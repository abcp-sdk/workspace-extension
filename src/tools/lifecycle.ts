import type { LifecycleEvent } from '@abc-protocol/sdk'
import type { Forgejo } from '../forgejo.js'
import { validComponent } from './repo-content.js'

/** A session name split into its `org:repo:branch` parts. */
export interface SessionRef {
  org: string
  repo: string
  branch: string
}

/** Parse `org:repo:branch`; null when the name is not a workspace session. */
export function parseSessionName(name: string): SessionRef | null {
  const parts = name.split(':')
  if (parts.length !== 3) return null
  const [org, repo, branch] = parts as [string, string, string]
  if (!validComponent(org) || !validComponent(repo) || !validComponent(branch)) return null
  return { org, repo, branch }
}

/**
 * Materialize a session's branch in Forgejo from a lifecycle event. The
 * gateway owns session creation; the agent publishes `created`/`forked`, and
 * this converges the branch (idempotent: retries and replays are harmless).
 *
 *   - `created`: branch != main -> create it from main (main is created by the
 *     gateway's EnsureRepo with auto_init).
 *   - `forked`: create the new branch from the PARENT's branch (true workspace
 *     inheritance); cross-repo forks are refused.
 *   - `renamed`: unsupported by the gateway (sessions are immutable); ignored.
 *   - `deleted`: handled by the gateway (branch is left as a legal orphan).
 */
export async function materializeLifecycle(
  ev: LifecycleEvent,
  forgejo: Forgejo,
  locale: string,
): Promise<void> {
  const self = parseSessionName(ev.session_name)
  if (self === null) return // non-workspace session (explorer/admin)

  switch (ev.kind) {
    case 'created': {
      if (self.branch === 'main') return
      await ensureBranch(forgejo, self.org, self.repo, 'main', self.branch, locale)
      return
    }
    case 'forked': {
      if (self.branch === 'main') return
      const parent = ev.parent !== undefined ? parseSessionName(ev.parent) : null
      if (parent !== null && (parent.org !== self.org || parent.repo !== self.repo)) {
        return // cross-repo fork: not a thing here
      }
      const from = parent?.branch ?? 'main'
      await ensureBranch(forgejo, self.org, self.repo, from, self.branch, locale)
      return
    }
    default:
      return
  }
}

/**
 * Idempotently create `branch` from `from`. When `from` is empty it falls back
 * to the repo's default branch; when the source branch is itself missing
 * (bootstrap order) it falls back to `main`.
 */
async function ensureBranch(
  forgejo: Forgejo,
  org: string,
  repo: string,
  from: string,
  branch: string,
  locale: string,
): Promise<void> {
  if (await branchExists(forgejo, org, repo, branch, locale)) return
  let source = from
  if (source === '' || !(await branchExists(forgejo, org, repo, source, locale))) {
    source = await forgejo.resolveRef(org, repo, '', locale)
  }
  await forgejo.createBranch(org, repo, branch, source, locale)
}

async function branchExists(
  forgejo: Forgejo,
  org: string,
  repo: string,
  branch: string,
  locale: string,
): Promise<boolean> {
  try {
    const branches = await forgejo.listBranches(org, repo, locale)
    return branches.some(b => b.name === branch)
  } catch {
    return false
  }
}
