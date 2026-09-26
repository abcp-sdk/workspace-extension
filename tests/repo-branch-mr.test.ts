import { describe, expect, it } from 'vitest'
import { repoBranchCreate, repoMrComment } from '../src/tools/repo-history.js'
import type { RepoCtx } from '../src/tools/repo-content.js'

interface Published {
  session: string
  type: string
  payload: unknown
  source: string
}

function branchCtx(session = 'acme:web:main') {
  const created: Array<{ org: string; repo: string; name: string; from: string }> = []
  const forked: Array<{ session: string; branch: string }> = []
  const published: Published[] = []
  const c = {
    forgejo: {
      async createBranch(org: string, repo: string, name: string, from: string) {
        created.push({ org, repo, name, from })
      },
      async listBranches() {
        return []
      },
      async resolveRef() {
        return 'main'
      },
    },
    gateway: {
      async forkBranchSession(req: { session: string; branch: string }) {
        forked.push(req)
        return {}
      },
      async ensureBranchSession() {
        return {}
      },
    },
    deps: {
      async publishMailbox(tenant: string, sessionName: string, type: string, payload: unknown, source: string) {
        void tenant
        published.push({ session: sessionName, type, payload, source })
      },
    },
    tenant: 't1',
    session,
    locale: 'en',
  } as unknown as RepoCtx
  return { c, created, forked, published }
}

describe('repo-branch-create fork seed', () => {
  it('always emits a fork-context event; no trigger without a task', async () => {
    const { c, forked, published } = branchCtx()
    await repoBranchCreate(c, { org: 'acme', repo: 'web', name: 'feature/x', from: 'main' })
    expect(forked).toEqual([{ session: 'acme:web:main', branch: 'feature/x' }])
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      session: 'acme:web:feature/x',
      type: 'event',
      source: 'system:repo-branch-fork',
    })
    expect(String((published[0]!.payload as Record<string, unknown>).content)).toContain('todo-write')
    expect(String((published[0]!.payload as Record<string, unknown>).content)).toContain('acme/web')
  })

  it('dispatches the task as a trigger AFTER the event', async () => {
    const { c, published } = branchCtx()
    await repoBranchCreate(c, { org: 'acme', repo: 'web', name: 'feature/x', from: 'main', task: 'add tests' })
    expect(published.map(p => p.type)).toEqual(['event', 'trigger'])
    expect(published[1]).toMatchObject({ session: 'acme:web:feature/x', source: 'session:acme:web:main' })
    expect(String((published[1]!.payload as Record<string, unknown>).text)).toContain('add tests')
    expect(String((published[1]!.payload as Record<string, unknown>).text)).toContain('todo-write')
  })

  it('refuses to create a branch in ANOTHER repository', async () => {
    const { c, created, forked, published } = branchCtx('acme:web:main')
    await expect(
      repoBranchCreate(c, { org: 'other', repo: 'lib', name: 'feature/x' }),
    ).rejects.toThrow(/own repository/)
    expect(created).toEqual([])
    expect(forked).toEqual([])
    expect(published).toEqual([])
  })

  it('defaults org/repo to the session and succeeds without them', async () => {
    const { c, created, forked } = branchCtx('acme:web:main')
    await repoBranchCreate(c, { name: 'feature/y' })
    expect(created).toEqual([{ org: 'acme', repo: 'web', name: 'feature/y', from: 'main' }])
    expect(forked).toEqual([{ session: 'acme:web:main', branch: 'feature/y' }])
  })
})

function commentCtx(mr: { head: string; base: string }, session: string) {
  const published: Published[] = []
  const ensured: Array<{ org: string; repo: string; branch: string }> = []
  const c = {
    forgejo: {
      async createComment() {},
    },
    gateway: {
      async getMR() {
        return { mr }
      },
      async ensureBranchSession(req: { org: string; repo: string; branch: string }) {
        ensured.push(req)
        return {}
      },
    },
    deps: {
      async publishMailbox(tenant: string, sessionName: string, type: string, payload: unknown, source: string) {
        void tenant
        published.push({ session: sessionName, type, payload, source })
      },
    },
    tenant: 't1',
    session,
    locale: 'en',
  } as unknown as RepoCtx
  return { c, published, ensured }
}

describe('repo-mr-comment notify', () => {
  it('notifies the reviewer (base) when the head session comments', async () => {
    const { c, published } = commentCtx({ head: 'feature/x', base: 'main' }, 'acme:web:feature/x')
    await repoMrComment(c, { org: 'acme', repo: 'web', index: 7, body: 'please review' })
    expect(published).toEqual([
      expect.objectContaining({
        session: 'acme:web:main',
        type: 'trigger',
        source: 'system:repo-mr-comment',
      }),
    ])
  })

  it('notifies the head session when the reviewer comments', async () => {
    const { c, published } = commentCtx({ head: 'feature/x', base: 'main' }, 'acme:web:main')
    await repoMrComment(c, { org: 'acme', repo: 'web', index: 7, body: 'needs work' })
    expect(published[0]).toMatchObject({ session: 'acme:web:feature/x', source: 'system:repo-mr-comment' })
  })

  it('a third-party comment notifies the reviewer', async () => {
    const { c, published } = commentCtx({ head: 'feature/x', base: 'main' }, 'acme:web:other')
    await repoMrComment(c, { org: 'acme', repo: 'web', index: 7, body: 'fyi' })
    expect(published[0]).toMatchObject({ session: 'acme:web:main' })
  })
})
