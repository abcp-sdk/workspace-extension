import { describe, expect, it } from 'vitest'
import { Forgejo } from '../src/forgejo.js'
import type { GatewayClient } from '../src/client.js'

/**
 * The repo client is now a thin adapter over the workspace GATEWAY. These tests
 * assert the ADAPTER mapping (gateway response -> tool-facing shape) plus error
 * translation, with a fake gateway that records calls.
 */
function fakeGateway(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; req: unknown }> = []
  const res: Record<string, unknown> = {
    createOrg: { org: 'acme' },
    listOrgs: { orgs: ['acme', 'other'] },
    listRepos: { repos: [
      { org: 'acme', repo: 'app', defaultBranch: 'main', private: true },
      { org: 'other', repo: 'x', defaultBranch: 'main', private: true },
    ] },
    repoMeta: { org: 'acme', repo: 'app', defaultBranch: 'main', private: true, empty: false },
    branches: { branches: [{ name: 'main', sha: 's1' }] },
    tags: { tags: [{ name: 'v1', sha: 't1' }] },
    contents: { isDir: false, text: 'hello\n', sha: 'deadbeef', size: 6n, entries: [] },
    readRaw: { data: new Uint8Array([1, 2, 3]) },
    commitFiles: { sha: 'c0ffee' },
    log: { commits: [{ sha: 'c1', message: 'hi', author: 'A', date: '2026-01-01' }] },
    getCommit: { commit: { sha: 'c1', message: 'm', author: 'A', date: 'd', parents: ['p'] } },
    commitDiff: { diff: 'DIFF' },
    compare: { files: [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 1, patch: 'P' }] },
    listMRs: { mrs: [{ index: 2, title: 't', state: 'open', head: 'f', base: 'main', mergeable: false, merged: false }] },
    archive: { data: new Uint8Array([9, 9]) },
    ...overrides,
  }
  const gateway = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        async (req: unknown) => {
          calls.push({ method: prop, req })
          const r = res[prop] as { code?: string } | undefined
          if (r !== undefined && (r instanceof Error || typeof r.code === 'string')) throw r
          return r ?? {}
        },
    },
  ) as unknown as GatewayClient
  return { gateway, calls }
}

describe('Forgejo (gateway-backed)', () => {
  it('lists orgs from the gateway', async () => {
    const { gateway, calls } = fakeGateway()
    const fj = new Forgejo({ gateway })
    expect(await fj.listOrgs()).toEqual([{ name: 'acme', description: '' }, { name: 'other', description: '' }])
    expect(calls[0]!.method).toBe('listOrgs')
  })

  it('scopes listOrgRepos to the requested org (gateway returns all)', async () => {
    const { gateway } = fakeGateway()
    const fj = new Forgejo({ gateway })
    const repos = await fj.listOrgRepos('acme')
    expect(repos.map(r => r.fullName)).toEqual(['acme/app'])
  })

  it('maps a file read (text + sha + size)', async () => {
    const { gateway, calls } = fakeGateway()
    const fj = new Forgejo({ gateway })
    const got = await fj.getContents('o', 'r', 'a.txt', 'main')
    expect(got).toMatchObject({ kind: 'file', text: 'hello\n', sha: 'deadbeef', size: 6 })
    expect(calls[0]).toEqual({ method: 'contents', req: { org: 'o', repo: 'r', ref: 'main', path: 'a.txt' } })
  })

  it('maps a directory listing', async () => {
    const { gateway } = fakeGateway({ contents: { isDir: true, entries: [
      { path: 'dir/a', name: 'a', type: 'file', size: 3n, sha: 's1' },
      { path: 'dir/sub', name: 'sub', type: 'dir', size: 0n, sha: 's2' },
    ] } })
    const fj = new Forgejo({ gateway })
    const got = await fj.getContents('o', 'r', 'dir', 'main')
    expect(got.kind).toBe('dir')
    if (got.kind === 'dir') expect(got.entries.map(e => e.type)).toEqual(['file', 'dir'])
  })

  it('sends putFile through commitFiles with base64 content + sha', async () => {
    const { gateway, calls } = fakeGateway()
    const fj = new Forgejo({ gateway })
    const res = await fj.putFile('o', 'r', 'a.txt', 'hi', 'msg', { ref: 'main', sha: 'base' })
    expect(res.sha).toBe('c0ffee')
    const req = calls[0]!.req as { message: string; ref: string; files: Array<Record<string, unknown>> }
    expect(req.message).toBe('msg')
    expect(req.ref).toBe('main')
    expect(req.files[0]).toMatchObject({ operation: 'update', path: 'a.txt', sha: 'base' })
  })

  it('creates without a sha and deletes without content', async () => {
    const { gateway, calls } = fakeGateway()
    const fj = new Forgejo({ gateway })
    await fj.putFile('o', 'r', 'new.txt', 'hi', 'msg')
    expect((calls[0]!.req as { files: Array<Record<string, unknown>> }).files[0]).toMatchObject({ operation: 'create', path: 'new.txt' })
    await fj.deleteFile('o', 'r', 'gone.txt', 'bye')
    expect((calls[1]!.req as { files: Array<Record<string, unknown>> }).files[0]).toMatchObject({ operation: 'delete', path: 'gone.txt' })
  })

  it('maps commit history and single commit', async () => {
    const { gateway } = fakeGateway()
    const fj = new Forgejo({ gateway })
    expect((await fj.listCommits('o', 'r', { limit: 5 }))[0]).toMatchObject({ sha: 'c1', message: 'hi', author: 'A' })
    expect(await fj.getCommit('o', 'r', 'c1')).toMatchObject({ sha: 'c1', parents: ['p'] })
  })

  it('maps compare + MR list + archive', async () => {
    const { gateway } = fakeGateway()
    const fj = new Forgejo({ gateway })
    expect((await fj.compare('o', 'r', 'main', 'feat')).files[0]).toMatchObject({ path: 'a.txt', additions: 1 })
    expect((await fj.listPulls('o', 'r', 'open'))[0]).toMatchObject({ index: 2, mergeable: false })
    expect(Array.from(await fj.archiveTarGz('o', 'r', 'main'))).toEqual([9, 9])
  })

  it('translates gateway errors to typed tool errors', async () => {
    const mk = (code: string) => fakeGateway({ listOrgs: { code, message: 'boom' } })
    const notFound = new Forgejo({ gateway: mk('not_found').gateway })
    await expect(notFound.listOrgs()).rejects.toMatchObject({ code: 'not_found' })
    const denied = new Forgejo({ gateway: mk('permission_denied').gateway })
    await expect(denied.listOrgs()).rejects.toMatchObject({ code: 'permission_denied' })
    const conflict = new Forgejo({ gateway: mk('failed_precondition').gateway })
    await expect(conflict.listOrgs()).rejects.toMatchObject({ code: 'retryable' })
  })

  it('resolves a ref via repoMeta default branch', async () => {
    const { gateway, calls } = fakeGateway()
    const fj = new Forgejo({ gateway })
    expect(await fj.resolveRef('o', 'r', '')).toBe('main')
    expect(calls[0]!.method).toBe('repoMeta')
    expect(await fj.resolveRef('o', 'r', 'feat')).toBe('feat')
  })
})
