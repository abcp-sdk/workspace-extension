import { TypedToolError } from '@abc-protocol/sdk'
import type { WorkerClient } from '../client.js'
import { tr } from '../i18n.js'
import { AndroidPlatform, type Platform, Xa11yPlatform } from './platform.js'

/**
 * A resolved computer-use target: a sandbox name bound to the worker client and
 * the platform driver that talks to it. Tools receive this directly; there is
 * no context id or session binding.
 */
export interface SandboxTarget {
  sandbox: string
  platform: Platform
  client: WorkerClient
}

/** The platform families a computer-use target can be driven on. */
export type PlatformId = 'linux' | 'android' | 'windows' | 'macos'

/**
 * Decide the platform from the sandbox OS reported by the worker.
 *
 * An unknown/empty OS is treated as Linux: the desktop image's worker is
 * Linux, and it is the safe default for the X11 sandbox.
 */
export function detectPlatform(os: string): PlatformId {
  const s = os.trim().toLowerCase()
  if (s === 'android') return 'android'
  if (s === 'windows') return 'windows'
  if (s === 'darwin' || s === 'macos') return 'macos'
  return 'linux'
}

/** Build the `Platform` driver for a detected platform id. */
export function createPlatform(client: WorkerClient, id: PlatformId): Platform {
  return id === 'android'
    ? new AndroidPlatform(client)
    : new Xa11yPlatform(client, id)
}

/**
 * Detect the sandbox platform (from the worker's own `info.os`), build its
 * driver, and gate on the accessibility tooling. Throws a typed error when the
 * sandbox is not a computer-use target.
 *
 * The gate prefers the worker's probed `capabilities` (see `worker.v1`): when
 * the worker reports them, a `xa11y=false` refuses IMMEDIATELY without running
 * a command (the desktop image sets `xa11y=true`; a plain `sandbox-<lang>` does
 * not). Android is gated on `adb` instead. When the worker is too old to report
 * capabilities, fall back to probing the CLI directly.
 *
 * `sandbox` is only used for error text.
 */
export async function probeTarget(
  client: WorkerClient,
  sandbox: string,
  locale: string,
): Promise<SandboxTarget> {
  let os = ''
  let caps: { xa11y: boolean } | undefined
  try {
    const info = await client.info({})
    os = info.os
    caps = info.capabilities
  } catch {
    os = ''
  }
  const id = detectPlatform(os)
  const platform = createPlatform(client, id)

  if (id !== 'android' && caps !== undefined && !caps.xa11y) {
    throw new TypedToolError('not_found', tr(locale, 'a11yMissing', { sandbox }))
  }
  try {
    await platform.probe()
  } catch {
    throw new TypedToolError('not_found', tr(locale, 'a11yMissing', { sandbox }))
  }
  return { sandbox, platform, client }
}
