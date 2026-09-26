import { type ToolResultData, TypedToolError } from '@abc-protocol/sdk'
import type { WorkerClient } from '../client.js'
import { capLines, truncationNote } from './output.js'
import { envArg, numArg, requireArg, secondsArg, strArg } from './shared.js'
import { tr } from '../i18n.js'

export interface JobCtx {
  client: WorkerClient
  signal?: AbortSignal
  /** Session locale for result text ('' => English fallback). */
  locale?: string
}

const RUNNING = 'running'

/**
 * Slice ceiling for a long wait. The worker's JobWait now BLOCKS (no poll
 * loop) and caps at WORKER_WAIT_MAX (default 600s), so a ≤600s budget is a
 * SINGLE call; slicing only kicks in beyond the worker's cap.
 */
const SLICE_MS = 600_000

function clampInt(v: number | undefined, def: number, max: number): number {
  if (v === undefined) return def
  const n = Math.floor(v)
  if (!Number.isFinite(n) || n < 0) return def
  return Math.min(n, max)
}

/** Sleep that rejects on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TypedToolError('retryable', tr('en', 'interrupted')))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new TypedToolError('retryable', tr('en', 'interrupted')))
      },
      { once: true },
    )
  })
}

/** Wait for a job in ≤600s slices until state leaves running or the budget
 *  ends. The worker BLOCKS server-side up to timeoutMs (or its WORKER_WAIT_MAX
 *  cap), so the common ≤600s budget completes in ONE call with zero polling. */
async function waitForJob(
  client: WorkerClient,
  jobId: string,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<{ state: string; exitCode: number }> {
  const deadline = Date.now() + Math.max(0, budgetMs)
  for (;;) {
    const remaining = deadline - Date.now()
    // Floor at 1ms so a zero slice never blocks past our deadline.
    const slice = Math.max(1, Math.min(SLICE_MS, remaining))
    const res = await client.jobWait(
      { jobId, timeoutMs: slice },
      signal !== undefined ? { signal } : {},
    )
    if (res.state !== RUNNING) return { state: res.state, exitCode: res.exitCode }
    if (Date.now() >= deadline) return { state: res.state, exitCode: res.exitCode }
    // The worker's cap is below our remaining budget: retry immediately.
    await sleep(100, signal)
  }
}

/** Fetch a window of output lines and render them with a byte/line cap. */
async function renderOutput(
  client: WorkerClient,
  jobId: string,
  start: number,
  end: number,
  stream = 'all',
  locale = 'en',
): Promise<{ text: string; total: number }> {
  const res = await client.jobOutput({ jobId, start, end, stream })
  const capped = capLines(res.lines)
  let text = capped.kept.join('\n')
  if (capped.truncated) {
    text += truncationNote(capped, capped.kept.length, res.lines.length, locale)
  }
  return { text, total: res.totalLines }
}

/** `exec`: run a short command and wait up to `timeout` seconds for it. */
export async function execCommand(
  ctx: JobCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const command = requireArg(args, 'command', ctx.locale)
  const timeoutS = secondsArg(args, 5, 60)
  const workdir = strArg(args, 'workdir')
  const env = envArg(args)

  const started = await ctx.client.execute({ command, workdir, env })
  const jobId = started.jobId

  const done = await waitForJob(ctx.client, jobId, timeoutS * 1000, ctx.signal)
  if (done.state === RUNNING) {
    // Timed out: show the OLDEST 200 lines (from the start) so a long-running
    // job's early output is visible; the tail may not exist yet.
    const { text } = await renderOutput(ctx.client, jobId, 0, 200, 'all', ctx.locale)
    let content = tr(ctx.locale ?? 'en', 'execStillRunning', { jobId, timeout: timeoutS }) + '\n'
    if (text !== '') content += text + '\n'
    content += tr(ctx.locale ?? 'en', 'execUseJobOutput', { jobId })
    return { content, data: { 'job-id': jobId, state: RUNNING, backgrounded: true } }
  }

  const { text } = await renderOutput(ctx.client, jobId, 0, 0, 'all', ctx.locale)
  let content = tr(ctx.locale ?? 'en', 'commandFinished', { jobId, state: done.state, code: done.exitCode })
  if (text !== '') content += `\n${text}`
  return {
    content,
    data: { 'job-id': jobId, state: done.state, exit_code: done.exitCode, backgrounded: false },
  }
}

/** `job-start`: fire-and-forget; returns the job id only. No wall-clock
 *  deadline is armed — a long job is stopped explicitly with `job-kill`. */
export async function jobStart(
  ctx: JobCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const command = requireArg(args, 'command', ctx.locale)
  const workdir = strArg(args, 'workdir')
  const env = envArg(args)
  const started = await ctx.client.execute({ command, workdir, env })
  return {
    content: tr(ctx.locale ?? 'en', 'startedJob', { jobId: started.jobId }),
    data: { 'job-id': started.jobId },
  }
}

/** `job-output`: paged output with a display cap (1000 lines / 120 KiB). */
export async function jobOutput(
  ctx: JobCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const jobId = requireArg(args, 'job-id', ctx.locale)
  const offset = Math.trunc(numArg(args, 'offset') ?? 0)
  const limit = clampInt(numArg(args, 'limit'), 200, 1000)
  const stream = strArg(args, 'stream') || 'all'
  const res = await ctx.client.jobOutput({
    jobId,
    start: offset,
    end: offset < 0 ? 0 : offset + limit,
    stream,
  })
  const capped = capLines(res.lines, limit)
  let content = capped.kept.join('\n')
  if (capped.truncated) {
    content += truncationNote(capped, capped.kept.length, res.totalLines, ctx.locale)
  }
  const from = res.startLine
  const to = res.endLine
  return {
    content,
    data: {
      'job-id': jobId,
      total_lines: res.totalLines,
      start_line: from,
      end_line: to,
      done: res.done,
    },
  }
}

/** `job-wait`: wait up to `timeout` seconds; return the latest 200 lines. */
export async function jobWait(
  ctx: JobCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const jobId = requireArg(args, 'job-id', ctx.locale)
  const timeoutS = secondsArg(args, 60, 600)
  const done = await waitForJob(ctx.client, jobId, timeoutS * 1000, ctx.signal)
  const { text } = await renderOutput(ctx.client, jobId, -200, 0, 'all', ctx.locale)
  if (done.state === RUNNING) {
    let content = tr(ctx.locale ?? 'en', 'jobStillRunning', { jobId, timeout: timeoutS })
    if (text !== '') content += `\n${text}`
    return { content, data: { 'job-id': jobId, state: RUNNING } }
  }
  let content = tr(ctx.locale ?? 'en', 'jobFinished', { jobId, state: done.state, code: done.exitCode })
  if (text !== '') content += `\n${text}`
  return {
    content,
    data: { 'job-id': jobId, state: done.state, exit_code: done.exitCode },
  }
}

/** `job-kill`: terminate a job's process tree. */
export async function jobKill(
  ctx: JobCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const jobId = requireArg(args, 'job-id', ctx.locale)
  await ctx.client.jobKill({ jobId })
  return { content: tr(ctx.locale ?? 'en', 'killedJob', { jobId }) }
}

/** `job-stdin`: write to a job's stdin (optionally close it). */
export async function jobStdin(
  ctx: JobCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const jobId = requireArg(args, 'job-id', ctx.locale)
  const data = strArg(args, 'data')
  const close = args['close'] === true
  await ctx.client.jobStdin({
    jobId,
    data: new TextEncoder().encode(data),
    close,
  })
  return {
    content: tr(ctx.locale ?? 'en', close ? 'wroteStdinClosed' : 'wroteStdin', {
      n: data.length,
      jobId,
    }),
  }
}

/** `job-list`: list jobs registered in the worker.
 *
 * Running jobs come FIRST, then the rest newest-first. `command` is collapsed
 * to a single truncated line in the TEXT (a heredoc command would otherwise
 * explode into many physical lines); `data.jobs` keeps the full command for the
 * pretty card. */
export async function jobList(
  ctx: JobCtx,
  args: Record<string, unknown> = {},
): Promise<ToolResultData> {
  const limit = clampInt(numArg(args, 'limit'), 50, 500)
  const res = await ctx.client.listJobs({ limit })
  if (res.jobs.length === 0) {
    return { content: tr(ctx.locale ?? 'en', 'noJobs'), data: { count: 0, jobs: [] } }
  }
  // Running first, then newest-first by start time.
  const jobs = [...res.jobs].sort((a, b) => {
    const ar = a.state === RUNNING ? 0 : 1
    const br = b.state === RUNNING ? 0 : 1
    if (ar !== br) return ar - br
    return a.startedAt > b.startedAt ? -1 : a.startedAt < b.startedAt ? 1 : 0
  })
  const lines = jobs.map(
    j =>
      `${j.id}  ${j.state}${j.exitCode ? ` (exit ${j.exitCode})` : ''}  ${oneLine(j.command)}`,
  )
  const capped = capLines(lines)
  let content = capped.kept.join('\n')
  if (capped.truncated) content += truncationNote(capped, capped.kept.length, lines.length, ctx.locale)
  // Structured rows so the client can render a proper LIST (id / state / exit /
  // command) instead of a terminal transcript. The FULL command is preserved
  // here (only the text above collapses it).
  return {
    content,
    data: {
      count: jobs.length,
      jobs: jobs.map(j => ({
        id: j.id,
        state: j.state,
        exit_code: j.exitCode,
        command: j.command,
      })),
    },
  }
}

/** Collapse a (possibly multi-line) command to ONE truncated line for text. */
function oneLine(command: string, max = 200): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
