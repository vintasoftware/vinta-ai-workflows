/**
 * Bringing a `base_branch` that moved on into a running plan: `sync-base`.
 *
 * A run cuts `plan/<id>/base` from `base_branch` once, and every wave is built
 * on it. When `main` moves mid-run — a release, a dependency bump — the plan
 * PR goes on conflicting with it until the end. One run merged the new `main`
 * into its plan branch by hand and broke wave-4 in six files (a constants
 * module, `pyproject.toml`, `uv.lock` and three generated files), each then
 * resolved by hand.
 *
 * This makes the same merges in an order that keeps the run's shape: the plan
 * branch takes `base_branch`, the lowest wave takes the plan branch, and each
 * wave above takes the wave below, so every wave still has the one under it
 * in its history. `base_branch` is read from the remote when it is ahead of
 * the local branch — that is where a merged PR moves it.
 *
 * On a live run every merge runs in its job, holding the integration
 * worktree's queue, and a wave whose merge conflicts goes to the run's
 * conflict fixer, gated by `verify`, as a phase's merge does
 * (`Integrator.mergeBranch`). The plan branch's own merge is never given to
 * the fixer: what conflicts there is the run's configuration against the
 * base's, which is a decision and not a coding task — the integrator's
 * `#catchUp` refuses the same merge for the same reason. A finished or
 * paused run has no fixer to hand a conflict to, so its merges are made in a
 * scratch worktree and stop at the first conflict, with the branch as it was.
 */
import { firstRemote, git, gitOk, isAncestor, runChain, waveBranches, type BranchStep, type ChainResult, type StepMerge } from './branches.ts'

export type SyncStep = BranchStep

export interface SyncBaseOptions {
  readonly repoPath: string
  readonly planId: string
  readonly baseBranch: string
  /** Worktrees a branch may be released from: the run's own. */
  readonly ownWorktrees?: (path: string) => boolean
  readonly dryRun?: boolean
  readonly push?: boolean
  /**
   * How a wave's merge is made, on a live run: with the fixer. Absent, a plain
   * merge in a scratch worktree that stops at a conflict.
   */
  readonly mergeWave?: StepMerge
  /**
   * After each merge a live run makes, while its job still holds the
   * integration worktree's queue.
   *
   * TODO(codegen steps): this is where a project's declared generated files
   * are regenerated and committed once codegen steps exist. A merge of `main`
   * into a wave conflicts most in generated output (an OpenAPI schema, a
   * client, a route tree), and regenerating them settles that without the
   * fixer. Nothing is wired here yet.
   */
  readonly afterMerge?: (step: SyncStep) => Promise<void>
}

export type SyncBaseResult = ChainResult | { readonly kind: 'planned'; readonly steps: readonly SyncStep[] }

/** The plan branch's name, as `run/plan-branch.ts` cuts it. */
const planBranch = (planId: string): string => `plan/${planId}/base`

/**
 * The ref `base_branch` is read from: the remote's when the local branch is
 * behind it (fetched first), the local one otherwise.
 */
export async function baseSource(repoPath: string, baseBranch: string): Promise<string> {
  const remote = await firstRemote(repoPath).catch(() => null)
  if (remote === null) return baseBranch
  await gitOk(repoPath, ['fetch', '--quiet', remote, baseBranch])
  const tracking = `refs/remotes/${remote}/${baseBranch}`
  if (!(await gitOk(repoPath, ['rev-parse', '--verify', '--quiet', tracking]))) return baseBranch
  if (!(await gitOk(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`]))) return tracking
  return (await isAncestor(repoPath, baseBranch, tracking)) ? tracking : baseBranch
}

/** What would move, in order. Reads only — besides fetching `base_branch`. */
export async function planSyncBase(options: SyncBaseOptions): Promise<readonly SyncStep[]> {
  const { repoPath, planId } = options
  const plan = planBranch(planId)
  if (!(await gitOk(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan}`]))) return []
  const source = await baseSource(repoPath, options.baseBranch)

  const steps: SyncStep[] = []
  if (!(await isAncestor(repoPath, source, plan))) steps.push({ branch: plan, source })
  let below = plan
  for (const { name } of await waveBranches(repoPath, planId)) {
    // Planned on the refs as they will be, as `propagate` does.
    const moving = steps.some((step) => step.branch === below)
    if (moving || !(await isAncestor(repoPath, below, name))) steps.push({ branch: name, source: below })
    below = name
  }
  return steps
}

export async function syncBase(options: SyncBaseOptions): Promise<SyncBaseResult> {
  const steps = await planSyncBase(options)
  if (options.dryRun === true) return { kind: 'planned', steps }
  const plan = planBranch(options.planId)
  const mergeWave = options.mergeWave
  return await runChain(steps, {
    repoPath: options.repoPath,
    ...(options.ownWorktrees === undefined ? {} : { ownWorktrees: options.ownWorktrees }),
    ...(options.push === undefined ? {} : { push: options.push }),
    // The plan branch is merged plainly even on a live run (see above). With
    // no fixer, nothing is passed and every step is a plain merge in the
    // default scratch worktree.
    ...(mergeWave === undefined
      ? {}
      : {
          merge: async (step: SyncStep) => {
            const paths = step.branch === plan ? await plainInPlace(options.repoPath, step) : await mergeWave(step)
            if (paths === null) await options.afterMerge?.(step)
            return paths
          },
        }),
  })
}

/**
 * The plan branch's merge on a live run, made without a checkout, so it needs
 * no worktree: `merge-tree` writes the merged tree, `commit-tree` the commit,
 * and the branch moves only if it is still where it was. Returns the
 * conflicted paths, or null when merged.
 */
async function plainInPlace(repoPath: string, step: SyncStep): Promise<readonly string[] | null> {
  const before = await git(repoPath, ['rev-parse', `refs/heads/${step.branch}`])
  let tree: string
  try {
    tree = (await git(repoPath, ['merge-tree', '--write-tree', '--name-only', before, step.source])).split('\n')[0] ?? ''
  } catch (error) {
    // Exit 1: conflicts. The output is the tree, then the conflicted paths,
    // then a blank line and messages.
    const out = String((error as { stdout?: unknown }).stdout ?? '')
    const [, ...rest] = out.split('\n')
    const end = rest.indexOf('')
    const paths = (end === -1 ? rest : rest.slice(0, end)).filter((line) => line !== '')
    return paths.length > 0 ? [...new Set(paths)] : [step.branch]
  }
  const commit = await git(repoPath, [
    'commit-tree',
    tree,
    '-p',
    before,
    '-p',
    step.source,
    '-m',
    `Merge ${step.source} into ${step.branch}`,
  ])
  await git(repoPath, ['update-ref', `refs/heads/${step.branch}`, commit, before])
  return null
}
