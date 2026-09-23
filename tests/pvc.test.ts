import { describe, expect, it } from 'vitest'
import { pvcCreate, pvcDelete, pvcList } from '../src/tools/pvc.js'
import type { PVCContext } from '../src/tools/pvc.js'

function pvcCtx() {
  const calls: { create: unknown[]; list: number; del: unknown[] } = { create: [], list: 0, del: [] }
  const c = {
    workspace: {
      async createPVC(r: unknown) {
        calls.create.push(r)
        return { pvc: { name: 'data', size: '2Gi', storageClass: 'workspace-local', phase: 'Pending' } }
      },
      async listPVCs() {
        calls.list++
        return { pvcs: [{ name: 'data', size: '2Gi', storageClass: 'workspace-local', phase: 'Bound', mountedBy: ['app'] }] }
      },
      async deletePVC(r: unknown) {
        calls.del.push(r)
        return { ok: true }
      },
    },
    locale: 'en',
  } as unknown as PVCContext
  return { c, calls }
}

describe('pvc tools', () => {
  it('pvc-create forwards name/size/storage-class', async () => {
    const { c, calls } = pvcCtx()
    const res = await pvcCreate(c, { name: 'data', size: '2Gi', 'storage-class': 'workspace-local' })
    expect(calls.create[0]).toMatchObject({ name: 'data', size: '2Gi', storageClass: 'workspace-local' })
    expect(res.data).toMatchObject({ name: 'data', size: '2Gi', phase: 'Pending' })
  })

  it('pvc-create requires a name', async () => {
    const { c, calls } = pvcCtx()
    await expect(pvcCreate(c, {})).rejects.toThrow(/name/)
    expect(calls.create).toHaveLength(0)
  })

  it('pvc-list returns the claims with mounted_by', async () => {
    const { c } = pvcCtx()
    const res = await pvcList(c, {})
    expect(res.data).toMatchObject({ count: 1 })
    expect((res.data as { pvcs: unknown[] }).pvcs[0]).toMatchObject({ name: 'data', mounted_by: ['app'] })
  })

  it('pvc-delete forwards the name', async () => {
    const { c, calls } = pvcCtx()
    const res = await pvcDelete(c, { name: 'data' })
    expect(calls.del[0]).toMatchObject({ name: 'data' })
    expect(res.data).toMatchObject({ name: 'data', deleted: true })
  })
})
