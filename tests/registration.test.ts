import { afterAll, describe, expect, it } from 'vitest'
import {
  Agent,
  Extension,
  ExtensionManifestSchema,
  connectNatsBus,
  start,
} from '@abc-protocol/sdk'
import { createWorkspaceConfig, EXT_ID } from '../src/index.js'
import { CONFIG, BRIDGE_REQUIRED, BUILD_REQUIRED, REPO_REQUIRED, SANDBOX_REQUIRED } from '../src/config.js'
import type { WorkspaceClient, WorkerClient } from '../src/client.js'
import type { Forgejo } from '../src/forgejo.js'

/** A throwing stub client — registration never calls it. */
function stubClient(): WorkerClient {
  return new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('not called in registration test')
      },
    },
  ) as WorkerClient
}

function stubForgejo(): Forgejo {
  return new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('not called in registration test')
      },
    },
  ) as unknown as Forgejo
}

function stubManager(): WorkspaceClient {
  return new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('not called in registration test')
      },
    },
  ) as unknown as WorkspaceClient
}

const EXPECTED_TOOLS = [
  // sandbox lifecycle (workspace gateway)
  'sandbox-create',
  'sandbox-delete',
  'list-oci-images',
  'oci-import',
  'sandbox-list',
  'sandbox-status',
  // sandbox execution (easyworker)
  'sandbox-checkout',
  'sandbox-file-download',
  'sandbox-file-edit',
  'sandbox-exec',
  'sandbox-info',
  'sandbox-job-kill',
  'sandbox-job-list',
  'sandbox-job-output',
  'sandbox-job-stdin',
  'sandbox-job-start',
  'sandbox-job-wait',
  'sandbox-file-ls',
  'sandbox-port',
  'sandbox-file-read',
  'sandbox-file-rm',
  'sandbox-file-upload',
  'sandbox-file-write',
  // repo-*
  'repo-branch-create',
  'repo-branch-sync',
  'repo-branches',
  'repo-build-image',
  'repo-build-preview',
  'service-delete',
  'service-deploy',
  'service-list',
  'service-logs',
  'service-preview',
  'repo-commit',
  'repo-create-org',
  'repo-create-repo',
  'repo-file-delete',
  'repo-diff',
  'repo-file-edit',
  'repo-delete-push-mirror',
  'repo-explore',
  'repo-import',
  'repo-file-list',
  'repo-list-push-mirrors',
  'repo-log',
  'repo-mail-send',
  'repo-mr-comment',
  'repo-mr-create',
  'repo-mr-list',
  'repo-mr-merge',
  'repo-file-read',
  'repo-remove',
  'repo-file-restore',
  'repo-set-push-mirror',
  'repo-show',
  'repo-tag-create',
  'repo-tags',
  'repo-file-write',
].sort()

describe('workspace extension registration', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([
        Promise.resolve(s()).catch(() => {}),
        new Promise<void>(r => setTimeout(r, 2000)),
      ])
    }
  }, 30_000)

  it('is discoverable and advertises the sandbox-* + repo-* tool set', async () => {
    const server = await start({ storage: 'memory' })
    const url = `nats://127.0.0.1:${server.port}`
    stops.push(() => server.stop())

    const bus = await connectNatsBus(url)
    stops.push(() => bus.close())
    const ext = new Extension(
      bus,
      createWorkspaceConfig(bus, {
        getConfig: () => '',
        makeClient: stubClient,
        makeForgejo: stubForgejo,
        makeManager: stubManager,
      }),
    )
    await ext.serve()
    stops.push(() => ext.close())

    let manifest = null
    for (let i = 0; i < 5 && manifest === null; i++) {
      const replies = await bus.requestMany('abc.discover', {}, {
        maxWaitMs: 800,
        tenant: 'global',
      })
      for (const env of replies) {
        const p = ExtensionManifestSchema.safeParse(env.payload)
        if (p.success && p.data.id === EXT_ID) manifest = p.data
      }
    }

    expect(manifest).not.toBeNull()
    const names = (manifest?.tools ?? []).map(t => t.name).sort()
    expect(names).toEqual(EXPECTED_TOOLS)

    // Per-tool gating: sandbox-* and repo-* both need the gateway; the bridge
    // needs it too (repo checkout/port now go through the gateway).
    for (const t of manifest?.tools ?? []) {
      const expected = t.name === 'sandbox-checkout' || t.name === 'sandbox-port'
        ? BRIDGE_REQUIRED
        : t.name === 'repo-build-image'
          ? BUILD_REQUIRED
          : t.name.startsWith('repo-')
            ? REPO_REQUIRED
            : SANDBOX_REQUIRED
      expect(t.required_config, t.name).toEqual(expected)
    }
    const config = (manifest?.config ?? []).map(c => c.name).sort()
    expect(config).toEqual([CONFIG.gatewayUrl, CONFIG.gatewayToken].sort())

    // Prompt variables: org/repo/branch, all session-scoped (the branch-role
    // system prompts reference them).
    const vars = (manifest?.prompt?.variables ?? []).map(v => [v.name, v.scope]).sort()
    expect(vars).toEqual([
      ['branch', 'session'],
      ['org', 'session'],
      ['repo', 'session'],
    ])

    // Execution tools carry a required worker-name; lifecycle tools do not.
    const byName = new Map((manifest?.tools ?? []).map(t => [t.name, t]))
    for (const exec of ['sandbox-exec', 'sandbox-file-read', 'sandbox-checkout', 'sandbox-port']) {
      expect(byName.get(exec)?.input_schema?.required, exec).toContain('worker-name')
    }
    for (const life of ['sandbox-create', 'sandbox-list']) {
      expect(byName.get(life)?.input_schema?.required ?? [], life).not.toContain('worker-name')
    }
  })

  it('disables a sandbox tool call until the gateway is configured', async () => {
    const server = await start({ storage: 'memory' })
    const url = `nats://127.0.0.1:${server.port}`
    stops.push(() => server.stop())

    const bus = await connectNatsBus(url)
    stops.push(() => bus.close())
    const ext = new Extension(
      bus,
      createWorkspaceConfig(bus, {
        getConfig: () => undefined,
        makeClient: stubClient,
        makeForgejo: stubForgejo,
        makeManager: stubManager,
      }),
    )
    await ext.serve()
    stops.push(() => ext.close())

    const agent = await Agent.connect({ url })
    stops.push(() => agent.close())

    const res = await agent.callTool('global', '', EXT_ID, 'sandbox-info', 'call-1', {})
    expect('error' in res && res.error).toBeTruthy()
  })

  it('rejects a repo tool call when the gateway is not configured', async () => {
    const server = await start({ storage: 'memory' })
    const url = `nats://127.0.0.1:${server.port}`
    stops.push(() => server.stop())

    const bus = await connectNatsBus(url)
    stops.push(() => bus.close())
    const ext = new Extension(
      bus,
      createWorkspaceConfig(bus, {
        // No gateway config at all -> repo-* tools are disabled.
        getConfig: () => '',
        makeClient: stubClient,
        makeForgejo: stubForgejo,
        makeManager: stubManager,
      }),
    )
    await ext.serve()
    stops.push(() => ext.close())

    const agent = await Agent.connect({ url })
    stops.push(() => agent.close())

    const res = await agent.callTool('global', '', EXT_ID, 'repo-explore', 'call-2', {})
    expect(res.error?.code).toBe('invalid_argument')
  })
})
