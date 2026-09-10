/**
 * The event vocabulary.
 *
 * This is deliberately small. `events` is the only durable truth in the
 * journal, so every fact the `runs` and `nodes` projections hold must be
 * derivable from a fold over this union — if a field cannot be reconstructed
 * from these payloads, it does not belong in a projection.
 *
 * Separate from the store so the scheduler and the pipeline interpreter can
 * name events without pulling SQLite in behind them.
 */

export type RunStatus = 'running' | 'done' | 'failed'

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'waiting_on_capacity'
  | 'awaiting_human'
  | 'blocked'
  | 'done'
  | 'failed'

/**
 * §9.1's question, as it is journalled. The pause is the question — a bare
 * flag would survive a restart while the thing the operator has to answer
 * would not, which is the same as not surviving at all.
 */
export type HumanQuestionKind = 'confirm' | 'choice' | 'text'

export interface HumanQuestion {
  readonly question: string
  readonly kind: HumanQuestionKind
  readonly choices?: readonly string[]
  /** What the node view renders alongside the question. References, not content. */
  readonly context?: {
    readonly diffRef?: string
    readonly gateLogRef?: string
    readonly transcriptCursor?: number
  }
}

/** The scalar the answer re-enters the guard context with, as `human.answer`. */
export type HumanAnswer = string | number | boolean | null

/** The §9 operations that steer a node. `take over` is a PTY attach, not an event. */
export type OperatorOp = 'add_context' | 'redirect' | 'pause' | 'abort'

/**
 * Which edge of a gate-pool acquisition a `gate_pool` event marks.
 *
 * All three are needed and none is redundant: `requested` → `granted` is the
 * queue time §13.3 asks for, and `granted` → `released` is the occupancy
 * window without which saturation cannot be computed at all. The scheduler
 * also writes a `leases` row at the grant, but that table is cleared on open
 * and its rows are deleted on release, so it carries no history — see the note
 * on `leases` in `journal.ts`.
 */
export type GatePoolPhase = 'requested' | 'granted' | 'released'

/** The gate runner's verdict, as journalled. Mirrors `GateStatus` in `gates/runner.ts`. */
export type GateStatus = 'passed' | 'failed' | 'timed_out'

/**
 * Where the operation went. `sent` reached the live session; `queued` is
 * waiting for the node's next resume (§9's queue for harnesses that cannot
 * inject); `delivered` is that queue draining; `ignored` is an operation on a
 * node that has already settled and has nothing left to steer.
 */
export type OperatorDelivery = 'sent' | 'queued' | 'delivered' | 'ignored'

/**
 * How one node's definition moved between the run's frozen snapshot and the
 * amendment proposed against it (§9's amend path).
 *
 * These are *classifications*, not content: an amendment is recorded as which
 * nodes changed and in what way, never as the prose that changed. The split
 * between the topology kinds (`dependency_*`, `base_branch_changed`,
 * `node_added`, `node_removed`) and the content kinds (everything else) is the
 * one that matters at apply time — topology moves a node's *base*, content
 * moves what its branch *contains*.
 */
export type AmendmentKind =
  | 'node_added'
  | 'node_removed'
  | 'dependency_added'
  | 'dependency_removed'
  /** Same dependency set, different order — §8 merges `integ-` in that order. */
  | 'dependency_reordered'
  | 'base_branch_changed'
  | 'gates_changed'
  | 'harness_changed'
  | 'model_changed'
  | 'pipeline_changed'
  /** Name, `prompt_ref`, `touches` or `max_fix_rounds` — the phase body. */
  | 'body_changed'

/** One node and one way it moved. Both fields are identifiers. */
export interface AmendmentChange {
  readonly node: string
  readonly kind: AmendmentKind
}

/** Events about a run as a whole. */
interface RunPayloads {
  run_started: { readonly workflow_id: string; readonly base_branch: string }
  run_ended: { readonly status: Exclude<RunStatus, 'running'> }
  /**
   * §9's amend, as the run's own history: the reason a node's base moved.
   *
   * Deliberately *not* projected. The frozen snapshot on disk is the run's
   * definition and the `nodes` projection is folded out of `node_registered`,
   * `node_status` and `node_assigned` — all three of which an amendment emits
   * for the nodes it actually moves. This row is the audit trail beside them:
   * dropping every projection and replaying the log still reproduces the same
   * `runs` and `nodes` rows, which is the invariant §5.3 states.
   *
   * Every field is an identifier or a classification. `superseded` is the
   * run-relative path the previous snapshot was kept at, so the history points
   * at the old definition rather than carrying a copy of it.
   */
  workflow_amended: {
    /** 1 for the first amendment of a run, and one more for each after it. */
    readonly amendment: number
    readonly changes: readonly AmendmentChange[]
    /** The changed nodes plus their transitive dependents, topologically ordered. */
    readonly affected: readonly string[]
    /** Not-yet-started nodes that took the change immediately. */
    readonly applied: readonly string[]
    /** Already-`done` nodes rebased, in the order they were rebased. */
    readonly rebased: readonly string[]
    readonly superseded: string
  }
}

/**
 * Events about one node. `node_assigned` is a partial patch — the scheduler
 * learns a node's lane, its branch and its harness session id at three
 * different moments, and inventing an event per field buys nothing.
 */
interface NodePayloads {
  node_registered: { readonly wave: number; readonly harness: string }
  node_status: { readonly status: NodeStatus }
  node_assigned: {
    readonly lane?: string
    readonly branch?: string
    readonly base_branch?: string
    readonly session_id?: string
  }
  /**
   * §9.1's pause, question and all. Journalled *before* the effect that raises
   * the notification, so a daemon that comes back up reads the pending
   * question out of the log instead of re-asking it: delivery is once per
   * pause, and the pause is this row.
   */
  human_question: HumanQuestion & { readonly effect_id: string }
  /** The answer. It re-enters the guard context as `human.answer` (§9.1). */
  human_answered: { readonly effect_id: string; readonly answer: HumanAnswer }
  /**
   * One §9 operation. `text` is the operator's own steering message: it is
   * payload, exactly as a transcript entry is, and it never reaches a log line
   * or an error string.
   */
  node_operation: {
    readonly op: OperatorOp
    readonly text?: string
    readonly delivery: OperatorDelivery
  }
  /**
   * One edge of a gate-pool acquisition, for the whole set the gate needs —
   * acquisition is all-or-nothing and in one `pools.acquire` call (§6), so a
   * per-resource event would claim an ordering the scheduler does not have.
   * Pool ids only; which gate is about to run is `gate_result`'s subject.
   */
  gate_pool: { readonly phase: GatePoolPhase; readonly resources: readonly string[] }
  /**
   * What one gate returned. Identifiers, an exit code and a status — the
   * gate's *output* is repository content and stays in `gates/<id>.log`
   * (§5.3, §11), which is why there is no field here it could reach.
   */
  gate_result: {
    readonly gate: string
    readonly exit_code: number
    readonly status: GateStatus
  }
}

type RunEventOf<T extends keyof RunPayloads> = T extends T
  ? { readonly runId: string; readonly type: T; readonly payload: RunPayloads[T] }
  : never

type NodeEventOf<T extends keyof NodePayloads> = T extends T
  ? {
      readonly runId: string
      readonly nodeId: string
      readonly type: T
      readonly payload: NodePayloads[T]
    }
  : never

/** An event as handed to `append`: no id, no timestamp — the journal assigns both. */
export type NewEvent = RunEventOf<keyof RunPayloads> | NodeEventOf<keyof NodePayloads>

/**
 * An event as read back: `id` is the total order, `ts` is epoch milliseconds.
 * Distributed over the union rather than intersected with it, so a `switch` on
 * `type` still narrows the payload.
 */
export type StoredEvent = NewEvent extends infer E
  ? E extends NewEvent
    ? E & { readonly id: number; readonly ts: number }
    : never
  : never
