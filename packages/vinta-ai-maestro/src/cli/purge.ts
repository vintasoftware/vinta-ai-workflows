/**
 * `vinta-ai-maestro purge [run-id]` — §11's stated requirement.
 *
 * This command exists because agent transcripts and gate logs capture
 * repository contents verbatim. That makes `.vinta-ai-maestro/runs/` a data-at-rest
 * surface with a retention obligation, and an obligation with no mechanism is
 * a promise. This is the mechanism.
 *
 * It is also the only destructive command in the package, so it is built to be
 * one:
 *
 * - **It says exactly what it will delete, before it deletes it.** Every target
 *   path, listed. Not a count, not a glob — the paths, because a count cannot be
 *   checked and a glob has to be mentally expanded by the person least able to
 *   afford being wrong about it.
 * - **It asks.** `--yes` skips the question for scripts; `--dry-run` prints the
 *   list and stops, so "what would this remove" never requires being brave.
 * - **It does not end a run nobody named.** A run that could still be resumed
 *   — paused, failed, interrupted — is kept whole, directory and lanes, by a
 *   purge that does not name it; `--force` overrides that, and a running job is
 *   kept regardless (`run-guard.ts`).
 * - **It cannot leave `.vinta-ai-maestro/runs/`.** A run id is not a path: it is
 *   rejected outright if it contains a separator or a `..` segment, and the
 *   resolved target is then re-checked for containment before anything is
 *   unlinked. Two checks, because the first is a syntactic guess about what
 *   paths mean and the second is the actual question being asked. `fs.rm` does
 *   not follow symlinks, so a run directory that is a link to somewhere else
 *   loses the link and not the somewhere else.
 *
 * What it removes is the run *directory* — the frozen workflow snapshot, the
 * transcripts, the raw streams and the gate logs — and the run's rows in
 * `flow.db`. The rows used to be kept, on the argument that the event log is
 * opaque identifiers only (§11) and the post-mortem folds from it; what that
 * bought was a UI that listed, and offered to resume, a run whose snapshot
 * was gone. A purged run is purged: write the post-mortem first.
 */
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { openJournal, type Journal } from '../journal/journal.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { laneRootFor, runsRootFor, storeFor } from './paths.ts'
import { findReapable, reap, type Reapable, type TeardownExec } from './reap.ts'
import { runGuard } from './run-guard.ts'
import { dropWipRefs, landedWipRefs } from './wip-refs.ts'

export const PURGE_USAGE = `usage: vinta-ai-maestro purge [run-id] [--repo <dir>] [--yes] [--dry-run]
                             [--lanes] [--branches] [--force]

  Deletes run state under .vinta-ai-maestro/runs/ — transcripts, raw streams, gate
  logs and the frozen workflow snapshot. With no run id, every run is purged
  except those that could still be resumed (paused, failed, interrupted), which
  are kept and named. A run whose job is still running is always kept.

  Also drops the refs/vinta-ai-maestro/wip/* rescues a recycled lane left for
  a purged run whose phase has since landed — it is done, and its branch is
  reachable from a branch outside plan/ and wt/ — and, for a run already
  purged, those whose every rescued file reads the same at HEAD. Every
  other rescue is kept: it may be the only copy of that work.

  --repo <dir>   The project whose .vinta-ai-maestro/ store is purged.
                 Defaults to the current directory.
  --yes          Skip the confirmation. For scripts.
  --dry-run      List what would be deleted, and every command that would run,
                 and stop.
  --lanes        Also remove the lane worktrees under .vinta-ai-maestro/lanes/
                 and undo what each lane's summary records outside git: its
                 compose stack and forked volumes, its own service namespaces
                 (their reset_cmd) and its forked databases (dropdb, or the
                 project's dropdb_cmd). Summaries whose worktree is already gone
                 are cleaned up the same way. A run's lanes are not under runs/,
                 so nothing else reaps them. Lanes of a run that could still be
                 resumed are kept, as its run directory is: purge that run by
                 name, or pass --force.
  --branches     Also delete the plan/<workflow>/phase-* branches those lanes
                 held — the ones carrying no commit another branch does not
                 already have. A branch with commits of its own is listed and
                 kept, as is a lane whose worktree is dirty: on a failed run
                 either may be the only copy of what that phase produced.
  --force        Also purge runs that could still be resumed, and their lanes,
                 without naming them. Purging a run ends it: it cannot be
                 resumed afterwards. A running job is kept regardless.`

/** Nothing found, for the case where lanes were never asked about. */
const EMPTY_REAPABLE: Reapable = {
  lanes: [],
  dirtyLanes: [],
  protectedLanes: [],
  summaries: [],
  teardowns: [],
  unreadableSummaries: [],
  emptyBranches: [],
  carryingBranches: [],
}

export interface PurgeDeps {
  /** Runs a teardown command line. The default runs it in a shell, no prompts. */
  readonly exec?: TeardownExec
  readonly alive?: (pid: number) => boolean
}

/** A run id is a single directory name, never a path. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function purgeCommand(
  argv: readonly string[],
  io: Io,
  deps: PurgeDeps = {},
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' },
        yes: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        lanes: { type: 'boolean' },
        branches: { type: 'boolean' },
        force: { type: 'boolean' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(PURGE_USAGE)
    return USAGE
  }
  if (parsed.positionals.length > 1) {
    io.err(PURGE_USAGE)
    return USAGE
  }

  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const runsRoot = runsRootFor(repoPath)
  const runId = parsed.positionals[0]

  const found =
    runId === undefined ? await everyRun(runsRoot) : await within(runsRoot, runId, io)
  if (found === null) return FAILED
  // A run whose job is alive is writing into this directory right now —
  // transcripts, gate logs, its own `job.json`. Deleting it underneath the job
  // destroys the evidence of a run that is still producing it, so it is kept
  // and named, and `stop` is how it becomes purgeable. A run that could still
  // be resumed is kept from a purge that did not name it: its frozen snapshot
  // is what `run --resume` reads, so purging it ends the run.
  const guard = runGuard(repoPath, {
    ...(runId === undefined ? {} : { named: runId }),
    force: parsed.values.force === true,
    ...(deps.alive === undefined ? {} : { alive: deps.alive }),
  })
  const targets = found.filter((target) => {
    const id = basename(target)
    const reason = guard.keep(id)
    if (reason === null) return true
    io.err(`vinta-ai-maestro: keeping ${id} — ${reason}`)
    return false
  })

  const wantsLanes = parsed.values.lanes === true || parsed.values.branches === true
  const reapable = wantsLanes
    ? await findReapable({
        repoPath,
        laneRoot: laneRootFor(repoPath),
        summaryDir: join(repoPath, '.vinta-ai-workflows', 'worktrees'),
        ...(runId === undefined ? {} : { runId }),
        includeBranches: parsed.values.branches === true,
        guard,
      })
    : EMPTY_REAPABLE

  // Before anything is deleted: which phase a rescue belonged to is in the
  // journal rows this purge is about to forget.
  const purged = new Set(targets.map((target) => basename(target)))
  const landedRefs = await withJournal(repoPath, (journal) =>
    landedWipRefs({ repoPath, journal, guard, purged: (id) => purged.has(id) }),
  )

  const steps = reapable.teardowns.flatMap((teardown) => teardown.steps)
  const nothing =
    targets.length === 0 &&
    reapable.lanes.length === 0 &&
    reapable.summaries.length === 0 &&
    reapable.emptyBranches.length === 0 &&
    landedRefs.length === 0
  if (nothing) {
    // The wording widens only when the scope did. A plain `purge` that finds
    // nothing is still talking about run state, and saying "nothing to purge"
    // there would claim it had looked at lanes it was never asked about.
    const what = wantsLanes ? 'nothing to purge' : 'no run state to purge'
    io.out(
      runId === undefined
        ? `vinta-ai-maestro: ${what}.`
        : `vinta-ai-maestro: ${wantsLanes ? 'nothing to purge' : 'no run state'} for "${runId}".`,
    )
    // An unmerged branch is not nothing: it is the reason this ran and found
    // no work, and saying so beats an operator wondering why the branch is
    // still there.
    reportKept(reapable, io)
    return OK
  }

  io.out('vinta-ai-maestro purge — the following will be permanently deleted:')
  for (const target of targets) io.out(`  ${relative(repoPath, target)}`)
  for (const lane of reapable.lanes) {
    io.out(`  ${relative(repoPath, lane.path)}${lane.branch === null ? '' : ` (${lane.branch})`}`)
  }
  for (const summary of reapable.summaries) io.out(`  ${relative(repoPath, summary)}`)
  for (const branch of reapable.emptyBranches) io.out(`  branch ${branch}`)
  for (const ref of landedRefs) io.out(`  ref ${ref} (a recycled lane's rescue; its phase landed)`)
  if (steps.length > 0) {
    // Every command, as it will run. A database dropped is not something to
    // learn about from the summary line afterwards.
    io.out('')
    io.out('and torn down, from each lane’s summary:')
    for (const teardown of reapable.teardowns) {
      if (teardown.steps.length === 0) continue
      io.out(`  ${teardown.lane}${teardown.orphan ? ' (worktree already gone)' : ''}:`)
      for (const step of teardown.steps) io.out(`    ${step.label}`)
    }
  }
  io.out('')
  if (targets.length > 0) {
    io.out('Run directories hold agent transcripts and gate logs, which contain')
    io.out('repository contents verbatim.')
  }
  if (reapable.lanes.length > 0) {
    io.out('Removing a worktree discards anything uncommitted in it.')
  }
  if (steps.length > 0) {
    io.out('Dropping a database or a volume discards the data in it.')
  }
  io.out('Deletion cannot be undone.')
  reportKept(reapable, io)

  if (parsed.values['dry-run'] === true) {
    io.out('')
    io.out('--dry-run: nothing was deleted.')
    return OK
  }

  const count =
    targets.length +
    reapable.lanes.length +
    reapable.summaries.length +
    reapable.emptyBranches.length +
    landedRefs.length +
    steps.length
  if (parsed.values.yes !== true && !(await io.confirm(`Delete ${count} items?`))) {
    io.err('vinta-ai-maestro: cancelled. Nothing was deleted.')
    return FAILED
  }

  for (const target of targets) await rm(target, { recursive: true, force: true })
  forgetRuns(repoPath, targets.map((target) => basename(target)))
  let failures: readonly string[] = wantsLanes
    ? await reap(repoPath, reapable, {
        branches: parsed.values.branches === true,
        ...(deps.exec === undefined ? {} : { exec: deps.exec }),
      })
    : []
  failures = [...failures, ...(await dropWipRefs(repoPath, landedRefs))]

  io.out(`vinta-ai-maestro: deleted ${count - failures.length} of ${count} items.`)
  if (failures.length > 0) {
    // Named rather than counted: on Windows a worktree whose files something
    // still holds open is the common case, and it is fixed by retrying once
    // whatever holds them has exited.
    io.err('vinta-ai-maestro: these could not be removed — retry, or remove them by hand:')
    for (const failure of failures) io.err(`  ${failure}`)
    return FAILED
  }
  return OK
}

/** `use` with the store's journal, or with null when there is no store to open. */
async function withJournal<T>(repoPath: string, use: (journal: Journal | null) => Promise<T>): Promise<T> {
  if (!existsSync(join(storeFor(repoPath), 'flow.db'))) return await use(null)
  const journal = openJournal(repoPath)
  try {
    return await use(journal)
  } finally {
    journal.close()
  }
}

/** The journal's rows for runs whose directories are gone. No store, nothing to forget. */
function forgetRuns(repoPath: string, runIds: readonly string[]): void {
  if (runIds.length === 0 || !existsSync(join(storeFor(repoPath), 'flow.db'))) return
  const journal = openJournal(repoPath)
  try {
    for (const runId of runIds) journal.deleteRun(runId)
  } finally {
    journal.close()
  }
}

/**
 * Says what was deliberately left alone, and why.
 *
 * Silence would read as a bug — an operator who asked for `--lanes --branches`
 * and still sees a lane afterwards needs to know it was a decision. Both kinds
 * of survivor get the command that removes them anyway, because the point is to
 * let someone look at the reason and overrule it, not to hide the option.
 */
function reportKept(reapable: Reapable, io: Io): void {
  const byRun = new Map<string, { reason: string; names: string[] }>()
  for (const lane of reapable.protectedLanes) {
    const entry = byRun.get(lane.runId) ?? { reason: lane.reason, names: [] }
    entry.names.push(lane.name)
    byRun.set(lane.runId, entry)
  }
  for (const [runId, { reason, names }] of byRun) {
    io.out('')
    io.out(`Kept — lanes of ${runId}: ${reason}`)
    for (const name of names) io.out(`  ${name}`)
  }
  if (reapable.unreadableSummaries.length > 0) {
    io.out('')
    io.out('Kept — summaries that could not be read, so nothing was torn down from them:')
    for (const summary of reapable.unreadableSummaries) io.out(`  ${summary}`)
  }
  const left = reapable.teardowns.flatMap((teardown) =>
    teardown.left.map((what) => `${teardown.lane}: ${what}`),
  )
  if (left.length > 0) {
    io.out('')
    io.out('Left in place — named in a summary, but not provably that lane’s alone:')
    for (const line of left) io.out(`  ${line}`)
  }
  if (reapable.dirtyLanes.length > 0) {
    io.out('')
    io.out('Kept — uncommitted work in the worktree:')
    for (const lane of reapable.dirtyLanes) io.out(`  ${lane.path}`)
    io.out('Look first, then: git worktree remove --force <path>')
  }
  if (reapable.carryingBranches.length > 0) {
    io.out('')
    io.out('Kept — commits no other branch has:')
    for (const branch of reapable.carryingBranches) io.out(`  ${branch}`)
    io.out('Delete one anyway with: git branch -D <branch>')
  }
}

/**
 * Resolves one run id inside `runsRoot`, or refuses.
 *
 * The containment re-check after `resolve` is not redundant with the pattern
 * above it: the pattern encodes an assumption about what characters can mean
 * "go up", and this asks the resolver the question directly.
 */
async function within(runsRoot: string, runId: string, io: Io): Promise<string[] | null> {
  if (!RUN_ID.test(runId)) {
    io.err(`vinta-ai-maestro: refusing "${runId}" — a run id is a single name, not a path.`)
    return null
  }

  const target = resolve(runsRoot, runId)
  if (!target.startsWith(runsRoot + sep)) {
    io.err(`vinta-ai-maestro: refusing "${runId}" — it resolves outside .vinta-ai-maestro/runs/.`)
    return null
  }
  return (await everyRun(runsRoot)).includes(target) ? [target] : []
}

/** Every run directory, or none when the store has never been written. */
async function everyRun(runsRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(runsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(runsRoot, entry.name))
    .sort()
}
