import { describe, expect, it } from 'vitest'
import type { LifecycleEvent } from '@abc-protocol/sdk'
import { Forgejo } from '../src/forgejo.js'
import { materializeLifecycle, parseSessionName } from '../src/tools/lifecycle.js'

/** A gateway-backed Forgejo recording branch creation. */
function fakeForgejo(initial: string[] = ['main']) {
  const calls: Array<{ method: string; req: Record<string, unknown> }> = []
  const branches = new Set<string>(initial)
  const created: Array<{ name: string; from: string }> = []
  const gateway = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        async (req: Record<string, unknown>) => {
          calls.push({ method: prop, req })
          if (prop === 'branches') {
            return { branches: [...branches].map(name => ({ name, sha: 'sha' })) }
          }
          if (prop === 'createBranch') {
            created.push({ name: req['name'] as string, from: req['from'] as string })
            branches.add(req['name'] as string)
            return { ok: true }
          }
          if (prop === 'repoMeta') {
            return { org: req['org'], repo: req['repo'], defaultBranch: 'main', private: true, empty: false }
          }
          return {}
        },
    },
  )
  return { branches, created, forgejo: new Forgejo({ gateway: gateway as never }) }
}

function ev(kind: LifecycleEvent['kind'], session: string, parent?: string): LifecycleEvent {
  return { kind, session_name: session, ...(parent !== undefined ? { parent } : {}) }
}

describe('parseSessionName', () => {
  it('parses org:repo:branch and rejects free names', () => {
    expect(parseSessionName('acme:web:main')).toEqual({ org: 'acme', repo: 'web', branch: 'main' })
    expect(parseSessionName('planner-1')).toBeNull()
    expect(parseSessionName('a:b')).toBeNull()
    expect(parseSessionName('a:b:c:d')).toBeNull()
  })
})

describe('materializeLifecycle', () => {
  it('created: creates a non-main branch from main', async () => {
    const { created, forgejo } = fakeForgejo()
    await materializeLifecycle(ev('created', 'acme:web:feat-x'), forgejo, 'en')
    expect(created).toEqual([{ name: 'feat-x', from: 'main' }])
  })

  it('created: leaves main alone', async () => {
    const { created, forgejo } = fakeForgejo()
    await materializeLifecycle(ev('created', 'acme:web:main'), forgejo, 'en')
    expect(created).toEqual([])
  })

  it('forked: branches from the parent branch', async () => {
    const { created, forgejo } = fakeForgejo(['main', 'feat-x'])
    await materializeLifecycle(ev('forked', 'acme:web:feat-y', 'acme:web:feat-x'), forgejo, 'en')
    expect(created).toEqual([{ name: 'feat-y', from: 'feat-x' }])
  })

  it('forked: ignores a cross-repo parent', async () => {
    const { created, forgejo } = fakeForgejo()
    await materializeLifecycle(ev('forked', 'acme:web:feat-y', 'acme:api:feat-x'), forgejo, 'en')
    expect(created).toEqual([])
  })

  it('is idempotent (branch already present)', async () => {
    const { created, forgejo } = fakeForgejo()
    await materializeLifecycle(ev('created', 'acme:web:feat-x'), forgejo, 'en')
    await materializeLifecycle(ev('created', 'acme:web:feat-x'), forgejo, 'en')
    expect(created).toHaveLength(1)
  })

  it('ignores non-workspace session names', async () => {
    const { created, forgejo } = fakeForgejo()
    await materializeLifecycle(ev('created', 'my-planner'), forgejo, 'en')
    expect(created).toEqual([])
  })
})
