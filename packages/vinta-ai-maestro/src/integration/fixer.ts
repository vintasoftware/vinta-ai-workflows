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
import {
  attribute,
  CONFLICT_FIXER_ROLE,
  type Attribution,
  type TranscriptEntry,
} from '../journal/transcript.ts'
import { composeConflictPrompt } from '../prompts/index.ts'

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
  /** 1-based. Exhausting the rounds hands the conflict to a person, not to a harder retry. */
  readonly round: number
}

/** One method, so the scheduler can inject a real agent and a test a spy. */
export interface ConflictFixer {
  fix(request: ConflictRequest): Promise<void>
}

/** One conflict's staffing: the capability to spawn with, never a session. */
export interface FixerAgent {
  readonly adapter: HarnessAdapter
  readonly model: string
  /** Which of the conflicting nodes this agent's member implemented. */
  readonly implemented?: readonly string[]
}

export interface AgentConflictFixerOptions {
  /** Used when `staff` is absent or declines — `defaults`, in a composed run. */
  readonly adapter: HarnessAdapter
  readonly model: string
  /**
   * The integration worktree's environment, for the agent about to run in it.
   *
   * The integration worktree is a lane in every way that costs a port or a
   * volume, and `AgentTask.env` says what happens to an agent that runs without
   * its lane's: with the daemon's bare environment `COMPOSE_PROJECT_NAME` is
   * unset, docker falls back to naming the project after the directory, and the
   * stack comes up under a name nothing else in the run reserved. That is not
   * hypothetical — a fix round brought a second stack up in the integration
   * worktree and published 5432, 6379, 4566, 1025 and 8025 on the host, because
   * `compose.publish: []` is delivered through the `COMPOSE_FILE` override that
   * only this environment carries. It collided with the developer's own stack
   * and outlived the run.
   *
   * Absent means "no project isolation to deliver" — an injected fixer in a
   * test, or a workflow with no `project` block — never "run bare on purpose".
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Who this particular conflict goes to, resolved per call because staffing
   * depends on *which* nodes are in the conflict and that is only known once
   * the merge has failed (`integration/staffing.ts`). Returning null keeps the
   * `adapter`/`model` above, which is the pre-roster path.
   */
  readonly staff?: (request: ConflictRequest) => FixerAgent | null
  /**
   * Where the fix round's turn is written down.
   *
   * The stream below has always been drained — an unread one never ends — and
   * until now every event was dropped on the floor. So the one agent turn in a
   * run that nobody could watch was also the one nobody could read afterwards:
   * a phase spent minutes resolving a merge and left a resolved commit, a
   * `node_conflict` row saying it took two rounds, and no record of what was
   * actually decided or why.
   *
   * A callback rather than a `Journal`, because this module knows about
   * adapters and prompts and deliberately not about storage — the comment in
   * the drain loop has said persistence belongs to the caller since it was
   * written, and this is the seam that finally lets the caller do it.
   */
  readonly record?: (nodeId: string, entry: TranscriptEntry) => void
}

/**
 * The real fixer: a `conflict-fixer` agent spawned in the integration worktree.
 *
 * `cwd` comes from the request rather than from configuration, because the one
 * invariant worth enforcing here is that the fixer runs where the merge is —
 * an agent pointed at a lane would resolve a conflict in a tree the merge
 * cannot see, and the lane's own phase would inherit the edit.
 *
 * *Which* agent is `staff`'s answer, one conflict at a time, because the nodes
 * in a conflict are what decide it (`integration/staffing.ts`). It supplies a
 * model, a harness and the node ids the member implemented — never a session
 * id; the reason that distinction is load-bearing is written down there.
 */
export function createAgentConflictFixer(options: AgentConflictFixerOptions): ConflictFixer {
  return {
    async fix(request: ConflictRequest): Promise<void> {
      const staffed = options.staff?.(request) ?? null
      const context =
        staffed?.implemented === undefined
          ? request
          : { ...request, implemented: staffed.implemented }
      const task: AgentTask = {
        nodeId: request.nodeId,
        cwd: request.cwd,
        // The same composer every other role's prompt comes from, so a change
        // to what an agent is told stays one edit (`src/prompts`).
        prompt: composeConflictPrompt(context),
        model: staffed?.model ?? options.model,
        // Options, not `staff`: the environment belongs to the *worktree*, and
        // every conflict in a run is fixed in the same one. Which member is
        // holding the keyboard changes nothing about which compose project the
        // commands they run must resolve to.
        ...(options.env === undefined ? {} : { env: options.env }),
        // No `resumeSessionId`, deliberately, even when the staffed member has
        // a live session from the phase they just implemented. That session ran
        // in their lane; this runs in the integration worktree, where the files
        // in dispute are half-merged and unlike anything the session saw. §15.2
        // would refuse the resume anyway — `lane_changed` is its first rule —
        // and asking for one here would only encode the wrong intent for
        // whoever reads this next.
      }
      const adapter = staffed?.adapter ?? options.adapter
      const outcome = await adapter.spawn(task)
      if (!outcome.ok) throw new Error(`conflict fixer spawn refused: ${outcome.kind}`)

      // Draining is mandatory — an unread stream never ends — and the outcome
      // is deliberately not inspected: whether the conflict is actually
      // resolved is answered by the worktree, not by what the agent said. A
      // fixer that gave up costs a round rather than failing the run.
      //
      // Filed against the incoming node, which is the phase whose merge hit the
      // conflict and the one an operator is looking at. Under its own role, so
      // a phase transcript that already interleaves an implementer, a reviewer
      // and review fixers does not quietly gain a fourth voice indistinguishable
      // from the third: a conflict fixer works in the integration worktree on a
      // merge, not in the lane on the phase, and reading it as the review fixer
      // would be reading it as the wrong job.
      const by: Attribution = { role: CONFLICT_FIXER_ROLE }
      for await (const event of outcome.session.events) {
        // `attribute` for §7's reason: the operator's steering arrives on this
        // same stream, echoed back by the adapter, and must not be filed as the
        // agent's words.
        options.record?.(request.nodeId, { ...event, by: attribute(event, by) })
      }
    },
  }
}
