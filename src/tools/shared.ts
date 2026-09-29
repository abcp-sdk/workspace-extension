import { TypedToolError } from '@abc-protocol/sdk'
import { tr } from '../i18n.js'
import { expandTilde, type EditRangeError } from './text.js'

/**
 * Return `args` with a leading `~` expanded in the given string path keys
 * (`~` / `~/` => home, `~/x` => `<home>/x`). A shallow copy is made ONLY when a
 * value actually changes, so the common no-`~` case allocates nothing.
 */
export function expandPathArgs(
  args: Record<string, unknown>,
  keys: readonly string[],
  anchors: { home: string; workspace: string },
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined
  for (const k of keys) {
    const v = args[k]
    if (typeof v !== 'string' || v === '') continue
    const e = expandTilde(v, anchors)
    if (e === v) continue
    out ??= { ...args }
    out[k] = e
  }
  return out ?? args
}

/** Map a resolved-anchor failure to its localized `invalid_argument` error. */
export function rangeError(
  locale: string,
  path: string,
  total: number,
  reason: EditRangeError,
  startAnchor: number,
  endAnchor: number,
): TypedToolError {
  switch (reason) {
    case 'startAnchorMin':
      return new TypedToolError(
        'invalid_argument',
        tr(locale, 'editStartAnchorRange', { start: startAnchor, total }),
      )
    case 'endAnchorMax':
      return new TypedToolError(
        'invalid_argument',
        tr(locale, 'editEndAnchorRange', { end: endAnchor, total }),
      )
    case 'anchorOrder':
      return new TypedToolError(
        'invalid_argument',
        tr(locale, 'editAnchorOrder', { start: startAnchor, end: endAnchor }),
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

/**
 * Read an anchor-line argument. A NUMBER is used as-is. An EMPTY STRING is the
 * sentinel for the head/tail boundary (`emptyValue`); a missing or otherwise
 * malformed value falls back to `emptyValue` too (the caller validates range).
 */
export function anchorArg(
  args: Record<string, unknown>,
  key: string,
  emptyValue: number,
): number {
  const v = args[key]
  if (typeof v === 'string' && v.trim() === '') return emptyValue
  const n = numArg(args, key)
  return n === undefined ? emptyValue : Math.trunc(n)
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
