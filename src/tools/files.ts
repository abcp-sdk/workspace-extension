import { type ToolResultData, TypedToolError } from '@abc-protocol/sdk'
import type { WorkerClient } from '../client.js'
import type { WorkspaceDeps } from '../deps.js'
import {
  capLines,
  humanSize,
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
  truncationNote,
} from './output.js'
import { baseName, numArg, requireArg, strArg } from './shared.js'
import {
  joinFileLines,
  looksTextual,
  normalizeRel,
  numberLines,
  splitLines,
  toFileLines,
} from './text.js'
import { unifiedDiff } from './diff.js'
import {
  formatRanges,
  hashBytes,
  invalidate,
  rangesCover,
  recordSeen,
  seenFor,
} from './edit-state.js'
import { tr } from '../i18n.js'

/** Everything a file-tool handler needs at call time. */
export interface FileCtx {
  client: WorkerClient
  deps: WorkspaceDeps
  tenant: string
  session: string
  /** Session locale for result text ('' => English fallback). */
  locale?: string
}

function clampInt(v: number | undefined, def: number, max: number): number {
  if (v === undefined) return def
  const n = Math.floor(v)
  if (!Number.isFinite(n) || n < 0) return def
  return Math.min(n, max)
}

/** `read`: window a text file with line numbers; never ingests. The window
 *  is fetched SERVER-SIDE (worker.v1 FileRead start/end_line), so reading a
 *  slice of a huge file never transfers the whole thing. */
export async function readFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const path = requireArg(args, 'path', ctx.locale)
  const offset = clampInt(numArg(args, 'offset'), 0, Number.MAX_SAFE_INTEGER)
  const limit = clampInt(numArg(args, 'limit'), 200, 1000)

  const res = await ctx.client.fileRead({
    path,
    startLine: offset,
    endLine: offset + limit,
  })
  const isText = looksTextual(res.content)
  if (!isText) {
    throw new TypedToolError(
      'invalid_argument',
      tr(ctx.locale ?? 'en', 'notTextFile', { path }),
    )
  }
  const lines = splitLines(
    new TextDecoder('utf-8', { fatal: false }).decode(res.content),
  )
  const total = res.totalLines > 0 ? res.totalLines : lines.length
  const winStart = res.startLine
  const win = {
    lines,
    total,
    start: winStart,
    truncated: winStart + lines.length < total,
  }
  const numbered = numberLines(win.lines, win.start + 1)
  const capped = capLines(numbered)
  const shown = capped.kept.length
  const end = win.start + shown
  let content = capped.kept.join('\n')
  if (capped.truncated) {
    content += truncationNote(capped, shown, win.lines.length, ctx.locale)
  }
  if (win.truncated || win.start > 0) {
    content +=
      '\n' +
      tr(ctx.locale ?? 'en', 'showingLines', { start: win.start + 1, end, total: win.total }) +
      (win.truncated ? tr(ctx.locale ?? 'en', 'moreLinesAvailable') : '')
  }
  // Record exactly the lines DISPLAYED (after the byte/line cap), so a later
  // edit may only touch what the session has actually seen. An empty result
  // still records an entry (ranges []), which is what allows inserting into an
  // empty file. The hash covers the FETCHED window (see edit-state).
  {
    const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
    const ranges = shown > 0 ? [[win.start + 1, win.start + shown] as const] : []
    const next = recordSeen(
      state,
      path,
      hashBytes(res.content),
      ranges.map(r => [r[0], r[1]] as [number, number]),
      Date.now(),
      { start: winStart, end: winStart + lines.length, totalLines: total },
    )
    await ctx.deps.saveEditState(ctx.tenant, ctx.session, next)
  }
  return { content, data: { total_lines: win.total, start: win.start, shown } }
}

/**
 * `write`: overwrite a text file with `content` (JSON-friendly full content),
 * then read it back and return the WHOLE file with line numbers. Unlike `read`
 * there is no 1000-line cap (the caller already supplied the full content);
 * only the 120 KiB protocol guard applies — a larger write is REJECTED before
 * anything is written. On success the whole file counts as "seen" for `edit`.
 */
export async function writeFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const path = requireArg(args, 'path', ctx.locale)
  const locale = ctx.locale ?? 'en'
  const content = strArg(args, 'content')
  const bytes = Buffer.byteLength(content, 'utf8')
  const data = new TextEncoder().encode(content)

  if (bytes > MAX_RESULT_BYTES) {
    throw new TypedToolError(
      'invalid_argument',
      tr(locale, 'writeTooLarge', {
        path,
        bytes,
        limit: humanSize(MAX_RESULT_BYTES),
      }),
    )
  }

  // Best-effort pre-image so the tool card can render a unified diff.
  let before = ''
  try {
    const cur = await ctx.client.fileRead({ path })
    before = new TextDecoder('utf-8').decode(cur.content)
  } catch {
    // new file -> diff against empty
  }

  const wrote = await ctx.client.fileWrite({ path, content: data })
  if (!wrote.ok) {
    throw new TypedToolError('internal', tr(locale, 'writeFailed', { path }))
  }

  // Read back (authoritative bytes) and render the whole file with line numbers.
  const read = await ctx.client.fileRead({ path })
  const file = toFileLines(new TextDecoder('utf-8').decode(read.content))
  const numbered = numberLines(file.lines, 1)
  // Byte-only guard (never a line cap for write).
  const capped = capLines(numbered, Number.MAX_SAFE_INTEGER, MAX_RESULT_BYTES)
  let body = capped.kept.join('\n')
  if (capped.truncated) {
    body += truncationNote(capped, capped.kept.length, numbered.length, locale)
  }

  // The whole file is now seen; a later edit may touch any line.
  const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  const next = recordSeen(
    state,
    path,
    hashBytes(read.content),
    file.lines.length > 0 ? [[1, file.lines.length]] : [],
    Date.now(),
  )
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, next)

  const summary = tr(locale, 'wroteFile', {
    bytes: read.content.length,
    path,
    lines: file.lines.length,
  })
  const diff = unifiedDiff(before, content, path)
  return {
    content: body === '' ? summary : `${summary}\n\n${body}`,
    data: {
      path,
      bytes: read.content.length,
      lines: file.lines.length,
      total_lines: file.lines.length,
      added: diff.added,
      removed: diff.removed,
      diff: diff.text,
    },
  }
}

/**
 * `edit`: line-oriented replace/insert over the SAME line model as `read`
 * (1-based, `[start-line, end-line]` inclusive). `end-line < start-line`
 * inserts before `start-line`. Out-of-range line numbers are CLAMPED to the
 * file (never appending a phantom blank line): `[10,12]` on a 10-line file
 * replaces line 10; on an 11-line file it replaces lines 10-11.
 *
 * READ-BEFORE-EDIT: the session may only edit a file it has seen via `read`
 * (or written), only within the line ranges it has seen, and only while the
 * file is unchanged since that read. A successful edit CLEARS the seen state
 * (the caller must read again, because line numbers shift).
 *
 * Returns a localized one-line summary, a blank line, then a unified diff.
 */
export async function editFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const path = requireArg(args, 'path', ctx.locale)
  const locale = ctx.locale ?? 'en'
  const startLine = Math.trunc(numArg(args, 'start-line') ?? 0)
  const endLine = Math.trunc(numArg(args, 'end-line') ?? 0)
  const content = strArg(args, 'content')

  if (startLine < 1) {
    throw new TypedToolError('invalid_argument', tr(locale, 'startLineMin'))
  }

  // ---- read-before-edit guard ----
  const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  const seen = seenFor(state, path)
  if (seen === null) {
    throw new TypedToolError('permission_denied', tr(locale, 'editNeedsRead', { path }))
  }

  const read = await ctx.client.fileRead({ path })
  // Staleness: for a WINDOWED read record, re-fetch the SAME window and compare
  // hashes (byte-identical domain). Any line-count change shifts the window's
  // content (hash differs), and in-window edits differ too — as sound as the
  // legacy whole-file hash. Legacy/whole-file records compare the whole bytes.
  const stale = await (async () => {
    if (seen.winStart !== undefined && seen.winEnd !== undefined) {
      const w = await ctx.client.fileRead({
        path,
        startLine: seen.winStart,
        endLine: seen.winEnd,
      })
      return hashBytes(w.content) !== seen.sha256
    }
    return hashBytes(read.content) !== seen.sha256
  })()
  if (stale) {
    throw new TypedToolError('retryable', tr(locale, 'editStaleRead', { path }))
  }
  const current = new TextDecoder('utf-8', { fatal: false }).decode(read.content)
  const file = toFileLines(current)
  const total = file.lines.length
  const inserted = content === '' ? [] : toFileLines(content).lines

  // The (clamped) line range this edit will touch, for the seen-range check.
  let next: string[]
  let touched: [number, number]
  if (endLine < startLine) {
    // Insert before start-line, clamped to [0, total]. Anchored at `startLine`
    // (an empty file needs only a prior read, which `seen !== null` provides).
    const at = Math.min(Math.max(startLine - 1, 0), total)
    next = [...file.lines.slice(0, at), ...inserted, ...file.lines.slice(at)]
    touched = total === 0 ? [0, -1] : [at + 1, at + 1]
  } else {
    // Replace [start-line, end-line], both clamped to the file end.
    const s = Math.min(Math.max(startLine - 1, 0), total)
    const e = Math.max(s, Math.min(endLine, total))
    next = [...file.lines.slice(0, s), ...inserted, ...file.lines.slice(e)]
    touched = [s + 1, e]
  }

  if (!rangesCover(seen.ranges, touched[0], touched[1])) {
    throw new TypedToolError(
      'permission_denied',
      tr(locale, 'editRangeNotRead', {
        path,
        start: touched[0],
        end: Math.max(touched[0], touched[1]),
        seen: formatRanges(seen.ranges),
      }),
    )
  }

  const out = joinFileLines({ lines: next, trailingNewline: file.trailingNewline })
  if (out === current) {
    return { content: tr(locale, 'editNoChanges', { path }) }
  }

  const data = new TextEncoder().encode(out)
  const wrote = await ctx.client.fileWrite({ path, content: data })
  if (!wrote.ok) {
    throw new TypedToolError('internal', tr(locale, 'writeFailed', { path }))
  }
  // Line numbers may have shifted: require a fresh read before the next edit.
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, invalidate(state, path))

  const diff = unifiedDiff(current, out, path)
  const summary = tr(locale, 'editSummary', {
    path,
    added: diff.added,
    removed: diff.removed,
    lines: next.length,
  })
  const capped = capLines(diff.text.split('\n'))
  let body = capped.kept.join('\n')
  if (capped.truncated) {
    body += truncationNote(capped, capped.kept.length, diff.text.split('\n').length, locale)
  }
  return {
    content: `${summary}\n\n${body}`,
    data: {
      path,
      added: diff.added,
      removed: diff.removed,
      diff: diff.text,
      lines: next.length,
      bytes: data.length,
    },
  }
}

/** `list`: tree (levels 1..depth), size + is_dir per entry. ONE server-side
 *  recursive listing (worker.v1 FileList depth/limit) — the depth expansion
 *  happens in the worker, not one RPC per directory. */
export async function listFiles(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const path = strArg(args, 'path')
  const limit = clampInt(numArg(args, 'limit'), 200, 1000)
  const depth = clampInt(numArg(args, 'depth'), 3, 10) || 3

  // limit+1 is the truncation sentinel: an extra entry back means hit.
  const res = await ctx.client.fileList({
    path: path === '' ? '.' : path,
    depth,
    limit: limit + 1,
  })
  const truncated = res.files.length > limit
  const rawEntries = (truncated ? res.files.slice(0, limit) : res.files).map(f => ({
    path: f.path,
    size: Number(f.size),
    isDir: f.isDir,
  }))

  // Paths come back workspace-relative; make them relative to the walk root
  // and derive the level from the path depth.
  const rootRel = path === '' || path === '.' ? '' : normalizeRel(path)
  const entries: { path: string; depth: number; type: string; size: number }[] = []
  const lines: string[] = []
  for (const e of rawEntries) {
    let rel = e.path
    if (rootRel !== '' && (rel === rootRel || rel.startsWith(rootRel + '/'))) {
      rel = rel.slice(rootRel.length + 1)
    }
    const level = rel === '' ? 1 : rel.split('/').length
    entries.push({
      path: rel,
      depth: level,
      type: e.isDir ? 'dir' : 'file',
      size: e.isDir ? 0 : e.size,
    })
    const indent = '  '.repeat(Math.max(0, level - 1))
    const marker = e.isDir ? (level >= depth ? '[+]' : '[-]') : '   '
    const size = e.isDir ? '-' : humanSize(e.size)
    lines.push(`${indent}${marker} ${rel}  ${size}`)
  }
  if (truncated) {
    lines.push(
      tr(ctx.locale ?? 'en', 'omittedEntries', {
        path: rootRel === '' ? '.' : rootRel,
        count: 1,
        limit,
      }),
    )
  }
  if (entries.length === 0) {
    return {
      content:
        path === ''
          ? tr(ctx.locale ?? 'en', 'emptyRoot')
          : tr(ctx.locale ?? 'en', 'emptyDir', { path }),
    }
  }
  const capped = capLines(lines, MAX_RESULT_LINES)
  let content = capped.kept.join('\n')
  if (capped.truncated) content += truncationNote(capped, capped.kept.length, lines.length, ctx.locale)
  return {
    content,
    data: { rows: entries.length, truncated, entries },
  }
}

/** `rm`: remove a file or directory tree (worker.v1 FileDelete). */
export async function deleteFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const path = requireArg(args, 'path', ctx.locale)
  const locale = ctx.locale ?? 'en'
  const res = await ctx.client.fileDelete({ path })
  if (!res.ok) {
    throw new TypedToolError('internal', tr(locale, 'deleteFailed', { path }))
  }
  // A deleted file's seen state is meaningless now.
  const state = await ctx.deps.loadEditState(ctx.tenant, ctx.session)
  await ctx.deps.saveEditState(ctx.tenant, ctx.session, invalidate(state, path))
  return { content: tr(locale, 'deletedPath', { path }), data: { path, deleted: true } }
}

/** `download`: agent file → workspace path. */
export async function downloadFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const rawCode = requireArg(args, 'code', ctx.locale)
  const code = rawCode.startsWith('file:') ? rawCode.slice(5) : rawCode
  const path = requireArg(args, 'path', ctx.locale)
  const file = await ctx.deps.getFile(code, ctx.tenant)
  await ctx.client.fileWrite({ path, content: file.data })
  return {
    content: tr(ctx.locale ?? 'en', 'downloaded', {
      code,
      mime: file.mime,
      bytes: file.data.length,
      path,
    }),
  }
}

/** `upload`: workspace file → agent file store (agent derives the mime). */
export async function uploadFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const path = requireArg(args, 'path', ctx.locale)
  const name = strArg(args, 'name') || baseName(path)
  const res = await ctx.client.fileRead({ path })
  const stored = await ctx.deps.ingestFile({
    name,
    data: res.content,
    session: ctx.session,
    tenant: ctx.tenant,
  })
  return {
    content: tr(ctx.locale ?? 'en', 'uploaded', {
      path,
      code: stored.code,
      mime: stored.mime,
      bytes: res.content.length,
    }),
    data: { code: stored.code, mime: stored.mime },
  }
}
