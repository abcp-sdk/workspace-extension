import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { WorkerClient, GatewayClient } from '../client.js'
import { tr } from '../i18n.js'
import { capLines, truncationNote } from './output.js'
import { domainOf, numArg, strArg } from './shared.js'

/** Context for the sandbox lifecycle tools (workspace gateway). */
export interface SandboxCtx {
  workspace: GatewayClient
  locale: string
  /** The calling session (bound to the created sandbox). */
  session?: string
  /** Resolve a sandbox name to a live worker client + its endpoint url. */
  resolveWorker?: (name: string) => Promise<{ client: WorkerClient; url: string }>
  /**
   * After a successful create, materialize the session's branch into the new
   * sandbox. Returns a human note appended to the result ('' when nothing was
   * checked out — a free session, an empty repo, or a failure).
   */
  autoCheckout?: (sandbox: string) => Promise<string>
}

function short(ms: bigint): string {
  if (ms === 0n) return '-'
  return new Date(Number(ms)).toISOString()
}

/** Worker InfoResponse fields the info output exposes. */
export interface WorkerInfo {
  os: string
  arch: string
  shell: string
  workspace: string
  bootId: string
}

/** Render a worker's InfoResponse + its svc domain (shared by info + create). */
export function renderInfo(
  locale: string,
  info: WorkerInfo,
  domain: string,
): { text: string; data: Record<string, unknown> } {
  const text =
    tr(locale, 'infoHeader', { os: info.os, arch: info.arch, shell: info.shell }) +
    '\n' +
    tr(locale, 'infoWorkspace', { path: info.workspace }) +
    '\n' +
    tr(locale, 'infoService', { url: domain }) +
    '\n' +
    tr(locale, 'infoBoot', { id: info.bootId })
  return {
    text,
    data: { os: info.os, arch: info.arch, shell: info.shell, workspace: info.workspace, url: domain, boot_id: info.bootId },
  }
}

/** `list-oci-images`: browse OCI images (owner, optional name -> tags). */
export async function listOCIImages(
  ctx: SandboxCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const res = await ctx.workspace.listOCIImages({
    owner: strArg(args, 'owner'),
    name: strArg(args, 'name'),
  })
  const images = res.images
  if (images.length === 0) return { content: tr(ctx.locale, 'ociImageNone') }
  const lines = images.map(i => i.ref)
  return {
    content: tr(ctx.locale, 'ociImageHeader', { count: images.length }) + '\n' + lines.join('\n'),
    data: { images: images.map(i => ({ owner: i.owner, name: i.name, tag: i.tag, ref: i.ref })) },
  }
}

/** `sandbox-create`: create a worker sandbox and wait up to 60s for readiness. */
export async function sandboxCreate(
  ctx: SandboxCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  const image = strArg(args, 'image')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))

  const env = args['env']
  const envMap: Record<string, string> = {}
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === 'string') envMap[k] = v
    }
  }

  try {
    const res = await ctx.workspace.createSandbox({
      name,
      image,
      cpu: strArg(args, 'cpu'),
      memory: strArg(args, 'memory'),
      env: envMap,
      kvm: args['kvm'] === true,
      gpuCount: Math.trunc(numArg(args, 'gpu-count') ?? 0),
      session: ctx.session ?? '',
    })
    const w = res.sandbox
    if (w === undefined) {
      throw new TypedToolError('internal', tr(ctx.locale, 'sandboxNotFound', { name, err: 'no sandbox in response' }))
    }
    const domain = domainOf(w.url)
    let content = tr(ctx.locale, 'sandboxCreated', { name: w.name, url: domain, image: w.image })
    const data: Record<string, unknown> = { name: w.name, url: domain, image: w.image, phase: w.phase, ready: w.ready }
    // The sandbox is ready (CreateSandbox waited); append the worker's own info
    // (os/arch/workspace/boot id + svc domain). Best-effort: a failure here must
    // not fail a successful create.
    if (ctx.resolveWorker !== undefined) {
      try {
        const { client, url } = await ctx.resolveWorker(w.name)
        const info = await client.info({})
        const rendered = renderInfo(ctx.locale, info, domainOf(url))
        content += '\n' + rendered.text
        Object.assign(data, rendered.data)
      } catch {
        // ignore: creation succeeded
      }
    }
    // Materialize the session's branch into the fresh sandbox. Best-effort.
    if (ctx.autoCheckout !== undefined) {
      try {
        const note = await ctx.autoCheckout(w.name)
        if (note !== '') content += '\n' + note
      } catch {
        // ignore: creation succeeded
      }
    }
    return { content, data }
  } catch (e) {
    // The gateway returns DeadlineExceeded when the worker did not become
    // healthy within 60s; the sandbox is left in place.
    throw new TypedToolError('retryable', tr(ctx.locale, 'sandboxCreateTimeout', { name, err: String(e) }))
  }
}

/** `sandbox-list`: list managed sandboxes. */
export async function sandboxList(
  ctx: SandboxCtx,
  _args: Record<string, unknown>,
): Promise<ToolResultData> {
  const res = await ctx.workspace.listSandboxes({})
  const workers = res.sandboxes
  if (workers.length === 0) return { content: tr(ctx.locale, 'sandboxNone') }
  const lines = workers.map(
    w => `${w.name}  [${w.phase}${w.ready ? ', ready' : ''}]  ${w.image}  ${w.url}  ${short(w.createdAt)}  by ${w.creator || '-'}`,
  )
  const capped = capLines(lines)
  let content = capped.kept.join('\n')
  if (capped.truncated) content += truncationNote(capped, capped.kept.length, lines.length, ctx.locale)
  return { content, data: { count: workers.length } }
}

/** `sandbox-status`: one sandbox's live state. */
export async function sandboxStatus(
  ctx: SandboxCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'worker-name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'worker-name' }))
  try {
    const res = await ctx.workspace.getSandbox({ name })
    const w = res.sandbox
    if (w === undefined) {
      throw new TypedToolError('not_found', tr(ctx.locale, 'sandboxNotFound', { name, err: 'no sandbox in response' }))
    }
    return {
      content: tr(ctx.locale, 'sandboxStatus', {
        name: w.name, phase: w.phase, ready: w.ready ? ', ready' : '', image: w.image, url: w.url,
      }),
      data: { name: w.name, phase: w.phase, ready: w.ready, image: w.image, url: w.url, creator: w.creator, created_at: Number(w.createdAt) },
    }
  } catch (e) {
    throw new TypedToolError('not_found', tr(ctx.locale, 'sandboxNotFound', { name, err: String(e) }))
  }
}

/** `sandbox-delete`: delete a sandbox (pod + service + secret). */
export async function sandboxDelete(
  ctx: SandboxCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'worker-name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'worker-name' }))
  const res = await ctx.workspace.deleteSandbox({ name })
  return {
    content: res.ok
      ? tr(ctx.locale, 'sandboxDeleted', { name })
      : tr(ctx.locale, 'sandboxNotFound', { name, err: 'not found' }),
    data: { name, deleted: res.ok },
  }
}
