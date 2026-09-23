import { describe, expect, it } from 'vitest'
import { branchRefOf, checkoutIntoSandbox, fanoutRef, recordBaseline, resolveTip } from '../src/tools/fanout.js'
import type { WorkerClient } from '../src/client.js'
import type { WorkspaceDeps } from '../src/deps.js'

/** A forgejo stub with in-memory refs + raw files. */
function fakeForgejo(files: Record<string, Uint8Array> = {}, branches: Record<string, string> = {}) {
  const compareCalls: Array<{ base: string; head: string }> = []
  return {
    compareCalls,
    forgejo: {
      listBranches: async () => Object.entries(branches).map(([name, sha]) => ({ name, sha })),
      archiveTarGz: async () => new Uint8Array([1, 2, 3]),
      getRaw: async (_o: string, _r: string, path: string) => files[path] ?? new Uint8Array(),
      compare: async (_o: string, _r: string, base: string, head: string) => {
        compareCalls.push({ base, head })
        return { files: [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 1, patch: '' }] }
      },
    },
  }
}

function fakeWorker() {
  const writes: Array<{ path: string; content: Uint8Array }> = []
  const execs: string[] = []
  const syncs: Array<Record<string, unknown>> = []
  return {
    writes,
    execs,
    syncs,
    client: {
      fileWrite: async (req: { path: string; content: Uint8Array }) => {
        writes.push(req)
        return { ok: true }
      },
      execute: async (req: { command: string }) => {
        execs.push(req.command)
        return {}
      },
      syncFolder: async (req: Record<string, unknown>) => {
        syncs.push(req)
        return { files: 3, root: '/root/workspace' }
      },
    } as unknown as WorkerClient,
  }
}

/** An in-memory sync-state store. */
function fakeDeps(initial: Record<string, { rev: string; session: string; updatedAt: number }> = {}) {
  const store: Record<string, { rev: string; session: string; updatedAt: number }> = { ...initial }
  return {
    store,
    deps: {
      loadSyncState: async (_t: string, sb: string) => store[sb] ?? null,
      saveSyncState: async (_t: string, sb: string, s: { rev: string; session: string; updatedAt: number }) => {
        store[sb] = s
      },
    } as unknown as WorkspaceDeps,
  }
}

/** A gateway stub that lists session sandboxes. */
function fakeGateway(names: string[]) {
  return {
    listSandboxes: async () => ({ sandboxes: names.map(n => ({ name: n, session: 'o:r:feat' })) }),
  }
}

describe('branchRefOf', () => {
  it('parses a branch session and rejects a free session', () => {
    expect(branchRefOf('acme:web:feat')).toEqual({ org: 'acme', repo: 'web', branch: 'feat' })
    expect(branchRefOf('freesession')).toBeNull()
  })
})

describe('resolveTip / checkoutIntoSandbox', () => {
  it('resolves a branch sha and checks out via the worker', async () => {
    const { forgejo } = fakeForgejo({}, { feat: 'abc123' })
    expect(await resolveTip(forgejo as never, 'o', 'r', 'feat', 'en')).toBe('abc123')
    const w = fakeWorker()
    const res = await checkoutIntoSandbox(forgejo as never, w.client, 'o', 'r', 'feat')
    expect(res).toEqual({ ref: 'feat', files: 3 })
    expect(w.syncs[0]).toMatchObject({ dest: '.', clean: true, rev: 'feat' })
  })
})

describe('fanoutRef', () => {
  it('diffs baseline -> head and writes changed files into each session sandbox', async () => {
    const { forgejo, compareCalls } = fakeForgejo({ 'a.txt': new Uint8Array([104, 105]) })
    const w = fakeWorker()
    const { deps, store } = fakeDeps({ w1: { rev: 'old', session: 'o:r:feat', updatedAt: 0 } })
    const n = await fanoutRef(
      {
        gateway: fakeGateway(['w1']) as never,
        forgejo: forgejo as never,
        resolveWorker: async () => w.client,
        deps,
        tenant: 't',
        session: 'o:r:feat',
        locale: 'en',
      },
      'o', 'r', 'feat', 'new',
    )
    expect(n).toBe(1)
    expect(compareCalls).toEqual([{ base: 'old', head: 'new' }])
    expect(w.writes.map(x => x.path)).toEqual(['a.txt'])
    expect(store['w1']!.rev).toBe('new')
  })

  it('skips a sandbox with no baseline (nothing checked out)', async () => {
    const { forgejo } = fakeForgejo()
    const w = fakeWorker()
    const { deps } = fakeDeps()
    const n = await fanoutRef(
      { gateway: fakeGateway(['w1']) as never, forgejo: forgejo as never, resolveWorker: async () => w.client, deps, tenant: 't', session: 'o:r:feat', locale: 'en' },
      'o', 'r', 'feat', 'new',
    )
    expect(n).toBe(0)
    expect(w.writes).toHaveLength(0)
  })

  it('skips when already up to date (baseline == head)', async () => {
    const { forgejo, compareCalls } = fakeForgejo()
    const { deps } = fakeDeps({ w1: { rev: 'new', session: 'o:r:feat', updatedAt: 0 } })
    const n = await fanoutRef(
      { gateway: fakeGateway(['w1']) as never, forgejo: forgejo as never, resolveWorker: async () => fakeWorker().client, deps, tenant: 't', session: 'o:r:feat', locale: 'en' },
      'o', 'r', 'feat', 'new',
    )
    expect(n).toBe(0)
    expect(compareCalls).toHaveLength(0)
  })

  it('deletes a removed path through the shell', async () => {
    const w = fakeWorker()
    const forgejo = {
      listBranches: async () => [],
      getRaw: async () => new Uint8Array(),
      compare: async () => ({ files: [{ path: 'gone.txt', status: 'removed', additions: 0, deletions: 1, patch: '' }] }),
    }
    const { deps } = fakeDeps({ w1: { rev: 'old', session: 'o:r:feat', updatedAt: 0 } })
    await fanoutRef(
      { gateway: fakeGateway(['w1']) as never, forgejo: forgejo as never, resolveWorker: async () => w.client, deps, tenant: 't', session: 'o:r:feat', locale: 'en' },
      'o', 'r', 'feat', 'new',
    )
    expect(w.execs[0]).toContain("rm -f -- 'gone.txt'")
    expect(w.writes).toHaveLength(0)
  })
})

describe('recordBaseline', () => {
  it('stores the current branch tip', async () => {
    const { forgejo } = fakeForgejo({}, { feat: 'tip1' })
    const { deps, store } = fakeDeps()
    await recordBaseline({ forgejo: forgejo as never, deps, tenant: 't', session: 'o:r:feat', locale: 'en' }, 'w1', 'o', 'r', 'feat')
    expect(store['w1']).toMatchObject({ rev: 'tip1', session: 'o:r:feat' })
  })
})
