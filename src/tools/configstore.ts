import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import { tr } from '../i18n.js'
import { strArg } from './shared.js'

/** Context for the config-* and secret-* tools (workspace gateway). */
export interface ConfigStoreContext {
  workspace: GatewayClient
  locale: string
}

/** Coerce a `data` arg into a string->string map (values are stringified). */
function strMapArg(args: Record<string, unknown>, key: string): Record<string, string> {
  const v = args[key]
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new TypedToolError('invalid_argument', `'${key}' must be an object of string values`)
  }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val)
  return out
}

/** `config-put`: create/update a tenant-owned ConfigMap. */
export async function configPut(
  ctx: ConfigStoreContext,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  const data = strMapArg(args, 'data')
  try {
    const res = await ctx.workspace.putConfigMap({ name, data })
    const keys = Object.keys(data).length
    return {
      content: tr(ctx.locale, 'configPut', { name: res.configmap?.name ?? name, keys }),
      data: { name: res.configmap?.name ?? name, keys },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'configPutFailed', { name, err: String(e) }))
  }
}

/** `config-list`: list the tenant's ConfigMaps (values are NOT printed). */
export async function configList(
  ctx: ConfigStoreContext,
  _args: Record<string, unknown>,
): Promise<ToolResultData> {
  try {
    const res = await ctx.workspace.listConfigMaps({})
    const cms = res.configmaps
    if (cms.length === 0) return { content: tr(ctx.locale, 'configNone'), data: { count: 0, configmaps: [] } }
    const lines = cms.map(c => `${c.name}  keys=${Object.keys(c.data).join(',')}`)
    return {
      content: tr(ctx.locale, 'configListHeader', { count: cms.length }) + '\n' + lines.join('\n'),
      data: { count: cms.length, configmaps: cms.map(c => ({ name: c.name, keys: Object.keys(c.data) })) },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'configListFailed', { err: String(e) }))
  }
}

/** `config-delete`: delete a ConfigMap the tenant owns. */
export async function configDelete(
  ctx: ConfigStoreContext,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  try {
    const res = await ctx.workspace.deleteConfigMap({ name })
    return {
      content: res.ok ? tr(ctx.locale, 'configDeleted', { name }) : tr(ctx.locale, 'configDeleteFailed', { name, err: 'not found' }),
      data: { name, deleted: res.ok },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'configDeleteFailed', { name, err: String(e) }))
  }
}

/** `secret-put`: create/update a tenant-owned Secret. */
export async function secretPut(
  ctx: ConfigStoreContext,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  const data = strMapArg(args, 'data')
  try {
    const res = await ctx.workspace.putSecret({ name, data })
    const keys = Object.keys(data).length
    return {
      content: tr(ctx.locale, 'secretPut', { name: res.secret?.name ?? name, keys }),
      data: { name: res.secret?.name ?? name, keys },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'secretPutFailed', { name, err: String(e) }))
  }
}

/** `secret-list`: list the tenant's Secrets (values are NOT printed). */
export async function secretList(
  ctx: ConfigStoreContext,
  _args: Record<string, unknown>,
): Promise<ToolResultData> {
  try {
    const res = await ctx.workspace.listSecrets({})
    const secs = res.secrets
    if (secs.length === 0) return { content: tr(ctx.locale, 'secretNone'), data: { count: 0, secrets: [] } }
    const lines = secs.map(s => `${s.name}  keys=${Object.keys(s.data).join(',')}`)
    return {
      content: tr(ctx.locale, 'secretListHeader', { count: secs.length }) + '\n' + lines.join('\n'),
      data: { count: secs.length, secrets: secs.map(s => ({ name: s.name, keys: Object.keys(s.data) })) },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'secretListFailed', { err: String(e) }))
  }
}

/** `secret-delete`: delete a Secret the tenant owns. */
export async function secretDelete(
  ctx: ConfigStoreContext,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  try {
    const res = await ctx.workspace.deleteSecret({ name })
    return {
      content: res.ok ? tr(ctx.locale, 'secretDeleted', { name }) : tr(ctx.locale, 'secretDeleteFailed', { name, err: 'not found' }),
      data: { name, deleted: res.ok },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'secretDeleteFailed', { name, err: String(e) }))
  }
}
