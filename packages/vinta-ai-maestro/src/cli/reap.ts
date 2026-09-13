/**
 * What a failed run leaves on disk that nothing else removes.
 *
 * `purge` deletes run state under `.vinta-ai-maestro/runs/`. A run's *lanes* are
 * not there: they are git worktrees under `lanes/`, with summaries beside them,
 * and they outlive every purge. Three failed attempts at one plan leave twelve
 * worktrees and twelve summaries, every one of which `doctor` then reports.
 *
 * Worse than noise: lane directories are named per **run** and phase branches
 * per **workflow**, so a dead run's worktree keeps holding `plan/<id>/phase-p0`
 * and the next run of the same plan cannot cut it. A failed attempt makes the
 * retry impossible until someone clears it by hand.
 *
 * **One rule, applied to both kinds of destruction: never delete the only copy
 * of work.** A phase can leave work in two places — committed on its branch, or
 * uncommitted in its worktree — and both count. So a branch carrying commits no
 * other branch has is kept, and a lane with a dirty tree is kept, and each is
 * reported with the command to remove it by hand.
 *
 * An earlier version had this half-right: it guarded branches carefully and
 * then removed every worktree with `--force`, silently discarding exactly the
 * uncommitted work the branch guard existed to protect. Guarding one and not
 * the other is worse than guarding neither, because it reads as safe.
 *
 * A cleanup command that occasionally eats work is one nobody can afford to run
 * quickly, and running it quickly — between failed attempts, without reading the
 * list every time — is the entire point.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface Lane {
  /** The lane's directory, as git knows it. */
  readonly path: string
  /** The branch it holds checked out, if any. */
  readonly branch: string | null
  /** Uncommitted changes, including untracked files. Unknown reads as dirty. */
  readonly dirty: boolean
}

export interface Reapable {
  /** Lanes safe to remove: nothing uncommitted in them. */
  readonly lanes: readonly Lane[]
  /** Lanes kept because their worktree holds uncommitted work. */
  readonly dirtyLanes: readonly Lane[]
  /** Summary files (`<name>.yaml` and any sidecars) belonging to `lanes`. */
  readonly summaries: readonly string[]
  /** Phase branches safe to delete: every commit on them is reachable elsewhere. */
  readonly emptyBranches: readonly string[]
  /** Phase branches kept because they carry commits no other branch has. */
  readonly carryingBranches: readonly string[]
}

const git = async (repoPath: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', [...args], { cwd: repoPath })
  return stdout
}

/**
 * Every worktree git knows about, with the branch each holds.
 *
 * `--porcelain` is stanzas of `key value` lines separated by blank lines, each
 * opening with `worktree <path>`. Parsed rather than `--list`ed because the
 * human format aligns columns and truncates.
 */
export async function worktrees(repoPath: string): Promise<readonly Lane[]> {
  let output: string
  try {
    output = await git(repoPath, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }

  const found: { path: string; branch: string | null }[] = []
  let path: string | null = null
  let branch: string | null = null
  const flush = (): void => {
    if (path !== null) found.push({ path, branch })
    path = null
    branch = null
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  flush()

  // Asked per worktree rather than inferred from the main checkout's status:
  // each lane is its own working tree with its own index, and the main
  // checkout's cleanliness says nothing about any of them.
  return await Promise.all(
    found.map(async (lane) => ({ ...lane, dirty: await isDirty(lane.path) })),
  )
}

/**
 * Whether a worktree holds uncommitted work, untracked files included.
 *
 * An untracked file counts. A phase that wrote three new modules and never
 * committed them has produced exactly the work this command must not throw
 * away, and `--porcelain` without `-uall` would call that tree clean.
 *
 * A tree that cannot be asked reads as dirty. The question is "is it safe to
 * delete this", and an unanswerable question is not a yes.
 */
async function isDirty(path: string): Promise<boolean> {
  try {
    const output = await git(path, ['status', '--porcelain', '-uall'])
    return output.trim() !== ''
  } catch {
    return true
  }
}

/**
 * What belongs to a run, or to every run, under this store.
 *
 * A lane is identified by its directory sitting under `laneRoot` — not by its
 * name matching a pattern. The names encode a run id, but a name is a
 * convention and a path is a fact, and this deletes things.
 */
export async function findReapable(options: {
  readonly repoPath: string
  readonly laneRoot: string
  readonly summaryDir: string
  /** Restricts to one run's lanes. Absent means every lane under `laneRoot`. */
  readonly runId?: string
  /** Whether to consider branches at all. */
  readonly includeBranches: boolean
}): Promise<Reapable> {
  const { repoPath, laneRoot, summaryDir, runId } = options

  // Both sides resolved before comparing. `git worktree list` reports real
  // paths, and a store under a symlinked directory — `/var/folders/…` on macOS,
  // which is really `/private/var/folders/…`, and any repository someone keeps
  // behind a symlink — otherwise matches nothing. The failure mode is the worst
  // available for this command: it finds no lanes, deletes nothing, and says so
  // cheerfully.
  const root = realpath(laneRoot)
  const all = await worktrees(repoPath)
  const mine = all.filter((lane) => {
    if (!isUnder(realpath(lane.path), root)) return false
    return runId === undefined || basename(lane.path).startsWith(`${runId}-`)
  })

  const lanes = mine.filter((lane) => !lane.dirty)
  const dirtyLanes = mine.filter((lane) => lane.dirty)

  // Only the clean lanes' summaries. A kept lane keeps its summary: the file
  // is how the pool knows what that worktree is, and orphaning it would leave
  // a directory nothing can reset or tear down.
  const names = new Set(lanes.map((lane) => basename(lane.path)))
  const summaries = (await entriesOf(summaryDir))
    .filter((entry) => names.has(entry.replace(/\.(yaml|docker-compose\.override\.yml)$/, '')))
    .map((entry) => join(summaryDir, entry))

  if (!options.includeBranches) {
    return { lanes, dirtyLanes, summaries, emptyBranches: [], carryingBranches: [] }
  }

  // Only branches held by lanes that are actually going. A branch whose
  // worktree is being kept cannot be deleted anyway — git refuses while it is
  // checked out — so offering it would be a promise this cannot keep.
  const candidates = [...new Set(lanes.map((lane) => lane.branch).filter(isPhaseBranch))]
  const carrying = await Promise.all(candidates.map((branch) => carriesCommits(repoPath, branch)))

  return {
    lanes,
    dirtyLanes,
    summaries,
    emptyBranches: candidates.filter((_, i) => carrying[i] === false),
    carryingBranches: candidates.filter((_, i) => carrying[i] !== false),
  }
}

/**
 * Removes the worktrees, then the branches the caller approved.
 *
 * Worktrees first, and that order is required rather than tidy: git refuses to
 * delete a branch that a worktree still has checked out, so branch deletion
 * after removal is the only sequence that works.
 *
 * Each step is attempted independently. One worktree that will not go — a file
 * still held open, which Windows does routinely — must not strand the other
 * eleven.
 */
export async function reap(
  repoPath: string,
  target: Reapable,
  options: { readonly branches: boolean },
): Promise<readonly string[]> {
  const failures: string[] = []

  for (const lane of target.lanes) {
    try {
      await git(repoPath, ['worktree', 'remove', '--force', lane.path])
    } catch {
      failures.push(`worktree ${lane.path}`)
    }
  }
  // A removal that half-succeeded leaves the worktree registered, and git then
  // refuses to delete the branch it believes is still checked out.
  try {
    await git(repoPath, ['worktree', 'prune'])
  } catch {
    // Nothing to report: the removals above already said what did not go.
  }

  if (options.branches) {
    for (const branch of target.emptyBranches) {
      try {
        // `-d`, never `-D`. Emptiness is checked before offering, and this is
        // the second check: if git disagrees, the branch stays.
        await git(repoPath, ['branch', '-d', branch])
      } catch {
        failures.push(`branch ${branch}`)
      }
    }
  }

  return failures
}

/**
 * Whether a branch holds any commit no other branch does.
 *
 * The question that decides whether deleting it loses anything, and it is not
 * the same as "merged into HEAD" — which is what this used to ask. `--merged`
 * is relative to wherever the operator happens to be standing: phase branches
 * are cut from the plan's `base_branch`, so an operator sitting on an unrelated
 * feature branch would see every empty phase branch as unmerged and keep all of
 * them, and the command would tidy up nothing on the one checkout where it is
 * most often run.
 *
 * `rev-list <branch> --not --exclude=<branch> --branches` asks it directly:
 * commits reachable from this branch and from no other. Empty output means
 * every commit on it lives somewhere else too, so the ref is the only thing
 * deletion removes. It also needs no format string, unlike
 * `branch --format=%(refname:short)` — a `%` expression `cmd.exe` expands
 * before git sees it, which is the same Windows trap that broke `--format=%H`.
 *
 * An unanswerable question counts as carrying commits: the safe direction is
 * to keep the branch.
 */
async function carriesCommits(repoPath: string, branch: string): Promise<boolean> {
  try {
    const output = await git(repoPath, [
      'rev-list',
      '--max-count=1',
      branch,
      '--not',
      `--exclude=${branch}`,
      '--branches',
    ])
    return output.trim() !== ''
  } catch {
    return true
  }
}

const isPhaseBranch = (branch: string | null): branch is string =>
  branch !== null && /^plan\/[^/]+\/(phase|integ)-/.test(branch)

const basename = (path: string): string => path.split(/[/\\]/).filter(Boolean).pop() ?? path

/** Path containment by segment, so `lanes-old` is not "under" `lanes`. */
function isUnder(path: string, root: string): boolean {
  const normalize = (value: string): string[] => value.split(/[/\\]/).filter(Boolean)
  const parts = normalize(path)
  const rootParts = normalize(root)
  if (parts.length <= rootParts.length) return false
  return rootParts.every((segment, i) => parts[i] === segment)
}

/** The real path, or the path unchanged when it does not exist (yet). */
function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

async function entriesOf(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}
