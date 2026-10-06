/**
 * What a phase changed, as the node view shows it (§10): the files, how many
 * lines each one gained and lost, and the patch itself.
 *
 * This is the git unit's answer to a question the API used to decline. The
 * node endpoint served a *reference* — branch, base, lane — and left the diff
 * to the operator's own terminal, on the reasoning that running git belongs
 * here and not in the HTTP layer. That reasoning still holds, which is why the
 * API calls this rather than shelling out itself: nothing in `api.ts` knows how
 * a phase branch is named or where a lane lives. It hands over the branch, the
 * base and the lane's path, and gets back a description.
 *
 * Two sources, chosen per call:
 *
 * - **The lane's working tree**, when the lane still has this branch checked
 *   out. An agent mid-phase has edited files it has not committed — most
 *   commit once, at the end — and a diff of the branch alone would show an
 *   operator nothing while the agent is doing the thing they opened the page
 *   to watch. The working tree is compared against the merge base, so what is
 *   shown is exactly what the phase has done so far, committed or not, and
 *   files the tree does not track yet are listed beside it.
 * - **The branch**, otherwise: `base...branch`, from the main checkout, which
 *   sees every worktree's refs. This is what a finished phase reads as once
 *   its lane has been recycled for the next one, and it is what the operator
 *   would get from the command the old panel printed.
 *
 * The patch is bounded. A phase that rewrote a lockfile produces megabytes,
 * and the browser has no use for more than it can render; past the limit the
 * patch is cut at a file boundary and says so, and the per-file counts — which
 * come from `--numstat`, not from the patch — stay complete.
 *
 * §11: everything here is repository content, and it is *served*, which is the
 * product. Nothing in this module logs, and no error it throws carries a path
 * or a line of the diff — `GitCommandError` names a subcommand and an exit code.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { git, GitCommandError } from './git.ts'

const exec = promisify(execFile)

/** How a file changed. `untracked` is a working-tree-only state: new, and not yet added. */
export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'unmerged'
  | 'untracked'
  | 'unknown'

export interface ChangedFile {
  /** The path as it is now; for a deletion, the path that was removed. */
  readonly path: string
  /** Where a renamed or copied file came from. */
  readonly oldPath: string | null
  readonly status: ChangeStatus
  /** Null for a binary file, which has no line count. */
  readonly additions: number | null
  readonly deletions: number | null
  readonly binary: boolean
}

export interface Changes {
  /** Where the description was read from. `none` is a branch git could not find. */
  readonly source: 'worktree' | 'branch' | 'none'
  readonly files: readonly ChangedFile[]
  readonly totals: {
    readonly files: number
    readonly additions: number
    readonly deletions: number
  }
  /** The unified diff, when asked for; null when not. */
  readonly patch: string | null
  /** True when the patch was cut to fit the limit. The counts above are not. */
  readonly truncated: boolean
}

export interface DescribeChangesOptions {
  /** The main checkout. Every lane is a worktree of it, so its refs are all here. */
  readonly repo: string
  readonly branch: string
  readonly baseBranch: string
  /** The lane's worktree, or null for a node that has none. Used only if it holds `branch`. */
  readonly lanePath: string | null
  /** Whether to read the patch at all. The summary card does not; the diff view does. */
  readonly patch?: boolean
  /** Bytes of patch to serve before cutting at a file boundary. */
  readonly patchLimitBytes?: number
}

/** Two megabytes of diff is more than a browser renders well; past that it says so. */
export const DEFAULT_PATCH_LIMIT = 2 * 1024 * 1024

/** What git may hand back before this module cuts it: well past the limit, never unbounded. */
const GIT_OUTPUT_BUFFER = 64 * 1024 * 1024

/** Untracked files are diffed one spawn each; past this many the rest are listed, not diffed. */
const UNTRACKED_PATCH_LIMIT = 40

const EMPTY: Changes = {
  source: 'none',
  files: [],
  totals: { files: 0, additions: 0, deletions: 0 },
  patch: null,
  truncated: false,
}

export async function describeChanges(options: DescribeChangesOptions): Promise<Changes> {
  const { repo, branch, baseBranch } = options
  const wantPatch = options.patch ?? false
  const limit = options.patchLimitBytes ?? DEFAULT_PATCH_LIMIT

  let mergeBase: string
  try {
    mergeBase = (await git(repo, ['merge-base', baseBranch, branch])).trim()
  } catch (error) {
    // A branch the run never cut, or one that has since been deleted, is a
    // real answer rather than a failure: there is nothing to describe.
    if (error instanceof GitCommandError) return EMPTY
    throw error
  }

  const lane = options.lanePath
  const inLane = lane !== null && (await holdsBranch(lane, branch))
  // In the lane the working tree is one side of the diff, so the range is a
  // single commit. From the main checkout both sides are refs.
  const cwd = inLane ? lane : repo
  const range = inLane ? [mergeBase] : [mergeBase, branch]

  const [numstat, names] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-M', '-z', ...range], { maxBuffer: GIT_OUTPUT_BUFFER }),
    git(cwd, ['diff', '--name-status', '-M', '-z', ...range], { maxBuffer: GIT_OUTPUT_BUFFER }),
  ])
  const files = [...merge(parseNumstat(numstat), parseNameStatus(names))]

  let patch = wantPatch
    ? await git(cwd, ['diff', '-M', '--no-color', '--no-ext-diff', ...range], {
        maxBuffer: GIT_OUTPUT_BUFFER,
      })
    : ''

  if (inLane) {
    const untracked = await gitList(lane, ['ls-files', '--others', '--exclude-standard', '-z'])
    for (const [index, path] of untracked.entries()) {
      // Each untracked file is its own spawn, so only so many are diffed; the
      // rest are still listed, with no counts, which is the honest reading.
      const described = index < UNTRACKED_PATCH_LIMIT ? await untrackedFile(lane, path) : null
      files.push(
        described?.file ?? {
          path,
          oldPath: null,
          status: 'untracked',
          additions: null,
          deletions: null,
          binary: false,
        },
      )
      if (wantPatch && described !== null) patch += described.patch
    }
  }

  const cut = wantPatch ? bound(patch, limit) : { text: null, truncated: false }
  return {
    source: inLane ? 'worktree' : 'branch',
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
    patch: cut.text,
    truncated: cut.truncated,
  }
}

/** Whether the worktree at `path` exists and has `branch` checked out. */
async function holdsBranch(path: string, branch: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    const head = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return head === branch
  } catch {
    return false
  }
}

/** NUL-delimited output as a list, the trailing empty record dropped. */
async function gitList(cwd: string, args: readonly string[]): Promise<string[]> {
  const out = await git(cwd, args, { maxBuffer: GIT_OUTPUT_BUFFER })
  return out.split('\0').filter((entry) => entry.length > 0)
}

interface Counts {
  readonly additions: number | null
  readonly deletions: number | null
}

/**
 * `--numstat -z`: `<added>\t<deleted>\t<path>\0` per file, and for a rename
 * `<added>\t<deleted>\t\0<old>\0<new>\0`. A binary file counts as `-\t-`.
 */
export function parseNumstat(raw: string): Map<string, Counts> {
  const counts = new Map<string, Counts>()
  const records = raw.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    if (record === '') continue
    const [added = '', deleted = '', inline = ''] = record.split('\t')
    let path = inline
    if (path === '') {
      // A rename: the two paths follow as their own records.
      index += 2
      path = records[index] ?? ''
    }
    counts.set(path, {
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    })
  }
  return counts
}

interface Named {
  readonly path: string
  readonly oldPath: string | null
  readonly status: ChangeStatus
}

/**
 * `--name-status -z`: `<letter>\0<path>\0` per file, with renames and copies
 * (`R100`, `C75`) carrying two paths. The letters are git's own.
 */
export function parseNameStatus(raw: string): Named[] {
  const named: Named[] = []
  const records = raw.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index] ?? ''
    if (code === '') continue
    const letter = code[0] ?? ''
    if (letter === 'R' || letter === 'C') {
      const oldPath = records[index + 1] ?? ''
      const path = records[index + 2] ?? ''
      index += 2
      named.push({ path, oldPath, status: letter === 'R' ? 'renamed' : 'copied' })
      continue
    }
    const path = records[index + 1] ?? ''
    index += 1
    named.push({ path, oldPath: null, status: STATUS_LETTERS[letter] ?? 'unknown' })
  }
  return named
}

const STATUS_LETTERS: Readonly<Record<string, ChangeStatus>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type_changed',
  U: 'unmerged',
}

/** One row per named file, with its counts. A file git named but did not count is binary-shaped. */
function* merge(counts: Map<string, Counts>, named: readonly Named[]): Generator<ChangedFile> {
  for (const entry of named) {
    const count = counts.get(entry.path) ?? { additions: null, deletions: null }
    yield {
      ...entry,
      additions: count.additions,
      deletions: count.deletions,
      binary: count.additions === null && count.deletions === null,
    }
  }
}

/**
 * An untracked file, diffed against nothing.
 *
 * `--no-index` exits 1 when the two sides differ, which for a file against
 * `/dev/null` is always, so the exit code is read rather than thrown on. The
 * added count is read off the patch itself — one spawn, not two.
 */
async function untrackedFile(
  lane: string,
  path: string,
): Promise<{ file: ChangedFile; patch: string } | null> {
  let stdout: string
  try {
    const result = await exec(
      'git',
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', path],
      { cwd: lane, maxBuffer: GIT_OUTPUT_BUFFER },
    )
    stdout = result.stdout
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown }
    if (failed.code !== 1 || typeof failed.stdout !== 'string') return null
    stdout = failed.stdout
  }
  const binary = /^Binary files /m.test(stdout)
  const additions = binary
    ? null
    : stdout.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  return {
    file: { path, oldPath: null, status: 'untracked', additions, deletions: binary ? null : 0, binary },
    patch: stdout,
  }
}

/**
 * The patch within `limit` bytes, cut at the last file header that fits — a
 * half-rendered hunk reads as a parser bug, a missing file reads as a cut.
 */
function bound(patch: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(patch, 'utf8') <= limit) return { text: patch, truncated: false }
  const within = Buffer.from(patch, 'utf8').subarray(0, limit).toString('utf8')
  const boundary = within.lastIndexOf('\ndiff --git ')
  return { text: boundary > 0 ? within.slice(0, boundary + 1) : within, truncated: true }
}
