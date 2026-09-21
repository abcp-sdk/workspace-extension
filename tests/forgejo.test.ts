import { describe, expect, it } from 'vitest'
import { Forgejo } from '../src/forgejo.js'

/** A fake fetch recording calls and returning scripted responses. */
function fakeFetch(script: Array<{ match: string; status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: u, method: init?.method ?? 'GET', headers, ...(init?.body !== undefined ? { body: String(init.body) } : {}) })
    const hit = script.find(s => u.includes(s.match))
    if (hit === undefined) {
      return new Response('not found', { status: 404 })
    }
    const status = hit.status ?? 200
    if (hit.text !== undefined) return new Response(hit.text, { status })
    return new Response(hit.body !== undefined ? JSON.stringify(hit.body) : '', { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('Forgejo client', () => {
  it('sends a PAT Authorization header', async () => {
    const { impl, calls } = fakeFetch([{ match: '/api/v1/orgs', body: [] }])
    const fj = new Forgejo({ url: 'http://f.test/', auth: { token: 'abc' }, fetchImpl: impl })
    await fj.listOrgs()
    expect(calls[0]!.headers['Authorization']).toBe('token abc')
    expect(calls[0]!.url).toBe('http://f.test/api/v1/orgs?page=1&limit=50')
  })

  it('falls back to HTTP Basic auth', async () => {
    const { impl, calls } = fakeFetch([{ match: '/api/v1/orgs', body: [] }])
    const fj = new Forgejo({ url: 'http://f.test', auth: { user: 'root', password: 'pw' }, fetchImpl: impl })
    await fj.listOrgs()
    expect(calls[0]!.headers['Authorization']).toBe(`Basic ${Buffer.from('root:pw').toString('base64')}`)
  })

  it('maps 401 to permission_denied, 404 to not_found, 409 to retryable', async () => {
    const mk = (status: number) =>
      new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: fakeFetch([{ match: '/api/v1/orgs', status }]).impl })
    await expect(mk(401).listOrgs()).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(mk(404).listOrgs()).rejects.toMatchObject({ code: 'not_found' })
    await expect(mk(409).listOrgs()).rejects.toMatchObject({ code: 'retryable' })
  })

  it('decodes base64 file content and returns the blob sha', async () => {
    const { impl } = fakeFetch([
      {
        match: '/contents/a.txt',
        body: { type: 'file', encoding: 'base64', content: Buffer.from('hello\n').toString('base64'), sha: 'deadbeef', size: 6 },
      },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const got = await fj.getContents('o', 'r', 'a.txt', 'main')
    expect(got).toMatchObject({ kind: 'file', text: 'hello\n', sha: 'deadbeef', size: 6 })
  })

  it('lists a directory', async () => {
    const { impl } = fakeFetch([
      {
        match: '/contents/dir',
        body: [
          { type: 'file', path: 'dir/a.txt', name: 'a.txt', size: 3, sha: 's1' },
          { type: 'dir', path: 'dir/sub', name: 'sub', size: 0, sha: 's2' },
        ],
      },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const got = await fj.getContents('o', 'r', 'dir', 'main')
    expect(got.kind).toBe('dir')
    if (got.kind === 'dir') expect(got.entries.map(e => e.type)).toEqual(['file', 'dir'])
  })

  it('PUTs a file via ChangeFiles with base64 content and branch/sha', async () => {
    const { impl, calls } = fakeFetch([
      { match: '/contents', body: { files: [{ last_commit_sha: 'c0ffee' }] } },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const res = await fj.putFile('o', 'r', 'a.txt', 'hi', 'msg', { ref: 'main', sha: 'base' })
    expect(res.sha).toBe('c0ffee')
    expect(calls[0]!.method).toBe('POST')
    const body = JSON.parse(calls[0]!.body!)
    expect(body).toMatchObject({ message: 'msg', branch: 'main' })
    expect(body.files[0]).toMatchObject({ operation: 'update', path: 'a.txt', sha: 'base' })
    expect(Buffer.from(body.files[0].content, 'base64').toString()).toBe('hi')
  })

  it('creates a new file without a sha', async () => {
    const { impl, calls } = fakeFetch([
      { match: '/contents', body: { files: [{ last_commit_sha: 'new1' }] } },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    await fj.putFile('o', 'r', 'new.txt', 'hi', 'msg', { ref: 'main' })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.files[0]).toMatchObject({ operation: 'create', path: 'new.txt' })
    expect(body.files[0].sha).toBeUndefined()
  })

  it('deletes a file via ChangeFiles', async () => {
    const { impl, calls } = fakeFetch([
      { match: '/contents', body: { files: [{ last_commit_sha: 'del1' }] } },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    await fj.deleteFile('o', 'r', 'gone.txt', 'bye', { ref: 'main', sha: 'base' })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.files[0]).toEqual({ operation: 'delete', path: 'gone.txt', sha: 'base' })
  })

  it('commits multiple files atomically with operations', async () => {
    const { impl, calls } = fakeFetch([
      { match: '/contents', body: { files: [{ last_commit_sha: 'abc123' }] } },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    await fj.commitFiles('o', 'r', [
      { path: 'a.txt', operation: 'create', content: 'A' },
      { path: 'b.txt', operation: 'delete' },
    ], 'multi', { ref: 'main', newBranch: 'feat' })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.new_branch).toBe('feat')
    expect(body.files[0]).toMatchObject({ operation: 'create', path: 'a.txt' })
    expect(body.files[0].content).toBe(Buffer.from('A').toString('base64'))
    expect(body.files[1]).toEqual({ operation: 'delete', path: 'b.txt' })
  })

  it('resolves refs and maps the tree', async () => {
    const { impl } = fakeFetch([
      { match: '/git/trees/', body: { sha: 't1', truncated: false, tree: [{ path: 'a.txt', type: 'blob', size: 3, sha: 's1' }] } },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const tree = await fj.getTree('o', 'r', 'main')
    expect(tree.entries[0]).toMatchObject({ path: 'a.txt', type: 'file', size: 3 })
  })

  it('maps commit history', async () => {
    const { impl } = fakeFetch([
      {
        match: '/commits',
        body: [{ sha: 'c1', commit: { message: 'hi\n', author: { name: 'A', date: '2026-01-01' } }, parents: [] }],
      },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const commits = await fj.listCommits('o', 'r', { ref: 'main', limit: 5 })
    expect(commits[0]).toMatchObject({ sha: 'c1', message: 'hi', author: 'A' })
  })

  it('creates an org with a POST /orgs body', async () => {
    const { impl, calls } = fakeFetch([{ match: '/api/v1/orgs', body: { username: 'acme' } }])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const res = await fj.createOrg({ org: 'acme', fullName: 'Acme', visibility: 'private' })
    expect(res.name).toBe('acme')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('http://f.test/api/v1/orgs')
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ username: 'acme', full_name: 'Acme', visibility: 'private' })
  })

  it('creates a repo in an org when the org exists', async () => {
    const { impl, calls } = fakeFetch([
      { match: '/orgs/acme/repos', body: { full_name: 'acme/app', name: 'app', owner: { login: 'acme' }, default_branch: 'main', private: true } },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const res = await fj.createRepo('acme', { repo: 'app', private: true, autoInit: true, defaultBranch: 'main' })
    expect(res).toMatchObject({ fullName: 'acme/app', defaultBranch: 'main', private: true })
    expect(calls[0]!.url).toBe('http://f.test/api/v1/orgs/acme/repos')
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ name: 'app', private: true, auto_init: true, default_branch: 'main' })
  })

  it('falls back to POST /user/repos when the owner is not an org', async () => {
    const { impl, calls } = fakeFetch([
      { match: '/orgs/root/repos', status: 404 },
      { match: '/user/repos', body: { full_name: 'root/app', name: 'app', owner: { login: 'root' }, default_branch: 'main' } },
    ])
    const fj = new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl: impl })
    const res = await fj.createRepo('root', { repo: 'app' })
    expect(res.fullName).toBe('root/app')
    expect(calls.map(c => c.url)).toEqual([
      'http://f.test/api/v1/orgs/root/repos',
      'http://f.test/api/v1/user/repos',
    ])
  })
})
