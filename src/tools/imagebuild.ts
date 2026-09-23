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
 * The produced image does NOT have easyworker injected: to be usable as a
 * sandbox, the Dockerfile must FROM a worker-capable base image.
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
      content: tr(ctx.locale, 'imageBuilt', { image: res.imageRef }) + '\n\n' + res.log,
      data: { image_ref: res.imageRef },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'imageBuildFailed', { image: `${image}:${tag}`, err: String(e) }))
  }
}

/**
 * `repo-build-preview`: build a PREVIEW image from a repository Dockerfile.
 * The image NAME is forced to the repo and the TAG to `preview-<branch>-<sha>`
 * (the caller may append a suffix), so a preview build can never overwrite a
 * release tag. The result feeds `service-preview`.
 */
export async function repoBuildPreview(
  ctx: BuildCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const org = strArg(args, 'org')
  const repo = strArg(args, 'repo')
  for (const [key, val] of [['org', org], ['repo', repo]] as const) {
    if (val === '') {
      throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key }))
    }
  }
  try {
    const res = await ctx.workspace.buildPreviewImage({
      org,
      repo,
      ref: strArg(args, 'ref'),
      dockerfile: strArg(args, 'dockerfile'),
      context: strArg(args, 'context'),
      tagSuffix: strArg(args, 'tag-suffix'),
      buildArgs: buildArgs(args),
    })
    return {
      content: tr(ctx.locale, 'previewImageBuilt', { image: res.imageRef }) + '\n\n' + res.log,
      data: { image_ref: res.imageRef, tag: res.tag },
    }
  } catch (e) {
    throw new TypedToolError('internal', tr(ctx.locale, 'imageBuildFailed', { image: `${org}/${repo}`, err: String(e) }))
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
