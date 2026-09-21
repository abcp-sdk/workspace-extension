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
 * `repo-import`: migrate an EXTERNAL git repository into `org` (admin only).
 *
 * Forgejo's migrate clones the FULL repository (every branch + history): it has
 * no "single ref" option. When `ref` is given the tool makes that ref the
 * default branch and DELETES the other branches, so the imported repo ends up
 * with exactly that one branch. Omitted `ref` keeps the source's default branch
 * and all of its branches.
 *
 * The imported repo becomes owned by the caller's tenant and its branch session
 * is ensured (repo:branch <-> session, 1:1).
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

  // Refuse to overwrite an existing repo.
  const exists = await repoExists(ctx, org, repo)
  if (exists) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'importRepoExists', { full: `${org}/${repo}` }))
  }

  const authToken = strArg(args, 'auth-token')
  const authUser = strArg(args, 'auth-user')
  const privateRepo = args['private'] !== false
  const mirror = args['mirror'] === true
  const description = strArg(args, 'description')

  await ctx.forgejo.createOrg({ org, locale: ctx.locale }).catch(() => {
    /* the org may already exist; migrate below is the real check */
  })
  const res = await ctx.forgejo.migrateRepo(org, {
    repo,
    cloneAddr: url,
    private: privateRepo,
    mirror,
    ...(description !== '' ? { description } : {}),
    ...(authToken !== '' ? { authToken } : {}),
    ...(authUser !== '' ? { authUser } : {}),
    locale: ctx.locale,
  })

  let branch = res.defaultBranch || 'main'
  if (ref !== '') {
    // Trim to a single branch: make `ref` the default, delete the rest.
    const branches = await ctx.forgejo.listBranches(org, repo, ctx.locale)
    if (!branches.some(b => b.name === ref)) {
      throw new TypedToolError('not_found', tr(ctx.locale, 'importRefMissing', { ref }))
    }
    await ctx.forgejo.setDefaultBranch(org, repo, ref, ctx.locale)
    for (const b of branches) {
      if (b.name !== ref) await ctx.forgejo.deleteBranch(org, repo, b.name, ctx.locale)
    }
    branch = ref
  }

  // Ensure the branch session for the imported repo's default branch.
  try {
    await ctx.gateway.ensureBranchSession({ org, repo, branch })
  } catch {
    /* best effort */
  }
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

/** Whether `org/repo` already exists (a not_found means the name is free). */
async function repoExists(ctx: RepoCtx, org: string, repo: string): Promise<boolean> {
  try {
    await ctx.forgejo.getRepo(org, repo, ctx.locale)
    return true
  } catch (e) {
    if (e instanceof TypedToolError && e.code === 'not_found') return false
    throw e
  }
}
