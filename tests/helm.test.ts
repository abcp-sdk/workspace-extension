import { describe, expect, it } from 'vitest'
import { helmDeploy, helmHistory, helmList, helmRollback, helmUninstall, helmObjects, helmObjectLogs, type HelmCtx } from '../src/tools/helm.js'

function ctx() {
  const calls: Record<string, unknown[]> = { deploy: [], rollback: [], uninstall: [], list: [], history: [] }
  const c = {
    workspace: {
      async helmDeploy(r: unknown) { calls.deploy.push(r); return { release: { name: 'web', revision: 1, status: 'deployed' }, objects: ['Service/web', 'Deployment/web'], manifest: 'kind: Service' } },
      async helmList() { return { releases: [{ name: 'web', revision: 1, status: 'deployed', chartPath: 'deploy', ref: 'main' }] } },
      async helmHistory(r: unknown) { calls.history.push(r); return { release: { name: 'web' }, revisions: [{ revision: 1, ref: 'main', chartPath: 'deploy', objects: ['Service/web'] }] } },
      async helmRollback(r: unknown) { calls.rollback.push(r); return { release: { name: 'web', revision: 2 } } },
      async helmUninstall(r: unknown) { calls.uninstall.push(r); return { ok: true } },
    },
    session: 't:r:b',
    locale: 'en',
  } as unknown as HelmCtx
  return { c, calls }
}

describe('helm tools', () => {
  it('helm-deploy applies and reports the revision', async () => {
    const { c, calls } = ctx()
    const res = await helmDeploy(c, { release: 'web', org: 'o', repo: 'r', 'chart-path': 'deploy', values: 'replicas: 2' })
    expect(calls.deploy[0]).toMatchObject({ release: 'web', org: 'o', repo: 'r', chartPath: 'deploy', values: 'replicas: 2', dryRun: false })
    expect(res.data).toMatchObject({ name: 'web', revision: 1 })
  })

  it('helm-deploy dry-run returns the manifest', async () => {
    const { c } = ctx()
    const res = await helmDeploy(c, { release: 'web', org: 'o', repo: 'r', 'dry-run': true })
    expect(res.data).toMatchObject({ dry_run: true })
  })

  it('helm-deploy requires release/org/repo', async () => {
    const { c } = ctx()
    await expect(helmDeploy(c, { org: 'o', repo: 'r' })).rejects.toThrow(/release/)
    await expect(helmDeploy(c, { release: 'web', org: 'o' })).rejects.toThrow(/repo/)
  })

  it('helm-list lists releases', async () => {
    const { c } = ctx()
    const res = await helmList(c, {})
    expect(res.data).toMatchObject({ count: 1 })
  })

  it('helm-history requires release', async () => {
    const { c } = ctx()
    await expect(helmHistory(c, {})).rejects.toThrow(/release/)
  })

  it('helm-rollback forwards the revision', async () => {
    const { c, calls } = ctx()
    const res = await helmRollback(c, { release: 'web', revision: 1 })
    expect(calls.rollback[0]).toMatchObject({ release: 'web', revision: 1 })
    expect(res.data).toMatchObject({ revision: 2 })
  })

  it('helm-uninstall deletes', async () => {
    const { c, calls } = ctx()
    const res = await helmUninstall(c, { release: 'web' })
    expect(calls.uninstall[0]).toMatchObject({ release: 'web' })
    expect(res.data).toMatchObject({ deleted: true })
  })
})

describe('helm objects / logs', () => {
  function objCtx() {
    const calls: Record<string, unknown[]> = { objects: [], logs: [] }
    const c = {
      workspace: {
        async helmObjects(r: unknown) {
          calls.objects.push(r)
          return {
            objects: [
              { kind: 'Deployment', name: 'web', namespace: 'ns', status: 'Progressing', ready: false, message: 'CrashLoopBackOff', phase: 'Running', restarts: 5, readyReplicas: 0, desiredReplicas: 2 },
              { kind: 'Service', name: 'web', namespace: 'ns', status: 'Ready', ready: true, readyReplicas: 0, desiredReplicas: 0 },
            ],
          }
        },
        async helmObjectLogs(r: unknown) {
          calls.logs.push(r)
          return { lines: ['l1', 'l2'], available: true, message: '' }
        },
      },
      session: 't:r:b',
      locale: 'en',
    } as unknown as HelmCtx
    return { c, calls }
  }

  it('helm-objects lists live object status', async () => {
    const { c, calls } = objCtx()
    const res = await helmObjects(c, { release: 'web' })
    expect(calls.objects[0]).toMatchObject({ release: 'web' })
    expect(String(res.content)).toContain('CrashLoopBackOff')
    expect(res.data).toMatchObject({ release: 'web' })
  })

  it('helm-objects requires release', async () => {
    const { c } = objCtx()
    await expect(helmObjects(c, {})).rejects.toThrow(/release/)
  })

  it('helm-object-logs forwards tail/previous and reports lines', async () => {
    const { c, calls } = objCtx()
    const res = await helmObjectLogs(c, { release: 'web', kind: 'Pod', name: 'web-0', tail: 50, previous: true })
    expect(calls.logs[0]).toMatchObject({ release: 'web', kind: 'Pod', name: 'web-0', tailLines: 50n, previous: true })
    expect(res.data).toMatchObject({ available: true })
    expect(String(res.content)).toContain('l1')
  })

  it('helm-object-logs requires release/kind/name', async () => {
    const { c } = objCtx()
    await expect(helmObjectLogs(c, { kind: 'Pod', name: 'x' })).rejects.toThrow(/release/)
    await expect(helmObjectLogs(c, { release: 'web', name: 'x' })).rejects.toThrow(/kind/)
  })

  it('helm-object-logs reports unavailable', async () => {
    const c = {
      workspace: { async helmObjectLogs() { return { lines: [], available: false, message: 'no such pod' } } },
      session: 't',
      locale: 'en',
    } as unknown as HelmCtx
    const res = await helmObjectLogs(c, { release: 'web', kind: 'Pod', name: 'web-0' })
    expect(res.data).toMatchObject({ available: false, message: 'no such pod' })
  })
})
