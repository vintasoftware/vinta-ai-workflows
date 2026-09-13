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
 * - **It cannot leave `.vinta-ai-maestro/runs/`.** A run id is not a path: it is
 *   rejected outright if it contains a separator or a `..` segment, and the
 *   resolved target is then re-checked for containment before anything is
 *   unlinked. Two checks, because the first is a syntactic guess about what
 *   paths mean and the second is the actual question being asked. `fs.rm` does
 *   not follow symlinks, so a run directory that is a link to somewhere else
 *   loses the link and not the somewhere else.
 *
 * What it removes is the run *directory* — the frozen workflow snapshot, the
 * transcripts, the raw streams and the gate logs. It does not touch `flow.db`:
 * the event log carries opaque identifiers only (§11), it is the source of
 * truth every projection is rebuilt from, and dropping it would take the
 * post-mortem down with the transcripts it was supposed to replace.
 */
import { readdir, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { FAILED, OK, USAGE, type Io } from './io.ts'
import { laneRootFor, runsRootFor } from './paths.ts'
import { findReapable, reap, type Reapable } from './reap.ts'

export const PURGE_USAGE = `usage: vinta-ai-maestro purge [run-id] [--repo <dir>] [--yes] [--dry-run]
                             [--lanes] [--branches]

  Deletes run state under .vinta-ai-maestro/runs/ — transcripts, raw streams, gate
  logs and the frozen workflow snapshot. With no run id, every run is listed.

  --repo <dir>   The project whose .vinta-ai-maestro/ store is purged.
                 Defaults to the current directory.
  --yes          Skip the confirmation. For scripts.
  --dry-run      List what would be deleted and stop.
  --lanes        Also remove the lane worktrees a failed run left behind, and
                 their summaries. Nothing else reaps these: a run's lanes are
                 not under runs/, so they outlive every purge and accumulate.
  --branches     Also delete the plan/<workflow>/phase-* branches those lanes
                 held — the ones carrying no commit another branch does not
                 already have. A branch with commits of its own is listed and
                 kept, as is a lane whose worktree is dirty: on a failed run
                 either may be the only copy of what that phase produced.`

/** Nothing found, for the case where lanes were never asked about. */
const EMPTY_REAPABLE: Reapable = {
  lanes: [],
  dirtyLanes: [],
  summaries: [],
  emptyBranches: [],
  carryingBranches: [],
}

/** A run id is a single directory name, never a path. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function purgeCommand(argv: readonly string[], io: Io): Promise<number> {
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

  const targets =
    runId === undefined ? await everyRun(runsRoot) : await within(runsRoot, runId, io)
  if (targets === null) return FAILED

  const wantsLanes = parsed.values.lanes === true || parsed.values.branches === true
  const reapable = wantsLanes
    ? await findReapable({
        repoPath,
        laneRoot: laneRootFor(repoPath),
        summaryDir: join(repoPath, '.vinta-ai-workflows', 'worktrees'),
        ...(runId === undefined ? {} : { runId }),
        includeBranches: parsed.values.branches === true,
      })
    : EMPTY_REAPABLE

  const nothing =
    targets.length === 0 && reapable.lanes.length === 0 && reapable.emptyBranches.length === 0
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
  io.out('')
  if (targets.length > 0) {
    io.out('Run directories hold agent transcripts and gate logs, which contain')
    io.out('repository contents verbatim.')
  }
  if (reapable.lanes.length > 0) {
    io.out('Removing a worktree discards anything uncommitted in it.')
  }
  io.out('Deletion cannot be undone.')
  reportKept(reapable, io)

  if (parsed.values['dry-run'] === true) {
    io.out('')
    io.out('--dry-run: nothing was deleted.')
    return OK
  }

  const count = targets.length + reapable.lanes.length + reapable.emptyBranches.length
  if (parsed.values.yes !== true && !(await io.confirm(`Delete ${count} items?`))) {
    io.err('vinta-ai-maestro: cancelled. Nothing was deleted.')
    return FAILED
  }

  for (const target of targets) await rm(target, { recursive: true, force: true })
  for (const summary of reapable.summaries) await rm(summary, { force: true })
  const failures = wantsLanes
    ? await reap(repoPath, reapable, { branches: parsed.values.branches === true })
    : []

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

/**
 * Says what was deliberately left alone, and why.
 *
 * Silence would read as a bug — an operator who asked for `--lanes --branches`
 * and still sees a lane afterwards needs to know it was a decision. Both kinds
 * of survivor get the command that removes them anyway, because the point is to
 * let someone look at the reason and overrule it, not to hide the option.
 */
function reportKept(reapable: Reapable, io: Io): void {
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
