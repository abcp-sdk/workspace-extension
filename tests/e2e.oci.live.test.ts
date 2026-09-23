import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus, Extension } from '@abc-protocol/sdk'
import { createWorkspaceConfig } from '../src/index.js'
import { CONFIG } from '../src/config.js'

/**
 * Live e2e: oci-import mirrors an upstream image into the caller's org.
 * Set LIVE_NATS_URL, GATEWAY_URL, GATEWAY_TOKEN.
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const hasEnv = LIVE_NATS !== '' && GATEWAY_URL !== ''
const maybe = hasEnv ? describe : describe.skip

maybe('live e2e: oci-import', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([Promise.resolve(s()).catch(() => {}), new Promise<void>(r => setTimeout(r, 2000))])
    }
  }, 120_000)

  it('mirrors an upstream image into an owned org', async () => {
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

    const org = `e2eoci-${Date.now()}`
    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await agent.callTool(tenant, `${org}:app:main`, 'workspace', tool, `c-${tool}-${Date.now()}`, args)
      if (res.error) throw new Error(`${tool}: ${res.error.code}: ${res.error.message}`)
      return res
    }
    const imported = await call('oci-import', {
      org,
      name: 'redis',
      tag: '8.10.2',
      source: 'docker.io/library/redis:8.10.2',
    })
    expect(String((imported.data as Record<string, unknown>).image_ref)).toBe(
      `git.agent.svc.cluster.local/${org}/redis:8.10.2`,
    )
    const list = await call('list-oci-images', { owner: org, name: 'redis' })
    expect(list.content).toContain(`${org}/redis:8.10.2`)
  }, 300_000)
})
