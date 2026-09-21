import { describe, expect, it } from 'vitest'
import { capLines, humanSize, MAX_RESULT_LINES, truncationNote } from '../src/tools/output.js'

describe('humanSize', () => {
  it('formats bytes and scales units', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(1023)).toBe('1023 B')
    expect(humanSize(1024)).toBe('1.0 KB')
    expect(humanSize(1536)).toBe('1.5 KB')
    expect(humanSize(10 * 1024 * 1024)).toBe('10 MB')
  })
})

describe('capLines', () => {
  it('keeps everything under both caps', () => {
    const c = capLines(['a', 'b', 'c'])
    expect(c.kept).toEqual(['a', 'b', 'c'])
    expect(c.truncated).toBe(false)
    expect(c.reason).toBeNull()
  })

  it('caps by line count', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `l${i}`)
    const c = capLines(lines, 3, 1024)
    expect(c.kept).toEqual(['l0', 'l1', 'l2'])
    expect(c.truncated).toBe(true)
    expect(c.reason).toBe('lines')
  })

  it('caps by bytes', () => {
    const c = capLines(['aaaa', 'bbbb', 'cccc'], 100, 9)
    expect(c.kept).toEqual(['aaaa', 'bbbb'])
    expect(c.reason).toBe('bytes')
  })

  it('respects the default line cap', () => {
    const lines = Array.from({ length: MAX_RESULT_LINES + 5 }, (_, i) => `${i}`)
    expect(capLines(lines).kept).toHaveLength(MAX_RESULT_LINES)
  })
})

describe('truncationNote', () => {
  it('is empty when nothing was cut', () => {
    expect(truncationNote({ kept: [], truncated: false, reason: null }, 0, 0)).toBe('')
  })
  it('mentions lines when line-capped', () => {
    const note = truncationNote({ kept: [], truncated: true, reason: 'lines' }, 3, 10)
    expect(note).toContain('3 of 10 lines')
  })
})
