import { describe, expect, it } from 'vitest'
import { repoMrCreate } from '../src/tools/repo-history.js'
import type { RepoCtx } from '../src/tools/repo-content.js'

interface Notify {
  tenant: string
  session: string
  kind: string
  source: string
}

function ctx(session: string, opts: { failNotify?: boolean } = {}) {
  const ensured: Array<{ org: string; repo: string; branch: string }> = []
  const notified: Notify[] = []
  const c = {
    forgejo: {} as never,
    gateway: {
      async createMR() {
        return { index: 7, url: 'http://forge/acme/web/pulls/7' }
      },
      async ensureBranchSession(r: { org: string; repo: string; branch: string }) {
        ensured.push(r)
      },
    },
    deps: {
      async publishMailbox(tenant: string, s: string, kind: string, _payload: unknown, source: string) {
        if (opts.failNotify) throw new Error('nats down')
        notified.push({ tenant, session: s, kind, source })
      },
    },
    tenant: 't1',
    session,
    locale: 'en',
  } as unknown as RepoCtx
  return { c, ensured, notified }
}

describe('repo-mr-create notification', () => {
  it('wakes the base branch session after opening the MR', async () => {
    const { c, ensured, notified } = ctx('acme:web:feature/x')
    const res = await repoMrCreate(c, { org: 'acme', repo: 'web', title: 'Add x', head: 'feature/x', base: 'main' })
    expect(res.data).toMatchObject({ index: 7 })
    expect(ensured).toEqual([{ org: 'acme', repo: 'web', branch: 'main' }])
    expect(notified).toEqual([
      { tenant: 't1', session: 'acme:web:main', kind: 'trigger', source: 'system:repo-mr' },
    ])
  })

  it('does not notify when the base is the caller', async () => {
    const { c, ensured, notified } = ctx('acme:web:main')
    await repoMrCreate(c, { org: 'acme', repo: 'web', title: 'Add x', head: 'feature/x', base: 'main' })
    expect(ensured).toEqual([])
    expect(notified).toEqual([])
  })

  it('keeps the MR result when notification delivery fails', async () => {
    const { c, notified } = ctx('acme:web:feature/x', { failNotify: true })
    const res = await repoMrCreate(c, { org: 'acme', repo: 'web', title: 'Add x', head: 'feature/x', base: 'main' })
    expect(res.data).toMatchObject({ index: 7 })
    expect(notified).toEqual([])
  })
})
