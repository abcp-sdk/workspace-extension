import { TypedToolError } from '@abc-protocol/sdk'
import { tr } from './i18n.js'

/** Config knob names (single source of truth for the manifest + readers). */
export const CONFIG = {
  gatewayUrl: 'gateway-url',
  gatewayToken: 'gateway-token',
} as const

/** sandbox-* tools require the workspace gateway (sandbox lifecycle). */
export const SANDBOX_REQUIRED = [CONFIG.gatewayUrl, CONFIG.gatewayToken]
/**
 * repo-* tools go through the workspace GATEWAY (which owns the Forgejo
 * credentials and enforces tenant ownership), so they require the gateway.
 */
export const REPO_REQUIRED = [CONFIG.gatewayUrl, CONFIG.gatewayToken]
/** checkout/port bridge a repo and a sandbox (both via the gateway). */
export const BRIDGE_REQUIRED = [CONFIG.gatewayUrl, CONFIG.gatewayToken]
/** repo-build-image needs the workspace gateway (it runs the build). */
export const BUILD_REQUIRED = [CONFIG.gatewayUrl, CONFIG.gatewayToken]

export type GetConfig = (name: string, sessionName?: string, tenant?: string) => unknown

/** Read a config string ('' when unset/wrong type). */
export function cfgRaw(get: GetConfig, name: string, session: string, tenant: string): string {
  const v = get(name, session, tenant)
  return typeof v === 'string' ? v.trim() : ''
}

/** Read a REQUIRED config string, throwing a typed error when unset. */
export function cfgString(
  get: GetConfig,
  name: string,
  session: string,
  tenant: string,
  locale: string,
): string {
  const v = cfgRaw(get, name, session, tenant)
  if (v === '') {
    throw new TypedToolError('invalid_argument', tr(locale, 'notConfigured', { name }))
  }
  return v
}

/** The workspace-gateway endpoint (sandbox-* tools). */
export interface GatewayConfig {
  url: string
  token: string
}

export function gatewayConfig(get: GetConfig, session: string, tenant: string, locale: string): GatewayConfig {
  return {
    url: cfgString(get, CONFIG.gatewayUrl, session, tenant, locale),
    token: cfgString(get, CONFIG.gatewayToken, session, tenant, locale),
  }
}
