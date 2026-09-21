import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import { Forgejo } from '../src/forgejo.js'
import type { WorkspaceDeps } from '../src/deps.js'
import type { SessionEditState } from '../src/tools/edit-state.js'
import {
  repoEdit,
  repoRead,
  repoWrite,
  type RepoCtx,
} from '../src/tools/repo-content.js'

/** In-memory repo backing a real Forgejo client over a fake fetch. */
function fakeRepo() {
  const files = new Map<string, { text: string; sha: string }>()
  let n = 0
  const sha = () => `sha${++n}`
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    // ChangeFiles commit endpoint.
    if (u.endsWith('/contents') && method === 'POST') {
      const body = JSON.parse(String(init!.body))
      const ops = body.files as Array<{ operation: string; path: string; content?: string; sha?: string }>
      for (const f of ops) {
        if (f.operation === 'delete') {
          files.delete(f.path)
          continue
        }
        const text = Buffer.from(f.content ?? '', 'base64').toString()
        files.set(f.path, { text, sha: sha() })
      }
      return new Response(JSON.stringify({ files: [{ last_commit_sha: sha() }] }))
    }
    const m = /\/contents\/(.+?)(\?|$)/.exec(u)
    if (m === null) return new Response('{}', { status: 404 })
    const path = decodeURIComponent(m[1]!)
    if (method === 'GET') {
      const f = files.get(path)
      if (f === undefined) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(f.text).toString('base64'), sha: f.sha, size: f.text.length }))
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { files, forgejo: new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl }) }
}

function ctx(forgejo: Forgejo): RepoCtx {
  let state: SessionEditState = {}
  const deps = {
    loadEditState: async () => state,
    saveEditState: async (_t, _s, next: SessionEditState) => {
      state = next
    },
  } as unknown as WorkspaceDeps
  return { forgejo, deps, tenant: 't', session: 's', locale: 'en' }
}

describe('repo read-before-edit guard', () => {
  it('refuses edit before read', async () => {
    const { forgejo } = fakeRepo()
    const c = ctx(forgejo)
    await repoWrite(c, { org: 'o', repo: 'r', path: 'a.txt', content: '1\n2\n3\n' })
    // write marks seen with sha '', so a fresh read is needed for freshness.
    const err = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-line': 2, 'end-line': 2, content: 'X' }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    // After a write the seen sha is '' which won't match the blob -> retryable
    // (or permission_denied if never recorded). Either way: refused.
    expect(['permission_denied', 'retryable']).toContain((err as TypedToolError).code)
  })

  it('read then edit only seen lines; edit invalidates', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n3\n4\n5\n', sha: 'base' })

    // Read only lines 2-3.
    await repoRead(c, { org: 'o', repo: 'r', path: 'a.txt', offset: 1, limit: 2 })
    // Editing line 5 is refused.
    const err = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-line': 5, 'end-line': 5, content: 'X' }).catch(e => e)
    expect((err as TypedToolError).code).toBe('permission_denied')

    // Editing lines 2-3 succeeds and invalidates.
    await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-line': 2, 'end-line': 3, content: 'X' })
    expect(files.get('a.txt')!.text).toBe('1\nX\n4\n5\n')

    // Second edit without re-read is refused.
    const err2 = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-line': 2, 'end-line': 2, content: 'Y' }).catch(e => e)
    expect((err2 as TypedToolError).code).toBe('permission_denied')
  })

  it('detects a stale read (blob changed underneath)', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n', sha: 's1' })
    await repoRead(c, { org: 'o', repo: 'r', path: 'a.txt' })
    files.set('a.txt', { text: '1\nCHANGED\n', sha: 's2' })
    const err = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-line': 2, 'end-line': 2, content: 'X' }).catch(e => e)
    expect((err as TypedToolError).code).toBe('retryable')
  })

  it('returns a unified diff on edit', async () => {
    const { files, forgejo } = fakeRepo()
    const c = ctx(forgejo)
    files.set('a.txt', { text: '1\n2\n3\n', sha: 's1' })
    await repoRead(c, { org: 'o', repo: 'r', path: 'a.txt' })
    const r = await repoEdit(c, { org: 'o', repo: 'r', path: 'a.txt', 'start-line': 2, 'end-line': 2, content: 'X' })
    expect(r.content).toContain('--- a/a.txt')
    expect(r.content).toContain('-2')
    expect(r.content).toContain('+X')
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
