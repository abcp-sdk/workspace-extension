import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import { Forgejo } from '../src/forgejo.js'
import type { WorkspaceDeps } from '../src/deps.js'
import { repoRead, type RepoCtx } from '../src/tools/repo-content.js'

/**
 * In-memory repo backing a real gateway-backed Forgejo client. The file map is
 * `path -> { text, sha }`.
 *
 * `contents` models the REAL gateway: its `text` is a protobuf `string`, whose
 * decoder STRIPS a leading BOM. `readRaw` carries `bytes`, so the BOM survives.
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
            const text = f.text.charCodeAt(0) === 0xfeff ? f.text.slice(1) : f.text
            return { isDir: false, text, sha: f.sha, size: BigInt(f.text.length) }
          }
          if (prop === 'readRaw') {
            const f = files.get(req['path'] as string)
            if (f === undefined) throw { code: 'not_found', message: 'not found' }
            return { data: new TextEncoder().encode(f.text), sha: f.sha, mime: 'text/plain', isText: true }
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

describe('repo-file-read', () => {
  it('reads a window with line numbers', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: 'l1\nl2\nl3\nl4\n', sha: 'base' })
    const r = await repoRead(c, { org: 'o', repo: 'r', path: 'a.txt', offset: 1, limit: 2 })
    expect(String(r.content)).toContain('2  l2')
    expect(String(r.content)).toContain('3  l3')
  })

  it('defaults ref to the session branch', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: 'x\n', sha: 'base' })
    const r = await repoRead(c, { org: 'o', repo: 'r', path: 'a.txt' })
    expect((r.data as Record<string, unknown>)['ref']).toBe('feat')
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
