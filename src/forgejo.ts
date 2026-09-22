// Gateway-backed repository client.
//
// WHY: the extension used to call Forgejo DIRECTLY with a shared admin token,
// which let any tenant list/read/write every OTHER tenant's repos (the token
// is global). Repo operations now go through the WORKSPACE GATEWAY
// (workspace.v1), whose handlers call `ensureVisible` first — so a tenant can
// only touch a repo it owns. The gateway owns the Forgejo credentials; the
// extension never holds a Forgejo token.
//
// This class deliberately keeps the SAME method surface the tools already use
// (getContents / commitFiles / listBranches / …), so only construction changes.
import type { GatewayClient } from './client.js'
import { tr } from './i18n.js'
import { TypedToolError } from '@abc-protocol/sdk'

export interface ForgejoAuth {
  token?: string
  user?: string
  password?: string
}

export interface ForgejoOptions {
  /** Base URL, e.g. `http://forgejo.example`. Trailing slash trimmed. */
  url: string
  auth: ForgejoAuth
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** One repo entry from search/list. */
export interface RepoInfo {
  fullName: string
  owner: string
  name: string
  defaultBranch: string
  private: boolean
  empty: boolean
}

/** A file/dir entry from the contents or tree API. */
export interface ContentEntry {
  path: string
  name: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  size: number
  sha: string
}

/** A commit entry. */
export interface CommitInfo {
  sha: string
  message: string
  author: string
  date: string
  parents: string[]
}

/** A branch/tag entry. */
export interface RefInfo {
  name: string
  sha: string
}

export interface CommitFile {
  path: string
  operation?: 'create' | 'update' | 'delete'
  content?: string
  contentBytes?: Uint8Array
  sha?: string
  fromPath?: string
}

export interface CommitResult {
  sha: string
  message: string
}

/** Map a gateway Connect error to a typed tool error (keeps tool messages). */
function gatewayError(e: unknown, locale: string): TypedToolError {
  const err = e as { code?: string; message?: string }
  const code = err?.code ?? ''
  const msg = err?.message ?? String(e)
  if (code === 'not_found') return new TypedToolError('not_found', tr(locale, 'forgejoNotFound', { msg }))
  if (code === 'permission_denied') return new TypedToolError('permission_denied', tr(locale, 'forgejoUnauthorized', { status: 403, msg }))
  if (code === 'failed_precondition' || code === 'aborted') return new TypedToolError('retryable', tr(locale, 'forgejoConflict', { msg }))
  if (code === 'invalid_argument') return new TypedToolError('invalid_argument', tr(locale, 'forgejoInvalid', { msg }))
  return new TypedToolError('internal', msg)
}

/**
 * Repository operations via the workspace gateway. Constructed with a
 * gateway client that already carries the tenant identity (bearer + tenant
 * header), so every call is tenant-scoped server-side.
 */
export class Forgejo {
  readonly base: string
  private readonly gateway: GatewayClient

  constructor(opts: { url?: string; gateway: GatewayClient; auth?: ForgejoAuth; fetchImpl?: typeof fetch }) {
    this.base = (opts.url ?? '').trim().replace(/\/+$/, '')
    this.gateway = opts.gateway
  }

  // ---- org / repo ----

  async createOrg(opts: { org: string; locale?: string }): Promise<{ name: string }> {
    try {
      const r = await this.gateway.createOrg({ org: opts.org })
      return { name: r.org }
    } catch (e) {
      throw gatewayError(e, opts.locale ?? 'en')
    }
  }

  async listOrgs(locale = 'en'): Promise<Array<{ name: string; description: string }>> {
    try {
      const r = await this.gateway.listOrgs({})
      return (r.orgs ?? []).map(name => ({ name, description: '' }))
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async listOrgRepos(org: string, locale = 'en'): Promise<RepoInfo[]> {
    try {
      const r = await this.gateway.listRepos({})
      return (r.repos ?? [])
        .filter(x => x.org === org)
        .map(x => toRepoInfo(x.org, x.repo, x.defaultBranch, x.private))
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async getRepo(org: string, repo: string, locale = 'en'): Promise<RepoInfo> {
    try {
      const r = await this.gateway.repoMeta({ org, repo })
      return toRepoInfo(r.org, r.repo, r.defaultBranch, r.private, r.empty)
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async resolveRef(org: string, repo: string, ref: string, locale = 'en'): Promise<string> {
    if (ref !== '') return ref
    const info = await this.getRepo(org, repo, locale)
    return info.defaultBranch
  }

  // ---- refs ----

  async listBranches(org: string, repo: string, locale = 'en'): Promise<RefInfo[]> {
    try {
      const r = await this.gateway.branches({ org, repo })
      return (r.branches ?? []).map(b => ({ name: b.name, sha: b.sha }))
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async listTags(org: string, repo: string, locale = 'en'): Promise<RefInfo[]> {
    try {
      const r = await this.gateway.tags({ org, repo })
      return (r.tags ?? []).map(t => ({ name: t.name, sha: t.sha }))
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async createBranch(org: string, repo: string, name: string, from: string, locale = 'en'): Promise<void> {
    try {
      await this.gateway.createBranch({ org, repo, name, from })
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async createTag(org: string, repo: string, name: string, target: string, locale = 'en'): Promise<void> {
    try {
      await this.gateway.createTag({ org, repo, name, target })
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  // ---- contents ----

  async getContents(
    org: string,
    repo: string,
    path: string,
    ref: string,
    locale = 'en',
  ): Promise<{ kind: 'file'; text: string; sha: string; size: number } | { kind: 'dir'; entries: ContentEntry[] }> {
    try {
      const r = await this.gateway.contents({ org, repo, ref, path })
      if (r.isDir) {
        return {
          kind: 'dir',
          entries: (r.entries ?? []).map(e => ({
            path: e.path,
            name: e.name,
            type: (e.type || 'file') as ContentEntry['type'],
            size: Number(e.size),
            sha: e.sha,
          })),
        }
      }
      return { kind: 'file', text: r.text, sha: r.sha, size: Number(r.size) }
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async getRaw(org: string, repo: string, path: string, ref: string, locale = 'en'): Promise<Uint8Array> {
    try {
      const r = await this.gateway.readRaw({ org, repo, ref, path })
      return r.data
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async putFile(
    org: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    opts: { ref?: string; sha?: string; newBranch?: string; locale?: string } = {},
  ): Promise<CommitResult> {
    return this.commitFiles(
      org,
      repo,
      [{ path, operation: opts.sha !== undefined && opts.sha !== '' ? 'update' : 'create', content, ...(opts.sha !== undefined && opts.sha !== '' ? { sha: opts.sha } : {}) }],
      message,
      opts,
    )
  }

  async deleteFile(
    org: string,
    repo: string,
    path: string,
    message: string,
    opts: { ref?: string; sha?: string; locale?: string } = {},
  ): Promise<CommitResult> {
    return this.commitFiles(
      org,
      repo,
      [{ path, operation: 'delete', ...(opts.sha !== undefined && opts.sha !== '' ? { sha: opts.sha } : {}) }],
      message,
      opts,
    )
  }

  async commitFiles(
    org: string,
    repo: string,
    files: CommitFile[],
    message: string,
    opts: { ref?: string; newBranch?: string; locale?: string } = {},
  ): Promise<CommitResult> {
    try {
      const r = await this.gateway.commitFiles({
        org,
        repo,
        message,
        ref: opts.ref ?? '',
        newBranch: opts.newBranch ?? '',
        files: files.map(f => ({
          path: f.path,
          operation: f.operation ?? 'update',
          content: f.content ?? '',
          contentBytes: f.contentBytes ?? new Uint8Array(),
          sha: f.sha ?? '',
          fromPath: f.fromPath ?? '',
        })),
      })
      return { sha: r.sha, message: '' }
    } catch (e) {
      throw gatewayError(e, opts.locale ?? 'en')
    }
  }

  // ---- history ----

  async listCommits(
    org: string,
    repo: string,
    opts: { ref?: string; path?: string; limit?: number; locale?: string } = {},
  ): Promise<CommitInfo[]> {
    try {
      const r = await this.gateway.log({ org, repo, ref: opts.ref ?? '', path: opts.path ?? '', limit: opts.limit ?? 50 })
      return (r.commits ?? []).map(c => ({ sha: c.sha, message: c.message, author: c.author, date: c.date, parents: [] }))
    } catch (e) {
      throw gatewayError(e, opts.locale ?? 'en')
    }
  }

  async getCommit(org: string, repo: string, sha: string, locale = 'en'): Promise<CommitInfo> {
    try {
      const r = await this.gateway.getCommit({ org, repo, sha })
      const c = r.commit
      return { sha: c?.sha ?? sha, message: c?.message ?? '', author: c?.author ?? '', date: c?.date ?? '', parents: c?.parents ?? [] }
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async commitDiff(org: string, repo: string, sha: string, locale = 'en'): Promise<string> {
    try {
      const r = await this.gateway.commitDiff({ org, repo, sha })
      return r.diff
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async compare(
    org: string,
    repo: string,
    base: string,
    head: string,
    locale = 'en',
  ): Promise<{ files: Array<{ path: string; status: string; additions: number; deletions: number; patch: string }> }> {
    try {
      const r = await this.gateway.compare({ org, repo, base, head })
      return {
        files: (r.files ?? []).map(f => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
      }
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  // ---- pull requests ----

  async listPulls(
    org: string,
    repo: string,
    state: string,
    locale = 'en',
  ): Promise<Array<{ index: number; title: string; state: string; head: string; base: string; mergeable: boolean; merged: boolean }>> {
    try {
      const r = await this.gateway.listMRs({ org, repo, state })
      return (r.mrs ?? []).map(m => ({
        index: m.index, title: m.title, state: m.state, head: m.head, base: m.base,
        mergeable: m.mergeable, merged: m.merged,
      }))
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  async createComment(org: string, repo: string, index: number, body: string, locale = 'en'): Promise<void> {
    try {
      await this.gateway.commentMR({ org, repo, index, body })
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }

  // ---- archive (checkout) ----

  async archiveTarGz(org: string, repo: string, ref: string, locale = 'en'): Promise<Uint8Array> {
    try {
      const r = await this.gateway.archive({ org, repo, ref })
      return r.data
    } catch (e) {
      throw gatewayError(e, locale)
    }
  }
}

function toRepoInfo(org: string, repo: string, defaultBranch: string, priv: boolean, empty = false): RepoInfo {
  return {
    fullName: `${org}/${repo}`,
    owner: org,
    name: repo,
    defaultBranch: defaultBranch || 'main',
    private: priv,
    empty,
  }
}
