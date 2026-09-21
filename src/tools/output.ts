/**
 * Tool-result rendering limits. The abc protocol HARD-REJECTS a tool's
 * `content` above 128 KiB (MAX_TOOL_CONTENT_BYTES in the SDK), so the renderer
 * caps at 1000 lines AND 120 KiB (headroom below 128 KiB) and reports the
 * truncation instead of letting the SDK turn the result into an error.
 */
import { tr } from '../i18n.js'

export const MAX_RESULT_LINES = 1000
/** 120 KiB < the protocol's 128 KiB hard cap. */
export const MAX_RESULT_BYTES = 120 * 1024

/** Render a byte count for humans (B / KB / MB / GB / TB). */
export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export interface Capped {
  kept: string[]
  truncated: boolean
  /** Why truncation happened: line cap, byte cap, or neither. */
  reason: 'lines' | 'bytes' | null
}

/**
 * Cap a list of lines by count and cumulative UTF-8 bytes. Both limits are
 * inclusive of the last kept line; `reason` names the first limit that hit.
 */
export function capLines(
  lines: readonly string[],
  maxLines = MAX_RESULT_LINES,
  maxBytes = MAX_RESULT_BYTES,
): Capped {
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    if (kept.length >= maxLines) {
      return { kept, truncated: true, reason: 'lines' }
    }
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (bytes + cost > maxBytes) {
      return { kept, truncated: true, reason: 'bytes' }
    }
    kept.push(line)
    bytes += cost
  }
  return { kept, truncated: false, reason: null }
}

/** A one-line note describing a truncation (or '' when nothing was cut). */
export function truncationNote(
  c: Capped,
  shown: number,
  total: number,
  locale = 'en',
): string {
  if (!c.truncated) return ''
  const why =
    c.reason === 'bytes'
      ? tr(locale, 'whyBytes', { size: humanSize(MAX_RESULT_BYTES) })
      : tr(locale, 'whyLines', { lines: MAX_RESULT_LINES })
  return tr(locale, 'truncatedAfter', { shown, total, why })
}
