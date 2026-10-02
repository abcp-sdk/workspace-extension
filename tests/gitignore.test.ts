import { describe, expect, it } from 'vitest'
import { GitignoreSet, parseGitignore } from '../src/tools/gitignore.js'

function set(files: Record<string, string>): GitignoreSet {
  return new GitignoreSet(Object.entries(files).map(([dir, body]) => parseGitignore(body, dir)))
}

describe('gitignore matcher', () => {
  it('matches a bare directory name anywhere and everything under it', () => {
    const g = set({ '': 'node_modules/\n' })
    expect(g.ignores('node_modules', true)).toBe(true)
    expect(g.ignores('node_modules/pkg/index.js', false)).toBe(true)
    expect(g.ignores('src/node_modules/x.js', false)).toBe(true)
    expect(g.ignores('src/index.js', false)).toBe(false)
  })

  it('matches a bare file glob at any depth', () => {
    const g = set({ '': '*.log\n' })
    expect(g.ignores('a.log', false)).toBe(true)
    expect(g.ignores('deep/dir/b.log', false)).toBe(true)
    expect(g.ignores('a.log.txt', false)).toBe(false)
  })

  it('honors a leading slash as anchored to the .gitignore directory', () => {
    const g = set({ '': '/build\n' })
    expect(g.ignores('build', true)).toBe(true)
    expect(g.ignores('build/out.js', false)).toBe(true)
    expect(g.ignores('src/build/out.js', false)).toBe(false)
  })

  it('supports negation (last matching pattern wins)', () => {
    const g = set({ '': '*.log\n!keep.log\n' })
    expect(g.ignores('a.log', false)).toBe(true)
    expect(g.ignores('keep.log', false)).toBe(false)
  })

  it('lets a nested .gitignore override its ancestor', () => {
    const g = set({ '': '*.txt\n', 'sub': '!note.txt\n' })
    expect(g.ignores('a.txt', false)).toBe(true)
    expect(g.ignores('sub/note.txt', false)).toBe(false)
    expect(g.ignores('sub/other.txt', false)).toBe(true)
  })

  it('treats a `**` pattern as spanning directories', () => {
    const g = set({ '': '**/dist/\n' })
    expect(g.ignores('dist/x.js', false)).toBe(true)
    expect(g.ignores('a/b/dist/x.js', false)).toBe(true)
  })

  it('ignores comments and blank lines', () => {
    const g = set({ '': '# a comment\n\n  \n*.tmp\n' })
    expect(g.ignores('x.tmp', false)).toBe(true)
    expect(g.ignores('a comment', false)).toBe(false)
  })

  it('does not match a dir-only pattern against a same-named file', () => {
    const g = set({ '': 'cache/\n' })
    expect(g.ignores('cache', true)).toBe(true)
    expect(g.ignores('cache', false)).toBe(false)
  })
})
