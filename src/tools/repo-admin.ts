import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import { tr } from '../i18n.js'
import { strArg } from './shared.js'
import { repoRef, validComponent, type RepoCtx } from './repo-content.js'
/**
 * `repo-create-org`: create a Forgejo organization. The `org` argument is the
 * organization's slug (required).
 */
export async function repoCreateOrg(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = strArg(args, 'org')
  if (org === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'org' }))
  }
  if (!validComponent(org)) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key: 'org', value: org }))
  }
  const res = await ctx.forgejo.createOrg({ org, locale: ctx.locale })
  return {
    content: tr(ctx.locale, 'repoOrgCreated', { org: res.name }),
    data: { org: res.name },
  }
}

/**
 * `repo-create-repo`: create a repository under `org` (the gateway ensures the
 * org + repo + protected `main` branch and records ownership). The default
 * branch is always `main`; extra init options are not supported by the gateway.
 */
export async function repoCreateRepo(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  await ctx.gateway.ensureRepo({ org: r.org, repo: r.repo })
  // Auto-create the repo's `main` branch session (repo:branch <-> session, 1:1).
  // Best-effort: a repo is still usable if this fails.
  try {
    await ctx.gateway.ensureBranchSession({ org: r.org, repo: r.repo, branch: 'main' })
  } catch {
    /* best effort */
  }
  return {
    content: tr(ctx.locale, 'repoRepoCreated', { full: `${r.org}/${r.repo}`, branch: 'main' }),
    data: { org: r.org, repo: r.repo, default_branch: 'main', private: false },
  }
}

/**
 * `repo-import`: import an EXTERNAL git repository into `org` as a PUBLIC repo
 * (admin only).
 *
 * The WORKSPACE GATEWAY owns the import: it creates an empty PUBLIC repo,
 * clones the source with go-git (never Forgejo's mirror-migrate, which would
 * drag in every `refs/pull/*`), and pushes the selected source ref as `main`.
 * `ref` may be a branch, a tag, or any revision; empty means the source's HEAD
 * branch. Only `main` is created. This tool only validates and forwards.
 *
 * The imported repo becomes owned by the caller's tenant.
 */
export async function repoImport(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = strArg(args, 'org')
  const url = strArg(args, 'url')
  const ref = strArg(args, 'ref')
  if (org === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'org' }))
  if (url === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'url' }))
  if (!validComponent(org)) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key: 'org', value: org }))
  }
  // Repository name: explicit `repo`, else derived from the URL's last segment.
  const repo = strArg(args, 'repo') || deriveRepoName(url)
  if (repo === '' || !validComponent(repo)) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key: 'repo', value: repo }))
  }
  if (ref !== '' && !validComponent(ref)) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key: 'ref', value: ref }))
  }

  const res = await ctx.gateway.importRepo({
    org,
    url,
    repo,
    ref,
    authUser: strArg(args, 'auth-user'),
    authToken: strArg(args, 'auth-token'),
    private: false,
    mirror: false,
    description: strArg(args, 'description'),
  })
  const branch = res.repo?.defaultBranch || 'main'
  return {
    content: tr(ctx.locale, 'repoImported', { full: `${org}/${repo}`, branch }),
    data: { org, repo, default_branch: branch, url },
  }
}

/**
 * `repo-set-push-mirror`: register a push mirror on a repo (admin only). The
 * repo's commits are continuously pushed to `remote-url` (HTTPS). A repo may
 * have MULTIPLE mirrors; the returned `remote-name` is what `repo-delete-push-mirror`
 * needs. The gateway owns the Forgejo call (tenant-scoped).
 */
export async function repoSetPushMirror(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const remoteUrl = strArg(args, 'remote-url')
  if (remoteUrl === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'remote-url' }))
  }
  const res = await ctx.gateway.setPushMirror({
    org: r.org,
    repo: r.repo,
    remoteAddress: remoteUrl,
    remoteUsername: strArg(args, 'auth-user'),
    remotePassword: strArg(args, 'auth-token'),
    syncOnCommit: args['sync-on-commit'] === true,
    interval: strArg(args, 'interval'),
    branchFilter: strArg(args, 'branch-filter'),
  })
  const m = res.mirror
  return {
    content: tr(ctx.locale, 'pushMirrorSet', {
      full: `${r.org}/${r.repo}`,
      name: m?.remoteName ?? '',
      url: m?.remoteAddress ?? remoteUrl,
    }),
    data: {
      org: r.org,
      repo: r.repo,
      remote_name: m?.remoteName ?? '',
      remote_address: m?.remoteAddress ?? remoteUrl,
      interval: m?.interval ?? '',
      sync_on_commit: m?.syncOnCommit ?? false,
      branch_filter: m?.branchFilter ?? '',
    },
  }
}

/** `repo-list-push-mirrors`: list a repo's push mirrors (admin only). */
export async function repoListPushMirrors(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const res = await ctx.gateway.listPushMirrors({ org: r.org, repo: r.repo })
  const mirrors = (res.mirrors ?? []).map(m => ({
    remote_name: m.remoteName,
    remote_address: m.remoteAddress,
    interval: m.interval,
    sync_on_commit: m.syncOnCommit,
    branch_filter: m.branchFilter,
    last_error: m.lastError,
    last_update: m.lastUpdate,
  }))
  const lines = mirrors.length
    ? mirrors
        .map(m => `- ${m.remote_name} → ${m.remote_address}${m.branch_filter ? ` [${m.branch_filter}]` : ''}${m.sync_on_commit ? ' (on commit)' : ''}${m.interval ? ` every ${m.interval}` : ''}${m.last_error ? ` ⚠ ${m.last_error}` : ''}`)
        .join('\n')
    : tr(ctx.locale, 'pushMirrorNone')
  return {
    content: tr(ctx.locale, 'pushMirrorList', { full: `${r.org}/${r.repo}`, count: mirrors.length }) + '\n' + lines,
    data: { org: r.org, repo: r.repo, mirrors },
  }
}

/** `repo-delete-push-mirror`: remove a push mirror by `remote-name` (admin only). */
export async function repoDeletePushMirror(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const remoteName = strArg(args, 'remote-name')
  if (remoteName === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'remote-name' }))
  }
  await ctx.gateway.deletePushMirror({ org: r.org, repo: r.repo, remoteName })
  return {
    content: tr(ctx.locale, 'pushMirrorDeleted', { full: `${r.org}/${r.repo}`, name: remoteName }),
    data: { org: r.org, repo: r.repo, remote_name: remoteName },
  }
}

/**
 * `repo-remove`: delete a repository you own (admin) — its git repo, every
 * branch session (each cascading to its sandboxes) and the ownership row. The
 * org is left in place. Destructive and irreversible.
 */
export async function repoRemove(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  await ctx.gateway.deleteRepo({ org: r.org, repo: r.repo })
  return {
    content: tr(ctx.locale, 'repoRemoved', { full: `${r.org}/${r.repo}` }),
    data: { org: r.org, repo: r.repo, removed: true },
  }
}

/** Derive `repo` from a git URL's last path segment (strips `.git`). */
function deriveRepoName(url: string): string {
  const clean = url.replace(/\/+$/, '').replace(/\.git$/i, '')
  const seg = clean.split(/[/:]/).filter(Boolean).pop() ?? ''
  return seg
}
