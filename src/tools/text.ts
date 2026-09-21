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

/** Split content into lines, tolerating \r\n and a trailing newline. */
export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  // A single trailing newline yields a final "" element; drop only that one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * A file's lines plus whether it ended with a newline. The line array uses the
 * SAME model as `read`/`splitLines` (no phantom trailing empty line), so line
 * numbers and counts agree across tools. `joinText` re-adds the final newline.
 */
export interface FileLines {
  lines: string[]
  trailingNewline: boolean
}

export function toFileLines(text: string): FileLines {
  const normalized = text.replace(/\r\n/g, '\n')
  const trailingNewline = normalized.endsWith('\n')
  return { lines: splitLines(normalized), trailingNewline }
}

export function joinFileLines(file: FileLines): string {
  if (file.lines.length === 0) return ''
  return file.lines.join('\n') + (file.trailingNewline ? '\n' : '')
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
