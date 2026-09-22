import { describe, expect, it } from 'vitest'
import type { Bus } from '@abc-protocol/sdk'
import { agentFileDeps } from '../src/deps.js'

/**
 * `publishMailbox` must forward the message ORIGIN (`source`) to the SDK's
 * `publishMailboxEvent`; a dropped source shows up as a generic message in the
 * UI. The SDK publishes via `bus.inboxPublish`, so a fake bus captures the
 * envelope.
 */
function fakeBus() {
  const published: Array<{ ch: string; payload: unknown }> = []
  const bus = {
    async inboxPublish(ch: string, payload: unknown) {
      published.push({ ch, payload })
    },
  } as unknown as Bus
  return { bus, published }
}

describe('agentFileDeps.publishMailbox', () => {
  it('forwards the source into the mailbox envelope', async () => {
    const { bus, published } = fakeBus()
    const deps = agentFileDeps(bus)

    await deps.publishMailbox('acme', 'acme:web:main', 'trigger', { text: 'hi' }, 'session:acme:web:feature')

    expect(published).toHaveLength(1)
    const env = published[0]!.payload as { type: string; source: string; payload: unknown }
    expect(env.type).toBe('trigger')
    expect(env.source).toBe('session:acme:web:feature')
    expect(env.payload).toEqual({ text: 'hi' })
  })

  it('defaults the source to an empty string when omitted', async () => {
    const { bus, published } = fakeBus()
    const deps = agentFileDeps(bus)

    await deps.publishMailbox('acme', 'acme:web:main', 'trigger', { text: 'hi' })

    const env = published[0]!.payload as { source: string }
    expect(env.source).toBe('')
  })
})
