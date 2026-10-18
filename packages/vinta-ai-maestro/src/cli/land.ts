/**
 * `vinta-ai-maestro land <run-id>`, `propagate <run-id> <phase>` and
 * `sync-base <run-id>`: moving a run's branches toward what lands, done by a
 * command rather than by hand (`landing/`). The last two work on a live run
 * too, through its job, which makes the merges holding the integration
 * worktree's queue.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { openJournal, type Journal } from '../journal/journal.ts'
import { insideRoot } from '../landing/branches.ts'
import { ghForge, landedComment, planLanding, type Forge } from '../landing/land.ts'
import { propagate, type PropagateResult } from '../landing/propagate.ts'
import { syncBase, type SyncBaseResult } from '../landing/sync-base.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { laneRootFor, storeFor } from './paths.ts'
import { reach, refused, type SteerDeps } from './steer.ts'

export const LAND_USAGE = `usage: vinta-ai-maestro land <runId> [--close] [--ready] [--repo <dir>]

  Says how a finished run's plan lands, and which of its PRs are done.

  The plan PR — the run's final wave branch into the base branch — is the one
  to merge, with a merge commit. Every phase and integration PR is a review
  unit it already carries; merging those too resolves the same conflicts
  again against different bases. This lists them all with their state, and
  marks each one whose work is already in the base: merging it would leave
  the base's tree unchanged (a GitHub "Update branch", or bookkeeping merges
  of branches the base already has). A draft plan PR is named as one: GitHub
  will not merge a draft.

  --close        Close every open PR whose work is already in the base, with a
                 comment saying it landed. Nothing else is closed.
  --ready        Mark a draft plan PR ready for review, so it can be merged.
  --repo <dir>   The project. Defaults to the current directory.`

export const PROPAGATE_USAGE = `usage: vinta-ai-maestro propagate <runId> <phase> [--dry-run] [--no-push] [--repo <dir>]

  Carries new commits on a phase branch — a fix made after the run — into every
  integ-* and wave-* branch of the run that contains that phase, so the plan PR
  carries it too. Integration branches take the phase; waves keep their chain,
  each one taking the wave below. Merge commits only: nothing is rewritten.

  A conflict stops it with the branch and the paths, leaving that branch as it
  was. A branch one of the run's own worktrees has checked out is released
  from it first (detached, files untouched). On a live run the merges are made
  by its job, holding the integration worktree's queue, so none of the run's
  own merges can interleave with them.

  --dry-run      Print the merges it would make, and make none.
  --no-push      Do not push the branches it moved (they are pushed when the
                 project has a remote).
  --repo <dir>   The project. Defaults to the current directory.`

export const SYNC_BASE_USAGE = `usage: vinta-ai-maestro sync-base <runId> [--dry-run] [--no-push] [--repo <dir>]

  Brings a base branch that moved on into a run's plan: merges it into
  plan/<id>/base, then the plan branch into the lowest wave and each wave
  into the one above, so the plan PR stops conflicting with the base. The base
  is read from the remote when the local branch is behind it. Merge commits
  only: nothing is rewritten.

  On a live run the merges are made by its job, holding the integration
  worktree's queue, and a wave's conflict goes to the run's conflict fixer,
  gated as a phase's merge is. The plan branch's own conflict is never the
  fixer's: it is the run's configuration against the base's. A run that is not
  live has no fixer, and a conflict stops it with the branch as it was.

  --dry-run      Print the merges it would make, and make none.
  --no-push      Do not push the branches it moved (they are pushed when the
                 project has a remote).
  --repo <dir>   The project. Defaults to the current directory.`

export interface LandDeps {
  readonly forge?: Forge
}

export async function landCommand(argv: readonly string[], io: Io, deps: LandDeps = {}): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, close: { type: 'boolean' }, ready: { type: 'boolean' } },
      allowPositionals: true,
    })
  } catch {
    io.err(LAND_USAGE)
    return USAGE
  }
  const [runId] = parsed.positionals
  if (runId === undefined || parsed.positionals.length > 1) {
    io.err(LAND_USAGE)
    return USAGE
  }
  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  if (!existsSync(storeFor(repoPath))) {
    io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
    return FAILED
  }
  const journal = openJournal(repoPath)
  try {
    if (journal.run(runId) === undefined) {
      io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
      return FAILED
    }
    const forge = deps.forge ?? ghForge(repoPath)
    const plan = await planLanding({ repoPath, journal, runId, forge })

    if (plan.plan === null) {
      io.out('Plan PR: none was opened. The run did not build its final wave, or `gh` was missing.')
    } else {
      const draft = plan.plan.state === 'open' && plan.plan.draft
      io.out(`Plan PR: ${plan.plan.url} (${plan.plan.state}${draft ? ', draft' : ''})`)
      if (draft && parsed.values.ready === true) {
        if (forge.ready !== undefined && (await forge.ready(plan.plan.url))) {
          io.out('Marked it ready for review.')
        } else {
          io.err(`vinta-ai-maestro: could not mark ${plan.plan.url} ready. Run: gh pr ready ${plan.plan.url}`)
          return FAILED
        }
      } else if (draft) {
        io.out(
          `It is a draft, and GitHub will not merge a draft. Mark it ready first: ` +
            `vinta-ai-maestro land ${runId} --ready (or gh pr ready ${plan.plan.url}).`,
        )
      }
    }
    io.out(
      `Land it by merging the plan PR into ${plan.baseBranch} with a merge commit, and nothing else: ` +
        `the ${plan.units.length} PR(s) below are review units it carries.`,
    )
    if (plan.units.length > 0) {
      io.out('')
      for (const unit of plan.units) {
        const note =
          unit.state !== 'open'
            ? ''
            : unit.landed === true
              ? ' — its work is already in the base'
              : unit.landed === false
                ? ' — carries work the base does not have yet'
                : ' — could not be compared with the base'
        io.out(`  ${unit.kind} ${unit.nodeId}  ${unit.url}  ${unit.state}${note}`)
      }
    }

    const landed = plan.units.filter((unit) => unit.state === 'open' && unit.landed === true)
    if (parsed.values.close !== true) {
      if (landed.length > 0) io.out(`\n${landed.length} open PR(s) have landed. Close them with: vinta-ai-maestro land ${runId} --close`)
      return OK
    }

    let failed = 0
    for (const unit of landed) {
      if (await forge.close(unit.url, landedComment(plan.baseBranch, plan.plan?.url ?? null))) {
        io.out(`closed ${unit.url}`)
      } else {
        failed += 1
        io.err(`vinta-ai-maestro: could not close ${unit.url}`)
      }
    }
    if (landed.length === 0) io.out('Nothing to close: no open PR has landed yet.')
    return failed === 0 ? OK : FAILED
  } finally {
    journal.close()
  }
}

export async function propagateCommand(argv: readonly string[], io: Io, deps: SteerDeps = {}): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'no-push': { type: 'boolean' } },
      allowPositionals: true,
    })
  } catch {
    io.err(PROPAGATE_USAGE)
    return USAGE
  }
  const [runId, nodeId] = parsed.positionals
  if (runId === undefined || nodeId === undefined || parsed.positionals.length > 2) {
    io.err(PROPAGATE_USAGE)
    return USAGE
  }
  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const dryRun = parsed.values['dry-run'] === true
  const push = parsed.values['no-push'] !== true
  // A live run's integration worktree is merging into these branches, so the
  // merges go to its job, which makes them holding the integration queue.
  const live = await throughJob(repoPath, runId, 'propagate', { phase: nodeId, dryRun, push }, io, deps)
  if (live !== null) return typeof live === 'number' ? live : printChain(live as PropagateResult, io, nodeId, false)

  const journal = openRun(repoPath, runId, io)
  if (journal === null) return FAILED
  try {
    const workflow = journal.readWorkflow(runId)
    const node = journal.nodes(runId).find((candidate) => candidate.node_id === nodeId)
    if (node === undefined || node.base_branch === null) {
      io.err(`vinta-ai-maestro: run ${runId} has no phase "${nodeId}" with a recorded base`)
      return FAILED
    }
    const result = await propagate({
      repoPath,
      planId: workflow.id,
      nodeId,
      phaseBase: node.base_branch,
      ownWorktrees: insideRoot(laneRootFor(repoPath)),
      dryRun,
      push,
    })
    return printChain(result, io, nodeId, false)
  } finally {
    journal.close()
  }
}

export async function syncBaseCommand(argv: readonly string[], io: Io, deps: SteerDeps = {}): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'no-push': { type: 'boolean' } },
      allowPositionals: true,
    })
  } catch {
    io.err(SYNC_BASE_USAGE)
    return USAGE
  }
  const [runId] = parsed.positionals
  if (runId === undefined || parsed.positionals.length > 1) {
    io.err(SYNC_BASE_USAGE)
    return USAGE
  }
  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const dryRun = parsed.values['dry-run'] === true
  const push = parsed.values['no-push'] !== true
  const live = await throughJob(repoPath, runId, 'sync-base', { dryRun, push }, io, deps)
  if (live !== null) return typeof live === 'number' ? live : printChain(live as SyncBaseResult, io, null, true)

  const journal = openRun(repoPath, runId, io)
  if (journal === null) return FAILED
  try {
    const workflow = journal.readWorkflow(runId)
    const result = await syncBase({
      repoPath,
      planId: workflow.id,
      baseBranch: workflow.base_branch,
      ownWorktrees: insideRoot(laneRootFor(repoPath)),
      dryRun,
      push,
    })
    return printChain(result, io, null, false)
  } finally {
    journal.close()
  }
}

/**
 * The run's job's answer when the run is live, an exit code when the job
 * refused, and null when nothing hosts the run — the merges are then made
 * here, in a scratch worktree.
 */
async function throughJob(
  repoPath: string,
  runId: string,
  op: 'propagate' | 'sync-base',
  body: Readonly<Record<string, unknown>>,
  io: Io,
  deps: SteerDeps,
): Promise<unknown> {
  const target = reach(repoPath, runId, deps.env ?? process.env)
  if (target === null) return null
  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(`${target.url}/api/runs/${encodeURIComponent(runId)}/branches/${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // A job that died between reading its job.json and asking it: nothing is
    // merging any more, so the merges are made here.
    return null
  }
  const answer: unknown = await response.json().catch(() => null)
  if (response.status >= 400) return refused(io, response.status, answer)
  io.out(`run ${runId} is live: its job made the merges, holding the integration worktree's queue.`)
  return answer
}

function openRun(repoPath: string, runId: string, io: Io): Journal | null {
  if (!existsSync(storeFor(repoPath))) {
    io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
    return null
  }
  const journal = openJournal(repoPath)
  if (journal.run(runId) === undefined) {
    journal.close()
    io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
    return null
  }
  return journal
}

/**
 * Prints what a chain of merges did. `nodeId` is the phase `propagate`
 * carried, null for `sync-base`; `fixed` says a wave's conflict already went
 * to the run's fixer.
 */
function printChain(result: PropagateResult | SyncBaseResult, io: Io, nodeId: string | null, fixed: boolean): number {
  const command = nodeId === null ? 'sync-base' : 'propagate'
  const nothing =
    nodeId === null
      ? 'Nothing to bring in: the plan branch and every wave already have the base.'
      : `Nothing to carry: every branch containing ${nodeId} already has it.`
  switch (result.kind) {
    case 'planned':
      if (result.steps.length === 0) io.out(nothing)
      for (const step of result.steps) io.out(`would merge ${step.source} into ${step.branch}`)
      return OK
    case 'done':
      if (result.steps.length === 0) io.out(nothing)
      for (const step of result.steps) io.out(`merged ${step.source} into ${step.branch}`)
      for (const branch of result.pushed) io.out(`pushed ${branch}`)
      return OK
    case 'conflict': {
      for (const step of result.done) io.out(`merged ${step.source} into ${step.branch}`)
      const wave = /\/wave-\d+$/.test(result.at.branch)
      io.err(
        `vinta-ai-maestro: merging ${result.at.source} into ${result.at.branch} conflicted` +
          `${fixed && wave ? ' and the fixer did not resolve it' : ''}; it was left as it was.`,
      )
      for (const path of result.paths) io.err(`  ${path}`)
      if (nodeId === null && wave && !fixed) {
        io.err('Resume the run and sync again to hand the conflict to its fixer, or resolve it on that branch by hand.')
      }
      io.err(`Resolve it on that branch by hand, then run ${command} again to carry it the rest of the way.`)
      return FAILED
    }
    case 'held':
      io.err(
        `vinta-ai-maestro: ${result.branch} is checked out in ${result.worktree}, which is not one of this ` +
          'run’s worktrees. Switch that checkout to another branch first.',
      )
      return FAILED
  }
}
