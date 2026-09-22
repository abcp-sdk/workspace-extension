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
    data: { org: r.org, repo: r.repo, default_branch: 'main', private: true },
  }
}

/**
 * `repo-import`: import an EXTERNAL git repository into `org` (admin only).
 *
 * The WORKSPACE GATEWAY owns the import: it creates an empty repo, clones the
 * source's HEAD BRANCHES with go-git (never Forgejo's mirror-migrate, which
 * would drag in every `refs/pull/*`), pushes them, sets the default branch and
 * ensures the branch session. This tool only validates the arguments and
 * forwards. When `ref` is given ONLY that branch is imported and becomes the
 * default; otherwise every head branch is imported.
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
    private: args['private'] !== false,
    mirror: false,
    description: strArg(args, 'description'),
  })
  const branch = res.repo?.defaultBranch || 'main'
  return {
    content: tr(ctx.locale, 'repoImported', { full: `${org}/${repo}`, branch }),
    data: { org, repo, default_branch: branch, url },
  }
}

/** Derive `repo` from a git URL's last path segment (strips `.git`). */
function deriveRepoName(url: string): string {
  const clean = url.replace(/\/+$/, '').replace(/\.git$/i, '')
  const seg = clean.split(/[/:]/).filter(Boolean).pop() ?? ''
  return seg
}
