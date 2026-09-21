/**
 * Dependency-free line-level unified diff. Produces a standard patch body
 * (`--- a/<path>` / `+++ b/<path>` headers, `@@` hunks, 3 lines of context)
 * with no external package. For very large inputs the LCS table would be
 * O(n·m), so above a threshold we fall back to a single-hunk common
 * prefix/suffix trim (correct, just less minimal).
 */

/** One side of a diff, split into lines with an explicit end-of-line flag. */
interface Side {
  lines: string[]
  /** True when the source did NOT end with a newline. */
  noEol: boolean
}

/** Split text for diffing: normalize CRLF, remember a missing final newline. */
function splitSide(text: string): Side {
  const s = text.replace(/\r\n/g, '\n')
  if (s === '') return { lines: [], noEol: false }
  const noEol = !s.endsWith('\n')
  const body = noEol ? s : s.slice(0, -1)
  return { lines: body.split('\n'), noEol }
}

/** A line annotated with whether it is the (newline-less) last line. */
interface ALine {
  text: string
  noEol: boolean
}

function annotate(side: Side): ALine[] {
  const out: ALine[] = side.lines.map(text => ({ text, noEol: false }))
  if (side.noEol && out.length > 0) out[out.length - 1]!.noEol = true
  return out
}

function sameLine(a: ALine, b: ALine): boolean {
  return a.text === b.text && a.noEol === b.noEol
}

type OpKind = 'keep' | 'del' | 'add'

interface Op {
  kind: OpKind
  old?: ALine
  new?: ALine
}

/** Above this many cells (old×new) the O(n·m) LCS is skipped. */
const LCS_CELL_LIMIT = 4_000_000

/** LCS-based edit script aligning `a` to `b` (minimal). */
function lcsOps(a: ALine[], b: ALine[]): Op[] {
  const n = a.length
  const m = b.length
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () =>
    new Int32Array(m + 1),
  )
  for (let i = 1; i <= n; i++) {
    const row = dp[i]!
    const prev = dp[i - 1]!
    for (let j = 1; j <= m; j++) {
      row[j] =
        sameLine(a[i - 1]!, b[j - 1]!)
          ? prev[j - 1]! + 1
          : Math.max(prev[j]!, row[j - 1]!)
    }
  }
  const ops: Op[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (sameLine(a[i - 1]!, b[j - 1]!)) {
      ops.push({ kind: 'keep', old: a[i - 1]!, new: b[j - 1]! })
      i--
      j--
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ kind: 'del', old: a[i - 1]! })
      i--
    } else {
      ops.push({ kind: 'add', new: b[j - 1]! })
      j--
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', old: a[i - 1]! })
    i--
  }
  while (j > 0) {
    ops.push({ kind: 'add', new: b[j - 1]! })
    j--
  }
  ops.reverse()
  return ops
}

/** Fallback edit script: common prefix/suffix trim, one del/add block. */
function trimOps(a: ALine[], b: ALine[]): Op[] {
  let p = 0
  while (p < a.length && p < b.length && sameLine(a[p]!, b[p]!)) p++
  let s = 0
  while (
    s < a.length - p &&
    s < b.length - p &&
    sameLine(a[a.length - 1 - s]!, b[b.length - 1 - s]!)
  ) {
    s++
  }
  const ops: Op[] = []
  for (let k = 0; k < p; k++) ops.push({ kind: 'keep', old: a[k]!, new: b[k]! })
  for (let k = p; k < a.length - s; k++) ops.push({ kind: 'del', old: a[k]! })
  for (let k = p; k < b.length - s; k++) ops.push({ kind: 'add', new: b[k]! })
  for (let k = a.length - s; k < a.length; k++)
    ops.push({ kind: 'keep', old: a[k]!, new: b[k]! })
  return ops
}

interface Positioned {
  op: Op
  oldIdx: number // 0-based index into old lines, or -1
  newIdx: number // 0-based index into new lines, or -1
}

function position(ops: Op[]): Positioned[] {
  const out: Positioned[] = []
  let oi = 0
  let ni = 0
  for (const op of ops) {
    if (op.kind === 'keep') {
      out.push({ op, oldIdx: oi, newIdx: ni })
      oi++
      ni++
    } else if (op.kind === 'del') {
      out.push({ op, oldIdx: oi, newIdx: -1 })
      oi++
    } else {
      out.push({ op, oldIdx: -1, newIdx: ni })
      ni++
    }
  }
  return out
}

/** Emit a diff line, plus the `\ No newline` marker when the side lacks EOL. */
function emit(out: string[], prefix: ' ' | '-' | '+', line: ALine): void {
  out.push(`${prefix}${line.text}`)
  if (line.noEol) out.push('\\ No newline at end of file')
}

export interface UnifiedDiffResult {
  /** The full patch text ('' when the inputs are identical). */
  text: string
  added: number
  removed: number
}

/**
 * Compute a unified diff between two texts. `path` is used for the `a/` and
 * `b/` headers. Returns `text: ''` when the contents are identical.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
  context = 3,
): UnifiedDiffResult {
  if (oldText === newText) return { text: '', added: 0, removed: 0 }
  const oldSide = splitSide(oldText)
  const newSide = splitSide(newText)
  const a = annotate(oldSide)
  const b = annotate(newSide)

  const ops =
    a.length * b.length > LCS_CELL_LIMIT ? trimOps(a, b) : lcsOps(a, b)
  const pos = position(ops)

  const changed: number[] = []
  for (let i = 0; i < pos.length; i++) {
    if (pos[i]!.op.kind !== 'keep') changed.push(i)
  }
  if (changed.length === 0) return { text: '', added: 0, removed: 0 }

  const ctx = Math.max(0, Math.floor(context))
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]

  // Group changes within 2*ctx of each other into one hunk.
  const groups: Array<{ start: number; end: number }> = []
  for (const c of changed) {
    const last = groups[groups.length - 1]
    if (last === undefined || c - last.end > 2 * ctx) {
      groups.push({ start: c, end: c })
    } else if (c > last.end) {
      last.end = c
    }
  }

  let added = 0
  let removed = 0
  for (const g of groups) {
    const lo = Math.max(0, g.start - ctx)
    const hi = Math.min(pos.length - 1, g.end + ctx)
    let oldStart = -1
    let newStart = -1
    let oldCount = 0
    let newCount = 0
    const body: string[] = []
    // Buffer consecutive changed lines so deletions always precede additions
    // (the LCS backtrack may interleave them), matching standard unified diffs.
    let pendingDel: string[] = []
    let pendingAdd: string[] = []
    const flush = () => {
      body.push(...pendingDel, ...pendingAdd)
      pendingDel = []
      pendingAdd = []
    }
    for (let i = lo; i <= hi; i++) {
      const p = pos[i]!
      if (p.op.kind === 'keep') {
        flush()
        if (oldStart < 0) {
          oldStart = p.oldIdx + 1
          newStart = p.newIdx + 1
        }
        oldCount++
        newCount++
        emit(body, ' ', p.op.old!)
      } else if (p.op.kind === 'del') {
        if (oldStart < 0) oldStart = p.oldIdx + 1
        oldCount++
        removed++
        const lines: string[] = []
        emit(lines, '-', p.op.old!)
        pendingDel.push(...lines)
      } else {
        if (newStart < 0) newStart = p.newIdx + 1
        newCount++
        added++
        const lines: string[] = []
        emit(lines, '+', p.op.new!)
        pendingAdd.push(...lines)
      }
    }
    flush()
    if (oldStart < 0) oldStart = 1
    if (newStart < 0) newStart = 1
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    out.push(...body)
  }

  return { text: out.join('\n'), added, removed }
}
