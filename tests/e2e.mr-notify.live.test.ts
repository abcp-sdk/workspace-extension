import { afterAll, describe, expect, it } from 'vitest'
import { Agent, CH, connectNatsBus } from '@abc-protocol/sdk'

/**
 * Live e2e: `repo-mr-create` auto-notifies the BASE branch session, against the
 * DEPLOYED workspace-extension (no local Extension is started, so tool calls go
 * to the running deployment). Set LIVE_NATS_URL, GATEWAY_URL, GATEWAY_TOKEN.
 *
 * A feature-branch session opens an MR into `main`; the main session's mailbox
 * must receive a `trigger` from `system:repo-mr` without anyone polling.
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const hasEnv = LIVE_NATS !== '' && GATEWAY_URL !== ''
const maybe = hasEnv ? describe : describe.skip

maybe('live e2e: MR auto-notify (deployed extension)', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([Promise.resolve(s()).catch(() => {}), new Promise<void>(r => setTimeout(r, 2000))])
    }
  }, 120_000)

  it('wakes the base session when a change request is opened', async () => {
    const bus = await connectNatsBus(LIVE_NATS)
    stops.push(() => bus.close())

    const agent = await Agent.connect({ url: LIVE_NATS })
    stops.push(() => agent.close())
    await agent.serveConfig()
    await agent.discover(1500)

    const tenant = 'workspace'
    const stamp = Date.now()
    const org = `mrv-${stamp}`
    const repo = 'app'
    const featSession = `${org}:${repo}:feature/x`
    const mainSession = `${org}:${repo}:main`

    const call = async (session: string, tool: string, args: Record<string, unknown>) => {
      const res = await agent.callTool(tenant, session, 'workspace', tool, `call-${tool}-${Date.now()}-${Math.random()}`, args)
      if (res.error) throw new Error(`${tool}: ${res.error.code}: ${res.error.message}`)
      return res
    }

    // Watch the main session's mailbox subject BEFORE creating the MR. A core
    // subscription sees the live JetStream publish.
    const received: Array<Record<string, unknown>> = []
    const sub = await bus.subscribe(CH.mailbox(tenant, mainSession))
    stops.push(() => sub.close())
    void (async () => {
      for await (const env of sub) received.push(env.payload as Record<string, unknown>)
    })()

    await call(featSession, 'repo-create-org', { org })
    await call(featSession, 'repo-create-repo', { org, repo, 'auto-init': true })
    await call(featSession, 'repo-branch-create', { org, repo, name: 'feature/x', from: 'main' })
    await call(featSession, 'repo-file-write', { org, repo, ref: 'feature/x', path: 'a.txt', content: 'hi\n' })
    await call(featSession, 'repo-commit', { org, repo, ref: 'feature/x', message: 'seed' })
    await call(featSession, 'repo-mr-create', { org, repo, title: 'Add a', head: 'feature/x', base: 'main' })

    for (let i = 0; i < 40 && received.length === 0; i++) await new Promise(r => setTimeout(r, 250))
    expect(received.length).toBeGreaterThan(0)
    expect(received[0]).toMatchObject({ type: 'trigger', source: 'system:repo-mr' })
    expect(JSON.stringify(received[0]!.payload)).toContain('feature/x')
  }, 180_000)
})
