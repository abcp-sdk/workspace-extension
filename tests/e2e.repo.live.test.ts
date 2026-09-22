import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus, Extension } from '@abc-protocol/sdk'
import { createWorkspaceConfig } from '../src/index.js'
import { CONFIG } from '../src/config.js'

/**
 * Live end-to-end against a REAL Forgejo (and a REAL easyworker for the
 * checkout/port bridge). Set:
 *   LIVE_NATS_URL  e.g. nats://<nats>:4222
 *   GATEWAY_URL / GATEWAY_TOKEN  the workspace gateway (repo tools go through it)
 *   E2E_ORG / E2E_REPO  an existing repo the tenant owns
 *   E2E_IMAGE  a worker image for the checkout/port test
 * Skipped unless LIVE_NATS_URL, GATEWAY_URL and E2E_ORG/E2E_REPO are set.
 */
const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? ''
const GATEWAY_TOKEN = process.env['GATEWAY_TOKEN'] ?? ''
const E2E_ORG = process.env['E2E_ORG'] ?? ''
const E2E_REPO = process.env['E2E_REPO'] ?? ''
const E2E_IMAGE = process.env['E2E_IMAGE'] ?? ''
const hasRepo = LIVE_NATS !== '' && GATEWAY_URL !== '' && E2E_ORG !== '' && E2E_REPO !== ''
const maybe = hasRepo ? describe : describe.skip

maybe('live e2e: workspace repo-* tools against a real Forgejo', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) {
      await Promise.race([
        Promise.resolve(s()).catch(() => {}),
        new Promise<void>(r => setTimeout(r, 2000)),
      ])
    }
  }, 90_000)

  it('reads, edits, commits and diffs a real repository', async () => {
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
    const session = 'e2e-repo-session'
    await agent.setConfig(tenant, 'workspace', CONFIG.gatewayUrl, GATEWAY_URL)
    await agent.setConfig(tenant, 'workspace', CONFIG.gatewayToken, GATEWAY_TOKEN)
    await new Promise(r => setTimeout(r, 800))

    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await agent.callTool(tenant, session, 'workspace', tool, `call-${tool}-${Date.now()}`, args)
      if (res.error) throw new Error(`${tool}: ${res.error.code}: ${res.error.message}`)
      return res
    }

    // ---- explore: the org + repo must be visible ----
    const explore = await call('repo-explore', { org: E2E_ORG, repo: E2E_REPO })
    expect(explore.content).toContain(`${E2E_ORG}/${E2E_REPO}`)

    // ---- create-org + create-repo (random names; no cleanup endpoint here) ----
    const stamp = Date.now()
    const newOrg = `e2e-org-${stamp}`
    const newRepo = `e2e-repo-${stamp}`
    const madeOrg = await call('repo-create-org', { org: newOrg, 'full-name': 'E2E Org' })
    expect(String(madeOrg.data && (madeOrg.data as Record<string, unknown>).org)).toBe(newOrg)
    const madeRepo = await call('repo-create-repo', {
      org: newOrg, repo: newRepo, private: true, 'auto-init': true, 'default-branch': 'main',
    })
    expect(String((madeRepo.data as Record<string, unknown>).default_branch)).toBe('main')
    // The new repo is reachable.
    const newBranches = await call('repo-branches', { org: newOrg, repo: newRepo })
    expect(newBranches.content).toContain('main')

    // ---- branches ----
    const branches = await call('repo-branches', { org: E2E_ORG, repo: E2E_REPO })
    expect(String(branches.data && JSON.stringify(branches.data))).toContain('branches')

    // ---- write a scratch file, then read/edit it ----
    const scratch = `e2e-scratch-${Date.now()}.txt`
    await call('repo-write', {
      org: E2E_ORG, repo: E2E_REPO, path: scratch,
      content: 'line1\nline2\nline3\n', message: 'e2e: write scratch',
    })
    const read = await call('repo-read', { org: E2E_ORG, repo: E2E_REPO, path: scratch })
    expect(read.content).toContain('1  line1')
    expect(read.content).toContain('3  line3')

    const edited = await call('repo-edit', {
      org: E2E_ORG, repo: E2E_REPO, path: scratch,
      'start-line': 2, 'end-line': 2, content: 'LINE2', message: 'e2e: edit scratch',
    })
    expect(edited.content).toContain('@@')
    expect(edited.content).toContain('-line2')
    expect(edited.content).toContain('+LINE2')

    // ---- a second edit without re-read is refused ----
    const stale = await agent
      .callTool(tenant, session, 'workspace', 'repo-edit', `call-stale-${Date.now()}`, {
        org: E2E_ORG, repo: E2E_REPO, path: scratch,
        'start-line': 2, 'end-line': 2, content: 'Z',
      })
      .then(r => r.error)
    expect(stale?.code).toBe('permission_denied')

    // ---- log mentions the file ----
    const log = await call('repo-log', { org: E2E_ORG, repo: E2E_REPO, path: scratch })
    expect(log.content).toContain('e2e:')

    // ---- cleanup: delete the scratch file ----
    await call('repo-delete', {
      org: E2E_ORG, repo: E2E_REPO, path: scratch, message: 'e2e: delete scratch',
    })
  }, 120_000)

  it('checks out the repo into the sandbox and ports a new file back', async () => {
    if (E2E_IMAGE === '') return // no image: skip bridge part
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
    const session = 'e2e-bridge-session'
    for (const [k, v] of [
      [CONFIG.gatewayUrl, GATEWAY_URL],
      [CONFIG.gatewayToken, GATEWAY_TOKEN],
    ] as Array<[string, string]>) {
      await agent.setConfig(tenant, 'workspace', k, v)
    }
    await new Promise(r => setTimeout(r, 800))

    // Create a sandbox for the bridge test and delete it afterwards.
    const worker = `e2e-bridge-${Date.now()}`
    await call('sandbox-create', { name: worker, image: E2E_IMAGE })

    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await agent.callTool(tenant, session, 'workspace', tool, `call-${tool}-${Date.now()}`, args)
      if (res.error) throw new Error(`${tool}: ${res.error.code}: ${res.error.message}`)
      return res
    }

    const checkout = await call('sandbox-checkout', { 'worker-name': worker, org: E2E_ORG, repo: E2E_REPO, dest: 'checkout' })
    expect(Number((checkout.data as Record<string, unknown>).files)).toBeGreaterThan(0)

    // Create a NEW file in the sandbox and port it to a fresh dir.
    const dir = `e2e-port-${Date.now()}`
    await call('sandbox-write', { 'worker-name': worker, path: `${dir}/a.txt`, content: 'A\n' })
    await call('sandbox-write', { 'worker-name': worker, path: `${dir}/b.txt`, content: 'B\n' })
    const ported = await call('sandbox-port', {
      'worker-name': worker, org: E2E_ORG, repo: E2E_REPO, path: dir, message: 'e2e: port dir',
    })
    expect(Number((ported.data as Record<string, unknown>).count)).toBe(2)

    await call('sandbox-delete', { 'worker-name': worker })
  }, 180_000)
})
