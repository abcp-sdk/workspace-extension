import { describe, expect, it } from 'vitest'
import type { LifecycleEvent } from '@abc-protocol/sdk'
import { Forgejo } from '../src/forgejo.js'
import { materializeLifecycle, parseSessionName } from '../src/tools/lifecycle.js'

/** A fake Forgejo recording branch operations. */
function fakeForgejo(initial: string[] = ['main']) {
  const branches = new Set<string>(initial)
  const created: Array<{ name: string; from: string }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('/branches') && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { new_branch_name: string; old_ref_name: string }
      created.push({ name: body.new_branch_name, from: body.old_ref_name })
      branches.add(body.new_branch_name)
      return new Response('{}')
    }
    if (u.includes('/branches') && method === 'GET') {
      const rows = [...branches].map(name => ({ name, commit: { id: 'sha' } }))
      return new Response(JSON.stringify(rows))
    }
    if (u.includes('/repos/') && method === 'GET') {
      return new Response(JSON.stringify({ default_branch: 'main' }))
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { branches, created, forgejo: new Forgejo({ url: 'http://f.test', auth: { token: 'x' }, fetchImpl }) }
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
