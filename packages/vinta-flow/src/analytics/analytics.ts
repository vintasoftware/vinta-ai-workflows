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
 * **What the log attributes.** All five ways a node spends time are recorded
 * and are reported exactly:
 *
 * | bucket          | derived from                                            |
 * |-----------------|---------------------------------------------------------|
 * | lane queue      | `node_status: running` → the `node_assigned` carrying `lane` |
 * | working         | lane held, node not parked                              |
 * | capacity wait   | `node_status: waiting_on_capacity` → the next `running`  |
 * | suspended       | `node_status: awaiting_human` → the next `running`       |
 * | gate-pool queue | `gate_pool: requested` → the matching `granted`          |
 *
 * The fifth is a *subset* of `workingMs`, not a sixth share of the span: the
 * node holds its lane throughout the wait (§6), so counting it separately
 * would break the reconciliation below. It is reported alongside the split
 * rather than carved out of it.
 *
 * Gate-pool occupancy comes from the same three edges: `granted` → `released`
 * is one hold, and sweeping the holds gives every gate pool the peak, busy and
 * saturated figures the `lane` pool has always had. `leases` is still written
 * at the grant, but it is the *current* holder set — cleared on open, deleted
 * on release — and no history is read out of it here.
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
 * fifth is a subset of `workingMs`, reported beside it.
 */
export interface TimeSplit {
  /** `finishedAtMs - startedAtMs`, or `asOf - startedAtMs` while in flight. 0 if never dispatched. */
  readonly spanMs: number
  /** Dispatched, waiting for a lane slot. Summed over every attempt, including post-capacity-wait retries. */
  readonly laneQueueMs: number
  /**
   * Lane held and the node not parked: agent turns, gate runs, and the wait
   * for a gate's pool — which `gatePoolQueueMs` separates out without leaving
   * this bucket, because the lane is held throughout it.
   */
  readonly workingMs: number
  /** `waiting_on_capacity`: a vendor refused a spawn and the node is inside a backoff window (§6.1). */
  readonly capacityWaitMs: number
  /** `awaiting_human`: parked on an `await_human` question or an operator pause (§9.1). */
  readonly suspendedMs: number
  /**
   * Time inside `workingMs` spent queued for a gate's pool, summed over every
   * acquisition. Derived from the `gate_pool` edges the scheduler writes, so
   * 0 means "never waited", not "not recorded".
   */
  readonly gatePoolQueueMs: number
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
 * "the log does not say", which now happens only when a pool's own events are
 * missing from a journal that nonetheless recorded gates needing it.
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

/**
 * The one figure this module can still fail to have.
 *
 * `gate_pool_events_missing` is not "gate pools are unmeasurable" — they are,
 * from the three edges the scheduler journals. It is the narrower and now
 * detectable case: a run that recorded a `gate_result` for a gate declaring
 * `requires`, with no `gate_pool` event naming that pool. A journal written
 * before the vocabulary carried these edges reads exactly like this, and so
 * does a pool taken by something other than the scheduler. Reporting zero
 * occupancy for such a pool would be the same lie the old gaps existed to
 * prevent, pointed the other way.
 */
export type AttributionGapKind = 'gate_pool_events_missing'

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
  gatePoolQueueMs: number
  /** An acquisition requested and not yet granted. */
  gateWait: { readonly from: number; readonly resources: readonly string[] } | null
  /** An acquisition granted and not yet released. */
  gateHold: { readonly from: number; readonly resources: readonly string[] } | null
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
  gatePoolQueueMs: 0,
  gateWait: null,
  gateHold: null,
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

  // Per-pool occupancy and queueing, accumulated across nodes: a pool's
  // timeline is the union of every node's holds on it, which is exactly what
  // makes saturation a fact about the pool rather than about one node.
  const poolHolds = new Map<string, Interval[]>()
  const poolQueuedMs = new Map<string, number>()
  /** Pools any `gate_pool` event named, and gates any `gate_result` reported. */
  const poolsSeen = new Set<string>()
  const gatesRun = new Set<string>()

  const traceOf = (nodeId: string): Trace => {
    const existing = traces.get(nodeId)
    if (existing !== undefined) return existing
    const fresh = newTrace()
    traces.set(nodeId, fresh)
    return fresh
  }

  const addQueue = (resources: readonly string[], from: number, to: number): void => {
    const ms = Math.max(0, to - from)
    for (const resource of resources) {
      poolQueuedMs.set(resource, (poolQueuedMs.get(resource) ?? 0) + ms)
    }
  }

  const addHold = (resources: readonly string[], from: number, to: number): void => {
    // `to === from` is kept, not dropped. A fast gate is granted and released
    // inside one millisecond: it contributes no elapsed time — `busyMs` of 0 is
    // right — but the slot *was* held, and discarding it here made `peakHeld`
    // read 0 or 1 for the same run depending on machine load. Only a genuinely
    // inverted interval is meaningless.
    if (to < from) return
    for (const resource of resources) {
      const held = poolHolds.get(resource) ?? []
      held.push({ from, to })
      poolHolds.set(resource, held)
    }
  }

  /** Closes whatever a node still had open on a gate pool at `at`. */
  const closeGate = (trace: Trace, at: number): void => {
    if (trace.gateWait !== null) {
      trace.gatePoolQueueMs += Math.max(0, at - trace.gateWait.from)
      addQueue(trace.gateWait.resources, trace.gateWait.from, at)
      trace.gateWait = null
    }
    if (trace.gateHold !== null) {
      addHold(trace.gateHold.resources, trace.gateHold.from, at)
      trace.gateHold = null
    }
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
      case 'gate_pool': {
        // The three edges §13.3 needs. The node stays in `working` throughout:
        // it is holding its lane the whole time (§6), so the wait is measured
        // beside the split rather than carved out of it.
        const trace = traceOf(event.nodeId)
        const { phase, resources } = event.payload
        for (const resource of resources) poolsSeen.add(resource)
        if (phase === 'requested') {
          trace.gateWait = { from: event.ts, resources }
          continue
        }
        if (phase === 'granted') {
          const wait = trace.gateWait
          if (wait !== null) {
            trace.gatePoolQueueMs += Math.max(0, event.ts - wait.from)
            addQueue(wait.resources, wait.from, event.ts)
            trace.gateWait = null
          }
          trace.gateHold = { from: event.ts, resources }
          continue
        }
        if (trace.gateHold !== null) {
          addHold(trace.gateHold.resources, trace.gateHold.from, event.ts)
          trace.gateHold = null
        }
        continue
      }
      case 'gate_result':
        // Read only to tell "this pool was never busy" from "this journal
        // never recorded the pool" — see `attributionGaps`.
        gatesRun.add(event.payload.gate)
        continue
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
    closeGate(trace, observedAsOfMs)
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
        gatePoolQueueMs: trace.gatePoolQueueMs,
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
  poolHolds.set(LANE, laneHolds)
  poolQueuedMs.set(LANE, laneQueuedMs)
  const unrecorded = unrecordedPools(workflow, gatesRun, poolsSeen)

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
    pools: poolContention(workflow, poolHolds, poolQueuedMs, unrecorded, startedAtMs, observedAsOfMs),
    laneIdleness: laneIdleness(laneCapacity, laneSegments, elapsedMs),
    gaps: attributionGaps(unrecorded),
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
/**
 * Most slots held at once, counted from the holds themselves rather than from
 * swept time segments.
 *
 * A hold granted and released inside the same millisecond has zero duration and
 * therefore contributes no segment: `busyMs` of 0 is correct, but the slot *was*
 * held and a peak of 0 is not. Fast gates do exactly this, so deriving the peak
 * from elapsed time made the figure depend on clock granularity — it read 1 or 0
 * for the same run depending on machine load, which is how it surfaced.
 *
 * Holds are half-open, so two back-to-back holds are one slot reused, not two
 * concurrent ones. That alone would erase the zero-width case again, so the two
 * are counted separately and combined: a zero-width hold sits on top of whatever
 * spans genuinely cover its instant.
 */
function peakConcurrent(intervals: readonly Interval[], from: number, to: number): number {
  const spans: { from: number; to: number }[] = []
  const instants = new Map<number, number>()
  for (const interval of intervals) {
    const start = Math.max(interval.from, from)
    const end = Math.min(interval.to, to)
    if (end < start) continue
    if (end === start) instants.set(start, (instants.get(start) ?? 0) + 1)
    else spans.push({ from: start, to: end })
  }

  const points = spans.flatMap((span) => [
    { at: span.from, delta: 1 },
    { at: span.to, delta: -1 },
  ])
  // A release at t frees the slot a grant at t takes.
  points.sort((a, b) => a.at - b.at || a.delta - b.delta)

  let held = 0
  let peak = 0
  for (const point of points) {
    held += point.delta
    peak = Math.max(peak, held)
  }

  for (const [at, count] of instants) {
    const covering = spans.filter((span) => span.from <= at && at < span.to).length
    peak = Math.max(peak, covering + count)
  }
  return peak
}

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

/**
 * Every pool, measured the same way. `lane`'s holds come from its
 * `node_assigned` grants and a gate pool's from its `gate_pool` edges, but
 * once both are intervals the arithmetic is one loop — which is the point of
 * journalling the gate edges at all.
 */
function poolContention(
  workflow: Workflow,
  holds: ReadonlyMap<string, readonly Interval[]>,
  queued: ReadonlyMap<string, number>,
  unrecorded: ReadonlySet<string>,
  from: number,
  to: number,
): PoolContention[] {
  const pools: PoolContention[] = []
  const names = [LANE, ...Object.keys(workflow.resources).filter((id) => id !== LANE)]

  for (const resource of names) {
    const capacity = workflow.resources[resource]?.capacity ?? 0
    if (unrecorded.has(resource)) {
      pools.push({
        resource,
        capacity,
        attribution: 'unattributed',
        reason: 'gate_pool_events_missing',
      })
      continue
    }
    const held = holds.get(resource) ?? []
    // Clamped, because the pool never grants beyond capacity and a figure above
    // it would be reporting something that cannot have happened. It is reachable
    // only through zero-width holds: two fast gates that take and release the
    // same slot inside one millisecond are, at this resolution, indistinguishable
    // from two concurrent ones. Where they differ, sequential is the truth the
    // pool guarantees — so the clamp is the honest reading rather than a patch.
    const peakHeld = capacity > 0
      ? Math.min(capacity, peakConcurrent(held, from, to))
      : peakConcurrent(held, from, to)
    let busyMs = 0
    let saturatedMs = 0
    for (const segment of sweep(held, from, to)) {
      const ms = segment.to - segment.from
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
      queuedMs: queued.get(resource) ?? 0,
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
 * Pools this run demonstrably used and demonstrably did not record.
 *
 * The evidence has to be positive in both directions, which is why it is a
 * `gate_result` and not the mere existence of the pool in the workflow: a pool
 * no gate ever ran against was genuinely idle, and calling that unrecorded
 * would be the stale gap this module just stopped emitting. A gate that
 * *ran* while needing the pool, with no `gate_pool` event naming it, is the
 * one case left where zero would be a lie.
 */
function unrecordedPools(
  workflow: Workflow,
  gatesRun: ReadonlySet<string>,
  poolsSeen: ReadonlySet<string>,
): Set<string> {
  const missing = new Set<string>()
  for (const gateId of gatesRun) {
    for (const resource of workflow.gates[gateId]?.requires ?? []) {
      if (resource !== LANE && !poolsSeen.has(resource)) missing.add(resource)
    }
  }
  return missing
}

/**
 * What the journal cannot tell you, stated. Emitted per pool rather than once,
 * because "we cannot measure `test-suite`" is a different sentence from "we
 * cannot measure gate pools in general", and a report is read one pool at a
 * time.
 *
 * Empty on any run the current scheduler produced — the two gaps this module
 * used to emit unconditionally are closed by the `gate_pool` edges, and a gap
 * left standing after its cause is fixed is a lie in the other direction.
 */
function attributionGaps(unrecorded: ReadonlySet<string>): AttributionGap[] {
  if (unrecorded.size === 0) return []
  return [
    {
      kind: 'gate_pool_events_missing',
      resources: [...unrecorded].sort(),
      needs:
        'the `gate_pool` events the scheduler writes around a gate acquisition — ' +
        'requested, granted, released. This run recorded a gate result for a gate ' +
        'requiring these pools but no acquisition of them, which is what a journal ' +
        'written before those events existed looks like, and what a pool taken ' +
        'outside the scheduler looks like. Queue time and occupancy for them are ' +
        'unknown rather than zero.',
    },
  ]
}
