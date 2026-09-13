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
 * **Two different kinds of destruction, and they are not offered together by
 * accident.** Removing a worktree discards whatever was uncommitted in it.
 * Deleting a branch discards commits. So this module finds and describes; the
 * caller confirms; and an unmerged branch is never deleted, only reported —
 * it is the only copy of whatever that phase wrote, and a cleanup command that
 * throws work away is one nobody can afford to run quickly.
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
}

export interface Reapable {
  readonly lanes: readonly Lane[]
  /** Summary files (`<name>.yaml` and any sidecars) belonging to those lanes. */
  readonly summaries: readonly string[]
  /** Phase branches safe to delete: not checked out anywhere, already merged. */
  readonly mergedBranches: readonly string[]
  /** Phase branches kept because deleting them would lose commits. */
  readonly unmergedBranches: readonly string[]
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

  const found: Lane[] = []
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
  return found
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
  const lanes = all.filter((lane) => {
    if (!isUnder(realpath(lane.path), root)) return false
    return runId === undefined || basename(lane.path).startsWith(`${runId}-`)
  })

  const names = new Set(lanes.map((lane) => basename(lane.path)))
  const summaries = (await entriesOf(summaryDir))
    .filter((entry) => names.has(entry.replace(/\.(yaml|docker-compose\.override\.yml)$/, '')))
    .map((entry) => join(summaryDir, entry))

  if (!options.includeBranches) {
    return { lanes, summaries, mergedBranches: [], unmergedBranches: [] }
  }

  // Only the branches these lanes actually hold. Deleting every
  // `plan/*/phase-*` in the repository would reach branches belonging to runs
  // this command was not asked about.
  const candidates = [...new Set(lanes.map((lane) => lane.branch).filter(isPhaseBranch))]
  const merged = new Set(await mergedBranches(repoPath))

  return {
    lanes,
    summaries,
    mergedBranches: candidates.filter((branch) => merged.has(branch)),
    unmergedBranches: candidates.filter((branch) => !merged.has(branch)),
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
    for (const branch of target.mergedBranches) {
      try {
        // `-d`, never `-D`. Merged is checked before offering, and this is the
        // second check: if git disagrees, the branch stays.
        await git(repoPath, ['branch', '-d', branch])
      } catch {
        failures.push(`branch ${branch}`)
      }
    }
  }

  return failures
}

/**
 * Branches already contained by the checkout's current HEAD.
 *
 * `branch --merged HEAD` and the plain listing, for two separate reasons.
 * `--merged` takes an optional commit, so `--merged --format=…` is read as
 * `--merged <commit>` and dies on a malformed object name — the commit has to
 * be named before any other flag. And `%(refname:short)` is a `%` expression,
 * which on Windows goes through `cmd.exe` and is expanded before git ever sees
 * it, the same way `--format=%H` was.
 *
 * So the human listing is parsed instead: one branch per line, with `*` for the
 * current branch and `+` for one checked out in another worktree — which every
 * lane branch is, and which is exactly what has to be recognised rather than
 * skipped.
 */
async function mergedBranches(repoPath: string): Promise<readonly string[]> {
  try {
    const output = await git(repoPath, ['branch', '--merged', 'HEAD'])
    return output
      .split('\n')
      .map((line) => line.replace(/^[*+]?\s+/, '').trim())
      .filter((line) => line !== '' && !line.startsWith('('))
  } catch {
    // Unknown means unmerged: the safe direction is to keep the branch.
    return []
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
