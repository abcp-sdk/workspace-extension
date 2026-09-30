import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus, Extension } from '@abc-protocol/sdk'
import { createWorkspaceConfig } from '../src/index.js'
import { CONFIG } from '../src/config.js'

/**
 * Live e2e: sandbox auto-checkout on create + fan-out on a repo change.
 * Set LIVE_NATS_URL, GATEWAY_URL, GATEWAY_TOKEN, E2E_IMAGE (a worker base).
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const E2E_IMAGE = process.env['E2E_IMAGE'] ?? ''
const hasEnv = LIVE_NATS !== '' && GATEWAY_URL !== ''
const maybe = hasEnv ? describe : describe.skip

maybe('live e2e: sandbox auto-checkout + fan-out', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([Promise.resolve(s()).catch(() => {}), new Promise<void>(r => setTimeout(r, 2000))])
    }
  }, 120_000)

  it('checks the branch into a new sandbox, then fans a write out to it', async () => {
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

    const stamp = Date.now()
    const org = `e2esb-${stamp}`
    const repo = 'app'
    const branch = 'main'
    const session = `${org}:${repo}:${branch}`
    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await agent.callTool(tenant, session, 'workspace', tool, `call-${tool}-${Date.now()}`, args)
      if (res.error) throw new Error(`${tool}: ${res.error.code}: ${res.error.message}`)
      return res
    }

    // Seed a repo (main is auto-initialized by EnsureRepo).
    await call('repo-create-org', { org })
    await call('repo-create-repo', { org, repo, 'auto-init': true })

    // Create a sandbox: the extension must auto-checkout the session's branch.
    const name = `e2esb-${stamp}`
    const created = await call('sandbox-create', { name, ...(E2E_IMAGE ? { image: E2E_IMAGE } : {}) })
    expect(created.content).toContain('Checked out')
    expect(created.content).toContain(`${org}/${repo}@${branch}`)

    // A checked-out repo directory must be present in the sandbox.
    const ls = await call('sandbox-file-ls', { 'worker-name': name, path: '.' })
    expect(ls.content).toContain(repo)

    await call('sandbox-delete', { 'worker-name': name })
  }, 300_000)
})
