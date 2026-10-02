/**
 * Minimal, dependency-free `.gitignore` matcher.
 *
 * `sandbox-submit-mr` collects the sandbox repo directory to diff it against
 * `base`. Without honoring `.gitignore` it would read EVERY file under the
 * path — including `node_modules/`, build output and other ignored trees —
 * which is both wrong (those files are not part of the change set) and slow
 * (one `fileRead` RPC per file, enough to time out on a real checkout).
 *
 * This implements the gitignore subset that matters in practice:
 *   - `#` comments and blank lines
 *   - `!pattern` negation (last matching pattern wins)
 *   - a trailing `/` restricts a pattern to DIRECTORIES (and their contents)
 *   - a leading `/` (or any embedded `/`) anchors the pattern to the
 *     `.gitignore`'s own directory; otherwise it matches at any depth
 *   - `*` (within a segment), `?`, `[...]` classes and `**`
 * Nested `.gitignore` files are honored: a deeper file's patterns are applied
 * after (and thus override) a shallower one's.
 */

/** One compiled pattern line. */
interface Pattern {
  re: RegExp
  negated: boolean
  dirOnly: boolean
}

/** A `.gitignore` file: its directory (repo-relative, '' = root) + patterns. */
interface GitignoreFile {
  dir: string
  patterns: Pattern[]
}

function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

/** Translate one glob (a gitignore pattern minus `!`/anchoring) to a regex. */
function globToRegex(pat: string): string {
  let re = ''
  let i = 0
  while (i < pat.length) {
    const c = pat[i]!
    if (c === '\\' && i + 1 < pat.length) {
      re += escapeRegexChar(pat[i + 1]!)
      i += 2
      continue
    }
    if (c === '*') {
      if (pat[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (pat[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }
    if (c === '[') {
      let j = i + 1
      if (pat[j] === '!' || pat[j] === '^') j++
      if (pat[j] === ']') j++
      while (j < pat.length && pat[j] !== ']') j++
      if (j >= pat.length) {
        re += '\\['
        i++
        continue
      }
      let cls = pat.slice(i + 1, j)
      if (cls.startsWith('!')) cls = '^' + cls.slice(1)
      re += `[${cls}]`
      i = j + 1
      continue
    }
    re += escapeRegexChar(c)
    i++
  }
  return re
}

/** Compile one non-comment, non-blank gitignore line (null when it is empty). */
function compileLine(raw: string): Pattern | null {
  let s = raw
  // An unescaped trailing space is trimmed by git; leading spaces are literal.
  while (s.endsWith(' ') && !s.endsWith('\\ ')) s = s.slice(0, -1)
  if (s === '') return null
  let negated = false
  if (s.startsWith('!')) {
    negated = true
    s = s.slice(1)
  }
  if (s === '') return null
  let dirOnly = false
  if (s.endsWith('/')) {
    dirOnly = true
    s = s.slice(0, -1)
  }
  let anchored = false
  if (s.startsWith('/')) {
    anchored = true
    s = s.slice(1)
  }
  // A slash anywhere but the (stripped) end anchors the pattern.
  if (s.includes('/')) anchored = true
  if (s === '') return null
  const body = globToRegex(s)
  const prefix = anchored ? '^' : '^(?:.*/)?'
  // A directory pattern also covers everything BELOW the matched directory.
  const suffix = dirOnly ? '(?:/.*)?$' : '$'
  return { re: new RegExp(prefix + body + suffix), negated, dirOnly }
}

/** Parse a `.gitignore` body into compiled patterns. */
export function parseGitignore(text: string, dir: string): GitignoreFile {
  const patterns: Pattern[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const p = compileLine(trimmed)
    if (p !== null) patterns.push(p)
  }
  return { dir, patterns }
}

/**
 * A set of `.gitignore` files, evaluated in git order: shallower files first,
 * deeper files after (so a nested file overrides its ancestors). The LAST
 * matching pattern across all applicable files wins.
 */
export class GitignoreSet {
  private readonly files: GitignoreFile[]

  constructor(files: GitignoreFile[]) {
    // Shallow (root '') first; then by depth so deeper dirs override.
    this.files = [...files].sort((a, b) => depth(a.dir) - depth(b.dir))
  }

  /** True when `path` (repo-relative, '/'-separated) is ignored. */
  ignores(path: string, isDir: boolean): boolean {
    let ignored = false
    for (const f of this.files) {
      const rel = relativeTo(f.dir, path)
      if (rel === null) continue // the file's dir is not an ancestor of path
      for (const p of f.patterns) {
        if (matches(p, rel, isDir)) ignored = !p.negated
      }
    }
    return ignored
  }
}

function depth(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length
}

/** `path` relative to `dir`, or null when `dir` is not an ancestor of `path`. */
function relativeTo(dir: string, path: string): string | null {
  if (dir === '') return path
  if (path === dir) return ''
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null
}

/** Does pattern `p` match `rel` (the path relative to the pattern's dir)? */
function matches(p: Pattern, rel: string, isDir: boolean): boolean {
  if (rel === '') return false
  // The path itself (dir-only patterns only match an actual directory).
  if ((!p.dirOnly || isDir) && p.re.test(rel)) return true
  // Any ancestor DIRECTORY match also ignores everything beneath it (this is
  // what makes a bare `node_modules` ignore `node_modules/**`).
  const parts = rel.split('/')
  for (let k = 1; k < parts.length; k++) {
    if (p.re.test(parts.slice(0, k).join('/'))) return true
  }
  return false
}
