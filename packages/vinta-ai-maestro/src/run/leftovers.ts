/**
 * What finished runs left behind: compose stacks still running, lane
 * worktrees still on disk, job processes still alive.
 *
 * A run that ends `done` now stops its own stacks (`LanePool.stopStacks`), but
 * that does nothing for a run that finished before it did, a stack that would
 * not stop, or a job an earlier interrupt failed to end. One observed run had
 * twenty containers, five worktrees and a job process still up a day and a
 * half after it was done. Nothing said so.
 *
 * Only runs that are over — `done` or `cancelled` — are asked about. A failed,
 * paused or interrupted run is resumable, and its lanes and stacks are the
 * state a resume or a person debugging it needs: they are not leftovers.
 *
 * Every entry carries the command that removes it. Nothing here removes
 * anything.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { laneRootFor } from '../cli/paths.ts'
import { isAlive, liveJob } from '../job/job.ts'
import type { Journal } from '../journal/journal.ts'

const run = promisify(execFile)

export interface Leftover {
  readonly kind: 'stack' | 'lane' | 'job'
  readonly runId: string
  /** The compose project, the lane directory, or the pid. */
  readonly what: string
  /** The command the operator runs to remove it. */
  readonly remedy: string
}

export interface LeftoverDeps {
  /** Running compose projects. The default asks `docker compose ls`; no docker reads as none. */
  readonly listStacks?: () => Promise<readonly string[]>
  readonly alive?: (pid: number) => boolean
}

const FINISHED: ReadonlySet<string> = new Set(['done', 'cancelled'])

export async function findLeftovers(
  repoPath: string,
  journal: Journal,
  deps: LeftoverDeps = {},
): Promise<readonly Leftover[]> {
  const finished = journal.runs().filter((row) => FINISHED.has(row.status))
  if (finished.length === 0) return []

  const stacks = await (deps.listStacks ?? runningStacks)()
  const laneRoot = laneRootFor(repoPath)
  const lanes = existsSync(laneRoot) ? readdirSync(laneRoot) : []
  // A lane's compose project is `<checkout>_<lane>`, and compose lowercases it.
  const prefix = `${basename(repoPath)}_`.toLowerCase()

  const found: Leftover[] = []
  for (const row of finished) {
    const runId = row.id
    for (const project of stacks) {
      if (!project.startsWith(`${prefix}${runId.toLowerCase()}-`)) continue
      found.push({ kind: 'stack', runId, what: project, remedy: `docker compose -p ${project} down` })
    }
    const own = lanes.filter((name) => name.startsWith(`${runId}-`))
    for (const name of own) {
      found.push({
        kind: 'lane',
        runId,
        what: join(laneRoot, name),
        remedy: `vinta-ai-maestro purge ${runId} --lanes`,
      })
    }
    const job = liveJob(repoPath, runId, deps.alive ?? isAlive)
    if (job !== null) {
      found.push({ kind: 'job', runId, what: String(job.pid), remedy: `vinta-ai-maestro stop ${runId}` })
    }
  }
  return found
}

/** One line per leftover, and the command for it. */
export function describeLeftovers(found: readonly Leftover[]): readonly string[] {
  const label = { stack: 'compose stack still running', lane: 'lane worktree still on disk', job: 'job process still alive' }
  return found.map((entry) => `${entry.runId}: ${label[entry.kind]} ${entry.what} — ${entry.remedy}`)
}

async function runningStacks(): Promise<readonly string[]> {
  try {
    const { stdout } = await run('docker', ['compose', 'ls', '--format', 'json'], { timeout: 10_000 })
    const parsed = JSON.parse(stdout) as { Name?: unknown }[]
    return parsed.map((entry) => entry.Name).filter((name): name is string => typeof name === 'string')
  } catch {
    return []
  }
}
