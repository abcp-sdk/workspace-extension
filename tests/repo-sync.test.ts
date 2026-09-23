import { describe, expect, it } from 'vitest'
import { Forgejo } from '../src/forgejo.js'
import { repoBranchSync, repoRestore } from '../src/tools/repo-sync.js'
import type { RepoCtx } from '../src/tools/repo-content.js'

interface SyncCall {
  org: string
  repo: string
  branch: string
}

function syncCtx(result: { clean: boolean; conflicts?: string[]; commit?: string }, session = 'acme:web:feature/x') {
  const calls: SyncCall[] = []
  const c = {
    forgejo: new Forgejo({ gateway: {} as never }),
    gateway: {
      async syncBranch(r: SyncCall) {
        calls.push(r)
        return { clean: result.clean, conflicts: result.conflicts ?? [], commit: result.commit ?? 'abc123def' }
      },
    },
    deps: {} as never,
    tenant: 't1',
    session,
    locale: 'en',
  } as unknown as RepoCtx
  return { c, calls }
}

describe('repo-branch-sync', () => {
  it('derives org/repo/branch from the session and reports a clean sync', async () => {
    const { c, calls } = syncCtx({ clean: true, commit: 'deadbeefcafe' })
    const res = await repoBranchSync(c, {})
    expect(calls).toEqual([{ org: 'acme', repo: 'web', branch: 'feature/x' }])
    expect(res.data).toMatchObject({ org: 'acme', repo: 'web', branch: 'feature/x', clean: true })
    expect(String(res.content)).toContain('deadbeef')
  })

  it('reports conflicts and lists the paths', async () => {
    const { c } = syncCtx({ clean: false, conflicts: ['src/a.ts', 'src/b.ts'] })
    const res = await repoBranchSync(c, {})
    expect(res.data).toMatchObject({ clean: false, conflicts: ['src/a.ts', 'src/b.ts'] })
    expect(String(res.content)).toContain('src/a.ts')
  })

  it('accepts explicit overrides', async () => {
    const { c, calls } = syncCtx({ clean: true })
    await repoBranchSync(c, { org: 'o', repo: 'r', branch: 'dev' })
    expect(calls).toEqual([{ org: 'o', repo: 'r', branch: 'dev' }])
  })

  it('refuses main and non-session use without args', async () => {
    const { c } = syncCtx({ clean: true })
    await expect(repoBranchSync(c, { branch: 'main' })).rejects.toThrow(/main/)
    const s = syncCtx({ clean: true }, 'plain-session')
    await expect(repoBranchSync(s.c, {})).rejects.toThrow(/branch/)
  })
})

function restoreCtx() {
  const writes: Array<{ path: string; ref?: string; binary: boolean; text?: string }> = []
  const c = {
    forgejo: {
      async getRaw(_org: string, _repo: string, _path: string, _ref: string) {
        return new Uint8Array([104, 105, 10]) // "hi\n"
      },
      async applyFiles(_org: string, _repo: string, files: Array<{ path: string; content?: string }>, opts: { ref?: string }) {
        writes.push({ path: files[0]!.path, ref: opts.ref, binary: false, text: files[0]!.content })
        return { sha: 'cafebabe01', message: 'ok' }
      },
    },
    gateway: {} as never,
    deps: {} as never,
    tenant: 't1',
    session: 'acme:web:feature/x',
    locale: 'en',
  } as unknown as RepoCtx
  return { c, writes }
}

describe('repo-file-restore', () => {
  it('restores text content from a ref onto the target branch', async () => {
    const { c, writes } = restoreCtx()
    const res = await repoRestore(c, { org: 'acme', repo: 'web', path: 'a.txt', from: 'main', ref: 'feature/x' })
    expect(writes).toEqual([{ path: 'a.txt', ref: 'feature/x', binary: false, text: 'hi\n' }])
    expect(res.data).toMatchObject({ path: 'a.txt', from: 'main', ref: 'feature/x', binary: false })
  })

  it('requires org/repo/path/from', async () => {
    const { c } = restoreCtx()
    await expect(repoRestore(c, { repo: 'web', path: 'a.txt', from: 'main' })).rejects.toThrow(/org/)
    await expect(repoRestore(c, { org: 'a', repo: 'w', path: 'a.txt' })).rejects.toThrow(/from/)
  })
})
