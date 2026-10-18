/**
 * Carrying a fix made to a phase after the run into every branch built from it.
 *
 * The fix belongs on the phase branch, so the phase's PR is right. But the
 * run merged that branch into `integ-<id>` branches and into every wave from
 * its own upward, and the plan PR is the last wave: a fix on the phase branch
 * alone does not reach what lands. One observed run found a cross-phase bug on
 * the merged waves after it had finished, fixed it on the phase, and then
 * merged it by hand into three wave branches from a separate checkout — the
 * integration worktree still had the last one checked out.
 *
 * Which branches contain the phase is read from git, not from the plan: a
 * branch contains it when it shares a commit of the phase's own (one its base
 * does not have). Integration branches take the phase directly. Waves keep
 * their chain: the lowest wave containing the phase takes the phase, and each
 * wave above takes the wave below, so every wave still has the one under it
 * in its history.
 *
 * A finished run's merges are made in a scratch worktree of its own. A live
 * run's are made in its job, holding the integration worktree's queue, so no
 * wave merge or base preparation of the run's own interleaves with them
 * (`landing/branches.ts`); the command reaches the job over its API. A branch
 * another of the run's worktrees has checked out is released from it first
 * (detached at its commit, files untouched). A conflict stops it: the merge is
 * aborted, the branch is left as it was, and the conflicted paths are named.
 * Every step is a merge commit; nothing is rewritten, so every step can be
 * reverted.
 */
import { isAncestor, localBranches, mergeBase, runChain, waveBranches, type BranchStep, type ChainResult } from './branches.ts'

export type PropagateStep = BranchStep

export interface PropagateOptions {
  readonly repoPath: string
  readonly planId: string
  readonly nodeId: string
  /** The branch the phase was cut from, as the run recorded it. */
  readonly phaseBase: string
  /** Worktrees this command may release a branch from: the run's own. */
  readonly ownWorktrees?: (path: string) => boolean
  readonly dryRun?: boolean
  readonly push?: boolean
}

export type PropagateResult = ChainResult | { readonly kind: 'planned'; readonly steps: readonly PropagateStep[] }

/** What would move, in order. Pure reads. */
export async function planPropagation(options: PropagateOptions): Promise<readonly PropagateStep[]> {
  const { repoPath, planId, nodeId, phaseBase } = options
  const phase = `plan/${planId}/phase-${nodeId}`
  const branches = await localBranches(repoPath, `plan/${planId}/`)
  const contains = async (branch: string): Promise<boolean> => {
    const base = await mergeBase(repoPath, phase, branch)
    return base !== null && !(await isAncestor(repoPath, base, phaseBase))
  }

  const steps: PropagateStep[] = []
  for (const branch of branches.filter((name) => /\/integ-[^/]+$/.test(name))) {
    if ((await contains(branch)) && !(await isAncestor(repoPath, phase, branch))) steps.push({ branch, source: phase })
  }
  const waves = await waveBranches(repoPath, planId)
  let below: string | null = null
  for (const { name } of waves) {
    if (!(await contains(name))) continue
    const source: string = below ?? phase
    // Planned on the refs as they will be: a wave below that is about to move
    // is not yet an ancestor of this one, whatever git says now.
    const moving = steps.some((step) => step.branch === below)
    if (moving || !(await isAncestor(repoPath, source, name))) steps.push({ branch: name, source })
    below = name
  }
  return steps
}

export async function propagate(options: PropagateOptions): Promise<PropagateResult> {
  const steps = await planPropagation(options)
  if (options.dryRun === true) return { kind: 'planned', steps }
  return await runChain(steps, {
    repoPath: options.repoPath,
    ...(options.ownWorktrees === undefined ? {} : { ownWorktrees: options.ownWorktrees }),
    ...(options.push === undefined ? {} : { push: options.push }),
  })
}
