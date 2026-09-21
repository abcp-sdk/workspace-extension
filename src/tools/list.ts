import { normalizeRel } from './text.js'
/** A minimal directory entry (structurally matches worker.v1.FileEntry). */
export interface DirEntry {
  path: string
  size: number
  isDir: boolean
}

/** List a workspace path: dir → its children, file → a single entry. */
export type ListDir = (
  path: string,
) => Promise<{ isDir: boolean; entries: DirEntry[] }>

export interface TreeRow {
  /** Display path relative to the walk root. */
  path: string
  /** 1 for an immediate child of the root. */
  depth: number
  size: number
  isDir: boolean
  /** A directory that reached the depth cap and was NOT expanded. */
  atMaxDepth: boolean
}

/** A directory that was expanded but had children dropped by the row limit. */
export interface Omission {
  path: string
  count: number
}

export interface TreeWalk {
  rows: TreeRow[]
  omissions: Omission[]
  /** True when the row limit stopped the walk. */
  limitHit: boolean
}

export interface WalkOpts {
  /** Workspace-relative root being listed ('' = workspace root). */
  root: string
  /** Levels to show below the root (default 3). */
  depth: number
  /** Maximum number of rows to emit. */
  limit: number
}

/**
 * BFS/level-order walk with a global row budget.
 *
 * - Level 1 is emitted entirely before any of level 2, level 2 before level 3.
 * - A level that does not fit is emitted up to `limit`; deeper levels are then
 *   never listed, and directories at that level stay unexpanded.
 * - Every directory that WAS expanded but whose children were (partly) dropped
 *   by the limit is reported in `omissions`.
 */
export async function walkTree(
  listDir: ListDir,
  opts: WalkOpts,
): Promise<TreeWalk> {
  const root = normalizeRel(opts.root)
  const maxDepth = Math.max(1, Math.floor(opts.depth))
  const limit = Math.max(1, Math.floor(opts.limit))

  const rootRes = await listDir(root === '' ? '.' : root)
  if (!rootRes.isDir) {
    return {
      rows: rootRes.entries.slice(0, limit).map(e => ({
        path: normalizeRel(e.path),
        depth: 1,
        size: e.size,
        isDir: false,
        atMaxDepth: true,
      })),
      omissions:
        rootRes.entries.length > limit
          ? [{ path: root || '.', count: rootRes.entries.length - limit }]
          : [],
      limitHit: rootRes.entries.length > limit,
    }
  }

  const rows: TreeRow[] = []
  const omissions: Omission[] = []
  // Directories at `depth` whose children have not been listed yet. The root
  // (depth 0) is the first frontier; its children become level-1 rows.
  let frontier: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ]
  let remaining = limit

  while (frontier.length > 0 && remaining > 0) {
    const level = frontier[0]!.depth + 1
    // List every frontier directory once (this IS the expansion step).
    const listed: Array<{ dir: string; entries: DirEntry[] }> = []
    for (const dir of frontier) {
      try {
        const res = await listDir(dir.path === '' ? '.' : dir.path)
        if (res.isDir) listed.push({ dir: dir.path, entries: res.entries })
      } catch {
        // Unlistable directory: omit its subtree silently.
      }
    }

    const levelDirs: Array<{ path: string; depth: number }> = []
    for (const { dir, entries } of listed) {
      let emittedHere = 0
      for (const e of entries) {
        if (remaining <= 0) break
        rows.push({
          path: normalizeRel(e.path),
          depth: level,
          size: e.size,
          isDir: e.isDir,
          atMaxDepth: level >= maxDepth,
        })
        remaining--
        emittedHere++
      }
      if (emittedHere < entries.length) {
        omissions.push({ path: dir || '.', count: entries.length - emittedHere })
      }
      if (level < maxDepth) {
        for (const e of entries) {
          if (e.isDir) {
            levelDirs.push({ path: normalizeRel(e.path), depth: level })
          }
        }
      }
    }

    if (remaining <= 0) {
      return { rows, omissions, limitHit: true }
    }
    // Only descend when the whole level fit (deeper levels are lower priority).
    frontier = level < maxDepth ? levelDirs : []
  }

  return { rows, omissions, limitHit: false }
}
