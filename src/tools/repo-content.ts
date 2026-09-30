import { TypedToolError } from '@abc-protocol/sdk'
import type { ToolResultData } from '@abc-protocol/sdk'
import type { Forgejo } from '../forgejo.js'
import type { GatewayClient } from '../client.js'
import type { WorkspaceDeps } from '../deps.js'
import { tr } from '../i18n.js'
import { capLines, humanSize, MAX_RESULT_LINES, truncationNote } from './output.js'
import { unifiedDiff } from './diff.js'
import {
  applyEdit,
  checkAnchor,
  joinFileLines,
  numberLines,
  resolveEditTarget,
  toFileLines,
  windowLines,
} from './text.js'
import { anchorArg, anchorError, hasArg, numArg, rangeError, requireArg, strArg } from './shared.js'

/** Everything a repo-* tool handler needs at call time. */
export interface RepoCtx {
  forgejo: Forgejo
  deps: WorkspaceDeps
  /** Tenant gateway client (branch-session ensure/fork for created repos/branches). */
  gateway: GatewayClient
  tenant: string
  session: string
  locale: string
  /**
   * Fan a branch change out to the session's sandboxes. Best-effort; returns
   * the number of sandboxes updated (0 when the session owns none).
   */
  fanout?: (org: string, repo: string, branch: string, newRev: string) => Promise<number>
}

/** A repo address: `org/repo` at `ref` (ref '' = the default branch). */
export interface RepoRef {
  org: string
  repo: string
  ref: string
}

/** Legal org/repo/branch component: no `:`, `..`, `//`, or path escapes. */
const COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

export function validComponent(s: string): boolean {
  if (!COMPONENT_RE.test(s)) return false
  if (s.includes(':') || s.includes('..')) return false
  if (s.startsWith('/') || s.endsWith('/') || s.includes('//')) return false
  if (s.endsWith('.') || s.endsWith('.lock')) return false
  return true
}

/** Validate org/repo (and a non-empty ref) names, or throw invalid_argument. */
function validateRef(r: RepoRef, locale: string): RepoRef {
  for (const [key, val] of [['org', r.org], ['repo', r.repo]] as const) {
    if (!validComponent(val)) {
      throw new TypedToolError('invalid_argument', tr(locale, 'invalidName', { key, value: val }))
    }
  }
  if (r.ref !== '' && !validComponent(r.ref)) {
    throw new TypedToolError('invalid_argument', tr(locale, 'invalidName', { key: 'ref', value: r.ref }))
  }
  return r
}

/** Read org/repo/ref (all required except ref, which may be ''). */
export function repoRef(args: Record<string, unknown>, locale: string): RepoRef {
  return validateRef(
    {
      org: requireArg(args, 'org', locale),
      repo: requireArg(args, 'repo', locale),
      ref: strArg(args, 'ref'),
    },
    locale,  )
}

/** The `org`/`repo` a session is bound to, or null for a non-branch session. */
export function sessionRepo(session: string): { org: string; repo: string; branch: string } | null {
  const parts = session.split(':')
  if (parts.length !== 3) return null
  const [org, repo, branch] = parts as [string, string, string]
  if (!validComponent(org) || !validComponent(repo) || !validComponent(branch)) return null
  return { org, repo, branch }
}

/**
 * Read `org`/`repo` for a tool that may ONLY act on the CALLER'S OWN repository
 * (repo-tag-create). Both arguments are
 * OPTIONAL and default to the session's own `org`/`repo`; when supplied they
 * MUST match the session's repository, otherwise `permission_denied`. A session
 * that is not bound to a branch (`sessionRepo` null) must pass both explicitly.
 */
export function ownRepoRef(ctx: RepoCtx, args: Record<string, unknown>): RepoRef {
  const self = sessionRepo(ctx.session)
  const argOrg = strArg(args, 'org')
  const argRepo = strArg(args, 'repo')
  if (self !== null) {
    const org = argOrg || self.org
    const repo = argRepo || self.repo
    if (org !== self.org || repo !== self.repo) {
      throw new TypedToolError(
        'permission_denied',
        tr(ctx.locale, 'ownRepoOnly', { org: self.org, repo: self.repo }),
      )
    }
    return validateRef({ org, repo, ref: strArg(args, 'ref') }, ctx.locale)
  }
  // No branch binding: require an explicit repo (validated as usual).
  return validateRef(
    { org: requireArg(args, 'org', ctx.locale), repo: requireArg(args, 'repo', ctx.locale), ref: strArg(args, 'ref') },
    ctx.locale,
  )
}

/**
 * Like `repoRef`, but resolves an empty `ref` to the repository's default
 * branch (one extra metadata call). Tools that pass `ref` to an endpoint that
 * requires a concrete branch (archive, branch/tag create) MUST use this.
 */
export async function resolveRepoRef(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<RepoRef> {
  const r = repoRef(args, ctx.locale)
  if (r.ref !== '') return r
  return { ...r, ref: await ctx.forgejo.resolveRef(r.org, r.repo, '', ctx.locale) }
}

/** The seen-state key for a repo file (path namespaced by org/repo@ref). */
export function repoKey(r: RepoRef, path: string): string {
  return `${r.org}/${r.repo}@${r.ref}:${path}`
}

/**
 * Resolve the ref a READ targets: an explicit `ref` wins, else the session's own
 * branch when it has one, else '' (the repo default). Reads share the write
 * path's seen-state key, so they must resolve the branch identically.
 */
function readRepoRef(ctx: RepoCtx, args: Record<string, unknown>): RepoRef {
  const r = repoRef(args, ctx.locale)
  if (r.ref !== '') return r
  const branch = sessionBranch(ctx.session)
  return branch === '' ? r : { ...r, ref: branch }
}

/** The branch part of an `org:repo:branch` session ('' when not a branch session). */
function sessionBranch(session: string): string {
  const parts = session.split(':')
  return parts.length === 3 ? (parts[2] ?? '') : ''
}

function clampInt(v: number | undefined, def: number, max: number): number {
  if (v === undefined) return def
  const n = Math.floor(v)
  if (!Number.isFinite(n) || n < 0) return def
  return Math.min(n, max)
}

/** `repo-file-read`: line-numbered text window; records seen ranges + blob sha. */
export async function repoRead(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = readRepoRef(ctx, args)
  const path = requireArg(args, 'path', ctx.locale)
  const offset = clampInt(numArg(args, 'offset'), 0, Number.MAX_SAFE_INTEGER)
  const limit = clampInt(numArg(args, 'limit'), 200, 1000)

  const got = await ctx.forgejo.getContents(r.org, r.repo, path, r.ref, ctx.locale)
  if (got.kind !== 'file') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'notTextFile', { path }))
  }
  const bytes = new TextEncoder().encode(got.text)
  const win = windowLines(bytes, offset, limit)
  if (!win.isText) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'notTextFile', { path }))
  }
  const numbered = numberLines(win.lines, win.start + 1)
  const capped = capLines(numbered)
  const shown = capped.kept.length
  const end = win.start + shown
  let content = capped.kept.join('\n')
  if (capped.truncated) content += truncationNote(capped, shown, win.lines.length, ctx.locale)
  if (win.truncated || win.start > 0) {
    content +=
      '\n' +
      tr(ctx.locale, 'showingLines', { start: win.start + 1, end, total: win.total }) +
      (win.truncated ? tr(ctx.locale, 'moreLinesAvailable') : '')
  }
  return { content, data: { org: r.org, repo: r.repo, ref: r.ref, path, sha: got.sha, total_lines: win.total, start: win.start, shown } }
}

/** `repo-file-list`: list a directory (or the repo tree root). */
export async function repoList(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = readRepoRef(ctx, args)
  const path = strArg(args, 'path')
  const got = await ctx.forgejo.getContents(r.org, r.repo, path, r.ref, ctx.locale)
  const entries = got.kind === 'dir' ? got.entries : [{ path, name: path, type: 'file' as const, size: got.size, sha: got.sha }]
  if (entries.length === 0) {
    return { content: tr(ctx.locale, 'repoNoEntries', { org: r.org, repo: r.repo, ref: r.ref || 'HEAD' }) }
  }
  const lines = entries.map(e => `${e.type === 'dir' ? '[-]' : '   '} ${e.path}  ${e.type === 'dir' ? '-' : humanSize(e.size)}`)
  const capped = capLines(lines, MAX_RESULT_LINES)
  let content = tr(ctx.locale, 'repoTreeHeader', { org: r.org, repo: r.repo, ref: r.ref || 'HEAD', count: entries.length }) + '\n' + capped.kept.join('\n')
  if (capped.truncated) content += truncationNote(capped, capped.kept.length, lines.length, ctx.locale)
  return { content, data: { org: r.org, repo: r.repo, ref: r.ref, entries: entries.map(e => ({ path: e.path, type: e.type, size: e.size })) } }
}

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha
}
