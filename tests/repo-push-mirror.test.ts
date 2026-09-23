import { describe, expect, it } from 'vitest'
import { Forgejo } from '../src/forgejo.js'
import {
  repoDeletePushMirror,
  repoListPushMirrors,
  repoRemove,
  repoSetPushMirror,
} from '../src/tools/repo-admin.js'
import type { RepoCtx } from '../src/tools/repo-content.js'

/**
 * The push-mirror tools only validate arguments and forward to the gateway
 * (which owns the tenant-scoped Forgejo call). These tests pin the forwarded
 * request shape and the returned data.
 */

interface SetCall {
  org: string
  repo: string
  remoteAddress: string
  remoteUsername: string
  remotePassword: string
  syncOnCommit: boolean
  interval: string
  branchFilter: string
}

function ctx() {
  const sets: SetCall[] = []
  const deletes: { org: string; repo: string; remoteName: string }[] = []
  const reposRemoved: { org: string; repo: string }[] = []
  let listed = 0
  const c = {
    forgejo: new Forgejo({ gateway: {} as never }),
    gateway: {
      async deleteRepo(r: { org: string; repo: string }) {
        reposRemoved.push(r)
        return { ok: true }
      },
      async setPushMirror(r: SetCall) {
        sets.push(r)
        return {
          mirror: {
            remoteName: 'remote_mirror_abc',
            remoteAddress: r.remoteAddress,
            interval: r.interval,
            syncOnCommit: r.syncOnCommit,
            branchFilter: r.branchFilter,
            lastError: '',
            lastUpdate: '',
          },
        }
      },
      async listPushMirrors() {
        listed++
        return {
          mirrors: [
            {
              remoteName: 'remote_mirror_abc',
              remoteAddress: 'https://example.com/x.git',
              interval: '8h',
              syncOnCommit: true,
              branchFilter: 'main',
              lastError: '',
              lastUpdate: '2026-01-01T00:00:00Z',
            },
          ],
        }
      },
      async deletePushMirror(r: { org: string; repo: string; remoteName: string }) {
        deletes.push(r)
        return { ok: true }
      },
    },
    deps: {} as never,
    tenant: 't1',
    session: 'acme:web:main',
    locale: 'en',
  } as unknown as RepoCtx
  return { c, sets, deletes, reposRemoved, listed: () => listed }
}

describe('repo-remove', () => {
  it('forwards org/repo to deleteRepo', async () => {
    const { c, reposRemoved } = ctx()
    const res = await repoRemove(c, { org: 'acme', repo: 'web' })
    expect(reposRemoved).toEqual([{ org: 'acme', repo: 'web' }])
    expect(res.data).toMatchObject({ org: 'acme', repo: 'web', removed: true })
  })

  it('rejects an illegal org/repo name', async () => {
    const { c, reposRemoved } = ctx()
    await expect(repoRemove(c, { org: 'a//b', repo: 'web' })).rejects.toThrow(/org/)
    expect(reposRemoved).toHaveLength(0)
  })
})

describe('repo-set-push-mirror', () => {
  it('forwards org/repo/remote-url and options', async () => {
    const { c, sets } = ctx()
    const res = await repoSetPushMirror(c, {
      org: 'acme',
      repo: 'web',
      'remote-url': 'https://example.com/x.git',
      'auth-user': 'me',
      'auth-token': 'secret',
      'sync-on-commit': true,
      interval: '8h',
      'branch-filter': 'main',
    })
    expect(sets).toEqual([
      {
        org: 'acme',
        repo: 'web',
        remoteAddress: 'https://example.com/x.git',
        remoteUsername: 'me',
        remotePassword: 'secret',
        syncOnCommit: true,
        interval: '8h',
        branchFilter: 'main',
      },
    ])
    expect(res.data).toMatchObject({
      org: 'acme',
      repo: 'web',
      remote_name: 'remote_mirror_abc',
      remote_address: 'https://example.com/x.git',
    })
  })

  it('defaults sync-on-commit to false and requires remote-url', async () => {
    const { c, sets } = ctx()
    await repoSetPushMirror(c, { org: 'acme', repo: 'web', 'remote-url': 'https://e/x.git' })
    expect(sets[0]).toMatchObject({ syncOnCommit: false, remoteUsername: '', interval: '' })
    await expect(repoSetPushMirror(c, { org: 'acme', repo: 'web' })).rejects.toThrow(/remote-url/)
  })

  it('rejects an illegal org/repo name', async () => {
    const { c, sets } = ctx()
    await expect(repoSetPushMirror(c, { org: 'bad:name', repo: 'web', 'remote-url': 'https://e/x.git' })).rejects.toThrow(/org/)
    expect(sets).toHaveLength(0)
  })
})

describe('repo-list-push-mirrors', () => {
  it('lists mirrors and includes last_error in the text', async () => {
    const { c, listed } = ctx()
    const res = await repoListPushMirrors(c, { org: 'acme', repo: 'web' })
    expect(listed()).toBe(1)
    expect(res.content).toContain('remote_mirror_abc')
    expect(res.data.mirrors).toHaveLength(1)
  })
})

describe('repo-delete-push-mirror', () => {
  it('forwards remote-name and requires it', async () => {
    const { c, deletes } = ctx()
    await repoDeletePushMirror(c, { org: 'acme', repo: 'web', 'remote-name': 'remote_mirror_abc' })
    expect(deletes).toEqual([{ org: 'acme', repo: 'web', remoteName: 'remote_mirror_abc' }])
    await expect(repoDeletePushMirror(c, { org: 'acme', repo: 'web' })).rejects.toThrow(/remote-name/)
  })
})
