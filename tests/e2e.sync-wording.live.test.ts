import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus } from '@abc-protocol/sdk'

const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const hasEnv = LIVE_NATS !== '' && GATEWAY_URL !== ''
const maybe = hasEnv ? describe : describe.skip

maybe('live e2e: sync wording direction', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) await Promise.race([Promise.resolve(s()).catch(() => {}), new Promise<void>(r => setTimeout(r, 2000))])
  }, 120_000)

  it('reports main merged INTO the branch', async () => {
    const bus = await connectNatsBus(LIVE_NATS)
    stops.push(() => bus.close())
    const agent = await Agent.connect({ url: LIVE_NATS })
    stops.push(() => agent.close())
    await agent.serveConfig()
    await agent.discover(1500)
    const tenant = 'workspace'
    const stamp = Date.now()
    const org = `syncv-${stamp}`
    const repo = 'app'
    const feat = `${org}:${repo}:feature/x`
    const call = async (session: string, tool: string, args: Record<string, unknown>) => {
      const r = await agent.callTool(tenant, session, 'workspace', tool, `c-${tool}-${Date.now()}-${Math.random()}`, args)
      if (r.error) throw new Error(`${tool}: ${r.error.code}: ${r.error.message}`)
      return r
    }
    await call(feat, 'repo-create-org', { org })
    await call(feat, 'repo-create-repo', { org, repo, 'auto-init': true })
    await call(feat, 'repo-branch-create', { org, repo, name: 'feature/x', from: 'main' })
    await call(feat, 'repo-file-write', { org, repo, ref: 'feature/x', path: 'a.txt', content: 'x\n' })
    await call(feat, 'repo-commit', { org, repo, ref: 'feature/x', message: 'feat change' })
    const res = await call(feat, 'repo-branch-sync', { org, repo, branch: 'feature/x' })
    expect(String(res.content)).toContain('Merged main into')
    expect(String(res.content)).not.toContain('with main')
  }, 180_000)
})
