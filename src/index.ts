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
  forgejoConfig,
  gatewayConfig,
  type GatewayConfig,
  REPO_REQUIRED,
  SANDBOX_REQUIRED,
  type ForgejoConfig,
} from './config.js'
import { localeOf, tr } from './i18n.js'
import { materializeLifecycle, parseSessionName } from './tools/lifecycle.js'
import { domainOf, strArg } from './tools/shared.js'
import {
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
import { repoCreateOrg, repoCreateRepo, repoImport } from './tools/repo-admin.js'
import { repoBranchSync, repoRestore } from './tools/repo-sync.js'
import { repoMailSend, type MailCtx } from './tools/mail.js'
import { sandboxCheckout, sandboxPort, type BridgeCtx } from './tools/bridge.js'
import {
  renderInfo,
  sandboxCreate,
  sandboxDelete,
  listOCIImages,
  sandboxList,
  sandboxStatus,
  type SandboxCtx,
} from './tools/sandbox.js'
import { repoBuildImage, type BuildCtx } from './tools/imagebuild.js'
import { serviceDelete, serviceDeploy, serviceList, type ServiceCtx } from './tools/services.js'

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
  /** Forgejo client factory (overridable in tests). */
  makeForgejo?: (cfg: ForgejoConfig) => Forgejo
  /** Workspace-gateway client factory (overridable in tests). */
  makeManager?: (cfg: GatewayConfig, tenant: string) => GatewayClient
}

/**
 * Build the workspace extension: sandbox lifecycle (workspace gateway), sandbox
 * execution (easyworker), repo-* tools (Forgejo) and the checkout/port bridge.
 * Config is resolved per call.
 *
 * `bus` is only needed for the agent file RPCs (sandbox-download/upload).
 */
export function createWorkspaceConfig(
  bus: Bus | undefined,
  opts: WorkspaceExtensionOpts,
): ExtensionConfig {
  const deps = opts.deps ?? (bus !== undefined ? agentFileDeps(bus) : undefined)
  const cache = new WorkerClientCache()
  const makeClient = opts.makeClient ?? ((ep: { url: string; token: string }) => cache.get(ep))
  const makeForgejo = opts.makeForgejo ?? ((cfg: ForgejoConfig) => new Forgejo({ url: cfg.url, auth: cfg.auth }))
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
    makeForgejo(forgejoConfig(opts.getConfig, session, tenant, locale))

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
      return fn({ forgejo: repoClient(s, t, locale), gateway: managerFor(s, t, locale), deps, tenant: t, session: s, locale }, args ?? {})
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
      return fn({ workspace: managerFor(s, t, locale), locale, resolveWorker }, args ?? {})
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

  /** Wrap a bridge (repo + worker) tool. */
  const bridgeWrap = (
    fn: (ctx: BridgeCtx, args: Record<string, unknown>) => Promise<ToolResultData>,
  ): ToolSpec['execute'] =>
    async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const s = sessionName ?? ''
      const locale = await localeOf(deps, t, s)
      const client = await resolveWorkerClient(args ?? {}, s, t, locale)
      return fn({ client, forgejo: repoClient(s, t, locale), locale }, args ?? {})
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
    'sandbox-read': fileWrap(readFile),
    'sandbox-write': fileWrap(writeFile),
    'sandbox-edit': fileWrap(editFile),
    'sandbox-ls': fileWrap(listFiles),
    'sandbox-download': fileWrap(downloadFile),
    'sandbox-upload': fileWrap(uploadFile),
    'sandbox-checkout': bridgeWrap(sandboxCheckout),
    'sandbox-port': bridgeWrap(sandboxPort),

    // ---- repo-* ----
    'repo-explore': repoWrap(repoExplore),
    'repo-create-org': repoWrap(repoCreateOrg),
    'repo-create-repo': repoWrap(repoCreateRepo),
    'repo-import': repoWrap(repoImport),
    'repo-build-image': buildWrap(repoBuildImage),
    'repo-mail-send': mailWrap(repoMailSend),

    // ---- services (long-lived Deployments) ----
    'service-deploy': serviceWrap(serviceDeploy),
    'service-list': serviceWrap(serviceList),
    'service-delete': serviceWrap(serviceDelete),
    'repo-read': repoWrap(repoRead),
    'repo-write': repoWrap(repoWrite),
    'repo-edit': repoWrap(repoEdit),
    'repo-delete': repoWrap(repoDelete),
    'repo-list': repoWrap(repoList),
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
    'repo-restore': repoWrap(repoRestore),
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
      // Cascade: delete every sandbox this session created (creator == t/sess).
      // Best-effort; the gateway's idle reaper is the backstop.
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
 * Delete every sandbox created by `tenant/session` (the creator annotation the
 * gateway stamps). Best-effort; the gateway's idle reaper is the backstop.
 */
async function deleteSessionSandboxes(
  workspace: GatewayClient,
  tenant: string,
  session: string,
): Promise<void> {
  const creator = `${tenant}/${session}`
  const res = await workspace.listSandboxes({})
  for (const sb of res.sandboxes) {
    if (sb.creator === creator) await workspace.deleteSandbox({ name: sb.name })
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
  [CONFIG.forgejoUrl]: {
    type: 'string',
    default: '',
    scope: 'global',
    description: 'Base URL of the Forgejo instance (e.g. http://forgejo.example).',
    descriptions: { zh: 'Forgejo 实例的基础地址（如 http://forgejo.example）。' },
  },
  [CONFIG.forgejoToken]: {
    type: 'string',
    default: '',
    scope: 'global',
    description: 'Forgejo personal access token (preferred over user/password).',
    descriptions: { zh: 'Forgejo 个人访问令牌（优先于用户名/密码）。' },
  },
  [CONFIG.forgejoUser]: {
    type: 'string',
    default: '',
    scope: 'global',
    description: 'Forgejo username (used only when forgejo-token is empty).',
    descriptions: { zh: 'Forgejo 用户名（仅当 forgejo-token 为空时使用）。' },
  },
  [CONFIG.forgejoPassword]: {
    type: 'string',
    default: '',
    scope: 'global',
    description: 'Forgejo password (used only when forgejo-token is empty).',
    descriptions: { zh: 'Forgejo 密码（仅当 forgejo-token 为空时使用）。' },
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
      'Create a sandbox from ANY base image and wait up to 60s for it to become healthy. The gateway derives a runnable sandbox by injecting the easyworker binary into the base image at launch time, so any image works (see list-oci-images for available images). `image` is a full image ref; omit it for the deployment default base. Returns the sandbox name, its in-cluster service DNS, and the worker environment (OS/arch, workspace root, boot id).',
    descriptions: { zh: '用任意基础镜像创建沙箱，最多等待 60 秒就绪。网关会在启动时把 easyworker 二进制注入基础镜像，因此任意镜像都可用（可用 list-oci-images 查看现有镜像）。`image` 是完整镜像引用；省略则用部署默认基础镜像。返回沙箱名、集群内服务域名，以及 worker 环境（OS/架构、工作区根目录、boot id）。' },
    inputSchema: obj(
      {
        name: str('Logical sandbox name (unique among live sandboxes).', '逻辑沙箱名（在存活沙箱中唯一）。'),
        image: str('Full base image ref (see list-oci-images; omit for the deployment default).', '完整基础镜像引用（见 list-oci-images；省略则用部署默认）。'),
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
    description: 'Browse OCI images in the registry. `owner` selects the namespace (default: the deployment toolchain org). Pass `name` to list ONE image\'s tags; omit it to list all of the owner\'s images. Returns full refs usable with sandbox-create.',
    descriptions: { zh: '浏览 registry 中的 OCI 镜像。`owner` 选择命名空间（默认：部署的 toolchain 组织）。传 `name` 列出单个镜像的所有 tag；省略则列出该 owner 的全部镜像。返回的完整引用可直接用于 sandbox-create。' },
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
      'Start a long-running shell command and return the job id immediately (no waiting). Drive it with sandbox-job-wait/sandbox-job-output/sandbox-job-stdin/sandbox-job-kill. ' +
      EXEC_WARNING_EN,
    descriptions: {
      zh: '启动一个长时间运行的 shell 命令并立即返回 job id（不等待）。用 sandbox-job-wait/sandbox-job-output/sandbox-job-stdin/sandbox-job-kill 进行后续控制。' +
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
  'sandbox-read': {
    description: 'Read a text file from the sandbox workspace with line numbers, windowed by offset/limit. Binary files are rejected. Reading records the lines as "seen" so a later sandbox-edit may change them.',
    descriptions: { zh: '从沙箱工作区读取文本文件并带行号，通过 offset/limit 分窗。二进制文件会被拒绝。读取会记录已“看到”的行，之后 sandbox-edit 才能修改这些行。' },
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
  'sandbox-write': {
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
  'sandbox-edit': {
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
  'sandbox-ls': {
    description: 'List a sandbox path as a breadth-first tree (levels 1..depth) with sizes. Directories beyond the cap stay collapsed.',
    descriptions: { zh: '以广度优先树（第 1..depth 层）列出沙箱路径并显示大小。超过上限的目录保持折叠。' },
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
  'sandbox-download': {
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
  'sandbox-upload': {
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
    description: 'Create a Forgejo organization. `org` is the organization slug. Requires a credential allowed to create organizations (e.g. an admin PAT).',
    descriptions: { zh: '创建 Forgejo 组织。`org` 为组织标识（slug）。需要具备创建组织权限的凭据（如管理员 PAT）。' },
    inputSchema: obj(
      {
        org: str('Organization slug to create (required).', '要创建的组织标识（必填）。'),
        'full-name': str('Display name.', '显示名称。'),
        description: str('Description.', '描述。'),
        visibility: {
          type: 'string',
          enum: ['public', 'limited', 'private'],
          description: 'Visibility (default public).',
          descriptions: { zh: '可见性（默认 public）。' },
        },
        email: str('Contact email.', '联系邮箱。'),
        location: str('Location.', '所在地。'),
        website: str('Website.', '网站。'),
      },
      ['org'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-create-repo': {
    description: 'Create a repository under `org` (an organization or a user; falls back to the authenticated user when not an org). Optionally auto-initialized with a default branch.',
    descriptions: { zh: '在 `org`（组织或用户；若不是组织则回退到当前认证用户）下创建仓库。可选自动初始化并设定默认分支。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        private: {
          type: 'boolean',
          description: 'Create a private repository.',
          descriptions: { zh: '创建私有仓库。' },
        },
        'auto-init': {
          type: 'boolean',
          description: 'Initialize the repository with a README + initial commit.',
          descriptions: { zh: '用 README + 初始提交初始化仓库。' },
        },
        'default-branch': str('Default branch (used when auto-init is true).', '默认分支（auto-init 为 true 时使用）。'),
        description: str('Repository description.', '仓库描述。'),
        readme: str('Readme template (with auto-init).', 'README 模板（配合 auto-init）。'),
        gitignores: str('.gitignore template (with auto-init).', '.gitignore 模板（配合 auto-init）。'),
        license: str('License template (with auto-init).', '许可证模板（配合 auto-init）。'),
      },
      ['org', 'repo'],
    ),
    required: REPO_REQUIRED,
  },
  'repo-import': {
    description: 'Import an EXTERNAL git repository into an org (admin). Forgejo clones the full repository; when `ref` is given, that ref becomes the default branch and the other branches are deleted (single-branch import). Refuses to overwrite an existing repo. `auth-token`/`auth-user` support private sources; `mirror` keeps it synced.',
    descriptions: { zh: '将外部 git 仓库导入到某组织（管理员）。Forgejo 会克隆完整仓库；给出 `ref` 时，该 ref 会成为默认分支且其余分支被删除（单分支导入）。已存在的仓库会被拒绝。`auth-token`/`auth-user` 支持私有源；`mirror` 保持同步。' },
    inputSchema: obj(
      {
        org: str('Target organization.', '目标组织。'),
        url: str('External git clone URL (https/ssh).', '外部 git 克隆地址（https/ssh）。'),
        repo: str('Target repo name (default: derived from the URL).', '目标仓库名（默认：从 URL 推断）。'),
        ref: str('Import ONLY this branch/ref (default: all branches + source default).', '仅导入该分支/ref（默认：全部分支 + 源默认分支）。'),
        'auth-user': str('Basic-auth username for a private source.', '私有源的基本认证用户名。'),
        'auth-token': str('Access token for a private source.', '私有源的访问令牌。'),
        private: bool('Make the imported repo private (default true).', '将导入的仓库设为私有（默认 true）。'),
        mirror: bool('Keep it as a mirror of the source (default false).', '作为源的镜像持续同步（默认 false）。'),
        description: str('Repository description.', '仓库描述。'),
      },
      ['org', 'url'],
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
  'service-deploy': {
    description: 'Deploy a container image as a LONG-LIVED Kubernetes service (Deployment + Service). Use this for something a sandbox talks to (an app, a proxy, ...), NOT for execution. The image runs as-is (no worker injection). Returns the in-cluster URL. Updating an existing service you own redeploys it. Set kvm=true for /dev/kvm and gpu-count>0 for NVIDIA GPUs (both non-privileged).',
    descriptions: { zh: '将容器镜像部署为长期运行的 Kubernetes 服务（Deployment + Service）。用于沙箱需要访问的东西（应用、代理等），不是用来执行的。镜像原样运行（不注入 worker）。返回集群内地址。更新自己拥有的服务即重新部署。kvm=true 可获 /dev/kvm，gpu-count>0 可获 NVIDIA GPU（均非特权）。' },
    inputSchema: obj(
      {
        image: str('Image to deploy (see list-oci-images).', '要部署的镜像（见 list-oci-images）。'),
        name: str('Service name (default: derived from the session).', '服务名（默认：由会话名派生）。'),
        'container-port': int('Container port the app listens on (default 8080).', '应用监听的容器端口（默认 8080）。'),
        'service-port': int('In-cluster Service port (default 80).', '集群内 Service 端口（默认 80）。'),
        replicas: int('Replicas (default 1).', '副本数（默认 1）。'),
        cpu: str('CPU request/limit (e.g. 250m).', 'CPU 请求/上限（如 250m）。'),
        memory: str('Memory request/limit (e.g. 256Mi).', '内存请求/上限（如 256Mi）。'),
        command: { type: 'array', items: { type: 'string' }, description: 'Command override (argv).', descriptions: { zh: '命令覆盖（argv）。' } },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables.', descriptions: { zh: '环境变量。' } },
        kvm: { type: 'boolean', description: 'Request KVM (/dev/kvm) — non-privileged, via the device plugin.', descriptions: { zh: '请求 KVM（/dev/kvm）——非特权，经 device plugin。' } },
        'gpu-count': int('Number of NVIDIA GPUs to request (0 = none; needs the GPU device plugin).', '请求的 NVIDIA GPU 卡数（0 = 无；需 GPU device plugin）。'),
      },
      [],
    ),
    required: SANDBOX_REQUIRED,
  },
  'service-list': {
    description: 'List the services this tenant deployed (name, phase, image, url, replicas).',
    descriptions: { zh: '列出本租户部署的服务（名称、状态、镜像、地址、副本数）。' },
    inputSchema: obj({}),
    required: SANDBOX_REQUIRED,
  },
  'service-delete': {
    description: 'Delete a deployed service (Deployment + Service).',
    descriptions: { zh: '删除已部署的服务（Deployment + Service）。' },
    inputSchema: obj({ name: str('Service name.', '服务名。') }, ['name']),
    required: SANDBOX_REQUIRED,
  },
  'repo-read': {
    description: 'Read a text file from a repository ref, line-numbered (1-based), windowed by offset/limit. Records the lines as "seen" so a later repo-edit may change them.',
    descriptions: { zh: '从仓库某个 ref 读取文本文件，带行号（从 1 开始），用 offset/limit 分窗。会记录已“看到”的行，之后 repo-edit 才能修改。' },
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
  'repo-write': {
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
  'repo-edit': {
    description: 'Edit a repository file by line numbers (1-based) as ONE commit. end-line < start-line inserts; otherwise replaces [start-line, end-line]. Requires a prior repo-read of the file, only the seen lines may change, and the file must be unchanged since (blob sha). Returns a summary + unified diff.',
    descriptions: { zh: '按行号（从 1 开始）编辑仓库文件，作为一次提交。end-line < start-line 插入；否则替换 [start-line, end-line]。必须先 repo-read 过该文件，只能改已“看到”的行，且文件自读取后未变化（blob sha）。返回摘要 + unified diff。' },
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
  'repo-delete': {
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
  'repo-list': {
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
    description: 'Commit several files to the repository atomically as ONE commit (create/update/delete). Optionally create a new branch in the same commit.',
    descriptions: { zh: '把多个文件原子地提交为一次提交（create/update/delete）。可在同一次提交中创建新分支。' },
    inputSchema: obj(
      {
        ...REPO_ADDR,
        message: str('Commit message.', '提交信息。'),
        'new-branch': str('Create this new branch from `ref` and commit there (optional).', '从 `ref` 创建该新分支并在其上提交（可选）。'),
        files: {
          type: 'array',
          description: 'Files to commit. Each: { path, operation (create|update|delete), content?, sha? }.',
          descriptions: { zh: '要提交的文件。每项：{ path, operation (create|update|delete), content?, sha? }。' },
          items: {
            type: 'object',
            properties: {
              path: str('Repo-relative path.', '仓库相对路径。'),
              operation: { type: 'string', enum: ['create', 'update', 'delete'] },
              content: str('UTF-8 content (ignored for delete).', 'UTF-8 内容（delete 时忽略）。'),
              sha: str('Base blob sha for optimistic locking (update/delete).', '乐观锁用的基础 blob sha（update/delete）。'),
            },
            required: ['path'],
          },
        },
      },
      ['org', 'repo', 'message', 'files'],
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
    description: 'Create a branch from a ref (default: the repository default branch).',
    descriptions: { zh: '从某个 ref 创建分支（默认：仓库默认分支）。' },
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
  'repo-restore': {
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
  'sandbox-read', 'sandbox-write', 'sandbox-edit', 'sandbox-ls',
  'sandbox-download', 'sandbox-upload', 'sandbox-checkout', 'sandbox-port',
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
