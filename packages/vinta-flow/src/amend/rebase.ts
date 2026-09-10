/**
 * Moving an already-`done` node's branch onto the base its amended
 * dependencies imply (§9, §8).
 *
 * This is the one part of the amend path that touches git, and it does so
 * through `Integrator`: `prepareBase` is what knows the topology rule, builds
 * an `integ-<id>` branch when a node has several dependencies, and merges them
 * in `depends_on` declaration order. Re-deriving any of that here would be a
 * second place that knows how phase branches are named.
 *
 * Two properties the loop below exists to guarantee:
 *
 * - **`integ-` bases are rebuilt before the node that sits on them.** The queue
 *   arrives in topological order, so by the time `prepareBase` merges a node's
 *   dependencies, every one of those dependency branches has already been
 *   moved. Building the `integ-` first is not a separate pass — it is what
 *   `prepareBase` does at the head of each entry.
 * - **Fork points are read before anything moves.** A rebase is expressed as
 *   `--onto <new base> <fork point> <branch>`, and the fork point is captured
 *   as a *commit* for every queued node up front. Naming the old base by
 *   branch instead would replay the wrong range the moment that branch is
 *   itself rebuilt earlier in the same queue.
 *
 * A rebase that conflicts is aborted and the queue stops. The skill's rule
 * applies unchanged: never leave a half-rebased branch behind. Resolving it is
 * a conflict-fixer's job in the integration worktree, and the amend path does
 * not spawn agents.
 *
 * Node ids and branch names only. `git rebase` prints conflict hunks, which
 * are repository content (§11); nothing here reads its output into a message.
 */
import { Integrator, type IntegrationPlan } from '../integration/integrator.ts'
import { git, gitOk } from '../integration/git.ts'
import type { Workflow } from '../types.ts'
import type { AmendRunner, RebaseRequest } from './amend.ts'

/** A rebase git could not complete. Identifiers only, as everywhere in §8. */
export class RebaseConflictError extends Error {
  readonly nodeId: string
  readonly branch: string
  readonly base: string

  constructor(nodeId: string, branch: string, base: string) {
    super(
      `node "${nodeId}": branch ${branch} does not rebase cleanly onto ${base}. ` +
        'The rebase was aborted and no branch was left half-moved.',
    )
    this.name = 'RebaseConflictError'
    this.nodeId = nodeId
    this.branch = branch
    this.base = base
  }
}

export interface RebaserOptions {
  /** The dedicated integration worktree (§8). Never a lane: a lane may be busy. */
  readonly integrationPath: string
  /**
   * A node's base as the run recorded it — the journal's `nodes.base_branch`.
   * `null` for a node the run never assigned one to, which falls back to the
   * workflow's `base_branch`.
   */
  readonly baseOf: (nodeId: string) => string | null
  /**
   * Called after each node moves, with the ref it now sits on. This is what
   * makes the run's history explain why a base moved: the caller journals it
   * as `node_assigned`, beside the `workflow_amended` row.
   */
  readonly onRebased?: (nodeId: string, base: string) => void
}

/**
 * Builds the `rebase` member of an `AmendRunner` from an integration worktree.
 *
 * The `Integrator` is constructed per request, from the *amended* workflow:
 * the whole point is that the new bases are derived from the new graph.
 */
export function createRebaser(options: RebaserOptions): NonNullable<AmendRunner['rebase']> {
  return async function rebase(request: RebaseRequest): Promise<void> {
    const cwd = options.integrationPath
    const integrator = new Integrator({
      plan: planOf(request.workflow),
      integrationPath: cwd,
      // The amend path never authors code and never resolves a conflict: a
      // conflicting rebase stops and is reported. A fixer here would be the
      // orchestrator editing someone else's branch without a review.
      fixer: { fix: async () => {} },
    })

    // Pass one, before anything moves: where each branch actually forked from
    // the base the run recorded for it.
    const forks = new Map<string, string>()
    for (const nodeId of request.nodes) {
      const branch = integrator.nodeBranch(nodeId)
      const from = options.baseOf(nodeId) ?? request.workflow.base_branch
      forks.set(nodeId, (await git(cwd, ['merge-base', from, branch])).trim())
    }

    // Pass two, in the order given — which is topological, so a dependency has
    // always moved before the `integ-` branch that merges it is rebuilt.
    for (const nodeId of request.nodes) {
      const base = await integrator.prepareBase(nodeId)
      const branch = integrator.nodeBranch(nodeId)
      const fork = forks.get(nodeId) as string

      if (!(await gitOk(cwd, ['rebase', '--onto', base, fork, branch]))) {
        // Leaving a rebase in progress would make the integration worktree
        // unusable for every later step, including the one that reports this.
        await gitOk(cwd, ['rebase', '--abort'])
        throw new RebaseConflictError(nodeId, branch, base)
      }
      options.onRebased?.(nodeId, base)
    }
  }
}

/** `Workflow` already satisfies `IntegrationPlan` structurally; this names it. */
function planOf(workflow: Workflow): IntegrationPlan {
  return { id: workflow.id, base_branch: workflow.base_branch, nodes: workflow.nodes }
}
