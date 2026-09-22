import { describe, expect, it } from 'vitest'
import { Forgejo } from '../src/forgejo.js'
import { repoMailSend, type MailCtx } from '../src/tools/mail.js'

/** A gateway-backed Forgejo whose branch list is fixed. */
function fakeForgejo(branches: string[]) {
  const gateway = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        async (req: Record<string, unknown>) => {
          if (prop === 'branches') return { branches: branches.map(name => ({ name, sha: 'sha' })) }
          if (prop === 'repoMeta') return { org: req['org'], repo: req['repo'], defaultBranch: 'main', private: true, empty: false }
          return {}
        },
    },
  )
  return new Forgejo({ gateway: gateway as never })
}

/** A fake gateway recording ensure calls; returns a fixed session. */
function fakeGateway() {
  const ensured: Array<{ org: string; repo: string; branch: string }> = []
  const gateway = {
    async ensureBranchSession(req: { org: string; repo: string; branch: string }) {
      ensured.push(req)
      return { branchSession: { session: `${req.org}:${req.repo}:${req.branch}` } }
    },
  }
  return { ensured, gateway: gateway as unknown as MailCtx['gateway'] }
}

function ctx(branches: string[]) {
  const { ensured, gateway } = fakeGateway()
  const published: Array<{ session: string; type: string; payload: unknown; source: string }> = []
  const c: MailCtx = {
    forgejo: fakeForgejo(branches),
    gateway,
    tenant: 't1',
    session: 'acme:web:main',
    locale: 'en',
    publishMailbox: async (_tenant, sessionName, type, payload, source = '') => {
      published.push({ session: sessionName, type, payload, source })
    },
  }
  return { c, ensured, published }
}

describe('repo-mail-send', () => {
  it('errors when the branch does not exist in the repo', async () => {
    const { c, ensured, published } = ctx(['main'])
    await expect(repoMailSend(c, { org: 'acme', repo: 'web', branch: 'nope', text: 'hi' })).rejects.toThrow(
      /does not exist/,
    )
    expect(ensured).toEqual([])
    expect(published).toEqual([])
  })

  it('ensures the branch session then delivers to it (explicit branch)', async () => {
    const { c, ensured, published } = ctx(['main', 'feature/x'])
    const res = await repoMailSend(c, { org: 'acme', repo: 'web', branch: 'feature/x', text: 'do it' })
    expect(ensured).toEqual([{ org: 'acme', repo: 'web', branch: 'feature/x' }])
    expect(published).toEqual([
      { session: 'acme:web:feature/x', type: 'trigger', payload: { text: 'do it' }, source: 'session:acme:web:main' },
    ])
    expect(res.data).toMatchObject({ session: 'acme:web:feature/x' })
  })

  it('defaults the branch to main', async () => {
    const { c, ensured, published } = ctx(['main'])
    await repoMailSend(c, { org: 'acme', repo: 'web', text: 'hello' })
    expect(ensured).toEqual([{ org: 'acme', repo: 'web', branch: 'main' }])
    expect(published[0]?.session).toBe('acme:web:main')
  })
})
