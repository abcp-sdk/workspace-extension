import { TypedToolError } from '@abc-protocol/sdk'
import { tr } from '../i18n.js'
import type { AnchorError, EditRangeError } from './text.js'

/** Clip long line text for an error message. */
export function clip(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** Build the typed error for a failed anchor check. */
export function anchorError(
  locale: string,
  path: string,
  kind: 'before' | 'after',
  line: number,
  total: number,
  c: AnchorError,
): TypedToolError {
  const kindSide = anchorSide(locale, kind)
  if (c.reason === 'missing') {
    return new TypedToolError(
      'retryable',
      tr(locale, 'editAnchorMissing', {
        kind,
        kindSide,
        line,
        path,
        actual: clip(c.actual),
      }),
    )
  }
  if (c.reason === 'mismatch') {
    return new TypedToolError(
      'retryable',
      tr(locale, 'editAnchorMismatch', {
        kind,
        kindSide,
        line,
        path,
        expected: clip(c.expected),
        actual: clip(c.actual),
      }),
    )
  }
  return new TypedToolError(
    'retryable',
    tr(locale, 'editAnchorOutOfRange', { kind, kindSide, line, path, total }),
  )
}

/** Localized word for which side of the edit region an anchor guards. */
function anchorSide(locale: string, kind: 'before' | 'after'): string {
  const zh = locale.toLowerCase().startsWith('zh')
  if (kind === 'before') return zh ? '上方' : 'above'
  return zh ? '下方' : 'below'
}

/** Map a resolved-range failure to its localized `invalid_argument` error. */
export function rangeError(
  locale: string,
  path: string,
  total: number,
  reason: EditRangeError,
  startLine: number,
  endLine: number,
): TypedToolError {
  switch (reason) {
    case 'startLineMin':
      return new TypedToolError('invalid_argument', tr(locale, 'startLineMin'))
    case 'endLineBeforeStart':
      return new TypedToolError('invalid_argument', tr(locale, 'editEndLineBeforeStart'))
    case 'startLinePastEnd':
      return new TypedToolError(
        'invalid_argument',
        tr(locale, 'editStartLinePastEnd', { start: startLine, path, total }),
      )
    case 'endLinePastEnd':
      return new TypedToolError(
        'invalid_argument',
        tr(locale, 'editEndLinePastEnd', { end: endLine, path, total }),
      )
  }
}

/** Read a string tool argument (missing/typed wrong = ""). */
export function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

/** True when a key is PRESENT (even with an empty-string value). */
export function hasArg(args: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(args, key)
}

export function numArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function requireArg(
  args: Record<string, unknown>,
  key: string,
  locale = 'en',
): string {
  const v = strArg(args, key)
  if (v === '') {
    throw new TypedToolError('invalid_argument', tr(locale, 'argRequired', { key }))
  }
  return v
}

/**
 * Read a `timeout` argument in SECONDS, clamped to [1, max]; defaults to
 * `def` when absent. Non-positive/invalid values fall back to `def`.
 */
export function secondsArg(
  args: Record<string, unknown>,
  def: number,
  max: number,
): number {
  const v = numArg(args, 'timeout')
  const n = v === undefined ? def : Math.floor(v)
  const clamped = Math.min(Math.max(n, 1), max)
  return Number.isFinite(clamped) ? clamped : def
}

/** Read an `env` argument as a string→string map (non-string values dropped). */
export function envArg(args: Record<string, unknown>): Record<string, string> {
  const raw = args['env']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** Basename of a workspace path (both separators tolerated). */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

/** Format a value for a text tool result (JSON for objects). */
export function render(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

/** Bare domain of a URL: drops scheme, port, path (e.g. `wm-x.ns.svc.cluster.local`). */
export function domainOf(url: string): string {
  const noScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const slash = noScheme.indexOf('/')
  const hostPort = slash >= 0 ? noScheme.slice(0, slash) : noScheme
  // IPv6 [::1]:port -> keep bracketed host; otherwise strip the port.
  const m = /^(\[[^\]]+\])(?::\d+)?$/.exec(hostPort)
  if (m) return m[1]!
  const colon = hostPort.lastIndexOf(':')
  return colon >= 0 ? hostPort.slice(0, colon) : hostPort
}
