import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import { tr } from '../i18n.js'
import { strArg } from './shared.js'

/** Context for the pvc-* tools (workspace gateway). */
export interface PVCContext {
  workspace: GatewayClient
  locale: string
}

/** `pvc-create`: create a named, tenant-owned PersistentVolumeClaim. */
export async function pvcCreate(
  ctx: PVCContext,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  try {
    const res = await ctx.workspace.createPVC({
      name,
      size: strArg(args, 'size'),
      storageClass: strArg(args, 'storage-class'),
    })
    const p = res.pvc
    if (p === undefined) {
      throw new TypedToolError('internal', tr(ctx.locale, 'pvcCreateFailed', { name, err: 'no pvc in response' }))
    }
    return {
      content: tr(ctx.locale, 'pvcCreated', { name: p.name, size: p.size, class: p.storageClass }),
      data: { name: p.name, size: p.size, storage_class: p.storageClass, phase: p.phase },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'pvcCreateFailed', { name, err: String(e) }))
  }
}

/** `pvc-list`: list the tenant's PVCs. */
export async function pvcList(
  ctx: PVCContext,
  _args: Record<string, unknown>,
): Promise<ToolResultData> {
  try {
    const res = await ctx.workspace.listPVCs({})
    const pvcs = res.pvcs
    if (pvcs.length === 0) return { content: tr(ctx.locale, 'pvcNone'), data: { count: 0, pvcs: [] } }
    const lines = pvcs.map(p => {
      const mounted = (p.mountedBy ?? []).length ? `  mounted-by=${(p.mountedBy ?? []).join(',')}` : ''
      return `${p.name}  [${p.phase}]  ${p.size}  class=${p.storageClass}${mounted}`
    })
    return {
      content: tr(ctx.locale, 'pvcListHeader', { count: pvcs.length }) + '\n' + lines.join('\n'),
      data: {
        count: pvcs.length,
        pvcs: pvcs.map(p => ({
          name: p.name, size: p.size, storage_class: p.storageClass,
          phase: p.phase, mounted_by: p.mountedBy ?? [],
        })),
      },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'pvcListFailed', { err: String(e) }))
  }
}

/** `pvc-delete`: delete a PVC (refused while a service mounts it). */
export async function pvcDelete(
  ctx: PVCContext,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  try {
    const res = await ctx.workspace.deletePVC({ name })
    return {
      content: res.ok ? tr(ctx.locale, 'pvcDeleted', { name }) : tr(ctx.locale, 'pvcDeleteFailed', { name, err: 'not found' }),
      data: { name, deleted: res.ok },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'pvcDeleteFailed', { name, err: String(e) }))
  }
}
