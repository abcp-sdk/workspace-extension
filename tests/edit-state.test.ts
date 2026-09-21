import { describe, expect, it } from 'vitest'
import {
  formatRanges,
  invalidate,
  mergeRanges,
  pathHash,
  rangesCover,
  recordSeen,
  seenFor,
  type LineRange,
} from '../src/tools/edit-state.js'

describe('mergeRanges', () => {
  it('keeps disjoint ranges sorted', () => {
    expect(mergeRanges([[5, 8]], 1, 3)).toEqual([
      [1, 3],
      [5, 8],
    ])
  })

  it('coalesces adjacent ranges', () => {
    expect(mergeRanges([[1, 3]], 4, 6)).toEqual([[1, 6]])
  })

  it('coalesces overlapping ranges', () => {
    expect(mergeRanges([[1, 5]], 3, 8)).toEqual([[1, 8]])
  })

  it('absorbs a contained range', () => {
    expect(mergeRanges([[1, 10]], 4, 6)).toEqual([[1, 10]])
  })

  it('ignores an empty range (e < s)', () => {
    expect(mergeRanges([[1, 3]], 5, 4)).toEqual([[1, 3]])
  })
})

describe('rangesCover', () => {
  it('is true when every line is covered', () => {
    expect(rangesCover([[1, 50]], 10, 20)).toBe(true)
  })

  it('is true across a coalesced gap-free span', () => {
    expect(rangesCover([[1, 5], [6, 10]], 3, 8)).toBe(true)
  })

  it('is false when a line falls in a gap', () => {
    expect(rangesCover([[1, 5], [10, 15]], 4, 11)).toBe(false)
  })

  it('is true for an empty range', () => {
    expect(rangesCover([], 3, 2)).toBe(true)
  })
})

describe('formatRanges', () => {
  it('renders singles and spans', () => {
    expect(formatRanges([[1, 1], [3, 5]])).toBe('1, 3-5')
    expect(formatRanges([])).toBe('none')
  })
})

describe('recordSeen / invalidate', () => {
  it('accumulates ranges per path and invalidates on edit', () => {
    let s = {}
    s = recordSeen(s, 'a.txt', 'h1', [[1, 10]], 1000)
    s = recordSeen(s, 'a.txt', 'h2', [[20, 30]], 1001)
    const seen = seenFor(s, 'a.txt')
    expect(seen?.ranges).toEqual([
      [1, 10],
      [20, 30],
    ])
    expect(seen?.sha256).toBe('h2')
    s = invalidate(s, 'a.txt')
    expect(seenFor(s, 'a.txt')).toBeNull()
  })

  it('keys by path hash (no path leaks into the KV key)', () => {
    expect(pathHash('a.b/c.txt')).toMatch(/^[0-9a-f]{32}$/)
    expect(pathHash('a.b/c.txt')).toBe(pathHash('a.b/c.txt'))
    expect(pathHash('a.b/c.txt')).not.toBe(pathHash('a/b/c.txt'))
  })

  it('records an empty range list for an empty file read', () => {
    const s = recordSeen({}, 'empty.txt', 'h', [] as LineRange[], 1)
    expect(seenFor(s, 'empty.txt')?.ranges).toEqual([])
  })
})
