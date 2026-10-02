import {
  numArg,
  strArg,
  type ToolResultData,
  TypedToolError,
} from '@abc-protocol/sdk'
import type { WorkspaceDeps } from '../deps.js'
import { tr } from '../i18n.js'
import type { SandboxTarget } from './target.js'

/** Everything a computer tool handler needs at call time. */
export interface ToolCtx {
  deps: WorkspaceDeps
  locale: string
  tenant: string
  session: string
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------
export async function apps(
  ctx: ToolCtx,
  t: SandboxTarget,
): Promise<ToolResultData> {
  const list = await t.platform.apps()
  if (list.length === 0) {
    return { content: tr(ctx.locale, 'noApps'), data: { apps: [] } }
  }
  const lines = list.map(a => {
    const pid = a.pid === '' ? '-' : a.pid
    return `${pid}\t${a.name}${a.focused ? '\tfocused' : ''}`
  })
  return {
    content: lines.join('\n'),
    data: { apps: list },
  }
}

export async function snapshot(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const app = strArg(args, 'app')
  const depth = numArg(args, 'depth') ?? 0
  const text = await t.platform.snapshot(app, Math.floor(depth))
  if (text.trim() === '') {
    return { content: tr(ctx.locale, 'noApps') }
  }
  return {
    content: text,
    data: { sandbox: t.sandbox, platform: t.platform.id },
  }
}

export async function find(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const selector = strArg(args, 'selector')
  if (selector === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'selector' }))
  }
  const app = strArg(args, 'app')
  const output = strArg(args, 'output')
  const text = await t.platform.find(selector, app, output)
  if (text.trim() === '') {
    return {
      content: `${tr(ctx.locale, 'noMatches', { selector })}\n${tr(ctx.locale, 'findByRefHint')}`,
      data: { selector, count: 0 },
    }
  }
  return { content: text, data: { selector } }
}

// ---------------------------------------------------------------------------
// interact
// ---------------------------------------------------------------------------
export async function action(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const act = strArg(args, 'action')
  const target = strArg(args, 'target')
  if (act === '' || target === '') {
    throw new TypedToolError(
      'invalid_argument',
      tr(ctx.locale, 'argRequired', { key: act === '' ? 'action' : 'target' }),
    )
  }
  const value = strArg(args, 'value')
  const app = strArg(args, 'app')
  await t.platform.action(act, target, value, app)
  return { content: tr(ctx.locale, 'actionDone', { action: act, target }) }
}

export async function click(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const x = numArg(args, 'x')
  const y = numArg(args, 'y')
  if (x === undefined || y === undefined) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'x/y' }))
  }
  const button = strArg(args, 'button')
  const count = Math.floor(numArg(args, 'count') ?? 1)
  await t.platform.click(x, y, button, count)
  return {
    content: tr(ctx.locale, 'clickedAt', {
      x: Math.round(x),
      y: Math.round(y),
    }),
  }
}

export async function typeText(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const text = strArg(args, 'text')
  if (text === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'text' }))
  }
  const target = strArg(args, 'target')
  const submit = args['submit'] === true
  await t.platform.typeText(text, target)
  if (submit) await t.platform.key('Return', [])
  return { content: tr(ctx.locale, 'typedText', { count: text.length }) }
}

export async function key(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const k = strArg(args, 'key')
  if (k === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'key' }))
  const held = Array.isArray(args['held'])
    ? (args['held'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      )
    : []
  await t.platform.key(k, held)
  return { content: tr(ctx.locale, 'pressedKey', { key: k }) }
}

export async function scroll(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const x = numArg(args, 'x')
  const y = numArg(args, 'y')
  if (x === undefined || y === undefined) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'x/y' }))
  }
  const dx = Math.floor(numArg(args, 'dx') ?? 0)
  const dy = Math.floor(numArg(args, 'dy') ?? 0)
  await t.platform.scroll(x, y, dx, dy)
  return {
    content: tr(ctx.locale, 'scrolled', {
      x: Math.round(x),
      y: Math.round(y),
      dx,
      dy,
    }),
  }
}

export async function drag(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const fromX = numArg(args, 'from_x')
  const fromY = numArg(args, 'from_y')
  const toX = numArg(args, 'to_x')
  const toY = numArg(args, 'to_y')
  if (
    fromX === undefined ||
    fromY === undefined ||
    toX === undefined ||
    toY === undefined
  ) {
    throw new TypedToolError(
      'invalid_argument',
      tr(ctx.locale, 'argRequired', { key: 'from_x/from_y/to_x/to_y' }),
    )
  }
  const durationMs = Math.floor(numArg(args, 'duration_ms') ?? 0)
  await t.platform.drag(fromX, fromY, toX, toY, durationMs)
  return {
    content: tr(ctx.locale, 'dragged', {
      fromX: Math.round(fromX),
      fromY: Math.round(fromY),
      toX: Math.round(toX),
      toY: Math.round(toY),
    }),
  }
}

// ---------------------------------------------------------------------------
// visual
// ---------------------------------------------------------------------------
export async function screenshot(
  ctx: ToolCtx,
  t: SandboxTarget,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const region = strArg(args, 'region')
  const shot = await t.platform.screenshot(region)

  // Read the PNG bytes back through the worker (absolute path, whole file).
  const read = await t.client.fileRead({ path: shot.path })
  if (read.content.length === 0) {
    throw new TypedToolError(
      'retryable',
      tr(ctx.locale, 'screenshotFailed', { reason: 'empty file' }),
    )
  }
  const name = `screenshot-${Date.now()}.png`
  const stored = await ctx.deps.ingestFile({
    name,
    data: read.content,
    session: ctx.session,
    tenant: ctx.tenant,
  })
  // The webui renders produced files from `data.files` (the unified key), with
  // one `{ code, mime, name, size, width, height }` entry per file — the same
  // shape the built-in media tools use.
  return {
    content: tr(ctx.locale, 'screenshotStored', {
      code: stored.code,
      width: shot.width,
      height: shot.height,
    }),
    data: {
      files: [
        {
          code: stored.code,
          mime: stored.mime || 'image/png',
          name,
          size: read.content.length,
          width: shot.width,
          height: shot.height,
        },
      ],
      width: shot.width,
      height: shot.height,
    },
  }
}
