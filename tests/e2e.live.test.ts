import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus, Extension } from '@abc-protocol/sdk'
import { createWorkspaceConfig } from '../src/index.js'
import { CONFIG } from '../src/config.js'

/**
 * Live end-to-end against a REAL workspace-gateway + a REAL Kubernetes cluster
 * (and a REAL NATS broker). Set:
 *   LIVE_NATS_URL    e.g. nats://<nats>:4222
 *   GATEWAY_URL      e.g. http://workspace-gateway.<ns>.svc.cluster.local
 *   GATEWAY_TOKEN    the gateway's sandbox service token
 *   E2E_IMAGE        a worker image to launch (must contain easyworker)
 *   E2E_NAME         optional sandbox name (default e2e-<ts>)
 * Skipped unless LIVE_NATS_URL, GATEWAY_URL and E2E_IMAGE are set.
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const E2E_IMAGE = process.env['E2E_IMAGE'] ?? ''
const maybe = LIVE_NATS === '' || GATEWAY_URL === '' || E2E_IMAGE === '' ? describe.skip : describe

maybe('live e2e: sandbox lifecycle + execution via the workspace gateway', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([
        Promise.resolve(s()).catch(() => {}),
        new Promise<void>(r => setTimeout(r, 2000)),
      ])
    }
  }, 120_000)

  it('creates, lists, executes in, then deletes a sandbox', async () => {
    const bus = await connectNatsBus(LIVE_NATS)
    stops.push(() => bus.close())

    let ext: Extension | undefined
    const config = createWorkspaceConfig(bus, {
      getConfig: (name, sessionName, tenant) =>
        ext?.getConfig(name, sessionName, tenant ?? ''),
    })
    ext = new Extension(bus, config)
    await ext.serve()
    stops.push(() => ext!.close())

    const agent = await Agent.connect({ url: LIVE_NATS })
    stops.push(() => agent.close())
    await agent.serveConfig()
    await agent.discover(1500)

    const tenant = 'e2e'
    const session = 'e2e-sandbox-session'
    await agent.setConfig(tenant, 'workspace', CONFIG.gatewayUrl, GATEWAY_URL)
    await agent.setConfig(tenant, 'workspace', CONFIG.gatewayToken, GATEWAY_TOKEN)
    await new Promise(r => setTimeout(r, 800))

    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await agent.callTool(tenant, session, 'workspace', tool, `call-${tool}-${Date.now()}`, args)
      if (res.error) throw new Error(`${tool}: ${res.error.code}: ${res.error.message}`)
      return res
    }

    const name = process.env['E2E_NAME'] ?? `e2e-${Date.now()}`

    // ---- create (waits up to 60s for readiness) ----
    const created = await call('sandbox-create', { name, image: E2E_IMAGE })
    expect(String((created.data as Record<string, unknown>).name)).toBe(name)
    expect(String((created.data as Record<string, unknown>).url)).toContain(name)

    try {
      // ---- list sees it, with the creator recorded ----
      const list = await call('sandbox-list', {})
      expect(list.content).toContain(name)
      expect(list.content).toContain(`${tenant}/${session}`)

      // ---- status ----
      const status = await call('sandbox-status', { 'worker-name': name })
      expect(String((status.data as Record<string, unknown>).phase)).toBe('Running')
      expect((status.data as Record<string, unknown>).ready).toBe(true)

      // ---- info + exec through the resolved worker ----
      const info = await call('sandbox-info', { 'worker-name': name })
      expect(info.data).toMatchObject({ os: 'linux', arch: 'amd64' })

      const exec = await call('sandbox-exec', { 'worker-name': name, command: 'echo hi-e2e' })
      expect(exec.content).toContain('hi-e2e')
      expect(exec.data).toMatchObject({ state: 'done', exit_code: 0 })

      // ---- write / read with line numbers ----
      await call('sandbox-write', { 'worker-name': name, path: 'e2e/a.txt', content: 'x\ny\n' })
      const read = await call('sandbox-read', { 'worker-name': name, path: 'e2e/a.txt' })
      expect(read.content).toContain('1  x')
      expect(read.content).toContain('2  y')

      // ---- a missing worker-name is refused ----
      const noName = await agent
        .callTool(tenant, session, 'workspace', 'sandbox-exec', `call-noname-${Date.now()}`, { command: 'echo x' })
        .then(r => r.error)
      expect(noName?.code).toBe('invalid_argument')
    } finally {
      // ---- delete ----
      const del = await call('sandbox-delete', { 'worker-name': name })
      expect((del.data as Record<string, unknown>).deleted).toBe(true)
      const list2 = await call('sandbox-list', {})
      expect(list2.content).not.toContain(name)
    }
  }, 180_000)
})
