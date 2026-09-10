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
 * Where the operation went. `sent` reached the live session; `queued` is
 * waiting for the node's next resume (§9's queue for harnesses that cannot
 * inject); `delivered` is that queue draining; `ignored` is an operation on a
 * node that has already settled and has nothing left to steer.
 */
export type OperatorDelivery = 'sent' | 'queued' | 'delivered' | 'ignored'

/** Events about a run as a whole. */
interface RunPayloads {
  run_started: { readonly workflow_id: string; readonly base_branch: string }
  run_ended: { readonly status: Exclude<RunStatus, 'running'> }
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
