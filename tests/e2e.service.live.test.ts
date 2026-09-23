import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus, Extension } from '@abc-protocol/sdk'
import { createWorkspaceConfig } from '../src/index.js'
import { CONFIG } from '../src/config.js'

/**
 * Live e2e: a service deployed by a session is bound to that session and
 * reported by service-list. Set LIVE_NATS_URL, GATEWAY_URL, GATEWAY_TOKEN.
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const E2E_IMAGE = process.env['E2E_IMAGE'] ?? 'git.agent.svc.cluster.local/root/alpine:3.24'
const hasEnv = LIVE_NATS !== '' && GATEWAY_URL !== ''
const maybe = hasEnv ? describe : describe.skip

maybe('live e2e: service session binding', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([Promise.resolve(s()).catch(() => {}), new Promise<void>(r => setTimeout(r, 2000))])
    }
  }, 90_000)

  it('binds a deployed service to its session', async () => {
    const bus = await connectNatsBus(LIVE_NATS)
    stops.push(() => bus.close())
    let ext: Extension | undefined
    const config = createWorkspaceConfig(bus, {
      getConfig: (name, sessionName, tenant) => ext?.getConfig(name, sessionName, tenant ?? ''),
    })
    ext = new Extension(bus, config)
    await ext.serve()
    stops.push(() => ext!.close())
    const agent = await Agent.connect({ url: LIVE_NATS })
    stops.push(() => agent.close())
    await agent.serveConfig()
    await agent.discover(1500)
    const tenant = 'e2e'
    await agent.setConfig(tenant, 'workspace', CONFIG.gatewayUrl, GATEWAY_URL)
    await agent.setConfig(tenant, 'workspace', CONFIG.gatewayToken, GATEWAY_TOKEN)
    await new Promise(r => setTimeout(r, 800))

    const session = `e2esvc-${Date.now()}:app:main`
    const name = `e2esvc-${Date.now()}`
    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await agent.callTool(tenant, session, 'workspace', tool, `call-${tool}-${Date.now()}`, args)
      if (res.error) throw new Error(`${tool}: ${res.error.code}: ${res.error.message}`)
      return res
    }
    await call('service-deploy', { name, image: E2E_IMAGE, 'container-port': 80 })
    const list = await call('service-list', {})
    expect(list.content).toContain(name)
    expect(list.content).toContain(`session=${session}`)
    await call('service-delete', { name })
  }, 180_000)
})
