import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import { tr } from '../i18n.js'
import { capLines, truncationNote } from './output.js'
import { numArg, requireArg, strArg } from './shared.js'
import { repoRef, ownRepoRef, resolveRepoRef, validComponent, type RepoCtx } from './repo-content.js'

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha
}

/** Validate an optional naming argument, or throw invalid_argument. */
function requireName(value: string, key: string, locale: string): string {
  if (!validComponent(value)) {
    throw new TypedToolError('invalid_argument', tr(locale, 'invalidName', { key, value }))
  }
  return value
}

/** `repo-explore`: list orgs / repos / branches (private included). */
export async function repoExplore(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = strArg(args, 'org')
  const repo = strArg(args, 'repo')
  const keyword = strArg(args, 'keyword').toLowerCase()
  if (org !== '') requireName(org, 'org', ctx.locale)
  if (repo !== '') requireName(repo, 'repo', ctx.locale)

  if (org === '') {
    const orgs = await ctx.forgejo.listOrgs(ctx.locale)
    const filtered = keyword === '' ? orgs : orgs.filter(o => o.name.toLowerCase().includes(keyword))
    if (filtered.length === 0) return { content: tr(ctx.locale, 'repoExploreEmpty') }
    const lines = filtered.map(o => `${o.name}${o.description !== '' ? `  ${o.description}` : ''}`)
    return {
      content: tr(ctx.locale, 'repoExploreHeader', { count: filtered.length }) + '\n' + lines.join('\n'),
      data: { orgs: filtered.map(o => o.name) },
    }
  }

  const repos = await ctx.forgejo.listOrgRepos(org, ctx.locale)
  let filtered = repo === '' ? repos : repos.filter(r => r.name === repo)
  if (keyword !== '') filtered = filtered.filter(r => r.name.toLowerCase().includes(keyword))
  if (filtered.length === 0) return { content: tr(ctx.locale, 'repoExploreEmpty') }

  const lines: string[] = []
  const data: Array<{ repo: string; default_branch: string; branches: string[] }> = []
  for (const rp of filtered) {
    const branches = await ctx.forgejo.listBranches(org, rp.name, ctx.locale)
    lines.push(`${org}/${rp.name}  (default: ${rp.defaultBranch}, branches: ${branches.map(b => b.name).join(', ')})`)
    data.push({ repo: rp.name, default_branch: rp.defaultBranch, branches: branches.map(b => b.name) })
  }
  return {
    content: tr(ctx.locale, 'repoExploreHeader', { count: filtered.length }) + '\n' + lines.join('\n'),
    data: { org, repos: data },
  }
}

/** `repo-log`: commit history (optional path/ref filter). */
export async function repoLog(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const path = strArg(args, 'path')
  const limit = Math.min(Math.max(Math.floor(numArg(args, 'limit') ?? 50), 1), 200)
  const commits = await ctx.forgejo.listCommits(r.org, r.repo, {
    ref: r.ref,
    ...(path !== '' ? { path } : {}),
    limit,
    locale: ctx.locale,
  })
  if (commits.length === 0) {
    return { content: tr(ctx.locale, 'repoNoCommits', { org: r.org, repo: r.repo, ref: r.ref || 'HEAD' }) }
  }
  const lines = commits.map(c => `${short(c.sha)}  ${c.date}  ${c.author}  ${c.message.split('\n')[0]}`)
  return {
    content: tr(ctx.locale, 'repoLogHeader', { org: r.org, repo: r.repo, ref: r.ref || 'HEAD', count: commits.length }) + '\n' + lines.join('\n'),
    data: { org: r.org, repo: r.repo, ref: r.ref, ...(path !== '' ? { path } : {}), commits },
  }
}

/** `repo-show`: one commit's metadata + patch. */
export async function repoShow(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const sha = requireArg(args, 'sha', ctx.locale)
  const commit = await ctx.forgejo.getCommit(r.org, r.repo, sha, ctx.locale)
  const patch = await ctx.forgejo.commitDiff(r.org, r.repo, sha, ctx.locale)
  const header = `${short(commit.sha)}  ${commit.date}  ${commit.author}\n\n${commit.message}`
  const capped = capLines(patch.split('\n'))
  let body = capped.kept.join('\n')
  if (capped.truncated) body += truncationNote(capped, capped.kept.length, patch.split('\n').length, ctx.locale)
  // Structured payload so the client renders the patch as a proper DIFF (with
  // the commit message as a field) instead of a terminal transcript.
  return {
    content: `${header}\n\n${body}`,
    data: {
      org: r.org,
      repo: r.repo,
      ref: r.ref,
      sha: commit.sha,
      commit,
      message: commit.message,
      diff: capped.kept.join('\n'),
    },
  }
}

/** `repo-diff`: compare two refs. */
export async function repoDiff(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const base = requireArg(args, 'base', ctx.locale)
  const head = requireArg(args, 'head', ctx.locale)
  const cmp = await ctx.forgejo.compare(r.org, r.repo, base, head, ctx.locale)
  if (cmp.files.length === 0) {
    return { content: tr(ctx.locale, 'repoNoDiff', { org: r.org, repo: r.repo, base, head }) }
  }
  const lines: string[] = []
  for (const f of cmp.files) {
    lines.push(`${f.status} ${f.path} (+${f.additions} -${f.deletions})`)
    if (f.patch !== '') lines.push(f.patch)
  }
  const capped = capLines(lines)
  let body = capped.kept.join('\n')
  if (capped.truncated) body += truncationNote(capped, capped.kept.length, lines.length, ctx.locale)
  return {
    content: tr(ctx.locale, 'repoDiffHeader', { org: r.org, repo: r.repo, base, head, count: cmp.files.length }) + '\n' + body,
    data: {
      org: r.org, repo: r.repo, base, head,
      files: cmp.files.map(f => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    },
  }
}

/** `repo-branches`: list branches. */
export async function repoBranches(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const branches = await ctx.forgejo.listBranches(r.org, r.repo, ctx.locale)
  if (branches.length === 0) return { content: tr(ctx.locale, 'repoNoEntries', { org: r.org, repo: r.repo, ref: '' }) }
  const lines = branches.map(b => `${b.name}  ${short(b.sha)}`)
  return {
    content: tr(ctx.locale, 'repoBranchesHeader', { org: r.org, repo: r.repo, count: branches.length }) + '\n' + lines.join('\n'),
    data: { org: r.org, repo: r.repo, branches },
  }
}

/** `repo-branch-create`: create a branch from a ref.
 *
 * Also FORKS the branch's session from the source branch's session (repo:branch
 * <-> session, 1:1). The new session is ALWAYS seeded with an `event` mailbox
 * message carrying a fork-context preamble (its history belongs to the parent;
 * it must plan with `todo-write`). When a `task` is given, a `trigger` follows
 * the event (delivered after it, so the preamble lands first) that wakes the
 * new session to do the work — one step: create branch + dispatch. */
export async function repoBranchCreate(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  // A maintainer may only create branches in its OWN repository (org/repo
  // default to the session's and must match it).
  const r = ownRepoRef(ctx, args)
  const from = strArg(args, 'from') || (r.ref !== '' ? r.ref : await ctx.forgejo.resolveRef(r.org, r.repo, '', ctx.locale))
  const name = requireName(requireArg(args, 'name', ctx.locale), 'name', ctx.locale)
  const task = strArg(args, 'task')
  await ctx.forgejo.createBranch(r.org, r.repo, name, from, ctx.locale)
  // Fork the corresponding branch session from the source branch's session
  // (repo:branch <-> session, 1:1). The source session is `org:repo:<from>`;
  // best-effort: on failure still ensure the new branch has SOME session.
  let forked = true
  try {
    await ctx.gateway.forkBranchSession({
      session: `${r.org}:${r.repo}:${from}`,
      branch: name,
    })
  } catch {
    forked = false
    try {
      await ctx.gateway.ensureBranchSession({ org: r.org, repo: r.repo, branch: name })
    } catch {
      /* best effort */
    }
  }
  // Seed the new session. `event` only folds into context (no turn); it is sent
  // BEFORE any task `trigger` so the preamble is the first thing in the chain.
  const childSession = `${r.org}:${r.repo}:${name}`
  if (ctx.deps !== undefined) {
    const preamble = tr(ctx.locale, 'branchForkPreamble', {
      org: r.org, repo: r.repo, branch: name, parent: ctx.session,
    })
    try {
      await ctx.deps.publishMailbox(ctx.tenant, childSession, 'event', { content: preamble }, 'system:repo-branch-fork')
    } catch {
      /* best effort */
    }
    if (task !== '') {
      const reminder = tr(ctx.locale, 'branchForkTodoReminder')
      try {
        await ctx.deps.publishMailbox(
          ctx.tenant, childSession, 'trigger',
          { text: `${reminder}\n\n${task}` }, `session:${ctx.session}`,
        )
      } catch {
        /* best effort */
      }
    }
  }
  return {
    content: tr(ctx.locale, 'repoBranchCreated', { name, org: r.org, repo: r.repo, from }),
    data: { org: r.org, repo: r.repo, name, from, forked, dispatched: task !== '' },
  }
}

/** `repo-tags`: list tags. */
export async function repoTags(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const tags = await ctx.forgejo.listTags(r.org, r.repo, ctx.locale)
  if (tags.length === 0) return { content: tr(ctx.locale, 'repoNoEntries', { org: r.org, repo: r.repo, ref: '' }) }
  const lines = tags.map(t => `${t.name}  ${short(t.sha)}`)
  return {
    content: tr(ctx.locale, 'repoTagsHeader', { org: r.org, repo: r.repo, count: tags.length }) + '\n' + lines.join('\n'),
    data: { org: r.org, repo: r.repo, tags },
  }
}

/** `repo-tag-create`: create a tag at a target (OWN repository only). */
export async function repoTagCreate(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = ownRepoRef(ctx, args)
  const name = requireName(requireArg(args, 'name', ctx.locale), 'name', ctx.locale)
  const target = strArg(args, 'target') || (r.ref !== '' ? r.ref : await ctx.forgejo.resolveRef(r.org, r.repo, '', ctx.locale))
  await ctx.forgejo.createTag(r.org, r.repo, name, target, ctx.locale)
  return {
    content: tr(ctx.locale, 'repoTagCreated', { name, org: r.org, repo: r.repo, target }),
    data: { org: r.org, repo: r.repo, name, target },
  }
}

/** `repo-mr-create`: open a pull request.
 *
 * Routed through the GATEWAY so its conflict-marker gate applies (a branch
 * carrying unresolved ABCP-CONFLICT markers is refused).
 *
 * After the MR is created the BASE branch's session is woken with a mailbox
 * `trigger` (source `system:repo-mr`), so the reviewer (e.g. the main-branch
 * maintainer) is notified instead of having to poll `repo-mr-list`. */
export async function repoMrCreate(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const title = requireArg(args, 'title', ctx.locale)
  const head = requireName(requireArg(args, 'head', ctx.locale), 'head', ctx.locale)
  const base = requireName(requireArg(args, 'base', ctx.locale), 'base', ctx.locale)
  const body = strArg(args, 'body')
  const res = await ctx.gateway.createMR({ org: r.org, repo: r.repo, title, head, base, body })
  // Notify the base branch's session (best-effort: a delivery failure must not
  // fail the MR). Skip when the base IS the caller (nothing to notify).
  const baseSession = `${r.org}:${r.repo}:${base}`
  if (ctx.deps !== undefined && baseSession !== ctx.session) {
    const text = tr(ctx.locale, 'mrCreatedNotice', {
      index: res.index,
      title,
      head,
      base,
      org: r.org,
      repo: r.repo,
      url: res.url,
    })
    // Ensure the base session exists so its mailbox is durable; a failure here
    // (e.g. an agent that does not know the tenant yet) must not suppress the
    // notification.
    try {
      await ctx.gateway.ensureBranchSession({ org: r.org, repo: r.repo, branch: base })
    } catch {
      /* best-effort */
    }
    try {
      await ctx.deps.publishMailbox(ctx.tenant, baseSession, 'trigger', { text }, 'system:repo-mr')
    } catch {
      /* notification is best-effort */
    }
  }
  return {
    content: tr(ctx.locale, 'repoMrCreated', { index: res.index, org: r.org, repo: r.repo, url: res.url }),
    data: { org: r.org, repo: r.repo, index: res.index, url: res.url },
  }
}

/** `repo-mr-list`: list pull requests. */
export async function repoMrList(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const state = strArg(args, 'state')
  const pulls = await ctx.forgejo.listPulls(r.org, r.repo, state, ctx.locale)
  if (pulls.length === 0) return { content: tr(ctx.locale, 'repoMrListHeader', { org: r.org, repo: r.repo, count: 0 }) }
  const lines = pulls.map(p => {
    // A conflicted/diverged PR is explicitly flagged so a maintainer can
    // dispatch the branch session to sync before merging.
    const state = p.merged ? 'merged' : p.mergeable || p.state !== 'open' ? p.state : `${p.state} CONFLICT`
    return `#${p.index} [${state}] ${p.head} -> ${p.base}  ${p.title}`
  })
  return {
    content: tr(ctx.locale, 'repoMrListHeader', { org: r.org, repo: r.repo, count: pulls.length }) + '\n' + lines.join('\n'),
    data: { org: r.org, repo: r.repo, pulls },
  }
}

/** `repo-mr-comment`: comment on a pull request.
 *
 * After the comment lands, the REVIEWER (the base branch's session — `main` for
 * a feature branch) is woken with a `trigger` so it learns of the discussion
 * without polling. When the reviewer itself comments, the HEAD (source) session
 * is woken instead. Best-effort; a delivery failure never fails the comment. */
export async function repoMrComment(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const index = Math.trunc(numArg(args, 'index') ?? 0)
  if (index <= 0) throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'index' }))
  const body = requireArg(args, 'body', ctx.locale)
  await ctx.forgejo.createComment(r.org, r.repo, index, body, ctx.locale)
  // Notify the OTHER side of the review: the reviewer normally, or the source
  // session when the reviewer is the one commenting. Skip self / unknown.
  if (ctx.deps !== undefined) {
    try {
      const mr = (await ctx.gateway.getMR({ org: r.org, repo: r.repo, index })).mr
      const head = mr?.head ?? ''
      const base = mr?.base || 'main'
      const headSession = `${r.org}:${r.repo}:${head}`
      const baseSession = `${r.org}:${r.repo}:${base}`
      const target = ctx.session === baseSession ? headSession : baseSession
      if (head !== '' && target !== ctx.session) {
        const branch = target === headSession ? head : base
        try {
          await ctx.gateway.ensureBranchSession({ org: r.org, repo: r.repo, branch })
        } catch {
          /* best effort */
        }
        const text = tr(ctx.locale, 'mrCommentNotice', {
          index, head, base, org: r.org, repo: r.repo, body,
        })
        try {
          await ctx.deps.publishMailbox(ctx.tenant, target, 'trigger', { text }, 'system:repo-mr-comment')
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* best effort: the comment already succeeded */
    }
  }
  return { content: tr(ctx.locale, 'repoMrCommented', { index, org: r.org, repo: r.repo }), data: { org: r.org, repo: r.repo, index } }
}

/** `repo-mr-merge`: merge a pull request (maintainer).
 *
 * Routed through the GATEWAY: it refuses when the PR is not mergeable, or when
 * the head branch still carries unresolved conflict markers. */
export async function repoMrMerge(
  ctx: RepoCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = repoRef(args, ctx.locale)
  const index = Math.trunc(numArg(args, 'index') ?? 0)
  if (index <= 0) throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'index' }))
  await ctx.gateway.mergeMR({ org: r.org, repo: r.repo, index })
  // A merge moves `main`; refresh the maintainer session's own sandboxes.
  const fanned = ctx.fanout !== undefined ? await ctx.fanout(r.org, r.repo, r.ref, '') : 0
  const note = fanned > 0 ? `\n${tr(ctx.locale, 'fanoutUpdated', { count: fanned })}` : ''
  return { content: tr(ctx.locale, 'repoMrMerged', { index, org: r.org, repo: r.repo }) + note, data: { org: r.org, repo: r.repo, index, fanned } }
}
