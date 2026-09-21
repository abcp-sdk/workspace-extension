import { describe, expect, it } from 'vitest'
import { Forgejo } from '../src/forgejo.js'
import { repoImport } from '../src/tools/repo-admin.js'
import type { RepoCtx } from '../src/tools/repo-content.js'

/** A fake Forgejo: no repo exists initially; records migrate/patch/delete. */
function fakeForgejo(branches: string[], opts: { exists?: boolean } = {}) {
  const calls: string[] = []
  const state = { branches: [...branches], defaultBranch: branches[0] ?? 'main', exists: opts.exists === true }
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.endsWith('/repos/migrate') && method === 'POST') {
      calls.push('migrate')
      state.exists = true
      return new Response(JSON.stringify({ name: 'ext', owner: 'acme', default_branch: state.defaultBranch, full_name: 'acme/ext', private: true }))
    }
    if (u.includes('/branches/') && method === 'DELETE') {
      const name = decodeURIComponent(u.split('/branches/')[1] ?? '')
      calls.push(`delete:${name}`)
      state.branches = state.branches.filter(b => b !== name)
      return new Response(null, { status: 204 })
    }
    if (/\/repos\/acme\/[^/]+$/.test(u) && method === 'PATCH') {
      const body = JSON.parse(String(init!.body)) as { default_branch: string }
      calls.push(`patch:${body.default_branch}`)
      state.defaultBranch = body.default_branch
      return new Response(JSON.stringify({ default_branch: body.default_branch }))
    }
    if (/\/repos\/acme\/[^/]+$/.test(u) && method === 'GET') {
      if (!state.exists) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
      return new Response(JSON.stringify({ name: 'ext', owner: 'acme', default_branch: state.defaultBranch }))
    }
    if (u.includes('/repos/acme/') && u.includes('/branches')) {
      return new Response(JSON.stringify(state.branches.map(name => ({ name, commit: { id: 'sha' } }))))
    }
    if (u.endsWith('/orgs') && method === 'POST') return new Response(JSON.stringify({ username: 'acme' }))
    if (u.includes('/repos/acme/') && u.includes('/branches/') && method === 'POST') return new Response('{}')
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { calls, state, forgejo: new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl }) }
}

function ctx(branches: string[], exists = false) {
  const { calls, forgejo } = fakeForgejo(branches, { exists })
  const ensured: Array<{ org: string; repo: string; branch: string }> = []
  const c = {
    forgejo,
    gateway: {
      async ensureBranchSession(r: { org: string; repo: string; branch: string }) {
        ensured.push(r)
        return { branchSession: {} }
      },
    },
    deps: {} as never,
    tenant: 't1',
    session: 'acme:web:main',
    locale: 'en',
  } as unknown as RepoCtx
  return { c, calls, ensured }
}

describe('repo-import', () => {
  it('derives the repo name from the URL and ensures the default-branch session', async () => {
    const { c, calls, ensured } = ctx(['main', 'dev'])
    await repoImport(c, { org: 'acme', url: 'https://github.com/foo/bar.git' })
    expect(calls).toContain('migrate')
    // no ref -> no trim
    expect(calls.some(x => x.startsWith('delete:'))).toBe(false)
    expect(ensured).toEqual([{ org: 'acme', repo: 'bar', branch: 'main' }])
  })

  it('trims to a single ref: sets default then deletes the other branches', async () => {
    const { c, calls, ensured } = ctx(['main', 'dev', 'release/1.0'])
    await repoImport(c, { org: 'acme', url: 'https://x/y/z.git', repo: 'z', ref: 'dev' })
    expect(calls).toContain('patch:dev')
    expect(calls).toContain('delete:main')
    expect(calls).toContain('delete:release/1.0')
    expect(calls).not.toContain('delete:dev')
    expect(ensured).toEqual([{ org: 'acme', repo: 'z', branch: 'dev' }])
  })

  it('refuses to overwrite an existing repo', async () => {
    const { c, calls } = ctx(['main'], true)
    await expect(repoImport(c, { org: 'acme', url: 'https://x/y/ext.git' })).rejects.toThrow(/already exists/)
    expect(calls).not.toContain('migrate')
  })

  it('errors when the requested ref is absent from the source', async () => {
    const { c } = ctx(['main', 'dev'])
    await expect(
      repoImport(c, { org: 'acme', url: 'https://x/y/z.git', repo: 'z', ref: 'nope' }),
    ).rejects.toThrow(/not found/)
  })
})
