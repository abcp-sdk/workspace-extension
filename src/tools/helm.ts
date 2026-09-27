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
  const slot = strArg(args, 'slot')
  if (slot !== '' && slot !== 'blue' && slot !== 'green') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'helmSlotInvalid'))
  }
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
        slot,
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
    const slotNote = (r?.slots ?? []).length
      ? '\n' + (r?.slots ?? []).map(sl => tr(ctx.locale, 'helmSlotLine', {
          slot: sl.slot, ready: sl.ready ? 'ready' : 'not-ready', count: `${sl.readyWorkload}/${sl.totalWorkload}`,
          active: sl.slot === r?.activeSlot ? ' *' : '',
        })).join('\n')
      : ''
    return {
      content: tr(ctx.locale, 'helmDeployed', { release: r?.name ?? release, revision: r?.revision ?? 0 }) + slotNote,
      data: {
        name: r?.name ?? release, revision: r?.revision ?? 0, status: r?.status ?? '',
        ref: r?.ref ?? '', chart_path: r?.chartPath ?? '', slot: r?.slot ?? '', active_slot: r?.activeSlot ?? '',
        objects: res.objects,
        slots: (r?.slots ?? []).map(sl => ({ slot: sl.slot, release: sl.release, ready: sl.ready, ready_workload: sl.readyWorkload, total_workload: sl.totalWorkload })),
      },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'helmFailed', { op: 'helm-deploy', err: String(e) }))
  }
}

/** `helm-promote`: switch a blue-green release's router to the other slot. */
export async function helmPromote(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  const force = args['force'] === true
  try {
    const res = await ctx.workspace.helmPromote({ release, force })
    return {
      content: tr(ctx.locale, 'helmPromoted', { release, slot: res.release?.activeSlot ?? '' }),
      data: { release, active_slot: res.release?.activeSlot ?? '' },
    }
  } catch (e) {
    throw new TypedToolError('retryable', tr(ctx.locale, 'helmFailed', { op: 'helm-promote', err: String(e) }))
  }
}

/** `helm-rollback-release`: switch a blue-green release's router back a slot. */
export async function helmRollbackRelease(
  ctx: HelmCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const release = strArg(args, 'release')
  if (release === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'release' }))
  try {
    const res = await ctx.workspace.helmRollbackRelease({ release })
    return {
      content: tr(ctx.locale, 'helmRolledBackSlot', { release, slot: res.release?.activeSlot ?? '' }),
      data: { release, active_slot: res.release?.activeSlot ?? '' },
    }
  } catch (e) {
    throw new TypedToolError('retryable', tr(ctx.locale, 'helmFailed', { op: 'helm-rollback-release', err: String(e) }))
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
    const slots = (r.slots ?? []).length
      ? `  slots=${(r.slots ?? []).map(sl => `${sl.slot}${sl.slot === r.activeSlot ? '*' : ''}(${sl.ready ? 'ready' : 'not-ready'})`).join(',')}`
      : ''
    return `${r.name}  rev${r.revision}  [${r.status}]  ${r.chartPath || '.'}@${r.ref || 'HEAD'}${slots}  session=${r.session || '-'}`
  })
  return {
    content: tr(ctx.locale, 'helmListHeader', { count: rels.length }) + '\n' + lines.join('\n'),
    data: { count: rels.length, releases: rels.map(r => ({ name: r.name, revision: r.revision, status: r.status, ref: r.ref, chart_path: r.chartPath, session: r.session, active_slot: r.activeSlot, slots: (r.slots ?? []).map(sl => ({ slot: sl.slot, ready: sl.ready, ready_workload: sl.readyWorkload, total_workload: sl.totalWorkload })) })) },
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
