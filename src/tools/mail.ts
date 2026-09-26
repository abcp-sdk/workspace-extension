import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import type { Forgejo } from '../forgejo.js'
import { tr } from '../i18n.js'
import { strArg } from './shared.js'
import { validComponent } from './repo-content.js'
import { parseSessionName } from './lifecycle.js'

const MAIN = 'main'

export interface MailCtx {
  forgejo: Forgejo
  gateway: GatewayClient
  tenant: string
  session: string
  locale: string
  /** Publish into a session's durable mailbox (from WorkspaceDeps). */
  publishMailbox: (
    tenant: string,
    sessionName: string,
    type: string,
    payload: unknown,
    source?: string,
  ) => Promise<void>
}

/**
 * `repo-mail-send`: deliver a message (as a `trigger`) into a repository
 * branch's session mailbox, waking that session's turn.
 *
 * Addressing is by REPO + BRANCH (branch defaults to `main`), NOT by session
 * name: the tool resolves `org:repo:branch`, ensures the branch session exists
 * (repo:branch <-> session, 1:1), then publishes directly onto the NATS mailbox
 * — the same channel the HTTP prompt route uses. This replaces the bundled
 * `mail-send` (which required an existing session by name).
 *
 * The branch MUST exist in Forgejo: a message that would create a session with
 * no corresponding branch is refused (the mapping is strictly 1:1).
 *
 * AUTHORIZATION (a branch session is bound to ONE repo; messaging is
 * role-scoped, not tenant-wide):
 *   - a DEVELOPER (branch != main) may only message `main` of its OWN repo —
 *     i.e. report back to / request review from the maintainer;
 *   - a MAINTAINER (main) may message any branch of its own repo, and may
 *     message `main` of ANOTHER repo (peer maintainer coordination) — but never
 *     a non-main branch of another repo.
 * Cross-tenant targets remain invisible (the gateway's tenant scoping).
 */
export async function repoMailSend(
  ctx: MailCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = strArg(args, 'org')
  const repo = strArg(args, 'repo')
  const branch = strArg(args, 'branch') || 'main'
  const text = strArg(args, 'text')

  if (org === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'org' }))
  if (repo === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'repo' }))
  if (text === '') throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'text' }))
  if (!validComponent(org) || !validComponent(repo) || !validComponent(branch)) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'invalidName', { key: 'org/repo/branch', value: `${org}/${repo}:${branch}` }))
  }

  // A branch session may only message per its role (see the doc above).
  const self = parseSessionName(ctx.session)
  if (self === null) {
    throw new TypedToolError('permission_denied', tr(ctx.locale, 'mailNeedsBranchSession'))
  }
  const sameRepo = self.org === org && self.repo === repo
  if (!sameRepo && branch !== MAIN) {
    // Cross-repo messaging is maintainer-only AND only to a peer `main`.
    throw new TypedToolError('permission_denied', tr(ctx.locale, 'mailCrossRepoMainOnly', { org, repo, branch }))
  }
  if (self.branch !== MAIN && !(sameRepo && branch === MAIN)) {
    // A developer may only message its OWN repo's main (never another branch).
    throw new TypedToolError('permission_denied', tr(ctx.locale, 'mailDeveloperMainOnly'))
  }
  if (self.org === org && self.repo === repo && self.branch === branch) {
    throw new TypedToolError('permission_denied', tr(ctx.locale, 'mailSelfDenied', { session: ctx.session }))
  }

  // The branch must exist (branch <-> session is 1:1).
  const branches = await ctx.forgejo.listBranches(org, repo, ctx.locale)
  if (!branches.some(b => b.name === branch)) {
    throw new TypedToolError('not_found', tr(ctx.locale, 'mailBranchMissing', { branch }))
  }

  const session = `${org}:${repo}:${branch}`
  // Ensure a session exists for the branch (idempotent), then deliver.
  await ctx.gateway.ensureBranchSession({ org, repo, branch })

  await ctx.publishMailbox(ctx.tenant, session, 'trigger', { text }, `session:${ctx.session}`)
  return {
    content: tr(ctx.locale, 'mailDelivered', { session }),
    data: { session, org, repo, branch },
  }
}
