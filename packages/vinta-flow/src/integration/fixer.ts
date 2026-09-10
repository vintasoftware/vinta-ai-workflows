/**
 * The conflict fixer seam.
 *
 * The orchestrator never edits code — not a phase's code, and not a merge
 * conflict either. A conflict is a coding task, and coding tasks go to an
 * agent. What the orchestrator owns is where that agent runs (the dedicated
 * integration worktree, never a lane that is still working), how many rounds
 * it gets, and what happens when it runs out.
 *
 * The request carries **identifiers only** — node ids, branch names, conflicted
 * paths and the plan references where the two phase briefs live. It never
 * carries a hunk: the agent is standing in the worktree and can read the
 * conflict itself, and putting file contents in a request is how they end up
 * in a log.
 */
import type { AgentTask, HarnessAdapter } from '../harness/adapter.ts'

export interface ConflictRequest {
  /** The integration worktree. The fixer runs here and nowhere else. */
  readonly cwd: string
  /** The branch being merged into. */
  readonly into: string
  /** The branch whose merge conflicted. */
  readonly incoming: string
  /** The node that branch belongs to. */
  readonly nodeId: string
  /** Every node that changed a conflicted path — the incoming one included. */
  readonly nodes: readonly string[]
  readonly paths: readonly string[]
  /** Where each involved node's phase brief lives, for the fixer to read. */
  readonly promptRefs: readonly string[]
  /** 1-based. Exhausting the rounds is a plan defect, not a harder retry. */
  readonly round: number
}

/** One method, so the scheduler can inject a real agent and a test a spy. */
export interface ConflictFixer {
  fix(request: ConflictRequest): Promise<void>
}

export interface AgentConflictFixerOptions {
  readonly adapter: HarnessAdapter
  readonly model: string
}

/**
 * The real fixer: a `conflict-fixer` agent spawned in the integration worktree.
 *
 * `cwd` comes from the request rather than from configuration, because the one
 * invariant worth enforcing here is that the fixer runs where the merge is —
 * an agent pointed at a lane would resolve a conflict in a tree the merge
 * cannot see, and the lane's own phase would inherit the edit.
 */
export function createAgentConflictFixer(options: AgentConflictFixerOptions): ConflictFixer {
  return {
    async fix(request: ConflictRequest): Promise<void> {
      const task: AgentTask = {
        nodeId: request.nodeId,
        cwd: request.cwd,
        prompt: instructions(request),
        model: options.model,
      }
      const outcome = await options.adapter.spawn(task)
      if (!outcome.ok) throw new Error(`conflict fixer spawn refused: ${outcome.kind}`)

      // Draining is mandatory — an unread stream never ends — and the outcome
      // is deliberately not inspected: whether the conflict is actually
      // resolved is answered by the worktree, not by what the agent said. A
      // fixer that gave up costs a round rather than failing the run.
      for await (const _event of outcome.session.events) {
        // Transcript persistence belongs to the caller that owns the journal.
      }
    },
  }
}

/**
 * Paths and plan references, plus the one rule a fixer must not break: a
 * conflict resolved by taking a side deletes half of what the plan asked for,
 * and does it invisibly.
 */
function instructions(request: ConflictRequest): string {
  return [
    `Resolve the merge conflict from merging ${request.incoming} into ${request.into}.`,
    `Conflicted paths: ${request.paths.join(' ')}`,
    `Nodes involved: ${request.nodes.join(' ')}`,
    `Phase briefs: ${request.promptRefs.join(' ')}`,
    'Resolve for both phases’ intents. Never resolve with --ours or --theirs.',
  ].join('\n')
}
