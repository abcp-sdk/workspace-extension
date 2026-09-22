import {
  BASE_LOCALE,
  type Catalog,
  defineI18n,
  translate,
} from '@abc-protocol/sdk'
import type { WorkspaceDeps } from './deps.js'

/**
 * Workspace-extension message catalog for RUNTIME tool text (content + error)
 * that reaches the model. Tool DESCRIPTIONS are localized separately through
 * the manifest (`description` + `descriptions[locale]`).
 *
 * The locale set is an OPEN map: add a language by adding a column to each
 * entry — no code change. New keys are type-checked against this object, so a
 * typo in `t(locale, '...')` fails to compile.
 */
export const CATALOG = {
  // ---- info ----
  infoHeader: {
    en: 'easyworker {os}/{arch} (shell {shell})',
    zh: 'easyworker {os}/{arch}（shell {shell}）',
  },
  infoWorkspace: {
    en: 'workspace: {path}',
    zh: '工作区：{path}',
  },
  infoService: {
    en: 'service: {url}',
    zh: '服务：{url}',
  },
  infoBoot: {
    en: 'boot_id: {id}',
    zh: 'boot_id：{id}',
  },

  // ---- exec / jobs ----
  execStillRunning: {
    en: 'Job {jobId} is still running after {timeout}s.',
    zh: '任务 {jobId} 在 {timeout} 秒后仍在运行。',
  },
  execUseJobOutput: {
    en: 'Use job-output (job-id: {jobId}) to see more output.',
    zh: '使用 job-output（job-id：{jobId}）查看更多输出。',
  },
  commandFinished: {
    en: 'Command finished (job {jobId}, {state}, exit {code}).',
    zh: '命令已结束（任务 {jobId}，{state}，退出码 {code}）。',
  },
  startedJob: {
    en: 'Started job {jobId}.',
    zh: '已启动任务 {jobId}。',
  },
  jobStillRunning: {
    en: 'Job {jobId} is still running after {timeout}s.',
    zh: '任务 {jobId} 在 {timeout} 秒后仍在运行。',
  },
  jobFinished: {
    en: 'Job {jobId} {state} (exit {code}).',
    zh: '任务 {jobId} {state}（退出码 {code}）。',
  },
  killedJob: {
    en: 'Killed job {jobId}.',
    zh: '已终止任务 {jobId}。',
  },
  wroteStdin: {
    en: 'Wrote {n} chars to job {jobId} stdin.',
    zh: '已向任务 {jobId} 的 stdin 写入 {n} 个字符。',
  },
  wroteStdinClosed: {
    en: 'Wrote {n} chars to job {jobId} stdin and closed it.',
    zh: '已向任务 {jobId} 的 stdin 写入 {n} 个字符并关闭。',
  },
  noJobs: {
    en: 'No jobs.',
    zh: '没有任务。',
  },

  // ---- files ----
  notTextFile: {
    en: "'{path}' is not a text file (binary content); read supports text files only",
    zh: "'{path}' 不是文本文件（二进制内容）；read 只支持文本文件。",
  },
  wroteFile: {
    en: "Wrote {bytes} bytes to '{path}' ({lines} lines).",
    zh: "已向 '{path}' 写入 {bytes} 字节（{lines} 行）。",
  },
  writeTooLarge: {
    en: "'{path}' is {bytes} bytes; write is limited to {limit} (build larger files in the workspace instead).",
    zh: "'{path}' 为 {bytes} 字节；write 上限为 {limit}（更大的文件请在 workspace 内生成）。",
  },
  writeFailed: {
    en: "failed to write '{path}'.",
    zh: "写入 '{path}' 失败。",
  },
  editSummary: {
    en: "Edited '{path}': +{added} -{removed} (now {lines} lines).",
    zh: "已编辑 '{path}'：+{added} -{removed}（现为 {lines} 行）。",
  },
  editNoChanges: {
    en: "No changes to '{path}'.",
    zh: "'{path}' 没有变化。",
  },
  emptyRoot: {
    en: '(workspace root is empty)',
    zh: '（工作区根目录为空）',
  },
  emptyDir: {
    en: '(empty: {path})',
    zh: '（空：{path}）',
  },
  downloaded: {
    en: "Downloaded file:{code} ({mime}, {bytes} bytes) to '{path}'.",
    zh: "已下载 file:{code}（{mime}，{bytes} 字节）到 '{path}'。",
  },
  uploaded: {
    en: "Uploaded '{path}' as file:{code} ({mime}, {bytes} bytes).",
    zh: "已上传 '{path}' 为 file:{code}（{mime}，{bytes} 字节）。",
  },

  // ---- truncation / paging notes ----
  truncatedAfter: {
    en: '... truncated after {shown} of {total} lines ({why}); narrow the range (offset/limit) to see more.',
    zh: '... 已在 {total} 行中截断至 {shown} 行（{why}）；用 offset/limit 缩小范围以查看更多。',
  },
  whyBytes: {
    en: 'result exceeds {size}',
    zh: '结果超过 {size}',
  },
  whyLines: {
    en: 'result exceeds {lines} lines',
    zh: '结果超过 {lines} 行',
  },
  showingLines: {
    en: '... showing lines {start}-{end} of {total}',
    zh: '... 正在显示第 {start}-{end} 行，共 {total} 行',
  },
  moreLinesAvailable: {
    en: ' (more lines available; use offset/limit)',
    zh: '（还有更多行；请使用 offset/limit）',
  },
  omittedEntries: {
    en: '... {path}: {count} entries omitted (limit {limit})',
    zh: '... {path}：省略 {count} 个条目（上限 {limit}）',
  },

  // ---- sandbox lifecycle (workspace gateway) ----
  sandboxCreated: {
    en: "Created sandbox '{name}' ({image}) at {url}.",
    zh: "已创建沙箱 '{name}'（{image}），地址 {url}。",
  },
  sandboxCreateTimeout: {
    en: "sandbox '{name}' did not become healthy within 60s ({err}); it may still be starting — check sandbox-status, or sandbox-delete it.",
    zh: "沙箱 '{name}' 在 60 秒内未就绪（{err}）；它可能仍在启动——用 sandbox-status 查看，或用 sandbox-delete 删除。",
  },
  sandboxNone: {
    en: 'No sandboxes.',
    zh: '没有沙箱。',
  },
  serviceDeployed: {
    en: "Deployed service '{name}' ({image}) at {url}.",
    zh: "已部署服务 '{name}'（{image}），地址 {url}。",
  },
  serviceDeployFailed: {
    en: 'service-deploy failed: {err}',
    zh: 'service-deploy 失败：{err}',
  },
  serviceNone: {
    en: 'No services.',
    zh: '没有服务。',
  },
  serviceListHeader: {
    en: 'Services ({count}):',
    zh: '服务（{count} 个）：',
  },
  serviceDeleted: {
    en: "Deleted service '{name}'.",
    zh: "已删除服务 '{name}'。",
  },
  serviceNotFound: {
    en: "service '{name}' not found.",
    zh: "未找到服务 '{name}'。",
  },
  ociImageNone: {
    en: 'No OCI images found.',
    zh: '未找到 OCI 镜像。',
  },
  ociImageHeader: {
    en: 'OCI images ({count}):',
    zh: 'OCI 镜像（{count} 个）：',
  },
  imageBuilt: {
    en: "Built and pushed image '{image}'.",
    zh: "已构建并推送镜像 '{image}'。",
  },
  imageBuildFailed: {
    en: "Failed to build image '{image}': {err}",
    zh: "构建镜像 '{image}' 失败：{err}",
  },
  sandboxStatus: {
    en: "sandbox '{name}': {phase}{ready} (image {image}, url {url})",
    zh: "沙箱 '{name}'：{phase}{ready}（镜像 {image}，地址 {url}）",
  },
  sandboxNotFound: {
    en: "sandbox '{name}' not found ({err}).",
    zh: "未找到沙箱 '{name}'（{err}）。",
  },
  sandboxDeleted: {
    en: "Deleted sandbox '{name}'.",
    zh: "已删除沙箱 '{name}'。",
  },
  workerNameRequired: {
    en: "worker-name is required (call sandbox-create or sandbox-list first)",
    zh: '缺少 worker-name（请先调用 sandbox-create 或 sandbox-list）。',
  },

  // ---- errors (config / args) ----
  notConfigured: {
    en: "{name} is not configured; set it in the extension's tool settings",
    zh: '未配置 {name}；请在扩展的工具设置中填写。',
  },
  workerNotConfigured: {
    en: "worker {name} is not configured; set it in the extension's tool settings",
    zh: '未配置 worker {name}；请在扩展的工具设置中填写。',
  },
  fileToolsRequireBus: {
    en: 'file tools require an agent bus (download/upload)',
    zh: '文件工具需要 agent bus（download/upload）。',
  },
  argRequired: {
    en: '{key} is required',
    zh: '缺少 {key}。',
  },
  startLineMin: {
    en: 'start-line must be >= 1',
    zh: 'start-line 必须 >= 1。',
  },
  mailBranchMissing: {
    en: "branch '{branch}' does not exist in the repository (branch <-> session is 1:1)",
    zh: "仓库中不存在分支 '{branch}'（分支与会话一一对应）。",
  },
  importRepoExists: {
    en: "repository '{full}' already exists; import refuses to overwrite",
    zh: "仓库 '{full}' 已存在；导入不会覆盖。",
  },
  importRefMissing: {
    en: "ref '{ref}' not found in the imported repository",
    zh: "导入的仓库中不存在 ref '{ref}'。",
  },
  repoImported: {
    en: "imported {full} (default branch: {branch})",
    zh: "已导入 {full}（默认分支：{branch}）。",
  },
  mailDelivered: {
    en: "message delivered to branch session '{session}'",
    zh: "消息已投递到分支会话 '{session}'。",
  },
  invalidName: {
    en: "'{value}' is not a valid {key} (allowed: letters, digits, . _ / -; no ':', '..', '//', or trailing '.'/'.lock')",
    zh: "'{value}' 不是合法的 {key}（允许：字母、数字、. _ / -；不得含 ':'、'..'、'//' 或以 '.'/'.lock' 结尾）。",
  },
  editNeedsRead: {
    en: "'{path}' has not been read in this session; call read first (read the lines you intend to edit).",
    zh: "本会话尚未读取 '{path}'；请先调用 read 工具（读取你要编辑的行）。",
  },
  editStaleRead: {
    en: "'{path}' changed since it was last read; call read again before editing (line numbers may have shifted).",
    zh: "'{path}' 自上次读取后已变化；请重新调用 read 工具后再编辑（行号可能已改变）。",
  },
  editRangeNotRead: {
    en: "lines {start}-{end} of '{path}' were not read; call read for that range first (seen: {seen}).",
    zh: "尚未读取 '{path}' 的第 {start}-{end} 行；请先调用 read 工具读取该范围（已读：{seen}）。",
  },
  tenantRequired: {
    en: '{op}: tenant required',
    zh: '{op}：缺少 tenant。',
  },
  fileNotFound: {
    en: 'file not found: {code}',
    zh: '未找到文件：{code}。',
  },
  interrupted: {
    en: 'interrupted',
    zh: '已中断。',
  },

  // ---- forgejo REST errors ----
  forgejoUnauthorized: {
    en: 'Forgejo denied the request ({status}): {msg}',
    zh: 'Forgejo 拒绝了请求（{status}）：{msg}',
  },
  forgejoNotFound: {
    en: 'Forgejo: not found ({msg})',
    zh: 'Forgejo：未找到（{msg}）',
  },
  forgejoConflict: {
    en: 'Forgejo: conflict ({msg}); the file changed since it was read — re-read and retry',
    zh: 'Forgejo：冲突（{msg}）；文件自读取后已变化——请重新读取后重试',
  },
  forgejoInvalid: {
    en: 'Forgejo rejected the request: {msg}',
    zh: 'Forgejo 拒绝了请求：{msg}',
  },
  forgejoHttp: {
    en: 'Forgejo HTTP {status}: {msg}',
    zh: 'Forgejo HTTP {status}：{msg}',
  },

  // ---- repo tools ----
  repoRef: {
    en: 'repository {org}/{repo}@{ref}',
    zh: '仓库 {org}/{repo}@{ref}',
  },
  repoWrote: {
    en: "Wrote '{path}' in {org}/{repo}@{ref} (commit {sha}).",
    zh: "已写入 {org}/{repo}@{ref} 中的 '{path}'（提交 {sha}）。",
  },
  repoDeleted: {
    en: "Deleted '{path}' in {org}/{repo}@{ref} (commit {sha}).",
    zh: "已删除 {org}/{repo}@{ref} 中的 '{path}'（提交 {sha}）。",
  },
  repoCommitted: {
    en: 'Committed {count} file(s) to {org}/{repo}@{ref} (commit {sha}).',
    zh: '已向 {org}/{repo}@{ref} 提交 {count} 个文件（提交 {sha}）。',
  },
  repoNoChanges: {
    en: "No changes to '{path}' in {org}/{repo}@{ref}.",
    zh: "{org}/{repo}@{ref} 中的 '{path}' 没有变化。",
  },
  repoEditSummary: {
    en: "Edited '{path}' in {org}/{repo}@{ref}: +{added} -{removed} (commit {sha}).",
    zh: "已编辑 {org}/{repo}@{ref} 中的 '{path}'：+{added} -{removed}（提交 {sha}）。",
  },
  repoTreeHeader: {
    en: '{org}/{repo}@{ref} ({count} entries):',
    zh: '{org}/{repo}@{ref}（{count} 个条目）：',
  },
  repoNoEntries: {
    en: '{org}/{repo}@{ref}: no entries.',
    zh: '{org}/{repo}@{ref}：无条目。',
  },
  repoLogHeader: {
    en: 'Commits in {org}/{repo}@{ref} ({count}):',
    zh: '{org}/{repo}@{ref} 的提交（{count}）：',
  },
  repoNoCommits: {
    en: '{org}/{repo}@{ref}: no commits.',
    zh: '{org}/{repo}@{ref}：无提交。',
  },
  repoBranchesHeader: {
    en: 'Branches of {org}/{repo} ({count}):',
    zh: '{org}/{repo} 的分支（{count}）：',
  },
  repoTagsHeader: {
    en: 'Tags of {org}/{repo} ({count}):',
    zh: '{org}/{repo} 的标签（{count}）：',
  },
  repoBranchCreated: {
    en: "Created branch '{name}' in {org}/{repo} from {from}.",
    zh: "已从 {from} 在 {org}/{repo} 创建分支 '{name}'。",
  },
  repoTagCreated: {
    en: "Created tag '{name}' in {org}/{repo} at {target}.",
    zh: "已在 {org}/{repo} 的 {target} 创建标签 '{name}'。",
  },
  repoNoDiff: {
    en: 'No differences between {base} and {head} in {org}/{repo}.',
    zh: '{org}/{repo} 中 {base} 与 {head} 之间没有差异。',
  },
  repoDiffHeader: {
    en: 'Diff {base}...{head} in {org}/{repo} ({count} file(s)):',
    zh: '{org}/{repo} 中 {base}...{head} 的差异（{count} 个文件）：',
  },
  repoMrCreated: {
    en: 'Opened pull request #{index} in {org}/{repo} ({url}).',
    zh: '已在 {org}/{repo} 打开合并请求 #{index}（{url}）。',
  },
  repoMrListHeader: {
    en: 'Pull requests in {org}/{repo} ({count}):',
    zh: '{org}/{repo} 的合并请求（{count}）：',
  },
  repoMrCommented: {
    en: 'Commented on pull request #{index} in {org}/{repo}.',
    zh: '已评论 {org}/{repo} 的合并请求 #{index}。',
  },
  repoMrMerged: {
    en: 'Merged pull request #{index} in {org}/{repo}.',
    zh: '已合并 {org}/{repo} 的合并请求 #{index}。',
  },
  syncClean: {
    en: 'Synced {org}/{repo}:{branch} with main (no conflicts). New commit {commit}.',
    zh: '已将 main 同步到 {org}/{repo}:{branch}（无冲突）。新提交 {commit}。',
  },
  syncConflicts: {
    en: 'Synced {org}/{repo}:{branch} with main; {count} file(s) have CONFLICTS and now contain ABCP-CONFLICT marker blocks: {paths}. Resolve each block (keep the correct content, remove all marker lines), then commit. repo-mr-create/repo-mr-merge will refuse the branch until every marker is gone.',
    zh: '已将 main 同步到 {org}/{repo}:{branch}；{count} 个文件存在冲突，现已写入 ABCP-CONFLICT 标记块：{paths}。请逐块解决（保留正确内容并删除所有标记行）后提交。在标记全部清除前，repo-mr-create/repo-mr-merge 会拒绝该分支。',
  },
  syncNeedsBranch: {
    en: 'No branch given and the session is not bound to org:repo:branch; pass org/repo/branch explicitly.',
    zh: '未提供分支且会话未绑定到 org:repo:branch；请显式传入 org/repo/branch。',
  },
  syncMainRefused: {
    en: 'Refusing to sync the default branch (main).',
    zh: '拒绝同步默认分支（main）。',
  },
  restored: {
    en: 'Restored {path} in {org}/{repo} to {from} (target {ref}, commit {sha}{binary}).',
    zh: '已将 {org}/{repo} 的 {path} 恢复为 {from}（目标 {ref}，提交 {sha}{binary}）。',
  },
  repoExploreHeader: {
    en: '{count} organization(s):',
    zh: '{count} 个组织：',
  },
  repoExploreEmpty: {
    en: 'No organizations or repositories found.',
    zh: '未找到组织或仓库。',
  },
  repoOrgCreated: {
    en: "Created organization '{org}'.",
    zh: "已创建组织 '{org}'。",
  },
  repoRepoCreated: {
    en: "Created repository '{full}' (default branch {branch}).",
    zh: "已创建仓库 '{full}'（默认分支 {branch}）。",
  },

  // ---- checkout / port ----
  checkoutDone: {
    en: 'Checked out {org}/{repo}@{ref} into the sandbox ({files} files).',
    zh: '已将 {org}/{repo}@{ref} 检出到沙箱（{files} 个文件）。',
  },
  portDone: {
    en: 'Ported {count} file(s) from the sandbox to {org}/{repo}@{ref} (commit {sha}).',
    zh: '已将 {count} 个文件从沙箱移植到 {org}/{repo}@{ref}（提交 {sha}）。',
  },
  portRefusedExists: {
    en: 'refusing to port: {count} path(s) already exist in {org}/{repo}@{ref} (directory port never overwrites): {paths}',
    zh: '拒绝移植：{count} 个路径已存在于 {org}/{repo}@{ref}（目录移植绝不覆盖）：{paths}',
  },
  portNoFiles: {
    en: 'no files to port from {path}',
    zh: '{path} 中没有可移植的文件',
  },
} satisfies Catalog<string>

export type MessageKey = keyof typeof CATALOG

const { t } = defineI18n(CATALOG)

/** Translate a workspace message into `locale`. */
export function tr(
  locale: string,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  return t(locale, key, params)
}

/** Read the session's effective locale (agent-projected), '' when unknown. */
export async function localeOf(
  deps: WorkspaceDeps | undefined,
  tenant: string,
  session: string,
): Promise<string> {
  if (deps === undefined || session === '') return BASE_LOCALE
  const v = await deps
    .getSessionVariable(tenant, 'agent', session, 'locale')
    .catch(() => '')
  return v === '' ? BASE_LOCALE : v
}

export { translate }
