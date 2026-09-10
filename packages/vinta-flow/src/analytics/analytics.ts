/**
 * Critical-path and queue analytics over a recorded run (§13.3).
 *
 * §13.1 answers "given these durations, what *would* the schedule be". This
 * answers the other half: given a run that actually happened, where did the
 * wall clock go. Same shape of analysis — a fold over a tape, then a backward
 * walk over the observed schedule — but the tape is the journal's event log
 * rather than a simulator's records, so the numbers describe a run instead of
 * a projection.
 *
 * **Why this is not `import { criticalPath } from '../simulate/simulate.ts'`.**
 * The walk is twenty lines and is duplicated here on purpose. `simulate.ts` is
 * a dev tool: it boots the real scheduler against mock adapters, a virtual
 * clock and a throwaway SQLite journal in a temp dir, and its `criticalPath` is
 * a module-private function over its own `SimulatedNode`. Importing it would
 * pull that whole module graph — `MockAdapter`, `VirtualClock`, `mkdtempSync` —
 * behind a product feature, to reuse a loop whose only shared parameter is
 * "which dependency finished last". The honest shared abstraction is a backward
 * walk over `{ id, endsAtMs, deps }` living in `graph.ts` beside `computeWaves`;
 * that file is not this module's to change, so the approach is shared and the
 * loop is not.
 *
 * **The source is structural, like `usage.ts`'s.** `Journal` satisfies
 * `AnalyticsSource` and so does a fake, which is what lets these figures be
 * tested against a journal whose timestamps are chosen rather than measured —
 * `Journal.append` stamps `Date.now()`, so a real one cannot express "this node
 * queued for exactly four minutes". It also means this module survives the
 * journal growing methods.
 *
 * **What the log can and cannot attribute.** Four of the five ways a node
 * spends time are recorded and are reported exactly:
 *
 * | bucket          | derived from                                            |
 * |-----------------|---------------------------------------------------------|
 * | lane queue      | `node_status: running` → the `node_assigned` carrying `lane` |
 * | working         | lane held, node not parked                              |
 * | capacity wait   | `node_status: waiting_on_capacity` → the next `running`  |
 * | suspended       | `node_status: awaiting_human` → the next `running`       |
 *
 * The fifth — time queued for a **gate's** pool — is **not recorded anywhere**.
 * The scheduler takes those pools with `journal.acquireLease`, which writes a
 * `leases` row: a table that is cleared on open and whose rows are deleted on
 * release, so it carries no grant time that outlives the wait and no history at
 * all. No event marks the attempt, the grant or the release. That time is
 * therefore inside `workingMs`, indistinguishable from an agent turn, and this
 * module reports `gatePoolQueueMs: null` and a `gate_pool_queue_unrecorded`
 * gap rather than a zero or an inferred number. §6.1 already had to put
 * capacity waits in a side table for the same reason the event union has no
 * room for this; the fix is an event, not an estimate here.
 *
 * **The attribution reconciles, exactly.** Two identities hold on every run,
 * complete or in progress, and are the point of the module:
 *
 *   laneQueueMs + workingMs + capacityWaitMs + suspendedMs === spanMs
 *   Σ (step.gapMs + step.spanMs) + tailGapMs                === elapsedMs
 *
 * The gaps are not slack absorbed into a bucket — they are reported, so a chain
 * that does not account for the whole run says so instead of quietly rounding.
 *
 * Identifiers and durations only: node ids, pool ids, waves, epoch
 * milliseconds. Nothing here reads a transcript, a prompt, a branch or a lane
 * path.
 */
import type { NodeStatus, RunStatus, StoredEvent } from '../journal/events.ts'
import type { Workflow } from '../types.ts'

/** The pool every node is dispatched into. Required of every workflow (§5.1). */
const LANE = 'lane'

/**
 * The slice of the journal this module needs. Structural on purpose — see the
 * module comment. `sinceId` is accepted because `Journal.events` takes it; this
 * module always reads a whole run.
 */
export interface AnalyticsSource {
  readWorkflow(runId: string): Workflow
  events(runId: string, sinceId?: number): readonly StoredEvent[]
}

export interface AnalyzeOptions {
  /**
   * The end of the observed window for a run that has not ended. Defaults to
   * the last event's timestamp, which is the last moment the log can vouch
   * for — a wall-clock `Date.now()` would report idleness the journal has no
   * evidence of.
   */
  readonly nowMs?: number
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Where one node's span went. The four figures partition it exactly; the
 * fifth is a subset of `workingMs` that the journal cannot separate out.
 */
export interface TimeSplit {
  /** `finishedAtMs - startedAtMs`, or `asOf - startedAtMs` while in flight. 0 if never dispatched. */
  readonly spanMs: number
  /** Dispatched, waiting for a lane slot. Summed over every attempt, including post-capacity-wait retries. */
  readonly laneQueueMs: number
  /**
   * Lane held and the node not parked. Agent turns, gate runs — **and** any
   * time spent queued for a gate's pool, which the event log does not mark.
   * Read it as "holding a lane and not visibly waiting", not as "running".
   */
  readonly workingMs: number
  /** `waiting_on_capacity`: a vendor refused a spawn and the node is inside a backoff window (§6.1). */
  readonly capacityWaitMs: number
  /** `awaiting_human`: parked on an `await_human` question or an operator pause (§9.1). */
  readonly suspendedMs: number
  /**
   * Time inside `workingMs` spent queued for a gate's pool. Always `null`
   * today: nothing in the event vocabulary records a gate-pool acquisition.
   * A number here would be an invention — see `AttributionGap`.
   */
  readonly gatePoolQueueMs: number | null
}

export interface NodeAnalytics {
  readonly nodeId: string
  readonly wave: number
  readonly status: NodeStatus
  /** The `node_status: running` that dispatched it. `null` for a node that never started. */
  readonly startedAtMs: number | null
  /** `null` while the node is still in flight. */
  readonly finishedAtMs: number | null
  /** Started and not settled inside the observed window. Its `spanMs` is a floor. */
  readonly inFlight: boolean
  readonly split: TimeSplit
}

/** One hop on the chain that produced the observed elapsed time. */
export interface CriticalPathStep {
  readonly nodeId: string
  readonly wave: number
  /**
   * Time between the previous hop finishing (the run starting, for the first
   * hop) and this node being dispatched. Reported rather than folded into a
   * bucket: unattributed time on the critical path is a finding.
   */
  readonly gapMs: number
  readonly startedAtMs: number
  /** Where the span ends: the finish, or the observed window's end while in flight. */
  readonly endsAtMs: number
  readonly split: TimeSplit
}

/**
 * What one pool cost the run. `unattributed` is not "zero contention" — it is
 * "the log does not say", which for every pool but `lane` is currently the
 * only truthful answer.
 */
export type PoolContention =
  | {
      readonly resource: string
      readonly capacity: number
      readonly attribution: 'exact'
      /** Most slots held at once. Below capacity means the pool never blocked anyone. */
      readonly peakHeld: number
      /** How long at least one slot was held. */
      readonly busyMs: number
      /** How long every slot was held — the window in which the pool could block someone. */
      readonly saturatedMs: number
      /** Summed time nodes spent queued for this pool before being granted. */
      readonly queuedMs: number
    }
  | {
      readonly resource: string
      readonly capacity: number
      readonly attribution: 'unattributed'
      readonly reason: AttributionGapKind
    }

/**
 * The number that says whether the graph or the pool is the constraint.
 *
 * A free lane is a lane nobody could use: the pool grants on arrival, so a node
 * queued for a lane and a free lane cannot coexist. Idle lane time is therefore
 * always graph-bound time — a run at `idleFraction` 0.75 is waiting on its own
 * dependency chain, and buying lanes would buy nothing.
 */
export interface LaneIdleness {
  readonly capacity: number
  /** `capacity × elapsedMs`: every lane-millisecond the run could have used. */
  readonly slotMs: number
  /** Lane-milliseconds no node held. */
  readonly idleSlotMs: number
  /** `idleSlotMs / slotMs`, in [0, 1]. 0 when the pool never had a spare slot. */
  readonly idleFraction: number
  /** Wall-clock time with at least one lane free. */
  readonly freeWallMs: number
}

export type AttributionGapKind = 'gate_pool_queue_unrecorded' | 'gate_pool_occupancy_unrecorded'

/**
 * A figure the journal cannot supply. Carried in the report rather than thrown
 * or defaulted to zero: a consumer that shows a gate-pool number has to reach
 * past an explicit statement that there is none.
 *
 * Identifiers and static text only.
 */
export interface AttributionGap {
  readonly kind: AttributionGapKind
  /** The pools it applies to. */
  readonly resources: readonly string[]
  /** What the event log would have to carry for the figure to exist. */
  readonly needs: string
}

export interface RunAnalytics {
  readonly runId: string
  readonly status: RunStatus
  readonly startedAtMs: number
  /** `null` while the run is in progress. */
  readonly endedAtMs: number | null
  /** The end of the window every figure is computed over. */
  readonly observedAsOfMs: number
  /** `observedAsOfMs - startedAtMs`. The run's observed elapsed time. */
  readonly elapsedMs: number
  /** True when the run had not ended: every figure is a floor. */
  readonly partial: boolean
  /** Declaration order, so a report reads the way the plan does. */
  readonly nodes: readonly NodeAnalytics[]
  /** Root-first. Empty when no node was ever dispatched. */
  readonly criticalPath: readonly CriticalPathStep[]
  /** From the last hop's end to the end of the observed window. */
  readonly tailGapMs: number
  /** `Σ (gapMs + spanMs) + tailGapMs`. Equals `elapsedMs`. */
  readonly criticalPathMs: number
  /** Declaration order of `workflow.resources`, `lane` first. */
  readonly pools: readonly PoolContention[]
  readonly laneIdleness: LaneIdleness
  /** Empty when every figure in the report is attributable. */
  readonly gaps: readonly AttributionGap[]
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** Which bucket a node's clock is currently running into. */
type Phase = 'lane_queue' | 'working' | 'capacity_wait' | 'suspended'

interface Interval {
  readonly from: number
  readonly to: number
}

interface Trace {
  status: NodeStatus
  wave: number | null
  startedAtMs: number | null
  finishedAtMs: number | null
  laneQueueMs: number
  workingMs: number
  capacityWaitMs: number
  suspendedMs: number
  phase: Phase | null
  since: number
  /** Open lane hold, if any. */
  holdFrom: number | null
  holds: Interval[]
  /** Lane-queue intervals, for the `lane` pool's `queuedMs`. */
  queues: Interval[]
}

const newTrace = (): Trace => ({
  status: 'pending',
  wave: null,
  startedAtMs: null,
  finishedAtMs: null,
  laneQueueMs: 0,
  workingMs: 0,
  capacityWaitMs: 0,
  suspendedMs: 0,
  phase: null,
  since: 0,
  holdFrom: null,
  holds: [],
  queues: [],
})

/** Statuses at which the node has settled and given everything back. */
const SETTLED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'failed', 'blocked'])

function closePhase(trace: Trace, at: number): void {
  if (trace.phase === null) return
  const ms = Math.max(0, at - trace.since)
  switch (trace.phase) {
    case 'lane_queue':
      trace.laneQueueMs += ms
      if (ms > 0) trace.queues.push({ from: trace.since, to: at })
      break
    case 'working':
      trace.workingMs += ms
      break
    case 'capacity_wait':
      trace.capacityWaitMs += ms
      break
    case 'suspended':
      trace.suspendedMs += ms
      break
  }
  trace.phase = null
}

function openPhase(trace: Trace, phase: Phase, at: number): void {
  trace.phase = phase
  trace.since = at
}

function closeHold(trace: Trace, at: number): void {
  if (trace.holdFrom === null) return
  if (at > trace.holdFrom) trace.holds.push({ from: trace.holdFrom, to: at })
  trace.holdFrom = null
}

/**
 * Attributes a recorded run's wall clock.
 *
 * Throws only when the log does not describe a run at all — a missing
 * `run_started` means there is nothing to measure against. Every other
 * incompleteness (a run still going, a node still in flight, a node that never
 * started) is reported as a partial figure, because "not finished yet" is a
 * true answer and making the caller catch for it would push that judgement into
 * every consumer.
 */
export function analyzeRun(
  source: AnalyticsSource,
  runId: string,
  options: AnalyzeOptions = {},
): RunAnalytics {
  const workflow = source.readWorkflow(runId)
  const events = source.events(runId, 0)

  let startedAtMs: number | null = null
  let endedAtMs: number | null = null
  let status: RunStatus = 'running'
  let lastEventMs = 0
  const traces = new Map<string, Trace>()

  const traceOf = (nodeId: string): Trace => {
    const existing = traces.get(nodeId)
    if (existing !== undefined) return existing
    const fresh = newTrace()
    traces.set(nodeId, fresh)
    return fresh
  }

  for (const event of events) {
    lastEventMs = Math.max(lastEventMs, event.ts)
    switch (event.type) {
      case 'run_started':
        startedAtMs = event.ts
        continue
      case 'run_ended':
        endedAtMs = event.ts
        status = event.payload.status
        continue
      case 'node_registered': {
        const trace = traceOf(event.nodeId)
        trace.wave = event.payload.wave
        continue
      }
      case 'node_status': {
        const trace = traceOf(event.nodeId)
        const next = event.payload.status
        closePhase(trace, event.ts)
        switch (next) {
          case 'running':
            if (trace.startedAtMs === null) trace.startedAtMs = event.ts
            // A node resumed from a pause still holds its lane; one resumed
            // from a capacity wait gave it back and must queue again (§6.1).
            openPhase(trace, trace.holdFrom === null ? 'lane_queue' : 'working', event.ts)
            break
          case 'awaiting_human':
            openPhase(trace, 'suspended', event.ts)
            break
          case 'waiting_on_capacity':
            closeHold(trace, event.ts)
            openPhase(trace, 'capacity_wait', event.ts)
            break
          default:
            closeHold(trace, event.ts)
            if (SETTLED.has(next) && trace.startedAtMs !== null) trace.finishedAtMs = event.ts
            break
        }
        trace.status = next
        continue
      }
      case 'node_assigned': {
        // The lane grant. A patch carrying only a session id or a branch says
        // nothing about pool occupancy and must not be read as one.
        if (event.payload.lane === undefined) continue
        const trace = traceOf(event.nodeId)
        if (trace.holdFrom !== null) continue
        if (trace.phase === 'lane_queue') closePhase(trace, event.ts)
        trace.holdFrom = event.ts
        if (trace.phase === null) openPhase(trace, 'working', event.ts)
        continue
      }
      default:
        // `human_question`, `human_answered` and `node_operation` are recorded
        // for other readers; the time they describe is already in the status
        // transitions they accompany.
        continue
    }
  }

  if (startedAtMs === null) throw new Error(`run "${runId}" has no run_started event`)

  const observedAsOfMs = Math.max(
    startedAtMs,
    endedAtMs ?? options.nowMs ?? Math.max(lastEventMs, startedAtMs),
  )
  const elapsedMs = observedAsOfMs - startedAtMs

  // Close whatever was still open at the edge of the window. A settled node
  // closed both at its terminal event, so this only touches live ones.
  for (const trace of traces.values()) {
    closePhase(trace, observedAsOfMs)
    closeHold(trace, observedAsOfMs)
  }

  const nodes: NodeAnalytics[] = []
  const laneHolds: Interval[] = []
  let laneQueuedMs = 0
  for (const node of workflow.nodes) {
    const trace = traces.get(node.id) ?? newTrace()
    const started = trace.startedAtMs
    const inFlight = started !== null && trace.finishedAtMs === null
    const spanMs = started === null ? 0 : (trace.finishedAtMs ?? observedAsOfMs) - started
    laneHolds.push(...trace.holds)
    laneQueuedMs += trace.queues.reduce((total, one) => total + (one.to - one.from), 0)

    nodes.push({
      nodeId: node.id,
      wave: trace.wave ?? 0,
      status: trace.status,
      startedAtMs: started,
      finishedAtMs: trace.finishedAtMs,
      inFlight,
      split: {
        spanMs,
        laneQueueMs: trace.laneQueueMs,
        workingMs: trace.workingMs,
        capacityWaitMs: trace.capacityWaitMs,
        suspendedMs: trace.suspendedMs,
        gatePoolQueueMs: null,
      },
    })
  }

  const path = criticalPath(workflow, nodes, startedAtMs, observedAsOfMs)
  const tip = path.at(-1)
  const tailGapMs = tip === undefined ? elapsedMs : Math.max(0, observedAsOfMs - tip.endsAtMs)
  const criticalPathMs =
    path.reduce((total, step) => total + step.gapMs + step.split.spanMs, 0) + tailGapMs

  const laneCapacity = workflow.resources[LANE]?.capacity ?? 0
  const laneSegments = sweep(laneHolds, startedAtMs, observedAsOfMs)

  return {
    runId,
    status,
    startedAtMs,
    endedAtMs,
    observedAsOfMs,
    elapsedMs,
    partial: endedAtMs === null,
    nodes,
    criticalPath: path,
    tailGapMs,
    criticalPathMs,
    pools: poolContention(workflow, laneSegments, laneQueuedMs),
    laneIdleness: laneIdleness(laneCapacity, laneSegments, elapsedMs),
    gaps: attributionGaps(workflow),
  }
}

// ---------------------------------------------------------------------------
// The backward walk
// ---------------------------------------------------------------------------

/**
 * The chain that produced the observed elapsed time, root first.
 *
 * Walks backwards over the *observed* schedule, not forwards over the graph:
 * start at the node whose span ends last, and step to whichever of its
 * dependencies ended latest, since that is the one whose finish gated this
 * node's dispatch. Repeated to a node with no dependency that ever ran.
 *
 * Reading the schedule is what makes the answer useful. Queueing is inside the
 * spans, so a chain made long by waiting for a lane shows up as the critical
 * path it actually was, and on an uncontended run it reduces to the longest
 * chain by duration — which is not the chain with the most nodes. Ties break on
 * declaration order, so two reads of one journal give one answer.
 *
 * An in-flight node's span ends at the observed window's edge, which makes it a
 * legitimate tip: a partial report names the chain the run is currently on.
 */
function criticalPath(
  workflow: Workflow,
  nodes: readonly NodeAnalytics[],
  runStartedAtMs: number,
  observedAsOfMs: number,
): CriticalPathStep[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const order = new Map(workflow.nodes.map((node, index) => [node.id, index]))
  const depsOf = new Map(workflow.nodes.map((node) => [node.id, node.depends_on.map((d) => d.node)]))
  const endsAt = (node: NodeAnalytics): number => node.finishedAtMs ?? observedAsOfMs
  const ran = (node: NodeAnalytics | undefined): node is NodeAnalytics =>
    node !== undefined && node.startedAtMs !== null

  /** Later end wins; declaration order breaks the tie. */
  const later = (a: NodeAnalytics, b: NodeAnalytics): NodeAnalytics => {
    if (endsAt(b) !== endsAt(a)) return endsAt(b) > endsAt(a) ? b : a
    return (order.get(b.nodeId) ?? 0) < (order.get(a.nodeId) ?? 0) ? b : a
  }

  let cursor: NodeAnalytics | undefined
  for (const node of nodes) {
    if (!ran(node)) continue
    cursor = cursor === undefined ? node : later(cursor, node)
  }

  const reversed: NodeAnalytics[] = []
  const seen = new Set<string>()
  while (cursor !== undefined && !seen.has(cursor.nodeId)) {
    seen.add(cursor.nodeId)
    reversed.push(cursor)

    let next: NodeAnalytics | undefined
    for (const id of depsOf.get(cursor.nodeId) ?? []) {
      const dep = byId.get(id)
      if (!ran(dep)) continue
      next = next === undefined ? dep : later(next, dep)
    }
    cursor = next
  }

  const path: CriticalPathStep[] = []
  // The head hop's gap is measured against the run's own start: the run
  // beginning is the only instant earlier than the first node's dispatch, and
  // that stretch — provisioning, snapshotting — is real elapsed time that the
  // reconciliation must not lose.
  let previousEnd = runStartedAtMs
  for (const node of reversed.reverse()) {
    const startedAtMs = node.startedAtMs as number
    path.push({
      nodeId: node.nodeId,
      wave: node.wave,
      gapMs: Math.max(0, startedAtMs - previousEnd),
      startedAtMs,
      endsAtMs: endsAt(node),
      split: node.split,
    })
    previousEnd = endsAt(node)
  }
  return path
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

interface Segment {
  readonly from: number
  readonly to: number
  readonly held: number
}

/**
 * Turns a bag of hold intervals into a contiguous occupancy timeline over
 * `[from, to]`. Clamped to the window, so a hold still open at the edge
 * contributes exactly the part inside it.
 */
function sweep(intervals: readonly Interval[], from: number, to: number): Segment[] {
  const deltas = new Map<number, number>()
  const bump = (at: number, delta: number): void => {
    deltas.set(at, (deltas.get(at) ?? 0) + delta)
  }
  for (const interval of intervals) {
    const start = Math.max(interval.from, from)
    const end = Math.min(interval.to, to)
    if (end <= start) continue
    bump(start, 1)
    bump(end, -1)
  }

  const segments: Segment[] = []
  let held = 0
  let cursor = from
  for (const at of [...deltas.keys()].sort((a, b) => a - b)) {
    if (at > cursor) {
      segments.push({ from: cursor, to: at, held })
      cursor = at
    }
    held += deltas.get(at) as number
  }
  if (to > cursor) segments.push({ from: cursor, to, held })
  return segments
}

function poolContention(
  workflow: Workflow,
  laneSegments: readonly Segment[],
  laneQueuedMs: number,
): PoolContention[] {
  const pools: PoolContention[] = []
  const names = [LANE, ...Object.keys(workflow.resources).filter((id) => id !== LANE)]

  for (const resource of names) {
    const capacity = workflow.resources[resource]?.capacity ?? 0
    if (resource !== LANE) {
      pools.push({ resource, capacity, attribution: 'unattributed', reason: 'gate_pool_occupancy_unrecorded' })
      continue
    }
    let peakHeld = 0
    let busyMs = 0
    let saturatedMs = 0
    for (const segment of laneSegments) {
      const ms = segment.to - segment.from
      peakHeld = Math.max(peakHeld, segment.held)
      if (segment.held > 0) busyMs += ms
      if (capacity > 0 && segment.held >= capacity) saturatedMs += ms
    }
    pools.push({
      resource,
      capacity,
      attribution: 'exact',
      peakHeld,
      busyMs,
      saturatedMs,
      queuedMs: laneQueuedMs,
    })
  }
  return pools
}

function laneIdleness(
  capacity: number,
  segments: readonly Segment[],
  elapsedMs: number,
): LaneIdleness {
  let idleSlotMs = 0
  let freeWallMs = 0
  for (const segment of segments) {
    const ms = segment.to - segment.from
    const free = Math.max(0, capacity - segment.held)
    idleSlotMs += free * ms
    if (free > 0) freeWallMs += ms
  }
  const slotMs = capacity * elapsedMs
  return {
    capacity,
    slotMs,
    idleSlotMs,
    idleFraction: slotMs === 0 ? 0 : idleSlotMs / slotMs,
    freeWallMs,
  }
}

/**
 * What the journal cannot tell you, stated. Emitted per pool rather than once,
 * because "we cannot measure `test-suite`" is a different sentence from "we
 * cannot measure gate pools in general", and a report is read one pool at a
 * time.
 */
function attributionGaps(workflow: Workflow): AttributionGap[] {
  const gatePools = Object.keys(workflow.resources).filter((id) => id !== LANE)
  if (gatePools.length === 0) return []
  return [
    {
      kind: 'gate_pool_queue_unrecorded',
      resources: gatePools,
      needs:
        'an event marking a gate pool acquisition being attempted and granted. ' +
        'The scheduler takes these pools through `leases`, a table cleared on ' +
        'open whose rows are deleted on release, so no grant time survives the ' +
        'wait. Gate-pool queue time is inside `workingMs` and is not separable.',
    },
    {
      kind: 'gate_pool_occupancy_unrecorded',
      resources: gatePools,
      needs:
        'an event marking a gate pool lease being released. Without both edges ' +
        'there is no occupancy timeline, so saturation and contention for these ' +
        'pools cannot be computed at all.',
    },
  ]
}
