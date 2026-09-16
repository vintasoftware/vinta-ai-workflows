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

/**
 * Which edge of an agent-held lease an `agent_lease` event marks.
 *
 * Two, where `gate_pool` has three, and the missing one is `requested`. An
 * agent does not queue *here*: the daemon's lease endpoint answers "not yet"
 * on a short cycle and the client asks again, so a wait is a sequence of
 * requests that each entered and left the pool queue. A `requested` row per
 * hop would count polls, not waiting — and the one row that could honestly
 * mark the start of a wait is the client's, which this process never sees.
 */
export type AgentLeasePhase = 'acquired' | 'released'

/** The gate runner's verdict, as journalled. Mirrors `GateStatus` in `gates/runner.ts`. */
export type GateStatus = 'passed' | 'failed' | 'timed_out'

/** Whether a spawn continued its slot's session or started a new one (§15). */
export type SessionDisposition = 'reused' | 'fresh'

/**
 * Why a spawn started a fresh session instead of continuing one. A closed set,
 * because these rows are what make "reuse is not happening" diagnosable — a
 * free-text reason would be unqueryable, and a vendor's own words about a
 * session are prose this payload may not carry (§11).
 *
 * `no_slot` is the ordinary case and not a degradation: a `spawn_agent` that
 * names no `session` is asking for a cold turn, which is what every pipeline
 * authored before §15 does.
 */
export type SessionFreshReason =
  /** The effect named no slot. Today's default behaviour. */
  | 'no_slot'
  /** The slot has no entry yet — the first turn of a session has to be one. */
  | 'no_prior_session'
  /** This turn runs on a different harness than the one that opened the slot. */
  | 'harness_changed'
  /**
   * The node is in a different lane than the slot's session ran in. A capacity
   * refusal re-drives a node's whole pipeline in a fresh lane (§6.1, §15.2), and
   * a session resumed into a worktree it has never seen would be reasoning about
   * paths and file states that are no longer there.
   */
  | 'lane_changed'
  /** The harness cannot continue a session at all (`capabilities.resume`). */
  | 'no_resume_capability'
  /** The slot hit `defaults.max_session_turns` (§15.5). */
  | 'turn_ceiling'
  /**
   * The last fix round, deliberately handed to an agent that has not seen the
   * work (§15.5). The author already tried and failed; its assumptions are now
   * a liability rather than context.
   */
  | 'final_fix_round'
  /** The vendor no longer has the session; the spawn was retried cold (§15.4). */
  | 'stale_session'
  /**
   * The member's previous phase failed. Its session is the context that failed
   * with it, and carrying that into the next phase propagates whatever wrong
   * turn it took — a cold start is cheaper than a poisoned one.
   */
  | 'prior_phase_failed'

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
  /**
   * A node's status, and on `failed` why.
   *
   * The reason used to live only in the scheduler's memory and the run's
   * terminal output, which meant a finished run could say *that* a node failed
   * and never *why*. Two runs failing for two different causes produced two
   * identical rows, and the only way back to the cause was the operator's
   * scrollback.
   *
   * It is a **sanitized** reason (`failureReason`), not an arbitrary error
   * message: the package's own errors are built from identifiers and are kept
   * verbatim, and anything else is reduced to its kind (§11). The journal is
   * durable and is served over the API; an exception message from a dependency
   * is exactly the place repository content leaks into one.
   */
  node_status: { readonly status: NodeStatus; readonly reason?: string }
  node_assigned: {
    readonly lane?: string
    readonly branch?: string
    readonly base_branch?: string
    readonly session_id?: string
    /**
     * What the phase branch pointed at *before* this attempt took it over, or
     * null on the first one. A commit id, which is an identifier and not
     * repository content.
     *
     * It exists because the alternative record was a reflog. A retry used to
     * reset the phase branch to base, and the only evidence that an attempt's
     * commits had ever existed was `git reflog show <branch>` — which nobody
     * reads unless they already suspect. Retries keep their predecessor's work
     * now, so this is mostly a no-op; it is recorded anyway, because the case
     * worth seeing is the one where something moved a branch and nothing in the
     * run said so.
     */
    readonly previous_head?: string | null
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
   * What one spawn decided about its session slot (§15).
   *
   * Journalled at the spawn, which is the moment the decision is taken — not
   * at `session_started`, which is when the *id* becomes known and which
   * `node_assigned` already carries. A `fresh` row therefore always states why
   * it was fresh, from a closed set of tokens: a run that quietly stopped
   * reusing sessions and one that never started are otherwise identical from
   * the outside, and the first is a bug while the second is a configuration.
   *
   * `session_id` is present only on a `reused` row, and is the id being
   * continued. Ids are identifiers, exactly as `node_assigned.session_id` is;
   * no prompt text, no agent output and no vendor prose reaches this payload.
   */
  node_session: {
    readonly slot: string
    readonly disposition: SessionDisposition
    /** The id being continued. Present on `reused`, absent on `fresh`. */
    readonly session_id?: string
    /** Why fresh, from a closed set. Absent on `reused`. */
    readonly reason?: SessionFreshReason
  }
  /**
   * Who took this node, and whether the plan named them.
   *
   * Journalled once per attempt, at the claim — before the lane is acquired, so
   * a node that then waits on capacity is already on the record as staffed. A
   * `substitute` row is the interesting one: it says the plan's staffing and
   * the run's staffing diverged, which is how a feature comes in dearer than
   * the roster predicted without anything having gone wrong.
   *
   * Ids and an integer tier. A member is a staffing decision, not an agent's
   * words: nothing a model wrote reaches this payload (§11).
   */
  node_crew: {
    readonly member: string
    readonly tier: number
    /** True when the plan named someone else and they were busy. */
    readonly substitute: boolean
    /** Who the plan named. Present only on a substitution. */
    readonly instead_of?: string
    /**
     * Which seat this claim filled. Absent means `implementer`, so rows written
     * before reviewers were members read as what they were.
     */
    readonly role?: 'implementer' | 'reviewer'
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
  /**
   * One edge of a lease an *agent* holds — a command it runs inside its own
   * turn through `vinta-ai-maestro with`, brokered by `resources/agent-leases.ts`.
   *
   * It exists because writing the `leases` row was not enough. That row is
   * read by the daemon's snapshot and reported correctly, but a projection
   * nobody is told changed is a projection nobody sees change: the browser
   * re-reads the snapshot when a frame arrives, so a table write with no event
   * behind it left the resource panel showing the holders it had last time
   * some unrelated event happened to land. The queue was moving and the screen
   * said it was stalled — worst for agent waits, which are the long ones.
   *
   * Separate from `gate_pool` because the holder is separate. A gate's pools
   * are taken by the scheduler around a gate it is about to run; an agent's
   * are taken by the agent's inner loop and held for as long as its command
   * lives. They land in the same table and the same meters, and only one of
   * them was ever announced.
   *
   * `lease_id` has no counterpart in `gate_pool` because one node can hold
   * several agent leases at once — the broker keys them by id — so without it
   * an `acquired` row could not be paired with the `released` row ending it.
   *
   * A renewal writes nothing. It is a liveness heartbeat on a lease already
   * reported, repeated every TTL for as long as the command runs, and nothing
   * about the holder set changes when one lands. Journalling it would bury the
   * two rows that are transitions under a heartbeat log.
   *
   * Pool ids and a lease id, beside the node id the event is already keyed by.
   * The broker is never told what command the lease is for, so there is no
   * field here that a command line or a line of repository text could reach
   * (§11).
   */
  agent_lease: {
    readonly phase: AgentLeasePhase
    readonly lease_id: string
    readonly resources: readonly string[]
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
