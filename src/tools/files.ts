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
import {
  anchorArg,
  anchorError,
  baseName,
  hasArg,
  numArg,
  rangeError,
  requireArg,
  strArg,
} from './shared.js'
import {
  applyEdit,
  checkAnchor,
  joinFileLines,
  looksTextual,
  normalizeRel,
  numberLines,
  resolveEditTarget,
  splitLines,
  toFileLines,
} from './text.js'
import { unifiedDiff } from './diff.js'
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
 * (1-based). The edit region is defined by TWO ANCHORS that are the UNCHANGED
 * lines immediately OUTSIDE it:
 *   - `start-anchor-line`: the 1-based line number of the unchanged line ABOVE
 *     the region (`0` = the head of the file).
 *   - `end-anchor-line`: the unchanged line BELOW the region (`total + 1` = the
 *     tail of the file).
 * The lines STRICTLY BETWEEN them are replaced by `content`; an empty region
 * inserts, empty `content` deletes. Anchors are NEVER silently clamped:
 * `start-anchor-line` must be in `[0, total]`, `end-anchor-line` in
 * `[1, total + 1]`, and `end-anchor-line >= start-anchor-line + 1`.
 *
 * Returns a localized one-line summary, a blank line, then a unified diff.
 */
export async function editFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const path = requireArg(args, 'path', ctx.locale)
  const locale = ctx.locale ?? 'en'
  const content = strArg(args, 'content')
  const startAnchorText = strArg(args, 'start-anchor')
  const endAnchorText = strArg(args, 'end-anchor')

  // All four anchor arguments are REQUIRED (present, though the content may be
  // "" at the head/tail). A missing key is a caller error.
  for (const key of [
    'start-anchor-line',
    'end-anchor-line',
    'start-anchor',
    'end-anchor',
  ]) {
    if (!hasArg(args, key)) {
      throw new TypedToolError('invalid_argument', tr(locale, 'editAnchorRequired', { key }))
    }
  }

  const read = await ctx.client.fileRead({ path })
  const current = new TextDecoder('utf-8', { fatal: false }).decode(read.content)
  const file = toFileLines(current)
  const total = file.lines.length
  const inserted = content === '' ? [] : toFileLines(content).lines

  // `start-anchor-line` / `end-anchor-line` are required. An EMPTY STRING is the
  // sentinel for the head (start => 0) and the tail (end => total + 1).
  const startAnchor = anchorArg(args, 'start-anchor-line', 0)
  const endAnchor = anchorArg(args, 'end-anchor-line', total + 1)

  // Strict bounds (no silent clamping).
  const resolved = resolveEditTarget(startAnchor, endAnchor, total)
  if (!resolved.ok) {
    throw rangeError(locale, path, total, resolved.reason, startAnchor, endAnchor)
  }

  // Anchor-content validation: the UNCHANGED line above (start-anchor-line) and
  // below (end-anchor-line) the region must match the caller's copy.
  const startCheck = checkAnchor(file.lines, startAnchor, startAnchorText, total)
  if (!startCheck.ok) {
    throw anchorError(locale, path, 'start', startAnchor, total, startCheck)
  }
  const endCheck = checkAnchor(file.lines, endAnchor, endAnchorText, total)
  if (!endCheck.ok) {
    throw anchorError(locale, path, 'end', endAnchor, total, endCheck)
  }

  const next = applyEdit(file.lines, resolved.target, inserted)

  const out = joinFileLines({ lines: next, trailingNewline: file.trailingNewline })
  if (out === current) {
    return { content: tr(locale, 'editNoChanges', { path }) }
  }

  const data = new TextEncoder().encode(out)
  const wrote = await ctx.client.fileWrite({ path, content: data })
  if (!wrote.ok) {
    throw new TypedToolError('internal', tr(locale, 'writeFailed', { path }))
  }

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
    data: {
      files: [{ code, name: file.name, mime: file.mime, size: file.data.length }],
    },
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
    data: {
      files: [{ code: stored.code, name, mime: stored.mime, size: res.content.length }],
    },
  }
}
