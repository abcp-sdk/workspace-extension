/**
 * Patch language — a stripped-down, file-oriented diff (the opencode
 * `apply_patch` format). Pure parsing + application, no I/O, so it is unit
 * testable; the tool handler in `files.ts` wires it to the worker.
 *
 * Envelope:
 *
 *   *** Begin Patch
 *   *** Add File: <path>       every following line is a `+` line (content)
 *   *** Delete File: <path>    nothing follows
 *   *** Update File: <path>    optional `*** Move to: <path>`, then `@@` hunks
 *   @@ [context]               ' '=context, '-'=old, '+'=new; optional `*** End of File`
 *   *** End Patch
 *
 * `applyPatch` rewrites a file's line array in place, preserving the file's
 * EOL/BOM via the caller (see `text.ts`). Any failed lookup throws a
 * `PatchError` and NOTHING is written by the caller (it computes every file
 * first, then writes).
 */

/** One parsed file operation. */
export type PatchHunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: PatchChunk[] }

/** One `@@` chunk inside an Update: old lines replaced by new lines. */
export interface PatchChunk {
  oldLines: string[]
  newLines: string[]
  changeContext?: string
  endOfFile?: boolean
}

/** A patch could not be parsed or applied. */
export class PatchError extends Error {}

/** Split a patch blob into lines WITHOUT dropping a leading BOM or CR. */
function splitPatchLines(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return body.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Parse a patch into hunks. Throws {@link PatchError} on a malformed patch
 * (missing markers, an unknown operation, or an Update with no hunks).
 * Moves are parsed (so the caller can reject them with a clear message) but
 * NOT applied.
 */
export function parsePatch(patchText: string): PatchHunk[] {
  const lines = splitPatchLines(patchText)
  const begin = lines.findIndex(l => l.trim() === '*** Begin Patch')
  const end = lines.findIndex(l => l.trim() === '*** End Patch')
  if (begin === -1 || end === -1 || begin >= end) {
    throw new PatchError('Invalid patch: missing "*** Begin Patch" / "*** End Patch"')
  }
  const hunks: PatchHunk[] = []
  let i = begin + 1
  while (i < end) {
    const line = lines[i] ?? ''
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim()
      if (path === '') throw new PatchError('Invalid add: empty file path')
      const { contents, next } = readAddContents(lines, i + 1, end)
      hunks.push({ type: 'add', path, contents })
      i = next
      continue
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim()
      if (path === '') throw new PatchError('Invalid delete: empty file path')
      hunks.push({ type: 'delete', path })
      i++
      continue
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim()
      if (path === '') throw new PatchError('Invalid update: empty file path')
      let j = i + 1
      let movePath: string | undefined
      if ((lines[j] ?? '').startsWith('*** Move to:')) {
        movePath = (lines[j] ?? '').slice('*** Move to:'.length).trim()
        if (movePath === '') throw new PatchError('Invalid move: empty file path')
        j++
      }
      const { chunks, next } = readUpdateChunks(lines, j, end)
      if (chunks.length === 0) {
        throw new PatchError(`Invalid update for ${path}: expected at least one @@ chunk`)
      }
      hunks.push(movePath !== undefined
        ? { type: 'update', path, movePath, chunks }
        : { type: 'update', path, chunks })
      i = next
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    throw new PatchError(`Invalid patch line: ${line}`)
  }
  return hunks
}

/** Read an Add File body: every line up to the next `***` is a `+` line. */
function readAddContents(
  lines: string[],
  start: number,
  end: number,
): { contents: string; next: number } {
  let contents = ''
  let i = start
  while (i < end && !(lines[i] ?? '').startsWith('***')) {
    const l = lines[i] ?? ''
    if (!l.startsWith('+')) {
      throw new PatchError(`Invalid add line (must start with "+"): ${l}`)
    }
    contents += l.slice(1) + '\n'
    i++
  }
  return { contents, next: i }
}

/** Read an Update's `@@` chunks up to the next `***` header. */
function readUpdateChunks(
  lines: string[],
  start: number,
  end: number,
): { chunks: PatchChunk[]; next: number } {
  const chunks: PatchChunk[] = []
  let i = start
  while (i < end && !(lines[i] ?? '').startsWith('***')) {
    const header = lines[i] ?? ''
    if (!header.startsWith('@@')) {
      throw new PatchError(`Invalid update line (expected "@@"): ${header}`)
    }
    const changeContext = header.slice(2).trim() || undefined
    const oldLines: string[] = []
    const newLines: string[] = []
    let endOfFile = false
    i++
    while (i < end && !(lines[i] ?? '').startsWith('@@')) {
      const l = lines[i] ?? ''
      if (l === '*** End of File') {
        endOfFile = true
        i++
        break
      }
      if (l.startsWith('***')) break
      if (l.startsWith(' ')) {
        oldLines.push(l.slice(1))
        newLines.push(l.slice(1))
      } else if (l.startsWith('-')) {
        oldLines.push(l.slice(1))
      } else if (l.startsWith('+')) {
        newLines.push(l.slice(1))
      } else {
        throw new PatchError(`Invalid update chunk line: ${l}`)
      }
      i++
    }
    chunks.push({
      oldLines,
      newLines,
      ...(changeContext !== undefined ? { changeContext } : {}),
      ...(endOfFile ? { endOfFile: true } : {}),
    })
  }
  return { chunks, next: i }
}

// ---- application ------------------------------------------------------------

/** Normalize fancy Unicode punctuation so a copy-paste near-match still lands. */
function normalizeUnicode(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
}

/** The match chain, strictest first: exact, trimEnd, trim, Unicode-normalized. */
const MATCHERS: Array<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
]

/**
 * Find the start index of `needle` in `haystack` at/after `from`. When
 * `endOfFile` is set, the match is preferred at the very end of the file.
 * Returns -1 when no matcher locates it.
 */
export function findContext(
  haystack: readonly string[],
  needle: readonly string[],
  from: number,
  endOfFile = false,
): number {
  if (needle.length === 0) return -1
  for (const eq of MATCHERS) {
    const matches = (at: number): boolean =>
      needle.every((n, k) => eq(haystack[at + k] ?? '', n))
    if (endOfFile) {
      const at = haystack.length - needle.length
      if (at >= from && matches(at)) return at
    }
    for (let at = from; at <= haystack.length - needle.length; at++) {
      if (matches(at)) return at
    }
  }
  return -1
}

/**
 * Apply an Update's chunks to a file's line array, returning the new array.
 * Throws {@link PatchError} when a chunk's old lines (or its `@@` context)
 * cannot be found. Chunks apply top-to-bottom; the search cursor advances past
 * each match so identical blocks stay ordered.
 */
export function applyChunks(
  path: string,
  lines: readonly string[],
  chunks: readonly PatchChunk[],
): string[] {
  const edits: Array<{ at: number; remove: number; insert: string[] }> = []
  let cursor = 0
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined && chunk.changeContext !== '') {
      const ctx = findContext(lines, [chunk.changeContext], cursor)
      if (ctx === -1) {
        throw new PatchError(`Failed to find context '${chunk.changeContext}' in ${path}`)
      }
      cursor = ctx + 1
    }
    if (chunk.oldLines.length === 0) {
      edits.push({ at: lines.length, remove: 0, insert: [...chunk.newLines] })
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let at = findContext(lines, oldLines, cursor, chunk.endOfFile === true)
    if (at === -1 && oldLines[oldLines.length - 1] === '') {
      oldLines = oldLines.slice(0, -1)
      if (newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1)
      at = findContext(lines, oldLines, cursor, chunk.endOfFile === true)
    }
    if (at === -1) {
      throw new PatchError(`Failed to find expected lines in ${path}:\n${oldLines.join('\n')}`)
    }
    edits.push({ at, remove: oldLines.length, insert: [...newLines] })
    cursor = at + oldLines.length
  }
  // Apply from the END so earlier indices stay valid.
  const out = [...lines]
  for (const e of [...edits].sort((a, b) => b.at - a.at)) {
    out.splice(e.at, e.remove, ...e.insert)
  }
  return out
}

/**
 * Derive an Add's content as a line array (a trailing newline is always added,
 * matching the `+`-line model). Returned as `FileLines`-compatible pieces so
 * the caller can join with the right EOL/BOM.
 */
export function addContentsLines(contents: string): string[] {
  const body = contents.replace(/\r\n/g, '\n')
  const withNl = body.endsWith('\n') ? body : body + '\n'
  const lines = withNl.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
