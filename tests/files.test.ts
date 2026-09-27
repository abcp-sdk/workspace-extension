import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import {
  checkAnchor,
  looksTextual,
  numberLines,
  resolveEditTarget,
  splitLines,
  touchedRange,
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
import type { SessionEditState } from '../src/tools/edit-state.js'

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
  let state: SessionEditState = {}
  return {
    client: fakeClient(files),
    tenant: 't1',
    session: 's1',
    deps: {
      getFile: async () => ({ data: enc('x'), name: 'x', mime: 'text/plain' }),
      ingestFile: async ({ name, data }) =>
        ingest?.(name, data) ?? { code: 'abc123', mime: 'text/plain' },
      getSessionVariable: async () => '',
      loadEditState: async () => state,
      saveEditState: async (_t, _s, next) => {
        state = next
      },
      clearEditState: async () => {
        state = {}
      },
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

  it('resolves replace targets strictly (no clamping)', () => {
    expect(resolveEditTarget(2, 3, 10)).toEqual({ ok: true, target: { kind: 'replace', s: 1, e: 3 } })
    expect(resolveEditTarget(1, 1, 1)).toEqual({ ok: true, target: { kind: 'replace', s: 0, e: 1 } })
    expect(resolveEditTarget(11, 10, 10)).toEqual({ ok: true, target: { kind: 'insert', at: 10 } })
    expect(resolveEditTarget(1, 0, 0)).toEqual({ ok: true, target: { kind: 'insert', at: 0 } })
    expect(resolveEditTarget(12, 11, 10)).toEqual({ ok: false, reason: 'startLinePastEnd' })
    expect(resolveEditTarget(5, 3, 10)).toEqual({ ok: false, reason: 'endLineBeforeStart' })
    expect(resolveEditTarget(3, 12, 10)).toEqual({ ok: false, reason: 'endLinePastEnd' })
    expect(resolveEditTarget(0, -1, 10)).toEqual({ ok: false, reason: 'startLineMin' })
  })

  it('computes the touched range for the read guard', () => {
    expect(touchedRange({ kind: 'replace', s: 1, e: 3 }, 10)).toEqual([2, 3])
    expect(touchedRange({ kind: 'insert', at: 0 }, 10)).toEqual([1, 1])
    expect(touchedRange({ kind: 'insert', at: 10 }, 10)).toEqual([10, 10])
    expect(touchedRange({ kind: 'insert', at: 0 }, 0)).toEqual([1, 0])
  })

  it('checks anchors with trim semantics', () => {
    const lines = ['alpha', '  beta']
    expect(checkAnchor(lines, 1, 'alpha', 2)).toEqual({ ok: true })
    expect(checkAnchor(lines, 2, 'beta', 2)).toEqual({ ok: true })
    expect(checkAnchor(lines, 1, '', 2)).toMatchObject({ ok: false, reason: 'missing' })
    expect(checkAnchor(lines, 1, 'wrong', 2)).toMatchObject({ ok: false, reason: 'mismatch' })
    expect(checkAnchor(lines, 3, '', 2)).toEqual({ ok: true })
    expect(checkAnchor(lines, 3, 'x', 2)).toMatchObject({ ok: false, reason: 'outOfRange' })
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

describe('edit (read-before-edit guard)', () => {
  const decode = (f: Record<string, Uint8Array>) =>
    new TextDecoder().decode(f['a.txt'])

  it('refuses to edit a file that was never read', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const err = await editFile(fileCtx(files), {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 2,
      content: 'X',
    }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('permission_denied')
    expect(String(err)).toContain('read')
  })

  it('allows editing only lines that were read', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n4\n5\n6\n') }
    const ctx = fileCtx(files)
    // read lines 2-3 only
    await readFile(ctx, { path: 'a.txt', offset: 1, limit: 2 })
    // editing line 5 must be refused
    const err = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 5,
      'end-line': 5,
      content: 'X',
      'start-anchor': '5',
      'end-anchor': '5',
    }).catch(e => e)
    expect((err as TypedToolError).code).toBe('permission_denied')
    expect(String(err)).toContain('2-3')
    // editing lines 2-3 is allowed
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 3,
      content: 'X',
      'start-anchor': '2',
      'end-anchor': '3',
    })
    expect(decode(files)).toBe('1\nX\n4\n5\n6\n')
  })

  it('requires a re-read after a successful edit', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, { path: 'a.txt', 'start-line': 2, 'end-line': 2, content: 'X', 'start-anchor': '2', 'end-anchor': '2' })
    const err = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 2,
      content: 'Y',
      'start-anchor': 'X',
      'end-anchor': 'X',
    }).catch(e => e)
    expect((err as TypedToolError).code).toBe('permission_denied')
    // re-read then edit works
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, { path: 'a.txt', 'start-line': 2, 'end-line': 2, content: 'Y', 'start-anchor': 'X', 'end-anchor': 'X' })
    expect(decode(files)).toBe('1\nY\n3\n')
  })

  it('detects an external change since the read', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    files['a.txt'] = enc('1\n2\nCHANGED\n') // e.g. an exec wrote it
    const err = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 2,
      content: 'X',
      'start-anchor': '2',
      'end-anchor': '2',
    }).catch(e => e)
    expect((err as TypedToolError).code).toBe('retryable')
  })

  it('write marks the whole file seen (edit works without a read)', async () => {
    const files: Record<string, Uint8Array> = {}
    const ctx = fileCtx(files)
    await writeFile(ctx, { path: 'a.txt', content: '1\n2\n3\n' })
    await editFile(ctx, { path: 'a.txt', 'start-line': 2, 'end-line': 2, content: 'X', 'start-anchor': '2', 'end-anchor': '2' })
    expect(decode(files)).toBe('1\nX\n3\n')
  })

  it('replaces an inclusive range', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n4') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 3,
      content: 'X',
      'start-anchor': '2',
      'end-anchor': '3',
    })
    expect(decode(files)).toBe('1\nX\n4')
  })

  it('inserts when end-line === start-line - 1', async () => {
    const files = { 'a.txt': enc('1\n2\n3') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 1,
      content: 'X',
      'start-anchor': '2',
      'end-anchor': '1',
    })
    expect(decode(files)).toBe('1\nX\n2\n3')
  })

  it('inserts at the head (only start-anchor)', async () => {
    const files = { 'a.txt': enc('1\n2\n3') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 1,
      'end-line': 0,
      content: 'HEAD',
      'start-anchor': '1',
    })
    expect(decode(files)).toBe('HEAD\n1\n2\n3')
  })

  it('appends at the tail (only end-anchor)', async () => {
    const files = { 'a.txt': enc('1\n2\n3') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 4,
      'end-line': 3,
      content: 'TAIL',
      'end-anchor': '3',
    })
    expect(decode(files)).toBe('1\n2\n3\nTAIL')
  })

  it('inserts into an empty file (no anchors)', async () => {
    const files: Record<string, Uint8Array> = {}
    const ctx = fileCtx(files)
    await writeFile(ctx, { path: 'a.txt', content: '' })
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 1,
      'end-line': 0,
      content: 'first',
    })
    expect(decode(files)).toBe('first')
  })

  it('rejects a start-anchor that does not match the line (no write)', async () => {
    const files = { 'a.txt': enc('alpha\nbeta\ngamma\n') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    const err = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 2,
      content: 'X',
      'start-anchor': 'WRONG',
      'end-anchor': 'beta',
    }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('retryable')
    expect(String(err)).toMatch(/anchor/i)
    expect(decode(files)).toBe('alpha\nbeta\ngamma\n') // untouched
  })

  it('rejects a missing anchor for an existing line (no write)', async () => {
    const files = { 'a.txt': enc('alpha\nbeta\n') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    const err = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 1,
      'end-line': 1,
      content: 'X',
      'end-anchor': 'alpha',
    }).catch(e => e)
    expect((err as TypedToolError).code).toBe('retryable')
    expect(decode(files)).toBe('alpha\nbeta\n')
  })

  it('tolerates whitespace/indent differences in an anchor', async () => {
    const files = { 'a.txt': enc('  indented\nplain\n') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 1,
      'end-line': 1,
      content: 'CHANGED',
      'start-anchor': 'indented',
      'end-anchor': 'indented',
    })
    expect(decode(files)).toBe('CHANGED\nplain\n')
  })

  it('rejects out-of-range line numbers instead of clamping', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n'
    const files = { 'a.txt': enc(ten) }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    const err = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 10,
      'end-line': 12,
      content: 'XXX',
      'start-anchor': 'L10',
      'end-anchor': 'L12',
    }).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
    expect(decode(files)).toBe(ten) // untouched
  })

  it('preserves the trailing newline', async () => {
    const files = { 'a.txt': enc('alpha\nbeta\ngamma\n') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 2,
      content: 'BETA',
      'start-anchor': 'beta',
      'end-anchor': 'beta',
    })
    expect(decode(files)).toBe('alpha\nBETA\ngamma\n')
  })

  it('returns a unified diff in content', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n4') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    const r = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 3,
      content: 'X',
      'start-anchor': '2',
      'end-anchor': '3',
    })
    expect(r.content).toContain('--- a/a.txt')
    expect(r.content).toContain('+++ b/a.txt')
    expect(r.content).toContain('@@ -1,4 +1,3 @@')
    expect(r.content).toContain('-2')
    expect(r.content).toContain('-3')
    expect(r.content).toContain('+X')
    expect(r.data).toMatchObject({ added: 1, removed: 2 })
  })

  it('reports no changes when the edit is a no-op', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const ctx = fileCtx(files)
    await readFile(ctx, { path: 'a.txt' })
    const r = await editFile(ctx, {
      path: 'a.txt',
      'start-line': 2,
      'end-line': 2,
      content: '2',
      'start-anchor': '2',
      'end-anchor': '2',
    })
    expect(String(r.content)).toContain('No changes')
    expect(decode(files)).toBe('1\n2\n3\n')
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
  it('deletes a file and clears its seen state', async () => {
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
