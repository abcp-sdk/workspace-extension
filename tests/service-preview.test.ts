import { describe, expect, it } from 'vitest'
import { repoBuildPreview } from '../src/tools/imagebuild.js'
import { serviceDeploy, serviceLogs, servicePreview, servicePromote, serviceRollback } from '../src/tools/services.js'
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

  it('forwards volumes as VolumeMountSpec', async () => {
    const { c, previews } = serviceCtx()
    await servicePreview(c, {
      image: 'reg/x:1',
      volumes: [
        { pvc: 'data', 'mount-path': '/data', 'read-only': true, 'sub-path': 'sub' },
        { pvc: 'skip' }, // no mount-path -> dropped
      ],
    })
    expect(previews[0]).toMatchObject({
      volumes: [{ pvc: 'data', mountPath: '/data', readOnly: true, subPath: 'sub' }],
    })
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

describe('service-deploy Tier 0', () => {
  it('forwards Tier 0 fields (resources/probes/rollout/config/sidecars)', async () => {
    const calls: unknown[] = []
    const c = {
      workspace: {
        async deployService(r: unknown) {
          calls.push(r)
          return {
            service: {
              name: 'web', image: 'img:1', url: 'http://web:80',
              phase: 'Pending', ready: false, replicas: 1, ports: [],
            },
          }
        },
      },
      session: 't:r:b',
      locale: 'en',
    } as unknown as ServiceCtx
    await serviceDeploy(c, {
      image: 'img:1',
      resources: { cpu: '100m', memory: '128Mi', 'cpu-limit': '1', 'memory-limit': '512Mi' },
      'readiness-probe': { 'http-port': 8080, 'http-path': '/healthz' },
      'liveness-probe': { 'exec-command': ['true'] },
      rollout: { 'max-surge': '25%', 'max-unavailable': '0' },
      'env-refs': [{ name: 'DB', 'config-map': 'cfg', 'config-key': 'db' }],
      'env-from': [{ secret: 'sec' }],
      'config-mounts': [{ 'config-map': 'cfg', 'mount-path': '/etc/cfg' }],
      sidecars: [{ name: 'helper', image: 'busybox', init: true }],
      'node-selector': { disk: 'ssd' },
      tolerations: [{ key: 'dedicated', operator: 'Exists', effect: 'NoSchedule' }],
    })
    expect(calls[0]).toMatchObject({
      resources: { cpu: '100m', memory: '128Mi', cpuLimit: '1', memoryLimit: '512Mi' },
      readinessProbe: { httpPort: 8080, httpPath: '/healthz' },
      livenessProbe: { execCommand: ['true'] },
      rollout: { maxSurge: '25%', maxUnavailable: '0' },
      envRefs: [{ name: 'DB', configMap: 'cfg', configKey: 'db' }],
      envFrom: [{ secret: 'sec' }],
      configMounts: [{ configMap: 'cfg', mountPath: '/etc/cfg' }],
      sidecars: [{ name: 'helper', image: 'busybox', init: true }],
      nodeSelector: { disk: 'ssd' },
      tolerations: [{ key: 'dedicated', operator: 'Exists', effect: 'NoSchedule' }],
    })
  })

  it('omits Tier 0 fields when absent', async () => {
    const calls: unknown[] = []
    const c = {
      workspace: {
        async deployService(r: unknown) {
          calls.push(r)
          return { service: { name: 'web', image: 'img:1', url: 'http://web:80', phase: 'Pending', ready: false, replicas: 1, ports: [] } }
        },
      },
      session: 't:r:b',
      locale: 'en',
    } as unknown as ServiceCtx
    await serviceDeploy(c, { image: 'img:1' })
    const req = calls[0] as Record<string, unknown>
    expect(req['resources']).toBeUndefined()
    expect(req['readinessProbe']).toBeUndefined()
    expect(req['sidecars']).toBeUndefined()
  })
})

describe('service-promote / service-rollback', () => {
  function slotCtx() {
    const calls: unknown[] = []
    const c = {
      workspace: {
        async promoteService(r: unknown) {
          calls.push(r)
          return { service: { name: 'web', image: 'img:green', activeSlot: 'green', url: 'http://web:80', publicUrl: 'https://web.worker.d' } }
        },
        async rollbackService(r: unknown) {
          calls.push(r)
          return { service: { name: 'web', image: 'img:blue', activeSlot: 'blue', url: 'http://web:80', publicUrl: 'https://web.worker.d' } }
        },
      },
      session: 't:r:b',
      locale: 'en',
    } as unknown as ServiceCtx
    return { c, calls }
  }

  it('promotes and reports the new active slot', async () => {
    const { c, calls } = slotCtx()
    const res = await servicePromote(c, { name: 'web', force: true })
    expect(calls[0]).toMatchObject({ name: 'web', force: true })
    expect(res.data).toMatchObject({ active_slot: 'green', image: 'img:green' })
  })

  it('rolls back and reports the active slot', async () => {
    const { c, calls } = slotCtx()
    const res = await serviceRollback(c, { name: 'web' })
    expect(calls[0]).toMatchObject({ name: 'web' })
    expect(res.data).toMatchObject({ active_slot: 'blue' })
  })

  it('requires a name', async () => {
    const { c } = slotCtx()
    await expect(servicePromote(c, {})).rejects.toThrow(/name/)
  })
})
