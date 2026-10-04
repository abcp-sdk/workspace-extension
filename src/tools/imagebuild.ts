import type { ToolResultData } from '@abc-protocol/sdk'
import { TypedToolError } from '@abc-protocol/sdk'
import type { GatewayClient } from '../client.js'
import { tr } from '../i18n.js'
import { strArg } from './shared.js'

/** Context for `repo-build-image` (the workspace gateway runs the build). */
export interface BuildCtx {
  workspace: GatewayClient
  locale: string
}

/** Read a `build-args` argument as a string→string map. */
function buildArgs(args: Record<string, unknown>): Record<string, string> {
  const raw = args['build-args']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * `repo-build-image`: build a container image from a repository Dockerfile
 * (context = a repo subdirectory) and push it to the deployment registry.
 *
 * The produced image does NOT have agent-worker injected: to be usable as a
 * sandbox, the Dockerfile must FROM a worker-bundled base image (one built by
 * `abc-protocol/worker`'s `sandbox-images/build.sh`).
 *
 * The build runs in the BACKGROUND (a large image's layer push is minutes): the
 * gateway returns a build_id immediately; poll `repo-build-status` for the
 * result.
 */
export async function repoBuildImage(
  ctx: BuildCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = strArg(args, 'org')
  const repo = strArg(args, 'repo')
  const image = strArg(args, 'image')
  const tag = strArg(args, 'tag')
  for (const [key, val] of [['org', org], ['repo', repo], ['image', image], ['tag', tag]] as const) {
    if (val === '') {
      throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key }))
    }
  }
  try {
    const res = await ctx.workspace.buildSandboxImage({
      org,
      repo,
      ref: strArg(args, 'ref'),
      dockerfile: strArg(args, 'dockerfile'),
      context: strArg(args, 'context'),
      image,
      tag,
      buildArgs: buildArgs(args),
    })
    return {
      content: tr(ctx.locale, 'imageBuildStarted', { image: `${image}:${tag}`, id: res.buildId }),
      data: { build_id: res.buildId, image: `${image}:${tag}` },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'imageBuildFailed', { image: `${image}:${tag}`, err: String(e) }))
  }
}

/**
 * `repo-build-status`: poll a background image build started by
 * `repo-build-image`. Returns state (running|done|failed), the pushed image ref
 * (on done) and the build log.
 */
export async function repoBuildStatus(
  ctx: BuildCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const buildId = strArg(args, 'build-id')
  if (buildId === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'build-id' }))
  }
  const res = await ctx.workspace.getBuildStatus({ buildId })
  const content =
    tr(ctx.locale, 'buildStatus', { id: res.buildId, state: res.state }) +
    (res.imageRef ? `\n${res.imageRef}` : '') +
    (res.log ? `\n\n${res.log}` : '')
  return {
    content,
    data: { build_id: res.buildId, state: res.state, image_ref: res.imageRef },
  }
}

/**
 * `oci-import`: mirror an upstream image (public or, with credentials, private)
 * into the deployment registry under an org the caller owns. This is the OCI
 * analogue of `repo-import`: the image lands at `<registry>/<org>/<name>:<tag>`
 * and becomes referenceable from `service-deploy` / as a sandbox base.
 */
export async function ociImport(
  ctx: BuildCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = strArg(args, 'org')
  const name = strArg(args, 'name')
  const tag = strArg(args, 'tag')
  const source = strArg(args, 'source')
  for (const [key, val] of [['org', org], ['name', name], ['tag', tag], ['source', source]] as const) {
    if (val === '') {
      throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key }))
    }
  }
  try {
    const res = await ctx.workspace.importImage({
      org,
      name,
      tag,
      source,
      authUser: strArg(args, 'auth-user'),
      authToken: strArg(args, 'auth-token'),
    })
    return {
      content: tr(ctx.locale, 'imageImported', { image: res.imageRef, source }) + '\n\n' + res.log,
      data: { image_ref: res.imageRef, source },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'imageImportFailed', { image: `${org}/${name}:${tag}`, err: String(e) }))
  }
}
