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
 * It works in a scratch worktree of its own and never on a live run, whose
 * integration worktree is busy. A branch another of the run's worktrees has
 * checked out is released from it first (detached at its commit, files
 * untouched). A conflict stops it: the merge is aborted, the branch is left as
 * it was, and the conflicted paths are named. Every step is a merge commit;
 * nothing is rewritten, so every step can be reverted.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface PropagateStep {
  /** The branch that moves. */
  readonly branch: string
  /** What is merged into it: the phase branch, or the wave below. */
  readonly source: string
}

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

export type PropagateResult =
  | { readonly kind: 'done'; readonly steps: readonly PropagateStep[]; readonly pushed: readonly string[] }
  | { readonly kind: 'planned'; readonly steps: readonly PropagateStep[] }
  | {
      readonly kind: 'conflict'
      readonly done: readonly PropagateStep[]
      readonly at: PropagateStep
      readonly paths: readonly string[]
    }
  | { readonly kind: 'held'; readonly branch: string; readonly worktree: string }

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
  const waves = branches
    .map((name) => ({ name, wave: Number(/\/wave-(\d+)$/.exec(name)?.[1] ?? Number.NaN) }))
    .filter((entry) => Number.isFinite(entry.wave))
    .sort((a, b) => a.wave - b.wave)
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
  if (options.dryRun === true || steps.length === 0) {
    return options.dryRun === true ? { kind: 'planned', steps } : { kind: 'done', steps, pushed: [] }
  }

  const { repoPath } = options
  // Released before anything moves: a branch checked out elsewhere cannot be
  // checked out here, and git's refusal halfway through would leave a chain
  // with its lower waves moved and its upper ones not.
  const holders = await worktreeBranches(repoPath)
  for (const step of steps) {
    const holder = holders.get(step.branch)
    if (holder === undefined) continue
    if (options.ownWorktrees?.(holder) !== true) return { kind: 'held', branch: step.branch, worktree: holder }
    await git(holder, ['checkout', '--quiet', '--detach'])
  }

  const scratch = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-propagate-'))
  const work = join(scratch, 'tree')
  await git(repoPath, ['worktree', 'add', '--quiet', '--detach', work])
  const done: PropagateStep[] = []
  try {
    for (const step of steps) {
      await git(work, ['checkout', '--quiet', step.branch])
      if (await gitOk(work, ['merge', '--no-ff', '--no-edit', step.source])) {
        done.push(step)
        continue
      }
      const paths = (await git(work, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter((line) => line !== '')
      await gitOk(work, ['merge', '--abort'])
      return { kind: 'conflict', done, at: step, paths }
    }
  } finally {
    await gitOk(repoPath, ['worktree', 'remove', '--force', work])
    rmSync(scratch, { recursive: true, force: true })
  }

  const pushed: string[] = []
  const remote = options.push === false ? null : await firstRemote(repoPath)
  if (remote !== null) {
    for (const step of done) {
      if (await gitOk(repoPath, ['push', '--quiet', remote, step.branch])) pushed.push(step.branch)
    }
  }
  return { kind: 'done', steps: done, pushed }
}

async function localBranches(repoPath: string, prefix: string): Promise<string[]> {
  const out = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`])
  return out.split('\n').filter((line) => line !== '')
}

/** Branch → the worktree that has it checked out. */
async function worktreeBranches(repoPath: string): Promise<Map<string, string>> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const held = new Map<string, string>()
  let path: string | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    if (line.startsWith('branch refs/heads/') && path !== null) {
      // The main checkout is never released: it is the operator's.
      if (resolve(path) !== resolve(repoPath)) held.set(line.slice('branch refs/heads/'.length), path)
    }
  }
  return held
}

async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  try {
    return await git(cwd, ['merge-base', a, b])
  } catch {
    return null
  }
}

const isAncestor = (cwd: string, a: string, b: string): Promise<boolean> =>
  gitOk(cwd, ['merge-base', '--is-ancestor', a, b])

async function firstRemote(repoPath: string): Promise<string | null> {
  const remotes = (await git(repoPath, ['remote'])).split('\n').filter((line) => line !== '')
  return remotes[0] ?? null
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd })
  return stdout.trim()
}

async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await run('git', [...args], { cwd })
    return true
  } catch {
    return false
  }
}
