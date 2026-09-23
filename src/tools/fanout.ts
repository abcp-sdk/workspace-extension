import type { GatewayClient, WorkerClient } from '../client.js'
import type { WorkspaceDeps } from '../deps.js'
import type { Forgejo } from '../forgejo.js'
import { tr } from '../i18n.js'
import { parseSessionName } from './lifecycle.js'

/**
 * Session-scoped sandbox fan-out.
 *
 * A sandbox is bound to the session that created it. When that session's branch
 * moves (write/edit/delete/commit/port, a main sync, or a maintainer merge into
 * `main`), the change is materialized into every sandbox the session owns, so
 * the in-sandbox workspace keeps matching the branch without a full re-checkout.
 *
 * The baseline is the branch tip sha the sandbox last held, persisted per
 * (tenant, sandbox). A fan-out diffs baseline -> new tip and applies only the
 * paths that moved. Files not checked out (no baseline) are skipped.
 */

/** Everything a fan-out needs at call time. */
export interface FanoutCtx {
  gateway: GatewayClient
  forgejo: Forgejo
  /** Resolve a sandbox name to a live worker client. */
  resolveWorker: (name: string) => Promise<WorkerClient>
  deps: WorkspaceDeps | undefined
  tenant: string
  session: string
  locale: string
}
/** The `org:repo:branch` parts of a session, or null when it is not a branch session. */
export function branchRefOf(session: string): { org: string; repo: string; branch: string } | null {
  const s = parseSessionName(session)
  return s === null ? null : { org: s.org, repo: s.repo, branch: s.branch }
}

/** The sandboxes bound to `session` (names only). */
async function sessionSandboxes(gateway: GatewayClient, session: string): Promise<string[]> {
  const res = await gateway.listSandboxes({ session })
  return (res.sandboxes ?? []).map(s => s.name).filter(n => n !== '')
}

/** Resolve a branch's current tip sha. */
export async function resolveTip(forgejo: Forgejo, org: string, repo: string, branch: string, locale: string): Promise<string> {
  const branches = await forgejo.listBranches(org, repo, locale)
  return branches.find(b => b.name === branch)?.sha ?? ''
}

/** Materialize the repo tree at `ref` into the sandbox workspace (full checkout). */
export async function checkoutIntoSandbox(
  forgejo: Forgejo,
  client: WorkerClient,
  org: string,
  repo: string,
  ref: string,
): Promise<{ ref: string; files: number }> {
  const archive = await forgejo.archiveTarGz(org, repo, ref)
  const res = await client.syncFolder({ tarball: archive, dest: '.', clean: true, rev: ref })
  return { ref, files: res.files }
}

/** Single-quote a value for /bin/sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Apply one changed path into a sandbox. `status` is the compare status. */
async function applyPath(
  client: WorkerClient,
  forgejo: Forgejo,
  org: string,
  repo: string,
  rev: string,
  path: string,
  status: string,
  locale: string,
): Promise<void> {
  if (status === 'removed' || status === 'deleted') {
    // The worker has no delete RPC; remove through the shell (repo-relative
    // path, validated, single-quoted).
    await client.execute({ command: `rm -f -- ${shq(path)}`, workdir: '' }).catch(() => {})
    return
  }
  const data = await forgejo.getRaw(org, repo, path, rev, locale)
  await client.fileWrite({ path, content: data })
}

/**
 * Fan the current `branch` tip (or `newRev` when known) out to every sandbox the
 * session owns. Best-effort: a missing baseline or an unreachable sandbox is
 * skipped, never fatal. Returns the number of sandboxes updated.
 */
export async function fanoutRef(
  ctx: FanoutCtx,
  org: string,
  repo: string,
  branch: string,
  newRev = '',
): Promise<number> {
  const saveSync = ctx.deps?.saveSyncState
  const loadSync = ctx.deps?.loadSyncState
  if (saveSync === undefined || loadSync === undefined) return 0
  const names = await sessionSandboxes(ctx.gateway, ctx.session)
  if (names.length === 0) return 0
  const head = newRev !== '' ? newRev : await resolveTip(ctx.forgejo, org, repo, branch, ctx.locale)
  if (head === '') return 0
  let updated = 0
  for (const name of names) {
    const base = await loadSync(ctx.tenant, name)
    if (base === null || base.rev === '') continue
    if (base.rev === head) continue
    try {
      const cmp = await ctx.forgejo.compare(org, repo, base.rev, head, ctx.locale)
      const client = await ctx.resolveWorker(name)
      for (const f of cmp.files) {
        if (f.path === '') continue
        await applyPath(client, ctx.forgejo, org, repo, head, f.path, f.status, ctx.locale)
      }
      await saveSync(ctx.tenant, name, { rev: head, session: ctx.session, updatedAt: Date.now() })
      updated++
    } catch {
      // Sandbox unreachable or compare failed: leave its baseline untouched.
    }
  }
  return updated
}

/** Record a sandbox's baseline right after a full checkout. */
export async function recordBaseline(
  ctx: { forgejo: Forgejo; deps: WorkspaceDeps | undefined; tenant: string; session: string; locale: string },
  sandbox: string,
  org: string,
  repo: string,
  branch: string,
): Promise<void> {
  const saveSync = ctx.deps?.saveSyncState
  if (saveSync === undefined) return
  const rev = await resolveTip(ctx.forgejo, org, repo, branch, ctx.locale)
  if (rev === '') return
  await saveSync(ctx.tenant, sandbox, { rev, session: ctx.session, updatedAt: Date.now() })
}

/** Human summary of a fan-out for a tool result. */
export function fanoutNote(locale: string, count: number): string {
  return count > 0 ? tr(locale, 'fanoutUpdated', { count }) : ''
}
