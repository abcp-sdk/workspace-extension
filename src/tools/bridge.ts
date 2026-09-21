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
 * overwrite). `dest` defaults to the workspace root.
 */
export async function sandboxCheckout(
  ctx: BridgeCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const r = refOf(args, ctx.locale)
  const dest = strArg(args, 'dest')
  const clean = args['clean'] === true
  // The archive endpoint needs a concrete ref; resolve an empty one to the
  // repository default branch.
  const ref = r.ref !== '' ? r.ref : await ctx.forgejo.resolveRef(r.org, r.repo, '', ctx.locale)
  const archive = await ctx.forgejo.archiveTarGz(r.org, r.repo, ref, ctx.locale)
  const res = await ctx.client.syncFolder({
    tarball: archive,
    dest: dest === '' ? '.' : dest,
    clean,
    rev: ref,
  })
  return {
    content: tr(ctx.locale, 'checkoutDone', {
      org: r.org, repo: r.repo, ref, files: res.files,
    }),
    data: { org: r.org, repo: r.repo, ref, dest: res.root, files: res.files },
  }
}

/** A file to port: repo-relative path + content. */
interface PortedFile {
  path: string
  content: string
}

/**
 * `sandbox-port`: commit sandbox file(s) back to the repo. A single file is
 * overwritten (update). A directory is ported as NEW files only — if ANY file
 * in the directory already exists in the repo, the whole port is refused (no
 * overwrite logic for directory ports, per design).
 */
export async function sandboxPort(
  ctx: BridgeCtx,
  args: Record<string, unknown>,
): Promise<ToolResultData> {
  const rawRef = refOf(args, ctx.locale)
  const sandboxPath = strArg(args, 'path')
  if (sandboxPath === '') {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'argRequired', { key: 'path' }))
  }
  const repoPath = strArg(args, 'repo-path') || sandboxPath
  const message = strArg(args, 'message') || `port ${sandboxPath}`
  // A commit needs a concrete branch; resolve an empty ref to the default.
  const r: RepoRef = {
    ...rawRef,
    ref: rawRef.ref !== '' ? rawRef.ref : await ctx.forgejo.resolveRef(rawRef.org, rawRef.repo, '', ctx.locale),
  }

  // Is the sandbox path a directory?
  const stat = await ctx.client.fileList({ path: sandboxPath })
  let files: PortedFile[]
  if (stat.isDir) {
    files = await collectDir(ctx.client, sandboxPath, repoPath)
  } else {
    const data = await ctx.client.fileRead({ path: sandboxPath })
    files = [{ path: repoPath, content: new TextDecoder().decode(data.content) }]
  }
  if (files.length === 0) {
    throw new TypedToolError('invalid_argument', tr(ctx.locale, 'portNoFiles', { path: sandboxPath }))
  }

  // Directory port: refuse if ANY target path already exists (no overwrite).
  if (stat.isDir) {
    const existing: string[] = []
    for (const f of files) {
      try {
        const cur = await ctx.forgejo.getContents(r.org, r.repo, f.path, r.ref, ctx.locale)
        if (cur.kind === 'file') existing.push(f.path)
      } catch {
        // absent -> fine
      }
    }
    if (existing.length > 0) {
      throw new TypedToolError(
        'invalid_argument',
        tr(ctx.locale, 'portRefusedExists', {
          count: existing.length,
          org: r.org,
          repo: r.repo,
          ref: r.ref || 'HEAD',
          paths: existing.slice(0, 20).join(', '),
        }),
      )
    }
  }

  const commitFiles: CommitFile[] = files.map(f => ({
    path: f.path,
    operation: stat.isDir ? 'create' : 'update',
    content: f.content,
  }))
  const res = await ctx.forgejo.commitFiles(r.org, r.repo, commitFiles, message, {
    ref: r.ref,
    locale: ctx.locale,
  })
  return {
    content: tr(ctx.locale, 'portDone', {
      count: files.length, org: r.org, repo: r.repo, ref: r.ref || 'HEAD', sha: short(res.sha),
    }),
    data: { org: r.org, repo: r.repo, ref: r.ref, commit: res.sha, count: files.length, paths: files.map(f => f.path) },
  }
}

/** Recursively read a sandbox directory into repo-relative text files. */
async function collectDir(client: WorkerClient, sandboxDir: string, repoDir: string): Promise<PortedFile[]> {
  const out: PortedFile[] = []
  const res = await client.fileList({ path: sandboxDir })
  if (!res.isDir) {
    const data = await client.fileRead({ path: sandboxDir })
    return [{ path: repoDir, content: new TextDecoder().decode(data.content) }]
  }
  for (const entry of res.files) {
    const name = entry.path.split('/').pop() ?? entry.path
    const repoChild = repoDir.replace(/\/+$/, '') === '' ? name : `${repoDir.replace(/\/+$/, '')}/${name}`
    if (entry.isDir) {
      out.push(...(await collectDir(client, entry.path, repoChild)))
    } else {
      const data = await client.fileRead({ path: entry.path })
      out.push({ path: repoChild, content: new TextDecoder().decode(data.content) })
    }
  }
  return out
}

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha
}
