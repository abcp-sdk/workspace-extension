/**
 * Pure byte/text helpers for the file tools. Kept dependency-free for tests.
 */

/** A windowed read of a file's content (used by `read`). */
export interface TextWindow {
  /** True when the checked window looks like UTF-8 text (no NUL, valid UTF-8). */
  isText: boolean
  /** The selected lines (0-based `[offset, offset+limit)`), no line numbers. */
  lines: string[]
  /** Total number of lines in the file. */
  total: number
  /** 0-based line index the window starts at (after clamping). */
  start: number
  /** True when more lines exist after the window. */
  truncated: boolean
}

/** Heuristic: bytes are text when the window decodes as UTF-8 and has no NUL. */
export function looksTextual(data: Uint8Array): boolean {
  if (data.length === 0) return true
  const probe = data.length > 8192 ? data.subarray(0, 8192) : data
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(probe)
    return true
  } catch {
    return false
  }
}

/** Split content into lines, tolerating \r\n, a leading BOM and a trailing newline. */
export function splitLines(text: string): string[] {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = normalized.replace(/\r\n/g, '\n').split('\n')
  // A single trailing newline yields a final "" element; drop only that one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * A file's lines plus the byte details needed to write it back byte-faithfully.
 * The line array uses the SAME model as `read`/`splitLines` (no phantom trailing
 * empty line), so line numbers and counts agree across tools. `joinFileLines`
 * restores the original line terminator, final newline and UTF-8 BOM.
 */
export interface FileLines {
  lines: string[]
  trailingNewline: boolean
  /** Original line terminator (`\n`, or `\r\n`); restored on write. */
  eol: '\n' | '\r\n'
  /** True when the file began with a UTF-8 BOM; restored on write. */
  bom: boolean
}

/** Detect the dominant line terminator (`\r\n` when any CRLF is present). */
function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Strip a leading UTF-8 BOM (U+FEFF); report whether one was present. */
function stripBom(text: string): { text: string; bom: boolean } {
  return text.charCodeAt(0) === 0xfeff
    ? { text: text.slice(1), bom: true }
    : { text, bom: false }
}

export function toFileLines(text: string): FileLines {
  const { text: body, bom } = stripBom(text)
  const eol = detectEol(body)
  const normalized = body.replace(/\r\n/g, '\n')
  const trailingNewline = normalized.endsWith('\n')
  return { lines: splitLines(normalized), trailingNewline, eol, bom }
}

export function joinFileLines(file: FileLines): string {
  const body =
    file.lines.length === 0
      ? ''
      : file.lines.join('\n') + (file.trailingNewline ? '\n' : '')
  const withEol = file.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body
  return file.bom ? '\uFEFF' + withEol : withEol
}

/**
 * Window `[offset, offset+limit)` over the file's lines. `offset` is clamped
 * to [0, total]; `limit` to at least 1. `offset` counts from the start only.
 */
export function windowLines(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  decode: (b: Uint8Array) => string = b =>
    new TextDecoder('utf-8').decode(b),
): TextWindow {
  const isText = looksTextual(bytes)
  const all = splitLines(decode(bytes))
  const total = all.length
  const start = Math.min(Math.max(0, Math.floor(offset)), total)
  const n = Math.max(1, Math.floor(limit))
  const lines = all.slice(start, start + n)
  return { isText, lines, total, start, truncated: start + lines.length < total }
}

/** Render lines with 1-based absolute line-number prefixes, padded. */
export function numberLines(
  lines: readonly string[],
  startLine: number,
): string[] {
  const width = String(startLine + lines.length).length
  return lines.map((l, i) =>
    `${String(startLine + i).padStart(width, ' ')}  ${l}`,
  )
}

/** Drop trailing slashes and leading './' from a path for display. */
export function normalizeRel(p: string): string {
  let s = p
  while (s.startsWith('./')) s = s.slice(2)
  while (s.endsWith('/') && s.length > 1) s = s.slice(0, -1)
  return s
}

/** Join a slash path, collapsing boundary slashes (`a/` + `/b` => `a/b`). */
function joinSlash(base: string, rest: string): string {
  const b = base.replace(/\/+$/, '')
  const r = rest.replace(/^\/+/, '')
  if (b === '') return `/${r}`
  return r === '' ? b : `${b}/${r}`
}

/**
 * Expand a leading `~` in a worker path: `~` / `~/` => the worker's HOME, and
 * `~/x` => `<HOME>/x`. The worker itself does NOT expand `~` (it treats a
 * relative path as literal), so the tool layer does it here, matching the
 * sandbox file browser. `home` falls back to `workspace` when the platform has
 * no home concept. A path that is not `~` / `~/...` is returned UNCHANGED
 * (including `~user`, which is not supported and stays a literal name).
 */
export function expandTilde(
  p: string,
  anchors: { home: string; workspace: string },
): string {
  if (p !== '~' && p !== '~/' && !p.startsWith('~/')) return p
  const base = anchors.home !== '' ? anchors.home : anchors.workspace
  if (base === '') return p
  if (p === '~' || p === '~/') return base
  return joinSlash(base, p.slice(2))
}

/** Why an edit's anchor pair was rejected. */
export type EditRangeError =
  | 'startAnchorMin'
  | 'endAnchorMax'
  | 'anchorOrder'

/**
 * A resolved edit target over a file's line model. The edit region is the
 * lines STRICTLY BETWEEN the two anchors: 1-based `[s+1, e-1]` inclusive. An
 * empty region (`e === s + 1`) is an INSERT at 0-based index `s`.
 */
export interface EditTarget {
  /** `start-anchor-line` (0-based cut index == the 1-based anchor line). */
  s: number
  /** `end-anchor-line` (the 1-based anchor line below the region). */
  e: number
}

/**
 * Resolve an edit's anchor pair against a file of `total` lines, WITHOUT
 * silently clamping. `start-anchor-line` is the 1-based line number of the
 * UNCHANGED line immediately ABOVE the edit region (`0` = before line 1);
 * `end-anchor-line` is the UNCHANGED line immediately BELOW it (`total + 1` =
 * after the last line). The region replaced is the lines strictly between
 * them. Valid ranges: start in `[0, total]`, end in `[1, total + 1]`, and
 * `end >= start + 1`.
 *
 *   insert between lines 27 and 28  -> start 27, end 28
 *   replace lines 28..29            -> start 27, end 30
 *   prepend at the head             -> start 0,  end 1
 *   append at the tail              -> start total, end total + 1
 */
export function resolveEditTarget(
  startAnchor: number,
  endAnchor: number,
  total: number,
): { ok: true; target: EditTarget } | { ok: false; reason: EditRangeError } {
  if (startAnchor < 0 || startAnchor > total)
    return { ok: false, reason: 'startAnchorMin' }
  if (endAnchor < 1 || endAnchor > total + 1)
    return { ok: false, reason: 'endAnchorMax' }
  if (endAnchor < startAnchor + 1) return { ok: false, reason: 'anchorOrder' }
  return { ok: true, target: { s: startAnchor, e: endAnchor } }
}

/**
 * Apply a resolved target to `lines`, returning the new line array. The region
 * `[s+1, e-1]` (1-based, inclusive) is replaced by `inserted` (empty = delete;
 * an empty region + inserted = insert).
 */
export function applyEdit(
  lines: readonly string[],
  target: EditTarget,
  inserted: readonly string[],
): string[] {
  return [...lines.slice(0, target.s), ...inserted, ...lines.slice(target.e - 1)]
}

/** Why an anchor's content failed to validate. */
export type AnchorError =
  | { reason: 'missing'; actual: string }
  | { reason: 'mismatch'; actual: string; expected: string }
  | { reason: 'outOfRange' }

/**
 * Validate an `anchor` (the caller's copy of an anchor line's text) against
 * line `line` (1-based) of `lines`. An EMPTY `anchor` means "this boundary does
 * not exist": it is required when the line EXISTS and forbidden when it does
 * not. Comparison is `trim()`-based, so indentation/whitespace transcription
 * slips are tolerated while the actual content must still match.
 */
export function checkAnchor(
  lines: readonly string[],
  line: number,
  anchor: string,
  total: number,
): { ok: true } | ({ ok: false } & AnchorError) {
  const exists = line >= 1 && line <= total
  if (!exists) {
    return anchor.trim() === ''
      ? { ok: true }
      : { ok: false, reason: 'outOfRange' }
  }
  const actual = lines[line - 1] ?? ''
  if (anchor.trim() === '') return { ok: false, reason: 'missing', actual }
  return actual.trim() === anchor.trim()
    ? { ok: true }
    : { ok: false, reason: 'mismatch', actual, expected: anchor }
}
