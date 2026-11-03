/**
 * Which run a lane belongs to, and whether that run still needs it.
 *
 * `purge --lanes` used to answer neither question. Every clean worktree under
 * the lane root was a candidate, so the lanes of a paused, failed or
 * interrupted run — its integration worktree included — went with the rest,
 * and the run's resume then had nothing to adopt. The `liveJob` check that
 * guarded run *directories* never reached lanes at all.
 *
 * The rule is the one `run --resume` applies, read from the same places: the
 * journal's status corrected by whether a job is hosting it (`runState`), and
 * `isResumable`. A run whose job is alive is never touched — it is writing into
 * those worktrees now. A run that can still be resumed is kept unless the
 * operator named it, or passed `--force`: naming a run is the decision to end
 * it, which is not a decision a bulk purge may make on anyone's behalf.
 *
 * A lane's run is found by name — lanes are `<run-id>-<slot>` — against the
 * runs this store knows of, longest id first, so `run-1-lane-1` belongs to
 * `run-1` and not to a run called `run`. A lane matching no known run belongs
 * to a run that is already gone, and nothing can resume it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { liveJob } from '../job/job.ts'
import { openJournal } from '../journal/journal.ts'
import type { ProjectSpec } from '../lanes/pool.ts'
import { parseWorkflow } from '../validate.ts'
import { runsRootFor, storeFor } from './paths.ts'
import { projectSpec } from './project.ts'
import { isResumable, runState, type RunState } from './status.ts'

export interface RunGuard {
  /** The known run this lane or summary name belongs to, or null for none. */
  ownerOf(name: string): string | null
  /** Why this run's state must stay, or null when it may go. */
  keep(runId: string): string | null
  /** The `project` block the run provisioned its lanes from, or null when unknown. */
  project(runId: string): ProjectSpec | null
}

/** A guard that knows no runs: every lane is an orphan and nothing is kept. */
export const NO_GUARD: RunGuard = {
  ownerOf: () => null,
  keep: () => null,
  project: () => null,
}

export function runGuard(
  repoPath: string,
  options: {
    /** The run the operator named. Its resumability does not keep it. */
    readonly named?: string
    /** Purge resumable runs too. A live run is kept regardless. */
    readonly force: boolean
    readonly alive?: (pid: number) => boolean
  },
): RunGuard {
  const states = new Map<string, RunState | null>()
  for (const id of runDirectories(repoPath)) states.set(id, null)
  if (existsSync(join(storeFor(repoPath), 'flow.db'))) {
    const journal = openJournal(repoPath)
    try {
      for (const row of journal.runs()) {
        states.set(row.id, runState(row, liveJob(repoPath, row.id, options.alive)))
      }
    } finally {
      journal.close()
    }
  }
  // Longest first, so the most specific id claims a name.
  const ids = [...states.keys()].sort((a, b) => b.length - a.length)
  const projects = new Map<string, ProjectSpec | null>()

  return {
    ownerOf: (name) => ids.find((id) => name.startsWith(`${id}-`)) ?? null,
    keep: (runId) => {
      const job = liveJob(repoPath, runId, options.alive)
      if (job !== null) return `its job is still running (pid ${job.pid}). Stop it first.`
      if (runId === options.named || options.force) return null
      const state = states.get(runId) ?? null
      if (state === null || !isResumable(state)) return null
      return `it is ${state} and can still be resumed. Name it, or pass --force, to purge it anyway.`
    },
    project: (runId) => {
      if (!projects.has(runId)) projects.set(runId, frozenProject(repoPath, runId))
      return projects.get(runId) ?? null
    },
  }
}

/**
 * The run's frozen `project` block — the one its lanes were provisioned from,
 * which is what a database name has to be checked against. Read before `purge`
 * deletes the run directory it lives in.
 */
function frozenProject(repoPath: string, runId: string): ProjectSpec | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(runsRootFor(repoPath), runId, 'workflow.json'), 'utf8'),
    )
    const parsed = parseWorkflow(raw)
    return parsed.ok ? projectSpec(parsed.workflow.project) : null
  } catch {
    return null
  }
}

function runDirectories(repoPath: string): readonly string[] {
  try {
    return readdirSync(runsRootFor(repoPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
