/**
 * Dry-run / simulation mode (§13.1).
 *
 * Every assertion here is an exact number. A simulation whose only property is
 * "it finished" would tell an operator nothing about whether `lane` should be 3
 * or 6, which is the question §13.1 says the feature exists to answer — so the
 * schedule, the critical path and the contention are pinned to hand-computed
 * values, and the projection is asserted to be byte-identical run to run.
 *
 * Nothing here waits on real time: the multi-hour projections below complete in
 * milliseconds, which is the observable proof that the clock is virtual.
 */
import { describe, expect, it } from 'vitest'

import { MockAdapter } from '../src/harness/mock.ts'
import { formatSimulation, simulate, type SimulationReport } from '../src/simulate/index.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

const HARNESS = 'claude-code'

/** Minutes, in milliseconds. Every duration in this file is written this way. */
const min = (n: number): number => n * 60_000

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/** One agent turn, then done: a node's duration is exactly its estimate. */
const SOLO = {
  states: [
    {
      id: 'work',
      name: 'Work',
      position: { x: 0, y: 0 },
      onEnter: [{ id: 'e-work', definitionId: 'spawn_agent', params: { role: 'implementer' } }],
    },
    { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [{ id: 't-done', from: 'work', to: 'done' }],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

/** One turn, then the node's declared gates: a turn plus a queued resource. */
const GATED = {
  states: [
    {
      id: 'work',
      name: 'Work',
      position: { x: 0, y: 0 },
      onEnter: [{ id: 'e-work', definitionId: 'spawn_agent', params: { role: 'implementer' } }],
    },
    {
      id: 'gate',
      name: 'Gate',
      position: { x: 200, y: 0 },
      onEnter: [{ id: 'e-gate', definitionId: 'run_gate', params: {} }],
    },
    { id: 'done', name: 'Done', position: { x: 400, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [
    { id: 't-gate', from: 'work', to: 'gate' },
    { id: 't-done', from: 'gate', to: 'done', guard: 'gate.exit_code == 0' },
  ],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

const node = (
  id: string,
  deps: readonly string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  name: id,
  depends_on: deps.map((dep) => ({ node: dep, artifact: `${dep}'s artifact` })),
  prompt_ref: `plan.md#${id}`,
  ...extra,
})

function makeWorkflow(
  nodes: readonly Record<string, unknown>[],
  options: {
    readonly lanes?: number
    readonly resources?: Record<string, unknown>
    readonly gates?: Record<string, unknown>
    readonly pipeline?: string
  } = {},
): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'sim-flow',
    base_branch: 'main',
    defaults: { harness: HARNESS, model: 'opus', pipeline: options.pipeline ?? 'solo' },
    resources: options.resources ?? { lane: { capacity: options.lanes ?? 4, kind: 'worktree' } },
    gates: options.gates ?? {},
    nodes,
    pipelines: { solo: SOLO, gated: GATED },
  })
}

const nodeById = (report: SimulationReport, id: string): SimulationReport['nodes'][number] => {
  const found = report.nodes.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no simulated node "${id}"`)
  return found
}

const poolById = (report: SimulationReport, id: string): SimulationReport['pools'][number] => {
  const found = report.pools.find((candidate) => candidate.resource === id)
  if (found === undefined) throw new Error(`no pool "${id}"`)
  return found
}

// ---------------------------------------------------------------------------
// 1: the schedule
// ---------------------------------------------------------------------------

describe('projected schedule', () => {
  it('produces an exact schedule from known durations', async () => {
    const report = await simulate({
      workflow: makeWorkflow([node('a'), node('b', ['a']), node('c', ['b'])]),
      estimates: { nodes: { a: min(60), b: min(30), c: min(10) } },
    })

    expect(report.status).toBe('completed')
    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done' })
    expect(report.projectedMs).toBe(min(100))

    expect(report.nodes).toEqual([
      {
        id: 'a',
        wave: 1,
        status: 'done',
        readyAtMs: 0,
        startedAtMs: 0,
        finishedAtMs: min(60),
        busyMs: min(60),
        queueMs: 0,
        waits: {},
      },
      {
        id: 'b',
        wave: 2,
        status: 'done',
        readyAtMs: min(60),
        startedAtMs: min(60),
        finishedAtMs: min(90),
        busyMs: min(30),
        queueMs: 0,
        waits: {},
      },
      {
        id: 'c',
        wave: 3,
        status: 'done',
        readyAtMs: min(90),
        startedAtMs: min(90),
        finishedAtMs: min(100),
        busyMs: min(10),
        queueMs: 0,
        waits: {},
      },
    ])

    // Four lanes for a chain: never saturated, nobody ever queued.
    expect(poolById(report, 'lane')).toEqual({
      resource: 'lane',
      capacity: 4,
      peakHeld: 1,
      busyMs: min(100),
      saturatedMs: 0,
      queuedMs: 0,
    })
  })

  it('runs independent nodes concurrently, so the projection is the longest of them', async () => {
    const report = await simulate({
      workflow: makeWorkflow([node('a'), node('b'), node('c')]),
      estimates: { nodes: { a: min(10), b: min(45), c: min(20) } },
    })

    expect(report.projectedMs).toBe(min(45))
    expect(nodeById(report, 'c').startedAtMs).toBe(0)
    expect(poolById(report, 'lane').peakHeld).toBe(3)
  })

  it('charges the documented default when a node has no estimate', async () => {
    const report = await simulate({ workflow: makeWorkflow([node('a')]) })
    // 20 minutes per agent turn, and `solo` spawns exactly one.
    expect(report.projectedMs).toBe(min(20))
  })
})

// ---------------------------------------------------------------------------
// 2: the critical path
// ---------------------------------------------------------------------------

describe('critical path', () => {
  it('follows duration, not node count, through a diamond', async () => {
    // The short branch has three nodes and the long branch has one. The
    // longest path is therefore the one with fewer hops:
    //   root(5) → heavy(100) → join(5)  = 110m   ← critical
    //   root(5) → s1(10) → s2(10) → s3(10) → join(5) = 40m
    const report = await simulate({
      workflow: makeWorkflow(
        [
          node('root'),
          node('heavy', ['root']),
          node('s1', ['root']),
          node('s2', ['s1']),
          node('s3', ['s2']),
          node('join', ['heavy', 's3']),
        ],
        { lanes: 6 },
      ),
      estimates: {
        nodes: { root: min(5), heavy: min(100), s1: min(10), s2: min(10), s3: min(10), join: min(5) },
      },
    })

    expect(report.projectedMs).toBe(min(110))
    expect(report.criticalPath.map((step) => step.nodeId)).toEqual(['root', 'heavy', 'join'])
    expect(report.criticalPath).toEqual([
      { nodeId: 'root', wave: 1, startedAtMs: 0, finishedAtMs: min(5), busyMs: min(5), queueMs: 0 },
      {
        nodeId: 'heavy',
        wave: 2,
        startedAtMs: min(5),
        finishedAtMs: min(105),
        busyMs: min(100),
        queueMs: 0,
      },
      {
        nodeId: 'join',
        wave: 5,
        startedAtMs: min(105),
        finishedAtMs: min(110),
        busyMs: min(5),
        queueMs: 0,
      },
    ])
    // The short branch finished long before the join could start — it was
    // never on the critical path even though it holds three of the six nodes.
    expect(nodeById(report, 's3').finishedAtMs).toBe(min(35))
  })
})

// ---------------------------------------------------------------------------
// 3: resource contention
// ---------------------------------------------------------------------------

describe('resource contention', () => {
  const FOUR = [node('a'), node('b'), node('c'), node('d')]
  const HOUR_EACH = { nodes: { a: min(60), b: min(60), c: min(60), d: min(60) } }

  it('lengthens the projection when lane capacity narrows, and says who waited', async () => {
    const wide = await simulate({
      workflow: makeWorkflow(FOUR, { lanes: 4 }),
      estimates: HOUR_EACH,
    })
    const narrow = await simulate({
      workflow: makeWorkflow(FOUR, { lanes: 2 }),
      estimates: HOUR_EACH,
    })

    expect(wide.projectedMs).toBe(min(60))
    expect(narrow.projectedMs).toBe(min(120))

    // Nobody queued at four lanes; the last two nodes queued an hour at two.
    expect(wide.nodes.map((n) => n.queueMs)).toEqual([0, 0, 0, 0])
    expect(narrow.nodes.map((n) => [n.id, n.startedAtMs, n.waits])).toEqual([
      ['a', 0, {}],
      ['b', 0, {}],
      ['c', min(60), { lane: min(60) }],
      ['d', min(60), { lane: min(60) }],
    ])

    expect(poolById(wide, 'lane')).toEqual({
      resource: 'lane',
      capacity: 4,
      peakHeld: 4,
      busyMs: min(60),
      saturatedMs: min(60),
      queuedMs: 0,
    })
    expect(poolById(narrow, 'lane')).toEqual({
      resource: 'lane',
      capacity: 2,
      peakHeld: 2,
      busyMs: min(120),
      saturatedMs: min(120),
      queuedMs: min(120),
    })
  })

  it('attributes a gate queue to the gate’s own pool, not to the lane', async () => {
    const report = await simulate({
      workflow: makeWorkflow([node('a', [], { gates: ['unit'] }), node('b', [], { gates: ['unit'] })], {
        pipeline: 'gated',
        resources: {
          lane: { capacity: 2, kind: 'worktree' },
          'test-suite': { capacity: 1, kind: 'semaphore' },
        },
        gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
      }),
      estimates: { nodes: { a: min(10), b: min(10) }, gates: { unit: min(30) } },
    })

    // Both implement 0→10. `a` gates 10→40; `b` holds its lane while it waits,
    // then gates 40→70.
    expect(report.projectedMs).toBe(min(70))
    expect(nodeById(report, 'a').waits).toEqual({})
    expect(nodeById(report, 'b').waits).toEqual({ 'test-suite': min(30) })
    expect(poolById(report, 'test-suite')).toEqual({
      resource: 'test-suite',
      capacity: 1,
      peakHeld: 1,
      busyMs: min(60),
      saturatedMs: min(60),
      queuedMs: min(30),
    })
    // Lanes were never the constraint here: both were held the whole run and
    // nobody ever queued for one.
    expect(poolById(report, 'lane').queuedMs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4: unrunnable graphs, caught without spawning anything
// ---------------------------------------------------------------------------

describe('unrunnable graphs', () => {
  it('reports a cycle without spawning', async () => {
    const adapter = new MockAdapter({ id: HARNESS })
    const report = await simulate({
      workflow: makeWorkflow([node('a', ['b']), node('b', ['a'])]),
      adapters: { [HARNESS]: adapter },
    })

    expect(report.status).toBe('stopped')
    expect(report.stop?.kind).toBe('cycle')
    expect(report.stop).toMatchObject({ cycle: expect.arrayContaining(['a', 'b']) })
    expect(report.projectedMs).toBe(0)
    expect(report.criticalPath).toEqual([])
    expect(adapter.spawned).toEqual([])
    expect(formatSimulation(report)).toContain('Nothing was spawned.')
  })

  it('reports an unsatisfiable resource requirement without spawning', async () => {
    const adapter = new MockAdapter({ id: HARNESS })
    const report = await simulate({
      workflow: makeWorkflow([node('a', [], { gates: ['e2e'] })], {
        gates: { e2e: { cmd: 'true', requires: ['gpu'] } },
      }),
      adapters: { [HARNESS]: adapter },
    })

    expect(report.status).toBe('stopped')
    expect(report.stop).toEqual({ kind: 'unsatisfiable', nodeId: 'a', resource: 'gpu' })
    expect(adapter.spawned).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5: determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('gives byte-identical output for the same input twice', async () => {
    const workflow = () =>
      makeWorkflow(
        [
          node('a', [], { gates: ['unit'] }),
          node('b', [], { gates: ['unit'] }),
          node('c', ['a'], { gates: ['unit'] }),
          node('d', ['a', 'b'], { gates: ['unit'] }),
        ],
        {
          pipeline: 'gated',
          resources: {
            lane: { capacity: 2, kind: 'worktree' },
            'test-suite': { capacity: 1, kind: 'semaphore' },
          },
          gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
        },
      )
    const estimates = {
      nodes: { a: min(31), b: min(17), c: min(43), d: min(7) },
      gates: { unit: min(13) },
    }

    const first = await simulate({ workflow: workflow(), estimates })
    const second = await simulate({ workflow: workflow(), estimates })

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(formatSimulation(second)).toBe(formatSimulation(first))
  })
})

// ---------------------------------------------------------------------------
// 6: the clock is virtual
// ---------------------------------------------------------------------------

describe('virtual time', () => {
  it('projects a multi-hour run in milliseconds of test time', async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(`n${i + 1}`))
    const startedAt = Date.now()
    const report = await simulate({
      workflow: makeWorkflow(nodes, { lanes: 3 }),
      estimates: { defaultAgentTurnMs: min(180) },
    })
    const elapsedMs = Date.now() - startedAt

    // Twelve three-hour nodes through three lanes: four batches, 12 hours.
    expect(report.projectedMs).toBe(min(720))
    expect(poolById(report, 'lane').saturatedMs).toBe(min(720))
    expect(elapsedMs).toBeLessThan(min(720))
    expect(elapsedMs).toBeLessThan(10_000)
  })
})
