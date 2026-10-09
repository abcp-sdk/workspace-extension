import { describe, expect, it } from 'vitest'
import type { GatewayClient } from '../src/client.js'
import {
  configPut,
  configList,
  configDelete,
  secretPut,
  secretList,
  secretDelete,
  type ConfigStoreContext,
} from '../src/tools/configstore.js'

/** A gateway stub recording config/secret calls. */
function ctx(over: Partial<Record<string, unknown>> = {}) {
  const calls: Array<[string, unknown]> = []
  const c = {
    workspace: {
      async putConfigMap(r: unknown) { calls.push(['putConfigMap', r]); return { configmap: { name: 'nats', data: { 'nats.conf': 'CONFVAL' } } } },
      async listConfigMaps() { calls.push(['listConfigMaps', {}]); return { configmaps: [{ name: 'nats', data: { 'nats.conf': 'CONFVAL' } }] } },
      async deleteConfigMap(r: unknown) { calls.push(['deleteConfigMap', r]); return { ok: true } },
      async putSecret(r: unknown) { calls.push(['putSecret', r]); return { secret: { name: 's', data: { token: 'SEKRETVAL' } } } },
      async listSecrets() { calls.push(['listSecrets', {}]); return { secrets: [{ name: 's', data: { token: 'SEKRETVAL' } }] } },
      async deleteSecret(r: unknown) { calls.push(['deleteSecret', r]); return { ok: true } },
      ...over,
    },
    locale: 'en',
  } as unknown as ConfigStoreContext
  return { c, calls }
}

describe('config-* / secret-*', () => {
  it('config-put forwards name + stringified data', async () => {
    const { c, calls } = ctx()
    const res = await configPut(c, { name: 'nats', data: { 'nats.conf': 'CONFVAL', n: 1 } })
    expect(calls[0]).toEqual(['putConfigMap', { name: 'nats', data: { 'nats.conf': 'CONFVAL', n: '1' } }])
    expect(res.data).toMatchObject({ name: 'nats', keys: 2 })
  })

  it('config-put requires name', async () => {
    const { c } = ctx()
    await expect(configPut(c, { data: {} })).rejects.toThrow(/name/)
  })

  it('config-list prints names + keys (not values)', async () => {
    const { c } = ctx()
    const res = await configList(c, {})
    expect(String(res.content)).toContain('nats')
    expect(String(res.content)).toContain('nats.conf')
    expect(String(res.content)).not.toContain('CONFVAL')
    expect(res.data).toMatchObject({ count: 1 })
  })

  it('config-delete reports the deletion', async () => {
    const { c, calls } = ctx()
    const res = await configDelete(c, { name: 'nats' })
    expect(calls[0]).toEqual(['deleteConfigMap', { name: 'nats' }])
    expect(res.data).toMatchObject({ name: 'nats', deleted: true })
  })

  it('secret-put / secret-list / secret-delete', async () => {
    const { c, calls } = ctx()
    await secretPut(c, { name: 's', data: { token: 'SEKRETVAL' } })
    expect(calls[0]).toEqual(['putSecret', { name: 's', data: { token: 'SEKRETVAL' } }])
    const listed = await secretList(c, {})
    expect(String(listed.content)).toContain('s')
    expect(String(listed.content)).not.toContain('SEKRETVAL')
    const del = await secretDelete(c, { name: 's' })
    expect(del.data).toMatchObject({ deleted: true })
  })
})
