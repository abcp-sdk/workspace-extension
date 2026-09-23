import { describe, expect, it } from 'vitest'
import { Forgejo } from '../src/forgejo.js'
import { repoImport } from '../src/tools/repo-admin.js'
import type { RepoCtx } from '../src/tools/repo-content.js'

/**
 * `repo-import` now delegates the whole import to the workspace gateway
 * (`importRepo` owns clone+push+default-branch+session). These tests only pin
 * the tool's argument handling + the request it forwards.
 */

interface ImportCall {
  org: string
  url: string
  repo: string
  ref: string
  authUser: string
  authToken: string
  private: boolean
  mirror: boolean
  description: string
}

function ctx(result: { org?: string; repo?: string; defaultBranch?: string } = {}) {
  const imported: ImportCall[] = []
  const c = {
    forgejo: new Forgejo({ gateway: {} as never }),
    gateway: {
      async importRepo(r: ImportCall) {
        imported.push(r)
        return {
          repo: {
            org: r.org,
            repo: r.repo,
            defaultBranch: result.defaultBranch ?? '',
            private: r.private,
          },
        }
      },
    },
    deps: {} as never,
    tenant: 't1',
    session: 'acme:web:main',
    locale: 'en',
  } as unknown as RepoCtx
  return { c, imported }
}

describe('repo-import', () => {
  it('derives the repo name from the URL and forwards to the gateway', async () => {
    const { c, imported } = ctx()
    const res = await repoImport(c, { org: 'acme', url: 'https://github.com/foo/bar.git' })
    expect(imported).toEqual([
      {
        org: 'acme',
        url: 'https://github.com/foo/bar.git',
        repo: 'bar',
        ref: '',
        authUser: '',
        authToken: '',
        private: false,
        mirror: false,
        description: '',
      },
    ])
    expect(res.data).toMatchObject({ org: 'acme', repo: 'bar', default_branch: 'main' })
  })

  it('forwards an explicit repo and a source ref (always public)', async () => {
    const { c, imported } = ctx({ defaultBranch: 'main' })
    const res = await repoImport(c, {
      org: 'acme',
      url: 'https://x/y/z.git',
      repo: 'z',
      ref: 'dev',
    })
    expect(imported[0]).toMatchObject({ repo: 'z', ref: 'dev', private: false, mirror: false })
    expect(res.data).toMatchObject({ repo: 'z', default_branch: 'main' })
  })

  it('ignores a private=true arg (imports are always public)', async () => {
    const { c, imported } = ctx()
    await repoImport(c, { org: 'acme', url: 'https://x/y/z.git', private: true })
    expect(imported[0]).toMatchObject({ private: false })
  })

  it('forwards private-source credentials and the description', async () => {
    const { c, imported } = ctx()
    await repoImport(c, {
      org: 'acme',
      url: 'https://x/y/priv.git',
      'auth-user': 'me',
      'auth-token': 'secret',
      description: 'imported',
    })
    expect(imported[0]).toMatchObject({ authUser: 'me', authToken: 'secret', description: 'imported' })
  })

  it('requires org and url', async () => {
    const { c, imported } = ctx()
    await expect(repoImport(c, { url: 'https://x/y/z.git' })).rejects.toThrow(/org/)
    await expect(repoImport(c, { org: 'acme' })).rejects.toThrow(/url/)
    expect(imported).toHaveLength(0)
  })

  it('rejects an illegal org/repo/ref name', async () => {
    const { c, imported } = ctx()
    await expect(repoImport(c, { org: 'bad:name', url: 'https://x/y/z.git' })).rejects.toThrow(/org/)
    await expect(repoImport(c, { org: 'acme', url: 'https://x/y/z.git', repo: 'a//b' })).rejects.toThrow(/repo/)
    await expect(repoImport(c, { org: 'acme', url: 'https://x/y/z.git', ref: 'a..b' })).rejects.toThrow(/ref/)
    expect(imported).toHaveLength(0)
  })
})
