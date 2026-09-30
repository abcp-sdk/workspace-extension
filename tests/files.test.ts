import { describe, expect, it } from 'vitest'
import { TypedToolError } from '@abc-protocol/sdk'
import {
  expandTilde,
  looksTextual,
  numberLines,
  splitLines,
  windowLines,
} from '../src/tools/text.js'
import {
  downloadFile,
  patchFile,
  readFile,
  uploadFile,
  type FileCtx,
} from '../src/tools/files.js'
import { applyChunks, findContext, parsePatch } from '../src/tools/patch.js'
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
    // `workerAnchors` calls info() to expand a leading `~`; provide a stub so
    // paths without `~` are returned unchanged.
    info: async () => ({ home: '/root', workspace: '/root/workspace' }),
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

describe('patch (parse + apply)', () => {
  it('parses add/update/delete sections', () => {
    const hunks = parsePatch(`*** Begin Patch
*** Add File: a.txt
+hello
+world
*** Update File: b.txt
@@
-old
+new
*** Delete File: c.txt
*** End Patch`)
    expect(hunks).toHaveLength(3)
    expect(hunks[0]).toMatchObject({ type: 'add', path: 'a.txt', contents: 'hello\nworld\n' })
    expect(hunks[1]).toMatchObject({ type: 'update', path: 'b.txt' })
    expect(hunks[2]).toMatchObject({ type: 'delete', path: 'c.txt' })
  })

  it('rejects a patch without Begin/End markers', () => {
    expect(() => parsePatch('*** Update File: a\n@@\n-a\n+b')).toThrow(/Begin/)
  })

  it('rejects an update with no hunks', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Update File: a.txt\n*** End Patch')).toThrow(/at least one/)
  })

  it('finds context with the trim fallback', () => {
    expect(findContext(['alpha', 'beta', 'gamma'], ['beta'], 0)).toBe(1)
    expect(findContext(['  alpha  ', 'beta'], ['alpha'], 0)).toBe(0)
    expect(findContext(['x'], ['nope'], 0)).toBe(-1)
  })

  it('applies chunks in order', () => {
    const out = applyChunks('a.txt', ['1', '2', '3', '4'], [
      { oldLines: ['2', '3'], newLines: ['X'] },
    ])
    expect(out).toEqual(['1', 'X', '4'])
  })

  it('throws when old lines do not match', () => {
    expect(() => applyChunks('a.txt', ['1', '2'], [{ oldLines: ['NOPE'], newLines: ['X'] }])).toThrow(/Failed to find/)
  })
})

describe('patch tool', () => {
  const decode = (f: Record<string, Uint8Array>, p = 'a.txt') =>
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(f[p])

  it('adds a new file', async () => {
    const files: Record<string, Uint8Array> = {}
    const r = await patchFile(fileCtx(files), {
      'patch-text': '*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch',
    })
    expect(decode(files)).toBe('one\ntwo\n')
    expect(r.data).toMatchObject({ files: 1, added: 2, removed: 0 })
  })

  it('updates an existing file and preserves trailing newline', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    await patchFile(fileCtx(files), {
      'patch-text': '*** Begin Patch\n*** Update File: a.txt\n@@\n-2\n+X\n*** End Patch',
    })
    expect(decode(files)).toBe('1\nX\n3\n')
  })

  it('preserves CRLF and BOM across an update', async () => {
    const files = { 'a.txt': enc('\uFEFFalpha\r\nbeta\r\n') }
    await patchFile(fileCtx(files), {
      'patch-text': '*** Begin Patch\n*** Update File: a.txt\n@@\n-beta\n+gamma\n*** End Patch',
    })
    expect(decode(files)).toBe('\uFEFFalpha\r\ngamma\r\n')
  })

  it('deletes a file', async () => {
    const files = { 'a.txt': enc('x\n') }
    const r = await patchFile(fileCtx(files), {
      'patch-text': '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch',
    })
    expect(files['a.txt']).toBeUndefined()
    expect(r.data).toMatchObject({ files: 1, removed: 1 })
  })

  it('applies multiple files atomically', async () => {
    const files: Record<string, Uint8Array> = { 'b.txt': enc('old\n') }
    await patchFile(fileCtx(files), {
      'patch-text': `*** Begin Patch
*** Add File: a.txt
+new
*** Update File: b.txt
@@
-old
+updated
*** End Patch`,
    })
    expect(decode(files, 'a.txt')).toBe('new\n')
    expect(decode(files, 'b.txt')).toBe('updated\n')
  })

  it('rejects the whole patch (no writes) when a hunk fails', async () => {
    const files = { 'b.txt': enc('old\n') }
    const err = await patchFile(fileCtx(files), {
      'patch-text': `*** Begin Patch
*** Add File: a.txt
+new
*** Update File: b.txt
@@
-DOESNOTEXIST
+updated
*** End Patch`,
    }).catch(e => e)
    expect((err as TypedToolError).code).toBe('retryable')
    // Nothing was written: a.txt must NOT exist and b.txt is unchanged.
    expect(files['a.txt']).toBeUndefined()
    expect(decode(files, 'b.txt')).toBe('old\n')
  })

  it('rejects a move', async () => {
    const files = { 'a.txt': enc('x\n') }
    const err = await patchFile(fileCtx(files), {
      'patch-text': '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch',
    }).catch(e => e)
    expect((err as TypedToolError).code).toBe('invalid_argument')
    expect(decode(files)).toBe('x\n')
  })

  it('requires patch-text', async () => {
    const err = await patchFile(fileCtx({}), {}).catch(e => e)
    expect(err).toBeInstanceOf(TypedToolError)
    expect((err as TypedToolError).code).toBe('invalid_argument')
  })

  it('returns a unified diff', async () => {
    const files = { 'a.txt': enc('1\n2\n3\n') }
    const r = await patchFile(fileCtx(files), {
      'patch-text': '*** Begin Patch\n*** Update File: a.txt\n@@\n-2\n+X\n*** End Patch',
    })
    expect(r.content).toContain('--- a/a.txt')
    expect(r.content).toContain('+X')
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
