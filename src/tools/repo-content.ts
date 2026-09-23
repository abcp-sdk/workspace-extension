import { TypedToolError } from '@abc-protocol/sdk'
import type { ToolResultData } from '@abc-protocol/sdk'
import type { Forgejo } from '../forgejo.js'
import type { GatewayClient } from '../client.js'
import type { WorkspaceDeps } from '../deps.js'
import { tr } from '../i18n.js'
import { capLines, humanSize, MAX_RESULT_LINES, truncationNote } from './output.js'
import { unifiedDiff } from './diff.js'
import {
  formatRanges,
  invalidate,
  rangesCover,
  recordSeen,
  seenFor,
} from './edit-state.js'
import { joinFileLines, numberLines, toFileLines, windowLines } from './text.js'
import { numArg, requireArg, strArg } from './shared.js'

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
 * Resolve the branch a WRITE targets. An explicit `ref` wins; otherwise the
 * session's own branch (staging rewrites HEAD, so a write must never land on
 * the default branch by omission). Throws when the session has no branch and no
 * ref was given.
 */
function writeRepoRef(ctx: RepoCtx, args: Record<string, unknown>): RepoRef {
  const r = repoRef(args, ctx.locale)
  if (r.ref !== '') return r
  const branch = sessionBranch(ctx.session)
  if (branch !== '') return { ...r, ref: branch }
  throw new TypedToolError('invalid_argument', tr(ctx.locale, 'writeNeedsBranch'))
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

/** `repo-read`: line-numbered text window; records seen ranges + blob sha. */
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
  // Record exactly the displayed lines, keyed by org/repo@ref:path, with the
  // git blob sha as the freshness token.
  const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  const next = recordSeen(
    state,
    repoKey(r, path),
    got.sha,
    shown > 0 ? [[win.start + 1, win.start + shown]] : [],
    Date.now(),
  )
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, next)
  return { content, data: { path, sha: got.sha, total_lines: win.total, start: win.start, shown } }
}

/** `repo-write`: overwrite one file (one commit); marks the whole file seen. */
export async function repoWrite(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = writeRepoRef(ctx, args)
  const path = requireArg(args, 'path', ctx.locale)
  const content = strArg(args, 'content')
  const message = strArg(args, 'message') || `write ${path}`
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > 120 * 1024) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'writeTooLarge', { path, bytes, limit: humanSize(120 * 1024) }))
  }

  // Optimistic lock: pass the current blob sha when the file exists.
  let baseSha = ''
  try {
    const cur = await ctx.forgejo.getContents(r.org, r.repo, path, r.ref, ctx.locale)
    if (cur.kind === 'file') baseSha = cur.sha
  } catch {
    // absent -> create
  }
  const res = await ctx.forgejo.putFile(r.org, r.repo, path, content, message, {
    ref: r.ref,
    ...(baseSha !== '' ? { sha: baseSha } : {}),
    locale: ctx.locale,
  })
  const file = toFileLines(content)
  const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  const next = recordSeen(
    state,
    repoKey(r, path),
    '', // sha unknown until re-read; force a read before edit
    file.lines.length > 0 ? [[1, file.lines.length]] : [],
    Date.now(),
  )
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, next)
  const fanned = ctx.fanout !== undefined ? await ctx.fanout(r.org, r.repo, r.ref, res.sha) : 0
  const note = fanned > 0 ? `\n${tr(ctx.locale, 'fanoutUpdated', { count: fanned })}` : ''
  return {
    content: tr(ctx.locale, 'repoWrote', { path, org: r.org, repo: r.repo, ref: r.ref || 'HEAD', sha: short(res.sha) }) + note,
    data: { path, org: r.org, repo: r.repo, ref: r.ref, commit: res.sha, base_sha: baseSha, fanned },
  }
}

/** `repo-edit`: line edit with read-before-edit guard + unified diff. */
export async function repoEdit(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = writeRepoRef(ctx, args)
  const path = requireArg(args, 'path', ctx.locale)
  const startLine = Math.trunc(numArg(args, 'start-line') ?? 0)
  const endLine = Math.trunc(numArg(args, 'end-line') ?? 0)
  const content = strArg(args, 'content')
  const message = strArg(args, 'message') || `edit ${path}`
  if (startLine < 1) throw new TypedToolError('invalid_argument', tr(ctx.locale, 'startLineMin'))

  const key = repoKey(r, path)
  const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  const seen = seenFor(state, key)
  if (seen === null) throw new TypedToolError('permission_denied', tr(ctx.locale, 'editNeedsRead', { path }))

  const got = await ctx.forgejo.getContents(r.org, r.repo, path, r.ref, ctx.locale)
  if (got.kind !== 'file') throw new TypedToolError('not_found', tr(ctx.locale, 'forgejoNotFound', { msg: path }))
  if (got.sha !== seen.sha256) throw new TypedToolError('retryable', tr(ctx.locale, 'editStaleRead', { path }))

  const file = toFileLines(got.text)
  const total = file.lines.length
  const inserted = content === '' ? [] : toFileLines(content).lines
  let next: string[]
  let touched: [number, number]
  if (endLine < startLine) {
    const at = Math.min(Math.max(startLine - 1, 0), total)
    next = [...file.lines.slice(0, at), ...inserted, ...file.lines.slice(at)]
    touched = total === 0 ? [0, -1] : [at + 1, at + 1]
  } else {
    const s = Math.min(Math.max(startLine - 1, 0), total)
    const e = Math.max(s, Math.min(endLine, total))
    next = [...file.lines.slice(0, s), ...inserted, ...file.lines.slice(e)]
    touched = [s + 1, e]
  }
  if (!rangesCover(seen.ranges, touched[0], touched[1])) {
    throw new TypedToolError(
      'permission_denied',
      tr(ctx.locale, 'editRangeNotRead', {
        path,
        start: touched[0],
        end: Math.max(touched[0], touched[1]),
        seen: formatRanges(seen.ranges),
      }),
    )
  }
  const out = joinFileLines({ lines: next, trailingNewline: file.trailingNewline })
  if (out === got.text) {
    return { content: tr(ctx.locale, 'repoNoChanges', { path, org: r.org, repo: r.repo, ref: r.ref || 'HEAD' }) }
  }

  const res = await ctx.forgejo.putFile(r.org, r.repo, path, out, message, {
    ref: r.ref,
    sha: got.sha,
    locale: ctx.locale,
  })
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, invalidate(state, key))

  const diff = unifiedDiff(got.text, out, path)
  const summary = tr(ctx.locale, 'repoEditSummary', {
    path, org: r.org, repo: r.repo, ref: r.ref || 'HEAD',
    added: diff.added, removed: diff.removed, sha: short(res.sha),
  })
  const capped = capLines(diff.text.split('\n'))
  let body = capped.kept.join('\n')
  if (capped.truncated) body += truncationNote(capped, capped.kept.length, diff.text.split('\n').length, ctx.locale)
  const fanned = ctx.fanout !== undefined ? await ctx.fanout(r.org, r.repo, r.ref, res.sha) : 0
  const note = fanned > 0 ? `\n${tr(ctx.locale, 'fanoutUpdated', { count: fanned })}` : ''
  return {
    content: `${summary}\n\n${body}${note}`,
    data: { path, org: r.org, repo: r.repo, ref: r.ref, commit: res.sha, added: diff.added, removed: diff.removed, fanned },
  }
}

/** `repo-delete`: delete one file (one commit). */
export async function repoDelete(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = writeRepoRef(ctx, args)
  const path = requireArg(args, 'path', ctx.locale)
  const message = strArg(args, 'message') || `delete ${path}`
  let baseSha = ''
  try {
    const cur = await ctx.forgejo.getContents(r.org, r.repo, path, r.ref, ctx.locale)
    if (cur.kind === 'file') baseSha = cur.sha
  } catch {
    // absent
  }
  const res = await ctx.forgejo.deleteFile(r.org, r.repo, path, message, {
    ref: r.ref,
    ...(baseSha !== '' ? { sha: baseSha } : {}),
    locale: ctx.locale,
  })
  const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, invalidate(state, repoKey(r, path)))
  const fanned = ctx.fanout !== undefined ? await ctx.fanout(r.org, r.repo, r.ref, res.sha) : 0
  const note = fanned > 0 ? `\n${tr(ctx.locale, 'fanoutUpdated', { count: fanned })}` : ''
  return {
    content: tr(ctx.locale, 'repoDeleted', { path, org: r.org, repo: r.repo, ref: r.ref || 'HEAD', sha: short(res.sha) }) + note,
    data: { path, org: r.org, repo: r.repo, ref: r.ref, commit: res.sha, fanned },
  }
}

/** `repo-list`: list a directory (or the repo tree root). */
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

/**
 * `repo-commit`: finalize the branch's staged changes under `message` and open a
 * fresh staging commit. There is no file list: writes/edits/deletes accumulate
 * in the staging commit and this tool names it.
 */
export async function repoCommit(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = writeRepoRef(ctx, args)
  const message = requireArg(args, 'message', ctx.locale)
  if (message.trim() === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'message' }))
  }
  const res = await ctx.forgejo.commitStaged(r.org, r.repo, r.ref, message, ctx.locale)
  // The commit rewinds/advances HEAD; invalidate all seen state for this branch.
  let state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  for (const key of Object.keys(state)) {
    if (key.startsWith(`${r.org}/${r.repo}@`) || key.startsWith(`${r.org}/${r.repo}@${r.ref}:`)) {
      state = invalidate(state, key)
    }
  }
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, state)
  const fanned = ctx.fanout !== undefined ? await ctx.fanout(r.org, r.repo, r.ref, res.sha) : 0
  const note = fanned > 0 ? `\n${tr(ctx.locale, 'fanoutUpdated', { count: fanned })}` : ''
  return {
    content: tr(ctx.locale, 'repoCommitted', { org: r.org, repo: r.repo, ref: r.ref || 'HEAD', sha: short(res.sha) }) + note,
    data: { org: r.org, repo: r.repo, ref: r.ref, commit: res.sha, fanned },
  }
}

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha
}
