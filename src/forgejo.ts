import { TypedToolError } from '@abc-protocol/sdk'
import { tr } from './i18n.js'

/**
 * A small typed client over the Forgejo (Gitea-compatible) REST API. It owns
 * authentication, pagination, base64 file handling and error mapping; the tools
 * only speak in domain terms (read/write/commit/list/log/...).
 *
 * Auth: a personal access token (`Authorization: token <pat>`) is preferred;
 * when absent, HTTP Basic (`user:password`) is used. Both are supported.
 */

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
  /** Repo-relative path. */
  path: string
  /** `update` (default) or `delete`. */
  operation?: 'create' | 'update' | 'delete'
  /** UTF-8 content (ignored for delete). */
  content?: string
  /** Blob sha for optimistic locking (update/delete). */
  sha?: string
  /** For renames (update only). */
  fromPath?: string
}

export interface CommitResult {
  /** The new commit sha, when Forgejo reports it. */
  sha: string
  /** A human summary line Forgejo returns (file response). */
  message: string
}

const PAGE = 50
const MAX_PAGES = 40

/** Turn an HTTP status + body into a typed tool error. */
function httpError(status: number, body: string, locale: string): TypedToolError {
  const msg = body.length > 300 ? `${body.slice(0, 300)}…` : body
  if (status === 401 || status === 403) {
    return new TypedToolError('permission_denied', tr(locale, 'forgejoUnauthorized', { status, msg }))
  }
  if (status === 404) {
    return new TypedToolError('not_found', tr(locale, 'forgejoNotFound', { msg }))
  }
  if (status === 409) {
    return new TypedToolError('retryable', tr(locale, 'forgejoConflict', { msg }))
  }
  if (status === 422) {
    return new TypedToolError('invalid_argument', tr(locale, 'forgejoInvalid', { msg }))
  }
  return new TypedToolError('internal', tr(locale, 'forgejoHttp', { status, msg }))
}

export class Forgejo {
  readonly base: string
  private readonly auth: ForgejoAuth
  private readonly fetchImpl: typeof fetch

  constructor(opts: ForgejoOptions) {
    this.base = opts.url.trim().replace(/\/+$/, '')
    this.auth = opts.auth
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', ...extra }
    if (this.auth.token !== undefined && this.auth.token !== '') {
      h['Authorization'] = `token ${this.auth.token}`
    } else if (this.auth.user !== undefined && this.auth.user !== '') {
      const b64 = Buffer.from(`${this.auth.user}:${this.auth.password ?? ''}`).toString('base64')
      h['Authorization'] = `Basic ${b64}`
    }
    return h
  }

  /** JSON request; throws a typed error on a non-2xx status. */
  private async json<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; locale?: string | undefined } = {},
  ): Promise<T> {
    const locale = opts.locale ?? 'en'
    let url = `${this.base}/api/v1${path}`
    if (opts.query !== undefined) {
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== '') q.set(k, String(v))
      }
      const s = q.toString()
      if (s !== '') url += `?${s}`
    }
    const headers = this.headers(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw httpError(res.status, text, locale)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (text === '') return undefined as T
    return JSON.parse(text) as T
  }

  /** Fetch raw bytes (archive/raw file); throws a typed error on failure. */
  private async bytes(path: string, locale = 'en'): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.base}/api/v1${path}`, { headers: this.headers() })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw httpError(res.status, text, locale)
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  /** Follow Link rel=next pagination until exhausted (bounded). */
  private async paged<T>(path: string, query: Record<string, string | number | boolean | undefined>, locale: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.json<T[]>('GET', path, {
        query: { ...query, page, limit: PAGE },
        locale,
      })
      if (!Array.isArray(batch) || batch.length === 0) break
      out.push(...batch)
      if (batch.length < PAGE) break
    }
    return out
  }

  // ---- discovery ----

  /** Create an organization. `username` is the org's slug (required). */
  async createOrg(
    opts: {
      org: string
      fullName?: string
      description?: string
      visibility?: 'public' | 'limited' | 'private'
      email?: string
      location?: string
      website?: string
      locale?: string
    },
  ): Promise<{ name: string }> {
    const body: Record<string, unknown> = { username: opts.org }
    if (opts.fullName !== undefined && opts.fullName !== '') body['full_name'] = opts.fullName
    if (opts.description !== undefined && opts.description !== '') body['description'] = opts.description
    if (opts.visibility !== undefined) body['visibility'] = opts.visibility
    if (opts.email !== undefined && opts.email !== '') body['email'] = opts.email
    if (opts.location !== undefined && opts.location !== '') body['location'] = opts.location
    if (opts.website !== undefined && opts.website !== '') body['website'] = opts.website
    const res = await this.json<Record<string, unknown>>('POST', '/orgs', {
      body,
      locale: opts.locale,
    })
    return { name: String(res['username'] ?? res['name'] ?? opts.org) }
  }

  /**
   * Create a repository under `owner`. The owner may be an organization OR a
   * user: the org endpoint is tried first, and on 404 we fall back to
   * `POST /user/repos` (which creates under the authenticated user). When
   * `owner` is empty, only the user endpoint is used.
   */
  async createRepo(
    owner: string,
    opts: {
      repo: string
      private?: boolean
      autoInit?: boolean
      defaultBranch?: string
      description?: string
      readme?: string
      gitignores?: string
      license?: string
      locale?: string
    },
  ): Promise<RepoInfo> {
    const body: Record<string, unknown> = { name: opts.repo }
    if (opts.private !== undefined) body['private'] = opts.private
    if (opts.autoInit !== undefined) body['auto_init'] = opts.autoInit
    if (opts.defaultBranch !== undefined && opts.defaultBranch !== '') body['default_branch'] = opts.defaultBranch
    if (opts.description !== undefined && opts.description !== '') body['description'] = opts.description
    if (opts.readme !== undefined && opts.readme !== '') body['readme'] = opts.readme
    if (opts.gitignores !== undefined && opts.gitignores !== '') body['gitignores'] = opts.gitignores
    if (opts.license !== undefined && opts.license !== '') body['license'] = opts.license

    if (owner !== '') {
      try {
        const res = await this.json<Record<string, unknown>>(
          'POST',
          `/orgs/${seg(owner)}/repos`,
          { body, locale: opts.locale },
        )
        return toRepoInfo(res)
      } catch (e) {
        // Not an org (or unknown) -> fall through to the user endpoint.
        if (!(e instanceof TypedToolError) || e.code !== 'not_found') throw e
      }
    }
    const res = await this.json<Record<string, unknown>>('POST', '/user/repos', {
      body,
      locale: opts.locale,
    })
    return toRepoInfo(res)
  }

  /** Organizations the credential can see. */
  async listOrgs(locale = 'en'): Promise<Array<{ name: string; description: string }>> {
    const rows = await this.paged<Record<string, unknown>>('/orgs', {}, locale)
    return rows.map(o => ({
      name: String(o['username'] ?? o['name'] ?? ''),
      description: String(o['description'] ?? ''),
    })).filter(o => o.name !== '')
  }

  /** Repositories owned by an org OR a user. */
  async listOrgRepos(org: string, locale = 'en'): Promise<RepoInfo[]> {
    // An owner may be an organization OR a user; try the org endpoint first,
    // then fall back to the user endpoint (a user is not an org, and vice
    // versa). Both are paginated.
    try {
      const rows = await this.paged<Record<string, unknown>>(`/orgs/${encodeURIComponent(org)}/repos`, {}, locale)
      return rows.map(toRepoInfo).filter(r => r.fullName !== '')
    } catch (e) {
      if (!(e instanceof TypedToolError) || e.code !== 'not_found') throw e
    }
    const rows = await this.paged<Record<string, unknown>>(`/users/${encodeURIComponent(org)}/repos`, {}, locale)
    return rows.map(toRepoInfo).filter(r => r.fullName !== '')
  }

  /** Repository metadata (owner, default branch, private, empty). */
  async getRepo(org: string, repo: string, locale = 'en'): Promise<RepoInfo> {
    const r = await this.json<Record<string, unknown>>(
      'GET',
      `/repos/${seg(org)}/${seg(repo)}`,
      { locale },
    )
    return toRepoInfo(r)
  }

  /** Resolve a ref to a concrete branch/sha: an empty ref = the default branch. */
  async resolveRef(org: string, repo: string, ref: string, locale = 'en'): Promise<string> {
    if (ref !== '') return ref
    const info = await this.getRepo(org, repo, locale)
    return info.defaultBranch
  }

  /** Search repos (optionally restricted to an owner). */
  async searchRepos(opts: { owner?: string; keyword?: string; locale?: string } = {}): Promise<RepoInfo[]> {
    const locale = opts.locale ?? 'en'
    const rows = await this.paged<Record<string, unknown>>('/repos/search', {
      ...(opts.keyword !== undefined && opts.keyword !== '' ? { q: opts.keyword } : {}),
    }, locale)
    let repos = rows.map(toRepoInfo).filter(r => r.fullName !== '')
    if (opts.owner !== undefined && opts.owner !== '') {
      repos = repos.filter(r => r.owner === opts.owner)
    }
    return repos
  }

  /** Branches of a repo. */
  async listBranches(org: string, repo: string, locale = 'en'): Promise<RefInfo[]> {
    const rows = await this.paged<Record<string, unknown>>(
      `/repos/${seg(org)}/${seg(repo)}/branches`, {}, locale,
    )
    return rows.map(b => ({
      name: String(b['name'] ?? ''),
      sha: String((b['commit'] as Record<string, unknown> | undefined)?.['id'] ?? ''),
    })).filter(b => b.name !== '')
  }

  /** Tags of a repo. */
  async listTags(org: string, repo: string, locale = 'en'): Promise<RefInfo[]> {
    const rows = await this.paged<Record<string, unknown>>(
      `/repos/${seg(org)}/${seg(repo)}/tags`, {}, locale,
    )
    return rows.map(t => ({
      name: String(t['name'] ?? ''),
      sha: String((t['commit'] as Record<string, unknown> | undefined)?.['id'] ?? t['id'] ?? ''),
    })).filter(t => t.name !== '')
  }

  // ---- contents ----

  /**
   * Read a file (returns UTF-8 text + blob sha) or list a directory.
   * `ref` empty = the repository default branch.
   */
  async getContents(
    org: string,
    repo: string,
    path: string,
    ref: string,
    locale = 'en',
  ): Promise<
    | { kind: 'file'; text: string; sha: string; size: number }
    | { kind: 'dir'; entries: ContentEntry[] }
  > {
    const data = await this.json<Record<string, unknown> | Array<Record<string, unknown>>>(
      'GET',
      `/repos/${seg(org)}/${seg(repo)}/contents/${encPath(path)}`,
      { query: { ref }, locale },
    )
    if (Array.isArray(data)) {
      return { kind: 'dir', entries: data.map(toContentEntry) }
    }
    if (String(data['type'] ?? '') === 'dir') {
      // A dir with no children can come back as a single object; normalize.
      return { kind: 'dir', entries: [] }
    }
    const encoding = String(data['encoding'] ?? '')
    const raw = String(data['content'] ?? '')
    const text = encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw
    return {
      kind: 'file',
      text,
      sha: String(data['sha'] ?? ''),
      size: Number(data['size'] ?? text.length),
    }
  }

  /** Raw file bytes (no base64 hop). */
  async getRaw(org: string, repo: string, path: string, ref: string, locale = 'en'): Promise<Uint8Array> {
    return this.bytes(`/repos/${seg(org)}/${seg(repo)}/raw/${encPath(path)}?ref=${encodeURIComponent(ref)}`, locale)
  }

  /**
   * Create or update ONE file (one commit). `sha` is the base blob sha for
   * optimistic locking on update (omit to create).
   *
   * Implemented via the ChangeFiles endpoint (`POST /contents`): the older
   * `PUT /contents/{path}` requires a SHA for updates and rejects creates
   * without one on some Forgejo builds, whereas ChangeFiles takes an explicit
   * operation and behaves consistently.
   */
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

  /** Delete ONE file (one commit). `sha` locks the version being deleted. */
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

  /**
   * Commit SEVERAL files atomically (one commit) via ChangeFilesOptions.
   * Each file is create/update/delete.
   */
  async commitFiles(
    org: string,
    repo: string,
    files: CommitFile[],
    message: string,
    opts: { ref?: string; newBranch?: string; locale?: string } = {},
  ): Promise<CommitResult> {
    const ops = files.map(f => {
      const op = f.operation ?? 'update'
      const body: Record<string, unknown> = {
        operation: op,
        path: f.path,
      }
      if (op !== 'delete') {
        body['content'] = Buffer.from(f.content ?? '', 'utf8').toString('base64')
      }
      if (f.sha !== undefined && f.sha !== '') body['sha'] = f.sha
      if (f.fromPath !== undefined && f.fromPath !== '') body['from_path'] = f.fromPath
      return body
    })
    const body: Record<string, unknown> = { message, files: ops }
    if (opts.ref !== undefined && opts.ref !== '') body['branch'] = opts.ref
    if (opts.newBranch !== undefined && opts.newBranch !== '') body['new_branch'] = opts.newBranch
    const res = await this.json<Record<string, unknown>>(
      'POST',
      `/repos/${seg(org)}/${seg(repo)}/contents`,
      { body, locale: opts.locale },
    )
    return { sha: commitShaOf(res), message: String(res['message'] ?? '') }
  }

  /** The tree at a ref/sha (recursive). */
  async getTree(
    org: string,
    repo: string,
    ref: string,
    locale = 'en',
  ): Promise<{ sha: string; entries: ContentEntry[]; truncated: boolean }> {
    const data = await this.json<Record<string, unknown>>(
      'GET',
      `/repos/${seg(org)}/${seg(repo)}/git/trees/${encodeURIComponent(ref)}`,
      { query: { recursive: true }, locale },
    )
    const tree = Array.isArray(data['tree']) ? (data['tree'] as Array<Record<string, unknown>>) : []
    return {
      sha: String(data['sha'] ?? ''),
      truncated: Boolean(data['truncated'] ?? false),
      entries: tree.map(t => ({
        path: String(t['path'] ?? ''),
        name: String(t['path'] ?? '').split('/').pop() ?? '',
        type: (String(t['type'] ?? 'blob') === 'tree' ? 'dir' : 'file') as ContentEntry['type'],
        size: Number(t['size'] ?? 0),
        sha: String(t['sha'] ?? ''),
      })),
    }
  }

  // ---- history ----

  async listCommits(
    org: string,
    repo: string,
    opts: { ref?: string; path?: string; limit?: number; locale?: string } = {},
  ): Promise<CommitInfo[]> {
    const rows = await this.json<Array<Record<string, unknown>>>(
      'GET',
      `/repos/${seg(org)}/${seg(repo)}/commits`,
      {
        query: {
          sha: opts.ref,
          path: opts.path,
          limit: opts.limit ?? 50,
        },
        locale: opts.locale,
      },
    )
    return (rows ?? []).map(toCommitInfo)
  }

  async getCommit(org: string, repo: string, sha: string, locale = 'en'): Promise<CommitInfo> {
    const c = await this.json<Record<string, unknown>>(
      'GET',
      `/repos/${seg(org)}/${seg(repo)}/git/commits/${encodeURIComponent(sha)}`,
      { locale },
    )
    return toCommitInfo(c)
  }

  /** Unified diff text for a commit (Forgejo `.diff`). */
  async commitDiff(org: string, repo: string, sha: string, locale = 'en'): Promise<string> {
    const res = await this.fetchImpl(
      `${this.base}/api/v1/repos/${seg(org)}/${seg(repo)}/git/commits/${encodeURIComponent(sha)}.diff`,
      { headers: this.headers({ Accept: 'text/plain' }) },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw httpError(res.status, text, locale)
    }
    return res.text()
  }

  /** Compare two refs (`base...head`), returning per-file patches. */
  async compare(
    org: string,
    repo: string,
    base: string,
    head: string,
    locale = 'en',
  ): Promise<{ files: Array<{ path: string; status: string; additions: number; deletions: number; patch: string }> }> {
    const data = await this.json<Record<string, unknown>>(
      'GET',
      `/repos/${seg(org)}/${seg(repo)}/compare/${encodeURIComponent(`${base}...${head}`)}`,
      { locale },
    )
    const files = Array.isArray(data['files']) ? (data['files'] as Array<Record<string, unknown>>) : []
    return {
      files: files.map(f => ({
        path: String(f['filename'] ?? ''),
        status: String(f['status'] ?? ''),
        additions: Number(f['additions'] ?? 0),
        deletions: Number(f['deletions'] ?? 0),
        patch: String(f['patch'] ?? ''),
      })),
    }
  }

  // ---- refs ----

  async createBranch(org: string, repo: string, name: string, from: string, locale = 'en'): Promise<void> {
    await this.json('POST', `/repos/${seg(org)}/${seg(repo)}/branches`, {
      body: { new_branch_name: name, old_ref_name: from },
      locale,
    })
  }

  async deleteBranch(org: string, repo: string, name: string, locale = 'en'): Promise<void> {
    // A missing ref is a no-op (Forgejo answers 500 + "object does not exist").
    try {
      await this.json('DELETE', `/repos/${seg(org)}/${seg(repo)}/branches/${seg(name)}`, { locale })
    } catch (e) {
      const msg = e instanceof Error ? e.message.toLowerCase() : ''
      if (!msg.includes('not found') && !msg.includes('does not exist')) throw e
    }
  }

  async setDefaultBranch(org: string, repo: string, branch: string, locale = 'en'): Promise<void> {
    await this.json('PATCH', `/repos/${seg(org)}/${seg(repo)}`, {
      body: { default_branch: branch },
      locale,
    })
  }

  /**
   * Migrate (import) an EXTERNAL git repository into `owner` as `repo`. Forgejo
   * clones the FULL repository (all branches + history). `ref` is NOT a migrate
   * parameter: when the caller wants a single branch the tool trims the others
   * after the import (see `repoImport`).
   */
  async migrateRepo(
    owner: string,
    opts: {
      repo: string
      cloneAddr: string
      private?: boolean
      mirror?: boolean
      description?: string
      authToken?: string
      authUser?: string
      locale?: string
    },
  ): Promise<RepoInfo> {
    const body: Record<string, unknown> = {
      clone_addr: opts.cloneAddr,
      repo_name: opts.repo,
      service: 'git',
    }
    if (owner !== '') body['repo_owner'] = owner
    if (opts.private !== undefined) body['private'] = opts.private
    if (opts.mirror !== undefined) body['mirror'] = opts.mirror
    if (opts.description !== undefined && opts.description !== '') body['description'] = opts.description
    if (opts.authToken !== undefined && opts.authToken !== '') body['auth_token'] = opts.authToken
    if (opts.authUser !== undefined && opts.authUser !== '') body['auth_username'] = opts.authUser
    const res = await this.json<Record<string, unknown>>('POST', '/repos/migrate', {
      body,
      locale: opts.locale,
    })
    return toRepoInfo(res)
  }

  async createTag(org: string, repo: string, name: string, target: string, locale = 'en'): Promise<void> {
    await this.json('POST', `/repos/${seg(org)}/${seg(repo)}/tags`, {
      body: { tag_name: name, target },
      locale,
    })
  }

  // ---- pull requests ----

  async createPull(
    org: string,
    repo: string,
    opts: { title: string; head: string; base: string; body?: string; locale?: string },
  ): Promise<{ index: number; url: string }> {
    const res = await this.json<Record<string, unknown>>(
      'POST',
      `/repos/${seg(org)}/${seg(repo)}/pulls`,
      {
        body: {
          title: opts.title,
          head: opts.head,
          base: opts.base,
          ...(opts.body !== undefined ? { body: opts.body } : {}),
        },
        locale: opts.locale,
      },
    )
    return { index: Number(res['number'] ?? 0), url: String(res['html_url'] ?? '') }
  }

  async listPulls(
    org: string,
    repo: string,
    state: string,
    locale = 'en',
  ): Promise<Array<{ index: number; title: string; state: string; head: string; base: string }>> {
    const rows = await this.paged<Record<string, unknown>>(
      `/repos/${seg(org)}/${seg(repo)}/pulls`,
      state !== '' ? { state } : {},
      locale,
    )
    return rows.map(p => ({
      index: Number(p['number'] ?? 0),
      title: String(p['title'] ?? ''),
      state: String(p['state'] ?? ''),
      head: String((p['head'] as Record<string, unknown> | undefined)?.['ref'] ?? ''),
      base: String((p['base'] as Record<string, unknown> | undefined)?.['ref'] ?? ''),
    }))
  }

  async createComment(org: string, repo: string, index: number, body: string, locale = 'en'): Promise<void> {
    await this.json('POST', `/repos/${seg(org)}/${seg(repo)}/issues/${index}/comments`, {
      body: { body },
      locale,
    })
  }

  async mergePull(org: string, repo: string, index: number, locale = 'en'): Promise<void> {
    await this.json('POST', `/repos/${seg(org)}/${seg(repo)}/pulls/${index}/merge`, { body: {}, locale })
  }

  // ---- archive (checkout) ----

  /** Download a repo tree as a tar.gz archive at `ref`. */
  async archiveTarGz(org: string, repo: string, ref: string, locale = 'en'): Promise<Uint8Array> {
    return this.bytes(
      `/repos/${seg(org)}/${seg(repo)}/archive/${encodeURIComponent(`${ref}.tar.gz`)}`,
      locale,
    )
  }
}

// ---- helpers ----

function seg(s: string): string {
  return encodeURIComponent(s)
}

/** Encode each path segment, keeping `/` separators. */
function encPath(p: string): string {
  return p
    .split('/')
    .map(s => encodeURIComponent(s))
    .join('/')
}

function toRepoInfo(r: Record<string, unknown>): RepoInfo {
  const owner = String((r['owner'] as Record<string, unknown> | undefined)?.['login'] ?? '')
  const name = String(r['name'] ?? '')
  return {
    fullName: String(r['full_name'] ?? (owner !== '' ? `${owner}/${name}` : name)),
    owner,
    name,
    defaultBranch: String(r['default_branch'] ?? ''),
    private: Boolean(r['private'] ?? false),
    empty: Boolean(r['empty'] ?? false),
  }
}

function toContentEntry(c: Record<string, unknown>): ContentEntry {
  const type = String(c['type'] ?? 'file')
  return {
    path: String(c['path'] ?? c['name'] ?? ''),
    name: String(c['name'] ?? ''),
    type: (type === 'dir' || type === 'symlink' || type === 'submodule' ? type : 'file') as ContentEntry['type'],
    size: Number(c['size'] ?? 0),
    sha: String(c['sha'] ?? ''),
  }
}

function toCommitInfo(c: Record<string, unknown>): CommitInfo {
  const commit = (c['commit'] as Record<string, unknown> | undefined) ?? c
  const authorObj = (commit['author'] as Record<string, unknown> | undefined) ?? {}
  const parents = Array.isArray(c['parents'])
    ? (c['parents'] as Array<Record<string, unknown>>).map(p => String(p['sha'] ?? ''))
    : []
  return {
    sha: String(c['sha'] ?? ''),
    message: String(commit['message'] ?? '').trim(),
    author: String(authorObj['name'] ?? authorObj['email'] ?? ''),
    date: String(authorObj['date'] ?? ''),
    parents,
  }
}

function commitShaOf(res: unknown): string {
  // `PUT/DELETE /contents` -> { commit: { sha } }; ChangeFiles (`POST
  // /contents`) -> { files: [{ last_commit_sha }] } (or a bare array).
  const obj = res as Record<string, unknown> | undefined
  if (obj !== undefined && obj !== null) {
    const commit = obj['commit'] as Record<string, unknown> | undefined
    if (commit !== undefined && typeof commit['sha'] === 'string') return commit['sha']
    if (typeof obj['sha'] === 'string') return obj['sha']
    const files = obj['files']
    if (Array.isArray(files) && files.length > 0) {
      const last = (files[files.length - 1] as Record<string, unknown>)['last_commit_sha']
      if (typeof last === 'string') return last
    }
  }
  if (Array.isArray(res) && res.length > 0) {
    const last = (res[res.length - 1] as Record<string, unknown>)['last_commit_sha']
    if (typeof last === 'string') return last
  }
  return ''
}
