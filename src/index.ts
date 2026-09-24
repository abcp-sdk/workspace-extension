import type {
  Bus,
  ExtensionConfig,
  ConfigSpec,
  ToolResultData,
  ToolSpec,
} from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import {
  createGatewayClient,
  type WorkerClient,
  WorkerClientCache,
  WorkerResolver,
  type GatewayClient,
} from './client.js'
import { agentFileDeps, type WorkspaceDeps } from './deps.js'
import { Forgejo } from './forgejo.js'
import {
  BRIDGE_REQUIRED,
  BUILD_REQUIRED,
  CONFIG,
  gatewayConfig,
  type GatewayConfig,
  REPO_REQUIRED,
  SANDBOX_REQUIRED,
} from './config.js'
import { localeOf, tr } from './i18n.js'
import { materializeLifecycle, parseSessionName } from './tools/lifecycle.js'
import { domainOf, strArg } from './tools/shared.js'
import {
  deleteFile,
  downloadFile,
  editFile,
  type FileCtx,
  listFiles,
  readFile,
  uploadFile,
  writeFile,
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
  repoCommit,
  repoDelete,
  repoEdit,
  repoList,
  repoRead,
  repoWrite,
  type RepoCtx,
} from './tools/repo-content.js'
import {
  repoBranchCreate,
  repoBranches,
  repoDiff,
  repoExplore,
  repoLog,
  repoMrComment,
  repoMrCreate,
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
import { repoBranchSync, repoRestore } from './tools/repo-sync.js'
import { repoMailSend, type MailCtx } from './tools/mail.js'
import { sandboxCheckout, sandboxPort, type BridgeCtx } from './tools/bridge.js'
import {
  branchRefOf,
  checkoutIntoSandbox,
  fanoutNote,
  fanoutRef,
  recordBaseline,
} from './tools/fanout.js'
import {
  renderInfo,
  sandboxCreate,
  sandboxDelete,
  listOCIImages,
  sandboxList,
  sandboxStatus,
  type SandboxCtx,
} from './tools/sandbox.js'
import { ociImport, repoBuildImage, repoBuildPreview, type BuildCtx } from './tools/imagebuild.js'
import {
  serviceDelete,
  serviceDeploy,
  serviceList,
  serviceLogs,
  servicePreview,
  type ServiceCtx,
} from './tools/services.js'
import {
  pvcCreate,
  pvcDelete,
  pvcList,
  type PVCContext,
} from './tools/pvc.js'

export const EXT_ID = 'workspace'
export const EXT_VERSION = '0.14.1'

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
  /** Forgejo-backed repo client factory. It is built OVER a gateway client, so
   *  every repo operation is tenant-scoped server-side (overridable in tests). */
  makeForgejo?: (gateway: GatewayClient) => Forgejo
  /** Workspace-gateway client factory (overridable in tests). */
  makeManager?: (cfg: GatewayConfig, tenant: string) => GatewayClient
}

/**
 * Build the workspace extension: sandbox lifecycle (workspace gateway), sandbox
 * execution (easyworker), repo-* tools (Forgejo) and the checkout/port bridge.
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
  const makeForgejo = opts.makeForgejo ?? ((gateway: GatewayClient) => new Forgejo({ gateway }))
  const makeManager =
    opts.makeManager ?? ((cfg: GatewayConfig, tenant: string) => createGatewayClient(cfg.url, cfg.token, tenant))

  // One gateway client + resolver per (url, token, tenant), reused across
  // calls. The tenant is part of the key because the client sends it as
  // X-Abc-Tenant (the gateway acts on behalf of that tenant).
  const managers = new Map<string, { client: GatewayClient; resolver: WorkerResolver }>()
  const managerKey = (cfg: GatewayConfig, tenant: string): string => `${cfg.url}\u0000${cfg.token}\u0000${tenant}`
  const managerFor = (session: string, tenant: string, locale: string): GatewayClient => {
    const cfg = gatewayConfig(opts.getConfig, session, tenant, locale)
    const key = managerKey(cfg, tenant)
    let hit = managers.get(key)
    if (hit === undefined) {
      const client = makeManager(cfg, tenant)
      hit = { client, resolver: new WorkerResolver(client) }
      managers.set(key, hit)
    }
    return hit.client
  }
  const resolverFor = (session: string, tenant: string, locale: string): WorkerResolver => {
    const cfg = gatewayConfig(opts.getConfig, session, tenant, locale)
    managerFor(session, tenant, locale)
    return managers.get(managerKey(cfg, tenant))!.resolver
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
      const client = await resolveWorkerClient(args ?? {}, s, t, locale)
      return fn(
        { client, locale, ...(signal !== undefined ? { signal } : {}) },
        args ?? {},
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
      const client = await resolveWorkerClient(args ?? {}, s, t, locale)
      return fn({ client, deps, tenant: t, session: s, locale }, args ?? {})
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
        const done = await checkoutIntoSandbox(repoClient(s, t, locale), client, ref.org, ref.repo, ref.branch)
        await recordBaseline(
          { forgejo: repoClient(s, t, locale), deps, tenant: t, session: s, locale },
          sandbox, ref.org, ref.repo, ref.branch,
        )
        return tr(locale, 'checkoutDone', { org: ref.org, repo: ref.repo, ref: done.ref, files: done.files })
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
      const client = await resolveWorkerClient(args ?? {}, s, t, locale)
      const ref = branchRefOf(s)
      return fn(
        {
          client, forgejo: repoClient(s, t, locale), locale,
          ...(ref !== null ? { branch: ref.branch } : {}),
          fanout: (org, repo, branch, newRev) => fanout(s, t, locale, org, repo, branch, newRev),
        },
        args ?? {},
      )
    }

  const handlers: Handlers = {
    // ---- sandbox lifecycle (workspace gateway) ----
    'sandbox-create': sandboxWrap(sandboxCreate),
    'sandbox-list': sandboxWrap(sandboxList),
    'list-oci-images': sandboxWrap(listOCIImages),
    'sandbox-status': sandboxWrap(sandboxStatus),
    'sandbox-delete': sandboxWrap(sandboxDelete),

    // ---- sandbox execution (easyworker) ----
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
    'sandbox-file-write': fileWrap(writeFile),
    'sandbox-file-edit': fileWrap(editFile),
    'sandbox-file-ls': fileWrap(listFiles),
    'sandbox-file-rm': fileWrap(deleteFile),
    'sandbox-file-download': fileWrap(downloadFile),
    'sandbox-file-upload': fileWrap(uploadFile),
    'sandbox-checkout': bridgeWrap(sandboxCheckout),
    'sandbox-port': bridgeWrap(sandboxPort),

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
    'repo-build-preview': buildWrap(repoBuildPreview),
    'oci-import': buildWrap(ociImport),
    'repo-mail-send': mailWrap(repoMailSend),

    // ---- services (long-lived Deployments) ----
    'service-deploy': serviceWrap(serviceDeploy),
    'service-preview': serviceWrap(servicePreview),
    'service-list': serviceWrap(serviceList),
    'service-delete': serviceWrap(serviceDelete),
    'service-logs': serviceWrap(serviceLogs),
    'pvc-create': pvcWrap(pvcCreate),
    'pvc-list': pvcWrap(pvcList),
    'pvc-delete': pvcWrap(pvcDelete),
    'repo-file-read': repoWrap(repoRead),
    'repo-file-write': repoWrap(repoWrite),
    'repo-file-edit': repoWrap(repoEdit),
    'repo-file-delete': repoWrap(repoDelete),
    'repo-file-list': repoWrap(repoList),
    'repo-commit': repoWrap(repoCommit),
    'repo-log': repoWrap(repoLog),
    'repo-show': repoWrap(repoShow),
    'repo-diff': repoWrap(repoDiff),
    'repo-branches': repoWrap(repoBranches),
    'repo-branch-create': repoWrap(repoBranchCreate),
    'repo-tags': repoWrap(repoTags),
    'repo-tag-create': repoWrap(repoTagCreate),
    'repo-mr-create': repoWrap(repoMrCreate),
    'repo-mr-list': repoWrap(repoMrList),
    'repo-mr-comment': repoWrap(repoMrComment),
    'repo-mr-merge': repoWrap(repoMrMerge),
    'repo-branch-sync': repoWrap(repoBranchSync),
    'repo-file-restore': repoWrap(repoRestore),
  }

  const tools: Record<string, ToolSpec> = {}
  for (const [name, meta] of Object.entries(TOOL_META)) {
    const execute = handlers[name]
    if (execute === undefined) continue
    const spec: ToolSpec = {
      description: meta.description,
      inputSchema: meta.inputSchema,
      requiredConfig: meta.required,
      execute,
    }
    if (meta.descriptions !== undefined) spec.descriptions = meta.descriptions
    tools[name] = spec
  }

  return {
    id: EXT_ID,
    version: EXT_VERSION,
    tools,
    // Session-scoped prompt variables: a branch session's `org`/`repo`/`branch`
    // are resolved from its `org:repo:branch` name and substituted into the
    // role system prompts (`{{vars.workspace.org}}` etc.). A free session
    // (no colons) resolves to empty strings; the free-role prompts never
    // reference them, so nothing is shown.
    variables: {
      org: { scope: 'session', resolve: sessionName => sessionRefPart(sessionName, 0) },
      repo: { scope: 'session', resolve: sessionName => sessionRefPart(sessionName, 1) },
      branch: { scope: 'session', resolve: sessionName => sessionRefPart(sessionName, 2) },
    },
    lifecycle: ['created', 'forked', 'renamed', 'deleted'],
    onLifecycle: async (ev, tenant) => {
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
      if (deps === undefined) return
      await deps.clearEditState(t, ev.session_name).catch(() => {})
    },
    config: CONFIG_SPECS,
  }
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

/** All config knobs (declared once; tools gate on subsets). */
const CONFIG_SPECS: Record<string, ConfigSpec> = {
  [CONFIG.gatewayUrl]: {
    type: 'string',
    default: '',
    scope: 'global',
    description: 'Base URL of the workspace-gateway service (e.g. http://workspace-gateway:80).',
    descriptions: { zh: 'workspace-gateway 服务的基础地址（如 http://workspace-gateway:80）。' },
  },
  [CONFIG.gatewayToken]: {
    type: 'string',
    default: '',
    scope: 'global',
    description: 'Service token the workspace-gateway requires for sandbox RPCs.',
    descriptions: { zh: 'workspace-gateway 在沙箱 RPC 上要求的服务令牌。' },
  },
}

interface ToolMeta {
  description: string
  descriptions?: Record<string, string>
  inputSchema: Record<string, unknown>
  required: string[]
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: 'object', properties, required })

const str = (description: string, descriptionsZh?: string): Record<string, unknown> => ({
  type: 'string',
  description,
  ...(descriptionsZh !== undefined ? { descriptions: { zh: descriptionsZh } } : {}),
})

const int = (description: string, descriptionsZh?: string): Record<string, unknown> => ({
  type: 'integer',
  description,
  ...(descriptionsZh !== undefined ? { descriptions: { zh: descriptionsZh } } : {}),
})

const bool = (description: string, descriptionsZh?: string): Record<string, unknown> => ({
  type: 'boolean',
  description,
  ...(descriptionsZh !== undefined ? { descriptions: { zh: descriptionsZh } } : {}),
})

const JOB_ID = str('Background job id.', '后台任务 id。')

/** The `volumes` array shared by service-deploy / service-preview: mount
 *  named PVCs (from pvc-create) into the container. */
const volumesSchema = (): Record<string, unknown> => ({
  type: 'array',
  description:
    'PVCs to mount (from pvc-create). Each: { pvc, mount-path, read-only?, sub-path? }. The claim must exist and belong to this tenant.',
  descriptions: {
    zh: '要挂载的 PVC（来自 pvc-create）。每项：{ pvc, mount-path, read-only?, sub-path? }。该 PVC 必须存在且属于本租户。',
  },
  items: {
    type: 'object',
    properties: {
      pvc: str('PVC name (see pvc-list).', 'PVC 名称（见 pvc-list）。'),
      'mount-path': str('Absolute path inside the container.', '容器内的绝对路径。'),
      'read-only': bool('Mount read-only (default false).', '只读挂载（默认 false）。'),
      'sub-path': str('Sub-path within the volume (optional).', '卷内的子路径（可选）。'),
    },
    required: ['pvc', 'mount-path'],
  },
})

/**
 * Appended to every command-running tool (`sandbox-exec` / `sandbox-job-start`)
 * and to their `command` argument. The remote worker already runs each job as a
 * tracked background task and records its output, so shell-level backgrounding
 * and output redirection actively break observability.
 */
const EXEC_WARNING_EN =
  'IMPORTANT: the remote worker runs every command as a background job and records its full output. ' +
  'Do NOT background the command yourself with &, nohup, setsid, disown, or `&` in a subshell; ' +
  'do NOT truncate or redirect output with pipes (e.g. `| head`/`| tail`) or redirection (e.g. `> file`, `2>&1`, `>> file`); ' +
  'do NOT run a daemon/server in the foreground expecting the call to return. ' +
  'Run the command as-is (the worker streams and stores stdout/stderr), then read the result with the job-output/job-wait tools.'
const EXEC_WARNING_ZH =
  '重要：远端 worker 会把每条命令都作为后台任务运行并记录完整输出。' +
  '请勿自行用 &、nohup、setsid、disown 或子 shell 的 & 将命令放到后台；' +
  '请勿用管道截断输出（如 `| head`/`| tail`）或重定向输出（如 `> file`、`2>&1`、`>> file`）；' +
  '也请勿在前台运行常驻的守护进程/服务并指望调用立即返回。' +
  '请原样运行命令（worker 会流式记录 stdout/stderr），再用 job-output/job-wait 工具读取结果。'

/** The sandbox to run against (a name from sandbox-create / sandbox-list). */
const WORKER_NAME = str(
  'Sandbox name to run against (from sandbox-create or sandbox-list).',
  '要操作的沙箱名（来自 sandbox-create 或 sandbox-list）。',
)

/** Repo address args shared by every repo-* tool. */
const REPO_ADDR = {
  org: str('Organization (owner) of the repository.', '仓库所属组织（owner）。'),
  repo: str('Repository name.', '仓库名。'),
  ref: str(
    'Git ref: branch, commit sha or tag. Omitted = the repository default branch.',
    'Git 引用：分支、提交 sha 或标签。省略 = 仓库默认分支。',
  ),
}

const TOOL_META: Record<string, ToolMeta> = {

  // ================= sandbox lifecycle (workspace gateway) =================
  'sandbox-create': {
    description:
      'Create a sandbox and wait up to 60s for it to become healthy. A sandbox runs a PRE-BUILT image that already bundles the worker — the gateway no longer injects anything. `image` must be one of the deployment sandbox images from the dedicated sandbox org (see list-oci-images with owner="sandbox"); omit it for the deployment default. Returns the sandbox name, its in-cluster service DNS, and the worker environment (OS/arch, workspace root, boot id).',
    descriptions: { zh: '创建沙箱并最多等待 60 秒就绪。沙箱运行的是预构建、已内置 worker 的镜像——网关不再做任何注入。`image` 必须是部署沙箱镜像（见 list-oci-images，owner="sandbox"）之一；省略则用部署默认镜像。返回沙箱名、集群内服务域名，以及 worker 环境（OS/架构、工作区根目录、boot id）。' },
    inputSchema: obj(
      {
        name: str('Logical sandbox name (unique among live sandboxes).', '逻辑沙箱名（在存活沙箱中唯一）。'),
        image: str('Sandbox image from the sandbox org (see list-oci-images; omit for the deployment default).', '沙箱组织下的沙箱镜像（见 list-oci-images；省略则用部署默认）。'),
        cpu: str('CPU request/limit, e.g. 500m or 1 (default 500m).', 'CPU 请求/上限，如 500m 或 1（默认 500m）。'),
        memory: str('Memory request/limit, e.g. 1Gi (default 1Gi).', '内存请求/上限，如 1Gi（默认 1Gi）。'),
        kvm: { type: 'boolean', description: 'Request KVM (/dev/kvm) — non-privileged, via the device plugin.', descriptions: { zh: '请求 KVM（/dev/kvm）——非特权，经 device plugin。' } },
        'gpu-count': int('Number of NVIDIA GPUs to request (0 = none; needs the GPU device plugin).', '请求的 NVIDIA GPU 卡数（0 = 无；需 GPU device plugin）。'),
        env: {
          type: 'object',
          description: 'Extra environment variables for the worker container.',
          descriptions: { zh: '为 worker 容器附加的环境变量。' },
          additionalProperties: { type: 'string' },
        },
      },
      ['name'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-list': {
    description: 'List every managed sandbox (name, phase, image, url, created, creator).',
    descriptions: { zh: '列出所有受管沙箱（名称、状态、镜像、地址、创建时间、创建者）。' },
    inputSchema: obj({}),
    required: SANDBOX_REQUIRED,
  },
  'list-oci-images': {
    description: 'Browse OCI images in the registry. `owner` selects the namespace (default: the deployment toolchain org; use owner="sandbox" to list the deployable SANDBOX images). Pass `name` to list ONE image\'s tags; omit it to list all of the owner\'s images. Returns full refs; only `sandbox` refs are usable with sandbox-create.',
    descriptions: { zh: '浏览 registry 中的 OCI 镜像。`owner` 选择命名空间（默认：部署的 toolchain 组织；用 owner="sandbox" 列出可部署的沙箱镜像）。传 `name` 列出单个镜像的所有 tag；省略则列出该 owner 的全部镜像。返回完整引用；只有 `sandbox` 下的引用可用于 sandbox-create。' },
    inputSchema: obj({
      owner: str('Owner (user or org) namespace (default: the deployment toolchain org).', 'owner（用户或组织）命名空间（默认：部署的 toolchain 组织）。'),
      name: str('Image name to list tags for (omit to list all images).', '要列出 tag 的镜像名（省略则列出全部镜像）。'),
    }),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-status': {
    description: "Show one sandbox's live state (phase, ready, image, url).",
    descriptions: { zh: '查看单个沙箱的实时状态（阶段、是否就绪、镜像、地址）。' },
    inputSchema: obj({ 'worker-name': WORKER_NAME }, ['worker-name']),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-delete': {
    description: 'Delete a sandbox (its Pod + Service + Secret).',
    descriptions: { zh: '删除沙箱（其 Pod + Service + Secret）。' },
    inputSchema: obj({ 'worker-name': WORKER_NAME }, ['worker-name']),
    required: SANDBOX_REQUIRED,
  },

  // ================= sandbox-* =================
  'sandbox-info': {
    description: 'Show the sandbox environment: OS/arch, shell, workspace root, in-cluster service DNS and boot id.',
    descriptions: { zh: '查看沙箱环境：OS/架构、shell、工作区根目录、集群内服务域名与 boot id。' },
    inputSchema: obj({}),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-exec': {
    description:
      'Run a short shell command in the sandbox workspace and wait up to `timeout` seconds. Returns the job id always; on completion up to 1000 lines of output, on timeout the oldest 200 lines plus a note that the job is still running. ' +
      EXEC_WARNING_EN,
    descriptions: {
      zh: '在沙箱工作区运行一个短命令，最多等待 `timeout` 秒。总是返回 job id；完成时最多返回 1000 行输出，超时则返回最旧的 200 行并提示任务仍在运行。' +
        EXEC_WARNING_ZH,
    },
    inputSchema: obj(
      {
        command: str('Shell command to run. ' + EXEC_WARNING_EN, '要运行的 shell 命令。' + EXEC_WARNING_ZH),
        workdir: str('Working directory, relative to the workspace root.', '工作目录，相对于工作区根目录。'),
        timeout: int('Synchronous wait ceiling in seconds (default 5, max 60).', '同步等待上限（秒，默认 5，最大 60）。'),
        env: {
          type: 'object',
          description: 'Extra environment variables for the job.',
          descriptions: { zh: '为任务附加的环境变量。' },
          additionalProperties: { type: 'string' },
        },
      },
      ['command'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-job-start': {
    description:
      'Start a long-running shell command and return the job id immediately (no waiting). Drive it with sandbox-job-wait/sandbox-job-output/sandbox-job-stdin/sandbox-job-kill. To stop a long job, call sandbox-job-kill yourself — no deadline is armed. ' +
      EXEC_WARNING_EN,
    descriptions: {
      zh: '启动一个长时间运行的 shell 命令并立即返回 job id（不等待）。用 sandbox-job-wait/sandbox-job-output/sandbox-job-stdin/sandbox-job-kill 进行后续控制。要停止长任务请自行调用 sandbox-job-kill——不会自动设置截止时间。' +
        EXEC_WARNING_ZH,
    },
    inputSchema: obj(
      {
        command: str('Shell command to run. ' + EXEC_WARNING_EN, '要运行的 shell 命令。' + EXEC_WARNING_ZH),
        workdir: str('Working directory, relative to the workspace root.', '工作目录，相对于工作区根目录。'),
        env: {
          type: 'object',
          description: 'Extra environment variables for the job.',
          descriptions: { zh: '为任务附加的环境变量。' },
          additionalProperties: { type: 'string' },
        },
      },
      ['command'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-job-output': {
    description: "Read a job's output by line window (offset/limit; offset negative counts from the end). Display is capped at 1000 lines / 120 KiB.",
    descriptions: { zh: '按行窗口读取任务输出（offset/limit；offset 为负从末尾计数）。展示上限 1000 行 / 120 KiB。' },
    inputSchema: obj({
      'job-id': JOB_ID,
      offset: int('Start line offset (negative = from the end, default 0).', '起始行偏移（负值从末尾算，默认 0）。'),
      limit: int('Maximum lines to return (default 200, max 1000).', '最多返回行数（默认 200，最大 1000）。'),
      stream: {
        type: 'string',
        enum: ['all', 'stdout', 'stderr'],
        description: 'Which stream to read (default all).',
        descriptions: { zh: '读取哪个流（默认 all）。' },
      },
    }, ['job-id']),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-job-wait': {
    description: 'Wait up to `timeout` seconds for a job to finish; returns the latest 200 lines of output. If it is still running at the deadline, says so.',
    descriptions: { zh: '最多等待 `timeout` 秒让任务结束；返回最新的 200 行输出。若到点仍在运行则明确提示。' },
    inputSchema: obj(
      {
        'job-id': JOB_ID,
        timeout: int('Wait ceiling in seconds (default 60, max 600).', '等待上限（秒，默认 60，最大 600）。'),
      },
      ['job-id'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-job-kill': {
    description: 'Kill a job and its whole process tree.',
    descriptions: { zh: '终止任务及其整个进程树。' },
    inputSchema: obj({ 'job-id': JOB_ID }, ['job-id']),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-job-stdin': {
    description: "Write to a job's stdin, optionally closing it.",
    descriptions: { zh: '向任务的 stdin 写入数据，可选关闭。' },
    inputSchema: obj(
      {
        'job-id': JOB_ID,
        data: str('Text to write to stdin.', '写入 stdin 的文本。'),
        close: {
          type: 'boolean',
          description: 'Close stdin after writing.',
          descriptions: { zh: '写入后关闭 stdin。' },
        },
      },
      ['job-id'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-job-list': {
    description: 'List jobs registered in the worker (id, state, exit code, command).',
    descriptions: { zh: '列出 worker 中登记的任务（id、状态、退出码、命令）。' },
    inputSchema: obj({}),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-file-read': {
    description: 'Read a text file from the sandbox workspace with line numbers, windowed by offset/limit (the window is fetched server-side, so a slice of a huge file is not fully transferred). Binary files are rejected. Reading records the lines as "seen" so a later sandbox-file-edit may change them.',
    descriptions: { zh: '从沙箱工作区读取文本文件并带行号，通过 offset/limit 分窗（窗口在服务端获取，大文件只取所需片段）。二进制文件会被拒绝。读取会记录已“看到”的行，之后 sandbox-file-edit 才能修改这些行。' },
    inputSchema: obj(
      {
        path: str('File path, relative to the workspace root.', '文件路径，相对于工作区根目录。'),
        offset: int('Start line (0-based, default 0).', '起始行（从 0 开始，默认 0）。'),
        limit: int('Maximum lines (default 200, max 1000).', '最多行数（默认 200，最大 1000）。'),
      },
      ['path'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-file-write': {
    description: 'Write (overwrite) a text file in the sandbox workspace, then return the whole file with line numbers. Rejected if the content exceeds 120 KiB. The whole file counts as "seen".',
    descriptions: { zh: '向沙箱工作区写入（覆盖）文本文件，随后返回带行号的全文件。内容超过 120 KiB 会被拒绝。整个文件视为已“看到”。' },
    inputSchema: obj(
      {
        path: str('File path, relative to the workspace root.', '文件路径，相对于工作区根目录。'),
        content: str('Full file content.', '完整文件内容。'),
      },
      ['path', 'content'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-file-edit': {
    description: 'Edit a sandbox file by line numbers (1-based). When end-line < start-line it inserts before start-line; otherwise it replaces [start-line, end-line]. Out-of-range line numbers are clamped. The session must have read (or written) the file first, and may only edit lines it has seen; the file must be unchanged since that read. A successful edit requires a fresh read. Returns a one-line summary followed by a unified diff.',
    descriptions: { zh: '按行号（从 1 开始）编辑沙箱文件。end-line < start-line 时在 start-line 前插入；否则替换 [start-line, end-line]。越界行号会夹取到文件范围。会话必须先 read（或 write）过该文件，且只能修改已“看到”的行；文件自上次读取后不得变化。编辑成功后需重新 read。返回一行摘要及 unified diff。' },
    inputSchema: obj(
      {
        path: str('File path, relative to the workspace root.', '文件路径，相对于工作区根目录。'),
        'start-line': int('Start line (1-based).', '起始行（从 1 开始）。'),
        'end-line': int('End line (1-based, inclusive); < start-line means insert.', '结束行（从 1 开始，含端点）；小于 start-line 表示插入。'),
        content: str('Replacement or inserted text.', '替换或插入的文本。'),
      },
      ['path', 'start-line', 'end-line'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-file-ls': {
    description: 'List a sandbox path as a tree (levels 1..depth) with sizes, in ONE server-side recursive listing. Directories beyond the cap stay collapsed.',
    descriptions: { zh: '以树形（第 1..depth 层）列出沙箱路径并显示大小，单次服务端递归列出。超过上限的目录保持折叠。' },
    inputSchema: obj(
      {
        path: str('Directory or file path, relative to the workspace root.', '目录或文件路径，相对于工作区根目录。'),
        limit: int('Maximum entries (default 200, max 1000).', '最大条目数（默认 200，最大 1000）。'),
        depth: int('Levels to expand (default 3).', '展开层数（默认 3）。'),
      },
      ['path'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-file-rm': {
    description: 'Remove a file or directory tree from the sandbox workspace (recursive). Its read-before-edit state is cleared.',
    descriptions: { zh: '从沙箱工作区删除文件或目录树（递归）。其读前编辑状态会被清除。' },
    inputSchema: obj(
      {
        path: str('File or directory path, relative to the workspace root.', '文件或目录路径，相对于工作区根目录。'),
      },
      ['path'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-file-download': {
    description: 'Download a stored file (agent `file:<code>`) into the sandbox workspace at `path`.',
    descriptions: { zh: '将已存储文件（agent 的 `file:<code>`）下载到沙箱工作区的 `path`。' },
    inputSchema: obj(
      {
        code: str('File code (with or without the `file:` prefix).', '文件 code（可带或不带 `file:` 前缀）。'),
        path: str('Destination path in the workspace.', '工作区中的目标路径。'),
      },
      ['code', 'path'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-file-upload': {
    description: 'Upload a sandbox file to the agent file store, returning its `file:<code>`. The content type is derived by the agent.',
    descriptions: { zh: '将沙箱文件上传到 agent 文件存储，返回 `file:<code>`。内容类型由 agent 推断。' },
    inputSchema: obj(
      {
        path: str('File path, relative to the workspace root.', '文件路径，相对于工作区根目录。'),
        name: str('Stored file name (defaults to the basename).', '存储文件名（默认取 basename）。'),
      },
      ['path'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'sandbox-checkout': {
    description: 'Download a repository tree (Forgejo archive at `ref`) into the sandbox workspace. With clean=true the workspace is emptied first; clean=false (default) keeps sandbox-only files and only replaces files present in the repo.',
    descriptions: { zh: '把仓库树（Forgejo 在 `ref` 处的归档）下载到沙箱工作区。clean=true 先清空工作区；clean=false（默认）保留沙箱独有文件，仅替换仓库中存在的文件。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        dest: str('Workspace-relative destination directory (default: workspace root).', '工作区内的目标目录（默认：工作区根目录）。'),
        clean: {
          type: 'boolean',
          description: 'Empty the destination before unpacking (default false).',
          descriptions: { zh: '解包前清空目标目录（默认 false）。' },
        },
      },
      ['org', 'repo'],
    ),
    required: BRIDGE_REQUIRED,
  },
  'sandbox-port': {
    description: 'Commit sandbox file(s) back to the repository. A single file is overwritten. A directory is ported as NEW files only: if any target path already exists in the repo, the whole port is refused (no directory overwrite).',
    descriptions: { zh: '把沙箱文件提交回仓库。单文件会覆盖；目录只作为新文件移植：只要任一目标路径已存在于仓库，整个移植被拒绝（目录不覆盖）。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('Sandbox path (file or directory), relative to the workspace root.', '沙箱路径（文件或目录），相对于工作区根目录。'),
        'repo-path': str('Destination repo path (defaults to the sandbox path).', '仓库目标路径（默认等于沙箱路径）。'),
        message: str('Commit message.', '提交信息。'),
      },
      ['org', 'repo', 'path'],
    ),
    required: BRIDGE_REQUIRED,
  },

  // ================= repo-* =================
  'repo-explore': {
    description: 'Browse the Forgejo structure: list organizations (no org), or the repositories + branches of an org. Optional keyword filters org/repo names. Includes private repos.',
    descriptions: { zh: '浏览 Forgejo 结构：不传 org 时列出组织；传 org 时列出该组织的仓库与分支。可用 keyword 过滤组织/仓库名。包含私有仓库。' },
    inputSchema: obj({
      org: str('Organization name (omitted = list all organizations).', '组织名（省略 = 列出所有组织）。'),
      repo: str('Repository name (omitted = list all repos in the org).', '仓库名（省略 = 列出该组织所有仓库）。'),
      keyword: str('Case-insensitive substring matched against org/repo names.', '对组织/仓库名做大小写不敏感的子串匹配。'),
    }),
    required: REPO_REQUIRED,
  },
  'repo-create-org': {
    description: 'Create an organization owned by the caller\'s tenant (idempotent). The gateway creates it under the shared Forgejo credential.',
    descriptions: { zh: '创建归属于调用方租户的组织（幂等）。gateway 用共享的 Forgejo 凭据创建。' },
    inputSchema: obj(
      {
        org: str('Organization slug to create (required).', '要创建的组织标识（必填）。'),
      },
      ['org'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-create-repo': {
    description: 'Create a PUBLIC repository under `org` (the gateway ensures the org + repo + a protected `main` branch and records ownership). The default branch is always `main`.',
    descriptions: { zh: '在 `org` 下创建一个公开仓库（gateway 负责确保组织 + 仓库 + 受保护的 `main` 分支，并记录归属）。默认分支固定为 `main`。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
      },
      ['org', 'repo'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-import': {
    description: 'Import an EXTERNAL git repository into an org as a PUBLIC repo (admin). `ref` selects the SOURCE ref to import — a branch, a tag, or any revision — and it ALWAYS lands on the new repo\'s `main`; with no `ref` the source\'s HEAD branch is imported. Only `main` is created (no other branches/tags). Refuses to overwrite an existing repo. `auth-token`/`auth-user` support private sources.',
    descriptions: { zh: '将外部 git 仓库作为公开仓库导入到某组织（管理员）。`ref` 选择要导入的源 ref——分支、标签或任意修订——它始终落到新仓库的 `main`；不给 `ref` 时导入源的 HEAD 分支。只创建 `main`（不带其它分支/标签）。已存在的仓库会被拒绝。`auth-token`/`auth-user` 支持私有源。' },
    inputSchema: obj(
      {
        org: str('Target organization.', '目标组织。'),
        url: str('External git clone URL (https/ssh).', '外部 git 克隆地址（https/ssh）。'),
        repo: str('Target repo name (default: derived from the URL).', '目标仓库名（默认：从 URL 推断）。'),
        ref: str('Source branch/tag/rev to import as `main` (default: the source HEAD branch).', '要作为 `main` 导入的源分支/标签/修订（默认：源 HEAD 分支）。'),
        'auth-user': str('Basic-auth username for a private source.', '私有源的基本认证用户名。'),
        'auth-token': str('Access token for a private source.', '私有源的访问令牌。'),
        description: str('Repository description.', '仓库描述。'),
      },
      ['org', 'url'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-remove': {
    description: 'DESTRUCTIVE: delete a repository you own (admin) — the git repo, ALL its branch sessions (each cascading to its sandboxes) and the ownership record. The organization is kept. This cannot be undone.',
    descriptions: { zh: '危险操作：删除你拥有的仓库（管理员）——git 仓库、其全部分支会话（各自级联删除沙箱）以及归属记录。组织保留。不可撤销。' },
    inputSchema: obj({ ...REPO_ADDR }, ['org', 'repo']),
    required: REPO_REQUIRED,
  },
  'repo-set-push-mirror': {
    description: 'Register a PUSH MIRROR on a repository you own (admin): its commits are continuously pushed to an external HTTPS git remote. A repo may have MULTIPLE mirrors. Returns the Forgejo-assigned `remote-name` (needed to delete). `sync-on-commit` pushes immediately on every commit; otherwise `interval` (e.g. `8h`, `30m`) sets the periodic sync. `branch-filter` limits which branches are mirrored. `auth-user`/`auth-token` authenticate a private destination.',
    descriptions: { zh: '在你拥有的仓库上登记一个 PUSH MIRROR（管理员）：其提交会持续推送到外部 HTTPS git 远端。一个仓库可有多个 mirror。返回 Forgejo 分配的 `remote-name`（删除时需要）。`sync-on-commit` 表示每次提交立即推送；否则用 `interval`（如 `8h`、`30m`）设定周期同步。`branch-filter` 限定镜像哪些分支。`auth-user`/`auth-token` 用于私有目标认证。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        'remote-url': str('External HTTPS git URL to push to.', '要推送到的外部 HTTPS git 地址。'),
        'auth-user': str('Basic-auth username for a private destination.', '私有目标的基本认证用户名。'),
        'auth-token': str('Access token/password for a private destination.', '私有目标的访问令牌/密码。'),
        'sync-on-commit': bool('Push immediately on every commit (default false).', '每次提交立即推送（默认 false）。'),
        interval: str('Periodic sync interval, e.g. 8h or 30m (optional).', '周期同步间隔，如 8h 或 30m（可选）。'),
        'branch-filter': str('Only mirror branches matching this glob (optional).', '仅镜像匹配该 glob 的分支（可选）。'),
      },
      ['org', 'repo', 'remote-url'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-list-push-mirrors': {
    description: 'List the push mirrors configured on a repository you own (admin), with each mirror\'s remote name, address, interval and last sync error.',
    descriptions: { zh: '列出你拥有的仓库上已配置的 push mirror（管理员），含每个 mirror 的 remote name、地址、间隔与上次同步错误。' },
    inputSchema: obj({ ...REPO_ADDR }, ['org', 'repo']),
    required: REPO_REQUIRED,
  },
  'repo-delete-push-mirror': {
    description: 'Remove a push mirror from a repository you own (admin) by its `remote-name` (as returned by repo-set-push-mirror / repo-list-push-mirrors).',
    descriptions: { zh: '按 `remote-name` 从你拥有的仓库移除一个 push mirror（管理员）（remote-name 由 repo-set-push-mirror / repo-list-push-mirrors 返回）。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        'remote-name': str('The mirror\'s remote_name to delete.', '要删除的 mirror 的 remote_name。'),
      },
      ['org', 'repo', 'remote-name'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-build-image': {
    description: 'Build a container image from a repository Dockerfile (context = a repo subdirectory) and push it to the deployment registry. IMPORTANT: the produced image does NOT get easyworker injected — the Dockerfile must FROM a worker-capable base image for the result to be usable as a sandbox. The result is not auto-added to the sandbox image catalog.',
    descriptions: { zh: '从仓库的 Dockerfile 构建容器镜像（上下文 = 仓库子目录）并推送到部署 registry。重要：产出的镜像不会注入 easyworker——Dockerfile 必须 FROM 一个含 worker 的基础镜像，产物才能作为沙箱使用。产物不会自动加入沙箱镜像目录。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        image: str('Image name (single path segment, pushed under the deployment registry).', '镜像名（单段路径，推送到部署 registry）。'),
        tag: str('Image tag.', '镜像标签。'),
        dockerfile: str('Repo-relative Dockerfile path (default ./Dockerfile).', '仓库相对 Dockerfile 路径（默认 ./Dockerfile）。'),
        context: str('Repo-relative build context subdirectory (default: repo root).', '仓库相对的构建上下文子目录（默认：仓库根）。'),
        'build-args': {
          type: 'object',
          description: 'Build arguments (--build-arg k=v).',
          descriptions: { zh: '构建参数（--build-arg k=v）。' },
          additionalProperties: { type: 'string' },
        },
      },
      ['org', 'repo', 'image', 'tag'],
    ),
    required: BUILD_REQUIRED,
  },
  'repo-build-preview': {
    description: 'Build a PREVIEW image from a repository Dockerfile (developer). The image NAME is forced to the repo and the TAG is forced to `preview-<branch>-<sha>` (+ optional tag-suffix), so a preview build can NEVER overwrite a release tag. Feed the result to `service-preview`.',
    descriptions: { zh: '从仓库 Dockerfile 构建 PREVIEW 镜像（开发者）。镜像名强制为仓库名，tag 强制为 `preview-<branch>-<sha>`（可加 tag-suffix），因此预览构建绝不会覆盖正式 tag。产物交给 `service-preview` 使用。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        dockerfile: str('Repo-relative Dockerfile path (default ./Dockerfile).', '仓库相对 Dockerfile 路径（默认 ./Dockerfile）。'),
        context: str('Repo-relative build context subdirectory (default: repo root).', '仓库相对的构建上下文子目录（默认：仓库根）。'),
        'tag-suffix': str('Optional suffix appended after the forced preview tag.', '可选后缀，追加在强制预览 tag 之后。'),
        'build-args': {
          type: 'object',
          description: 'Build arguments (--build-arg k=v).',
          descriptions: { zh: '构建参数（--build-arg k=v）。' },
          additionalProperties: { type: 'string' },
        },
      },
      ['org', 'repo'],
    ),
    required: BUILD_REQUIRED,
  },
  'oci-import': {
    description: 'Mirror an upstream container image (public, or private with auth-user/auth-token) into the deployment registry under an org you own. The image lands at <registry>/<org>/<name>:<tag> and is then usable from service-deploy or as a sandbox base. This is the image analogue of repo-import. Only runnable images can be mirrored (not arbitrary OCI artifacts); multi-arch sources collapse to linux/amd64.',
    descriptions: { zh: '将上游容器镜像（公开，或经 auth-user/auth-token 的私有镜像）复制到部署 registry 中你拥有的 org 下。镜像落在 <registry>/<org>/<name>:<tag>，之后可用于 service-deploy 或作为沙箱基础镜像。这是镜像版的 repo-import。仅可复制可运行的镜像（不能是任意 OCI 产物）；多架构源会退化为 linux/amd64。' },
    inputSchema: obj(
      {
        org: str('Destination org (must be owned by you; the image lands under it).', '目标组织（必须归你所有；镜像将落在其下）。'),
        name: str('Destination image name (single path segment).', '目标镜像名（单段路径）。'),
        tag: str('Destination tag (e.g. the upstream version).', '目标标签（如上游版本号）。'),
        source: str('Upstream image ref to mirror (e.g. docker.io/library/redis:7.4.2).', '要复制的上游镜像引用（如 docker.io/library/redis:7.4.2）。'),
        'auth-user': str('Basic-auth username for a private source (optional).', '私有源的基本认证用户名（可选）。'),
        'auth-token': str('Basic-auth token/password for a private source (optional).', '私有源的基本认证令牌/密码（可选）。'),
      },
      ['org', 'name', 'tag', 'source'],
    ),
    required: BUILD_REQUIRED,
  },
  'service-deploy': {
    description: 'Deploy a container image as a LONG-LIVED Kubernetes service (Deployment + Service). Use this for something a sandbox talks to (an app, a proxy, ...), NOT for execution. The image runs as-is (no worker injection). Returns the in-cluster URL and anonymous public URLs (`https://<name>.<domain>`, one per public port). Set `services` to expose ports: each entry is `{ preset: tcp80|tcp443|udp443, target-port, name? }`. tcp80 is the ONLY publicly reachable preset (the app must serve HTTP on its target port); tcp443/udp443 are in-cluster only. Entries sharing the same `name` merge into one Service (multi-port); a second public endpoint needs a distinct `name` (its host becomes `<name>-<name>.<domain>`). Omit `services` for a single public port 80 -> container-port. Updating an existing service you own redeploys it. Set kvm=true for /dev/kvm and gpu-count>0 for NVIDIA GPUs (both non-privileged).',
    descriptions: { zh: '将容器镜像部署为长期运行的 Kubernetes 服务（Deployment + Service）。用于沙箱需要访问的东西（应用、代理等），不是用来执行的。镜像原样运行（不注入 worker）。返回集群内地址与匿名公开地址（`https://<name>.<domain>`，每个公开端口一个）。用 `services` 声明端口：每项 `{ preset: tcp80|tcp443|udp443, target-port, name? }`。只有 tcp80 可公开访问（应用需在其目标端口提供 HTTP）；tcp443/udp443 仅集群内。相同 `name` 的项合并为一个 Service（多端口）；要第二个公开端点需不同的 `name`（其主机名为 `<name>-<name>.<domain>`）。省略 `services` 即单个公开端口 80 → 容器端口。更新自己拥有的服务即重新部署。kvm=true 可获 /dev/kvm，gpu-count>0 可获 NVIDIA GPU（均非特权）。' },
    inputSchema: obj(
      {
        image: str('Image to deploy (see list-oci-images).', '要部署的镜像（见 list-oci-images）。'),
        name: str('Service name (default: derived from the session).', '服务名（默认：由会话名派生）。'),
        'container-port': int('Default target port for entries without one (default 8080).', '未指定 target-port 的条目所用的默认容器端口（默认 8080）。'),
        'service-port': int('Deprecated; prefer `services`.', '已弃用；请用 `services`。'),
        replicas: int('Replicas (default 1).', '副本数（默认 1）。'),
        cpu: str('CPU request/limit (e.g. 250m).', 'CPU 请求/上限（如 250m）。'),
        memory: str('Memory request/limit (e.g. 256Mi).', '内存请求/上限（如 256Mi）。'),
        command: { type: 'array', items: { type: 'string' }, description: 'Command override (argv).', descriptions: { zh: '命令覆盖（argv）。' } },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables.', descriptions: { zh: '环境变量。' } },
        services: {
          type: 'array',
          description: 'Ports to expose. Each: { preset (tcp80|tcp443|udp443), target-port, name? }. Omit for a single public port 80.',
          descriptions: { zh: '要暴露的端口。每项：{ preset (tcp80|tcp443|udp443), target-port, name? }。省略即单个公开端口 80。' },
          items: {
            type: 'object',
            properties: {
              preset: { type: 'string', enum: ['tcp80', 'tcp443', 'udp443'] },
              'target-port': int('Container port to forward to (default container-port).', '转发的容器端口（默认 container-port）。'),
              name: str('Service suffix: "" = primary; else a sibling service <name>-<suffix>.', '服务后缀：空 = 主服务；否则为兄弟服务 <name>-<后缀>。'),
            },
            required: ['preset'],
          },
        },
        kvm: { type: 'boolean', description: 'Request KVM (/dev/kvm) — non-privileged, via the device plugin.', descriptions: { zh: '请求 KVM（/dev/kvm）——非特权，经 device plugin。' } },
        'gpu-count': int('Number of NVIDIA GPUs to request (0 = none; needs the GPU device plugin).', '请求的 NVIDIA GPU 卡数（0 = 无；需 GPU device plugin）。'),
        volumes: volumesSchema(),
      },
      [],
    ),
    required: SANDBOX_REQUIRED,
  },
  'service-list': {
    description: 'List the services this tenant deployed (name, phase, image, in-cluster url, ports, public urls, replicas).',
    descriptions: { zh: '列出本租户部署的服务（名称、状态、镜像、集群内地址、端口、公开地址、副本数）。' },
    inputSchema: obj({}),
    required: SANDBOX_REQUIRED,
  },
  'service-preview': {
    description: 'Deploy a PREVIEW service for verification (developer): session-bound, CLUSTER-ONLY (no public URL), and reclaimed on session end or after a TTL. The name is prefixed with the session slug so it never collides with a release service. Use it to run an image and verify it in a sandbox; read output with `service-logs`.',
    descriptions: { zh: '部署用于验证的 PREVIEW 服务（开发者）：绑定会话、仅集群内可达（无公开地址）、会话结束或超过 TTL 后自动回收。名字会加上会话前缀，绝不与正式服务冲突。用它运行镜像并在沙箱中验证；用 `service-logs` 读取输出。' },
    inputSchema: obj(
      {
        image: str('Image to run (e.g. from repo-build-preview).', '要运行的镜像（如来自 repo-build-preview）。'),
        name: str('Base name (a DNS-1123 label); the gateway prefixes it with the session slug.', '基础名（DNS-1123 label）；gateway 会加上会话前缀。'),
        'container-port': int('Default target port for entries without one (default 8080).', '未指定 target-port 的条目所用的默认容器端口（默认 8080）。'),
        cpu: str('CPU request/limit (e.g. 250m).', 'CPU 请求/上限（如 250m）。'),
        memory: str('Memory request/limit (e.g. 256Mi).', '内存请求/上限（如 256Mi）。'),
        command: { type: 'array', items: { type: 'string' }, description: 'Command override (argv).', descriptions: { zh: '命令覆盖（argv）。' } },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables.', descriptions: { zh: '环境变量。' } },
        services: {
          type: 'array',
          description: 'Ports to expose (cluster-internal only). Each: { preset, target-port, name? }.',
          descriptions: { zh: '要暴露的端口（仅集群内）。每项：{ preset, target-port, name? }。' },
          items: {
            type: 'object',
            properties: {
              preset: { type: 'string', enum: ['tcp80', 'tcp443', 'udp443'] },
              'target-port': int('Container port to forward to (default container-port).', '转发的容器端口（默认 container-port）。'),
              name: str('Service suffix.', '服务后缀。'),
            },
            required: ['preset'],
          },
        },
        'ttl-seconds': int('TTL before reclamation (0 = deployment default).', '回收前的 TTL（0 = 部署默认）。'),
        kvm: { type: 'boolean', description: 'Request KVM (/dev/kvm) — non-privileged.', descriptions: { zh: '请求 KVM（/dev/kvm）——非特权。' } },
        'gpu-count': int('Number of NVIDIA GPUs to request (0 = none).', '请求的 NVIDIA GPU 卡数（0 = 无）。'),
        volumes: volumesSchema(),
      },
      ['image'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'service-delete': {
    description: 'Delete a deployed service (Deployment + Service).',
    descriptions: { zh: '删除已部署的服务（Deployment + Service）。' },
    inputSchema: obj({ name: str('Service name.', '服务名。') }, ['name']),
    required: SANDBOX_REQUIRED,
  },
  'service-logs': {
    description: 'Read a service\'s container log (a bounded tail). Use `previous` to read the crashed instance before a restart (CrashLoopBackOff). Cluster-observed via the gateway.',
    descriptions: { zh: '读取服务的容器日志（有界 tail）。用 `previous` 读取重启前崩溃的那次实例（CrashLoopBackOff）。经 gateway 从集群读取。' },
    inputSchema: obj(
      {
        name: str('Service name.', '服务名。'),
        'tail-lines': int('Number of trailing lines (0 = deployment default).', '末尾行数（0 = 部署默认）。'),
        previous: { type: 'boolean', description: 'Read the previous container instance (the crash).', descriptions: { zh: '读取上一个容器实例（崩溃那次）。' } },
      },
      ['name'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'pvc-create': {
    description: 'Create a named, tenant-owned PersistentVolumeClaim (admin) for service data. Services mount it by name via service-deploy/service-preview `volumes`. Uses the deployment storage class (self-hosted local-path -> /home/develop/PVC on the host). NOTE: local-path does not enforce `size`; a fresh PVC stays Pending until a service mounts it.',
    descriptions: { zh: '创建命名、归属本租户的 PersistentVolumeClaim（管理员），用于服务数据。服务通过 service-deploy/service-preview 的 `volumes` 按名挂载。使用部署存储类（自建 local-path → 宿主机 /home/develop/PVC）。注意：local-path 不强制 `size`；新建的 PVC 在有服务挂载前保持 Pending。' },
    inputSchema: obj(
      {
        name: str('PVC name (a DNS-1123 label).', 'PVC 名称（DNS-1123 label）。'),
        size: str('Requested size, e.g. 1Gi (default 1Gi). Not enforced by local-path.', '请求容量，如 1Gi（默认 1Gi）。local-path 不强制。'),
        'storage-class': str('StorageClass (default the deployment class; only that value is accepted).', '存储类（默认为部署配置的类；仅接受该值）。'),
      },
      ['name'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'pvc-list': {
    description: 'List the tenant\'s PVCs (name, phase, size, storage class, and which services mount each).',
    descriptions: { zh: '列出本租户的 PVC（名称、状态、容量、存储类，以及哪些服务正在挂载）。' },
    inputSchema: obj({}),
    required: SANDBOX_REQUIRED,
  },
  'pvc-delete': {
    description: 'Delete a PVC (admin). REFUSED while any service still mounts it. Deletion is destructive: local-path removes the on-disk directory (reclaim policy Delete).',
    descriptions: { zh: '删除 PVC（管理员）。若有服务仍在挂载则拒绝。删除是破坏性的：local-path 会删除磁盘目录（回收策略 Delete）。' },
    inputSchema: obj(
      { name: str('PVC name.', 'PVC 名称。') },
      ['name'],
    ),
    required: SANDBOX_REQUIRED,
  },
  'repo-file-read': {
    description: 'Read a text file from a repository ref, line-numbered (1-based), windowed by offset/limit. Records the lines as "seen" so a later repo-file-edit may change them.',
    descriptions: { zh: '从仓库某个 ref 读取文本文件，带行号（从 1 开始），用 offset/limit 分窗。会记录已“看到”的行，之后 repo-file-edit 才能修改。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('File path, relative to the repository root.', '文件路径，相对于仓库根目录。'),
        offset: int('Start line (0-based, default 0).', '起始行（从 0 开始，默认 0）。'),
        limit: int('Maximum lines (default 200, max 1000).', '最多行数（默认 200，最大 1000）。'),
      },
      ['org', 'repo', 'path'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-file-write': {
    description: 'Create or overwrite a file in the repository as ONE commit. Uses the current blob sha for optimistic locking.',
    descriptions: { zh: '在仓库中创建或覆盖文件，作为一次提交。使用当前 blob sha 做乐观锁。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('File path, relative to the repository root.', '文件路径，相对于仓库根目录。'),
        content: str('Full file content.', '完整文件内容。'),
        message: str('Commit message (defaults to "write <path>").', '提交信息（默认 "write <path>"）。'),
      },
      ['org', 'repo', 'path', 'content'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-file-edit': {
    description: 'Edit a repository file by line numbers (1-based) as ONE commit. end-line < start-line inserts; otherwise replaces [start-line, end-line]. Requires a prior repo-file-read of the file, only the seen lines may change, and the file must be unchanged since (blob sha). Returns a summary + unified diff.',
    descriptions: { zh: '按行号（从 1 开始）编辑仓库文件，作为一次提交。end-line < start-line 插入；否则替换 [start-line, end-line]。必须先 repo-file-read 过该文件，只能改已“看到”的行，且文件自读取后未变化（blob sha）。返回摘要 + unified diff。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('File path, relative to the repository root.', '文件路径，相对于仓库根目录。'),
        'start-line': int('Start line (1-based).', '起始行（从 1 开始）。'),
        'end-line': int('End line (1-based, inclusive); < start-line means insert.', '结束行（从 1 开始，含端点）；小于 start-line 表示插入。'),
        content: str('Replacement or inserted text.', '替换或插入的文本。'),
        message: str('Commit message (defaults to "edit <path>").', '提交信息（默认 "edit <path>"）。'),
      },
      ['org', 'repo', 'path', 'start-line', 'end-line'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-file-delete': {
    description: 'Delete a file from the repository as ONE commit. Uses the current blob sha for optimistic locking.',
    descriptions: { zh: '从仓库删除文件，作为一次提交。使用当前 blob sha 做乐观锁。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('File path, relative to the repository root.', '文件路径，相对于仓库根目录。'),
        message: str('Commit message (defaults to "delete <path>").', '提交信息（默认 "delete <path>"）。'),
      },
      ['org', 'repo', 'path'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-file-list': {
    description: 'List a repository directory (or a single file) at a ref.',
    descriptions: { zh: '列出仓库某个 ref 下的目录（或单个文件）。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('Directory or file path (default: repository root).', '目录或文件路径（默认：仓库根目录）。'),
      },
      ['org', 'repo'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-commit': {
    description: 'Finalize the branch\'s staged changes under `message` and open a fresh staging area. repo-file-write/repo-file-edit/repo-file-delete accumulate into one staging commit; this names that commit. Required before opening or merging a change request.',
    descriptions: { zh: '用 `message` finalize 分支上已暂存的改动，并开启新的暂存区。repo-file-write/repo-file-edit/repo-file-delete 会累积进同一个暂存提交；本工具为该提交命名。在创建或合并合并请求之前必须执行。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        message: str('Commit message.', '提交信息。'),
      },
      ['org', 'repo', 'message'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-log': {
    description: 'View commit history, optionally scoped to a path and/or ref.',
    descriptions: { zh: '查看提交历史，可限定路径与/或 ref。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('Only commits touching this path.', '仅包含涉及该路径的提交。'),
        limit: int('Maximum commits (default 50, max 200).', '最多提交数（默认 50，最大 200）。'),
      },
      ['org', 'repo'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-show': {
    description: 'Show one commit: metadata plus its unified diff.',
    descriptions: { zh: '查看单个提交：元数据及其 unified diff。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        sha: str('Commit sha.', '提交 sha。'),
      },
      ['org', 'repo', 'sha'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-diff': {
    description: 'Compare two refs (base...head), returning per-file patches.',
    descriptions: { zh: '比较两个 ref（base...head），返回逐文件补丁。' },
    inputSchema: obj(
      {
        org: str('Organization (owner) of the repository.', '仓库所属组织（owner）。'),
        repo: str('Repository name.', '仓库名。'),
        base: str('Base ref (branch/sha/tag).', '基础 ref（分支/sha/标签）。'),
        head: str('Head ref (branch/sha/tag).', '目标 ref（分支/sha/标签）。'),
      },
      ['org', 'repo', 'base', 'head'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-branches': {
    description: 'List the repository branches.',
    descriptions: { zh: '列出仓库分支。' },
    inputSchema: obj({ ...REPO_ADDR }, ['org', 'repo']),
    required: REPO_REQUIRED,
  },
  'repo-branch-create': {
    description: 'Create a branch from a ref (default: the repository default branch). MAINTAINER ONLY (main-branch session): a feature-branch session is bound to exactly one branch and cannot create more.',
    descriptions: { zh: '从某个 ref 创建分支（默认：仓库默认分支）。仅限维护者（main 分支会话）：功能分支会话绑定到唯一分支，不能创建更多分支。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        name: str('New branch name.', '新分支名。'),
        from: str('Source ref (default: the repo default branch).', '源 ref（默认：仓库默认分支）。'),
      },
      ['org', 'repo', 'name'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-tags': {
    description: 'List the repository tags.',
    descriptions: { zh: '列出仓库标签。' },
    inputSchema: obj({ ...REPO_ADDR }, ['org', 'repo']),
    required: REPO_REQUIRED,
  },
  'repo-tag-create': {
    description: 'Create a tag at a target ref (default: the repository default branch).',
    descriptions: { zh: '在某个目标 ref 创建标签（默认：仓库默认分支）。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        name: str('Tag name.', '标签名。'),
        target: str('Target ref (default: the repo default branch).', '目标 ref（默认：仓库默认分支）。'),
      },
      ['org', 'repo', 'name'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-mr-create': {
    description: 'Open a pull request (merge request).',
    descriptions: { zh: '创建合并请求（pull request）。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        title: str('Title.', '标题。'),
        head: str('Source branch.', '源分支。'),
        base: str('Target branch.', '目标分支。'),
        body: str('Optional description.', '可选描述。'),
      },
      ['org', 'repo', 'title', 'head', 'base'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-mr-list': {
    description: 'List pull requests (optional state filter: open|closed|all).',
    descriptions: { zh: '列出合并请求（可选状态：open|closed|all）。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        state: str('State filter (open|closed|all).', '状态过滤（open|closed|all）。'),
      },
      ['org', 'repo'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-mr-comment': {
    description: 'Comment on a pull request.',
    descriptions: { zh: '在合并请求上评论。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        index: int('Pull request number.', '合并请求编号。'),
        body: str('Comment body.', '评论内容。'),
      },
      ['org', 'repo', 'index', 'body'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-mail-send': {
    description: 'Send a message into a repository branch\'s session mailbox (wakes that session\'s turn). Addressing is by org/repo + optional branch (default main); the branch session is created if needed.',
    descriptions: { zh: '向某仓库分支的会话邮箱投递一条消息（唤醒该会话的回合）。按 org/repo + 可选 branch（默认 main）寻址；分支会话不存在时会自动创建。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        branch: str('Target branch (default: main).', '目标分支（默认：main）。'),
        text: str('Message text.', '消息内容。'),
      },
      ['org', 'repo', 'text'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-mr-merge': {
    description: 'Merge a pull request.',
    descriptions: { zh: '合并合并请求。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        index: int('Pull request number.', '合并请求编号。'),
      },
      ['org', 'repo', 'index'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-branch-sync': {
    description: 'Catch a feature branch up with main by committing a merge of main into it. Files changed on both sides are merged automatically; genuine conflicts are written into the branch as ABCP-CONFLICT marker blocks that YOU must resolve (edit the file, then commit) before repo-mr-create/repo-mr-merge will accept the branch. Defaults to the current session\'s org/repo/branch.',
    descriptions: { zh: '将 main 合并进功能分支，使分支追平 main。两侧都改动的文件自动合并；真正的冲突会以 ABCP-CONFLICT 标记块写入分支，必须由本会话解决（编辑文件后提交）才能通过 repo-mr-create/repo-mr-merge。默认使用当前会话的 org/repo/branch。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        branch: str('Feature branch (default: the session\'s branch).', '功能分支（默认：当前会话的分支）。'),
      },
      [],
    ),
    required: REPO_REQUIRED,
  },
  'repo-file-restore': {
    description: 'Restore ONE file on a branch to its exact content at another ref or commit (binary-safe). Use it to recover a file version during conflict resolution.',
    descriptions: { zh: '把分支上的某个文件恢复为另一 ref 或提交时的确切内容（二进制安全）。用于解决冲突时找回文件版本。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        path: str('Repo-relative file path.', '仓库内文件路径。'),
        from: str('Source ref or commit sha to restore from.', '用于恢复的源 ref 或提交 sha。'),
        ref: str('Target branch (default: the repo default branch).', '目标分支（默认：仓库默认分支）。'),
      },
      ['org', 'repo', 'path', 'from'],
    ),
    required: REPO_REQUIRED,
  },
}

/**
 * Execution tools that operate on a sandbox and therefore require a
 * `worker-name`. Lifecycle tools (sandbox-create/list/status/delete) and all
 * repo-* tools are excluded.
 */
const WORKER_TOOLS = new Set([
  'sandbox-info', 'sandbox-exec',
  'sandbox-job-start', 'sandbox-job-output', 'sandbox-job-wait',
  'sandbox-job-kill', 'sandbox-job-stdin', 'sandbox-job-list',
  'sandbox-file-read', 'sandbox-file-write', 'sandbox-file-edit', 'sandbox-file-ls', 'sandbox-file-rm',
  'sandbox-file-download', 'sandbox-file-upload', 'sandbox-checkout', 'sandbox-port',
])

// Inject the required `worker-name` argument into every execution tool's
// schema (single source, so a new execution tool cannot forget it).
for (const name of WORKER_TOOLS) {
  const meta = TOOL_META[name]
  if (meta === undefined) continue
  const schema = meta.inputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  schema.properties = { 'worker-name': WORKER_NAME, ...(schema.properties ?? {}) }
  schema.required = ['worker-name', ...(schema.required ?? [])]
}
