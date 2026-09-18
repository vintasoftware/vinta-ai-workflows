/**
 * Critical-path and queue analytics (§13.3).
 *
 * Every run here is a **synthetic journal**: events appended at timestamps the
 * test chooses. Nothing spawns, no agent runs, no clock is read. That is not a
 * convenience — `Journal.append` stamps `Date.now()`, so a real journal cannot
 * express "this node queued for exactly one hundred milliseconds", and the
 * whole point of these assertions is that the arithmetic is exact rather than
 * approximately right. `tests/journal.test.ts` owns the round trip through
 * SQLite; this file owns the fold.
 *
 * The assertions that matter are the two reconciliations. A report whose
 * numbers do not add up is worse than no report, because it will be believed —
 * so the splits are checked against every node's span on every run built here,
 * and the critical path against the run's observed elapsed time, with `toBe`
 * and never a tolerance.
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeRun,
  type AnalyticsSource,
  type NodeAnalytics,
  type PoolContention,
  type RunAnalytics,
} from '../src/analytics/analytics.ts'
import { computeWaves } from '../src/graph.ts'
import type {
  GatePoolPhase,
  GateStatus,
  NewEvent,
  NodeStatus,
  RunStatus,
  StoredEvent,
} from '../src/journal/events.ts'
import type { Workflow, WorkflowInput } from '../src/types.ts'
import { parseWorkflow } from '../src/validate.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN = 'run-1'

const workflow = (
  nodes: WorkflowInput['nodes'],
  resources: WorkflowInput['resources'] = { lane: { capacity: 4, kind: 'worktree' } },
  gates: WorkflowInput['gates'] = {},
): Workflow => {
  const result = parseWorkflow({
    schema_version: 1,
    id: 'analytics',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources,
    gates,
    nodes,
  } satisfies WorkflowInput)
  if (!result.ok) throw new Error('test workflow fixture is invalid')
  return result.workflow
}

const phase = (id: string, deps: readonly string[] = []) => ({
  id,
  name: `phase ${id}`,
  prompt_ref: `plan.md#${id}`,
  depends_on: deps.map((node) => ({ node, artifact: `${node} output` })),
})

/**
 * A journal with the timestamps written by hand. Satisfies `AnalyticsSource`
 * structurally, exactly as `Journal` does, so the module under test cannot tell
 * the difference and does not have to be given a database to be measured.
 */
class Tape implements AnalyticsSource {
  readonly #workflow: Workflow
  readonly #events: StoredEvent[] = []

  constructor(wf: Workflow) {
    this.#workflow = wf
  }

  readWorkflow(): Workflow {
    return this.#workflow
  }

  events(): readonly StoredEvent[] {
    return this.#events
  }

  push(ts: number, event: NewEvent): this {
    this.#events.push({ ...event, id: this.#events.length + 1, ts } as StoredEvent)
    return this
  }

  /** `run_started`, plus the `node_registered` `createRun` emits per node. */
  begin(ts: number): this {
    this.push(ts, {
      runId: RUN,
      type: 'run_started',
      payload: { workflow_id: this.#workflow.id, base_branch: this.#workflow.base_branch },
    })
    const waves = computeWaves(this.#workflow.nodes)
    for (const node of this.#workflow.nodes) {
      this.push(ts, {
        runId: RUN,
        nodeId: node.id,
        type: 'node_registered',
        payload: { wave: waves.get(node.id) ?? 1, harness: this.#workflow.defaults.harness },
      })
    }
    return this
  }

  end(ts: number, status: Exclude<RunStatus, 'running'> = 'done'): this {
    return this.push(ts, { runId: RUN, type: 'run_ended', payload: { status } })
  }

  status(ts: number, nodeId: string, status: NodeStatus): this {
    return this.push(ts, { runId: RUN, nodeId, type: 'node_status', payload: { status } })
  }

  lane(ts: number, nodeId: string, lane = `${RUN}-lane-1`): this {
    return this.push(ts, { runId: RUN, nodeId, type: 'node_assigned', payload: { lane } })
  }

  /** One edge of a gate-pool acquisition, exactly as the scheduler writes it. */
  gatePool(ts: number, nodeId: string, phase: GatePoolPhase, resources: readonly string[]): this {
    return this.push(ts, { runId: RUN, nodeId, type: 'gate_pool', payload: { phase, resources } })
  }

  /** A gate that queued for `resources` from `from`, was granted at `granted`, ran until `to`. */
  gated(
    nodeId: string,
    resources: readonly string[],
    from: number,
    granted: number,
    to: number,
  ): this {
    this.gatePool(from, nodeId, 'requested', resources)
    this.gatePool(granted, nodeId, 'granted', resources)
    return this.gatePool(to, nodeId, 'released', resources)
  }

  gateResult(ts: number, nodeId: string, gate: string, status: GateStatus = 'passed'): this {
    return this.push(ts, {
      runId: RUN,
      nodeId,
      type: 'gate_result',
      payload: { gate, exit_code: status === 'passed' ? 0 : 1, status, duration_ms: 1000, cached: false },
    })
  }

  /** A node dispatched, granted a lane and finished, with no waiting in between. */
  ran(nodeId: string, from: number, to: number, laneAt = from): this {
    this.status(from, nodeId, 'running')
    this.lane(laneAt, nodeId)
    return this.status(to, nodeId, 'done')
  }
}

const nodeOf = (report: RunAnalytics, nodeId: string): NodeAnalytics => {
  const node = report.nodes.find((one) => one.nodeId === nodeId)
  if (!node) throw new Error(`node ${nodeId} missing from the report`)
  return node
}

const poolOf = (report: RunAnalytics, resource: string): PoolContention => {
  const pool = report.pools.find((one) => one.resource === resource)
  if (!pool) throw new Error(`pool ${resource} missing from the report`)
  return pool
}

const ids = (report: RunAnalytics): string[] => report.criticalPath.map((step) => step.nodeId)

/**
 * The two identities, asserted together on every run this file builds. Called
 * from each test rather than from one shared test so a failure names the run
 * that broke rather than a fixture index.
 */
const expectReconciles = (report: RunAnalytics): void => {
  for (const node of report.nodes) {
    const { spanMs, laneQueueMs, workingMs, capacityWaitMs, suspendedMs } = node.split
    expect(laneQueueMs + workingMs + capacityWaitMs + suspendedMs).toBe(spanMs)
    // The fifth figure is a *subset* of `workingMs`, not a fifth share of the
    // span: the node holds its lane while it queues for a gate pool (§6). A
    // gate-pool wait that escaped `workingMs` would break the identity above,
    // so it is checked here rather than left implicit in the docs.
    expect(node.split.gatePoolQueueMs).toBeLessThanOrEqual(workingMs)
  }
  const walked =
    report.criticalPath.reduce((total, step) => total + step.gapMs + step.split.spanMs, 0) +
    report.tailGapMs
  expect(walked).toBe(report.elapsedMs)
  expect(report.criticalPathMs).toBe(report.elapsedMs)
}

// ---------------------------------------------------------------------------

describe('critical path', () => {
  /**
   * The chain that took longest is not the chain with the most nodes. `a→b→c`
   * has three hops and finishes at 300; `a→d` has two and finishes at 1000. A
   * report that counted nodes, or walked the graph forwards, would name the
   * wrong one.
   */
  it('follows elapsed time, not node count', () => {
    const wf = workflow([phase('a'), phase('b', ['a']), phase('c', ['b']), phase('d', ['a'])])
    const tape = new Tape(wf)
      .begin(0)
      .ran('a', 0, 100)
      .ran('b', 100, 200)
      .ran('c', 200, 300)
      .ran('d', 100, 1000)
      .end(1000)

    const report = analyzeRun(tape, RUN)

    expect(ids(report)).toEqual(['a', 'd'])
    expect(report.criticalPath.map((step) => step.split.spanMs)).toEqual([100, 900])
    expect(report.elapsedMs).toBe(1000)
    expectReconciles(report)
  })

  it('reports a single node as the whole path', () => {
    const wf = workflow([phase('only')])
    const tape = new Tape(wf).begin(0).ran('only', 0, 1000).end(1000)

    const report = analyzeRun(tape, RUN)

    expect(ids(report)).toEqual(['only'])
    expect(report.criticalPath[0]?.gapMs).toBe(0)
    expect(report.criticalPath[0]?.split.spanMs).toBe(1000)
    expect(report.tailGapMs).toBe(0)
    expectReconciles(report)
  })

  /**
   * Elapsed time the chain does not account for is reported as a gap, never
   * absorbed into a node's span — which is what keeps the identity exact on a
   * run with setup before the first dispatch and teardown after the last.
   */
  it('accounts for time outside every node span as gaps', () => {
    const wf = workflow([phase('a'), phase('b', ['a'])])
    const tape = new Tape(wf).begin(0).ran('a', 50, 150).ran('b', 200, 300).end(400)

    const report = analyzeRun(tape, RUN)

    expect(ids(report)).toEqual(['a', 'b'])
    expect(report.criticalPath.map((step) => step.gapMs)).toEqual([50, 50])
    expect(report.tailGapMs).toBe(100)
    expect(report.elapsedMs).toBe(400)
    expectReconciles(report)
  })

  /** Two chains ending at the same instant: declaration order decides, always. */
  it('breaks ties on declaration order', () => {
    const wf = workflow([phase('a'), phase('b'), phase('c', ['a']), phase('d', ['b'])])
    const tape = new Tape(wf)
      .begin(0)
      .ran('a', 0, 100)
      .ran('b', 0, 100)
      .ran('c', 100, 200)
      .ran('d', 100, 200)
      .end(200)

    expect(ids(analyzeRun(tape, RUN))).toEqual(['a', 'c'])
  })

  it('refuses a log that does not describe a run', () => {
    const tape = new Tape(workflow([phase('a')]))
    expect(() => analyzeRun(tape, RUN)).toThrow(/run_started/)
  })
})

describe('queue-wait attribution', () => {
  /**
   * One run carrying every wait the journal can tell apart, plus the one it
   * cannot.
   *
   * `b` is dispatched with `a`, into a one-lane pool: it queues 100ms for the
   * lane, works 50ms, is refused a spawn and spends 50ms in a capacity window
   * having given the lane back, queues 30ms for a lane again on the retry, and
   * works out the rest.
   *
   * Gate-pool queueing is asserted as **absent from the log**, not as a number.
   * Nothing in the event vocabulary marks a gate pool being acquired — the
   * scheduler takes those through `leases`, a table cleared on open whose rows
   * are deleted on release — so the only honest report is `null` plus a named
   * gap. An inferred figure here would be believed.
   */
  const contended = (): Tape => {
    const wf = workflow([phase('a'), phase('b')], {
      lane: { capacity: 1, kind: 'worktree' },
      'test-suite': { capacity: 1, kind: 'semaphore' },
    })
    return new Tape(wf)
      .begin(0)
      .ran('a', 0, 100)
      .status(0, 'b', 'running')
      .lane(100, 'b')
      .status(150, 'b', 'waiting_on_capacity')
      .status(200, 'b', 'running')
      .lane(230, 'b')
      .status(400, 'b', 'done')
      .end(450)
  }

  it('separates lane queueing from a capacity wait', () => {
    const report = analyzeRun(contended(), RUN)
    const b = nodeOf(report, 'b')

    expect(b.split.laneQueueMs).toBe(130) // 0→100, then 200→230 after the retry
    expect(b.split.capacityWaitMs).toBe(50) // 150→200
    expect(b.split.workingMs).toBe(220) // 100→150 and 230→400
    expect(b.split.suspendedMs).toBe(0)
    expect(b.split.spanMs).toBe(400)
    expect(nodeOf(report, 'a').split).toMatchObject({ laneQueueMs: 0, workingMs: 100, spanMs: 100 })
  })

  /**
   * A run with no gate acquisitions in it queued for no gate pool. That is a
   * measurement, not an absence — which is the whole difference between this
   * and the `null` this figure used to be.
   */
  it('reports zero gate-pool queueing on a run with no gate acquisitions', () => {
    const report = analyzeRun(contended(), RUN)

    expect(nodeOf(report, 'b').split.gatePoolQueueMs).toBe(0)
    expect(report.gaps).toEqual([])
    expect(poolOf(report, 'test-suite')).toMatchObject({
      attribution: 'exact',
      peakHeld: 0,
      busyMs: 0,
      saturatedMs: 0,
      queuedMs: 0,
    })
  })

  it('measures the lane pool exactly', () => {
    const pool = poolOf(analyzeRun(contended(), RUN), 'lane')

    expect(pool).toMatchObject({
      attribution: 'exact',
      capacity: 1,
      peakHeld: 1,
      queuedMs: 130,
      // Held 0→150 (a, then b) and 230→400. The capacity window 150→230 is the
      // one stretch of this run where the lane was genuinely free.
      busyMs: 320,
      saturatedMs: 320,
    })
  })

  it('reconciles every split on the contended run', () => {
    expectReconciles(analyzeRun(contended(), RUN))
  })

  /**
   * A pause is a pause. Counting it as work would make a node that waited
   * overnight for an answer look like the most expensive phase in the run;
   * counting it as queueing would blame a pool that was never involved.
   */
  it('attributes a human-gate suspension as suspended', () => {
    const wf = workflow([phase('a')])
    const tape = new Tape(wf)
      .begin(0)
      .status(0, 'a', 'running')
      .lane(0, 'a')
      .push(100, {
        runId: RUN,
        nodeId: 'a',
        type: 'human_question',
        payload: { question: 'Ship it?', kind: 'confirm', effect_id: 'e1' },
      })
      .status(100, 'a', 'awaiting_human')
      .push(400, {
        runId: RUN,
        nodeId: 'a',
        type: 'human_answered',
        payload: { effect_id: 'e1', answer: true },
      })
      .status(400, 'a', 'running')
      .status(500, 'a', 'done')
      .end(500)

    const report = analyzeRun(tape, RUN)

    expect(nodeOf(report, 'a').split).toEqual({
      spanMs: 500,
      suspendedMs: 300,
      workingMs: 200,
      laneQueueMs: 0,
      capacityWaitMs: 0,
      gatePoolQueueMs: 0,
    })
    // §6: the lane is held across a pause, so the pool stays busy through it.
    expect(poolOf(report, 'lane')).toMatchObject({ busyMs: 500 })
    expectReconciles(report)
  })
})

// ---------------------------------------------------------------------------
// Gate pools — §13.3's other half: is gate capacity the constraint, or lanes?
// ---------------------------------------------------------------------------

describe('gate pools', () => {
  const RESOURCES = {
    lane: { capacity: 2, kind: 'worktree' },
    'test-suite': { capacity: 1, kind: 'semaphore' },
  } as const satisfies WorkflowInput['resources']

  const GATES = {
    tests: { cmd: 'pnpm test', requires: ['test-suite'], timeout_s: 600 },
  } as const satisfies WorkflowInput['gates']

  /**
   * Two nodes, one gate slot. `a` takes it at 100 and holds it to 300; `b`
   * asks at 200 and is granted only when `a` gives it back. Every number
   * below is a subtraction over those four instants, which is exactly what the
   * `leases` table could not express.
   */
  const queued = (): Tape => {
    const wf = workflow([phase('a'), phase('b')], RESOURCES, GATES)
    return new Tape(wf)
      .begin(0)
      .status(0, 'a', 'running')
      .lane(0, 'a')
      .status(0, 'b', 'running')
      .lane(0, 'b', `${RUN}-lane-2`)
      .gated('a', ['test-suite'], 100, 100, 300)
      .gated('b', ['test-suite'], 200, 300, 500)
      .status(400, 'a', 'done')
      .status(600, 'b', 'done')
      .end(600)
  }

  it('measures gate-pool queue time as a real number', () => {
    const report = analyzeRun(queued(), RUN)

    // `a` was granted the moment it asked; `b` waited 200→300 for `a`'s slot.
    expect(nodeOf(report, 'a').split.gatePoolQueueMs).toBe(0)
    expect(nodeOf(report, 'b').split.gatePoolQueueMs).toBe(100)
  })

  /**
   * The assertion the whole design has to survive: a fifth figure that is a
   * subset of `workingMs` must not disturb the partition of the span, and the
   * critical path must still account for the run exactly.
   */
  it('reconciles exactly with a gate-pool wait inside the span', () => {
    expectReconciles(analyzeRun(queued(), RUN))
  })

  it('measures a non-lane pool exactly instead of reporting it unattributed', () => {
    const report = analyzeRun(queued(), RUN)

    expect(poolOf(report, 'test-suite')).toEqual({
      resource: 'test-suite',
      capacity: 1,
      attribution: 'exact',
      // Held 100→300 by `a` and 300→500 by `b`: one slot, never two.
      peakHeld: 1,
      busyMs: 400,
      // Capacity 1, so every busy millisecond is a saturated one — which is
      // the number that says the gate, not the lane count, was the constraint.
      saturatedMs: 400,
      queuedMs: 100,
    })
    expect(report.gaps).toEqual([])
  })

  /**
   * A pool two nodes hold at once is not saturated at capacity 2, and the
   * report has to say so — otherwise "buy more gate slots" reads as the
   * answer to every run.
   */
  it('separates busy from saturated on a pool with room', () => {
    const wf = workflow([phase('a'), phase('b')], {
      lane: { capacity: 2, kind: 'worktree' },
      'test-suite': { capacity: 2, kind: 'semaphore' },
    })
    const tape = new Tape(wf)
      .begin(0)
      .ran('a', 0, 500)
      .ran('b', 0, 500, 0)
      .gated('a', ['test-suite'], 100, 100, 400)
      .gated('b', ['test-suite'], 200, 200, 300)
      .end(500)

    expect(poolOf(analyzeRun(tape, RUN), 'test-suite')).toMatchObject({
      capacity: 2,
      attribution: 'exact',
      peakHeld: 2,
      busyMs: 300, // 100→400
      saturatedMs: 100, // 200→300, the only stretch with both slots taken
      queuedMs: 0,
    })
  })

  /** A wait still open when the window ends is a floor, not nothing. */
  it('counts a wait still open at the edge of the observed window', () => {
    const wf = workflow([phase('a')], RESOURCES, GATES)
    const tape = new Tape(wf)
      .begin(0)
      .status(0, 'a', 'running')
      .lane(0, 'a')
      .gatePool(100, 'a', 'requested', ['test-suite'])

    const report = analyzeRun(tape, RUN, { nowMs: 400 })

    expect(nodeOf(report, 'a').split.gatePoolQueueMs).toBe(300)
    expect(poolOf(report, 'test-suite')).toMatchObject({ queuedMs: 300, busyMs: 0 })
    expectReconciles(report)
  })

  /**
   * The gap that replaced the two this module used to emit. It fires on
   * positive evidence in both directions — a gate that ran, needing a pool
   * whose acquisition was never journalled — which is what a run recorded
   * before these events existed looks like. Reporting zero occupancy for it
   * would be the same lie, pointed the other way.
   */
  it('reports a pool as unattributed when a gate ran without journalling its acquisition', () => {
    const wf = workflow([phase('a')], RESOURCES, GATES)
    const tape = new Tape(wf)
      .begin(0)
      .ran('a', 0, 400)
      .gateResult(200, 'a', 'tests')
      .end(400)

    const report = analyzeRun(tape, RUN)

    expect(report.gaps.map((gap) => gap.kind)).toEqual(['gate_pool_events_missing'])
    expect(report.gaps[0]?.resources).toEqual(['test-suite'])
    expect(poolOf(report, 'test-suite')).toMatchObject({
      attribution: 'unattributed',
      reason: 'gate_pool_events_missing',
    })
    // The lane pool is measured from its own events and is unaffected.
    expect(poolOf(report, 'lane')).toMatchObject({ attribution: 'exact', busyMs: 400 })
  })

  /** A gate that ran and journalled its acquisition leaves nothing unknown. */
  it('emits no gap when the acquisition was journalled', () => {
    const wf = workflow([phase('a')], RESOURCES, GATES)
    const tape = new Tape(wf)
      .begin(0)
      .ran('a', 0, 400)
      .gated('a', ['test-suite'], 100, 100, 300)
      .gateResult(300, 'a', 'tests')
      .end(400)

    expect(analyzeRun(tape, RUN).gaps).toEqual([])
  })
})

describe('lane idleness', () => {
  /**
   * A chain through a four-lane pool. Exactly one lane is ever in use, so three
   * quarters of the run's lane capacity was free and unusable — the number that
   * says the graph, not the pool, is the constraint. Buying lanes buys nothing
   * here.
   */
  it('is high on a graph-bound run', () => {
    const wf = workflow([phase('a'), phase('b', ['a']), phase('c', ['b'])])
    const tape = new Tape(wf).begin(0).ran('a', 0, 100).ran('b', 100, 200).ran('c', 200, 300).end(300)

    const report = analyzeRun(tape, RUN)

    expect(report.laneIdleness).toEqual({
      capacity: 4,
      slotMs: 1200,
      idleSlotMs: 900,
      idleFraction: 0.75,
      freeWallMs: 300,
    })
    expect(poolOf(report, 'lane')).toMatchObject({ peakHeld: 1, saturatedMs: 0, queuedMs: 0 })
    expectReconciles(report)
  })

  /**
   * The same total work, one lane, three independent nodes. The lane is never
   * free, the pool is saturated for the whole run, and 300ms was spent queued
   * for it — pool-bound, and the opposite prescription.
   */
  it('is zero on a pool-bound run', () => {
    const wf = workflow([phase('a'), phase('b'), phase('c')], {
      lane: { capacity: 1, kind: 'worktree' },
    })
    const tape = new Tape(wf)
      .begin(0)
      .ran('a', 0, 100)
      .ran('b', 0, 200, 100)
      .ran('c', 0, 300, 200)
      .end(300)

    const report = analyzeRun(tape, RUN)

    expect(report.laneIdleness).toEqual({
      capacity: 1,
      slotMs: 300,
      idleSlotMs: 0,
      idleFraction: 0,
      freeWallMs: 0,
    })
    expect(poolOf(report, 'lane')).toMatchObject({
      peakHeld: 1,
      busyMs: 300,
      saturatedMs: 300,
      queuedMs: 300, // b waited 100, c waited 200
    })
    expectReconciles(report)
  })
})

describe('an in-progress run', () => {
  /**
   * Nothing here throws and nothing is guessed: the window ends at the last
   * instant the log can vouch for, every figure inside it is a floor, and the
   * report says so. A live node is a legitimate tip of the critical path —
   * "what is this run currently waiting on" is the question a partial report
   * exists to answer.
   */
  const live = (): Tape => {
    const wf = workflow([phase('a'), phase('b', ['a'])])
    return new Tape(wf).begin(0).ran('a', 0, 100).status(100, 'b', 'running').lane(120, 'b')
  }

  it('reports partial figures and marks them partial', () => {
    const report = analyzeRun(live(), RUN, { nowMs: 300 })

    expect(report.partial).toBe(true)
    expect(report.status).toBe('running')
    expect(report.endedAtMs).toBeNull()
    expect(report.observedAsOfMs).toBe(300)
    expect(report.elapsedMs).toBe(300)

    const b = nodeOf(report, 'b')
    expect(b.inFlight).toBe(true)
    expect(b.finishedAtMs).toBeNull()
    expect(b.split).toMatchObject({ spanMs: 200, laneQueueMs: 20, workingMs: 180 })
    expect(ids(report)).toEqual(['a', 'b'])
    expectReconciles(report)
  })

  it('falls back to the last recorded event when no clock is supplied', () => {
    const report = analyzeRun(live(), RUN)

    // The last event is b's lane grant at 120: the log cannot vouch for a later
    // instant, and inventing one would report idleness nothing witnessed.
    expect(report.observedAsOfMs).toBe(120)
    expect(report.elapsedMs).toBe(120)
    expect(nodeOf(report, 'b').split.spanMs).toBe(20)
    expectReconciles(report)
  })

  it('is complete and not partial once the run ends', () => {
    const report = analyzeRun(live().status(400, 'b', 'done').end(400), RUN)

    expect(report.partial).toBe(false)
    expect(report.status).toBe('done')
    expect(nodeOf(report, 'b').inFlight).toBe(false)
    expectReconciles(report)
  })

  /** A node its dependency failed out from under never ran, and never appears. */
  it('gives a blocked node a zero span and keeps it off the path', () => {
    const wf = workflow([phase('a'), phase('b', ['a'])])
    const tape = new Tape(wf)
      .begin(0)
      .status(0, 'a', 'running')
      .lane(0, 'a')
      .status(100, 'a', 'failed')
      .status(100, 'b', 'blocked')
      .end(100, 'failed')

    const report = analyzeRun(tape, RUN)

    expect(nodeOf(report, 'b')).toMatchObject({ startedAtMs: null, inFlight: false })
    expect(nodeOf(report, 'b').split.spanMs).toBe(0)
    expect(ids(report)).toEqual(['a'])
    expectReconciles(report)
  })
})
