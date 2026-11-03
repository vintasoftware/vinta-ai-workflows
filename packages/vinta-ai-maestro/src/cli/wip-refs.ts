/**
 * Which `refs/vinta-ai-maestro/wip/*` rescues `purge` may drop.
 *
 * A lane recycle sets aside whatever its phase left uncommitted as a commit
 * under `wip/<lane>/<ms>` (`LanePool.#preserveWork`), and nothing ever removed
 * one: an observed project had ~80 of them, from lanes recycled across a run,
 * almost every one for a phase that went on to finish and land. A rescue is
 * there for the phase that lost work; once that phase has landed, it has done
 * its job.
 *
 * **Landed, from the run's own record.** The ref's lane names its run (the
 * same longest-prefix rule `run-guard.ts` gives lanes); the journal names the
 * phase that lane served when the rescue was taken — the last `node_assigned`
 * of that lane at or before the ref's timestamp. The rescue is dropped when
 * that phase is `done`, the commit the rescue sat on is on the phase's branch,
 * and that branch is reachable from a branch maestro does not own (anything
 * outside `plan/*` and `wt/*`, local or remote) — the phase merged into
 * something a person keeps.
 *
 * **Without a record, only identical content.** A ref whose run is already
 * purged has no journal to ask. It is dropped only when every path it rescued
 * reads the same at `HEAD` of the checkout as in the rescue, which is the work
 * having landed by any route. Anything git cannot answer is kept: a dropped
 * rescue is the one deletion here that can lose work.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Journal } from '../journal/journal.ts'
import { WIP_REFS } from '../lanes/pool.ts'
import type { RunGuard } from './run-guard.ts'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

export interface WipRef {
  readonly ref: string
  readonly lane: string
  /** Epoch ms the rescue was taken, from the ref's last segment. */
  readonly at: number
}

/** Every rescue ref in the repository. None when git cannot list them. */
export async function wipRefs(repoPath: string): Promise<WipRef[]> {
  let output: string
  try {
    output = await git(repoPath, ['for-each-ref', '--format=%(refname)', WIP_REFS])
  } catch {
    return []
  }
  const refs: WipRef[] = []
  for (const ref of output.split('\n').map((line) => line.trim())) {
    const match = new RegExp(`^${WIP_REFS}/(.+)/(\\d+)$`).exec(ref)
    if (match === null) continue
    refs.push({ ref, lane: match[1] as string, at: Number(match[2]) })
  }
  return refs
}

/** Whether `commit` is reachable from a branch maestro does not own. */
async function reachableOutsideMaestro(repoPath: string, commit: string): Promise<boolean> {
  const output = await git(repoPath, [
    'rev-list',
    '--max-count=1',
    commit,
    '--not',
    '--exclude=plan/*',
    '--exclude=wt/*',
    '--branches',
    '--exclude=*/plan/*',
    '--exclude=*/wt/*',
    '--remotes',
  ])
  return output.trim() === ''
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

/** The phase a lane served when the rescue was taken, with its branch and status. */
function phaseAt(
  journal: Journal,
  runId: string,
  wip: WipRef,
): { readonly branch: string; readonly status: string } | null {
  let nodeId: string | undefined
  for (const event of journal.events(runId)) {
    if (event.ts > wip.at) continue
    if (event.type === 'node_assigned' && event.payload.lane === wip.lane) nodeId = event.nodeId
  }
  if (nodeId === undefined) return null
  const row = journal.nodes(runId).find((candidate) => candidate.node_id === nodeId)
  return row?.branch == null ? null : { branch: row.branch, status: row.status }
}

async function phaseLanded(repoPath: string, wip: WipRef, phase: { branch: string; status: string }): Promise<boolean> {
  if (phase.status !== 'done') return false
  const parent = `${wip.ref}^`
  return (
    (await isAncestor(repoPath, parent, `refs/heads/${phase.branch}`)) &&
    (await reachableOutsideMaestro(repoPath, `refs/heads/${phase.branch}`))
  )
}

async function contentLanded(repoPath: string, wip: WipRef): Promise<boolean> {
  const paths = (await git(repoPath, ['diff', '--name-only', '--no-renames', `${wip.ref}^`, wip.ref, '--']))
    .split('\n')
    .filter((line) => line !== '')
  if (paths.length === 0) return true
  try {
    await git(repoPath, ['diff', '--quiet', '--no-renames', wip.ref, 'HEAD', '--', ...paths])
    return true
  } catch {
    return false
  }
}

/**
 * The rescues a purge may drop: those whose lane belongs to a run being
 * purged (`purged`), or to no run this store knows, and whose work landed.
 * `journal` is read before the purge forgets the runs it names.
 */
export async function landedWipRefs(options: {
  readonly repoPath: string
  readonly journal: Journal | null
  readonly guard: RunGuard
  readonly purged: (runId: string) => boolean
}): Promise<string[]> {
  const { repoPath, journal, guard } = options
  const landed: string[] = []
  for (const wip of await wipRefs(repoPath)) {
    const owner = guard.ownerOf(wip.lane)
    try {
      if (owner === null) {
        if (await contentLanded(repoPath, wip)) landed.push(wip.ref)
        continue
      }
      if (!options.purged(owner) || journal === null) continue
      const phase = phaseAt(journal, owner, wip)
      if (phase !== null && (await phaseLanded(repoPath, wip, phase))) landed.push(wip.ref)
    } catch {
      // Unanswerable is kept.
    }
  }
  return landed
}

/** Deletes each ref. Returns the ones git would not delete. */
export async function dropWipRefs(repoPath: string, refs: readonly string[]): Promise<string[]> {
  const failures: string[] = []
  for (const ref of refs) {
    try {
      await git(repoPath, ['update-ref', '-d', ref])
    } catch {
      failures.push(`ref ${ref}`)
    }
  }
  return failures
}
