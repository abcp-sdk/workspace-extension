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
  const visibility = strArg(args, 'visibility')
  const res = await ctx.forgejo.createOrg({
    org,
    ...(strArg(args, 'full-name') !== '' ? { fullName: strArg(args, 'full-name') } : {}),
    ...(strArg(args, 'description') !== '' ? { description: strArg(args, 'description') } : {}),
    ...(visibility === 'public' || visibility === 'limited' || visibility === 'private'
      ? { visibility }
      : {}),
    ...(strArg(args, 'email') !== '' ? { email: strArg(args, 'email') } : {}),
    ...(strArg(args, 'location') !== '' ? { location: strArg(args, 'location') } : {}),
    ...(strArg(args, 'website') !== '' ? { website: strArg(args, 'website') } : {}),
    locale: ctx.locale,
  })
  return {
    content: tr(ctx.locale, 'repoOrgCreated', { org: res.name }),
    data: { org: res.name },
  }
}

/**
 * `repo-create-repo`: create a repository under `org` (an organization or a
 * user; the client falls back to the authenticated user when `org` is not an
 * organization). Optionally auto-initialized with a default branch.
 */
export async function repoCreateRepo(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const autoInit = args['auto-init'] === true
  const priv = args['private'] === true
  const res = await ctx.forgejo.createRepo(r.org, {
    repo: r.repo,
    private: priv,
    autoInit,
    ...(strArg(args, 'default-branch') !== '' ? { defaultBranch: strArg(args, 'default-branch') } : {}),
    ...(strArg(args, 'description') !== '' ? { description: strArg(args, 'description') } : {}),
    ...(strArg(args, 'readme') !== '' ? { readme: strArg(args, 'readme') } : {}),
    ...(strArg(args, 'gitignores') !== '' ? { gitignores: strArg(args, 'gitignores') } : {}),
    ...(strArg(args, 'license') !== '' ? { license: strArg(args, 'license') } : {}),
    locale: ctx.locale,
  })
  // Auto-create the repo's `main` branch session (repo:branch <-> session, 1:1).
  // Best-effort: a repo is still usable if this fails.
  try {
    await ctx.gateway.ensureBranchSession({ org: r.org, repo: r.repo, branch: res.defaultBranch || 'main' })
  } catch {
    /* best effort */
  }
  return {
    content: tr(ctx.locale, 'repoRepoCreated', {
      full: res.fullName !== '' ? res.fullName : `${r.org}/${r.repo}`,
      branch: res.defaultBranch,
    }),
    data: { org: res.owner, repo: res.name, default_branch: res.defaultBranch, private: res.private },
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
