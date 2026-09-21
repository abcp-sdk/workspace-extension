import { TypedToolError } from '@abc-protocol/sdk'
import type { ForgejoAuth } from './forgejo.js'
import { tr } from './i18n.js'

/** Config knob names (single source of truth for the manifest + readers). */
export const CONFIG = {
  gatewayUrl: 'gateway-url',
  gatewayToken: 'gateway-token',
  forgejoUrl: 'forgejo-url',
  forgejoToken: 'forgejo-token',
  forgejoUser: 'forgejo-user',
  forgejoPassword: 'forgejo-password',
} as const

/** sandbox-* tools require the workspace gateway (sandbox lifecycle). */
export const SANDBOX_REQUIRED = [CONFIG.gatewayUrl, CONFIG.gatewayToken]
/**
 * repo-* tools require a Forgejo endpoint. Auth (token OR user/password) is
 * resolved at call time because `requiredConfig` is an AND gate and cannot
 * express "one of these".
 */
export const REPO_REQUIRED = [CONFIG.forgejoUrl]
/** checkout/port bridge a repo and a sandbox (both backends). */
export const BRIDGE_REQUIRED = [CONFIG.gatewayUrl, CONFIG.gatewayToken, CONFIG.forgejoUrl]
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

/** The Forgejo endpoint + resolved auth (repo-* tools). */
export interface ForgejoConfig {
  url: string
  auth: ForgejoAuth
}

/**
 * Resolve the Forgejo endpoint + auth. `forgejo-url` is required; auth is
 * `token` when set, otherwise `user`/`password` when both are set. Neither
 * present is an error with a clear remediation message.
 */
export function forgejoConfig(
  get: GetConfig,
  session: string,
  tenant: string,
  locale: string,
): ForgejoConfig {
  const url = cfgString(get, CONFIG.forgejoUrl, session, tenant, locale)
  const token = cfgRaw(get, CONFIG.forgejoToken, session, tenant)
  if (token !== '') return { url, auth: { token } }
  const user = cfgRaw(get, CONFIG.forgejoUser, session, tenant)
  const password = cfgRaw(get, CONFIG.forgejoPassword, session, tenant)
  if (user !== '' && password !== '') return { url, auth: { user, password } }
  throw new TypedToolError('invalid_argument', tr(locale, 'forgejoNoAuth'))
}
