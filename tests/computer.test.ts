import { describe, expect, it } from 'vitest'
import type { ComputerClient } from '../src/client.js'
import { detectPlatform, probeTarget } from '../src/computer/target.js'
import { apps as cuApps, screenshot as cuScreenshot } from '../src/computer/tools.js'
import type { ToolCtx } from '../src/computer/tools.js'

/** A ComputerService stub recording the calls the tools make. */
function fakeComputer(over: Partial<Record<string, unknown>> = {}): {
  client: ComputerClient
  calls: string[]
} {
  const calls: string[] = []
  const client = {
    info: async () => ({ platform: 'linux-x11', display: 'x11', tools: ['xa11y'] }),
    apps: async () => ({ apps: [{ pid: '123', name: 'zenity', focused: true }, { pid: '456', name: 'gedit', focused: false }] }),
    snapshot: async (r: { app: string; depth: number }) => { calls.push(`snapshot:${r.app}:${r.depth}`); return { text: 'tree' } },
    find: async (r: { selector: string; app: string; output: string }) => { calls.push(`find:${r.selector}:${r.app}:${r.output}`); return { text: 'match' } },
    action: async (r: { action: string; target: string; value: string; app: string }) => { calls.push(`action:${r.action}:${r.target}:${r.value}:${r.app}`); return { ok: true } },
    click: async (r: { x: number; y: number; button: string; count: number }) => { calls.push(`click:${r.x}:${r.y}:${r.button}:${r.count}`); return { ok: true } },
    type: async (r: { text: string; target: string }) => { calls.push(`type:${r.text}:${r.target}`); return { ok: true } },
    key: async (r: { key: string; held: string[] }) => { calls.push(`key:${r.key}:${r.held.join(',')}`); return { ok: true } },
    scroll: async (r: { x: number; y: number; dx: number; dy: number }) => { calls.push(`scroll:${r.x}:${r.y}:${r.dx}:${r.dy}`); return { ok: true } },
    drag: async (r: { fromX: number; fromY: number; toX: number; toY: number; durationMs: number }) => { calls.push(`drag:${r.fromX}:${r.fromY}:${r.toX}:${r.toY}:${r.durationMs}`); return { ok: true } },
    screenshot: async (r: { region: string }) => { calls.push(`shot:${r.region}`); return { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 800, height: 600 } },
    ...over,
  } as unknown as ComputerClient
  return { client, calls }
}

describe('detectPlatform', () => {
  it('maps worker OS strings to platform families', () => {
    expect(detectPlatform('linux')).toBe('linux')
    expect(detectPlatform('')).toBe('linux')
    expect(detectPlatform('android')).toBe('android')
    expect(detectPlatform('windows')).toBe('windows')
    expect(detectPlatform('darwin')).toBe('macos')
    expect(detectPlatform('macOS')).toBe('macos')
  })
})

describe('probeTarget gating (ComputerService)', () => {
  it('passes when ComputerService.Info resolves', async () => {
    const t = await probeTarget(fakeComputer().client, 'w1', 'en')
    expect(t.sandbox).toBe('w1')
  })

  it('throws not_found when ComputerService.Info fails', async () => {
    const client = fakeComputer({ info: async () => { throw new Error('unimplemented') } }).client
    const e = await probeTarget(client, 'w1', 'en').catch(x => x)
    expect((e as { code: string }).code).toBe('not_found')
    expect(String(e)).toContain('w1')
  })

  it('refuses a sandbox with no GUI tools (plain sandbox-<lang>)', async () => {
    const client = fakeComputer({ info: async () => ({ platform: 'linux', display: '', tools: [] }) }).client
    const e = await probeTarget(client, 'w1', 'en').catch(x => x)
    expect((e as { code: string }).code).toBe('not_found')
  })
})

describe('computer tools (thin proxy)', () => {
  const ctx: ToolCtx = {
    deps: { ingestFile: async () => ({ code: 'abc123', mime: 'image/png' }) } as unknown as ToolCtx['deps'],
    locale: 'en',
    tenant: 't',
    session: 'o:r:b',
  }

  it('apps lists the worker ComputerService apps', async () => {
    const { client } = fakeComputer()
    const r = await cuApps(ctx, { sandbox: 'w1', client })
    expect(r.data).toMatchObject({ apps: [{ pid: '123', name: 'zenity', focused: true }, { pid: '456', name: 'gedit', focused: false }] })
    expect(String(r.content)).toContain('123\tzenity\tfocused')
  })

  it('screenshot ingests the PNG bytes from the worker and returns file:<code>', async () => {
    const { client, calls } = fakeComputer()
    const r = await cuScreenshot(ctx, { sandbox: 'w1', client }, { region: '10,20,300,200' })
    expect(calls[0]).toBe('shot:10,20,300,200')
    expect(String(r.content)).toContain('file:abc123')
    expect(r.data).toMatchObject({ files: [{ code: 'abc123', mime: 'image/png', width: 800, height: 600 }] })
  })

  it('screenshot fails when the PNG is empty', async () => {
    const { client } = fakeComputer({ screenshot: async () => ({ png: new Uint8Array(), width: 0, height: 0 }) })
    const e = await cuScreenshot(ctx, { sandbox: 'w1', client }, {}).catch(x => x)
    expect((e as { code: string }).code).toBe('retryable')
  })
})
