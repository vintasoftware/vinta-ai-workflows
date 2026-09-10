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
