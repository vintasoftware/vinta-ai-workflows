/**
 * Dry-run / simulation mode (§13.1).
 *
 * Runs **the real scheduler** end to end — the same `createScheduler`, the same
 * `ResourcePools`, the same pipeline interpreter, the same admission control —
 * against a mock adapter and an effect executor whose only side effect is
 * advancing a virtual clock by a duration estimate. Nothing spawns, nothing
 * touches git, no gate command runs, no model turn is spent.
 *
 * **Why the real scheduler.** A simulator that modelled dispatch separately
 * would answer questions about the model. Every ordering rule this projection
 * depends on — a node's start gate is its own dependency set, a node holds its
 * lane while queued for a gate, all-or-nothing acquisition in canonical order —
 * lives in `scheduler.ts`, and re-deriving them here would mean the projection
 * agreed with the run only until one of them changed. So the scheduler is
 * driven, not imitated. It needed no modification: it owns no timer, and the
 * one seam into time (`Clock`, taken by admission control) is already injected.
 *
 * **How a six-hour run finishes in milliseconds.** Time moves only in
 * `VirtualClock.advance`, and only once every pending microtask has drained —
 * a discrete-event loop. A simulated effect "takes" an hour by parking on the
 * clock's timer queue; the driver notices the run has gone quiescent and jumps
 * straight to the next deadline.
 *
 * **What this can and cannot know.** It answers exactly one question: *given
 * these durations, what is the schedule?* It knows the graph, the pools and the
 * scheduler's own rules, so it can tell you the projected wall clock, the
 * critical path, and whether `lane` capacity or a gate pool is the binding
 * constraint. It cannot know how long a real agent's turn will take, how many
 * fix rounds a phase will need, whether a gate will fail, or when a vendor will
 * refuse a spawn — so it simulates the clean path: every review passes, every
 * gate exits zero, no fix round is entered, no spawn is refused, and harness
 * in-flight ceilings are set high enough not to bind. A projection is a
 * sensitivity analysis over durations you supply, never a prediction.
 *
 * Identifiers only, everywhere: node ids, pool ids, gate ids and durations. No
 * prompt text, no repository content, no lane paths.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdmissionControl } from '../admission/admission.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import { MockAdapter } from '../harness/mock.ts'
import type { NodeStatus } from '../journal/events.ts'
import { openJournal } from '../journal/journal.ts'
import type { EffectExecutor, EffectInvocation, EffectOutcome } from '../pipeline/effects.ts'
import { createScheduler, type RunReport, type RunStop } from '../scheduler/index.ts'
import type { EffectId, Node, Workflow } from '../types.ts'
import { VirtualClock } from './clock.ts'
import { MeasuredPools, type PoolContention } from './pools.ts'

/** The run id every simulation uses. Fixed, so two runs produce one report. */
const SIMULATION_RUN_ID = 'simulation'

/** The pool every node is dispatched into. Required of every workflow (§5.1). */
const LANE = 'lane'

/**
 * High enough never to bind. A vendor's real in-flight ceiling is discovered at
 * runtime (§6.1) and is not a property of the plan, so a projection that
 * pretended to know it would be reporting a guess as a constraint.
 */
const SIMULATED_CEILING = 1_000

/** 20 minutes per agent turn. */
export const DEFAULT_AGENT_TURN_MS = 20 * 60_000

/** 5 minutes per gate run. */
export const DEFAULT_GATE_MS = 5 * 60_000

/**
 * What a simulated run is told to cost. Everything is virtual milliseconds.
 *
 * The unit is an **agent turn**, not a node: a node's duration is however many
 * turns its pipeline spawns, and `standard-phase` spawns two on the clean path
 * (implementer, then reviewer). Charging per turn keeps the estimate a thing
 * the caller can state about a phase without also having to know which pipeline
 * it runs.
 */
export interface DurationEstimates {
  /** ms per agent turn, by node id. Falls back to `defaultAgentTurnMs`. */
  readonly nodes?: Readonly<Record<string, number>>
  /** ms per gate run, by gate id. Falls back to `defaultGateMs`. */
  readonly gates?: Readonly<Record<string, number>>
  readonly defaultAgentTurnMs?: number
  readonly defaultGateMs?: number
}

export interface SimulateOptions {
  readonly workflow: Workflow
  readonly estimates?: DurationEstimates
  /**
   * Adapters by harness id. Defaults to a fresh `MockAdapter` per harness the
   * workflow names — injectable so a caller can assert on what was spawned,
   * which for a dry run should be nothing at all.
   */
  readonly adapters?: Readonly<Record<string, HarnessAdapter>>
}

/** One node's place in the projected schedule. `null` where the node never ran. */
export interface SimulatedNode {
  readonly id: string
  readonly wave: number
  readonly status: NodeStatus
  /** When the last dependency finished — the earliest this node could start. */
  readonly readyAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  /** Time actually spent working: agent turns plus gate runs. */
  readonly busyMs: number
  /** Time spent waiting for a pool slot, once ready. */
  readonly queueMs: number
  /** `queueMs` broken down by the pool that was being waited on. */
  readonly waits: Readonly<Record<string, number>>
}

/** One hop on the chain that produced the projected wall clock. */
export interface CriticalPathStep {
  readonly nodeId: string
  readonly wave: number
  readonly startedAtMs: number
  readonly finishedAtMs: number
  readonly busyMs: number
  readonly queueMs: number
}

export interface SimulationReport {
  /** `stopped` means the graph could not run — see `stop`. Nothing was spawned. */
  readonly status: 'completed' | 'stopped'
  readonly stop?: RunStop
  /** Projected wall clock: when the last node finished. */
  readonly projectedMs: number
  readonly statuses: Readonly<Record<string, NodeStatus>>
  /** Declaration order, so a plan reads the way it runs. */
  readonly nodes: readonly SimulatedNode[]
  /** Root-first. Empty when nothing ran. */
  readonly criticalPath: readonly CriticalPathStep[]
  readonly pools: readonly PoolContention[]
}

/** What one simulated effect cost, and which pools it had to queue for. */
interface EffectRecord {
  readonly nodeId: string
  readonly verb: EffectId
  /** The pools a `run_gate` had to hold. Empty for every other verb. */
  readonly resources: readonly string[]
  readonly startedAtMs: number
  readonly finishedAtMs: number
}

/**
 * Projects a workflow's schedule without running it.
 *
 * Resolves with a report for every outcome the scheduler can reach, including
 * the unrunnable ones: a cycle and an unsatisfiable resource requirement are
 * static facts the scheduler finds before dispatching anything, so they come
 * back as `status: 'stopped'` with nothing spawned rather than as a throw.
 *
 * Rejects only when the run stalls — a pipeline that suspends on `await_human`
 * has no answer a projection could supply.
 */
export async function simulate(options: SimulateOptions): Promise<SimulationReport> {
  const { workflow } = options
  const clock = new VirtualClock()
  // Strict FIFO. The aging window is a wall-clock affordance measured in
  // hundreds of milliseconds; against durations measured in minutes every
  // waiter has aged by definition, so strict order is both what a real run
  // does and the only ordering that does not read `Date.now()`.
  const pools = new MeasuredPools(workflow.resources, clock, { agingMs: 0 })
  const executor = new SimulationExecutor(workflow, clock, options.estimates ?? {})

  // A throwaway journal: the scheduler requires one, and a projection has no
  // business writing into the project's own run history.
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-simulate-'))
  const journal = openJournal(dir)
  const adapters = options.adapters ?? defaultAdapters(workflow)
  const admission = new AdmissionControl({
    journal,
    runId: SIMULATION_RUN_ID,
    ceilings: Object.fromEntries(Object.keys(adapters).map((id) => [id, SIMULATED_CEILING])),
    clock,
  })

  try {
    const scheduler = createScheduler({
      workflow,
      runId: SIMULATION_RUN_ID,
      journal,
      pools,
      admission,
      adapters,
      executor,
      laneRoot: join(dir, 'lanes'),
    })

    const state: { report: RunReport | null; error: unknown } = { report: null, error: null }
    const settled = scheduler.run().then(
      (value) => {
        state.report = value
      },
      (error: unknown) => {
        state.error = error
      },
    )

    // The discrete-event loop: drain everything that can happen now, then jump
    // to the next deadline. Never a poll, and never a real wait.
    while (state.report === null && state.error === null) {
      await drain()
      if (state.report !== null || state.error !== null) break
      if (!clock.advance()) {
        const stalled = Object.entries(scheduler.statuses)
          .filter(([, status]) => status !== 'done' && status !== 'failed' && status !== 'blocked')
          .map(([id]) => id)
        throw new Error(`simulation stalled on: ${stalled.join(', ')}`)
      }
    }
    await settled
    if (state.error !== null) throw state.error
    if (state.report === null) throw new Error('simulation produced no report')

    return summarize(workflow, state.report, executor.records, pools)
  } finally {
    admission.close()
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Lets every pending microtask run. Two turns rather than one because the
 * scheduler, the pools and the interpreter hand work to each other through
 * promises; nothing here waits on real IO, so this always reaches quiescence.
 */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** One mock adapter per harness the workflow names. None of them is ever asked to spawn. */
function defaultAdapters(workflow: Workflow): Record<string, HarnessAdapter> {
  const ids = new Set<string>([workflow.defaults.harness])
  for (const node of workflow.nodes) if (node.harness) ids.add(node.harness)
  return Object.fromEntries([...ids].map((id) => [id, new MockAdapter({ id })]))
}

/**
 * The effect seam, wired to the clock instead of to the world.
 *
 * A `spawn_agent` costs its node's per-turn estimate; a `run_gate` costs the
 * sum of its gates' estimates. Every other verb — branching, merging, pushing,
 * opening a PR, writing tracking — is charged nothing, because none of them is
 * a scheduling constraint and pretending to estimate them would add noise to
 * the one number this exists to produce.
 *
 * The facts it returns are the clean path: reviews pass and gates exit zero.
 */
class SimulationExecutor implements EffectExecutor {
  readonly records: EffectRecord[] = []
  readonly #nodes: ReadonlyMap<string, Node>
  readonly #workflow: Workflow
  readonly #clock: VirtualClock
  readonly #estimates: DurationEstimates

  constructor(workflow: Workflow, clock: VirtualClock, estimates: DurationEstimates) {
    this.#workflow = workflow
    this.#clock = clock
    this.#estimates = estimates
    this.#nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  }

  async execute(invocation: EffectInvocation): Promise<EffectOutcome> {
    const nodeId = String(invocation.context.node?.['id'] ?? '')
    const verb = invocation.effect.definitionId
    const startedAtMs = this.#clock.now()

    const gates = verb === 'run_gate' ? this.#gatesOf(nodeId, invocation.effect.params['gate']) : []
    const costMs =
      verb === 'spawn_agent'
        ? (this.#estimates.nodes?.[nodeId] ?? this.#estimates.defaultAgentTurnMs ?? DEFAULT_AGENT_TURN_MS)
        : gates.reduce(
            (total, id) =>
              total + (this.#estimates.gates?.[id] ?? this.#estimates.defaultGateMs ?? DEFAULT_GATE_MS),
            0,
          )

    if (costMs > 0) await this.#clock.sleep(costMs)
    this.records.push({
      nodeId,
      verb,
      resources: this.#resourcesOf(gates),
      startedAtMs,
      finishedAtMs: this.#clock.now(),
    })

    if (verb === 'run_gate') return { facts: { gate: { exit_code: 0 } } }
    if (verb === 'spawn_agent' && invocation.effect.params['role'] === 'reviewer') {
      return { facts: { review: { verdict: 'pass' } } }
    }
    return {}
  }

  /** The gates a `run_gate` runs: one named, or every gate the node declared. */
  #gatesOf(nodeId: string, named: unknown): string[] {
    if (typeof named === 'string') return [named]
    return [...(this.#nodes.get(nodeId)?.gates ?? [])]
  }

  #resourcesOf(gates: readonly string[]): string[] {
    const resources = new Set<string>()
    for (const id of gates) {
      for (const resource of this.#workflow.gates[id]?.requires ?? []) resources.add(resource)
    }
    return [...resources].sort()
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Folds the tape into the schedule.
 *
 * Every wait is derived rather than declared: virtual time that passed for a
 * node without being charged to one of its effects is time it spent queued.
 * The gap before its first effect is the lane it was waiting for; a gap before
 * a `run_gate` is that gate's pools.
 */
function summarize(
  workflow: Workflow,
  run: RunReport,
  records: readonly EffectRecord[],
  pools: MeasuredPools,
): SimulationReport {
  const byNode = new Map<string, EffectRecord[]>()
  for (const record of records) {
    const list = byNode.get(record.nodeId)
    if (list === undefined) byNode.set(record.nodeId, [record])
    else list.push(record)
  }

  const finished = new Map<string, number>()
  const nodes: SimulatedNode[] = []

  // Declaration order is a topological order for every graph the scheduler will
  // run, so a dependency's finish time is always known by the time it is read.
  for (const node of workflow.nodes) {
    const own = byNode.get(node.id) ?? []
    const startedAtMs = own[0]?.startedAtMs ?? null
    const finishedAtMs = own.at(-1)?.finishedAtMs ?? null
    const readyAtMs = node.depends_on.reduce(
      (latest, dep) => Math.max(latest, finished.get(dep.node) ?? 0),
      0,
    )

    const waits: Record<string, number> = {}
    const add = (resource: string, ms: number): void => {
      if (ms > 0) waits[resource] = (waits[resource] ?? 0) + ms
    }
    if (startedAtMs !== null) add(LANE, startedAtMs - readyAtMs)

    let busyMs = 0
    let previous = startedAtMs ?? 0
    for (const record of own) {
      for (const resource of record.resources) add(resource, record.startedAtMs - previous)
      busyMs += record.finishedAtMs - record.startedAtMs
      previous = record.finishedAtMs
    }
    if (finishedAtMs !== null) finished.set(node.id, finishedAtMs)

    nodes.push({
      id: node.id,
      wave: run.waves[node.id] ?? 0,
      status: run.statuses[node.id] ?? 'pending',
      readyAtMs,
      startedAtMs,
      finishedAtMs,
      busyMs,
      queueMs: Object.values(waits).reduce((total, ms) => total + ms, 0),
      waits,
    })
  }

  return {
    status: run.status,
    ...(run.stop === undefined ? {} : { stop: run.stop }),
    projectedMs: nodes.reduce((latest, node) => Math.max(latest, node.finishedAtMs ?? 0), 0),
    statuses: run.statuses,
    nodes,
    criticalPath: criticalPath(workflow, nodes),
    pools: pools.contention(),
  }
}

/**
 * The chain that produced the projected wall clock, root first.
 *
 * Walks backwards over the *observed* schedule rather than forwards over
 * declared durations: start at the node that finished last, and step to
 * whichever of its dependencies finished latest, since that is the one whose
 * finish gated this node's start. Repeated to a node with no dependencies.
 *
 * Reading the schedule rather than the graph is what makes the answer useful:
 * the path it reports includes queueing, so a chain made long by waiting for a
 * lane shows up as the critical path it actually was. On an uncontended run it
 * reduces to the longest path by duration, which is not the path with the most
 * nodes. Ties break on declaration order, so the report is deterministic.
 */
function criticalPath(workflow: Workflow, nodes: readonly SimulatedNode[]): CriticalPathStep[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depsOf = new Map(workflow.nodes.map((node) => [node.id, node.depends_on.map((d) => d.node)]))

  let cursor: SimulatedNode | undefined
  for (const node of nodes) {
    if (node.finishedAtMs === null) continue
    if (cursor === undefined || node.finishedAtMs > (cursor.finishedAtMs ?? 0)) cursor = node
  }

  const path: CriticalPathStep[] = []
  const seen = new Set<string>()
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    path.unshift({
      nodeId: cursor.id,
      wave: cursor.wave,
      startedAtMs: cursor.startedAtMs ?? 0,
      finishedAtMs: cursor.finishedAtMs ?? 0,
      busyMs: cursor.busyMs,
      queueMs: cursor.queueMs,
    })

    let next: SimulatedNode | undefined
    for (const id of depsOf.get(cursor.id) ?? []) {
      const dep = byId.get(id)
      if (dep?.finishedAtMs === undefined || dep.finishedAtMs === null) continue
      if (next === undefined || dep.finishedAtMs > (next.finishedAtMs ?? 0)) next = dep
    }
    cursor = next
  }
  return path
}
