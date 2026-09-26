import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus } from '@abc-protocol/sdk'

/**
 * Live e2e: sandbox SESSION isolation through the real gateway, against the
 * DEPLOYED workspace-extension (no local Extension is started). Set
 * LIVE_NATS_URL, GATEWAY_URL, GATEWAY_TOKEN (E2E_IMAGE optional).
 *
 * Two agent sessions in the SAME tenant each create a sandbox; neither may
 * see, read, exec in, or delete the other's sandbox.
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const E2E_IMAGE = process.env['E2E_IMAGE'] ?? ''
const hasEnv = LIVE_NATS !== '' && GATEWAY_URL !== ''
const maybe = hasEnv ? describe : describe.skip

maybe('live e2e: sandbox session isolation', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([Promise.resolve(s()).catch(() => {}), new Promise<void>(r => setTimeout(r, 2000))])
    }
  }, 120_000)

  it('hides a feature-branch session from another session sandbox', async () => {
    const bus = await connectNatsBus(LIVE_NATS)
    stops.push(() => bus.close())

    const agent = await Agent.connect({ url: LIVE_NATS })
    stops.push(() => agent.close())
    await agent.serveConfig()
    await agent.discover(1500)

    const tenant = 'workspace'
    const stamp = Date.now()
    const org = `e2eiso-${stamp}`
    const repo = 'app'
    const mainSession = `${org}:${repo}:main`
    const featSession = `${org}:${repo}:feature/x`
    const mainSandbox = `iso-main-${stamp}`
    const featSandbox = `iso-feat-${stamp}`

    const call = (session: string, tool: string, args: Record<string, unknown>) =>
      agent.callTool(tenant, session, 'workspace', tool, `call-${tool}-${Date.now()}`, args)
    const callOk = async (session: string, tool: string, args: Record<string, unknown>) => {
      const res = await call(session, tool, args)
      if (res.error) throw new Error(`${tool} (${session}): ${res.error.code}: ${res.error.message}`)
      return res
    }
    const errOf = async (session: string, tool: string, args: Record<string, unknown>) =>
      (await call(session, tool, args)).error

    // Seed the repo + both branch sessions.
    await callOk(featSession, 'repo-create-org', { org })
    await callOk(featSession, 'repo-create-repo', { org, repo, 'auto-init': true })
    await callOk(featSession, 'repo-branch-create', { org, repo, name: 'feature/x', from: 'main' })

    const image = E2E_IMAGE ? { image: E2E_IMAGE } : {}
    try {
      await callOk(mainSession, 'sandbox-create', { name: mainSandbox, ...image })
      await callOk(featSession, 'sandbox-create', { name: featSandbox, ...image })

      // Each session's list shows ONLY its own sandbox.
      const mainList = await callOk(mainSession, 'sandbox-list', {})
      expect(mainList.content).toContain(mainSandbox)
      expect(mainList.content).not.toContain(featSandbox)
      const featList = await callOk(featSession, 'sandbox-list', {})
      expect(featList.content).toContain(featSandbox)
      expect(featList.content).not.toContain(mainSandbox)

      // A cross-session exec is refused (not found).
      const xexec = await errOf(featSession, 'sandbox-exec', { 'worker-name': mainSandbox, command: 'echo pwn' })
      expect(xexec).toBeTruthy()
      if (!['not_found', 'permission_denied'].includes(xexec!.code)) {
        throw new Error(`cross-session exec code=${xexec!.code} msg=${xexec!.message}`)
      }

      // A cross-session read is refused.
      const xread = await errOf(featSession, 'sandbox-file-read', { 'worker-name': mainSandbox, path: 'etc/hostname' })
      expect(xread).toBeTruthy()

      // A cross-session delete is refused, and the sandbox survives.
      const xdel = await errOf(featSession, 'sandbox-delete', { 'worker-name': mainSandbox })
      expect(xdel).toBeTruthy()
      const mainStatus = await callOk(mainSession, 'sandbox-status', { 'worker-name': mainSandbox })
      expect(String((mainStatus.data as Record<string, unknown>).phase)).toBe('Running')

      // A name is never reused, even by its OWN session: a second create with
      // the same name is refused and the original survives.
      const dup = await errOf(mainSession, 'sandbox-create', { name: mainSandbox, ...image })
      expect(dup).toBeTruthy()
      expect(dup!.code).toBe('invalid_argument')
      const stillThere = await callOk(mainSession, 'sandbox-status', { 'worker-name': mainSandbox })
      expect(String((stillThere.data as Record<string, unknown>).phase)).toBe('Running')
    } finally {
      await call(mainSession, 'sandbox-delete', { 'worker-name': mainSandbox })
      await call(featSession, 'sandbox-delete', { 'worker-name': featSandbox })
    }
  }, 240_000)
})
