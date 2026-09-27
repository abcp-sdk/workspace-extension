import { describe, expect, it } from 'vitest'
import { helmDeploy, helmHistory, helmList, helmPromote, helmRollback, helmRollbackRelease, helmUninstall, type HelmCtx } from '../src/tools/helm.js'

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

describe('helm blue-green', () => {
  function slotCtx() {
    const calls: Record<string, unknown[]> = { deploy: [], promote: [], rollback: [] }
    const c = {
      workspace: {
        async helmDeploy(r: unknown) { calls.deploy.push(r); return { release: { name: 'web-green', revision: 1, slot: 'green', activeSlot: 'blue', status: 'deployed', slots: [{ slot: 'blue', release: 'web-blue', ready: true, readyWorkload: 1, totalWorkload: 1 }, { slot: 'green', release: 'web-green', ready: false, readyWorkload: 0, totalWorkload: 1 }] }, objects: ['Deployment/web-green'] } },
        async helmPromote(r: unknown) { calls.promote.push(r); return { release: { name: 'web', activeSlot: 'green' } } },
        async helmRollbackRelease(r: unknown) { calls.rollback.push(r); return { release: { name: 'web', activeSlot: 'blue' } } },
      },
      session: 't:r:b',
      locale: 'en',
    } as unknown as HelmCtx
    return { c, calls }
  }

  it('helm-deploy forwards the slot', async () => {
    const { c, calls } = slotCtx()
    const res = await helmDeploy(c, { release: 'web', org: 'o', repo: 'r', slot: 'green' })
    expect(calls.deploy[0]).toMatchObject({ release: 'web', slot: 'green' })
    expect(res.data).toMatchObject({ slot: 'green', active_slot: 'blue' })
  })

  it('rejects an invalid slot', async () => {
    const { c } = slotCtx()
    await expect(helmDeploy(c, { release: 'web', org: 'o', repo: 'r', slot: 'purple' })).rejects.toThrow(/slot/)
  })

  it('helm-promote forwards force and reports the new active slot', async () => {
    const { c, calls } = slotCtx()
    const res = await helmPromote(c, { release: 'web', force: true })
    expect(calls.promote[0]).toMatchObject({ release: 'web', force: true })
    expect(res.data).toMatchObject({ active_slot: 'green' })
  })

  it('helm-rollback-release reports the slot', async () => {
    const { c } = slotCtx()
    const res = await helmRollbackRelease(c, { release: 'web' })
    expect(res.data).toMatchObject({ active_slot: 'blue' })
  })
})
