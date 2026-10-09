import { describe, expect, it } from 'vitest'
import type { GatewayClient } from '../src/client.js'
import { repoBuildCancel, type BuildCtx } from '../src/tools/imagebuild.js'

/** A gateway stub whose cancelBuild is scripted; records the request. */
function ctx(over: Partial<Record<keyof GatewayClient, unknown>> = {}) {
  const calls: Array<Record<string, unknown>> = []
  const c = {
    workspace: {
      async cancelBuild(r: Record<string, unknown>) {
        calls.push(r)
        return { ok: true }
      },
      ...over,
    },
    locale: 'en',
  } as unknown as BuildCtx
  return { c, calls }
}

describe('repo-build-cancel', () => {
  it('forwards build-id and reports the cancellation', async () => {
    const { c, calls } = ctx()
    const res = await repoBuildCancel(c, { 'build-id': 'b1' })
    expect(calls[0]).toMatchObject({ buildId: 'b1' })
    expect(res.data).toMatchObject({ build_id: 'b1', canceled: true })
  })

  it('reports "not running" when the gateway says ok=false (idempotent)', async () => {
    const { c } = ctx({ cancelBuild: async () => ({ ok: false }) })
    const res = await repoBuildCancel(c, { 'build-id': 'b1' })
    expect(res.data).toMatchObject({ build_id: 'b1', canceled: false })
    expect(String(res.content)).toContain('not running')
  })

  it('requires build-id', async () => {
    const { c } = ctx()
    await expect(repoBuildCancel(c, {})).rejects.toThrow(/build-id/)
  })
})
