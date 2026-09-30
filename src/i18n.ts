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
  infoHome: {
    en: 'home (~): {path}',
    zh: '主目录（~）：{path}',
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
  deletedPath: {
    en: "Deleted '{path}'.",
    zh: "已删除 '{path}'。",
  },
  deleteFailed: {
    en: "Failed to delete '{path}'.",
    zh: "删除 '{path}' 失败。",
  },

  // ---- sandbox lifecycle (workspace gateway) ----
  sandboxCreated: {
    en: "Created sandbox '{name}' ({image}) at {url}.",
    zh: "已创建沙箱 '{name}'（{image}），地址 {url}。",
  },
  sandboxExists: {
    en: "sandbox '{name}' already exists; delete it before reusing the name (sandbox-delete).",
    zh: "沙箱 '{name}' 已存在；重用该名字前请先用 sandbox-delete 删除它。",
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
  servicePublicUrl: {
    en: "Public URL (anonymous): {url}",
    zh: "公开地址（匿名可访问）：{url}",
  },
  serviceSlotLine: {
    en: "Slot {slot}: {url}{active}",
    zh: "槽位 {slot}：{url}{active}",
  },
  serviceSlotInvalid: {
    en: "slot must be 'blue' or 'green'",
    zh: "slot 必须为 'blue' 或 'green'。",
  },
  servicePromoted: {
    en: "Promoted '{name}': the primary URL now targets the {slot} slot.",
    zh: "已提升 '{name}'：主地址现指向 {slot} 槽位。",
  },
  servicePromoteFailed: {
    en: "service-promote '{name}' failed: {err}",
    zh: "service-promote '{name}' 失败：{err}",
  },
  serviceRolledBack: {
    en: "Rolled back '{name}': the primary URL now targets the {slot} slot.",
    zh: "已回滚 '{name}'：主地址现指向 {slot} 槽位。",
  },
  serviceRollbackFailed: {
    en: "service-rollback '{name}' failed: {err}",
    zh: "service-rollback '{name}' 失败：{err}",
  },
  serviceDeployFailed: {
    en: 'service-deploy failed: {err}',
    zh: 'service-deploy 失败：{err}',
  },
  helmRendered: {
    en: "Rendered release '{release}' ({count} objects):",
    zh: "已渲染 release '{release}'（{count} 个对象）：",
  },
  helmDeployed: {
    en: "Helm release '{release}' deployed (revision {revision}).",
    zh: "Helm release '{release}' 已部署（revision {revision}）。",
  },
  helmFailed: {
    en: '{op} failed: {err}',
    zh: '{op} 失败：{err}',
  },
  helmNone: {
    en: '(no Helm releases)',
    zh: '（无 Helm release）',
  },
  helmListHeader: {
    en: 'Helm releases ({count}):',
    zh: 'Helm release（{count} 个）：',
  },
  helmHistoryHeader: {
    en: "History of '{release}' ({count} revisions):",
    zh: "'{release}' 的历史（{count} 个 revision）：",
  },
  helmRolledBack: {
    en: "Rolled back '{release}' (now revision {revision}).",
    zh: "已回滚 '{release}'（现为 revision {revision}）。",
  },
  helmUninstalled: {
    en: "Uninstalled Helm release '{release}'.",
    zh: "已卸载 Helm release '{release}'。",
  },
  helmNotFound: {
    en: "Helm release '{release}' not found.",
    zh: "未找到 Helm release '{release}'。",
  },
  helmSlotLine: {
    en: "Slot {slot}: {ready} ({count}){active}",
    zh: "槽位 {slot}：{ready}（{count}）{active}",
  },
  helmSlotInvalid: {
    en: "slot must be 'blue' or 'green'",
    zh: "slot 必须为 'blue' 或 'green'。",
  },
  helmPromoted: {
    en: "Promoted Helm release '{release}': the router now targets the {slot} slot.",
    zh: "已提升 Helm release '{release}'：路由器现指向 {slot} 槽位。",
  },
  helmRolledBackSlot: {
    en: "Rolled back Helm release '{release}': the router now targets the {slot} slot.",
    zh: "已回滚 Helm release '{release}'：路由器现指向 {slot} 槽位。",
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
  servicePreviewed: {
    en: "Preview service '{name}' ({image}) is up in-cluster at {url} (no public URL; reclaimed on session end / TTL).",
    zh: "预览服务 '{name}'（{image}）已在集群内就绪：{url}（无公开地址；会话结束 / TTL 后回收）。",
  },
  serviceLogsHeader: {
    en: "Logs for '{name}' (last {count} lines):",
    zh: "'{name}' 的日志（最后 {count} 行）：",
  },
  serviceLogsEmpty: {
    en: "No log output for '{name}'.",
    zh: "'{name}' 暂无日志输出。",
  },
  servicePodMessage: {
    en: 'reason: {message}',
    zh: '原因：{message}',
  },
  pvcCreated: {
    en: "Created PVC '{name}' ({size}, class {class}).",
    zh: "已创建 PVC '{name}'（{size}，存储类 {class}）。",
  },
  pvcCreateFailed: {
    en: "pvc-create failed for '{name}': {err}",
    zh: "pvc-create 失败（'{name}'）：{err}",
  },
  pvcNone: {
    en: 'No PVCs.',
    zh: '没有 PVC。',
  },
  pvcListHeader: {
    en: 'PVCs ({count}):',
    zh: 'PVC（{count} 个）：',
  },
  pvcListFailed: {
    en: 'pvc-list failed: {err}',
    zh: 'pvc-list 失败：{err}',
  },
  pvcDeleted: {
    en: "Deleted PVC '{name}'.",
    zh: "已删除 PVC '{name}'。",
  },
  pvcDeleteFailed: {
    en: "pvc-delete failed for '{name}': {err}",
    zh: "pvc-delete 失败（'{name}'）：{err}",
  },
  serviceLogsFailed: {
    en: "service-logs failed for '{name}': {err}",
    zh: "读取 '{name}' 日志失败：{err}",
  },
  previewImageBuilt: {
    en: "Built and pushed PREVIEW image '{image}'.",
    zh: "已构建并推送预览镜像 '{image}'。",
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
  imageImported: {
    en: "Imported image '{source}' as '{image}'.",
    zh: "已将镜像 '{source}' 导入为 '{image}'。",
  },
  imageImportFailed: {
    en: "Failed to import image '{image}': {err}",
    zh: "导入镜像 '{image}' 失败：{err}",
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
  sandboxDiag: {
    en: 'sandbox exited/failed: restarts={restarts}, reason: {message}',
    zh: '沙箱已退出/失败：重启 {restarts} 次，原因：{message}',
  },
  sandboxLogsHeader: {
    en: "Logs for sandbox '{name}' (last {count} lines):",
    zh: "沙箱 '{name}' 的日志（最后 {count} 行）：",
  },
  sandboxLogsEmpty: {
    en: "No log output for sandbox '{name}'.",
    zh: "沙箱 '{name}' 暂无日志输出。",
  },
  sandboxLogsFailed: {
    en: "sandbox-logs failed for '{name}': {err}",
    zh: "读取沙箱 '{name}' 日志失败：{err}",
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
  editStartAnchorRange: {
    en: 'start-anchor-line {start} is out of range: it must be between 0 and the number of lines ({total}); use 0 to insert at the head.',
    zh: 'start-anchor-line {start} 越界：必须在 0 到总行数（{total}）之间；在文件头插入请用 0。',
  },
  editEndAnchorRange: {
    en: 'end-anchor-line {end} is out of range: it must be between 1 and the number of lines + 1 ({total} + 1); use total + 1 to append at the tail.',
    zh: 'end-anchor-line {end} 越界：必须在 1 到总行数 + 1（{total} + 1）之间；在文件尾追加请用总行数 + 1。',
  },
  editAnchorOrder: {
    en: 'end-anchor-line ({end}) must be greater than start-anchor-line ({start}); the two anchor the unchanged lines just outside the edit region.',
    zh: 'end-anchor-line（{end}）必须大于 start-anchor-line（{start}）；两者锚定编辑区两侧的不变行。',
  },
  editAnchorEmpty: {
    en: "the anchor line {kind} the edit region (line {line} of '{path}') is not blank, but '{kind}-anchor' was empty; pass that line's current text. That line is: {actual}",
    zh: "编辑区{kindSide}的锚行（'{path}' 第 {line} 行）不是空行，但 '{kind}-anchor' 传了空字符串；请传该行当前原文。该行内容：{actual}",
  },
  editAnchorMismatch: {
    en: "'{kind}-anchor' (line {line} of '{path}', the unchanged line {kindSide} the edit region) does not match: expected {expected}, found {actual}. The file or line numbers changed; call read again.",
    zh: "'{kind}-anchor'（'{path}' 第 {line} 行，即编辑区{kindSide}的不变行）不匹配：期望 {expected}，实际 {actual}。文件或行号已变化；请重新 read。",
  },
  editAnchorOutOfRange: {
    en: "'{kind}-anchor' was given for line {line}, which does not exist in '{path}' ({total} lines); pass an empty string instead.",
    zh: "'{path}'（{total} 行）中不存在第 {line} 行，'{kind}-anchor' 应传空字符串。",
  },
  editAnchorRequired: {
    en: "'{key}' is a required argument; pass the current text of the line it anchors, or an empty string when that line does not exist.",
    zh: "'{key}' 是必填参数；请传其锚定行的当前原文，该行不存在时传空字符串。",
  },
  mailBranchMissing: {
    en: "branch '{branch}' does not exist in the repository (branch <-> session is 1:1)",
    zh: "仓库中不存在分支 '{branch}'（分支与会话一一对应）。",
  },
  mailNeedsBranchSession: {
    en: 'repo-mail-send is only available to a repository branch session',
    zh: 'repo-mail-send 仅限仓库分支会话使用。',
  },
  mailMrBranchRefused: {
    en: "cannot message an `mr/...` branch ('{branch}'): MR head branches have no session",
    zh: "不能向 `mr/...` 分支（'{branch}'）发消息：MR 头分支没有对应会话。",
  },
  mailSelfDenied: {
    en: 'cannot send a message to your own session ({session})',
    zh: '不能向自己的会话（{session}）发送消息。',
  },
  ownRepoOnly: {
    en: 'this action is limited to your own repository ({org}/{repo})',
    zh: '该操作仅限你自己的仓库（{org}/{repo}）。',
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
  repoRemoved: {
    en: "removed {full} (repository + its branch sessions + sandboxes)",
    zh: "已删除 {full}（仓库及其分支会话与沙箱）。",
  },
  pushMirrorSet: {
    en: "push mirror set on {full}: {name} → {url}",
    zh: "已为 {full} 设置 push mirror：{name} → {url}。",
  },
  pushMirrorList: {
    en: "push mirrors on {full} ({count}):",
    zh: "{full} 上的 push mirror（{count} 个）：",
  },
  pushMirrorNone: {
    en: "(none)",
    zh: "（无）",
  },
  pushMirrorDeleted: {
    en: "push mirror '{name}' removed from {full}",
    zh: "已从 {full} 移除 push mirror '{name}'。",
  },
  mailDelivered: {
    en: "message delivered to branch session '{session}'",
    zh: "消息已投递到分支会话 '{session}'。",
  },
  invalidName: {
    en: "'{value}' is not a valid {key} (allowed: letters, digits, . _ / -; no ':', '..', '//', or trailing '.'/'.lock')",
    zh: "'{value}' 不是合法的 {key}（允许：字母、数字、. _ / -；不得含 ':'、'..'、'//' 或以 '.'/'.lock' 结尾）。",
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
  repoNoChanges: {
    en: "No changes to '{path}' in {org}/{repo}@{ref}.",
    zh: "{org}/{repo}@{ref} 中的 '{path}' 没有变化。",
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
  mrCreatedNotice: {
    en: 'A change request targeting your branch needs review: #{index} "{title}" ({head} → {base}) in {org}/{repo}.\n{url}\nReview it with repo-mr-list / repo-mr-comment and merge with repo-mr-merge (or close it with repo-mr-close) when ready.',
    zh: '有指向你分支的合并请求待审查：{org}/{repo} 的 #{index}「{title}」（{head} → {base}）。\n{url}\n用 repo-mr-list / repo-mr-comment 查看，就绪后用 repo-mr-merge 合并（或用 repo-mr-close 关闭）。',
  },
  mrCommentNotice: {
    en: 'A comment was added to change request #{index} ({head} → {base}) in {org}/{repo}:\n{body}\nReview it with repo-mr-list / repo-mr-comment; if changes are requested, checkout the branch into a sandbox and submit a new MR.',
    zh: '合并请求 #{index}（{head} → {base}，{org}/{repo}）有新评论：\n{body}\n用 repo-mr-list / repo-mr-comment 查看；若要求修改，请把分支检出到沙箱并重新提交 MR。',
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
  repoMrClosed: {
    en: 'Closed pull request #{index} in {org}/{repo}.',
    zh: '已关闭 {org}/{repo} 的合并请求 #{index}。',
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

  // ---- checkout / submit ----
  checkoutDone: {
    en: 'Checked out {org}/{repo}@{ref} into the sandbox directory `{dest}` ({files} files).',
    zh: '已将 {org}/{repo}@{ref} 检出到沙箱目录 `{dest}`（{files} 个文件）。',
  },
  submitDone: {
    en: 'Submitted {count} change(s) from the sandbox as change request #{index} into {base} of {org}/{repo} (head {head}).',
    zh: '已把沙箱中的 {count} 处改动作为合并请求 #{index} 提交到 {org}/{repo} 的 {base}（head {head}）。',
  },
  submitNoFiles: {
    en: 'no files found under sandbox path {path}; check out the repository there first (sandbox-checkout), then edit and submit.',
    zh: '沙箱路径 {path} 下没有文件；请先在该处检出仓库（sandbox-checkout），再编辑并提交。',
  },
  submitNoChanges: {
    en: 'the sandbox directory is identical to {base} in {org}/{repo}: nothing to submit.',
    zh: '沙箱目录与 {org}/{repo} 的 {base} 完全一致：没有可提交的改动。',
  },
  fanoutUpdated: {
    en: 'Synced the change into {count} sandbox(es) owned by this session.',
    zh: '已把该改动同步到本会话拥有的 {count} 个沙箱。',
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
