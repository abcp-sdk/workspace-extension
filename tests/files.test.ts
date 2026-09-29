import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import {
  applyEdit,
  expandTilde,
  looksTextual,
  numberLines,
  resolveEditTarget,
  splitLines,
  windowLines,
} from '../src/tools/text.js'
import {
  deleteFile,
  downloadFile,
  editFile,
  readFile,
  uploadFile,
  writeFile,
  type FileCtx,
} from '../src/tools/files.js'
import type { WorkerClient } from '../src/client.js'
import type { WorkspaceDeps } from '../src/deps.js'

const enc = (s: string) => new TextEncoder().encode(s)

/** A fake worker exposing only the file calls the file tools use. Implements
 *  the WINDOWED FileRead (startLine/endLine + totalLines) like worker.v1. */
function fakeClient(files: Record<string, Uint8Array>): WorkerClient {
  const split = (c: Uint8Array): string[] => {
    const t = new TextDecoder().decode(c)
    const lines = t.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  }
  return {
    fileRead: async (req: { path: string; startLine?: number; endLine?: number }) => {
      const c = files[req.path]
      if (c === undefined) throw new Error(`not found: ${req.path}`)
      const all = split(c)
      const start = req.startLine && req.startLine > 0 ? req.startLine : 0
      const end = req.endLine && req.endLine > 0 ? req.endLine : all.length
      // A whole-file window returns the ORIGINAL bytes verbatim (byte-exact);
      // a partial window is the slice joined with '\n'.
      const whole = start === 0 && end >= all.length
      const content = whole
        ? c
        : new TextEncoder().encode(all.slice(start, end).join('\n'))
      return { content, totalLines: all.length, startLine: start, endLine: start + all.slice(start, end).length }
    },
    fileWrite: async (req: { path: string; content: Uint8Array }) => {
      files[req.path] = req.content
      return { ok: true }
    },
    fileDelete: async (req: { path: string }) => {
      delete files[req.path]
      return { ok: true }
    },
  } as unknown as WorkerClient
}

function fileCtx(
  files: Record<string, Uint8Array>,
  ingest?: (name: string, data: Uint8Array) => { code: string; mime: string },
): FileCtx {
  return {
    client: fakeClient(files),
    tenant: 't1',
    session: 's1',
    deps: {
      getFile: async () => ({ data: enc('x'), name: 'x', mime: 'text/plain' }),
      ingestFile: async ({ name, data }) =>
        ingest?.(name, data) ?? { code: 'abc123', mime: 'text/plain' },
      getSessionVariable: async () => '',
    },
  }
}

describe('text helpers', () => {
  it('detects text vs binary', () => {
    expect(looksTextual(enc('hello'))).toBe(true)
    expect(looksTextual(new Uint8Array([0, 1, 2]))).toBe(false)
    expect(looksTextual(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false)
  })

  it('splits lines and drops a single trailing empty', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('windows lines with clamping', () => {
    const data = enc('l0\nl1\nl2\nl3')
    expect(windowLines(data, 1, 2).lines).toEqual(['l1', 'l2'])
    expect(windowLines(data, 1, 2).truncated).toBe(true)
    expect(windowLines(data, 10, 2).lines).toEqual([])
  })

  it('numbers lines from an absolute start', () => {
    expect(numberLines(['x', 'y'], 10)).toEqual(['10  x', '11  y'])
  })

  it('expands a leading ~ against home (falls back to workspace)', () => {
    const a = { home: '/root', workspace: '/root/workspace' }
    expect(expandTilde('~', a)).toBe('/root')
    expect(expandTilde('~/', a)).toBe('/root')
    expect(expandTilde('~/x/y', a)).toBe('/root/x/y')
    expect(expandTilde('~/workspace/a.txt', a)).toBe('/root/workspace/a.txt')
    // no tilde: unchanged
    expect(expandTilde('/abs/x', a)).toBe('/abs/x')
    expect(expandTilde('rel/x', a)).toBe('rel/x')
    // `~user` is NOT supported: stays literal
    expect(expandTilde('~bob/x', a)).toBe('~bob/x')
    // home empty -> fall back to workspace
    expect(expandTilde('~/x', { home: '', workspace: '/ws' })).toBe('/ws/x')
    // both empty -> unchanged (cannot expand)
    expect(expandTilde('~/x', { home: '', workspace: '' })).toBe('~/x')
  })

  it('resolves anchor pairs strictly (no clamping)', () => {
    expect(resolveEditTarget(1, 4, 10)).toEqual({ ok: true, target: { s: 1, e: 4 } })
    expect(resolveEditTarget(0, 1, 10)).toEqual({ ok: true, target: { s: 0, e: 1 } })
    expect(resolveEditTarget(10, 11, 10)).toEqual({ ok: true, target: { s: 10, e: 11 } })
    expect(resolveEditTarget(0, 1, 0)).toEqual({ ok: true, target: { s: 0, e: 1 } })
    expect(resolveEditTarget(11, 11, 10)).toEqual({ ok: false, reason: 'startAnchorMin' })
    expect(resolveEditTarget(2, 2, 10)).toEqual({ ok: false, reason: 'anchorOrder' })
    expect(resolveEditTarget(3, 12, 10)).toEqual({ ok: false, reason: 'endAnchorMax' })
    expect(resolveEditTarget(-1, 1, 10)).toEqual({ ok: false, reason: 'startAnchorMin' })
  })

  it('applies an edit target', () => {
    expect(applyEdit(['1', '2', '3', '4'], { s: 1, e: 4 }, ['X'])).toEqual(['1', 'X', '4'])
    expect(applyEdit(['1', '2', '3'], { s: 1, e: 2 }, ['X'])).toEqual(['1', 'X', '2', '3'])
    expect(applyEdit(['1', '2'], { s: 0, e: 1 }, ['H'])).toEqual(['H', '1', '2'])
    expect(applyEdit(['1', '2'], { s: 2, e: 3 }, ['T'])).toEqual(['1', '2', 'T'])
  })
})

describe('read', () => {
  it('returns numbered lines and a truncation marker', async () => {
    const files = { 'a.txt': enc('one\ntwo\nthree\nfour') }
    const r = await readFile(fileCtx(files), { path: 'a.txt', offset: 1, limit: 2 })
    expect(r.content).toContain('2  two')
    expect(r.content).toContain('3  three')
    expect(r.content).toContain('showing lines 2-3 of 4')
  })

  it('rejects binary files with a typed invalid_argument error', async () => {
    const files = { 'a.bin': new Uint8Array([0, 1, 2, 3]) }
    const err = await readFile(fileCtx(files), { path: 'a.bin' }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
    expect(String(err)).toMatch(/not a text file/)
  })

  it('missing required args are typed invalid_argument', async () => {
    const err = await readFile(fileCtx({}), {}).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
  })
})

describe('write', () => {
  it('writes bytes and returns the numbered full file', async () => {
    const files: Record<string, Uint8Array> = {}
    const r = await writeFile(fileCtx(files), { path: 'out.txt', content: 'a\nb\n' })
    expect(new TextDecoder().decode(files['out.txt'])).toBe('a\nb\n')
    expect(r.content).toContain('Wrote 4 bytes')
    expect(r.content).toContain('1  a')
    expect(r.content).toContain('2  b')
    expect(r.data).toMatchObject({ lines: 2, total_lines: 2 })
  })

  it('does not cap at 1000 lines (whole file returned)', async () => {
    const files: Record<string, Uint8Array> = {}
    const body = Array.from({ length: 1200 }, (_, i) => `L${i + 1}`).join('\n') + '\n'
    const r = await writeFile(fileCtx(files), { path: 'big.txt', content: body })
    expect(r.content).toContain('1200  L1200')
    expect(r.content).not.toContain('truncated')
  })

  it('rejects content over 120 KiB without writing', async () => {
    const files: Record<string, Uint8Array> = {}
    const huge = 'x'.repeat(121 * 1024)
    const err = await writeFile(fileCtx(files), { path: 'huge.txt', content: huge }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
    expect(files['huge.txt']).toBeUndefined()
  })
})

describe('edit (anchor lines + anchor content)', () => {
  const decode = (f: Record<string, Uint8Array>) => new TextDecoder().decode(f['a.txt'])

  it('replaces the lines strictly between the two anchors', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n4') }
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 4, 'start-anchor': '1', 'end-anchor': '4', content: 'X' })
    expect(decode(files)).toBe('1\nX\n4')
  })

  it('inserts between two adjacent anchors', async () => {
    const files = { 'a.txt': enc('1\n2\n3') }
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 2, 'start-anchor': '1', 'end-anchor': '2', content: 'X' })
    expect(decode(files)).toBe('1\nX\n2\n3')
  })

  it('prepends at the head (start 0, empty start-anchor)', async () => {
    const files = { 'a.txt': enc('1\n2\n3') }
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 0, 'end-anchor-line': 1, 'start-anchor': '', 'end-anchor': '1', content: 'HEAD' })
    expect(decode(files)).toBe('HEAD\n1\n2\n3')
  })

  it('appends at the tail (end total+1, empty end-anchor)', async () => {
    const files = { 'a.txt': enc('1\n2\n3') }
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 3, 'end-anchor-line': 4, 'start-anchor': '3', 'end-anchor': '', content: 'TAIL' })
    expect(decode(files)).toBe('1\n2\n3\nTAIL')
  })

  it('accepts empty-string head/tail sentinel lines', async () => {
    const files = { 'a.txt': enc('1\n2') }
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': '', 'end-anchor-line': 1, 'start-anchor': '', 'end-anchor': '1', content: 'HEAD' })
    expect(decode(files)).toBe('HEAD\n1\n2')
    const files2 = { 'a.txt': enc('1\n2') }
    await editFile(fileCtx(files2), { path: 'a.txt', 'start-anchor-line': 2, 'end-anchor-line': '', 'start-anchor': '2', 'end-anchor': '', content: 'TAIL' })
    expect(decode(files2)).toBe('1\n2\nTAIL')
  })

  it('inserts into an empty file (0,1)', async () => {
    const files: Record<string, Uint8Array> = {}
    await writeFile(fileCtx(files), { path: 'a.txt', content: '' })
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 0, 'end-anchor-line': 1, 'start-anchor': '', 'end-anchor': '', content: 'first' })
    expect(decode(files)).toBe('first')
  })

  it('deletes the region when content is empty', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n4') }
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 4, 'start-anchor': '1', 'end-anchor': '4', content: '' })
    expect(decode(files)).toBe('1\n4')
  })

  it('preserves the trailing newline', async () => {
    const files = { 'a.txt': enc('alpha\nbeta\ngamma\n') }
    await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 3, 'start-anchor': 'alpha', 'end-anchor': 'gamma', content: 'BETA' })
    expect(decode(files)).toBe('alpha\nBETA\ngamma\n')
  })

  it('rejects an out-of-range start anchor', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n'
    const files = { 'a.txt': enc(ten) }
    const err = await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 11, 'end-anchor-line': 11, 'start-anchor': '', 'end-anchor': '', content: 'X' }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
    expect(decode(files)).toBe(ten)
  })

  it('rejects an out-of-range end anchor', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const err = await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 5, 'start-anchor': '1', 'end-anchor': '', content: 'X' }).catch(e => e)
    expect((err as TypedToolError).code).toBe('invalid_argument')
  })

  it('rejects an inverted anchor pair', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const err = await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 2, 'end-anchor-line': 2, 'start-anchor': '', 'end-anchor': '', content: 'X' }).catch(e => e)
    expect((err as TypedToolError).code).toBe('invalid_argument')
  })

  it('requires all four anchor arguments', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    for (const missing of ['start-anchor-line', 'end-anchor-line', 'start-anchor', 'end-anchor']) {
      const args: Record<string, unknown> = { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 3, 'start-anchor': '1', 'end-anchor': '3', content: 'X' }
      delete args[missing]
      const err = await editFile(fileCtx(files), args).catch(e => e)
      expect((err as TypedToolError).code).toBe('invalid_argument')
      expect(String(err)).toContain(missing)
    }
  })

  it('refuses the edit when an anchor content does not match (no write)', async () => {
    const files = { 'a.txt': enc('alpha\nbeta\ngamma\n') }
    const err = await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 3, 'start-anchor': 'WRONG', 'end-anchor': 'gamma', content: 'X' }).catch(e => e)
    expect((err as TypedToolError).code).toBe('retryable')
    expect(decode(files)).toBe('alpha\nbeta\ngamma\n')
  })

  it('returns a unified diff', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n4') }
    const r = await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 4, 'start-anchor': '1', 'end-anchor': '4', content: 'X' })
    expect(r.content).toContain('--- a/a.txt')
    expect(r.content).toContain('-2')
    expect(r.content).toContain('+X')
    expect(r.data).toMatchObject({ added: 1, removed: 2 })
  })

  it('reports no changes when the edit is a no-op', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const r = await editFile(fileCtx(files), { path: 'a.txt', 'start-anchor-line': 1, 'end-anchor-line': 3, 'start-anchor': '1', 'end-anchor': '3', content: '2' })
    expect(String(r.content)).toContain('No changes')
  })
})


describe('read: server-side window', () => {
  it('reports the whole-file total while returning only the window', async () => {
    const files = { 'a.txt': enc('l0\nl1\nl2\nl3\nl4') }
    const r = await readFile(fileCtx(files), { path: 'a.txt', offset: 1, limit: 2 })
    expect(r.content).toContain('2  l1')
    expect(r.content).toContain('3  l2')
    expect(r.content).toContain('showing lines 2-3 of 5')
    expect(r.data).toMatchObject({ total_lines: 5, start: 1, shown: 2 })
  })
})

describe('rm', () => {
  it('deletes a file', async () => {
    const files = { 'a.txt': enc('x') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    const r = await deleteFile(ctx, { path: 'a.txt' })
    expect(r.content).toContain('a.txt')
    expect(files['a.txt']).toBeUndefined()
  })

  it('missing path is typed invalid_argument', async () => {
    const err = await deleteFile(fileCtx({}), {}).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
  })
})

describe('upload', () => {
  it('routes bytes through ingest with a default name', async () => {
    const files = { 'dir/a.txt': enc('data') }
    let seen: { name: string; len: number } | undefined
    const r = await uploadFile(
      fileCtx(files, (name, data) => {
        seen = { name, len: data.length }
        return { code: 'c0de', mime: 'text/plain' }
      }),
      { path: 'dir/a.txt' },
    )
    expect(seen).toEqual({ name: 'a.txt', len: 4 })
    expect(r.data).toEqual({
      files: [{ code: 'c0de', name: 'a.txt', mime: 'text/plain', size: 4 }],
    })
  })
})

describe('download', () => {
  it('exposes the fetched file under data.files', async () => {
    const files: Record<string, Uint8Array> = {}
    const written: { path: string; len: number }[] = []
    const c: FileCtx = {
      client: {
        fileWrite: async (req: { path: string; content: Uint8Array }) => {
          written.push({ path: req.path, len: req.content.length })
          return { ok: true }
        },
      } as unknown as WorkerClient,
      deps: {
        getFile: async () => ({
          data: enc('hello'),
          name: 'note.txt',
          mime: 'text/plain',
        }),
      } as unknown as WorkspaceDeps,
      tenant: 't1',
      session: 'acme:web:main',
      locale: 'en',
    }
    void files
    const r = await downloadFile(c, { code: 'c0de', path: 'dir/note.txt' })
    expect(written).toEqual([{ path: 'dir/note.txt', len: 5 }])
    expect(r.data).toEqual({
      files: [{ code: 'c0de', name: 'note.txt', mime: 'text/plain', size: 5 }],
    })
  })
})
