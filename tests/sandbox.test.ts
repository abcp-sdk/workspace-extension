import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import type { WorkerClient, WorkspaceClient } from '../src/client.js'
import {
  sandboxCreate,
  sandboxDelete,
  sandboxList,
  sandboxStatus,
  type SandboxCtx,
} from '../src/tools/sandbox.js'

/** A worker stub whose Info returns fixed values. */
function fakeWorker(over: Partial<Record<keyof WorkerClient, unknown>> = {}): WorkerClient {
  return {
    info: async () => ({ os: 'linux', arch: 'amd64', shell: 'builtin(mvdan-sh)', workspace: '/root/workspace', bootId: 'abc123' }),
    ...over,
  } as unknown as WorkerClient
}

/** A scripted workspace-gateway stub. */
function fakeManager(over: Partial<Record<keyof WorkspaceClient, unknown>> = {}): WorkspaceClient {
  const base = {
    createSandbox: async () => ({
      sandbox: { name: 'w1', image: 'img', phase: 'Running', ready: true, url: 'http://w1:48080', creator: 't/s', createdAt: 1n },
    }),
    listSandboxes: async () => ({ sandboxes: [] }),
    getSandbox: async () => ({
      sandbox: { name: 'w1', image: 'img', phase: 'Running', ready: true, url: 'http://w1:48080', creator: 't/s', createdAt: 1n },
    }),
    deleteSandbox: async () => ({ ok: true }),
  }
  return { ...base, ...over } as unknown as WorkspaceClient
}

const ctx = (manager: WorkspaceClient): SandboxCtx => ({ workspace: manager, locale: 'en' })

describe('sandbox-create', () => {
  it('creates and reports the worker (url is the bare domain)', async () => {
    const r = await sandboxCreate(ctx(fakeManager()), { name: 'w1', image: 'img' })
    expect(r.content).toContain('w1')
    expect(r.data).toMatchObject({ name: 'w1', url: 'w1', ready: true })
  })

  it('appends the worker info when a resolver is available', async () => {
    const c: SandboxCtx = {
      workspace: fakeManager(),
      locale: 'en',
      resolveWorker: async () => ({ client: fakeWorker(), url: 'http://wm-w1.worker.svc.cluster.local:48080' }),
    }
    const r = await sandboxCreate(c, { name: 'w1', image: 'img' })
    expect(r.content).toContain('wm-w1.worker.svc.cluster.local')
    expect(r.content).toContain('boot_id')
    expect(r.data).toMatchObject({ os: 'linux', arch: 'amd64', boot_id: 'abc123' })
  })

  it('still succeeds when the worker info call fails (best-effort)', async () => {
    const c: SandboxCtx = {
      workspace: fakeManager(),
      locale: 'en',
      resolveWorker: async () => {
        throw new Error('unreachable')
      },
    }
    const r = await sandboxCreate(c, { name: 'w1', image: 'img' })
    expect(r.data).toMatchObject({ name: 'w1', ready: true })
  })

  it('requires name (image is optional: empty = catalog default)', async () => {
    const e1 = await sandboxCreate(ctx(fakeManager()), { image: 'img' }).catch(e => e)
    expect((e1 as TypedToolError).code).toBe('invalid_argument')
    // Omitting image is allowed; the gateway resolves the catalog default.
    const ok = await sandboxCreate(ctx(fakeManager()), { name: 'w1' })
    expect(ok.data).toMatchObject({ name: 'w1' })
  })

  it('maps a manager failure to a retryable timeout error', async () => {
    const mgr = fakeManager({
      createSandbox: async () => {
        throw new Error('deadline exceeded')
      },
    })
    const e = await sandboxCreate(ctx(mgr), { name: 'w1', image: 'img' }).catch(e => e)
    expect((e as TypedToolError).code).toBe('retryable')
    expect(String(e)).toContain('60s')
  })

  it('maps an already-exists refusal to invalid_argument (not a timeout)', async () => {
    const mgr = fakeManager({
      createSandbox: async () => {
        throw new Error('ConnectError: [already_exists] sandbox "w1" already exists')
      },
    })
    const e = await sandboxCreate(ctx(mgr), { name: 'w1', image: 'img' }).catch(e => e)
    expect((e as TypedToolError).code).toBe('invalid_argument')
    expect(String(e)).toContain('already exists')
  })

  it('binds the sandbox to the calling session', async () => {
    let got: Record<string, unknown> = {}
    const mgr = fakeManager({
      createSandbox: async (req: Record<string, unknown>) => {
        got = req
        return { sandbox: { name: 'w1', image: 'img', phase: 'Running', ready: true, url: 'http://w1:48080', creator: 't', session: 'o:r:b', createdAt: 1n } }
      },
    })
    await sandboxCreate({ workspace: mgr, locale: 'en', session: 'o:r:b' }, { name: 'w1' })
    expect(got['session']).toBe('o:r:b')
  })

  it('passes os + disk through to the gateway (VM sandbox)', async () => {
    let got: Record<string, unknown> = {}
    const mgr = fakeManager({
      createSandbox: async (req: Record<string, unknown>) => {
        got = req
        return { sandbox: { name: 'w1', image: 'img', phase: 'Running', ready: true, url: 'http://w1:48080', creator: 't', createdAt: 1n } }
      },
    })
    await sandboxCreate(ctx(mgr), { name: 'w1', os: 'macos', disk: 'http://x/disk.qcow2' })
    expect(got['os']).toBe('macos')
    expect(got['disk']).toBe('http://x/disk.qcow2')
    // Omitted os/disk default to '' (the gateway applies linux + the per-OS disk).
    await sandboxCreate(ctx(mgr), { name: 'w2' })
    expect(got['os']).toBe('')
    expect(got['disk']).toBe('')
  })

  it('runs autoCheckout and appends its note when provided', async () => {
    const c: SandboxCtx = {
      workspace: fakeManager(),
      locale: 'en',
      session: 'o:r:feat',
      autoCheckout: async (name: string) => `checked out into ${name}`,
    }
    const r = await sandboxCreate(c, { name: 'w1' })
    expect(r.content).toContain('checked out into w1')
  })

  it('still succeeds when autoCheckout fails (best-effort)', async () => {
    const c: SandboxCtx = {
      workspace: fakeManager(),
      locale: 'en',
      session: 'o:r:feat',
      autoCheckout: async () => {
        throw new Error('boom')
      },
    }
    const r = await sandboxCreate(c, { name: 'w1' })
    expect(r.data).toMatchObject({ name: 'w1', ready: true })
  })
})

describe('sandbox-list', () => {
  it('reports none', async () => {
    const r = await sandboxList(ctx(fakeManager()), {})
    expect(r.content).toContain('No sandboxes')
  })

  it('lists workers with creator', async () => {
    const mgr = fakeManager({
      listSandboxes: async () => ({
        sandboxes: [{ name: 'a', image: 'i', phase: 'Running', ready: true, url: 'u', creator: 't/s', createdAt: 0n }],
      }),
    })
    const r = await sandboxList(ctx(mgr), {})
    expect(r.content).toContain('a')
    expect(r.content).toContain('t/s')
  })
})

describe('sandbox-status', () => {
  it('requires worker-name', async () => {
    const e = await sandboxStatus(ctx(fakeManager()), {}).catch(e => e)
    expect((e as TypedToolError).code).toBe('invalid_argument')
  })

  it('maps a missing worker to not_found', async () => {
    const mgr = fakeManager({
      getSandbox: async () => {
        throw new Error('not found')
      },
    })
    const e = await sandboxStatus(ctx(mgr), { 'worker-name': 'x' }).catch(e => e)
    expect((e as TypedToolError).code).toBe('not_found')
  })
})

describe('sandbox-delete', () => {
  it('deletes', async () => {
    const r = await sandboxDelete(ctx(fakeManager()), { 'worker-name': 'w1' })
    expect(r.data).toMatchObject({ name: 'w1', deleted: true })
  })
})

describe('sandbox-info capabilities', () => {
  it('renders probed capabilities (desktop/noVNC/a11y/distro) when reported', async () => {
    const client = fakeWorker({
      info: async () => ({
        os: 'linux',
        arch: 'amd64',
        shell: 'builtin(mvdan-sh)',
        workspace: '/root/workspace',
        home: '/root',
        bootId: 'abc123',
        capabilities: {
          desktop: true,
          display: 'x11',
          novnc: true,
          novncPort: 6080,
          xa11y: true,
          distro: 'debian',
        },
      }),
    })
    const c: SandboxCtx = {
      workspace: fakeManager(),
      locale: 'en',
      resolveWorker: async () => ({ client, url: 'http://wm-w1.worker.svc.cluster.local:48080' }),
    }
    const r = await sandboxCreate(c, { name: 'w1', image: 'img' })
    expect(r.content).toContain('capabilities:')
    expect(r.content).toContain('desktop(x11)')
    expect(r.content).toContain('noVNC:6080')
    expect(r.content).toContain('a11y')
    expect(r.content).toContain('distro:debian')
    expect(r.data).toMatchObject({
      capabilities: { desktop: true, xa11y: true, novncPort: 6080, distro: 'debian' },
    })
  })

  it('reports "none detected" for a plain sandbox', async () => {
    const client = fakeWorker({
      info: async () => ({
        os: 'linux',
        arch: 'amd64',
        shell: 'builtin(mvdan-sh)',
        workspace: '/root/workspace',
        home: '/root',
        bootId: 'abc123',
        capabilities: { desktop: false, display: '', novnc: false, novncPort: 0, xa11y: false, distro: 'debian' },
      }),
    })
    const c: SandboxCtx = {
      workspace: fakeManager(),
      locale: 'en',
      resolveWorker: async () => ({ client, url: 'http://wm-w1.worker.svc.cluster.local:48080' }),
    }
    const r = await sandboxCreate(c, { name: 'w1', image: 'img' })
    expect(r.content).toContain('distro:debian')
    expect(r.content).not.toContain('a11y')
    expect(r.content).not.toContain('desktop(')
  })

  it('omits the capabilities line when the worker reports none (older worker)', async () => {
    const c: SandboxCtx = {
      workspace: fakeManager(),
      locale: 'en',
      resolveWorker: async () => ({ client: fakeWorker(), url: 'http://wm-w1.worker.svc.cluster.local:48080' }),
    }
    const r = await sandboxCreate(c, { name: 'w1', image: 'img' })
    expect(r.content).not.toContain('capabilities:')
    expect(r.data['capabilities']).toBeUndefined()
  })
})
