import { type ToolResultData, TypedToolError } from '@abc-protocol/sdk'
import { type WorkerClient, workerAnchors } from '../client.js'
import type { WorkspaceDeps } from '../deps.js'
import {
  capLines,
  humanSize,
  MAX_RESULT_LINES,
  truncationNote,
} from './output.js'
import { baseName, numArg, requireArg, strArg } from './shared.js'
import {
  expandTilde,
  joinFileLines,
  looksTextual,
  normalizeRel,
  numberLines,
  splitLines,
  toFileLines,
} from './text.js'
import { unifiedDiff } from './diff.js'
import {
  addContentsLines,
  applyChunks,
  PatchError,
  parsePatch,
  type PatchHunk,
} from './patch.js'
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
    new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(res.content),
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
 * `patch`: apply an opencode-style multi-file patch (add / update / delete) in
 * ONE call. The patch is fully parsed and every file's new content is computed
 * BEFORE anything is written, so a malformed or non-matching patch leaves the
 * workspace untouched. `*** Move to:` is REJECTED (not supported). File EOL and
 * a UTF-8 BOM are preserved. Paths inside the patch are `~`-expanded here (the
 * worker does not expand `~`). Returns a one-line summary per file plus a
 * unified diff of the whole change.
 */
export async function patchFile(
  ctx: FileCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const locale = ctx.locale ?? 'en'
  const raw = strArg(args, 'patch-text')
  if (raw.trim() === '') {
    throw new TypedToolError('invalid_argument', tr(locale, 'argRequired', { key: 'patch-text' }))
  }

  let hunks: PatchHunk[]
  try {
    hunks = parsePatch(raw)
  } catch (e) {
    throw new TypedToolError('invalid_argument', tr(locale, 'patchInvalid', { err: String(e) }))
  }
  if (hunks.length === 0) {
    throw new TypedToolError('invalid_argument', tr(locale, 'patchEmpty'))
  }
  for (const h of hunks) {
    if (h.type === 'update' && h.movePath !== undefined) {
      throw new TypedToolError('invalid_argument', tr(locale, 'patchMoveUnsupported', { path: h.path }))
    }
  }

  const anchors = await workerAnchors(ctx.client)
  const expand = (p: string): string => expandTilde(p, anchors)

  // Phase 1: compute every file's new content (no writes yet). A failure here
  // aborts the whole patch, so the workspace is never partially applied.
  interface Planned {
    path: string
    kind: 'add' | 'update' | 'delete'
    before: string
    after: string
    lines: number
  }
  const planned: Planned[] = []
  const summaries: string[] = []
  let totalAdded = 0
  let totalRemoved = 0
  let fullDiff = ''
  for (const h of hunks) {
    const path = expand(h.path)
    if (h.type === 'add') {
      const after = addContentsLines(h.contents).join('\n')
      const afterText = after === '' ? '' : after + '\n'
      const diff = unifiedDiff('', afterText, path)
      planned.push({ path, kind: 'add', before: '', after: afterText, lines: addContentsLines(h.contents).length })
      summaries.push(tr(locale, 'patchAdded', { path, lines: addContentsLines(h.contents).length }))
      totalAdded += diff.added
      if (diff.text !== '') fullDiff += (fullDiff === '' ? '' : '\n') + diff.text
      continue
    }
    if (h.type === 'delete') {
      const before = await readTextFile(ctx, path, locale)
      const diff = unifiedDiff(before, '', path)
      planned.push({ path, kind: 'delete', before, after: '', lines: 0 })
      summaries.push(tr(locale, 'patchDeleted', { path }))
      totalRemoved += diff.removed
      if (diff.text !== '') fullDiff += (fullDiff === '' ? '' : '\n') + diff.text
      continue
    }
    // update
    const before = await readTextFile(ctx, path, locale)
    const file = toFileLines(before)
    let nextLines: string[]
    try {
      nextLines = applyChunks(path, file.lines, h.chunks)
    } catch (e) {
      throw new TypedToolError('retryable', tr(locale, 'patchApplyFailed', { path, err: String(e) }))
    }
    const after = joinFileLines({ ...file, lines: nextLines })
    const diff = unifiedDiff(before, after, path)
    planned.push({ path, kind: 'update', before, after, lines: nextLines.length })
    summaries.push(tr(locale, 'patchUpdated', { path, added: diff.added, removed: diff.removed }))
    totalAdded += diff.added
    totalRemoved += diff.removed
    if (diff.text !== '') fullDiff += (fullDiff === '' ? '' : '\n') + diff.text
  }

  // Phase 2: apply. Adds/updates write; deletes remove.
  for (const p of planned) {
    if (p.kind === 'delete') {
      const res = await ctx.client.fileDelete({ path: p.path })
      if (!res.ok) {
        throw new TypedToolError('internal', tr(locale, 'deleteFailed', { path: p.path }))
      }
      continue
    }
    const bytes = new TextEncoder().encode(p.after)
    const wrote = await ctx.client.fileWrite({ path: p.path, content: bytes })
    if (!wrote.ok) {
      throw new TypedToolError('internal', tr(locale, 'writeFailed', { path: p.path }))
    }
  }

  const summary = tr(locale, 'patchSummary', {
    files: planned.length,
    added: totalAdded,
    removed: totalRemoved,
  })
  const capped = capLines(fullDiff.split('\n'))
  let body = capped.kept.join('\n')
  if (capped.truncated) {
    body += truncationNote(capped, capped.kept.length, fullDiff.split('\n').length, locale)
  }
  return {
    content: `${summary}\n${summaries.join('\n')}` + (body === '' ? '' : `\n\n${body}`),
    data: {
      files: planned.length,
      added: totalAdded,
      removed: totalRemoved,
      diff: fullDiff,
      paths: planned.map(p => p.path),
      changed: planned.map(p => ({ path: p.path, kind: p.kind, lines: p.lines })),
    },
  }
}

/** Read a file's full text (BOM/EOL preserved) for patch planning. */
async function readTextFile(ctx: FileCtx, path: string, locale: string): Promise<string> {
  const res = await ctx.client.fileRead({ path }).catch(() => null)
  if (res === null) {
    throw new TypedToolError('not_found', tr(locale, 'patchFileMissing', { path }))
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(res.content)
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
