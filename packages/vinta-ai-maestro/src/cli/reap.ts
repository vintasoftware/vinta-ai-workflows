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
 *
 * **And never a run's lanes while the run still needs them.** A lane belongs to
 * a run, and a run that is live, paused, failed or interrupted will adopt its
 * worktrees when it resumes. `RunGuard` says which runs those are; their lanes
 * are kept and named, like a dirty one.
 *
 * A lane is also everything provisioned for it outside git — forked databases,
 * service slices, a compose stack and its forked volumes — and its summary is
 * the manifest of those. Reaping a lane tears them down from it
 * (`lanes/teardown.ts`), and a summary whose worktree is already gone is reaped
 * the same way rather than left for someone to find.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { runDatabaseCommand } from '../lanes/db-command.ts'
import { readSummary, type WorktreeSummary } from '../lanes/summary.ts'
import { planTeardown, type TeardownStep } from '../lanes/teardown.ts'
import { NO_GUARD, type RunGuard } from './run-guard.ts'

const run = promisify(execFile)

export interface Lane {
  /** The lane's directory, as git knows it. */
  readonly path: string
  /** The branch it holds checked out, if any. */
  readonly branch: string | null
  /** Uncommitted changes, including untracked files. Unknown reads as dirty. */
  readonly dirty: boolean
}

/** One lane's state outside git, and the files that record it. */
export interface Teardown {
  readonly lane: string
  /** Run before the summary goes; any failure keeps the summary for a retry. */
  readonly steps: readonly TeardownStep[]
  /** What the summary names that is deliberately not touched, and why. */
  readonly left: readonly string[]
  /** `<lane>.yaml` and its sidecars. */
  readonly files: readonly string[]
  /** True when the worktree is already gone and only the summary is left. */
  readonly orphan: boolean
}

/** A lane, or a summary without one, kept because of the run it belongs to. */
export interface ProtectedLane {
  readonly name: string
  readonly runId: string
  readonly reason: string
}

export interface Reapable {
  /** Lanes safe to remove: nothing uncommitted in them. */
  readonly lanes: readonly Lane[]
  /** Lanes kept because their worktree holds uncommitted work. */
  readonly dirtyLanes: readonly Lane[]
  /** Lanes and orphan summaries kept because their run is live or can still be resumed. */
  readonly protectedLanes: readonly ProtectedLane[]
  /** Summary files (`<name>.yaml` and any sidecars) belonging to `lanes` and orphans. */
  readonly summaries: readonly string[]
  /** What goes with each of them outside git, from its summary. */
  readonly teardowns: readonly Teardown[]
  /** Summaries that could not be read: nothing can be torn down from them, so they stay. */
  readonly unreadableSummaries: readonly string[]
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
async function lanesUnder(laneRoot: string): Promise<readonly Lane[]> {
  const names = await entriesOf(laneRoot)

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
 * only for `runId` and `guard`, which select among lanes already established
 * as lanes. Nothing is reaped for looking like it belongs to a run.
 *
 * A summary whose worktree is gone is an orphan, reaped by the same rules: it
 * is the only record of a forked database or a compose stack that nothing else
 * will ever remove. It counts as a lane's only when it says so itself — its
 * `path` is the lane root's directory of that name — because the same
 * directory holds the summaries `prepare-worktree` writes for worktrees a
 * person made, and those are not this command's.
 */
export async function findReapable(options: {
  readonly repoPath: string
  readonly laneRoot: string
  readonly summaryDir: string
  /** Restricts to one run's lanes. Absent means every lane under `laneRoot`. */
  readonly runId?: string
  /** Whether to consider branches at all. */
  readonly includeBranches: boolean
  /** Which run owns a lane, and whether it must be kept. Absent keeps nothing. */
  readonly guard?: RunGuard
}): Promise<Reapable> {
  const { repoPath, laneRoot, summaryDir, runId } = options
  const guard = options.guard ?? NO_GUARD

  // A lane that a longer run id claims belongs to that run, not this one.
  const selected = (name: string): boolean => {
    if (runId === undefined) return true
    const owner = guard.ownerOf(name)
    return owner === null ? name.startsWith(`${runId}-`) : owner === runId
  }
  const protectedLanes: ProtectedLane[] = []
  const kept = (name: string): boolean => {
    const owner = guard.ownerOf(name)
    const reason = owner === null ? null : guard.keep(owner)
    if (owner === null || reason === null) return false
    protectedLanes.push({ name, runId: owner, reason })
    return true
  }

  const all = await lanesUnder(laneRoot)
  const onDisk = new Set(all.map((lane) => basename(lane.path)))
  const mine = all.filter((lane) => selected(basename(lane.path)) && !kept(basename(lane.path)))

  const lanes = mine.filter((lane) => !lane.dirty)
  const dirtyLanes = mine.filter((lane) => lane.dirty)

  // Only the clean lanes' summaries, and the orphans'. A kept lane keeps its
  // summary: the file is how the pool knows what that worktree is, and
  // orphaning it would leave a directory nothing can reset or tear down.
  const entries = await entriesOf(summaryDir)
  const teardowns: Teardown[] = []
  const unreadableSummaries: string[] = []
  const plan = async (name: string, orphan: boolean): Promise<void> => {
    const files = entries
      .filter((entry) => stemOf(entry) === name)
      .map((entry) => join(summaryDir, entry))
    if (files.length === 0) return
    let summary: WorktreeSummary | null = null
    if (entries.includes(`${name}.yaml`)) {
      try {
        summary = await readSummary(summaryDir, name)
      } catch {
        unreadableSummaries.push(join(summaryDir, `${name}.yaml`))
        return
      }
    }
    const owner = guard.ownerOf(name)
    const undo =
      summary === null
        ? { steps: [], left: [] }
        : planTeardown(summary, owner === null ? null : guard.project(owner))
    teardowns.push({ lane: name, steps: undo.steps, left: undo.left, files, orphan })
  }

  for (const lane of lanes) await plan(basename(lane.path), false)
  for (const name of await orphansIn(summaryDir, laneRoot, entries, onDisk)) {
    if (selected(name) && !kept(name)) await plan(name, true)
  }
  const summaries = teardowns.flatMap((teardown) => teardown.files)
  const found = { lanes, dirtyLanes, protectedLanes, summaries, teardowns, unreadableSummaries }

  if (!options.includeBranches) {
    return { ...found, emptyBranches: [], carryingBranches: [] }
  }

  // Only branches held by lanes that are actually going. A branch whose
  // worktree is being kept cannot be deleted anyway — git refuses while it is
  // checked out — so offering it would be a promise this cannot keep.
  const candidates = [...new Set(lanes.map((lane) => lane.branch).filter(isPhaseBranch))]
  const carrying = await Promise.all(candidates.map((branch) => carriesCommits(repoPath, branch)))

  return {
    ...found,
    emptyBranches: candidates.filter((_, i) => carrying[i] === false),
    carryingBranches: candidates.filter((_, i) => carrying[i] !== false),
  }
}

const SUMMARY_FILE = /\.(yaml|docker-compose\.override\.yml)$/

const stemOf = (entry: string): string | null =>
  SUMMARY_FILE.test(entry) ? entry.replace(SUMMARY_FILE, '') : null

/** How every compose override the pool writes begins. */
const GENERATED = '# GENERATED by vinta-ai-maestro'

/**
 * Lane names with a summary and no worktree under the lane root.
 *
 * A summary is a lane's when it records that lane's own path; a compose
 * override with no summary beside it is a lane's when the pool wrote it, which
 * its first line says. Anything else in the directory is someone else's.
 */
async function orphansIn(
  summaryDir: string,
  laneRoot: string,
  entries: readonly string[],
  onDisk: ReadonlySet<string>,
): Promise<readonly string[]> {
  const stems = new Set(entries.map(stemOf).filter((stem): stem is string => stem !== null))
  const found: string[] = []
  for (const name of [...stems].filter((stem) => !onDisk.has(stem)).sort()) {
    if (entries.includes(`${name}.yaml`)) {
      try {
        const summary = await readSummary(summaryDir, name)
        if (summary.name === name && resolve(summary.path) === resolve(laneRoot, name)) {
          found.push(name)
        }
      } catch {
        // Unreadable and so not provably a lane's: not this command's to touch.
      }
      continue
    }
    try {
      const text = await readFile(join(summaryDir, `${name}.docker-compose.override.yml`), 'utf8')
      if (text.startsWith(GENERATED)) found.push(name)
    } catch {
      // Gone between the listing and the read: nothing left to reap.
    }
  }
  return found
}

/** Runs one teardown command line. Injected in tests. */
export type TeardownExec = (command: string, cwd: string) => Promise<void>

/**
 * The real one: stdin closed and a timeout, as for every database command, so
 * a `dropdb` asking for a password fails instead of hanging the purge.
 */
const runTeardownCommand: TeardownExec = (command, cwd) => runDatabaseCommand(command, { cwd })

/**
 * Tears down what each lane made outside git, removes the worktrees, then the
 * branches the caller approved, then the summaries.
 *
 * Teardown first, while the summary that describes it is still there. A
 * summary goes only once everything it lists has gone and its worktree with
 * it: it is the manifest a retry works from, and deleting it after a failed
 * `dropdb` would leave a database nothing records.
 *
 * Worktrees before branches, and that order is required rather than tidy: git
 * refuses to delete a branch that a worktree still has checked out, so branch
 * deletion after removal is the only sequence that works.
 *
 * Each step is attempted independently. One worktree that will not go — a file
 * still held open, which Windows does routinely — must not strand the other
 * eleven, and a database server that is down must not keep any worktree.
 */
export async function reap(
  repoPath: string,
  target: Reapable,
  options: { readonly branches: boolean; readonly exec?: TeardownExec },
): Promise<readonly string[]> {
  const failures: string[] = []
  const exec = options.exec ?? runTeardownCommand
  const unfinished = new Set<string>()

  for (const teardown of target.teardowns) {
    for (const step of teardown.steps) {
      try {
        await exec(step.command, repoPath)
      } catch {
        failures.push(`${step.label} (lane ${teardown.lane})`)
        unfinished.add(teardown.lane)
      }
    }
  }

  for (const lane of target.lanes) {
    try {
      await git(repoPath, ['worktree', 'remove', '--force', lane.path])
    } catch {
      failures.push(`worktree ${lane.path}`)
      unfinished.add(basename(lane.path))
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

  for (const teardown of target.teardowns) {
    for (const file of teardown.files) {
      if (unfinished.has(teardown.lane)) {
        failures.push(`summary ${file} (kept until lane ${teardown.lane} is gone)`)
        continue
      }
      try {
        await rm(file, { force: true })
      } catch {
        failures.push(`summary ${file}`)
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
