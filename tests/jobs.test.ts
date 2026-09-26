import { describe, expect, it } from 'vitest'
import type { WorkerClient } from '../src/client.js'
import {
  execCommand,
  jobList,
  jobOutput,
  jobWait,
  type JobCtx,
} from '../src/tools/jobs.js'

interface FakeJob {
  state: string
  exitCode: number
  lines: string[]
}

/**
 * Fake worker whose `jobWait` behaviour is scripted:
 * - `waitStates` is consumed one entry per JobWait call (last repeats).
 */
function fakeClient(job: FakeJob, waitStates: string[]): WorkerClient {
  let i = 0
  return {
    execute: async () => ({ jobId: 'j1' }),
    jobWait: async () => {
      const state = waitStates[Math.min(i, waitStates.length - 1)] ?? job.state
      i++
      return { state, exitCode: job.exitCode }
    },
    jobOutput: async (req: {
      start: number
      end: number
    }) => {
      const total = job.lines.length
      let s = req.start < 0 ? Math.max(0, total + req.start) : req.start
      let e = req.end <= 0 ? total : Math.min(req.end, total)
      if (e < s) e = s
      return {
        lines: job.lines.slice(s, e),
        totalLines: total,
        startLine: s,
        endLine: e,
        done: job.state !== 'running',
      }
    },
    jobKill: async () => ({ ok: true }),
    jobStdin: async () => ({ ok: true }),
    listJobs: async () => ({ jobs: [] }),
  } as unknown as WorkerClient
}

const ctx = (client: WorkerClient): JobCtx => ({ client })

describe('exec', () => {
  it('returns completion output and a job id', async () => {
    const job: FakeJob = {
      state: 'done',
      exitCode: 0,
      lines: ['hello', 'world'],
    }
    const r = await execCommand(ctx(fakeClient(job, ['done'])), {
      command: 'echo hi',
    })
    expect(r.content).toContain('exit 0')
    expect(r.content).toContain('hello')
    expect(r.data).toMatchObject({ 'job-id': 'j1', state: 'done', exit_code: 0 })
  })

  it('on timeout returns the OLDEST 200 lines and a running note', async () => {
    // 300 lines; the timed-out path reads [0, 200) (oldest), not the tail.
    const lines = Array.from({ length: 300 }, (_, i) => `l${i}`)
    const job: FakeJob = { state: 'running', exitCode: 0, lines }
    const r = await execCommand(ctx(fakeClient(job, ['running'])), {
      command: 'sleep 100',
      timeout: 1,
    })
    expect(r.content).toContain('still running')
    expect(r.content).toContain('l0')
    expect(r.content).not.toContain('l250')
    expect(r.data).toMatchObject({ 'job-id': 'j1', backgrounded: true })
  })
})

describe('job-wait', () => {
  it('returns the latest 200 lines on completion', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `l${i}`)
    const job: FakeJob = { state: 'done', exitCode: 1, lines }
    const r = await jobWait(ctx(fakeClient(job, ['done'])), {
      'job-id': 'j1',
      timeout: 1,
    })
    expect(r.content).toContain('exit 1')
    expect(r.content).toContain('l299')
    expect(r.content).not.toContain('l0\n')
  })

  it('reports still-running on timeout', async () => {
    const job: FakeJob = { state: 'running', exitCode: 0, lines: ['a'] }
    const r = await jobWait(ctx(fakeClient(job, ['running'])), {
      'job-id': 'j1',
      timeout: 1,
    })
    expect(r.content).toContain('still running')
    expect(r.data).toMatchObject({ state: 'running' })
  })
})

describe('job-output', () => {
  it('returns a line window with paging metadata', async () => {
    const job: FakeJob = {
      state: 'done',
      exitCode: 0,
      lines: ['a', 'b', 'c', 'd'],
    }
    const r = await jobOutput(ctx(fakeClient(job, ['done'])), {
      'job-id': 'j1',
      offset: 1,
      limit: 2,
    })
    expect(r.content).toBe('b\nc')
    expect(r.data).toMatchObject({ start_line: 1, end_line: 3, total_lines: 4 })
  })
})

describe('job-list', () => {
  const entry = (id: string, state: string, startedAt: number, command = `echo ${id}`) => ({
    id,
    state,
    exitCode: 0,
    startedAt: BigInt(startedAt),
    finishedAt: 0n,
    command,
  })

  function listCtx(jobs: ReturnType<typeof entry>[]) {
    let gotLimit = -1
    const client = {
      listJobs: async (req: { limit: number }) => {
        gotLimit = req.limit
        return { jobs }
      },
    } as unknown as WorkerClient
    return { c: { client } as JobCtx, limit: () => gotLimit }
  }

  it('defaults limit to 50 and passes it to the worker', async () => {
    const { c, limit } = listCtx([])
    await jobList(c, {})
    expect(limit()).toBe(50)
  })

  it('caps limit at 500', async () => {
    const { c, limit } = listCtx([])
    await jobList(c, { limit: 9999 })
    expect(limit()).toBe(500)
  })

  it('orders RUNNING first, then newest-first', async () => {
    const { c } = listCtx([
      entry('done-new', 'done', 300),
      entry('running-old', 'running', 100),
      entry('done-old', 'done', 200),
    ])
    const r = await jobList(c, {})
    const ids = (r.data as { jobs: Array<{ id: string }> }).jobs.map(j => j.id)
    expect(ids).toEqual(['running-old', 'done-new', 'done-old'])
  })

  it('collapses a multi-line command to ONE truncated line in the text, keeping it full in data', async () => {
    const multiline = `echo "=== a ==="\npgrep -af x\necho "=== b ==="\n${'z'.repeat(300)}`
    const { c } = listCtx([entry('j1', 'done', 1, multiline)])
    const r = await jobList(c, {})
    const text = String(r.content)
    expect(text.split('\n')).toHaveLength(1) // one physical line per job
    expect(text).toContain('j1')
    expect(text).toContain('…')
    // data keeps the FULL command
    const job = (r.data as { jobs: Array<{ command: string }> }).jobs[0]!
    expect(job.command).toBe(multiline)
  })
})
