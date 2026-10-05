import { TypedToolError } from '@abc-protocol/sdk'
import type { ComputerClient } from '../client.js'
import { tr } from '../i18n.js'

/**
 * A resolved computer-use target: a sandbox name bound to the worker's
 * **ComputerService** client. The worker owns the platform logic and picks the
 * right driver, so the extension is a thin proxy.
 */
export interface SandboxTarget {
  sandbox: string
  client: ComputerClient
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

/**
 * Probe the worker's ComputerService: a successful `Info` means the worker is a
 * computer-use target. Throws a typed error otherwise. `sandbox` is only used
 * for error text.
 */
export async function probeTarget(
  client: ComputerClient,
  sandbox: string,
  locale: string,
): Promise<SandboxTarget> {
  let tools: string[] = []
  try {
    tools = (await client.info({})).tools ?? []
  } catch {
    throw new TypedToolError('not_found', tr(locale, 'a11yMissing', { sandbox }))
  }
  // A plain `sandbox-<lang>` still answers Info (the ComputerService is always
  // mounted) but resolves to no GUI tools — refuse it the same way a missing
  // accessibility CLI used to be refused.
  if (tools.length === 0) {
    throw new TypedToolError('not_found', tr(locale, 'a11yMissing', { sandbox }))
  }
  return { sandbox, client }
}
