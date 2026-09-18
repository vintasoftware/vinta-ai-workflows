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
 * Why a phase went to somebody other than the member the plan named. A closed
 * set, for the same reason the one above is: a `substitute` row is how a run
 * comes in dearer than the roster predicted, and it is only answerable if the
 * row says which kind of substitution it was.
 *
 * Declared here rather than in `scheduler/crew.ts` so the payload's vocabulary
 * lives with the payload, exactly as `SessionFreshReason` does for the module
 * that decides it (`scheduler/sessions.ts` imports this file, not the reverse).
 */
/**
 * Which seat a `node_crew` claim filled.
 *
 * Named rather than written inline on the payload, so the one fold that has to
 * tell the two apart can be held to the set exhaustively (`usage/crew.ts`).
 * That is not tidiness: the rollup ignored this field for as long as it
 * existed, counted every reviewer's claim as a phase that member *took*, and
 * reported an inflated node count for every run that had reviewers at all. The
 * cost of a third seat being added and silently folded into one of these two is
 * the same bug again, so adding one here is meant to break that fold's build.
 *
 * Mirrors `CREW_ROLES` in `types.ts`, which is the schema's side of the same
 * vocabulary. Kept as its own declaration rather than an import because this
 * file deliberately imports nothing — the payload vocabulary lives with the
 * payload — and the two are held together by `crew.ts`'s own check.
 */
export type CrewRole = 'implementer' | 'reviewer'

export type CrewSubstituteReason =
  /**
   * The named member was working, and somebody at or above their tier covered
   * so the phase would not queue behind them. Costs what the plan budgeted:
   * the floor guarantees the cover was qualified, and `assignCrew` takes the
   * cheapest member who is.
   */
  | 'peer_busy'
  /**
   * The phase was promoted to a member who already holds a session it can
   * resume, ahead of a cheaper member who would have started cold (§15).
   *
   * The one substitution that is a deliberate overspend rather than the roster
   * absorbing load: the named member may well have been free. What it buys is
   * the context a cold session would have to rebuild before writing a line;
   * what it costs is the dearer model for the whole phase. Both halves are
   * real, which is why this is its own token instead of another `peer_busy`.
   */
  | 'warm_session'

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
   * A run picked up again by a process that did not start it.
   *
   * Its own event rather than a second `run_started`, for a reason the
   * projection makes plain: `run_started` is an `INSERT OR REPLACE` carrying
   * `started_at`, so replaying it would move the run's start to whenever
   * someone last resumed it. A run that took three days across four processes
   * would report having begun on the last one, and every duration derived from
   * that row — the post-mortem's, the UI's — would be wrong by the length of
   * the outage.
   *
   * `attempt` counts *hosting* processes, not retries: 2 on the first resume.
   * It is what lets the history distinguish a phase that ran twice because it
   * failed from one that ran twice because the machine rebooted underneath it.
   */
  run_resumed: { readonly attempt: number }
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
  /**
   * Why one *attempt* at a node failed — written whatever happens next.
   *
   * Distinct from `node_status: 'failed'`, which records the node giving up.
   * Most failures never reach that: under the default `onFailure: retry` an
   * attempt is retried automatically or parked on a question, and the node is
   * `running` again moments later. Those attempts used to leave no trace at
   * all, so a phase that failed three times in provisioning — before any agent
   * ran, so with no transcript and no gate log either — was undiagnosable
   * after the fact, and the only offered action was to repeat it.
   *
   * Not projected, deliberately. `nodes` is folded out of `node_registered`,
   * `node_status` and `node_assigned`, and this must not disturb any of them:
   * the node's status is whatever the attempt after this one makes it. It is
   * the audit trail beside them, in §5.3's sense — drop every projection,
   * replay the log, and the same rows come back.
   *
   * `reason` is a classification, never a command's output (§11). The error
   * itself, message included, goes to the daemon log.
   */
  node_error: {
    readonly reason: string
    /** 1 for the first attempt at this node, and one more for each after it. */
    readonly attempt: number
  }
  /**
   * A merge conflict an agent settled, filed against the node whose merge hit
   * it.
   *
   * Conflicts are an ordinary outcome here, not an exception: the plan's file
   * overlap analysis is a guess, two sibling phases legitimately edit one file,
   * and the conflict fixer exists because of it. What was missing is any record
   * that one happened. A phase would sit in `running` for minutes while an
   * agent merged in a worktree nobody was looking at, and the only trace
   * afterwards was a reflog entry in the integration checkout.
   *
   * `where` separates the two merges that can produce one. `base` is a
   * multi-dependency node's `integ-<id>`, built *before* the phase runs — so a
   * conflict there delays work that has not started. `wave` is the spine merge
   * after a phase finishes, where the work is already done.
   *
   * Identifiers, paths and a count (§11) — never the conflicted hunks, which
   * are repository content and stay in the worktree.
   */
  /**
   * The pull request a finished phase opened, or did not.
   *
   * `openPullRequest` never throws — reporting a finished run is not the work
   * the run did, and a missing or unauthenticated `gh` must not turn hours of
   * completed phases into a failed run. But its result was discarded, so
   * "never fails" had quietly become "never tells you": one phase in an
   * observed run completed with no pull request, and the only way to find out
   * was to notice the gap in a list on the forge.
   *
   * A URL, a branch pair and a refusal code. The refusal's own `message` is
   * deliberately not carried: it is composed from whatever `gh` said, and this
   * row is served over the API.
   */
  node_pr: {
    readonly opened: boolean
    readonly base: string
    readonly head: string
    readonly url?: string
    readonly reason?: 'unavailable' | 'failed'
  }
  node_conflict: {
    readonly where: 'base' | 'wave'
    /** The branch the merge was made on. */
    readonly branch: string
    /** Every node whose work is in the conflict, not only the incoming one. */
    readonly nodes: readonly string[]
    readonly paths: readonly string[]
    /** Fix rounds the agent needed. 1 is first-try. */
    readonly rounds: number
  }
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
  /**
   * `unattended` marks an answer the scheduler gave itself because nobody did
   * — the `retry_after` timer expiring on a failure question. Absent means a
   * person chose it.
   *
   * On the row rather than inferred, because the two are the same answer with
   * very different meanings: "a human looked at this and said try again" and
   * "nobody was here, so it tried again". A post-mortem that cannot tell them
   * apart reports an operator decision that was never made.
   */
  human_answered: {
    readonly effect_id: string
    readonly answer: HumanAnswer
    readonly unattended?: true
  }
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
    /** True when the plan named someone else. */
    readonly substitute: boolean
    /** Who the plan named. Present only on a substitution. */
    readonly instead_of?: string
    /**
     * Why somebody else took it. Present only on a substitution, and absent on
     * rows written before there were two ways to be one — which read as
     * `peer_busy`, because that was the only way then.
     *
     * The field that makes a `substitute` row answerable. `peer_busy` is the
     * roster absorbing its own load and costs what the plan budgeted. A
     * `warm_session` row is a phase that could have run as planned and was
     * promoted anyway to reuse a session already open: cheaper in cold starts,
     * dearer per token, and the trade an operator has to be able to see before
     * they can judge whether it was worth it.
     */
    readonly reason?: CrewSubstituteReason
    /**
     * Which seat this claim filled. Absent means `implementer`, so rows written
     * before reviewers were members read as what they were.
     */
    readonly role?: CrewRole
  }
  /**
   * One edge of a gate-pool acquisition, for the whole set the gate needs —
   * acquisition is all-or-nothing and in one `pools.acquire` call (§6), so a
   * per-resource event would claim an ordering the scheduler does not have.
   * Pool ids only; which gate is about to run is `gate_result`'s subject.
   */
  gate_pool: { readonly phase: GatePoolPhase; readonly resources: readonly string[] }
  /**
   * One gate began running, at this event's `ts`.
   *
   * Its own event rather than a field on the result, because the question it
   * answers — "what is this phase doing right now, and for how long" — can
   * only be asked while there is no result yet. The node view reads the pair
   * and shows a gate as running with a live clock until the result lands.
   *
   * Written by the runner's `onStart`, so the gap to the matching
   * `gate_result` is the gate's runtime and not its queue time. A gate served
   * from the cache never emits one: nothing started.
   */
  gate_started: { readonly gate: string }
  /**
   * What one gate returned. Identifiers, an exit code and a status — the
   * gate's *output* is repository content and stays in `gates/<id>.log`
   * (§5.3, §11), which is why there is no field here it could reach.
   *
   * `duration_ms` and `cached` are the two facts a reader cannot reconstruct
   * from the surrounding events. Duration is the runner's own measurement
   * rather than the distance between two journal rows, so it survives a
   * cached verdict (where it is what the gate cost *when it last ran*) and a
   * restart between the start and the result. `cached` is what stops the
   * figure being read as time this run spent.
   */
  gate_result: {
    readonly gate: string
    readonly exit_code: number
    readonly status: GateStatus
    readonly duration_ms: number
    readonly cached: boolean
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
