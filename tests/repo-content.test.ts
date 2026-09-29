import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import { Forgejo } from '../src/forgejo.js'
import type { WorkspaceDeps } from '../src/deps.js'
import {
  repoEdit,
  repoRead,
  repoWrite,
  type RepoCtx,
} from '../src/tools/repo-content.js'

/**
 * In-memory repo backing a real gateway-backed Forgejo client. The file map is
 * `path -> { text, sha }`; sha is bumped per mutation so the read-before-edit
 * freshness check works.
 */
function fakeRepo() {
  const files = new Map<string, { text: string; sha: string }>()
  let n = 0
  const sha = () => `sha${++n}`
  const gateway = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        async (req: Record<string, unknown>) => {
          if (prop === 'contents') {
            const f = files.get(req['path'] as string)
            if (f === undefined) throw { code: 'not_found', message: 'not found' }
            return { isDir: false, text: f.text, sha: f.sha, size: BigInt(f.text.length) }
          }
          if (prop === 'commitFiles' || prop === 'applyFiles') {
            for (const f of (req['files'] as Array<Record<string, unknown>>) ?? []) {
              const p = f['path'] as string
              if (f['operation'] === 'delete') { files.delete(p); continue }
              const bytes = f['contentBytes'] as Uint8Array | undefined
              const text = bytes !== undefined && bytes.length > 0 ? new TextDecoder().decode(bytes) : (f['content'] as string) ?? ''
              files.set(p, { text, sha: sha() })
            }
            return { sha: sha() }
          }
          if (prop === 'repoMeta') return { org: req['org'], repo: req['repo'], defaultBranch: 'main', private: true, empty: false }
          return {}
        },
    },
  )
  return { files, forgejo: new Forgejo({ gateway: gateway as never }) }
}

function ctx(forgejo: Forgejo): RepoCtx {
  const deps = {} as unknown as WorkspaceDeps
  return { forgejo, deps, tenant: 't', session: 'o:r:feat', locale: 'en' }
}

describe('repo anchor-line edit', () => {
  it('replaces the region between two anchors (no read needed)', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n3\n4\n', sha: 'base' })
    await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 4, content: 'X' })
    expect(files.get('a.txt')!.text).toBe('1\nX\n4\n')
  })

  it('inserts between adjacent anchors', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n3\n', sha: 'base' })
    await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 2, content: 'X' })
    expect(files.get('a.txt')!.text).toBe('1\nX\n2\n3\n')
  })

  it('prepends at the head and appends at the tail', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n', sha: 'base' })
    await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-anchor-line': 0, 'end-anchor-line': 1, content: 'HEAD' })
    expect(files.get('a.txt')!.text).toBe('HEAD\n1\n2\n')
    await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-anchor-line': 3, 'end-anchor-line': '', content: 'TAIL' })
    expect(files.get('a.txt')!.text).toBe('HEAD\n1\n2\nTAIL\n')
  })

  it('returns a unified diff on edit', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n3\n', sha: 's1' })
    const r = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 3, content: 'X' })
    expect(r.content).toContain('--- a/a.txt')
    expect(r.content).toContain('-2')
    expect(r.content).toContain('+X')
  })

  it('rejects an out-of-range anchor (no commit)', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: 'alpha\nbeta\n', sha: 's1' })
    const err = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-anchor-line': 5, 'end-anchor-line': 6, content: 'X' }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
    expect(files.get('a.txt')!.text).toBe('alpha\nbeta\n')
  })

  it('reports no changes on a no-op edit', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n', sha: 's1' })
    const r = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 3, content: '2' })
    expect(String(r.content)).toContain('No changes')
  })
})


describe('repo naming validation', () => {
  it('rejects illegal org/repo/ref names', async () => {
    const { forgejo } = fakeRepo()
    const c = ctx(forgejo)
    const bad: Array<Record<string, unknown>> = [
      { org: 'a:b', repo: 'r', path: 'x' },
      { org: 'o', repo: '../r', path: 'x' },
      { org: 'o', repo: 'r', ref: 'a..b', path: 'x' },
      { org: 'o', repo: 'r', ref: 'x/', path: 'x' },
    ]
    for (const args of bad) {
      const err = await repoRead(c, args).catch(e => e)
      expect((err as TypedToolError).code, JSON.stringify(args)).toBe('invalid_argument')
    }
  })

  it('accepts legal names (feature branches)', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: 'hi\n', sha: 's1' })
    await repoRead(c, { org: 'acme', repo: 'web-app', ref: 'feat/x_1.2', path: 'a.txt' })
  })
})
