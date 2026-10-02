import type { WorkerClient } from '../client.js'

/** Result of one sandbox command. */
export interface ExecResult {
  state: string
  exitCode: number
  lines: string[]
  totalLines: number
  /** Joined stdout+stderr text. */
  stdout: string
}

const RUNNING = 'running'

/**
 * A settled job is any state other than `running`. The worker uses
 * `running|done|killed|failed`; `done` is the success case, `failed` a non-zero
 * exit.
 */
export function isSettled(state: string): boolean {
  return state !== RUNNING
}

/** True when the job finished successfully (`done`). */
export function isSuccess(state: string): boolean {
  return state === 'done'
}
/** The worker's JobWait blocks up to its own cap; slice long budgets. */
const SLICE_MS = 600_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run a command in the sandbox and wait up to `timeoutMs` for it. Returns the
 * captured output lines and exit code; a still-running job returns state
 * `running` with whatever output exists.
 */
export async function run(
  client: WorkerClient,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const started = await client.execute({ command, workdir: '', env: {} })
  const jobId = started.jobId
  const budgetMs = opts.timeoutMs ?? 30_000
  const deadline = Date.now() + Math.max(0, budgetMs)

  let state = RUNNING
  let exitCode = 0
  for (;;) {
    const remaining = deadline - Date.now()
    const slice = Math.max(1, Math.min(SLICE_MS, remaining))
    const res = await client.jobWait(
      { jobId, timeoutMs: slice },
      opts.signal !== undefined ? { signal: opts.signal } : {},
    )
    state = res.state
    exitCode = res.exitCode
    if (state !== RUNNING || Date.now() >= deadline) break
    await sleep(100)
  }

  // Read all output (0..total) once the job settles; on timeout read what exists.
  const out = await client.jobOutput({
    jobId,
    start: 0,
    end: 0,
    stream: 'all',
  })
  return {
    state,
    exitCode,
    lines: out.lines,
    totalLines: out.totalLines,
    stdout: out.lines.join('\n'),
  }
}

/**
 * Run a command expected to succeed; throw with stderr on a non-zero exit.
 * `running` (timeout) is treated as failure for the small, fast commands the
 * computer-use tools issue.
 */
export async function runChecked(
  client: WorkerClient,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const res = await run(client, command, opts)
  if (res.state === RUNNING) {
    throw new Error(
      `command timed out: ${command}\n${res.stdout.slice(0, 500)}`,
    )
  }
  return res
}

/** POSIX single-quote a string for safe interpolation into a shell command. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
