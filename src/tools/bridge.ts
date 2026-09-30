import { TypedToolError } from '@abc-protocol/sdk'
import type { ToolResultData } from '@abc-protocol/sdk'
import type { WorkerClient } from '../client.js'
import type { Forgejo, CommitFile } from '../forgejo.js'
import { tr } from '../i18n.js'
import { strArg } from './shared.js'

/** Context for the repo↔sandbox bridge tools. */
export interface BridgeCtx {
  client: WorkerClient
  forgejo: Forgejo
  locale: string
  /** The session's own branch (`org:repo:branch`), used as the default target. */
  branch?: string
  /** Fan a merged base branch out to the session's other sandboxes (optional). */
  fanout?: (org: string, repo: string, branch: string, newRev: string) => Promise<number>
}

interface RepoRef {
  org: string
  repo: string
  ref: string
}

function refOf(args: Record<string, unknown>, locale: string): RepoRef {
  const org = strArg(args, 'org')
  const repo = strArg(args, 'repo')
  const ref = strArg(args, 'ref')
  if (org === '' || repo === '') {
    throw new TypedToolError('invalid_argument', tr(locale, 'argRequired', { key: org === '' ? 'org' : 'repo' }))
  }
  return { org, repo, ref }
}

/**
 * `sandbox-checkout`: download the repo tree at `ref` as tar.gz and unpack it
 * into the sandbox workspace. `clean:false` keeps sandbox-only files and only
 * replaces files present in the archive (matching the worker's per-entry
 * overwrite). The gateway STRIPS the archive's `<repo>/` wrapper, so `dest` is
 * the exact directory the repo tree lands in: `dest=myapp` yields
 * `<workspace>/myapp/README.md`. `dest` defaults to the repository name (so the
 * default layout is `<workspace>/<repo>/`).
 */
export async function sandboxCheckout(
  ctx: BridgeCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = refOf(args, ctx.locale)
  const dest = strArg(args, 'dest') || r.repo
  const clean = args['clean'] === true
  // The archive endpoint needs a concrete ref; resolve an empty one to the
  // repository default branch.
  const ref = r.ref !== '' ? r.ref : await ctx.forgejo.resolveRef(r.org, r.repo, '', ctx.locale)
  const archive = await ctx.forgejo.archiveTarGz(r.org, r.repo, ref, ctx.locale)
  const res = await ctx.client.syncFolder({
    tarball: archive,
    dest,
    clean,
    rev: ref,
  })
  return {
    content: tr(ctx.locale, 'checkoutDone', {
      org: r.org, repo: r.repo, ref, dest, files: res.files,
    }),
    data: { org: r.org, repo: r.repo, ref, dest, files: res.files },
  }
}

/** A file read from the sandbox: repo-relative path + raw bytes. */
interface SandboxFile {
  path: string
  bytes: Uint8Array
}

/** Build a CommitFile from raw bytes, choosing text vs binary representation. */
function toCommitFile(path: string, bytes: Uint8Array): CommitFile {
  try {
    return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { path, contentBytes: bytes }
  }
}

/**
 * `sandbox-submit-mr`: the ONLY way branch content changes. It diffs the
 * sandbox's repo directory (`path`) against `base` and submits the change set
 * as an MR: the gateway materializes it onto a new immutable `mr/...` head
 * branch and opens the MR into `base`.
 *
 * `base` and `path` are REQUIRED. `path` is the repo directory in the sandbox
 * (e.g. `myapp`); only files under it are considered, so unrelated sandbox
 * scratch files never leak into the change set. A file present in `base` but
 * absent in the sandbox is submitted as a DELETE.
 */
export async function sandboxSubmitMR(
  ctx: BridgeCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = refOf(args, ctx.locale)
  const base = strArg(args, 'base')
  const dir = strArg(args, 'path')
  if (base === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'base' }))
  }
  if (dir === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'path' }))
  }
  const title = strArg(args, 'title')
  const body = strArg(args, 'body')

  // 1. Read the sandbox repo directory into repo-relative files.
  const sandbox = await collectDir(ctx.client, dir, '')
  if (sandbox.length === 0) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'submitNoFiles', { path: dir }))
  }
  const sandboxByPath = new Map(sandbox.map(f => [f.path, f.bytes]))

  // 2. Read the base tree (repo-relative paths).
  const basePaths = await ctx.forgejo.listTree(r.org, r.repo, base, ctx.locale)

  // 3. Build the change set: added/changed files + deletions.
  const files: CommitFile[] = []
  for (const f of sandbox) {
    const inBase = basePaths.has(f.path)
    if (!inBase) {
      files.push({ ...toCommitFile(f.path, f.bytes), operation: 'create' })
      continue
    }
    // Compare content; skip unchanged to keep the MR minimal.
    const cur = await ctx.forgejo.getRaw(r.org, r.repo, f.path, base, ctx.locale)
    if (!bytesEqual(cur, f.bytes)) {
      files.push({ ...toCommitFile(f.path, f.bytes), operation: 'update' })
    }
  }
  for (const p of basePaths) {
    if (!sandboxByPath.has(p)) files.push({ path: p, operation: 'delete' })
  }
  if (files.length === 0) {
    return { content: tr(ctx.locale, 'submitNoChanges', { org: r.org, repo: r.repo, base }) }
  }

  // 4. Submit (gateway creates the immutable mr/... head and opens the MR).
  const res = await ctx.forgejo.submitMR(
    r.org, r.repo, base, title, body, files, ctx.locale,
  )
  return {
    content: tr(ctx.locale, 'submitDone', {
      index: res.index, org: r.org, repo: r.repo, base, head: res.head, count: files.length,
    }),
    data: { org: r.org, repo: r.repo, base, head: res.head, index: res.index, url: res.url, files: files.map(f => f.path) },
  }
}

/** Byte equality for two Uint8Arrays (length then element-wise). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Read a sandbox directory into repo-relative files. `sandboxDir` is the repo
 * directory inside the workspace; `repoDir` is the repo-relative prefix the
 * files are given (here always ''). One recursive `fileList` (server-side depth)
 * replaces a round-trip per directory.
 */
async function collectDir(client: WorkerClient, sandboxDir: string, repoDir: string): Promise<SandboxFile[]> {
  const root = sandboxDir.replace(/\/+$/, '')
  const res = await client.fileList({ path: root, depth: 1000, limit: 10000 })
  const out: SandboxFile[] = []
  for (const entry of res.files) {
    if (entry.isDir) continue
    let rel = entry.path
    if (rel === root || rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1)
    if (rel === '' || rel === root) continue
    const data = await client.fileRead({ path: entry.path })
    out.push({ path: repoDir === '' ? rel : `${repoDir}/${rel}`, bytes: data.content })
  }
  return out
}
