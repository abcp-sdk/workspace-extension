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
  /** The worker user's home dir (where `~` resolves); may be ''. */
  home: string
  bootId: string
  /**
   * What the sandbox IMAGE can do (probed by the worker at request time). A
   * missing/empty value means "not detected", not "impossible". Lets a caller
   * (and the model) know whether the GUI / computer-use tools can drive this
   * sandbox WITHOUT knowing the image ahead of time.
   */
  capabilities?: {
    desktop: boolean
    display: string
    novnc: boolean
    novncPort: number
    xa11y: boolean
    distro: string
  } | undefined
}

/** Render the sandbox's probed capabilities as one short line ('' when none). */
function renderCapabilities(locale: string, caps: WorkerInfo['capabilities']): string {
  if (caps === undefined) return ''
  const parts: string[] = []
  if (caps.desktop) {
    parts.push(tr(locale, 'infoCapsDesktop', { display: caps.display || '?' }))
  }
  if (caps.novnc) {
    parts.push(tr(locale, 'infoCapsNovnc', { port: caps.novncPort }))
  }
  if (caps.xa11y) parts.push(tr(locale, 'infoCapsA11y'))
  if (caps.distro !== '') parts.push(tr(locale, 'infoCapsDistro', { distro: caps.distro }))
  const body = parts.length > 0 ? parts.join(', ') : tr(locale, 'infoCapsNone')
  return tr(locale, 'infoCapabilities', { caps: body })
}

/** Render a worker's InfoResponse + its svc domain (shared by info + create). */
export function renderInfo(
  locale: string,
  info: WorkerInfo,
  domain: string,
): { text: string; data: Record<string, unknown> } {
  const home = info.home ?? ''
  const homeLine = home !== '' ? `\n${tr(locale, 'infoHome', { path: home })}` : ''
  const capsLine = renderCapabilities(locale, info.capabilities)
  const capsText = capsLine !== '' ? `\n${capsLine}` : ''
  const text =
    tr(locale, 'infoHeader', { os: info.os, arch: info.arch, shell: info.shell }) +
    '\n' +
    tr(locale, 'infoWorkspace', { path: info.workspace }) +
    homeLine +
    '\n' +
    tr(locale, 'infoService', { url: domain }) +
    '\n' +
    tr(locale, 'infoBoot', { id: info.bootId }) +
    capsText
  return {
    text,
    data: {
      os: info.os, arch: info.arch, shell: info.shell, workspace: info.workspace,
      home, url: domain, boot_id: info.bootId,
      ...(info.capabilities !== undefined ? { capabilities: info.capabilities } : {}),
    },
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
      // os: linux (default) | windows | macos; for windows/macos the gateway
      // picks the VM image, forces kvm + 8Gi and injects GOLDEN_DISK_URL.
      // `disk` (golden-disk URL) overrides the per-OS default; ignored on linux.
      os: strArg(args, 'os'),
      disk: strArg(args, 'disk'),
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
    // A name is never reused: the gateway refuses an existing sandbox with
    // `already_exists`. Surface that distinctly (not as a fake timeout).
    if (String(e).includes('[already_exists]')) {
      throw new TypedToolError('invalid_argument', tr(ctx.locale, 'sandboxExists', { name }))
    }
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
  const lines = workers.map(w => {
    const diag = w.message
      ? `  restarts=${w.restarts} reason: ${w.message}`
      : w.restarts > 0
        ? `  restarts=${w.restarts}`
        : ''
    return `${w.name}  [${w.phase}${w.ready ? ', ready' : ''}]  ${w.image}  ${w.url}  ${short(w.createdAt)}  by ${w.creator || '-'}${diag}`
  })
  const capped = capLines(lines)
  let content = capped.kept.join('\n')
  if (capped.truncated) content += truncationNote(capped, capped.kept.length, lines.length, ctx.locale)
  return {
    content,
    data: {
      count: workers.length,
      sandboxes: workers.map(w => ({
        name: w.name,
        phase: w.phase,
        image: w.image,
        url: w.url,
        creator: w.creator,
        session: w.session,
        restarts: w.restarts,
        message: w.message,
      })),
    },
  }
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
    const diag = w.message ? `\n${tr(ctx.locale, 'sandboxDiag', { restarts: w.restarts, message: w.message })}` : ''
    return {
      content: tr(ctx.locale, 'sandboxStatus', {
        name: w.name, phase: w.phase, ready: w.ready ? ', ready' : '', image: w.image, url: w.url,
      }) + diag,
      data: {
        name: w.name, phase: w.phase, ready: w.ready, image: w.image, url: w.url,
        creator: w.creator, created_at: Number(w.createdAt),
        restarts: w.restarts, message: w.message,
      },
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
