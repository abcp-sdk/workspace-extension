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
  let state: SessionEditState = {}
  const deps = {
    loadEditState: async () => state,
    saveEditState: async (_t, _s, next: SessionEditState) => {
      state = next
    },
  } as unknown as WorkspaceDeps
  return { forgejo, deps, tenant: 't', session: 'o:r:feat', locale: 'en' }
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
