import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import { tr } from '../i18n.js'
import { numArg, strArg } from './shared.js'

/** Context for the helm-* tools (workspace gateway). */
export interface HelmCtx {
  workspace: GatewayClient
  session: string
  locale: string
}

/** `helm-deploy`: render a repo chart into the cluster (or dry-run). */
export async function helmDeploy(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  const org = strArg(args, 'org')
  const repo = strArg(args, 'repo')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  if (org === '' || repo === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: org === '' ? 'org' : 'repo' }))
  const dryRun = args['dry-run'] === true
  try {
    const res = await ctx.workspace.helmDeploy(
      {
        release,
        org,
        repo,
        ref: strArg(args, 'ref'),
        chartPath: strArg(args, 'chart-path'),
        values: strArg(args, 'values'),
        dryRun,
      },
      { headers: { 'X-Session-Name': ctx.session } },
    )
    if (dryRun) {
      return {
        content: tr(ctx.locale, 'helmRendered', { release, count: res.objects.length }) + '\n' + res.manifest,
        data: { release, dry_run: true, objects: res.objects, manifest: res.manifest },
      }
    }
    const r = res.release
    return {
      content: tr(ctx.locale, 'helmDeployed', { release: r?.name ?? release, revision: r?.revision ?? 0 }),
      data: {
        name: r?.name ?? release, revision: r?.revision ?? 0, status: r?.status ?? '',
        ref: r?.ref ?? "", chart_path: r?.chartPath ?? "",
        objects: res.objects,
      },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'helmFailed', { op: 'helm-deploy', err: String(e) }))
  }
}

/** `helm-list`: list the tenant's releases. */
export async function helmList(
  ctx: HelmCtx,
  _args: Record<string, unknown>,
): Promise<ToolResultData> {
  const res = await ctx.workspace.helmList({})
  const rels = res.releases
  if (rels.length === 0) return { content: tr(ctx.locale, 'helmNone') }
  const lines = rels.map(r => {
    return `${r.name}  rev${r.revision}  [${r.status}]  ${r.chartPath || '.'}@${r.ref || 'HEAD'}  session=${r.session || '-'}`
  })
  return {
    content: tr(ctx.locale, 'helmListHeader', { count: rels.length }) + '\n' + lines.join('\n'),
    data: { count: rels.length, releases: rels.map(r => ({ name: r.name, revision: r.revision, status: r.status, ref: r.ref, chart_path: r.chartPath, session: r.session })) },
  }
}

/** `helm-history`: a release's revision history. */
export async function helmHistory(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  const res = await ctx.workspace.helmHistory({ release })
  const revs = res.revisions
  const lines = revs.map(r => `rev${r.revision}  ${r.chartPath || '.'}@${r.ref || 'HEAD'}  ${r.objects.join(', ')}`)
  return {
    content: tr(ctx.locale, 'helmHistoryHeader', { release, count: revs.length }) + '\n' + lines.join('\n'),
    data: { release, revisions: revs.map(r => ({ revision: r.revision, ref: r.ref, chart_path: r.chartPath, objects: r.objects })) },
  }
}

/** `helm-rollback`: re-apply a prior revision (0 = previous). */
export async function helmRollback(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  const revision = Math.trunc(numArg(args, 'revision') ?? 0)
  try {
    const res = await ctx.workspace.helmRollback({ release, revision })
    return {
      content: tr(ctx.locale, 'helmRolledBack', { release, revision: res.release?.revision ?? 0 }),
      data: { release, revision: res.release?.revision ?? 0 },
    }
  } catch (e) {
    throw new TypedToolError('retryable', tr(ctx.locale, 'helmFailed', { op: 'helm-rollback', err: String(e) }))
  }
}

/** `helm-uninstall`: delete a release and its objects. */
export async function helmUninstall(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  const res = await ctx.workspace.helmUninstall({ release })
  return {
    content: res.ok ? tr(ctx.locale, 'helmUninstalled', { release }) : tr(ctx.locale, 'helmNotFound', { release }),
    data: { release, deleted: res.ok },
  }
}

/** `helm-objects`: live status of every object a release deployed. */
export async function helmObjects(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  const res = await ctx.workspace.helmObjects({ release })
  const objs = res.objects
  if (objs.length === 0) return { content: tr(ctx.locale, 'helmObjectsNone', { release }), data: { release, objects: [] } }
  const lines = objs.map(o => {
    const reps = o.desiredReplicas > 0 ? ` ${o.readyReplicas}/${o.desiredReplicas}` : ''
    const rst = o.restarts > 0 ? ` restarts=${o.restarts}` : ''
    const msg = o.message ? `  ${o.message}` : ''
    return `${o.ready ? '✓' : '·'} ${o.kind}/${o.name}  [${o.status}]${reps}${rst}${msg}`
  })
  return {
    content: tr(ctx.locale, 'helmObjectsHeader', { release, count: objs.length }) + '\n' + lines.join('\n'),
    data: {
      release,
      objects: objs.map(o => ({
        kind: o.kind, name: o.name, namespace: o.namespace, status: o.status, ready: o.ready,
        message: o.message, phase: o.phase, restarts: o.restarts,
        ready_replicas: o.readyReplicas, desired_replicas: o.desiredReplicas,
      })),
    },
  }
}

/** `helm-object-logs`: one release object's container log (kind must be Pod). */
export async function helmObjectLogs(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  const kind = strArg(args, 'kind')
  const name = strArg(args, 'name')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  if (kind === '' || name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: kind === '' ? 'kind' : 'name' }))
  const tailLines = Math.trunc(numArg(args, 'tail') ?? 200)
  const previous = args['previous'] === true
  const res = await ctx.workspace.helmObjectLogs({ release, kind, name, tailLines: BigInt(tailLines), previous, container: strArg(args, 'container') })
  if (!res.available) {
    return { content: tr(ctx.locale, 'helmObjectLogsUnavailable', { name, reason: res.message }), data: { release, kind, name, available: false, message: res.message } }
  }
  return {
    content: tr(ctx.locale, 'helmObjectLogsHeader', { name, count: res.lines.length }) + '\n' + res.lines.join('\n'),
    data: { release, kind, name, available: true, lines: res.lines },
  }
}
