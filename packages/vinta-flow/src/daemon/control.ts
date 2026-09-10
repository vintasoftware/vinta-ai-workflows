/**
 * The ports the daemon drives, and nothing more.
 *
 * The API is a thin skin over units that already exist: the journal answers
 * every read, and the five §9 operations are forwarded to whoever is running
 * the run. That forwarding is declared here as a narrow interface rather than
 * as a dependency on `Scheduler`, for two reasons:
 *
 * - **The scheduler only implements two of the five.** `Scheduler` has
 *   `answer` (§9.1) and `statuses`; add-context, redirect, pause and abort all
 *   need a live `AgentSession` handle, which is the harness unit's to own and
 *   which no step has wired into the scheduler yet. Declaring the port lets
 *   this step ship the transport, the validation and the auth without
 *   pretending the mechanism behind two of the verbs exists. `runControl`
 *   below is the adapter that fills in what `Scheduler` really does have.
 * - **It is what makes the acceptance test honest.** A test that asserts "the
 *   operation reached the scheduler" against a real agent run is asserting
 *   about a model's mood. Against this port it asserts about a call.
 *
 * `PoolView` and `CapacityView` are the read-only slices of `ResourcePools`
 * and `AdmissionControl` the snapshot needs. Both are structural, so the real
 * objects satisfy them with no adapter and a stub satisfies them with three
 * methods.
 */
import type { NodeStatus } from '../journal/events.ts'
import type { GuardContext } from '../pipeline/guard.ts'
import type { HumanQuestion } from './schemas.ts'

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
   * The question a node is parked on (§9.1). Optional because no journal event
   * variant and no `await_human` param carries this shape yet — a host that
   * knows the question can surface it; one that does not reports the pause
   * alone, which the `awaiting_human` status already says.
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

/** One run the daemon serves. Registered when the run starts. */
export interface DaemonRun {
  readonly runId: string
  readonly control: RunControl
  readonly pools: PoolView
  readonly admission: CapacityView
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
  scheduler: Pick<RunControl, 'answer' | 'statuses'>,
  operations: Partial<Omit<RunControl, 'answer' | 'statuses'>> = {},
): RunControl {
  const unsupported = (verb: string) => (): never => {
    throw new UnsupportedOperation(verb)
  }
  return {
    get statuses() {
      return scheduler.statuses
    },
    answer: (nodeId, facts) => scheduler.answer(nodeId, facts),
    addContext: operations.addContext ?? unsupported('add_context'),
    redirect: operations.redirect ?? unsupported('redirect'),
    pause: operations.pause ?? unsupported('pause'),
    abortNode: operations.abortNode ?? unsupported('abort'),
    ...(operations.question === undefined ? {} : { question: operations.question }),
  }
}
