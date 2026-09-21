import { describe, expect, it } from 'vitest'
import { unifiedDiff } from '../src/tools/diff.js'

describe('unifiedDiff', () => {
  it('returns empty for identical inputs', () => {
    const r = unifiedDiff('a\nb\n', 'a\nb\n', 'f.txt')
    expect(r.text).toBe('')
    expect(r).toMatchObject({ added: 0, removed: 0 })
  })

  it('renders a standard single-hunk replace', () => {
    const r = unifiedDiff('1\n2\n3\n4\n', '1\nX\n3\n4\n', 'f.txt')
    expect(r.text).toBe(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,4 +1,4 @@',
        ' 1',
        '-2',
        '+X',
        ' 3',
        ' 4',
      ].join('\n'),
    )
    expect(r).toMatchObject({ added: 1, removed: 1 })
  })

  it('handles pure insertion', () => {
    const r = unifiedDiff('a\nb\n', 'a\nX\nb\n', 'f.txt')
    expect(r.text).toContain('+X')
    expect(r.text).not.toContain('-a')
    expect(r).toMatchObject({ added: 1, removed: 0 })
  })

  it('handles pure deletion', () => {
    const r = unifiedDiff('a\nb\nc\n', 'a\nc\n', 'f.txt')
    expect(r.text).toContain('-b')
    expect(r).toMatchObject({ added: 0, removed: 1 })
  })

  it('splits distant changes into separate hunks', () => {
    const oldT = ['a', ...Array(20).fill('x'), 'z'].join('\n') + '\n'
    const newT = ['A', ...Array(20).fill('x'), 'Z'].join('\n') + '\n'
    const r = unifiedDiff(oldT, newT, 'f.txt')
    expect(r.text.match(/@@ /g)?.length).toBe(2)
  })

  it('merges nearby changes into one hunk', () => {
    const oldT = 'a\nb\nc\nd\ne\nf\n'
    const newT = 'a\nB\nc\nd\nE\nf\n'
    const r = unifiedDiff(oldT, newT, 'f.txt')
    expect(r.text.match(/@@ /g)?.length).toBe(1)
  })

  it('marks a missing final newline', () => {
    const r = unifiedDiff('a\nb', 'a\nb\n', 'f.txt')
    expect(r.text).toContain('\\ No newline at end of file')
  })

  it('creates a file from empty', () => {
    const r = unifiedDiff('', 'a\nb\n', 'f.txt')
    expect(r.text).toContain('--- a/f.txt')
    expect(r.text).toContain('+a')
    expect(r.text).toContain('+b')
    expect(r.added).toBe(2)
  })

  it('trims all content', () => {
    const r = unifiedDiff('a\nb\nc\n', '', 'f.txt')
    expect(r.removed).toBe(3)
    expect(r.text).toContain('-a')
    expect(r.text).toContain('-c')
  })
})
