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
import { readdir, stat } from 'node:fs/promises'
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
 * The lanes under this root, with the branch each holds.
 *
 * Read from the directory rather than from `git worktree list`, and that is the
 * load-bearing choice in this file. Listing git's worktrees means asking which
 * of them are lanes, and the only available answer is "the ones whose path is
 * under `laneRoot`" — a comparison between a path git printed and a path Node
 * built, which are not the same string for the same directory. Windows decides
 * that on its own: drive-letter case, `/` against `\`, and 8.3 short names like
 * `RUNNER~1` where the long name is `runneradmin`. Resolving both sides first
 * narrows the gap without closing it, and the failure is silent in the worst
 * possible direction — every lane looks like someone else's worktree, so the
 * command finds nothing, deletes nothing, and says so cheerfully.
 *
 * A lane's directory is one this tool created, at a path it built itself. Going
 * that way round there is no second spelling to reconcile: the children of the
 * lane root are the candidates, and each is asked about itself.
 */
async function lanesUnder(laneRoot: string, runId: string | undefined): Promise<readonly Lane[]> {
  const names = (await entriesOf(laneRoot)).filter(
    (name) => runId === undefined || name.startsWith(`${runId}-`),
  )

  const found = await Promise.all(
    names.map(async (name): Promise<Lane | null> => {
      const path = join(laneRoot, name)
      if (!(await isLinkedWorktree(path))) return null
      return { path, branch: await branchOf(path), dirty: await isDirty(path) }
    }),
  )
  return found.filter((lane): lane is Lane => lane !== null)
}

/**
 * Whether a directory is a linked worktree, as opposed to anything else that
 * happens to be sitting under the lane root.
 *
 * A linked worktree carries a `.git` **file** pointing at the real repository,
 * where an ordinary checkout has a directory — a fact about the filesystem,
 * which is what this needs, since the lane root lives inside the repository and
 * a plain subdirectory of it would answer every `git` question perfectly well
 * while not being a worktree at all.
 */
async function isLinkedWorktree(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, '.git'))).isFile()
  } catch {
    return false
  }
}

/** The branch checked out in a worktree, or null when HEAD is detached. */
async function branchOf(path: string): Promise<string | null> {
  try {
    const output = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return output.trim() === '' ? null : output.trim()
  } catch {
    return null
  }
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
 * A lane is a child of `laneRoot` that is really a worktree; the name matters
 * only for `runId`, which selects a subset of lanes already established as
 * lanes. Nothing is reaped for looking like it belongs to a run.
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

  const mine = await lanesUnder(laneRoot, runId)

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

async function entriesOf(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}
