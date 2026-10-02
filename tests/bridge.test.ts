import { describe, expect, it } from 'vitest'
import { sandboxSubmitMR } from '../src/tools/bridge.js'
import type { BridgeCtx } from '../src/tools/bridge.js'
import type { CommitFile, Forgejo } from '../src/forgejo.js'

/**
 * `sandbox-submit-mr` must be BINARY-SAFE and must build the change set from a
 * diff of the sandbox repo directory against `base`: added/changed files plus
 * deletions for paths present in base but absent in the sandbox.
 */

interface Capture {
  files: CommitFile[]
  base: string
}

function ctxWith(
  sandboxFiles: Record<string, Uint8Array>,
  baseFiles: Record<string, Uint8Array> = {},
): { c: BridgeCtx; cap: Capture } {
  const cap: Capture = { files: [], base: '' }
  const c = {
    client: {
      fileList: async () => ({
        isDir: true,
        files: Object.entries(sandboxFiles).map(([p, b]) => ({ path: p, isDir: false, size: b.length })),
      }),
      fileRead: async ({ path }: { path: string }) => ({ content: sandboxFiles[path] ?? new Uint8Array() }),
    },
    forgejo: {
      listTree: async () => new Set(Object.keys(baseFiles)),
      getRaw: async (_o: string, _r: string, path: string) => baseFiles[path] ?? new Uint8Array(),
      submitMR: async (_o: string, _r: string, base: string, _t: string, _b: string, files: CommitFile[]) => {
        cap.base = base
        cap.files = files
        return { index: 7, url: 'http://x/mr/7', head: 'mr/acme-web-main-1' }
      },
    },
    locale: 'en',
  } as unknown as BridgeCtx
  return { c, cap }
}

describe('sandbox-submit-mr change set', () => {
  it('requires base and path', async () => {
    const { c } = ctxWith({})
    const e1 = await sandboxSubmitMR(c, { org: 'acme', repo: 'web', path: 'myapp' }).catch(e => e)
    expect((e1 as { code?: string }).code).toBe('invalid_argument')
    expect(String(e1)).toContain('base')
    const e2 = await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main' }).catch(e => e)
    expect(String(e2)).toContain('path')
  })

  it('submits a valid-UTF-8 file as text (unchanged bytes)', async () => {
    const { c, cap } = ctxWith({ 'myapp/a.txt': new TextEncoder().encode('hello\n') })
    await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    expect(cap.base).toBe('main')
    expect(cap.files).toHaveLength(1)
    expect(cap.files[0]).toMatchObject({ path: 'a.txt', operation: 'create', content: 'hello\n' })
    expect(cap.files[0]!.contentBytes).toBeUndefined()
  })

  it('submits a non-UTF-8 file via contentBytes, byte-for-byte', async () => {
    const bin = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x80, 0x81, 0xfe, 0xff])
    const { c, cap } = ctxWith({ 'myapp/lib.so': bin })
    await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    expect(cap.files[0]!.content).toBeUndefined()
    expect(cap.files[0]!.contentBytes).toEqual(bin)
  })

  it('marks changed files update and skips unchanged ones', async () => {
    const same = new TextEncoder().encode('same\n')
    const changed = new TextEncoder().encode('new\n')
    const { c, cap } = ctxWith(
      { 'myapp/same.txt': same, 'myapp/chg.txt': changed },
      { 'same.txt': same, 'chg.txt': new TextEncoder().encode('old\n') },
    )
    await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    const paths = cap.files.map(f => `${f.path}:${f.operation}`).sort()
    expect(paths).toEqual(['chg.txt:update'])
  })

  it('submits a DELETE for a base file missing from the sandbox', async () => {
    const { c, cap } = ctxWith(
      { 'myapp/keep.txt': new TextEncoder().encode('k\n') },
      { 'keep.txt': new TextEncoder().encode('k\n'), 'gone.txt': new TextEncoder().encode('g\n') },
    )
    await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    const del = cap.files.find(f => f.path === 'gone.txt')
    expect(del).toMatchObject({ operation: 'delete' })
  })

  it('reports no changes when the sandbox matches base', async () => {
    const t = new TextEncoder().encode('x\n')
    const { c } = ctxWith({ 'myapp/a.txt': t }, { 'a.txt': t })
    const r = await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    expect(String(r.content)).toContain('identical')
  })

  it('honors .gitignore: ignored trees never enter the change set', async () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const { c, cap } = ctxWith({
      'myapp/.gitignore': enc('node_modules/\n'),
      'myapp/src/a.ts': enc('export const a = 1\n'),
      'myapp/node_modules/pkg/index.js': enc('module.exports = {}\n'),
    })
    await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    expect(cap.files.map(f => f.path).sort()).toEqual(['.gitignore', 'src/a.ts'])
  })

  it('refuses more than the file-count cap', async () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 101; i++) files[`myapp/f${i}.txt`] = new TextEncoder().encode('x')
    const { c } = ctxWith(files)
    const e = await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' }).catch(x => x)
    expect((e as { code?: string }).code).toBe('invalid_argument')
    expect(String(e)).toContain('100')
  })

  it('refuses a change set over the byte cap', async () => {
    const big = new Uint8Array(11 * 1024 * 1024) // 11 MiB in one file
    const { c } = ctxWith({ 'myapp/big.bin': big })
    const e = await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' }).catch(x => x)
    expect((e as { code?: string }).code).toBe('invalid_argument')
    expect(String(e)).toContain('MiB')
  })

  // A base file that is TRACKED yet matches .gitignore (added with `git add -f`,
  // or tracked before the rule) exists physically in the sandbox. .gitignore only
  // hides UNTRACKED files, so it must NOT be reported as a delete — that would
  // silently remove a legitimate file from the target branch.
  it('does not delete a tracked base file that matches .gitignore', async () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const { c, cap } = ctxWith(
      { 'myapp/.gitignore': enc('*.log\n'), 'myapp/keep.log': enc('tracked\n') },
      { '.gitignore': enc('*.log\n'), 'keep.log': enc('tracked\n') },
    )
    await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    expect(cap.files.map(f => `${f.path}:${f.operation}`)).toEqual([])
  })

  // The counterpart: an ignored path that is ALSO untracked (absent from base)
  // is neither submitted nor deleted.
  it('leaves an untracked ignored tree alone (no create, no delete)', async () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const { c, cap } = ctxWith(
      { 'myapp/.gitignore': enc('node_modules/\n'), 'myapp/a.ts': enc('a\n'), 'myapp/node_modules/x.js': enc('x\n') },
      { '.gitignore': enc('node_modules/\n'), 'a.ts': enc('a\n') },
    )
    await sandboxSubmitMR(c, { org: 'acme', repo: 'web', base: 'main', path: 'myapp' })
    expect(cap.files).toEqual([])
  })
})
