import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import { tr } from '../i18n.js'
import { numArg, strArg } from './shared.js'

/** Context for the service-* tools (workspace gateway). */
export interface ServiceCtx {
  workspace: GatewayClient
  session: string
  locale: string
}

/**
 * The pod-diagnostic fields every service view carries (proto ServiceInfo
 * pod_phase/restarts/message). A service whose pod failed to start has no
 * logs, so these are the only explanation; surface them everywhere.
 */
interface PodDiag {
  pod_phase: string
  restarts: number
  message: string
}

/** Extract the diagnostic fields from a proto ServiceInfo (defaults empty). */
function podDiag(s: {
  podPhase?: string
  restarts?: number
  message?: string
}): PodDiag {
  return {
    pod_phase: s.podPhase ?? '',
    restarts: s.restarts ?? 0,
    message: s.message ?? '',
  }
}

/**
 * One line describing a pod's diagnostics, for the tool `content` (empty when
 * the pod is healthy and produced no message). `sep` joins the fields.
 */
function podDiagLine(locale: string, d: PodDiag): string {
  const parts: string[] = []
  if (d.pod_phase !== '') parts.push(`pod=${d.pod_phase}`)
  if (d.restarts > 0) parts.push(`restarts=${d.restarts}`)
  const base = parts.join(' ')
  if (d.message === '') return base
  const msg = tr(locale, 'servicePodMessage', { message: d.message })
  return base === '' ? msg : `${base} ${msg}`
}

/** `service-deploy`: run an image as a long-lived Deployment + Service. */
export async function serviceDeploy(
  ctx: ServiceCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const image = strArg(args, 'image')
  if (image === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'image' }))
  }
  const env = args['env']
  const envMap: Record<string, string> = {}
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === 'string') envMap[k] = v
    }
  }
  const command = args['command']
  const commandList = Array.isArray(command) ? command.filter((c): c is string => typeof c === 'string') : []
  const services = parseServices(args['services'])
  const volumes = parseVolumes(args['volumes'])
  const tier0 = parseTier0(args)
  const slot = strArg(args, 'slot')
  if (slot !== '' && slot !== 'blue' && slot !== 'green') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'serviceSlotInvalid'))
  }
  try {
    const res = await ctx.workspace.deployService(
      {
        name: strArg(args, 'name'),
        image,
        containerPort: Math.trunc(numArg(args, 'container-port') ?? 0),
        servicePort: Math.trunc(numArg(args, 'service-port') ?? 0),
        replicas: Math.trunc(numArg(args, 'replicas') ?? 0),
        env: envMap,
        cpu: strArg(args, 'cpu'),
        memory: strArg(args, 'memory'),
        command: commandList,
        kvm: args['kvm'] === true,
        gpuCount: Math.trunc(numArg(args, 'gpu-count') ?? 0),
        services,
        volumes,
        slot,
        ...tier0,
      },
      { headers: { 'X-Session-Name': ctx.session } },
    )
    const s = res.service
    if (s === undefined) {
      throw new TypedToolError('internal', tr(ctx.locale, 'serviceDeployFailed', { err: 'no service in response' }))
    }
    // One line per public port.
    const publics = (s.ports ?? [])
      .filter(p => p.publicUrl)
      .map(p => p.publicUrl)
    const note = publics.length
      ? '\n' + publics.map(u => tr(ctx.locale, 'servicePublicUrl', { url: u })).join('\n')
      : ''
    const slotNote = (s.slots ?? []).length
      ? '\n' + (s.slots ?? []).map(sl => tr(ctx.locale, 'serviceSlotLine', {
          slot: sl.slot, url: sl.publicUrl || sl.url, active: sl.slot === s.activeSlot ? ' *' : '',
        })).join('\n')
      : ''
    const diag = podDiag(s)
    const diagLine = podDiagLine(ctx.locale, diag)
    const diagNote = diagLine === '' ? '' : '\n' + diagLine
    return {
      content: tr(ctx.locale, 'serviceDeployed', { name: s.name, image: s.image, url: s.url }) + note + slotNote + diagNote,
      data: {
        name: s.name, image: s.image, url: s.url,
        public_url: publics[0] ?? '', public_urls: publics,
        ports: (s.ports ?? []).map(p => ({ name: p.name, preset: p.preset, port: p.port, protocol: p.protocol, target_port: p.targetPort, public_url: p.publicUrl })),
        phase: s.phase, ready: s.ready, replicas: s.replicas,
        active_slot: s.activeSlot,
        slots: (s.slots ?? []).map(sl => ({ slot: sl.slot, image: sl.image, ready: sl.ready, replicas: sl.replicas, ready_replicas: sl.readyReplicas, url: sl.url, public_url: sl.publicUrl })),
        ...diag,
      },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'serviceDeployFailed', { err: String(e) }))
  }
}

/** `service-promote`: switch a blue-green service's primary URL to the other slot. */
export async function servicePromote(
  ctx: ServiceCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  const force = args['force'] === true
  try {
    const res = await ctx.workspace.promoteService({ name, force })
    const s = res.service
    if (s === undefined) {
      throw new TypedToolError('internal', tr(ctx.locale, 'serviceDeployFailed', { err: 'no service in response' }))
    }
    return {
      content: tr(ctx.locale, 'servicePromoted', { name: s.name, slot: s.activeSlot }),
      data: { name: s.name, active_slot: s.activeSlot, image: s.image, ready: s.ready, url: s.url, public_url: s.publicUrl },
    }
  } catch (e) {
    throw new TypedToolError('retryable', tr(ctx.locale, 'servicePromoteFailed', { name, err: String(e) }))
  }
}

/** `service-rollback`: switch a blue-green service's primary URL back a slot. */
export async function serviceRollback(
  ctx: ServiceCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  try {
    const res = await ctx.workspace.rollbackService({ name })
    const s = res.service
    if (s === undefined) {
      throw new TypedToolError('internal', tr(ctx.locale, 'serviceDeployFailed', { err: 'no service in response' }))
    }
    return {
      content: tr(ctx.locale, 'serviceRolledBack', { name: s.name, slot: s.activeSlot }),
      data: { name: s.name, active_slot: s.activeSlot, image: s.image, ready: s.ready, url: s.url, public_url: s.publicUrl },
    }
  } catch (e) {
    throw new TypedToolError('retryable', tr(ctx.locale, 'serviceRollbackFailed', { name, err: String(e) }))
  }
}

/** Parse the `volumes` array into the gateway VolumeMountSpec shape. */
function parseVolumes(
  raw: unknown,
): Array<{ pvc: string; mountPath: string; readOnly: boolean; subPath: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ pvc: string; mountPath: string; readOnly: boolean; subPath: string }> = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const pvc = typeof o['pvc'] === 'string' ? o['pvc'] : ''
    const mountPath = typeof o['mount-path'] === 'string' ? o['mount-path'] : typeof o['mountPath'] === 'string' ? o['mountPath'] : ''
    if (pvc === '' || mountPath === '') continue
    out.push({
      pvc,
      mountPath,
      readOnly: o['read-only'] === true || o['readOnly'] === true,
      subPath: typeof o['sub-path'] === 'string' ? o['sub-path'] : typeof o['subPath'] === 'string' ? o['subPath'] : '',
    })
  }
  return out
}

/** A parsed Tier 0 (single-Deployment enhancement) argument bundle. */
interface Tier0Args {
  resources?: {
    cpu: string
    memory: string
    cpuLimit: string
    memoryLimit: string
  }
  readinessProbe?: ProbeArgs
  livenessProbe?: ProbeArgs
  startupProbe?: ProbeArgs
  rollout?: { maxSurge: string; maxUnavailable: string }
  envRefs?: Array<{
    name: string
    configMap: string
    configKey: string
    secret: string
    secretKey: string
  }>
  envFrom?: Array<{ configMap: string; secret: string }>
  configMounts?: Array<{
    configMap: string
    secret: string
    mountPath: string
    items: Array<{ key: string; path: string }>
  }>
  sidecars?: Array<{
    name: string
    image: string
    command: string[]
    env: Record<string, string>
    cpu: string
    memory: string
    init: boolean
  }>
  nodeSelector?: Record<string, string>
  tolerations?: Array<{ key: string; operator: string; value: string; effect: string }>
}

interface ProbeArgs {
  httpPath: string
  httpPort: number
  tcpPort: number
  execCommand: string[]
  initialDelaySeconds: number
  periodSeconds: number
  timeoutSeconds: number
  failureThreshold: number
  successThreshold: number
}

function strMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function strList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : []
}

function objList(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x),
  )
}

function parseProbe(raw: unknown): ProbeArgs | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  return {
    httpPath: typeof o['http-path'] === 'string' ? o['http-path'] : '',
    httpPort: Math.trunc(Number(o['http-port'] ?? 0)) || 0,
    tcpPort: Math.trunc(Number(o['tcp-port'] ?? 0)) || 0,
    execCommand: strList(o['exec-command']),
    initialDelaySeconds: Math.trunc(Number(o['initial-delay-seconds'] ?? 0)) || 0,
    periodSeconds: Math.trunc(Number(o['period-seconds'] ?? 0)) || 0,
    timeoutSeconds: Math.trunc(Number(o['timeout-seconds'] ?? 0)) || 0,
    failureThreshold: Math.trunc(Number(o['failure-threshold'] ?? 0)) || 0,
    successThreshold: Math.trunc(Number(o['success-threshold'] ?? 0)) || 0,
  }
}

/**
 * Parse the optional Tier 0 arguments for service-deploy into the gateway
 * request fields. Every field is omitted when absent so a plain deploy request
 * stays minimal.
 */
function parseTier0(args: Record<string, unknown>): Tier0Args {
  const out: Tier0Args = {}
  const res = args['resources']
  if (res !== null && typeof res === 'object' && !Array.isArray(res)) {
    const o = res as Record<string, unknown>
    out.resources = {
      cpu: typeof o['cpu'] === 'string' ? o['cpu'] : '',
      memory: typeof o['memory'] === 'string' ? o['memory'] : '',
      cpuLimit: typeof o['cpu-limit'] === 'string' ? o['cpu-limit'] : '',
      memoryLimit: typeof o['memory-limit'] === 'string' ? o['memory-limit'] : '',
    }
  }
  const rp = parseProbe(args['readiness-probe'])
  if (rp) out.readinessProbe = rp
  const lp = parseProbe(args['liveness-probe'])
  if (lp) out.livenessProbe = lp
  const sp = parseProbe(args['startup-probe'])
  if (sp) out.startupProbe = sp
  const ro = args['rollout']
  if (ro !== null && typeof ro === 'object' && !Array.isArray(ro)) {
    const o = ro as Record<string, unknown>
    out.rollout = {
      maxSurge: typeof o['max-surge'] === 'string' ? o['max-surge'] : '',
      maxUnavailable: typeof o['max-unavailable'] === 'string' ? o['max-unavailable'] : '',
    }
  }
  const er = objList(args['env-refs']).map(o => ({
    name: typeof o['name'] === 'string' ? o['name'] : '',
    configMap: typeof o['config-map'] === 'string' ? o['config-map'] : '',
    configKey: typeof o['config-key'] === 'string' ? o['config-key'] : '',
    secret: typeof o['secret'] === 'string' ? o['secret'] : '',
    secretKey: typeof o['secret-key'] === 'string' ? o['secret-key'] : '',
  }))
  if (er.length) out.envRefs = er
  const ef = objList(args['env-from']).map(o => ({
    configMap: typeof o['config-map'] === 'string' ? o['config-map'] : '',
    secret: typeof o['secret'] === 'string' ? o['secret'] : '',
  }))
  if (ef.length) out.envFrom = ef
  const cm = objList(args['config-mounts']).map(o => ({
    configMap: typeof o['config-map'] === 'string' ? o['config-map'] : '',
    secret: typeof o['secret'] === 'string' ? o['secret'] : '',
    mountPath: typeof o['mount-path'] === 'string' ? o['mount-path'] : '',
    items: objList(o['items']).map(it => ({
      key: typeof it['key'] === 'string' ? it['key'] : '',
      path: typeof it['path'] === 'string' ? it['path'] : '',
    })),
  }))
  if (cm.length) out.configMounts = cm
  const sc = objList(args['sidecars']).map(o => ({
    name: typeof o['name'] === 'string' ? o['name'] : '',
    image: typeof o['image'] === 'string' ? o['image'] : '',
    command: strList(o['command']),
    env: strMap(o['env']),
    cpu: typeof o['cpu'] === 'string' ? o['cpu'] : '',
    memory: typeof o['memory'] === 'string' ? o['memory'] : '',
    init: o['init'] === true,
  }))
  if (sc.length) out.sidecars = sc
  const ns = strMap(args['node-selector'])
  if (Object.keys(ns).length) out.nodeSelector = ns
  const tol = objList(args['tolerations']).map(o => ({
    key: typeof o['key'] === 'string' ? o['key'] : '',
    operator: typeof o['operator'] === 'string' ? o['operator'] : '',
    value: typeof o['value'] === 'string' ? o['value'] : '',
    effect: typeof o['effect'] === 'string' ? o['effect'] : '',
  }))
  if (tol.length) out.tolerations = tol
  return out
}

/** Parse the `services` port array into the gateway shape. */
function parseServices(raw: unknown): Array<{ name: string; preset: string; targetPort: number }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; preset: string; targetPort: number }> = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    out.push({
      name: typeof o['name'] === 'string' ? o['name'] : '',
      preset: typeof o['preset'] === 'string' ? o['preset'] : 'tcp80',
      targetPort: Math.trunc(Number(o['target-port'] ?? o['targetPort'] ?? 0)) || 0,
    })
  }
  return out
}

/** `service-list`: list the tenant's services. */
export async function serviceList(
  ctx: ServiceCtx,
  _args: Record<string, unknown>,
): Promise<ToolResultData> {
  const res = await ctx.workspace.listServices({})
  const svcs = res.services
  if (svcs.length === 0) return { content: tr(ctx.locale, 'serviceNone') }
  const lines = svcs.map(s => {
    const publics = (s.ports ?? []).filter(p => p.publicUrl).map(p => p.publicUrl)
    const ports = (s.ports ?? [])
      .map(p => `${p.protocol}:${p.port}${p.name ? `(${p.name})` : ''}->${p.targetPort}`)
      .join(',')
    const slots = (s.slots ?? []).length
      ? `  slots=${(s.slots ?? []).map(sl => `${sl.slot}${sl.slot === s.activeSlot ? '*' : ''}(${sl.ready ? 'ready' : 'not-ready'})`).join(',')}`
      : ''
    const diagLine = podDiagLine(ctx.locale, podDiag(s))
    return (
      `${s.name}  [${s.phase}${s.ready ? ', ready' : ''}]  ${s.image}  ${s.url}  x${s.replicas}` +
      (ports ? `  ports=${ports}` : '') +
      (publics.length ? `  public=${publics.join(',')}` : '') +
      slots +
      (diagLine ? `  ${diagLine}` : '') +
      `  session=${s.session || '-'}`
    )
  })
  return {
    content: tr(ctx.locale, 'serviceListHeader', { count: svcs.length }) + '\n' + lines.join('\n'),
    data: {
      count: svcs.length,
      services: svcs.map(s => ({
        name: s.name,
        phase: s.phase,
        image: s.image,
        url: s.url,
        session: s.session,
        replicas: s.replicas,
        ready_replicas: s.readyReplicas,
        ready: s.ready,
        publicUrl: (s.ports ?? []).filter(p => p.publicUrl).map(p => p.publicUrl)[0] ?? '',
        active_slot: s.activeSlot,
        slots: (s.slots ?? []).map(sl => ({ slot: sl.slot, image: sl.image, ready: sl.ready, replicas: sl.replicas, ready_replicas: sl.readyReplicas, url: sl.url, public_url: sl.publicUrl })),
        ...podDiag(s),
      })),
    },
  }
}

/** `service-logs`: read a service's container log (tail, optionally previous). */
export async function serviceLogs(
  ctx: ServiceCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  const tail = Math.trunc(numArg(args, 'tail-lines') ?? 0)
  const previous = args['previous'] === true
  try {
    const res = await ctx.workspace.serviceLogs({ name, tailLines: BigInt(tail), previous })
    const lines = res.lines
    const diag = podDiag(res)
    const diagLine = podDiagLine(ctx.locale, diag)
    if (lines.length === 0) {
      // The container produced no logs: usually it never started (runc create
      // failure, image pull error, crash loop). Explain WHY instead of a bare
      // "no output", so the caller is not left guessing.
      const head = tr(ctx.locale, 'serviceLogsEmpty', { name })
      return {
        content: diagLine === '' ? head : `${head}\n${diagLine}`,
        data: { name, lines: 0, available: false, ...diag },
      }
    }
    return {
      content: tr(ctx.locale, 'serviceLogsHeader', { name, count: lines.length }) + '\n' + lines.join('\n'),
      data: { name, lines: lines.length, available: true, ...diag },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'serviceLogsFailed', { name, err: String(e) }))
  }
}

/** `service-delete`: delete a service. */
export async function serviceDelete(
  ctx: ServiceCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const name = strArg(args, 'name')
  if (name === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'name' }))
  const res = await ctx.workspace.deleteService({ name })
  return {
    content: res.ok ? tr(ctx.locale, 'serviceDeleted', { name }) : tr(ctx.locale, 'serviceNotFound', { name }),
    data: { name, deleted: res.ok },
  }
}
