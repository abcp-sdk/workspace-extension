import { createHash } from 'node:crypto'

/**
 * Read-before-edit guard state. The extension enforces that a session may only
 * `edit` a file (and only the line ranges) it has actually SEEN via `read`, and
 * that the file has not changed underneath it. State is keyed per
 * (tenant, session) and persisted by the host (NATS KV), so it survives
 * restarts and is shared across replicas.
 */

/** A 1-based inclusive line range. */
export type LineRange = [number, number]

/** The last-seen state of one file for a session. */
export interface FileReadState {
  /** Display path (for messages). */
  path: string
  /**
   * sha256 (hex) of the bytes at the time it was last seen. When `winStart`
   * is set this is the hash of the FETCHED WINDOW (not the whole file);
   * otherwise (legacy records and whole-file reads) of the whole file.
   */
  sha256: string
  /** Merged, sorted, non-overlapping 1-based inclusive ranges that were seen. */
  ranges: LineRange[]
  /** Epoch millis of the last update (diagnostics). */
  updatedAt: number
  /**
   * Windowed-read metadata (0-based, end-exclusive): the sha256 covers lines
   * [winStart, winEnd) fetched from the worker. `edit` re-fetches the SAME
   * window and compares hashes — as sound as a whole-file hash for
   * line-numbered editing: any line-count change shifts the window content
   * (hash differs), and content changes inside the window differ too.
   */
  winStart?: number
  winEnd?: number
  /** Total lines at read time (diagnostics; staleness is hash-based). */
  totalLines?: number
}

/** A session's seen-file map: pathHash -> FileReadState. */
export type SessionEditState = Record<string, FileReadState>

/** Stable KV-safe key for a path (paths may contain KV-illegal characters). */
export function pathHash(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32)
}

/** sha256 (hex) of file bytes. */
export function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Merge `[s, e]` into a sorted, non-overlapping, coalesced range list. */
export function mergeRanges(ranges: LineRange[], s: number, e: number): LineRange[] {
  if (e < s) return ranges.map(r => [...r] as LineRange)
  const all = [...ranges.map(r => [...r] as LineRange), [s, e] as LineRange]
  all.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: LineRange[] = []
  for (const r of all) {
    const last = out[out.length - 1]
    if (last !== undefined && r[0] <= last[1] + 1) {
      if (r[1] > last[1]) last[1] = r[1]
    } else {
      out.push([r[0], r[1]])
    }
  }
  return out
}

/** True when every line in `[s, e]` is covered by `ranges`. `e < s` = empty. */
export function rangesCover(ranges: LineRange[], s: number, e: number): boolean {
  if (e < s) return true
  for (let line = s; line <= e; line++) {
    if (!ranges.some(r => line >= r[0] && line <= r[1])) return false
  }
  return true
}

/** Compact human rendering of seen ranges, e.g. `1-50, 100-200` (or `none`). */
export function formatRanges(ranges: LineRange[]): string {
  if (ranges.length === 0) return 'none'
  return ranges
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(', ')
}

/** Record that lines `[s, e]` of `path` were seen, with the hash. */
export function recordSeen(
  state: SessionEditState,
  path: string,
  sha256: string,
  ranges: LineRange[],
  now: number,
  win?: { start: number; end: number; totalLines: number },
): SessionEditState {
  const key = pathHash(path)
  const prev = state[key]
  let merged = prev?.ranges ?? []
  for (const [s, e] of ranges) merged = mergeRanges(merged, s, e)
  return {
    ...state,
    [key]: {
      path,
      sha256,
      ranges: merged,
      updatedAt: now,
      ...(win !== undefined
        ? { winStart: win.start, winEnd: win.end, totalLines: win.totalLines }
        : {}),
    },
  }
}

/** Drop a file's seen state (edit invalidates it — a re-read is required). */
export function invalidate(
  state: SessionEditState,
  path: string,
): SessionEditState {
  const key = pathHash(path)
  if (state[key] === undefined) return state
  const next = { ...state }
  delete next[key]
  return next
}

/** The seen state for a path, or null when never read. */
export function seenFor(
  state: SessionEditState,
  path: string,
): FileReadState | null {
  return state[pathHash(path)] ?? null
}
