import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import type { Forgejo } from '../forgejo.js'
import { tr } from '../i18n.js'
import { strArg } from './shared.js'
import { validComponent } from './repo-content.js'
import { parseSessionName } from './lifecycle.js'


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
 * — the same channel the HTTP prompt route uses.
 *
 * ALL real branches are PEERS: a session may message any branch of any
 * repository it can see (cross-repo allowed). The one restriction is that a
 * target may NOT be an `mr/...` branch (a system MR head has no session).
 *
 * The branch MUST exist in Forgejo: a message that would create a session with
 * no corresponding branch is refused (the mapping is strictly 1:1).
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
  // An `mr/...` branch is a system MR head with no session — never a target.
  if (branch.startsWith('mr/')) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'mailMrBranchRefused', { branch }))
  }

  // The caller must be a branch session (it has a repo identity).
  const self = parseSessionName(ctx.session)
  if (self === null) {
    throw new TypedToolError('permission_denied', tr(ctx.locale, 'mailNeedsBranchSession'))
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
