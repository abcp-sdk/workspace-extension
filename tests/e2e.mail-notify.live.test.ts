import { afterAll, describe, expect, it } from 'vitest'
import { Agent, CH, connectNatsBus } from '@abc-protocol/sdk'

/**
 * Live e2e: repo-mail-send role rules + branch-create event/task + mr-comment
 * reviewer notify, against the DEPLOYED extension. Set LIVE_NATS_URL,
 * GATEWAY_URL, GATEWAY_TOKEN.
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const hasEnv = LIVE_NATS !== '' && GATEWAY_URL !== ''
const maybe = hasEnv ? describe : describe.skip

maybe('live e2e: mail rules + fork seed + comment notify', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([Promise.resolve(s()).catch(() => {}), new Promise<void>(r => setTimeout(r, 2000))])
    }
  }, 120_000)

  it('enforces mail rules and seeds a forked branch session', async () => {
    const bus = await connectNatsBus(LIVE_NATS)
    stops.push(() => bus.close())
    const agent = await Agent.connect({ url: LIVE_NATS })
    stops.push(() => agent.close())
    await agent.serveConfig()
    await agent.discover(1500)

    const tenant = 'workspace'
    const stamp = Date.now()
    const org = `mailv-${stamp}`
    const repo = 'app'
    const mainSession = `${org}:${repo}:main`
    const featSession = `${org}:${repo}:feature/x`
    const childSession = `${org}:${repo}:feature/child`

    const call = (session: string, tool: string, args: Record<string, unknown>) =>
      agent.callTool(tenant, session, 'workspace', tool, `c-${tool}-${Date.now()}-${Math.random()}`, args)
    const ok = async (session: string, tool: string, args: Record<string, unknown>) => {
      const r = await call(session, tool, args)
      if (r.error) throw new Error(`${tool}: ${r.error.code}: ${r.error.message}`)
      return r
    }
    const err = async (session: string, tool: string, args: Record<string, unknown>) =>
      (await call(session, tool, args)).error

    await ok(featSession, 'repo-create-org', { org })
    await ok(featSession, 'repo-create-repo', { org, repo, 'auto-init': true })
    await ok(featSession, 'repo-branch-create', { org, repo, name: 'feature/x', from: 'main' })

    // A developer may only message its OWN repo's main.
    const denyBranch = await err(featSession, 'repo-mail-send', { org, repo, branch: 'feature/x', text: 'x' })
    expect(denyBranch?.code).toBe('permission_denied')
    const denyCross = await err(featSession, 'repo-mail-send', { org: 'other', repo: 'lib', text: 'x' })
    expect(denyCross?.code).toBe('permission_denied')
    const allowMain = await ok(featSession, 'repo-mail-send', { org, repo, branch: 'main', text: 'report' })
    expect(allowMain.content).toContain('main')

    // branch-create with task seeds event (fork preamble) THEN trigger (task).
    const seeded: Array<Record<string, unknown>> = []
    const sub = await bus.subscribe(CH.mailbox(tenant, childSession))
    stops.push(() => sub.close())
    void (async () => { for await (const e of sub) seeded.push(e.payload as Record<string, unknown>) })()

    await ok(mainSession, 'repo-branch-create', { org, repo, name: 'feature/child', from: 'main', task: 'add tests' })
    for (let i = 0; i < 40 && seeded.length < 2; i++) await new Promise(r => setTimeout(r, 250))
    expect(seeded.length).toBeGreaterThanOrEqual(2)
    expect(seeded[0]).toMatchObject({ type: 'event', source: 'system:repo-branch-fork' })
    expect(seeded[1]).toMatchObject({ type: 'trigger', source: `session:${mainSession}` })
    expect(JSON.stringify(seeded[0]!.payload)).toContain('todo-write')
    expect(JSON.stringify(seeded[1]!.payload)).toContain('add tests')
  }, 240_000)

  it('notifies the reviewer when the head session comments', async () => {
    const bus = await connectNatsBus(LIVE_NATS)
    stops.push(() => bus.close())
    const agent = await Agent.connect({ url: LIVE_NATS })
    stops.push(() => agent.close())
    await agent.serveConfig()
    await agent.discover(1500)

    const tenant = 'workspace'
    const stamp = Date.now()
    const org = `mrc-${stamp}`
    const repo = 'app'
    const featSession = `${org}:${repo}:feature/x`
    const mainSession = `${org}:${repo}:main`

    const call = async (session: string, tool: string, args: Record<string, unknown>) => {
      const r = await agent.callTool(tenant, session, 'workspace', tool, `c-${tool}-${Date.now()}-${Math.random()}`, args)
      if (r.error) throw new Error(`${tool}: ${r.error.code}: ${r.error.message}`)
      return r
    }

    await call(featSession, 'repo-create-org', { org })
    await call(featSession, 'repo-create-repo', { org, repo, 'auto-init': true })
    await call(featSession, 'repo-branch-create', { org, repo, name: 'feature/x', from: 'main' })
    await call(featSession, 'repo-file-write', { org, repo, ref: 'feature/x', path: 'a.txt', content: 'hi\n' })
    await call(featSession, 'repo-commit', { org, repo, ref: 'feature/x', message: 'seed' })
    await call(featSession, 'repo-mr-create', { org, repo, title: 'Add a', head: 'feature/x', base: 'main' })

    const got: Array<Record<string, unknown>> = []
    const sub = await bus.subscribe(CH.mailbox(tenant, mainSession))
    stops.push(() => sub.close())
    void (async () => { for await (const e of sub) got.push(e.payload as Record<string, unknown>) })()

    // The head (developer) comments -> the reviewer (main) is notified.
    await call(featSession, 'repo-mr-comment', { org, repo, index: 1, body: 'ready for review' })
    for (let i = 0; i < 40 && got.length === 0; i++) await new Promise(r => setTimeout(r, 250))
    expect(got.length).toBeGreaterThan(0)
    expect(got[0]).toMatchObject({ type: 'trigger', source: 'system:repo-mr-comment' })
    expect(JSON.stringify(got[0]!.payload)).toContain('ready for review')
  }, 240_000)
})
