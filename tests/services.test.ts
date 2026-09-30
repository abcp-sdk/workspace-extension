import { describe, expect, it } from 'vitest'
import { serviceDeploy, serviceLogs, servicePromote, serviceRollback } from '../src/tools/services.js'
import type { ServiceCtx } from '../src/tools/services.js'

function serviceCtx() {
  const logCalls: unknown[] = []
  const c = {
    workspace: {
      async serviceLogs(r: unknown) {
        logCalls.push(r)
        return { lines: ['line1', 'line2'] }
      },
    },
    session: 'myuser:demo:featx',
    locale: 'en',
  } as unknown as ServiceCtx
  return { c, logCalls }
}

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
