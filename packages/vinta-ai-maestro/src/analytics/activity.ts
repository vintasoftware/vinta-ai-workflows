/**
 * Where a run's working time goes, activity by activity, while it is still
 * going.
 *
 * `analytics.ts` answers the scheduling question — how long each node queued,
 * worked, waited on capacity or sat on a question, and which chain set the
 * elapsed time. This answers the one an operator asks mid-run: *of the time
 * spent working, how much was implementation, how much was gates, how much
 * was review and polish chores, how much was the merge* — and for which
 * phases, on which harness, by which crew member, on which model. It is the
 * fold behind the UI's analytics page and its filters.
 *
 * **One flat list, every row tagged.** The report is a list of activities,
 * each carrying the node it belongs to and the node's staffing at the time —
 * harness, model, crew member, tier — so a consumer filters and groups without
 * a second lookup, and a node that changed harness or fell back to another
 * model mid-run has its earlier activities attributed to what actually ran
 * them. Four kinds:
 *
 * | kind          | derived from                                            | id              |
 * |---------------|---------------------------------------------------------|-----------------|
 * | `step`        | `node_step` → the next `node_step`, or the node settling | pipeline state  |
 * | `gate`        | `gate_started` → `gate_result` (or `duration_ms` alone)   | gate id         |
 * | `chore`       | `chore_result`, back-dated by its `duration_ms`           | chore id        |
 * | `integration` | `integration_step` started → finished, `hold` left out    | the step kind   |
 *
 * Gates, chores and integration steps happen *inside* a pipeline state, so
 * their time is a subset of the step's, never added to it: a consumer that
 * wants "implementation time" reads the `implement` and `fix` steps, and one
 * that wants "gate time" reads the gates. The steps alone partition the
 * node's working time.
 *
 * **A step's clock stops while the node is parked.** `node_step` is written
 * when a state is entered, and the next one when the next state is — but
 * between the two the node may sit on a question or in a capacity window,
 * which is time `analytics.ts` already attributes to `suspendedMs` and
 * `capacityWaitMs`. So a step is closed when its node leaves `running` and
 * reopened, under the same id, when it comes back: the sum of a node's steps
 * is its working time and nothing else, and the two reports agree.
 *
 * **A cached gate verdict is counted, not timed.** A hit's `duration_ms` is
 * what the gate cost when it last really ran, so a hit is an activity of
 * zero length marked `cached`; a consumer tallying verdicts sees it and one
 * tallying time does not.
 *
 * **An open activity stays open.** `endedAt` is `null` for anything still in
 * progress inside the observed window, and the report's `asOfMs` is the
 * moment the figures are true as of. A live view ticks the open rows against
 * its own clock; a finished run has none.
 *
 * Identifiers and durations only: node, gate, chore and crew ids, pipeline
 * state names, harness and model ids, epoch milliseconds. Nothing here reads
 * a transcript, a prompt, a log or a diff.
 */
import type { NodeStatus, RunStatus, StoredEvent } from '../journal/events.ts'
import type { Workflow } from '../types.ts'

/** The slice of the journal this needs. Structural, like `AnalyticsSource`. */
export interface ActivitySource {
  readWorkflow(runId: string): Workflow
  events(runId: string, sinceId?: number): readonly StoredEvent[]
}

export interface ActivityOptions {
  /** The end of the observed window for a run in progress. Defaults to the last event's timestamp. */
  readonly nowMs?: number
}

export type ActivityKind = 'step' | 'gate' | 'chore' | 'integration'

export interface Activity {
  readonly node: string
  readonly kind: ActivityKind
  /** The pipeline state, the gate id, the chore id, or the integration step kind. */
  readonly id: string
  /** The attempt the node was on, from its last `node_step`. Null before the first. */
  readonly attempt: number | null
  readonly harness: string
  readonly model: string
  readonly crew: string | null
  readonly tier: number | null
  readonly startedAt: number
  /** Null while still in progress as of the observed window's end. */
  readonly endedAt: number | null
  /**
   * A gate's status, a chore's status, an integration step's outcome, or
   * `interrupted` for anything the process holding it ended before finishing.
   * Null on a step that is open or ended by the next step.
   */
  readonly outcome: string | null
  /** A gate verdict §13.4's cache served: zero length, counted as a run. */
  readonly cached: boolean
}

export interface ActivityNode {
  readonly nodeId: string
  readonly name: string
  readonly wave: number
  readonly status: NodeStatus
  readonly harness: string
  readonly model: string
  readonly crew: string | null
  readonly tier: number | null
}

export interface RunActivity {
  readonly runId: string
  readonly status: RunStatus
  readonly startedAtMs: number
  readonly endedAtMs: number | null
  /** The moment every figure is true as of. */
  readonly asOfMs: number
  readonly elapsedMs: number
  /** True while the run had not ended: every open activity is a floor. */
  readonly partial: boolean
  /** Workflow declaration order. */
  readonly nodes: readonly ActivityNode[]
  /** Start order. */
  readonly activities: readonly Activity[]
}

interface Open {
  readonly kind: ActivityKind
  readonly id: string
  readonly startedAt: number
  readonly attempt: number | null
  readonly harness: string
  readonly model: string
  readonly crew: string | null
  readonly tier: number | null
  /** What a `finished` has to match on an integration step. */
  readonly gate: string | null
  readonly round: number | null
}

interface NodeTrace {
  status: NodeStatus
  wave: number
  harness: string
  model: string
  crew: string | null
  tier: number | null
  attempt: number | null
  /** The state in progress, or the one paused by the node leaving `running`. */
  step: Open | null
  stepPaused: boolean
  gates: Open[]
  integration: Open[]
}

const SETTLED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'failed', 'blocked', 'pending'])

const KIND_ORDER: Readonly<Record<ActivityKind, number>> = { step: 0, integration: 1, gate: 2, chore: 3 }

export function collectActivities(
  source: ActivitySource,
  runId: string,
  options: ActivityOptions = {},
): RunActivity {
  const workflow = source.readWorkflow(runId)
  const events = source.events(runId, 0)
  const declared = new Map(workflow.nodes.map((node) => [node.id, node]))

  let startedAtMs: number | null = null
  let endedAtMs: number | null = null
  let status: RunStatus = 'running'
  let lastEventMs = 0
  const traces = new Map<string, NodeTrace>()
  const activities: Activity[] = []

  const plannedModel = (nodeId: string): string => {
    const node = declared.get(nodeId)
    const member = node?.crew === undefined ? undefined : workflow.crew[node.crew]
    return member?.model ?? node?.model ?? workflow.defaults.model
  }
  const plannedHarness = (nodeId: string): string => {
    const node = declared.get(nodeId)
    const member = node?.crew === undefined ? undefined : workflow.crew[node.crew]
    return member?.harness ?? node?.harness ?? workflow.defaults.harness
  }

  const traceOf = (nodeId: string): NodeTrace => {
    const existing = traces.get(nodeId)
    if (existing !== undefined) return existing
    const fresh: NodeTrace = {
      status: 'pending',
      wave: 0,
      harness: plannedHarness(nodeId),
      model: plannedModel(nodeId),
      crew: declared.get(nodeId)?.crew ?? null,
      tier: null,
      attempt: null,
      step: null,
      stepPaused: false,
      gates: [],
      integration: [],
    }
    traces.set(nodeId, fresh)
    return fresh
  }

  const open = (trace: NodeTrace, kind: ActivityKind, id: string, at: number, extra: Partial<Open> = {}): Open => ({
    kind,
    id,
    startedAt: at,
    attempt: trace.attempt,
    harness: trace.harness,
    model: trace.model,
    crew: trace.crew,
    tier: trace.tier,
    gate: null,
    round: null,
    ...extra,
  })

  const close = (nodeId: string, held: Open, at: number, outcome: string | null, cached = false): void => {
    activities.push({
      node: nodeId,
      kind: held.kind,
      id: held.id,
      attempt: held.attempt,
      harness: held.harness,
      model: held.model,
      crew: held.crew,
      tier: held.tier,
      startedAt: held.startedAt,
      endedAt: Math.max(held.startedAt, at),
      outcome,
      cached,
    })
  }

  const closeStep = (nodeId: string, trace: NodeTrace, at: number, outcome: string | null): void => {
    if (trace.step !== null && !trace.stepPaused) close(nodeId, trace.step, at, outcome)
    trace.step = null
    trace.stepPaused = false
  }

  /** Everything a killed process would have left open, at `at`. */
  const interruptAll = (at: number): void => {
    for (const [nodeId, trace] of traces) {
      if (trace.step !== null && !trace.stepPaused) close(nodeId, trace.step, at, 'interrupted')
      trace.step = null
      trace.stepPaused = false
      for (const gate of trace.gates) close(nodeId, gate, at, 'interrupted')
      trace.gates = []
      for (const step of trace.integration) close(nodeId, step, at, 'interrupted')
      trace.integration = []
    }
  }

  for (const event of events) {
    lastEventMs = Math.max(lastEventMs, event.ts)
    switch (event.type) {
      case 'run_started':
        startedAtMs = event.ts
        continue
      case 'run_ended':
        interruptAll(event.ts)
        endedAtMs = event.ts
        status = event.payload.status
        continue
      case 'run_resumed':
        interruptAll(event.ts)
        continue
      case 'node_registered': {
        const trace = traceOf(event.nodeId)
        trace.wave = event.payload.wave
        trace.harness = event.payload.harness
        continue
      }
      case 'node_assigned': {
        const trace = traceOf(event.nodeId)
        if (event.payload.harness !== undefined) trace.harness = event.payload.harness
        continue
      }
      case 'node_crew': {
        const trace = traceOf(event.nodeId)
        trace.crew = event.payload.member
        trace.tier = event.payload.tier
        trace.model = workflow.crew[event.payload.member]?.model ?? trace.model
        continue
      }
      case 'node_model_fallback': {
        // Every later spawn goes straight to the fallback (`known`), so from
        // here the node's work is the fallback model's.
        traceOf(event.nodeId).model = event.payload.to
        continue
      }
      case 'node_status': {
        const trace = traceOf(event.nodeId)
        const next = event.payload.status
        trace.status = next
        if (SETTLED.has(next)) {
          closeStep(event.nodeId, trace, event.ts, null)
          for (const gate of trace.gates) close(event.nodeId, gate, event.ts, 'interrupted')
          trace.gates = []
        } else if (next === 'running') {
          // Back from a question or a capacity window: the paused step resumes
          // under the same id, as a new row from now.
          if (trace.step !== null && trace.stepPaused) {
            trace.step = { ...trace.step, startedAt: event.ts, attempt: trace.attempt }
            trace.stepPaused = false
          }
        } else if (trace.step !== null && !trace.stepPaused) {
          close(event.nodeId, trace.step, event.ts, null)
          trace.stepPaused = true
        }
        continue
      }
      case 'node_step': {
        const trace = traceOf(event.nodeId)
        closeStep(event.nodeId, trace, event.ts, null)
        trace.attempt = event.payload.attempt
        trace.step = open(trace, 'step', event.payload.state, event.ts)
        continue
      }
      case 'gate_started': {
        const trace = traceOf(event.nodeId)
        const stale = trace.gates.findIndex((held) => held.id === event.payload.gate)
        if (stale !== -1) {
          close(event.nodeId, trace.gates[stale] as Open, event.ts, 'interrupted')
          trace.gates.splice(stale, 1)
        }
        trace.gates.push(open(trace, 'gate', event.payload.gate, event.ts))
        continue
      }
      case 'gate_result': {
        const trace = traceOf(event.nodeId)
        const { gate, status: verdict, duration_ms, cached } = event.payload
        const index = trace.gates.findIndex((held) => held.id === gate)
        if (index !== -1) {
          const held = trace.gates[index] as Open
          trace.gates.splice(index, 1)
          close(event.nodeId, cached ? { ...held, startedAt: event.ts } : held, event.ts, verdict, cached)
        } else {
          // No start on record — a hit the cache served without running, or a
          // row from before gates announced themselves. The runner's own
          // measurement is still what the run paid.
          const held = open(trace, 'gate', gate, cached ? event.ts : event.ts - Math.max(0, duration_ms))
          close(event.nodeId, held, event.ts, verdict, cached)
        }
        continue
      }
      case 'chore_result': {
        const trace = traceOf(event.nodeId)
        const held = open(trace, 'chore', event.payload.chore, event.ts - Math.max(0, event.payload.duration_ms))
        close(event.nodeId, held, event.ts, event.payload.status)
        continue
      }
      case 'integration_step': {
        const trace = traceOf(event.nodeId)
        const payload = event.payload
        if (payload.step === 'hold') continue
        if (payload.state === 'started') {
          trace.integration.push(
            open(trace, 'integration', payload.step, event.ts, {
              gate: payload.gate ?? null,
              round: payload.round ?? null,
            }),
          )
          continue
        }
        const index = trace.integration.findLastIndex(
          (held) =>
            held.id === payload.step &&
            (held.round === null || held.round === (payload.round ?? null)) &&
            (held.gate === null || payload.gate === undefined || held.gate === payload.gate),
        )
        if (index === -1) continue
        const held = trace.integration[index] as Open
        trace.integration.splice(index, 1)
        close(event.nodeId, held, event.ts, payload.outcome ?? 'ok')
        continue
      }
      default:
        continue
    }
  }

  const asOfMs = endedAtMs ?? options.nowMs ?? lastEventMs
  const startedAt = startedAtMs ?? asOfMs

  // What is still open is reported open, in start order with the rest.
  for (const [nodeId, trace] of traces) {
    const pending: Open[] = [...trace.gates, ...trace.integration]
    if (trace.step !== null && !trace.stepPaused) pending.push(trace.step)
    for (const held of pending) {
      activities.push({
        node: nodeId,
        kind: held.kind,
        id: held.id,
        attempt: held.attempt,
        harness: held.harness,
        model: held.model,
        crew: held.crew,
        tier: held.tier,
        startedAt: held.startedAt,
        endedAt: null,
        outcome: null,
        cached: false,
      })
    }
  }
  // Start order; a tie puts the enclosing step before what ran inside it.
  activities.sort((a, b) => a.startedAt - b.startedAt || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

  const nodes: ActivityNode[] = workflow.nodes.map((node) => {
    const trace = traceOf(node.id)
    return {
      nodeId: node.id,
      name: node.name,
      wave: trace.wave,
      status: trace.status,
      harness: trace.harness,
      model: trace.model,
      crew: trace.crew,
      tier: trace.tier,
    }
  })

  return {
    runId,
    status,
    startedAtMs: startedAt,
    endedAtMs,
    asOfMs,
    elapsedMs: Math.max(0, asOfMs - startedAt),
    partial: endedAtMs === null,
    nodes,
    activities,
  }
}
