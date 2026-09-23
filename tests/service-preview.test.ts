import { describe, expect, it } from 'vitest'
import { repoBuildPreview } from '../src/tools/imagebuild.js'
import { serviceLogs, servicePreview } from '../src/tools/services.js'
import type { ServiceCtx } from '../src/tools/services.js'
import type { BuildCtx } from '../src/tools/imagebuild.js'

function serviceCtx() {
  const previews: unknown[] = []
  const logCalls: unknown[] = []
  const c = {
    workspace: {
      async previewService(r: unknown) {
        previews.push(r)
        return {
          service: {
            name: 'myuser-demo-featx-web',
            image: 'reg/myuser/demo:preview-featx-abc123',
            url: 'http://myuser-demo-featx-web.worker.svc.cluster.local:80',
            stage: 'preview',
            phase: 'Pending',
            ready: false,
            expiresAt: '1700000000000',
            ports: [],
          },
        }
      },
      async serviceLogs(r: unknown) {
        logCalls.push(r)
        return { lines: ['line1', 'line2'] }
      },
    },
    session: 'myuser:demo:featx',
    locale: 'en',
  } as unknown as ServiceCtx
  return { c, previews, logCalls }
}

describe('service-preview', () => {
  it('forwards image + passes X-Session-Name, returns preview data', async () => {
    const { c, previews } = serviceCtx()
    const res = await servicePreview(c, {
      image: 'reg/myuser/demo:preview-featx-abc123',
      name: 'web',
      'ttl-seconds': 3600,
    })
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({
      image: 'reg/myuser/demo:preview-featx-abc123',
      name: 'web',
      ttlSeconds: 3600,
    })
    expect(res.data).toMatchObject({ name: 'myuser-demo-featx-web', stage: 'preview' })
  })

  it('requires an image', async () => {
    const { c, previews } = serviceCtx()
    await expect(servicePreview(c, {})).rejects.toThrow(/image/)
    expect(previews).toHaveLength(0)
  })
})

describe('service-logs', () => {
  it('tails a service log', async () => {
    const { c, logCalls } = serviceCtx()
    const res = await serviceLogs(c, { name: 'web', 'tail-lines': 100 })
    expect(logCalls[0]).toMatchObject({ name: 'web', tailLines: BigInt(100), previous: false })
    expect(res.content).toContain('line1')
    expect(res.data).toMatchObject({ lines: 2 })
  })

  it('requires a name', async () => {
    const { c } = serviceCtx()
    await expect(serviceLogs(c, {})).rejects.toThrow(/name/)
  })
})

function buildCtx() {
  const calls: unknown[] = []
  const c = {
    workspace: {
      async buildPreviewImage(r: unknown) {
        calls.push(r)
        return { imageRef: 'reg/myuser/demo:preview-featx-abc123', log: 'build ok', tag: 'preview-featx-abc123' }
      },
    },
    locale: 'en',
  } as unknown as BuildCtx
  return { c, calls }
}

describe('repo-build-preview', () => {
  it('forwards org/repo (name/tag are forced server-side)', async () => {
    const { c, calls } = buildCtx()
    const res = await repoBuildPreview(c, { org: 'myuser', repo: 'demo', 'tag-suffix': 'v2' })
    expect(calls[0]).toMatchObject({ org: 'myuser', repo: 'demo', tagSuffix: 'v2' })
    expect(res.data).toMatchObject({ tag: 'preview-featx-abc123' })
  })

  it('requires org and repo', async () => {
    const { c, calls } = buildCtx()
    await expect(repoBuildPreview(c, { org: 'myuser' })).rejects.toThrow(/repo/)
    expect(calls).toHaveLength(0)
  })
})
