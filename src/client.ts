import type { Client, Interceptor } from '@connectrpc/connect'
import { Code, createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { TypedToolError } from '@abc-protocol/sdk'
import { WorkerService } from './gen/worker/v1/worker_pb.js'
import { BranchSessionService } from './gen/workspace/v1/workspace_pb.js'

/** A worker.v1 Connect client. */
export type WorkerClient = Client<typeof WorkerService>

/**
 * A workspace.v1 Connect client. The workspace GATEWAY owns the sandbox
 * lifecycle in-process (the old worker-manager was folded into it), so this
 * one client covers lifecycle + resolve.
 */
export type GatewayClient = Client<typeof BranchSessionService>

/** The address + credential an operation runs against. */
export interface WorkerEndpoint {
  /** Base URL of an easyworker, e.g. `http://127.0.0.1:9090`. */
  url: string
  /** Worker bearer token (empty only when the worker runs with auth off). */
  token: string
}

/** Attach `Authorization: Bearer <token>` to every unary + streaming call. */
export function bearerInterceptor(token: string): Interceptor {
  return next => async req => {
    if (token !== '') req.header.set('Authorization', `Bearer ${token}`)
    return next(req)
  }
}

/** Trim trailing slashes so `baseUrl` never ends in `/`. */
export function normalizeUrl(raw: string): string {
  let s = raw.trim()
  while (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** Build a bearer-authenticated worker client (h1, matching easyworker). */
export function createWorkerClient(ep: WorkerEndpoint): WorkerClient {
  const transport = createConnectTransport({
    baseUrl: normalizeUrl(ep.url),
    httpVersion: '1.1',
    interceptors: [bearerInterceptor(ep.token)],
  })
  return createClient(WorkerService, transport)
}

/** Build a bearer-authenticated workspace-gateway client (h1).
 *
 * `tenant` is sent as `X-Abc-Tenant`: the extension authenticates with the
 * shared SERVICE token, and the gateway trusts this header to act on behalf of
 * the REAL tenant (so created sessions/sandboxes belong to that tenant, not the
 * synthetic service tenant).
 *
 * `session` is sent as `X-Session-Name`: the gateway uses it to enforce SESSION
 * isolation — an agent session may only touch sandboxes bound to its own
 * session (a feature branch must never drive another session's sandbox). */
export function createGatewayClient(
  baseUrl: string,
  token: string,
  tenant = '',
  session = '',
): GatewayClient {
  const transport = createConnectTransport({
    baseUrl: normalizeUrl(baseUrl),
    httpVersion: '1.1',
    interceptors: [
      tenantInterceptor(tenant),
      sessionInterceptor(session),
      bearerInterceptor(token),
    ],
  })
  return createClient(BranchSessionService, transport)
}

/** Attach `X-Session-Name` to every call (no-op when session is empty). */
function sessionInterceptor(session: string): Interceptor {
  return next => async req => {
    if (session !== '') req.header.set('X-Session-Name', session)
    return next(req)
  }
}

/** Attach `X-Abc-Tenant` to every call (no-op when tenant is empty). */
function tenantInterceptor(tenant: string): Interceptor {
  return next => async req => {
    if (tenant !== '') req.header.set('X-Abc-Tenant', tenant)
    return next(req)
  }
}

/**
 * Client cache keyed by `(url, token)`. Rebuilt when either changes; capped
 * (LRU) so a misconfigured URL cannot grow the map without bound.
 */
export class WorkerClientCache {
  private readonly clients = new Map<string, WorkerClient>()

  constructor(private readonly max = 16) {}

  get(ep: WorkerEndpoint): WorkerClient {
    const url = normalizeUrl(ep.url)
    const key = `${url}\u0000${ep.token}`
    const hit = this.clients.get(key)
    if (hit !== undefined) {
      this.clients.delete(key) // refresh LRU order
      this.clients.set(key, hit)
      return hit
    }
    const client = createWorkerClient({ url, token: ep.token })
    this.clients.set(key, client)
    if (this.clients.size > this.max) {
      const oldest = this.clients.keys().next().value
      if (oldest !== undefined) this.clients.delete(oldest)
    }
    return client
  }

  clear(): void {
    this.clients.clear()
  }
}

/** The `(url, token)` resolved for a sandbox, cached briefly per name. */
interface Resolved {
  endpoint: WorkerEndpoint
  at: number
}

/**
 * Resolves a sandbox name to its worker endpoint via the gateway, with a short
 * TTL cache so a burst of tool calls in one turn does not re-hit the gateway.
 */
export class WorkerResolver {
  private readonly cache = new Map<string, Resolved>()

  constructor(
    private readonly workspace: GatewayClient,
    private readonly ttlMs = 30_000,
  ) {}

  async resolve(name: string): Promise<WorkerEndpoint> {
    const hit = this.cache.get(name)
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs) return hit.endpoint
    let res: Awaited<ReturnType<GatewayClient['resolveSandbox']>>
    try {
      res = await this.workspace.resolveSandbox({ name })
    } catch (e) {
      // The gateway hides another session's sandbox as NotFound; surface it as
      // a typed not_found so the tool layer does not report a bare `internal`.
      // Match structurally (numeric Code or the `[not_found]` prefix) because a
      // duplicate @connectrpc/connect instance can defeat `instanceof`.
      const code = (e as { code?: unknown }).code
      if (code === Code.NotFound || String(e).includes('[not_found]')) {
        throw new TypedToolError('not_found', `sandbox not found: ${name}`)
      }
      throw e
    }
    const endpoint: WorkerEndpoint = { url: res.url, token: res.token }
    this.cache.set(name, { endpoint, at: Date.now() })
    return endpoint
  }

  invalidate(name: string): void {
    this.cache.delete(name)
  }

  clear(): void {
    this.cache.clear()
  }
}
