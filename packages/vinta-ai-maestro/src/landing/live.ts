/**
 * `propagate` and `sync-base` on a live run: made in its job, holding the
 * integration worktree's queue.
 *
 * Both used to refuse a live run, because its integration worktree merges into
 * the same branches and two writers to one set of refs is the race the queue
 * exists to prevent. But the refusal cost more than the race: a route fix on
 * two phases could not reach older `integ-*` branches until a 42-phase run
 * ended, so their PRs stayed red all run. The queue is the coordination
 * already there — `exec <run> integration` holds it for a command by hand —
 * so these hold it too, for the length of their merges, and nothing the run
 * merges can interleave with them.
 */
import { UnresolvedConflictError } from '../integration/integrator.ts'
import { insideRoot, type BranchStep } from './branches.ts'
import { propagate, type PropagateResult } from './propagate.ts'
import { syncBase, type SyncBaseResult } from './sync-base.ts'

export interface BranchRequest {
  readonly dryRun: boolean
  readonly push: boolean
}

/** What a run's job offers the two commands (`DaemonRun.branches`). */
export interface BranchPort {
  /** Null for a phase the run has no recorded base for. */
  propagate(request: BranchRequest & { readonly nodeId: string }): Promise<PropagateResult | null>
  syncBase(request: BranchRequest): Promise<SyncBaseResult>
}

export interface LiveBranchOptions {
  readonly repoPath: string
  readonly laneRoot: string
  /** The plan's id and base branch, read when asked: an amendment may not change them, but nothing here assumes it. */
  readonly plan: () => { readonly id: string; readonly baseBranch: string }
  /** The branch a phase was cut from, as the run recorded it. */
  readonly phaseBase: (nodeId: string) => string | null
  /** Runs `work` holding the integration worktree's queue, as `label`. */
  readonly hold: <T>(label: string, work: () => Promise<T>) => Promise<T>
  /**
   * A wave's merge, with the run's conflict fixer (`Integrator.mergeBranch`).
   * Absent, `sync-base` merges every wave plainly and stops at a conflict.
   */
  readonly mergeBranch?: (into: string, incoming: string, wave: number) => Promise<unknown>
}

export function liveBranches(options: LiveBranchOptions): BranchPort {
  const ownWorktrees = insideRoot(options.laneRoot)
  return {
    async propagate(request) {
      const phaseBase = options.phaseBase(request.nodeId)
      if (phaseBase === null) return null
      const { id } = options.plan()
      return await options.hold('propagate', () =>
        propagate({
          repoPath: options.repoPath,
          planId: id,
          nodeId: request.nodeId,
          phaseBase,
          ownWorktrees,
          dryRun: request.dryRun,
          push: request.push,
        }),
      )
    },
    async syncBase(request) {
      const { id, baseBranch } = options.plan()
      const mergeBranch = options.mergeBranch
      return await options.hold('sync-base', () =>
        syncBase({
          repoPath: options.repoPath,
          planId: id,
          baseBranch,
          ownWorktrees,
          dryRun: request.dryRun,
          push: request.push,
          ...(mergeBranch === undefined ? {} : { mergeWave: fixed(mergeBranch) }),
          // TODO(codegen steps): regenerate the project's declared generated
          // files here, after each merge, once codegen steps exist.
        }),
      )
    },
  }
}

/** A wave merge whose conflicts go to the fixer; one no round resolved reads as a conflict. */
function fixed(mergeBranch: NonNullable<LiveBranchOptions['mergeBranch']>) {
  return async (step: BranchStep): Promise<readonly string[] | null> => {
    const wave = Number(/\/wave-(\d+)$/.exec(step.branch)?.[1] ?? Number.NaN)
    if (!Number.isFinite(wave)) throw new Error(`${step.branch} is not a wave branch`)
    try {
      await mergeBranch(step.branch, step.source, wave)
      return null
    } catch (error) {
      if (!(error instanceof UnresolvedConflictError)) throw error
      return error.paths.length > 0 ? error.paths : [step.branch]
    }
  }
}
