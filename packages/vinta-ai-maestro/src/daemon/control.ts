/**
 * The ports the daemon drives, and nothing more.
 *
 * The API is a thin skin over units that already exist: the journal answers
 * every read, and the five §9 operations are forwarded to whoever is running
 * the run. That forwarding is declared here as a narrow interface rather than
 * as a dependency on `Scheduler`, for two reasons:
 *
 * - **The host, not `Scheduler`, is the contract.** `Scheduler` now implements
 *   add-context, redirect, pause and abort on top of the session registry it
 *   keeps, and `runControl` forwards to whatever of them the object it is
 *   handed actually has. A host that supplies fewer — an out-of-tree runner,
 *   or a test double — still gets a `RunControl`, and the verbs behind the
 *   mechanism it lacks refuse rather than quietly succeeding.
 * - **It is what makes the acceptance test honest.** A test that asserts "the
 *   operation reached the scheduler" against a real agent run is asserting
 *   about a model's mood. Against this port it asserts about a call.
 *
 * `PoolView` and `CapacityView` are the read-only slices of `ResourcePools`
 * and `AdmissionControl` the snapshot needs. Both are structural, so the real
 * objects satisfy them with no adapter and a stub satisfies them with three
 * methods.
 */
import type { AmendRunner } from '../amend/amend.ts'
import type { NodeStatus } from '../journal/events.ts'
import type { GuardContext } from '../pipeline/guard.ts'
import type { HumanQuestion } from './schemas.ts'
import type { AgentLeaseGrant } from '../resources/agent-leases.ts'

/** The five operations of §9, plus the two reads `Scheduler` already exposes. */
export interface RunControl {
  /** Live node statuses. The journal projection is authoritative; this is the peek. */
  readonly statuses: Readonly<Record<string, NodeStatus>>
  /** §9.1 — the answer enters the guard context as `human.answer` and resumes the node. */
  answer(nodeId: string, facts: GuardContext): void | Promise<void>
  /** §9 — `session.send(text)`, or queued for the next resume. */
  addContext(nodeId: string, text: string): void | Promise<void>
  /** §9 — interrupt, then send the new instruction. */
  redirect(nodeId: string, instruction: string): void | Promise<void>
  /** §9 — finish the current turn, then `await_human`. */
  pause(nodeId: string): void | Promise<void>
  /** §9 — kill the session, mark failed, block dependents. */
  abortNode(nodeId: string): void | Promise<void>
  /**
   * Run a failed node again, and unblock what its failure blocked.
   *
   * Not one of §9's five: those steer a node that is running, and this one
   * reaches a node that has stopped. Optional, like `question`, so a host that
   * schedules its own work is not obliged to implement it — and refuses
   * honestly rather than pretending to have retried.
   */
  retry?(nodeId: string): void | Promise<void>
  /**
   * The question a node is parked on (§9.1). Optional, and rarely needed: the
   * journal projects the pending question out of the `human_question` event,
   * which is what the API serves and what survives a restart. This is the
   * escape hatch for a host that parks a node without journalling the pause.
   */
  question?(nodeId: string): HumanQuestion | undefined
}

/** The read slice of `ResourcePools` the run snapshot needs. */
export interface PoolView {
  capacity(name: string): number
  held(name: string): number
  /** Holders enqueued and not yet granted, across every pool. */
  readonly waiting: number
}

/** The read slice of `AdmissionControl` the run snapshot needs (§6.1). */
export interface CapacityView {
  ceiling(harness: string): number
  inFlight(harness: string): number
  /** Epoch ms the harness may be tried again, or `undefined` when it is not parked. */
  wakeAt(harness: string): number | undefined
}

/** Renewable leases exposed to an agent through the daemon API. */
export interface AgentLeasePort {
  /**
   * `signal` leaves the queue without taking anything — how the endpoint
   * answers a waiting client on a short cycle instead of holding one request
   * open for the length of the wait. An implementation that ignores it still
   * works; it just makes its callers wait longer for "not yet".
   */
  acquire(
    resources: readonly string[],
    holderNode: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgentLeaseGrant>
  renew(leaseId: string): AgentLeaseGrant | null
  release(leaseId: string): void
}

/** One run the daemon serves. Registered when the run starts. */
export interface DaemonRun {
  readonly runId: string
  readonly control: RunControl
  readonly pools: PoolView
  readonly admission: CapacityView
  /** Absent on read-only/test hosts that do not offer agent-held leases. */
  readonly agentLeases?: AgentLeasePort
  /**
   * §9's amend path, when this host can drive it: the live statuses the gate
   * reads, the integration worktree a `done` node is rebased in, and the hand
   * -off that lets unstarted nodes take a new definition. Optional, because a
   * host with no integration worktree can still serve a run — `src/amend/`
   * refuses an amendment that would need one rather than half-applying it.
   */
  readonly amend?: AmendRunner
}

/** Raised by `runControl` for a §9 verb the host did not supply. */
export class UnsupportedOperation extends Error {}

/**
 * Builds a `RunControl` from what `Scheduler` actually implements, letting the
 * host supply the rest. The unsupplied verbs refuse rather than silently
 * succeeding: an operator who pressed Abort and got a 200 back would believe
 * the node was killed.
 */
export function runControl(
  scheduler: Pick<RunControl, 'answer' | 'statuses'> &
    Partial<Omit<RunControl, 'answer' | 'statuses'>>,
  operations: Partial<Omit<RunControl, 'answer' | 'statuses'>> = {},
): RunControl {
  const unsupported = (verb: string) => (): never => {
    throw new UnsupportedOperation(verb)
  }
  // Destructured off the prototype, so every forward re-binds `this` to the
  // scheduler: these are class methods reaching private state.
  const { addContext, redirect, pause, abortNode, question, retry } = scheduler
  const own =
    operations.question ??
    (question === undefined ? undefined : (nodeId: string) => question.call(scheduler, nodeId))

  return {
    get statuses() {
      return scheduler.statuses
    },
    answer: (nodeId, facts) => scheduler.answer(nodeId, facts),
    addContext:
      operations.addContext ??
      (addContext === undefined
        ? unsupported('add_context')
        : (nodeId, text) => addContext.call(scheduler, nodeId, text)),
    redirect:
      operations.redirect ??
      (redirect === undefined
        ? unsupported('redirect')
        : (nodeId, instruction) => redirect.call(scheduler, nodeId, instruction)),
    pause:
      operations.pause ??
      (pause === undefined ? unsupported('pause') : (nodeId) => pause.call(scheduler, nodeId)),
    abortNode:
      operations.abortNode ??
      (abortNode === undefined
        ? unsupported('abort')
        : (nodeId) => abortNode.call(scheduler, nodeId)),
    ...(own === undefined ? {} : { question: own }),
    // Optional all the way through: a host without it answers "unsupported"
    // rather than accepting a retry it will not perform.
    ...(operations.retry !== undefined
      ? { retry: operations.retry }
      : retry === undefined
        ? {}
        : { retry: (nodeId: string) => retry.call(scheduler, nodeId) }),
  }
}
