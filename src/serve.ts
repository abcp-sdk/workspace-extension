import { Extension, type Bus, connectNatsBus } from '@abc-protocol/sdk'
import { createWorkspaceConfig } from './index.js'

export interface ServeWorkspaceOpts {
  /** NATS URL the extension connects to (shared with the agent). */
  natsUrl: string
}

/**
 * Connect to NATS and serve the workspace extension. The URL + token are read
 * per call from extension config, so serving needs no worker details up front.
 * Resolves once the extension has registered; returns a stop function.
 */
export async function serveWorkspace(
  opts: ServeWorkspaceOpts,
): Promise<{ stop: () => Promise<void>; bus: Bus }> {
  const bus = await connectNatsBus(opts.natsUrl)
  let ext: Extension | undefined
  const config = createWorkspaceConfig(bus, {
    getConfig: (name, sessionName, tenant) =>
      ext?.getConfig(name, sessionName, tenant ?? ''),
  })
  ext = new Extension(bus, config)
  await ext.serve()
  return {
    bus,
    stop: async () => {
      await ext?.close()
    },
  }
}
