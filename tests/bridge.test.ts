import { describe, expect, it } from 'vitest'
import { sandboxPort } from '../src/tools/bridge.js'
import type { BridgeCtx } from '../src/tools/bridge.js'
import type { CommitFile, Forgejo } from '../src/forgejo.js'

/**
 * `sandbox-port` must be BINARY-SAFE: a non-UTF-8 file has to reach the repo
 * byte-for-byte. The regression this guards: `TextDecoder().decode` (non-fatal)
 * replaces every invalid byte with U+FFFD, inflating and corrupting the file.
 */

interface Capture {
  files: CommitFile[]
}

function ctxWith(
  sandboxFiles: Record<string, Uint8Array>,
  opts: { dir?: boolean } = {},
): { c: BridgeCtx; cap: Capture } {
  const cap: Capture = { files: [] }
  const c = {
    client: {
      fileList: async ({ path }: { path: string }) => {
        if (opts.dir || path === 'dir') {
          return {
            isDir: true,
            files: Object.keys(sandboxFiles).map(p => ({ path: p, isDir: false })),
          }
        }
        return { isDir: false, files: [] }
      },
      fileRead: async ({ path }: { path: string }) => ({
        content: sandboxFiles[path] ?? new Uint8Array(),
      }),
    },
    forgejo: {
      // getContents is only used for a DIRECTORY port's existence check.
      getContents: async () => {
        throw new Error('absent')
      },
      applyFiles: async (_o: string, _r: string, files: CommitFile[]) => {
        cap.files = files
        return { sha: 'deadbeefcafe', message: '' }
      },
    },
    locale: 'en',
    branch: 'feature/x',
  } as unknown as BridgeCtx
  return { c, cap }
}

describe('sandbox-port binary safety', () => {
  it('ports a valid-UTF-8 file as a string (unchanged bytes)', async () => {
    const text = new TextEncoder().encode('hello\nworld\n')
    const { c, cap } = ctxWith({ 'a.txt': text })
    await sandboxPort(c, { org: 'acme', repo: 'web', path: 'a.txt', 'repo-path': 'a.txt' })
    expect(cap.files).toHaveLength(1)
    expect(cap.files[0]!.content).toBe('hello\nworld\n')
    expect(cap.files[0]!.contentBytes).toBeUndefined()
  })

  it('ports a non-UTF-8 file via contentBytes, byte-for-byte', async () => {
    // 7f 45 4c 46 (ELF magic, valid) + 80 81 fe ff (invalid UTF-8).
    const bin = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x80, 0x81, 0xfe, 0xff])
    const { c, cap } = ctxWith({ 'libwcdb_api.so': bin })
    await sandboxPort(c, { org: 'acme', repo: 'web', path: 'libwcdb_api.so', 'repo-path': 'libwcdb_api.so' })
    expect(cap.files).toHaveLength(1)
    expect(cap.files[0]!.content).toBeUndefined()
    expect(cap.files[0]!.contentBytes).toEqual(bin)
    // No U+FFFD replacement crept in.
    expect(Buffer.from(cap.files[0]!.contentBytes!).includes(0xef)).toBe(false)
  })

  it('requires repo-path (never infers it from the sandbox path)', async () => {
    const { c } = ctxWith({ 'easyvcs/store/store.go': new TextEncoder().encode('x') })
    const e = await sandboxPort(c, { org: 'acme', repo: 'easyvcs', path: 'easyvcs/store/store.go' }).catch(e => e)
    expect((e as { code?: string }).code).toBe('invalid_argument')
    expect(String(e)).toContain('repo-path')
  })

  it('keeps text and binary distinct in a directory port', async () => {
    const text = new TextEncoder().encode('ok\n')
    const bin = new Uint8Array([0x00, 0xff, 0x10, 0x80])
    const { c, cap } = ctxWith({ 'dir/a.txt': text, 'dir/b.bin': bin })
    await sandboxPort(c, { org: 'acme', repo: 'web', path: 'dir', 'repo-path': 'out' })
    expect(cap.files).toHaveLength(2)
    const a = cap.files.find(f => f.path === 'out/a.txt')!
    const b = cap.files.find(f => f.path === 'out/b.bin')!
    expect(a.content).toBe('ok\n')
    expect(a.contentBytes).toBeUndefined()
    expect(b.contentBytes).toEqual(bin)
    expect(b.content).toBeUndefined()
  })
})
