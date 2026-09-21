import { describe, expect, it } from 'vitest'
import { walkTree, type DirEntry, type ListDir } from '../src/tools/list.js'

function tree(spec: Record<string, DirEntry[]>, files: Record<string, DirEntry> = {}): ListDir {
  return async (path: string) => {
    if (spec[path] !== undefined) return { isDir: true, entries: spec[path]! }
    if (files[path] !== undefined) return { isDir: false, entries: [files[path]!] }
    throw new Error(`no such path: ${path}`)
  }
}

const dir = (path: string, isDir = true, size = 0): DirEntry => ({ path, isDir, size })

describe('walkTree', () => {
  it('emits level order, parents before children', async () => {
    const listDir = tree({
      '.': [dir('a'), dir('b')],
      a: [dir('a/x'), dir('a/y')],
      b: [dir('b/z')],
      'a/x': [dir('a/x/deep')],
    })
    const w = await walkTree(listDir, { root: '', depth: 2, limit: 200 })
    expect(w.rows.map(r => r.path)).toEqual(['a', 'b', 'a/x', 'a/y', 'b/z'])
    expect(w.rows.filter(r => r.depth === 1)).toHaveLength(2)
    expect(w.rows.filter(r => r.depth === 2)).toHaveLength(3)
  })

  it('stops expanding when level 1 fills the limit', async () => {
    const listDir = tree({
      '.': [dir('a'), dir('b')],
      a: [dir('a/x')],
      b: [dir('b/z')],
    })
    const w = await walkTree(listDir, { root: '', depth: 3, limit: 2 })
    expect(w.rows.map(r => r.path)).toEqual(['a', 'b'])
    expect(w.limitHit).toBe(true)
  })

  it('records an omission for a partially-emitted directory', async () => {
    const listDir = tree({
      '.': [dir('a'), dir('b')],
      a: [dir('a/1'), dir('a/2'), dir('a/3')],
      b: [],
    })
    const w = await walkTree(listDir, { root: '', depth: 2, limit: 3 })
    // level1 = a, b (2 rows); only one child of `a` fits before the cap.
    expect(w.rows.map(r => r.path)).toEqual(['a', 'b', 'a/1'])
    expect(w.omissions).toEqual([{ path: 'a', count: 2 }])
    expect(w.limitHit).toBe(true)
  })

  it('honors depth: deeper dirs are marked atMaxDepth', async () => {
    const listDir = tree({
      '.': [dir('a')],
      a: [dir('a/b')],
    })
    const w = await walkTree(listDir, { root: '', depth: 1, limit: 200 })
    expect(w.rows).toEqual([
      { path: 'a', depth: 1, size: 0, isDir: true, atMaxDepth: true },
    ])
  })

  it('handles a file root as a single row', async () => {
    const listDir = tree({}, { 'f.txt': dir('f.txt', false, 3) })
    const w = await walkTree(listDir, { root: 'f.txt', depth: 3, limit: 200 })
    expect(w.rows).toHaveLength(1)
    expect(w.rows[0]!.isDir).toBe(false)
  })
})
