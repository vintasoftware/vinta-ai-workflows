/**
 * Moving a run's own branches by merge: what `propagate` and `sync-base` share.
 *
 * Both plan a list of steps — a branch, and what is merged into it — and carry
 * them out in order, stopping at the first conflict with that branch left as
 * it was. A finished run's steps run in a scratch worktree; a live run's run
 * in its job, holding the integration worktree's queue (`run/start.ts`), so
 * nothing the run itself merges can interleave with them.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface BranchStep {
  /** The branch that moves. */
  readonly branch: string
  /** What is merged into it. */
  readonly source: string
}

export type ChainResult =
  | { readonly kind: 'done'; readonly steps: readonly BranchStep[]; readonly pushed: readonly string[] }
  | {
      readonly kind: 'conflict'
      readonly done: readonly BranchStep[]
      readonly at: BranchStep
      readonly paths: readonly string[]
    }
  | { readonly kind: 'held'; readonly branch: string; readonly worktree: string }

/**
 * One step's merge: null when it is made, the conflicted paths when it is not
 * — and then the branch must be as it was before the step.
 */
export type StepMerge = (step: BranchStep) => Promise<readonly string[] | null>

export interface ChainOptions {
  readonly repoPath: string
  /** Worktrees a branch may be released from: the run's own. */
  readonly ownWorktrees?: (path: string) => boolean
  readonly push?: boolean
  /**
   * How each step is merged. Absent, a plain `merge --no-ff` in a scratch
   * worktree, aborted on a conflict.
   */
  readonly merge?: StepMerge
}

/** Carries `steps` out in order, then pushes what moved when the project has a remote. */
export async function runChain(steps: readonly BranchStep[], options: ChainOptions): Promise<ChainResult> {
  const { repoPath } = options
  if (steps.length === 0) return { kind: 'done', steps: [], pushed: [] }

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

  const done: BranchStep[] = []
  const carry = async (merge: StepMerge): Promise<ChainResult | null> => {
    for (const step of steps) {
      const paths = await merge(step)
      if (paths !== null) return { kind: 'conflict', done, at: step, paths }
      done.push(step)
    }
    return null
  }
  const stopped = options.merge === undefined ? await inScratch(repoPath, (work) => carry(plainMerge(work))) : await carry(options.merge)
  if (stopped !== null) return stopped

  const pushed: string[] = []
  const remote = options.push === false ? null : await firstRemote(repoPath)
  if (remote !== null) {
    for (const step of done) {
      if (await gitOk(repoPath, ['push', '--quiet', remote, step.branch])) pushed.push(step.branch)
    }
  }
  return { kind: 'done', steps: done, pushed }
}

/** A merge with no one to resolve a conflict: aborted, and the paths named. */
export function plainMerge(cwd: string): StepMerge {
  return async (step) => {
    await git(cwd, ['checkout', '--quiet', step.branch])
    if (await gitOk(cwd, ['merge', '--no-ff', '--no-edit', step.source])) return null
    const paths = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter((line) => line !== '')
    await gitOk(cwd, ['merge', '--abort'])
    return paths
  }
}

async function inScratch<T>(repoPath: string, work: (cwd: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-branches-'))
  const tree = join(scratch, 'tree')
  await git(repoPath, ['worktree', 'add', '--quiet', '--detach', tree])
  try {
    return await work(tree)
  } finally {
    await gitOk(repoPath, ['worktree', 'remove', '--force', tree])
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The run's wave branches that exist, lowest first. Waves are numbered from 1;
 * wave 0 is the plan branch, which is not one of these.
 */
export async function waveBranches(repoPath: string, planId: string): Promise<{ name: string; wave: number }[]> {
  return (await localBranches(repoPath, `plan/${planId}/`))
    .map((name) => ({ name, wave: Number(/\/wave-(\d+)$/.exec(name)?.[1] ?? Number.NaN) }))
    .filter((entry) => Number.isFinite(entry.wave))
    .sort((a, b) => a.wave - b.wave)
}

export async function localBranches(repoPath: string, prefix: string): Promise<string[]> {
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
      // The main checkout is never released: it is the operator's. Resolved,
      // because git prints Windows paths with forward slashes.
      if (resolve(path) !== resolve(repoPath)) held.set(line.slice('branch refs/heads/'.length), resolve(path))
    }
  }
  return held
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  try {
    return await git(cwd, ['merge-base', a, b])
  } catch {
    return null
  }
}

export const isAncestor = (cwd: string, a: string, b: string): Promise<boolean> =>
  gitOk(cwd, ['merge-base', '--is-ancestor', a, b])

/**
 * Whether a worktree lies under `root` — the run's lane root, which is what
 * makes it one of the run's own. Both sides in one spelling: symlinks resolved
 * (a temp directory is often one), separators native, and case folded on
 * Windows, whose paths ignore it.
 */
export function insideRoot(root: string): (path: string) => boolean {
  const base = real(root)
  return (path) => real(path).startsWith(`${base}${sep}`)
}

function real(path: string): string {
  let resolved: string
  try {
    resolved = realpathSync.native(path)
  } catch {
    resolved = resolve(path)
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export async function firstRemote(repoPath: string): Promise<string | null> {
  const remotes = (await git(repoPath, ['remote'])).split('\n').filter((line) => line !== '')
  return remotes[0] ?? null
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd })
  return stdout.trim()
}

export async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await run('git', [...args], { cwd })
    return true
  } catch {
    return false
  }
}
