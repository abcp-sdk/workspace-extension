import { TypedToolError } from '@abc-protocol/sdk'
import type { ToolResultData } from '@abc-protocol/sdk'
import { tr } from '../i18n.js'
import { requireArg, strArg } from './shared.js'
import { validComponent, type RepoCtx } from './repo-content.js'

/**
 * `repo-branch-sync`: integrate the base branch (`main`) into a FEATURE branch
 * with a two-parent merge commit, so the branch catches up with main. Files
 * changed on both sides are merged three-way; genuine conflicts are committed
 * as `ABCP-CONFLICT` marker blocks that THIS session must resolve (edit the
 * file and commit) before `repo-mr-create`/`repo-mr-merge` will accept it.
 *
 * The branch defaults to the caller's own branch (from its `org:repo:branch`
 * session), so a developer resolves conflicts in place — no new branch.
 */
export async function repoBranchSync(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = syncRef(ctx, args)
  const res = await ctx.gateway.syncBranch({ org: r.org, repo: r.repo, branch: r.branch })
  const fanned = res.clean && ctx.fanout !== undefined ? await ctx.fanout(r.org, r.repo, r.branch, res.commit) : 0
  const note = fanned > 0 ? `\n${tr(ctx.locale, 'fanoutUpdated', { count: fanned })}` : ''
  if (res.clean) {
    return {
      content: tr(ctx.locale, 'syncClean', { org: r.org, repo: r.repo, branch: r.branch, commit: res.commit.slice(0, 8) }) + note,
      data: { org: r.org, repo: r.repo, branch: r.branch, clean: true, commit: res.commit, fanned },
    }
  }
  return {
    content: tr(ctx.locale, 'syncConflicts', {
      org: r.org,
      repo: r.repo,
      branch: r.branch,
      count: res.conflicts.length,
      paths: res.conflicts.join(', '),
    }),
    data: { org: r.org, repo: r.repo, branch: r.branch, clean: false, conflicts: res.conflicts, commit: res.commit },
  }
}

/** `repo-restore`: restore ONE file on a branch to its content at another ref
 * (or commit). Text uses the normal path; BINARY is written byte-exact so a
 * non-UTF-8 file is not corrupted. This is the recovery tool for a conflict. */
export async function repoRestore(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = requireArg(args, 'org', ctx.locale)
  const repo = requireArg(args, 'repo', ctx.locale)
  const path = requireArg(args, 'path', ctx.locale)
  const from = requireArg(args, 'from', ctx.locale)
  const ref = strArg(args, 'ref')
  if (!validComponent(org) || !validComponent(repo)) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key: 'org/repo', value: `${org}/${repo}` }))
  }
  if (path === '' || path.includes('..')) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key: 'path', value: path }))
  }

  // Read the SOURCE bytes at `from` (binary-safe).
  const bytes = await ctx.forgejo.getRaw(org, repo, path, from, ctx.locale)

  // Stage the restored content onto the target branch (staging commit). The
  // target defaults to the session's own branch.
  const sessionBranch = ctx.session.split(':').length === 3 ? (ctx.session.split(':')[2] ?? '') : ''
  const target = ref !== '' ? ref : sessionBranch
  if (target === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'writeNeedsBranch'))
  }
  const isText = isUtf8(bytes)
  const res = await ctx.forgejo.applyFiles(
    org,
    repo,
    isText
      ? [{ path, operation: 'update', content: new TextDecoder().decode(bytes) }]
      : [{ path, operation: 'update', contentBytes: bytes }],
    { ref: target, locale: ctx.locale },
  )
  return {
    content: tr(ctx.locale, 'restored', {
      path, from, org, repo, ref: target, sha: res.sha.slice(0, 8),
      binary: isText ? '' : ' [binary]',
    }),
    data: { org, repo, path, from, ref: target, commit: res.sha, binary: !isText },
  }
}

/** Resolve the sync target: explicit org/repo/branch, else the session's branch. */
function syncRef(ctx: RepoCtx, args: Record<string, unknown>): { org: string; repo: string; branch: string } {
  const parts = ctx.session.split(':')
  const sessionOrg = parts.length === 3 ? (parts[0] ?? '') : ''
  const sessionRepo = parts.length === 3 ? (parts[1] ?? '') : ''
  const sessionBranch = parts.length === 3 ? (parts[2] ?? '') : ''
  const org = strArg(args, 'org') || sessionOrg
  const repo = strArg(args, 'repo') || sessionRepo
  const branch = strArg(args, 'branch') || sessionBranch
  if (org === '' || repo === '' || branch === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'syncNeedsBranch'))
  }
  for (const [key, val] of [['org', org], ['repo', repo], ['branch', branch]] as const) {
    if (!validComponent(val)) {
      throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key, value: val }))
    }
  }
  if (branch === 'main') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'syncMainRefused'))
  }
  return { org, repo, branch }
}

/** Whether bytes are valid UTF-8 (so a text write is lossless). */
function isUtf8(b: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b)
    return true
  } catch {
    return false
  }
}
