/**
 * `vinta-ai-maestro land <run-id>` and `vinta-ai-maestro propagate <run-id> <phase>`:
 * the two things a finished run still needs from someone, done by a command
 * rather than by hand (`landing/`).
 */
import { existsSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { liveJob } from '../job/job.ts'
import { openJournal } from '../journal/journal.ts'
import { ghForge, landedComment, planLanding, type Forge } from '../landing/land.ts'
import { propagate } from '../landing/propagate.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { laneRootFor, storeFor } from './paths.ts'

export const LAND_USAGE = `usage: vinta-ai-maestro land <runId> [--close] [--repo <dir>]

  Says how a finished run's plan lands, and which of its PRs are done.

  The plan PR — the run's final wave branch into the base branch — is the one
  to merge, with a merge commit. Every phase and integration PR is a review
  unit it already carries; merging those too resolves the same conflicts
  again against different bases. This lists them all with their state, and
  marks each one whose work is already in the base: every commit it adds is a
  merge whose parents the base has (a GitHub "Update branch", say).

  --close        Close every open PR whose work is already in the base, with a
                 comment saying it landed. Nothing else is closed.
  --repo <dir>   The project. Defaults to the current directory.`

export const PROPAGATE_USAGE = `usage: vinta-ai-maestro propagate <runId> <phase> [--dry-run] [--no-push] [--repo <dir>]

  Carries new commits on a phase branch — a fix made after the run — into every
  integ-* and wave-* branch of the run that contains that phase, so the plan PR
  carries it too. Integration branches take the phase; waves keep their chain,
  each one taking the wave below. Merge commits only: nothing is rewritten.

  A conflict stops it with the branch and the paths, leaving that branch as it
  was. A branch one of the run's own worktrees has checked out is released
  from it first (detached, files untouched). Refuses a run that is still live.

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
      options: { repo: { type: 'string' }, close: { type: 'boolean' } },
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
      io.out(`Plan PR: ${plan.plan.url} (${plan.plan.state})`)
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

export async function propagateCommand(argv: readonly string[], io: Io): Promise<number> {
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
  if (!existsSync(storeFor(repoPath))) {
    io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
    return FAILED
  }
  const journal = openJournal(repoPath)
  try {
    const row = journal.run(runId)
    if (row === undefined) {
      io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
      return FAILED
    }
    // A live run's integration worktree is merging; two writers to one set of
    // branches is the race the integration queue exists to prevent.
    if (row.status === 'running' && liveJob(repoPath, runId) !== null) {
      io.err(
        `vinta-ai-maestro: run ${runId} is live. Merge into its branches through it instead: ` +
          `vinta-ai-maestro exec ${runId} integration -- git merge --no-ff <branch>`,
      )
      return FAILED
    }
    const workflow = journal.readWorkflow(runId)
    const node = journal.nodes(runId).find((candidate) => candidate.node_id === nodeId)
    if (node === undefined || node.base_branch === null) {
      io.err(`vinta-ai-maestro: run ${runId} has no phase "${nodeId}" with a recorded base`)
      return FAILED
    }
    const laneRoot = laneRootFor(repoPath)
    const result = await propagate({
      repoPath,
      planId: workflow.id,
      nodeId,
      phaseBase: node.base_branch,
      ownWorktrees: (path) => real(path).startsWith(`${real(laneRoot)}${sep}`),
      dryRun: parsed.values['dry-run'] === true,
      push: parsed.values['no-push'] !== true,
    })

    switch (result.kind) {
      case 'planned':
        if (result.steps.length === 0) io.out(`Nothing to carry: every branch containing ${nodeId} already has it.`)
        for (const step of result.steps) io.out(`would merge ${step.source} into ${step.branch}`)
        return OK
      case 'done':
        if (result.steps.length === 0) io.out(`Nothing to carry: every branch containing ${nodeId} already has it.`)
        for (const step of result.steps) io.out(`merged ${step.source} into ${step.branch}`)
        for (const branch of result.pushed) io.out(`pushed ${branch}`)
        return OK
      case 'conflict':
        for (const step of result.done) io.out(`merged ${step.source} into ${step.branch}`)
        io.err(`vinta-ai-maestro: merging ${result.at.source} into ${result.at.branch} conflicted; it was left as it was.`)
        for (const path of result.paths) io.err(`  ${path}`)
        io.err('Resolve it on that branch by hand, then run propagate again to carry it the rest of the way.')
        return FAILED
      case 'held':
        io.err(
          `vinta-ai-maestro: ${result.branch} is checked out in ${result.worktree}, which is not one of this ` +
            'run’s worktrees. Switch that checkout to another branch first.',
        )
        return FAILED
    }
  } finally {
    journal.close()
  }
}

/** A path as git reports a worktree: symlinks resolved, so a temp directory compares equal. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
