import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import type { WorkerClient } from '../src/client.js'
import { detectPlatform, probeTarget } from '../src/computer/target.js'
import { Xa11yPlatform } from '../src/computer/platform.js'
import { apps as cuApps, screenshot as cuScreenshot } from '../src/computer/tools.js'
import type { ToolCtx } from '../src/computer/tools.js'

/**
 * A worker stub that records every Execute command and answers jobWait /
 * jobOutput / fileRead from scripted tables. `info` reports the OS and the
 * probed capabilities.
 */
function fakeWorker(opts: {
  os?: string
  capabilities?: Record<string, unknown>
  outputs?: Record<string, string>
  onExecute?: (command: string) => void
  readContent?: Uint8Array
} = {}): WorkerClient {
  const outputs = opts.outputs ?? {}
  return {
    info: async () => ({
      os: opts.os ?? 'linux',
      arch: 'amd64',
      shell: 'builtin(mvdan-sh)',
      workspace: '/root/workspace',
      home: '/root',
      bootId: 'b',
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    }),
    execute: async ({ command }: { command: string }) => {
      opts.onExecute?.(command)
      return { jobId: command }
    },
    jobWait: async ({ jobId }: { jobId: string }) => ({
      state: 'done',
      exitCode: 0,
      // carry the command through so jobOutput can look up its scripted output
      _job: jobId,
    }),
    jobOutput: async ({ jobId }: { jobId: string }) => {
      const text = outputs[jobId] ?? ''
      return { lines: text === '' ? [] : text.split('\n'), totalLines: 1, startLine: 0, endLine: 1, done: true }
    },
    fileRead: async () => ({ content: opts.readContent ?? new Uint8Array(), totalLines: 0, startLine: 0, endLine: 0 }),
  } as unknown as WorkerClient
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

describe('probeTarget gating', () => {
  it('refuses immediately when the worker reports xa11y=false (no command run)', async () => {
    let ran = 0
    const client = fakeWorker({
      capabilities: { desktop: false, display: '', novnc: false, novncPort: 0, xa11y: false, distro: 'debian' },
      onExecute: () => {
        ran++
      },
    })
    const e = await probeTarget(client, 'w1', 'en').catch(x => x)
    expect((e as TypedToolError).code).toBe('not_found')
    expect(String(e)).toContain('w1')
    expect(ran).toBe(0) // capabilities gate short-circuits before any Execute
  })

  it('accepts a desktop sandbox that reports xa11y=true (probe runs and passes)', async () => {
    const client = fakeWorker({
      capabilities: { desktop: true, display: 'x11', novnc: true, novncPort: 6080, xa11y: true, distro: 'debian' },
      outputs: { 'command -v xa11y': '/usr/local/bin/xa11y' },
    })
    const t = await probeTarget(client, 'w1', 'en')
    expect(t.platform.id).toBe('linux')
  })

  it('falls back to a CLI probe when the worker does not report capabilities', async () => {
    const client = fakeWorker({ outputs: { 'command -v xa11y': '/usr/bin/xa11y' } })
    const t = await probeTarget(client, 'w1', 'en')
    expect(t.platform.id).toBe('linux')
  })

  it('refuses when the fallback CLI probe finds nothing', async () => {
    const client = fakeWorker({ outputs: {} })
    const e = await probeTarget(client, 'w1', 'en').catch(x => x)
    expect((e as TypedToolError).code).toBe('not_found')
  })

  it('gates Android on adb, not xa11y', async () => {
    // capabilities absent, os=android: probe runs `adb ... getprop`
    const client = fakeWorker({ os: 'android', outputs: { 'adb -s emulator-5554 wait-for-device shell getprop sys.boot_completed': '1' } })
    const t = await probeTarget(client, 'a1', 'en')
    expect(t.platform.id).toBe('android')
  })
})

describe('Xa11yPlatform command construction', () => {
  it('builds an `xa11y tree` command with app + depth flags', async () => {
    let seen = ''
    const client = fakeWorker({ onExecute: c => (seen = c), outputs: {} })
    const p = new Xa11yPlatform(client, 'linux')
    await p.snapshot('zenity', 3)
    expect(seen).toBe("xa11y tree --app 'zenity' --depth 3")
  })

  it('quotes the app name so a space cannot break the command', async () => {
    let seen = ''
    const client = fakeWorker({ onExecute: c => (seen = c) })
    const p = new Xa11yPlatform(client, 'windows')
    await p.action('press', 'button[name="OK"]', '', 'My App')
    expect(seen).toBe("xa11y action 'press' 'button[name=\"OK\"]' --app 'My App'")
  })
})

describe('computer tools', () => {
  const ctx: ToolCtx = {
    deps: { ingestFile: async () => ({ code: 'abc123', mime: 'image/png' }) } as unknown as ToolCtx['deps'],
    locale: 'en',
    tenant: 't',
    session: 'o:r:b',
  }

  it('apps parses `pid\\tname[\\tfocused]` lines', async () => {
    const client = fakeWorker({ outputs: { 'xa11y apps': '123\tzenity\tfocused\n456\tgedit' } })
    const t = await probeTarget(fakeWorker({ capabilities: { xa11y: true }, outputs: { 'xa11y apps': '123\tzenity\tfocused\n456\tgedit', 'command -v xa11y': '/x' } }), 'w1', 'en')
    // use the scripted worker directly for the call
    const target = { ...t, platform: new Xa11yPlatform(client, 'linux') }
    const r = await cuApps(ctx, target)
    expect(r.data).toMatchObject({ apps: [{ pid: '123', name: 'zenity', focused: true }, { pid: '456', name: 'gedit', focused: false }] })
  })

  it('screenshot ingests the PNG through the agent and returns file:<code>', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const client = fakeWorker({ outputs: { 'xa11y screenshot --out /tmp/cu-shot.png': 'wrote /tmp/cu-shot.png (800x600 @1x)' }, readContent: png })
    const target = { sandbox: 'w1', platform: new Xa11yPlatform(client, 'linux'), client }
    const r = await cuScreenshot(ctx, target, {})
    expect(String(r.content)).toContain('file:abc123')
    expect(r.data).toMatchObject({ files: [{ code: 'abc123', mime: 'image/png', width: 800, height: 600 }] })
  })
})
