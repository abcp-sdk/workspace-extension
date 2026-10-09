import type {
  Bus,
  ExtensionConfig,
  ToolResultData,
  ToolSpec,
} from '@abc-protocol/sdk'
import { manifestConfig, parseManifest, TypedToolError } from '@abc-protocol/sdk'
import manifestYaml from '../manifest.yaml'
import {
  createComputerClient,
  createGatewayClient,
  type ComputerClient,
  type WorkerClient,
  WorkerClientCache,
  WorkerResolver,
  workerAnchors,
  type GatewayClient,
} from './client.js'
import { agentFileDeps, type WorkspaceDeps } from './deps.js'
import { Forgejo } from './forgejo.js'
import {
  CONFIG,
  gatewayConfig,
  type GatewayConfig,
} from './config.js'
import { localeOf, tr } from './i18n.js'
import { materializeLifecycle, parseSessionName } from './tools/lifecycle.js'
import { domainOf, expandPathArgs, strArg } from './tools/shared.js'
import {
  downloadFile,
  type FileCtx,
  listFiles,
  patchFile,
  readFile,
  uploadFile,
} from './tools/files.js'
import {
  execCommand,
  type JobCtx,
  jobKill,
  jobList,
  jobOutput,
  jobStart,
  jobStdin,
  jobWait,
} from './tools/jobs.js'
import {
  repoList,
  repoRead,
  type RepoCtx,
} from './tools/repo-content.js'
import {
  repoBranches,
  repoDiff,
  repoExplore,
  repoLog,
  repoMrClose,
  repoMrComment,
  repoMrList,
  repoMrMerge,
  repoShow,
  repoTagCreate,
  repoTags,
} from './tools/repo-history.js'
import {
  repoCreateOrg,
  repoCreateRepo,
  repoDeletePushMirror,
  repoImport,
  repoListPushMirrors,
  repoRemove,
  repoSetPushMirror,
} from './tools/repo-admin.js'
import { repoMailSend, type MailCtx } from './tools/mail.js'
import { sandboxCheckout, sandboxSubmitMR, type BridgeCtx } from './tools/bridge.js'
import {
  branchRefOf,
  checkoutIntoSandbox,
  fanoutNote,
  fanoutRef,
  recordBaseline,
} from './tools/fanout.js'
import * as C from './computer/tools.js'
import { probeTarget, type SandboxTarget } from './computer/target.js'
import {
  renderInfo,
  sandboxCreate,
  sandboxDelete,
  listOCIImages,
  sandboxList,
  sandboxStatus,
  type SandboxCtx,
} from './tools/sandbox.js'
import { ociImport, repoBuildImage, repoBuildStatus, type BuildCtx } from './tools/imagebuild.js'
import {
  serviceDelete,
  serviceDeploy,
  serviceList,
  serviceLogs,
  serviceRollback,
  type ServiceCtx,
} from './tools/services.js'
import {
  pvcCreate,
  pvcDelete,
  pvcList,
  type PVCContext,
} from './tools/pvc.js'
import {
  helmDeploy,
  helmHistory,
  helmList,
  helmRollback,
  helmUninstall,
  helmObjects,
  helmObjectLogs,
  type HelmCtx,
} from './tools/helm.js'

export const EXT_ID = 'workspace'
export const EXT_VERSION = '0.20.0'

/** Config names (re-exported for tests). */
export const CONFIG_MANAGER_URL = CONFIG.gatewayUrl
export const CONFIG_MANAGER_TOKEN = CONFIG.gatewayToken

type Handlers = Record<string, ToolSpec['execute']>

export interface WorkspaceExtensionOpts {
  /** Read the effective config (session > global > default) for a tenant. */
  getConfig: (name: string, sessionName?: string, tenant?: string) => unknown
  deps?: WorkspaceDeps
  /** Worker client factory (overridable in tests). */
  makeClient?: (ep: { url: string; token: string }) => WorkerClient
  /** ComputerService client factory (overridable in tests). */
  makeComputerClient?: (ep: { url: string; token: string }) => ComputerClient
  /** Forgejo-backed repo client factory. It is built OVER a gateway client, so
   *  every repo operation is tenant-scoped server-side (overridable in tests). */
  makeForgejo?: (gateway: GatewayClient) => Forgejo
  /** Workspace-gateway client factory (overridable in tests). */
  makeManager?: (cfg: GatewayConfig, tenant: string, session: string) => GatewayClient
}

/**
 * Build the workspace extension: sandbox lifecycle (workspace gateway), sandbox
 * execution (agent-worker), repo-* tools (Forgejo) and the checkout/port bridge.
 * Config is resolved per call.
 *
 * `bus` is only needed for the agent file RPCs (sandbox-file-download/upload).
 */
export function createWorkspaceConfig(
  bus: Bus | undefined,
  opts: WorkspaceExtensionOpts,
): ExtensionConfig {
  const deps = opts.deps ?? (bus !== undefined ? agentFileDeps(bus) : undefined)
  const cache = new WorkerClientCache()
  const makeClient = opts.makeClient ?? ((ep: { url: string; token: string }) => cache.get(ep))
  const makeComputerClient = opts.makeComputerClient ?? ((ep: { url: string; token: string }) => createComputerClient(ep))
  const makeForgejo = opts.makeForgejo ?? ((gateway: GatewayClient) => new Forgejo({ gateway }))
  const makeManager =
    opts.makeManager ??
    ((cfg: GatewayConfig, tenant: string, session: string) =>
      createGatewayClient(cfg.url, cfg.token, tenant, session))

  // One gateway client + resolver per (url, token, tenant, session), reused
  // across calls. The tenant is sent as X-Abc-Tenant and the session as
  // X-Session-Name (the gateway enforces tenant + session isolation from them).
  const managers = new Map<string, { client: GatewayClient; resolver: WorkerResolver }>()
  const managerKey = (cfg: GatewayConfig, tenant: string, session: string): string =>
    `${cfg.url}\u0000${cfg.token}\u0000${tenant}\u0000${session}`
  const managerFor = (session: string, tenant: string, locale: string): GatewayClient => {
    const cfg = gatewayConfig(opts.getConfig, session, tenant, locale)
    const key = managerKey(cfg, tenant, session)
    let hit = managers.get(key)
    if (hit === undefined) {
      const client = makeManager(cfg, tenant, session)
      hit = { client, resolver: new WorkerResolver(client) }
      // Bound the cache (LRU): a long-lived extension serves many sessions.
      if (managers.size >= 128) {
        const oldest = managers.keys().next().value
        if (oldest !== undefined) managers.delete(oldest)
      }
      managers.set(key, hit)
    }
    return hit.client
  }
  const resolverFor = (session: string, tenant: string, locale: string): WorkerResolver => {
    const cfg = gatewayConfig(opts.getConfig, session, tenant, locale)
    managerFor(session, tenant, locale)
    return managers.get(managerKey(cfg, tenant, session))!.resolver
  }

  const repoClient = (session: string, tenant: string, locale: string): Forgejo =>
    makeForgejo(managerFor(session, tenant, locale))

  /** Resolve the sandbox named by `worker-name` to a live worker client. */
  const resolveWorkerClient = async (
    args: Record<string, unknown>,
    session: string,
    tenant: string,
    locale: string,
  ): Promise<WorkerClient> => {
    const ep = await resolveWorkerEndpoint(args, session, tenant, locale)
    return makeClient(ep)
  }

  /** Resolve the sandbox's endpoint (url + token). */
  const resolveWorkerEndpoint = async (
    args: Record<string, unknown>,
    session: string,
    tenant: string,
    locale: string,
  ): Promise<{ url: string; token: string }> => {
    const name = strArg(args, 'worker-name')
    if (name === '') {
      throw new TypedToolError('invalid_argument', tr(locale, 'workerNameRequired'))
    }
    return resolverFor(session, tenant, locale).resolve(name)
  }

  /** Wrap a sandbox (worker) tool; resolves `worker-name` -> endpoint. */
  const wrap = (
    fn: (ctx: { client: WorkerClient; url: string; tenant: string; session: string; locale: string }, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      const ep = await resolveWorkerEndpoint(args ?? {}, s, t, locale)
      return fn({ client: makeClient(ep), url: ep.url, tenant: t, session: s, locale }, args ?? {})
    }

  const jobWrap = (
    fn: (ctx: JobCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      const a = args ?? {}
      const client = await resolveWorkerClient(a, s, t, locale)
      const expanded = expandPathArgs(a, PATH_KEYS, await workerAnchors(client))
      return fn(
        { client, locale, ...(signal !== undefined ? { signal } : {}) },
        expanded,
      )
    }

  const fileWrap = (
    fn: (ctx: FileCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] => {
    if (deps === undefined) {
      return async () => {
        throw new TypedToolError('internal', tr('en', 'fileToolsRequireBus'))
      }
    }
    return async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      const a = args ?? {}
      const client = await resolveWorkerClient(a, s, t, locale)
      // `~` is a client-side alias: expand it against the worker's home before
      // the path reaches the worker (which does not expand it).
      const anchors = await workerAnchors(client)
      const expanded = expandPathArgs(a, PATH_KEYS, anchors)
      return fn({ client, deps, tenant: t, session: s, locale }, expanded)
    }
  }

  /** Wrap a repo (Forgejo) tool. */
  const repoWrap = (
    fn: (ctx: RepoCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] => {
    if (deps === undefined) {
      return async () => {
        throw new TypedToolError('internal', tr('en', 'fileToolsRequireBus'))
      }
    }
    return async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      return fn(
        {
          forgejo: repoClient(s, t, locale), gateway: managerFor(s, t, locale), deps,
          tenant: t, session: s, locale,
          fanout: (org, repo, branch, newRev) => fanout(s, t, locale, org, repo, branch, newRev),
        },
        args ?? {},
      )
    }
  }

  /** Wrap a mail tool (needs both Forgejo for branch checks and deps for the mailbox). */
  const mailWrap = (
    fn: (ctx: MailCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] => {
    if (deps === undefined) {
      return async () => {
        throw new TypedToolError('internal', tr('en', 'fileToolsRequireBus'))
      }
    }
    return async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      return fn(
        {
          forgejo: repoClient(s, t, locale),
          gateway: managerFor(s, t, locale),
          tenant: t,
          session: s,
          locale,
          publishMailbox: deps.publishMailbox,
        },
        args ?? {},
      )
    }
  }

  /** Wrap a sandbox lifecycle (workspace gateway) tool. */
  const sandboxWrap = (
    fn: (ctx: SandboxCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      const resolveWorker = async (name: string) => {
        const ep = await resolverFor(s, t, locale).resolve(name)
        return { client: makeClient(ep), url: ep.url }
      }
      // A brand-new sandbox is materialized with the session's branch (a free
      // session has no branch and checks out nothing).
      const autoCheckout = async (sandbox: string): Promise<string> => {
        const ref = branchRefOf(s)
        if (ref === null) return ''
        const client = makeClient(await resolverFor(s, t, locale).resolve(sandbox))
        const done = await checkoutIntoSandbox(repoClient(s, t, locale), client, ref.org, ref.repo, ref.branch, ref.repo)
        await recordBaseline(
          { forgejo: repoClient(s, t, locale), deps, tenant: t, session: s, locale },
          sandbox, ref.org, ref.repo, ref.branch, ref.repo,
        )
        return tr(locale, 'checkoutDone', { org: ref.org, repo: ref.repo, ref: done.ref, dest: ref.repo, files: done.files })
      }
      return fn({ workspace: managerFor(s, t, locale), locale, session: s, resolveWorker, autoCheckout }, args ?? {})
    }

  /**
   * Fan a repo/branch change out to the session's sandboxes. Only acts when the
   * change targeted the session's OWN branch (a sandbox holds that branch, not
   * an arbitrary ref). Best-effort; returns the sandboxes updated.
   */
  const fanout = async (
    s: string,
    t: string,
    locale: string,
    org: string,
    repo: string,
    branch: string,
    newRev = '',
  ): Promise<number> => {
    if (s === '') return 0
    const ref = branchRefOf(s)
    if (ref === null) return 0
    // A write with no explicit ref lands on the repo default branch; for a
    // developer that is its own branch (main is protected), for a maintainer it
    // is main — both are the session's own branch, so '' matches too.
    if (ref.org !== org || ref.repo !== repo || (branch !== '' && branch !== ref.branch)) return 0
    const resolveWorker = async (name: string) => {
      const ep = await resolverFor(s, t, locale).resolve(name)
      return makeClient(ep)
    }
    try {
      return await fanoutRef(
        { gateway: managerFor(s, t, locale), forgejo: repoClient(s, t, locale), resolveWorker, deps, tenant: t, session: s, locale },
        org, repo, ref.branch, newRev,
      )
    } catch {
      return 0
    }
  }

  /** Wrap a build (workspace gateway) tool. */
  const buildWrap = (
    fn: (ctx: BuildCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      return fn({ workspace: managerFor(s, t, locale), locale }, args ?? {})
    }

  /** Wrap a service (workspace gateway) tool. */
  const serviceWrap = (
    fn: (ctx: ServiceCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      return fn({ workspace: managerFor(s, t, locale), session: s, locale }, args ?? {})
    }

  /** Wrap a helm (chart release) tool. */
  const helmWrap = (
    fn: (ctx: HelmCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      return fn({ workspace: managerFor(s, t, locale), session: s, locale }, args ?? {})
    }

  /** Wrap a pvc (workspace gateway storage) tool. */
  const pvcWrap = (
    fn: (ctx: PVCContext, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      return fn({ workspace: managerFor(s, t, locale), locale }, args ?? {})
    }

  /** Wrap a bridge (repo + worker) tool. */
  const bridgeWrap = (
    fn: (ctx: BridgeCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      const a = args ?? {}
      const client = await resolveWorkerClient(a, s, t, locale)
      const expanded = expandPathArgs(a, PATH_KEYS, await workerAnchors(client))
      const ref = branchRefOf(s)
      return fn(
        {
          client, forgejo: repoClient(s, t, locale), locale,
          ...(ref !== null ? { branch: ref.branch } : {}),
          fanout: (org, repo, branch, newRev) => fanout(s, t, locale, org, repo, branch, newRev),
        },
        expanded,
      )
    }

  /**
   * Wrap a computer-use (GUI) tool. Resolves `worker-name` to a live worker,
   * detects the platform from the worker's `info.os` and GATES on the
   * accessibility tooling (the worker's probed `capabilities.xa11y`, falling
   * back to a CLI probe on an older worker), then injects the target.
   */
  const computerWrap = (
    fn: (ctx: C.ToolCtx, t: SandboxTarget, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] => {
    if (deps === undefined) {
      return async () => {
        throw new TypedToolError('internal', tr('en', 'fileToolsRequireBus'))
      }
    }
    return async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      const a = args ?? {}
      const name = strArg(a, 'worker-name')
      if (name === '') {
        throw new TypedToolError('invalid_argument', tr(locale, 'workerNameRequired'))
      }
      const ep = await resolverFor(s, t, locale).resolve(name)
      const client = makeComputerClient(ep)
      const target = await probeTarget(client, name, locale)
      return fn({ deps, locale, tenant: t, session: s }, target, a)
    }
  }

    const handlers: Handlers = {
    // ---- sandbox lifecycle (workspace gateway) ----
    'sandbox-create': sandboxWrap(sandboxCreate),
    'sandbox-list': sandboxWrap(sandboxList),
    'list-oci-images': sandboxWrap(listOCIImages),
    'sandbox-status': sandboxWrap(sandboxStatus),
    'sandbox-delete': sandboxWrap(sandboxDelete),

    // ---- sandbox execution (agent-worker) ----
    'sandbox-info': wrap(async ({ client, url, locale }) => {
      const rendered = renderInfo(locale, await client.info({}), domainOf(url))
      return { content: rendered.text, data: rendered.data }
    }),
    'sandbox-exec': jobWrap(execCommand),
    'sandbox-job-start': jobWrap(jobStart),
    'sandbox-job-output': jobWrap(jobOutput),
    'sandbox-job-wait': jobWrap(jobWait),
    'sandbox-job-kill': jobWrap(jobKill),
    'sandbox-job-stdin': jobWrap(jobStdin),
    'sandbox-job-list': jobWrap(jobList),
    'sandbox-file-read': fileWrap(readFile),
    'sandbox-file-patch': fileWrap(patchFile),
    'sandbox-file-ls': fileWrap(listFiles),
    'sandbox-file-download': fileWrap(downloadFile),
    'sandbox-file-upload': fileWrap(uploadFile),
    'sandbox-checkout': bridgeWrap(sandboxCheckout),
    'sandbox-submit-mr': bridgeWrap(sandboxSubmitMR),

    // ---- computer-use (GUI via the accessibility tree) ----
    'sandbox-computer-apps': computerWrap((ctx, target) => C.apps(ctx, target)),
    'sandbox-computer-snapshot': computerWrap(C.snapshot),
    'sandbox-computer-find': computerWrap(C.find),
    'sandbox-computer-action': computerWrap(C.action),
    'sandbox-computer-click': computerWrap(C.click),
    'sandbox-computer-type': computerWrap(C.typeText),
    'sandbox-computer-key': computerWrap(C.key),
    'sandbox-computer-scroll': computerWrap(C.scroll),
    'sandbox-computer-drag': computerWrap(C.drag),
    'sandbox-computer-screenshot': computerWrap(C.screenshot),

    // ---- repo-* ----
    'repo-explore': repoWrap(repoExplore),
    'repo-create-org': repoWrap(repoCreateOrg),
    'repo-create-repo': repoWrap(repoCreateRepo),
    'repo-import': repoWrap(repoImport),
    'repo-remove': repoWrap(repoRemove),
    'repo-set-push-mirror': repoWrap(repoSetPushMirror),
    'repo-list-push-mirrors': repoWrap(repoListPushMirrors),
    'repo-delete-push-mirror': repoWrap(repoDeletePushMirror),
    'repo-build-image': buildWrap(repoBuildImage),
    'repo-build-status': buildWrap(repoBuildStatus),
    'oci-import': buildWrap(ociImport),
    'repo-mail-send': mailWrap(repoMailSend),

    // ---- services (long-lived Deployments) ----
    'service-deploy': serviceWrap(serviceDeploy),
    'service-rollback': serviceWrap(serviceRollback),
    'service-list': serviceWrap(serviceList),
    'service-delete': serviceWrap(serviceDelete),
    'service-logs': serviceWrap(serviceLogs),
    'helm-deploy': helmWrap(helmDeploy),
    'helm-list': helmWrap(helmList),
    'helm-history': helmWrap(helmHistory),
    'helm-rollback': helmWrap(helmRollback),
    'helm-uninstall': helmWrap(helmUninstall),
    'helm-objects': helmWrap(helmObjects),
    'helm-object-logs': helmWrap(helmObjectLogs),
    'pvc-create': pvcWrap(pvcCreate),
    'pvc-list': pvcWrap(pvcList),
    'pvc-delete': pvcWrap(pvcDelete),
    'repo-file-read': repoWrap(repoRead),
    'repo-file-list': repoWrap(repoList),
    'repo-log': repoWrap(repoLog),
    'repo-show': repoWrap(repoShow),
    'repo-diff': repoWrap(repoDiff),
    'repo-branches': repoWrap(repoBranches),
    'repo-tags': repoWrap(repoTags),
    'repo-tag-create': repoWrap(repoTagCreate),
    'repo-mr-list': repoWrap(repoMrList),
    'repo-mr-comment': repoWrap(repoMrComment),
    'repo-mr-merge': repoWrap(repoMrMerge),
    'repo-mr-close': repoWrap(repoMrClose),
  }

  const tools: Record<string, ToolSpec['execute']> = handlers

  // Tool/config metadata (descriptions, JSON schemas, required_config) lives in
  // manifest.yaml; only `execute` handlers are wired here. `manifestConfig`
  // joins the two, exactly like the other extensions.
  const manifest = parseManifest(manifestYaml)
  const cfg = manifestConfig(manifest, {
    handlers: Object.fromEntries(
      Object.entries(tools).map(([k, v]) => [k, { execute: v }]),
    ),
    variables: {
      org: { resolve: sessionName => sessionRefPart(sessionName, 0) },
      repo: { resolve: sessionName => sessionRefPart(sessionName, 1) },
      branch: { resolve: sessionName => sessionRefPart(sessionName, 2) },
    },
  })
  cfg.lifecycle = ['created', 'forked', 'renamed', 'deleted']
  cfg.onLifecycle = async (ev, tenant) => {
    const t = tenant ?? ''
    const locale = await localeOf(deps, t, ev.session_name).catch(() => 'en')
    // Materialize the workspace branch for a new/forked session (best effort:
    // a reconcile pass in the deployment heals a missed event).
    if (ev.kind === 'created' || ev.kind === 'forked') {
      const ref = parseSessionName(ev.session_name)
      if (ref !== null) {
        await materializeLifecycle(ev, repoClient(ev.session_name, t, locale), locale).catch(() => {})
      }
      return
    }
    if (ev.kind !== 'deleted') return
    // Cascade: delete every sandbox bound to this session (its
    // `worker-manager/session` annotation). Best-effort; the gateway's idle
    // reaper is the backstop.
    if (t !== '') {
      await deleteSessionSandboxes(managerFor(ev.session_name, t, locale), t, ev.session_name).catch(() => {})
    }
  }
  return cfg
}

/**
 * One component of a branch session's `org:repo:branch` name (0=org, 1=repo,
 * 2=branch); "" for a free session or a missing component. Used to resolve the
 * `org`/`repo`/`branch` prompt variables.
 */
function sessionRefPart(sessionName: string | undefined, index: 0 | 1 | 2): string {
  const ref = sessionName !== undefined ? parseSessionName(sessionName) : null
  if (ref === null) return ''
  return [ref.org, ref.repo, ref.branch][index] ?? ''
}

/**
 * Delete every sandbox bound to `session` (matched by the sandbox's
 * `worker-manager/session` binding, which the gateway filters on). Best-effort;
 * the gateway's idle reaper is the backstop.
 */
async function deleteSessionSandboxes(
  workspace: GatewayClient,
  tenant: string,
  session: string,
): Promise<void> {
  void tenant
  const res = await workspace.listSandboxes({ session })
  for (const sb of res.sandboxes) {
    if (sb.session === session) await workspace.deleteSandbox({ name: sb.name })
  }
}

/**
 * Sandbox (worker) path arguments that accept a leading `~` alias for the
 * worker's HOME. Expanded client-side before the call (the worker does not
 * expand `~`). Repo paths (`repo-*`) are repository-relative and are NOT here.
 */
const PATH_KEYS = ['path', 'dest', 'from', 'to', 'workdir'] as const
