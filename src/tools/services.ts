import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import { tr } from '../i18n.js'
import { numArg, strArg } from './shared.js'

/** Context for the service-* tools (workspace gateway). */
export interface ServiceCtx {
  workspace: GatewayClient
  session: string
  locale: string
}

/** `service-deploy`: run an image as a long-lived Deployment + Service. */
export async function serviceDeploy(
  ctx: ServiceCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const image = strArg(args, 'image')
  if (image === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'image' }))
  }
  const env = args['env']
  const envMap: Record<string, string> = {}
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === 'string') envMap[k] = v
    }
  }
  const command = args['command']
  const commandList = Array.isArray(command) ? command.filter((c): c is string => typeof c === 'string') : []
  try {
    const res = await ctx.workspace.deployService(
      {
        name: strArg(args, 'name'),
        image,
        containerPort: Math.trunc(numArg(args, 'container-port') ?? 0),
        servicePort: Math.trunc(numArg(args, 'service-port') ?? 0),
        replicas: Math.trunc(numArg(args, 'replicas') ?? 0),
        env: envMap,
        cpu: strArg(args, 'cpu'),
        memory: strArg(args, 'memory'),
        command: commandList,
        kvm: args['kvm'] === true,
        gpuCount: Math.trunc(numArg(args, 'gpu-count') ?? 0),
      },
      { headers: { 'X-Session-Name': ctx.session } },
    )
    const s = res.service
    if (s === undefined) {
      throw new TypedToolError('internal', tr(ctx.locale, 'serviceDeployFailed', { err: 'no service in response' }))
    }
    return {
      content: tr(ctx.locale, 'serviceDeployed', { name: s.name, image: s.image, url: s.url }),
      data: { name: s.name, image: s.image, url: s.url, phase: s.phase, ready: s.ready, replicas: s.replicas },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'serviceDeployFailed', { err: String(e) }))
  }
}

/** `service-list`: list the tenant's services. */
export async function serviceList(
  ctx: ServiceCtx,
  _args: Record<string, unknown>,
): Promise<ToolResultData> {
  const res = await ctx.workspace.listServices({})
  const svcs = res.services
  if (svcs.length === 0) return { content: tr(ctx.locale, 'serviceNone') }
  const lines = svcs.map(
    s => `${s.name}  [${s.phase}${s.ready ? ', ready' : ''}]  ${s.image}  ${s.url}  x${s.replicas}`,
  )
  return { content: tr(ctx.locale, 'serviceListHeader', { count: svcs.length }) + '\n' + lines.join('\n'), data: { count: svcs.length } }
}

/** `service-delete`: delete a service. */
export async function serviceDelete(
  ctx: ServiceCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  const res = await ctx.workspace.deleteService({ name })
  return {
    content: res.ok ? tr(ctx.locale, 'serviceDeleted', { name }) : tr(ctx.locale, 'serviceNotFound', { name }),
    data: { name, deleted: res.ok },
  }
}
