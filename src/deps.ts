import type { Bus } from '@abc-protocol/sdk'
import {
  getFileViaAgent,
  ingestFileViaAgent,
  publishMailboxEvent,
  sessionToken,
  sessionVarKey,
  tenantKVKey,
  TypedToolError,
  VARS_BUCKET,
} from '@abc-protocol/sdk'
import { tr } from './i18n.js'
import type { SessionEditState } from './tools/edit-state.js'

/**
 * Host hooks backed by the agent's file RPCs. The extension owns no blob
 * backend: it routes bytes through the agent, which persists them and (for
 * ingest) DERIVES the content type from the bytes — callers send no mime.
 */
export interface WorkspaceDeps {
  /** Persist bytes through the agent and return the canonical `file:<code>`
   *  plus the agent-derived mime. */
  ingestFile: (input: {
    name: string
    data: Uint8Array
    session?: string
    tenant?: string
  }) => Promise<{ code: string; mime: string }>
  /** Fetch stored bytes through the agent (used by `download`). */
  getFile: (
    code: string,
    tenant?: string,
  ) => Promise<{ data: Uint8Array; name: string; mime: string }>
  /**
   * Read a session variable the agent projects (vars bucket, provider "agent"),
   * e.g. `locale`. Returns '' when unset. Used to localize tool results.
   */
  getSessionVariable: (
    tenant: string,
    provider: string,
    sessionName: string,
    name: string,
  ) => Promise<string>
  /** Load the session's read-before-edit state ('' when never stored). */
  loadEditState: (tenant: string, sessionName: string) => Promise<SessionEditState>
  /** Persist the session's read-before-edit state. */
  saveEditState: (
    tenant: string,
    sessionName: string,
    state: SessionEditState,
  ) => Promise<void>
  /** Delete the session's read-before-edit state (session deletion). */
  clearEditState: (tenant: string, sessionName: string) => Promise<void>
  /** Load a sandbox's last-synced-rev baseline (null when never stored). */
  loadSyncState?: (tenant: string, sandbox: string) => Promise<SandboxSyncState | null>
  /** Persist a sandbox's last-synced-rev baseline. */
  saveSyncState?: (tenant: string, sandbox: string, state: SandboxSyncState) => Promise<void>
  /** Publish a message into a session's durable NATS mailbox (wakes its turn).
   *  `source` is the message ORIGIN (`user` / `session:{name}` / `system:{name}`),
   *  carried to the agent so a consumer can tell a hand-off from a human prompt. */
  publishMailbox: (
    tenant: string,
    sessionName: string,
    type: string,
    payload: unknown,
    source?: string,
  ) => Promise<void>
}

function requireTenant(tenant: string | undefined, op: string): string {
  if (tenant === undefined || tenant === '') {
    // Defensive: the tenant always rides the protocol envelope, so this only
    // fires on host misconfiguration. Typed internal, text from the catalog.
    throw new TypedToolError('internal', tr('en', 'tenantRequired', { op }))
  }
  return tenant
}

/**
 * KV bucket for read-before-edit state. One key per (tenant, session) holding
 * every seen file, so a session deletion clears it in one op. The bus creates
 * the bucket on first use.
 */
export const EDIT_STATE_BUCKET = 'workspace-edit-state'

/**
 * KV bucket for per-sandbox sync baselines. One key per (tenant, sandbox)
 * holding the last rev (commit sha) whose tree was written into that sandbox,
 * so a later repo change can fan out only the paths that moved.
 */
export const SYNC_STATE_BUCKET = 'workspace-sandbox-sync'

/** A sandbox's last-synced baseline. */
export interface SandboxSyncState {
  /** The branch tip sha whose tree the sandbox currently holds. */
  rev: string
  /** The session the sandbox is bound to (`org:repo:branch`). */
  session: string
  /** Epoch millis of the last sync (diagnostics). */
  updatedAt: number
}

/** Default deps backed by the agent file RPCs (`abc.<tenant>.file.*`). */
export function agentFileDeps(bus: Bus): WorkspaceDeps {
  return {
    ingestFile: async ({ name, data, session, tenant }) => {
      const t = requireTenant(tenant, 'ingestFile')
      const { code, mime } = await ingestFileViaAgent(bus, t, {
        name,
        data,
        ...(session !== undefined && session !== ''
          ? { sessionName: session }
          : {}),
      })
      return { code, mime }
    },
    getFile: async (code, tenant) => {
      const t = requireTenant(tenant, 'getFile')
      const got = await getFileViaAgent(bus, t, code)
      if (got === null) {
        throw new TypedToolError('not_found', tr('en', 'fileNotFound', { code }))
      }
      return { data: got.data, name: got.meta.name, mime: got.meta.mime }
    },
    getSessionVariable: async (tenant, provider, sessionName, name) => {
      if (sessionName === '') return ''
      try {
        const v = await bus.kvGet(
          VARS_BUCKET,
          sessionVarKey(tenant, provider, sessionName, name),
        )
        return v ?? ''
      } catch {
        return ''
      }
    },
    loadEditState: async (tenant, sessionName) => {
      if (sessionName === '') return {}
      try {
        const raw = await bus.kvGet(
          EDIT_STATE_BUCKET,
          tenantKVKey(tenant, sessionToken(sessionName)),
        )
        if (raw === null || raw === '') return {}
        const parsed: unknown = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object'
          ? (parsed as SessionEditState)
          : {}
      } catch {
        return {}
      }
    },
    saveEditState: async (tenant, sessionName, state) => {
      if (sessionName === '') return
      await bus.kvPut(
        EDIT_STATE_BUCKET,
        tenantKVKey(tenant, sessionToken(sessionName)),
        JSON.stringify(state),
        0,
      )
    },
    publishMailbox: async (tenant, sessionName, type, payload, source) => {
      const t = requireTenant(tenant, 'publishMailbox')
      await publishMailboxEvent(bus, t, sessionName, type, payload, source ?? '')
    },
    clearEditState: async (tenant, sessionName) => {
      if (sessionName === '') return
      await bus
        .kvDelete(EDIT_STATE_BUCKET, tenantKVKey(tenant, sessionToken(sessionName)))
        .catch(() => {})
    },
    loadSyncState: async (tenant, sandbox) => {
      if (sandbox === '') return null
      try {
        const raw = await bus.kvGet(
          SYNC_STATE_BUCKET,
          tenantKVKey(tenant, sessionToken(sandbox)),
        )
        if (raw === null || raw === '') return null
        const parsed: unknown = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object'
          ? (parsed as SandboxSyncState)
          : null
      } catch {
        return null
      }
    },
    saveSyncState: async (tenant, sandbox, state) => {
      if (sandbox === '') return
      await bus.kvPut(
        SYNC_STATE_BUCKET,
        tenantKVKey(tenant, sessionToken(sandbox)),
        JSON.stringify(state),
        0,
      )
    },
  }
}
