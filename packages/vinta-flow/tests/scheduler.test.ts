/**
 * The scheduler, driven by `MockAdapter` and a recording effect executor: no
 * real agents, no git, no worktrees, and no real clock.
 *
 * Time is injected everywhere it matters. A capacity wait is measured in
 * minutes and hours (§6.1), so a test that slept for one would either take
 * hours or shrink the constant until it stopped testing anything. Every wait
 * here is advanced explicitly, which also makes "the run did not call this a
 * deadlock" an assertion about a defined state rather than about a race.
 *
 * Every test ends by asserting the pools drained to zero. A leaked lease is
 * invisible in the run it happens in and fatal three phases later, so it is
 * checked on the happy paths and on the failure paths alike.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdmissionControl } from '../src/admission/admission.ts'
import type { Clock } from '../src/admission/clock.ts'
import type {
  AgentSession,
  HarnessAdapter,
  HarnessCapabilities,
  SpawnRefusalKind,
} from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import type { EffectExecutor, EffectInvocation, EffectOutcome } from '../src/pipeline/effects.ts'
import type { GuardContext } from '../src/pipeline/guard.ts'
import { STANDARD_PHASE } from '../src/pipeline/standard.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import { createScheduler, type Scheduler } from '../src/scheduler/index.ts'
import { WorkflowSchema, type EffectId, type Workflow } from '../src/types.ts'

const HARNESS = 'claude-code'

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/** Lets every pending microtask run. Nothing here needs a real timer. */
const flush = async (turns = 5): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

function fakeClock(): { clock: Clock; advance: (ms: number) => Promise<void> } {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; wake: () => void }>()

  return {
    clock: {
      now: () => now,
      at: (at, wake) => {
        const id = (seq += 1)
        timers.set(id, { at, wake })
        return () => timers.delete(id)
      },
    },
    async advance(ms: number): Promise<void> {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.wake()
        }
      }
      await flush()
    },
  }
}

interface Call {
  readonly nodeId: string
  readonly effect: string
  readonly verb: EffectId
  /** The guard context the effect saw — where a queued steering message lands. */
  readonly context: GuardContext
}

/**
 * Wraps an adapter so its session stalls after `session_started` until the
 * test lets it go. Without it a `MockAdapter` run drains in microtasks and
 * there is no moment at which a §9 operation could reach a live session —
 * which is exactly the moment these tests are about.
 */
function stalling(inner: HarnessAdapter): {
  readonly adapter: HarnessAdapter
  /** True while a session is parked mid-stream. */
  live(): boolean
  release(): void
} {
  let parked = 0
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })

  const adapter: HarnessAdapter = {
    id: inner.id,
    capabilities: inner.capabilities,
    preflight: () => inner.preflight(),
    async spawn(task) {
      const outcome = await inner.spawn(task)
      if (!outcome.ok) return outcome
      const session = outcome.session
      const stalled: AgentSession = {
        id: session.id,
        events: {
          async *[Symbol.asyncIterator]() {
            let first = true
            for await (const event of session.events) {
              yield event
              if (first) {
                first = false
                parked += 1
                await gate
                parked -= 1
              }
            }
          },
        },
        send: (text) => session.send(text),
        interrupt: () => session.interrupt(),
        kill: () => session.kill(),
      }
      return { ok: true, session: stalled }
    },
  }
  return { adapter, live: () => parked > 0, release: () => open() }
}

/** Polls `read` until it is true. Nothing here waits on a fixed delay. */
async function until(read: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (read()) return
    await flush(1)
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface Recorder extends EffectExecutor {
  readonly calls: Call[]
}

/**
 * The effect seam. Outcomes are keyed by `effectId`, or by `nodeId:effectId`
 * when one node needs a different answer from the rest; a list is a
 * per-invocation script whose last entry repeats.
 */
function recorder(
  outcomes: Readonly<Record<string, EffectOutcome | readonly EffectOutcome[]>> = {},
  tap?: (call: Call) => void,
): Recorder {
  const calls: Call[] = []
  const seen = new Map<string, number>()

  return {
    calls,
    async execute(invocation: EffectInvocation): Promise<EffectOutcome> {
      const nodeId = String(invocation.context.node?.['id'] ?? '?')
      const call: Call = {
        nodeId,
        effect: invocation.effect.id,
        verb: invocation.effect.definitionId,
        context: invocation.context,
      }
      calls.push(call)
      tap?.(call)

      const key = `${nodeId}:${call.effect}`
      const scripted = outcomes[key] ?? outcomes[call.effect]
      if (scripted === undefined) return {}
      if (!Array.isArray(scripted)) return scripted as EffectOutcome

      const list = scripted as readonly EffectOutcome[]
      const nth = seen.get(key) ?? 0
      seen.set(key, nth + 1)
      return list[Math.min(nth, list.length - 1)] ?? {}
    },
  }
}

interface Rig {
  readonly scheduler: Scheduler
  readonly pools: ResourcePools
  readonly journal: Journal
  readonly adapter: MockAdapter
  readonly calls: Call[]
  readonly advance: (ms: number) => Promise<void>
  readonly poolNames: readonly string[]
  /** Present when `stall` was asked for: holds every session open mid-stream. */
  readonly stall: { live(): boolean; release(): void }
}

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function rig(
  workflow: Workflow,
  options: {
    readonly spawns?: readonly (SpawnRefusalKind | 'ok')[]
    readonly outcomes?: Readonly<Record<string, EffectOutcome | readonly EffectOutcome[]>>
    readonly tap?: (call: Call) => void
    readonly register?: boolean
    /** Holds every session open after `session_started`, for the §9 operations. */
    readonly stall?: boolean
    readonly capabilities?: Partial<HarnessCapabilities>
  } = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-scheduler-'))
  const journal = openJournal(dir)
  const runId = 'run-1'
  if (options.register !== false) journal.createRun(runId, workflow)

  // Strict FIFO: the aging window is a wall-clock affordance, and a test that
  // depended on it would be asserting about `Date.now()`.
  const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
  const { clock, advance } = fakeClock()
  const adapter = new MockAdapter({
    id: HARNESS,
    ...(options.spawns === undefined ? {} : { spawns: options.spawns }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  })
  const stall = stalling(adapter)
  const admission = new AdmissionControl({
    journal,
    runId,
    ceilings: { [HARNESS]: 8 },
    clock,
    // Full jitter with a fixed draw: the backoff is then the cap itself, which
    // is a number this test can advance past exactly.
    random: () => 1,
    baseBackoffMs: 1_000,
  })
  const executor = recorder(options.outcomes ?? {}, options.tap)

  const scheduler = createScheduler({
    workflow,
    runId,
    journal,
    pools,
    admission,
    adapters: { [HARNESS]: options.stall === true ? stall.adapter : adapter },
    executor,
    laneRoot: join(dir, 'lanes'),
  })

  cleanups.push(() => {
    admission.close()
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })

  return {
    scheduler,
    pools,
    journal,
    adapter,
    calls: executor.calls,
    advance,
    poolNames: Object.keys(workflow.resources),
    stall,
  }
}

/** Every journalled §9 operation for a node, in order. */
const operationsOf = (rig_: Rig, nodeId: string): unknown[] =>
  rig_.journal
    .events('run-1')
    .filter((event) => event.type === 'node_operation' && event.nodeId === nodeId)
    .map((event) => event.payload)

/** The node's normalized transcript, which is where a session's own record is. */
const transcriptOf = (rig_: Rig, nodeId: string): { type: string; text?: string; result?: string }[] =>
  rig_.journal.tailTranscript('run-1', nodeId, 100) as {
    type: string
    text?: string
    result?: string
  }[]

/** No leaked leases: every pool back to zero, and nobody still queued. */
function expectDrained(rig_: Rig): void {
  for (const name of rig_.poolNames) expect([name, rig_.pools.held(name)]).toEqual([name, 0])
  expect(rig_.pools.waiting).toBe(0)
  expect(rig_.journal.leases()).toEqual([])
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

const dep = (id: string) => ({ node: id, artifact: `${id}'s artifact` })

const node = (
  id: string,
  deps: readonly string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  name: id,
  depends_on: deps.map(dep),
  prompt_ref: `plan.md#${id}`,
  ...extra,
})

const spawn = (id: string, role: string): Record<string, unknown> => ({
  id,
  definitionId: 'spawn_agent',
  params: { role },
})

/** One agent turn, then done. The graph tests care about order, not pipelines. */
const SOLO = {
  states: [
    { id: 'work', name: 'Work', position: { x: 0, y: 0 }, onEnter: [spawn('e-work', 'implementer')] },
    { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [{ id: 't-done', from: 'work', to: 'done' }],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

/** Reaches a final state the host marked as failure. */
const EXPLODE = {
  states: [
    { id: 'work', name: 'Work', position: { x: 0, y: 0 }, onEnter: [spawn('e-work', 'implementer')] },
    { id: 'failed', name: 'Failed', position: { x: 200, y: 0 }, data: { outcome: 'failed' } },
  ],
  transitions: [{ id: 't-failed', from: 'work', to: 'failed' }],
  initialStateIds: ['work'],
  finalStateIds: ['failed'],
}

/** Several steps, so a node can still be in flight when another one fails. */
const LONG = {
  states: [
    { id: 's1', name: 'S1', position: { x: 0, y: 0 }, onEnter: [spawn('e-1', 'implementer')] },
    { id: 's2', name: 'S2', position: { x: 200, y: 0 }, onEnter: [spawn('e-2', 'reviewer')] },
    { id: 's3', name: 'S3', position: { x: 400, y: 0 }, onEnter: [spawn('e-3', 'reviewer')] },
    { id: 'done', name: 'Done', position: { x: 600, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [
    { id: 't-12', from: 's1', to: 's2' },
    { id: 't-23', from: 's2', to: 's3' },
    { id: 't-3done', from: 's3', to: 'done' },
  ],
  initialStateIds: ['s1'],
  finalStateIds: ['done'],
}

/**
 * The gate and the agent in one state, so the node is still holding the gate
 * pool while its session is live — the shape an operator pause has to unwind.
 */
const GATE_WORK = {
  states: [
    {
      id: 'work',
      name: 'Work',
      position: { x: 0, y: 0 },
      onEnter: [
        { id: 'e-gate', definitionId: 'run_gate', params: {} },
        spawn('e-work', 'implementer'),
      ],
    },
    { id: 'wrap', name: 'Wrap', position: { x: 200, y: 0 }, onEnter: [spawn('e-wrap', 'reviewer')] },
    { id: 'done', name: 'Done', position: { x: 400, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [
    { id: 't-wrap', from: 'work', to: 'wrap' },
    { id: 't-done', from: 'wrap', to: 'done' },
  ],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

/** A gate, then a question — the two resources rules in one machine. */
const GATED = {
  states: [
    {
      id: 'gate',
      name: 'Gate',
      position: { x: 0, y: 0 },
      onEnter: [
        { id: 'e-gate', definitionId: 'run_gate', params: {} },
        { id: 'e-ask', definitionId: 'await_human', params: { reason: 'gate-review' } },
      ],
    },
    { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [{ id: 't-answered', from: 'gate', to: 'done', guard: "human.answer == 'ship'" }],
  initialStateIds: ['gate'],
  finalStateIds: ['done'],
}

function makeWorkflow(
  nodes: readonly Record<string, unknown>[],
  options: {
    readonly lanes?: number
    readonly resources?: Record<string, unknown>
    readonly gates?: Record<string, unknown>
    readonly pipelines?: Record<string, unknown>
    readonly pipeline?: string
  } = {},
): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'test-flow',
    base_branch: 'main',
    defaults: { harness: HARNESS, model: 'opus', pipeline: options.pipeline ?? 'solo' },
    resources: options.resources ?? { lane: { capacity: options.lanes ?? 4, kind: 'worktree' } },
    gates: options.gates ?? {},
    nodes,
    pipelines: options.pipelines ?? {
      solo: SOLO,
      explode: EXPLODE,
      long: LONG,
      gated: GATED,
      'gate-work': GATE_WORK,
    },
  })
}

const nodeIdsOf = (calls: readonly Call[]): string[] => {
  const seen: string[] = []
  for (const call of calls) if (!seen.includes(call.nodeId)) seen.push(call.nodeId)
  return seen
}

// ---------------------------------------------------------------------------
// 1: graph shapes
// ---------------------------------------------------------------------------

describe('continuous DAG dispatch', () => {
  it('runs a chain in dependency order, one wave per link', async () => {
    const r = rig(makeWorkflow([node('a'), node('b', ['a']), node('c', ['b'])]))
    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done' })
    expect(nodeIdsOf(r.calls)).toEqual(['a', 'b', 'c'])
    expect(r.adapter.spawned.map((task) => task.nodeId)).toEqual(['a', 'b', 'c'])
    expect(report.waves).toEqual({ a: 1, b: 2, c: 3 })
    expectDrained(r)
  })

  it('runs a diamond with the middle pair together and the join last', async () => {
    const r = rig(
      makeWorkflow([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])]),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done', d: 'done' })
    expect(nodeIdsOf(r.calls)).toEqual(['a', 'b', 'c', 'd'])
    expect(report.waves).toEqual({ a: 1, b: 2, c: 2, d: 3 })
    expectDrained(r)
  })

  it('runs a wide fan-out, every leaf in the same wave', async () => {
    const leaves = ['b', 'c', 'd', 'e', 'f'].map((id) => node(id, ['a']))
    const r = rig(makeWorkflow([node('a'), ...leaves]))
    const report = await r.scheduler.run()

    expect(Object.values(report.statuses)).toEqual(Array(6).fill('done'))
    expect(report.waves).toEqual({ a: 1, b: 2, c: 2, d: 2, e: 2, f: 2 })
    expectDrained(r)
  })

  it('runs disconnected components without either waiting on the other', async () => {
    const r = rig(
      makeWorkflow([node('a'), node('b', ['a']), node('c'), node('d', ['c'])], { lanes: 2 }),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done', d: 'done' })
    // Both roots start before either child: the wave never gated anything.
    expect(nodeIdsOf(r.calls).slice(0, 2).sort()).toEqual(['a', 'c'])
    expect(report.waves).toEqual({ a: 1, b: 2, c: 1, d: 2 })
    expectDrained(r)
  })

  it('starts a node the moment its own dependencies are green, not when its wave fills', async () => {
    // `b` depends only on `a`; `c` is a long-running root in the same wave as
    // `a`. If dispatch waited for wave 1 to drain, `b` could not overlap `c`.
    const order: string[] = []
    const r = rig(
      makeWorkflow([node('a'), node('c', [], { pipeline: 'long' }), node('b', ['a'])]),
      { tap: (call) => order.push(`${call.nodeId}:${call.effect}`) },
    )
    await r.scheduler.run()

    const bStart = order.indexOf('b:e-work')
    const cEnd = order.lastIndexOf('c:e-3')
    expect(bStart).toBeGreaterThan(-1)
    expect(bStart).toBeLessThan(cEnd)
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 2: capacity
// ---------------------------------------------------------------------------

describe('capacity', () => {
  it('never exceeds capacity("lane"), and keeps it saturated', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id))
    // Sampling has to happen where the lane is held, which is inside an effect.
    const sampled: number[] = []
    const r = rig(makeWorkflow(nodes, { lanes: 2 }), {
      tap: () => sampled.push(r.pools.held('lane')),
    })

    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(Math.max(...sampled)).toBe(2)
    expect(sampled.every((held) => held <= 2)).toBe(true)
    expectDrained(r)
  })

  it('holds the lane while queued for a gate, and queues gates behind capacity', async () => {
    const gates = { unit: { cmd: 'true', requires: ['test-suite'] } }
    const resources = {
      lane: { capacity: 3, kind: 'worktree' },
      'test-suite': { capacity: 1, kind: 'semaphore' },
    }
    const nodes = ['a', 'b', 'c'].map((id) => node(id, [], { gates: ['unit'], pipeline: 'gate' }))

    const held: { lane: number; gate: number; waiting: number }[] = []
    const r = rig(
      makeWorkflow(nodes, {
        resources,
        gates,
        pipelines: {
          gate: {
            states: [
              {
                id: 'gate',
                name: 'Gate',
                position: { x: 0, y: 0 },
                onEnter: [{ id: 'e-gate', definitionId: 'run_gate', params: {} }],
              },
              { id: 'done', name: 'Done', position: { x: 200, y: 0 } },
            ],
            transitions: [{ id: 't-done', from: 'gate', to: 'done' }],
            initialStateIds: ['gate'],
            finalStateIds: ['done'],
          },
        },
        pipeline: 'gate',
      }),
      {
        tap: (call) => {
          if (call.verb === 'run_gate') {
            held.push({
              lane: r.pools.held('lane'),
              gate: r.pools.held('test-suite'),
              waiting: r.pools.waiting,
            })
          }
        },
      },
    )

    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(held).toHaveLength(3)
    // The first gate to run held one of three lanes while the other two nodes
    // sat in the `test-suite` queue — still holding *their* lanes. That is the
    // §6 rule: an idle lane is just disk, and the gate queue is what serializes.
    expect(held[0]).toEqual({ lane: 3, gate: 1, waiting: 2 })
    // And the single gate slot was never over-subscribed.
    expect(held.every((sample) => sample.gate === 1 && sample.lane >= 1)).toBe(true)
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 3: failure containment
// ---------------------------------------------------------------------------

describe('failure containment', () => {
  it('blocks exactly the transitive dependents and lets everything else finish', async () => {
    const workflow = makeWorkflow([
      node('a'),
      node('b', ['a'], { pipeline: 'explode' }),
      node('c', ['a'], { pipeline: 'long' }),
      node('d', ['b']),
      node('e', ['d']),
      node('f', ['c']),
    ])

    let sawFailureWhileRunning = false
    const r = rig(workflow, {
      tap: (call) => {
        if (call.nodeId === 'c' && r.scheduler.statuses['b'] === 'failed') {
          sawFailureWhileRunning = true
        }
      },
    })

    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(report.statuses).toEqual({
      a: 'done',
      b: 'failed',
      c: 'done',
      d: 'blocked',
      e: 'blocked',
      f: 'done',
    })
    // `c` was in flight when `b` failed and ran to completion rather than
    // being killed.
    expect(sawFailureWhileRunning).toBe(true)
    expect(Object.keys(report.failures)).toEqual(['b'])
    expectDrained(r)
  })

  it('fails a node whose harness refuses fatally, without ending the run', async () => {
    const r = rig(makeWorkflow([node('a'), node('b')], { lanes: 1 }), { spawns: ['fatal'] })
    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(report.statuses['a']).toBe('failed')
    expect(report.statuses['b']).toBe('done')
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 4–5: waiting versus stopping
// ---------------------------------------------------------------------------

describe('deadlock detection', () => {
  it('does not call a run that is entirely inside a capacity window a deadlock', async () => {
    const r = rig(makeWorkflow([node('a'), node('b')], { lanes: 2 }), {
      spawns: ['quota', 'quota'],
    })

    const running = r.scheduler.run()
    await flush()

    // Nothing running, nothing ready, everything pending — §6's deadlock
    // shape, reached legitimately.
    expect(r.scheduler.statuses).toEqual({ a: 'waiting_on_capacity', b: 'waiting_on_capacity' })
    // The lane went back before the wait: a lane held here starves the pool.
    expect(r.pools.held('lane')).toBe(0)

    await r.advance(5_000)
    const report = await running

    expect(report.status).toBe('completed')
    expect(report.stop).toBeUndefined()
    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    expectDrained(r)
  })

  it('stops on a dependency cycle and names it', async () => {
    const workflow = makeWorkflow([node('a', ['b']), node('b', ['a'])])
    // `createRun` computes waves, which a cyclic graph has none of — the
    // scheduler refuses the workflow before anything is journalled.
    const r = rig(workflow, { register: false })

    const report = await r.scheduler.run()

    expect(report.status).toBe('stopped')
    expect(report.stop?.kind).toBe('cycle')
    expect(report.stop).toMatchObject({ cycle: expect.arrayContaining(['a', 'b']) })
    expect(r.adapter.spawned).toEqual([])
    expectDrained(r)
  })

  it('stops on a resource requirement no pool can ever meet', async () => {
    const workflow = makeWorkflow([node('a', [], { gates: ['e2e'] })], {
      gates: { e2e: { cmd: 'true', requires: ['gpu'] } },
    })
    const r = rig(workflow)

    const report = await r.scheduler.run()

    expect(report.status).toBe('stopped')
    expect(report.stop).toEqual({ kind: 'unsatisfiable', nodeId: 'a', resource: 'gpu' })
    expect(r.adapter.spawned).toEqual([])
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 6: await_human
// ---------------------------------------------------------------------------

describe('await_human', () => {
  it('keeps the lane, gives the gate resources back, and resumes on the answer', async () => {
    const workflow = makeWorkflow([node('a', [], { gates: ['unit'], pipeline: 'gated' })], {
      resources: {
        lane: { capacity: 2, kind: 'worktree' },
        'test-suite': { capacity: 1, kind: 'semaphore' },
      },
      gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
    })
    let gateHeld = 0
    const r = rig(workflow, {
      tap: (call) => {
        if (call.verb === 'run_gate') gateHeld = r.pools.held('test-suite')
      },
    })

    const running = r.scheduler.run()
    await flush()

    expect(gateHeld).toBe(1)
    expect(r.scheduler.statuses['a']).toBe('awaiting_human')
    // The lane stays — the human is being asked about the work in it.
    expect(r.pools.held('lane')).toBe(1)
    // The gate slot does not.
    expect(r.pools.held('test-suite')).toBe(0)

    r.scheduler.answer('a', { human: { answer: 'ship' } })
    const report = await running

    expect(report.statuses).toEqual({ a: 'done' })
    expectDrained(r)
  })

  it('refuses an answer for a node that is not waiting for one', async () => {
    const r = rig(makeWorkflow([node('a')]))
    expect(() => r.scheduler.answer('a', {})).toThrow(/not awaiting an answer/)
    await r.scheduler.run()
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 7: the loop itself
// ---------------------------------------------------------------------------

describe('the loop', () => {
  it('turns a bounded number of times — it waits on changes, never polls', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id))
    const r = rig(makeWorkflow(nodes, { lanes: 2 }))
    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    // Two status changes per node plus the final turn. A poll loop would run
    // orders of magnitude more.
    expect(report.iterations).toBeLessThanOrEqual(2 * nodes.length + 2)
    expectDrained(r)
  })

  it('journals every node status change and the lane it was given', async () => {
    const r = rig(makeWorkflow([node('a'), node('b', ['a'])]))
    await r.scheduler.run()

    const rows = r.journal.nodes('run-1')
    expect(rows.map((row) => row.status)).toEqual(['done', 'done'])
    expect(rows.every((row) => row.lane?.startsWith('run-1-lane-') === true)).toBe(true)
    expect(rows.every((row) => row.session_id !== null)).toBe(true)
    expect(r.journal.run('run-1')?.status).toBe('done')
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// The shipped pipeline, end to end
// ---------------------------------------------------------------------------

const standardWorkflow = (nodes: readonly Record<string, unknown>[]): Workflow =>
  makeWorkflow(nodes, {
    resources: {
      lane: { capacity: 2, kind: 'worktree' },
      'test-suite': { capacity: 1, kind: 'semaphore' },
    },
    gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
    pipelines: { 'standard-phase': STANDARD_PHASE },
    pipeline: 'standard-phase',
  })

describe('standard-phase under the scheduler', () => {
  it('runs implement → review → gate → integrate → done', async () => {
    const r = rig(standardWorkflow([node('a', [], { gates: ['unit'] })]), {
      outcomes: {
        'e-review': { facts: { review: { verdict: 'pass' } } },
        'e-gate': { facts: { gate: { exit_code: 0 } } },
      },
    })

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done' })
    expect(r.calls.map((call) => call.verb)).toEqual([
      'git_branch',
      'spawn_agent',
      'spawn_agent',
      'run_gate',
      'git_merge',
      'git_push',
      'open_pr',
      'write_tracking',
    ])
    expectDrained(r)
  })

  it('counts a fixer turn as a fix round and fails the node when they run out', async () => {
    const r = rig(
      standardWorkflow([node('a', [], { gates: ['unit'] }), node('b', ['a'])]),
      {
        outcomes: {
          'e-review': { facts: { review: { verdict: 'fail' } } },
          'e-gate': { facts: { gate: { exit_code: 0 } } },
        },
      },
    )

    const report = await r.scheduler.run()

    // `max_fix_rounds` defaults to 2, and `fix_rounds` is the count of fixer
    // turns taken — so two fixers run and the third round is refused.
    expect(r.calls.filter((call) => call.effect === 'e-fix')).toHaveLength(2)
    expect(report.statuses).toEqual({ a: 'failed', b: 'blocked' })
    expect(r.calls.some((call) => call.effect === 'e-failed')).toBe(true)
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 8: the four remaining operations of §9
//
// Each one needs a live `AgentSession`, so every test here holds one open
// mid-stream with `stall` and drives the operation against it. The session is
// `MockAdapter`'s own, so what it did is visible where a real one would be
// visible: in the node's transcript.
// ---------------------------------------------------------------------------

describe('§9 operations', () => {
  it('sends added context into the live session and journals it', async () => {
    const r = rig(makeWorkflow([node('a')]), { stall: true })
    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")

    await r.scheduler.addContext('a', 'the composite index is the fast one')
    r.stall.release()
    const report = await running

    expect(report.statuses).toEqual({ a: 'done' })
    // The message reached the session: §15's rule is that it shows up in the
    // transcript of the run it steered.
    expect(transcriptOf(r, 'a')).toContainEqual({
      type: 'user_message',
      text: 'the composite index is the fast one',
    })
    expect(operationsOf(r, 'a')).toEqual([
      { op: 'add_context', text: 'the composite index is the fast one', delivery: 'sent' },
    ])
    expectDrained(r)
  })

  it('queues added context for a harness that cannot inject, and delivers it on the resume', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'long' })]), {
      stall: true,
      capabilities: { inject: false },
    })
    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")

    // No throw at the operator, even though `session.send` would reject here.
    await r.scheduler.addContext('a', 'prefer a migration over a backfill')
    r.stall.release()
    const report = await running

    expect(report.statuses).toEqual({ a: 'done' })
    // It reaches the transcript even though the harness cannot inject: the
    // delivery moment differs (the next spawn, via `AgentTask.operatorText`),
    // but the record of what the operator said must not. That is what §7's
    // `user_message` variant exists for.
    expect(transcriptOf(r, 'a')).toContainEqual({
      type: 'user_message',
      text: 'prefer a migration over a backfill',
    })
    // Delivered on the node's next resume, into the guard context every later
    // effect reads — including the one that composes the next agent turn.
    const next = r.calls.find((call) => call.effect === 'e-2')
    expect(next?.context.human?.['pending_context']).toBe('prefer a migration over a backfill')
    expect(operationsOf(r, 'a')).toEqual([
      { op: 'add_context', text: 'prefer a migration over a backfill', delivery: 'queued' },
      { op: 'add_context', text: 'prefer a migration over a backfill', delivery: 'delivered' },
    ])
    expectDrained(r)
  })

  it('interrupts the live session on a redirect and carries the instruction into the resume', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'long' })]), { stall: true })
    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")

    await r.scheduler.redirect('a', 'use the queue, not a cron')
    r.stall.release()
    const report = await running

    expect(report.statuses).toEqual({ a: 'done' })
    // The interrupt reached the session: its first turn ended early and said so.
    expect(transcriptOf(r, 'a')).toContainEqual({ type: 'session_ended', result: 'interrupted' })
    const next = r.calls.find((call) => call.effect === 'e-2')
    expect(next?.context.human?.['pending_context']).toBe('use the queue, not a cron')
    expect(operationsOf(r, 'a')).toEqual([
      { op: 'redirect', text: 'use the queue, not a cron', delivery: 'queued' },
      { op: 'redirect', text: 'use the queue, not a cron', delivery: 'delivered' },
    ])
    expectDrained(r)
  })

  it('pauses after the current turn, keeping the lane and giving the gate slot back', async () => {
    const workflow = makeWorkflow([node('a', [], { gates: ['unit'], pipeline: 'gate-work' })], {
      resources: {
        lane: { capacity: 2, kind: 'worktree' },
        'test-suite': { capacity: 1, kind: 'semaphore' },
      },
      gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
    })
    const r = rig(workflow, { stall: true })

    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")
    // The gate pool is held right now, and the pause has to give it back.
    expect(r.pools.held('test-suite')).toBe(1)

    await r.scheduler.pause('a')
    r.stall.release()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'node a to park')

    // §6 and §9.1: the lane stays — the human is being asked about the work in
    // it — and the expensive slot is freed at once.
    expect(r.pools.held('lane')).toBe(1)
    expect(r.pools.held('test-suite')).toBe(0)
    expect(r.journal.pendingQuestion('run-1', 'a')?.question.kind).toBe('confirm')
    expect(operationsOf(r, 'a')).toEqual([{ op: 'pause', delivery: 'sent' }])

    r.scheduler.answer('a', { human: { answer: 'resume' } })
    const report = await running

    expect(report.statuses).toEqual({ a: 'done' })
    expect(r.journal.pendingQuestion('run-1', 'a')).toBeUndefined()
    expectDrained(r)
  })

  it('aborts a node: kills the session, fails it, and blocks exactly its dependents', async () => {
    const workflow = makeWorkflow([node('a'), node('b', ['a']), node('c', ['b']), node('d')])
    const r = rig(workflow, { stall: true })

    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")

    await r.scheduler.abortNode('a')

    // Containment is immediate: the operator does not wait for the node's own
    // loop to unwind before seeing what the abort took with it.
    expect(r.scheduler.statuses['a']).toBe('failed')
    expect(r.scheduler.statuses['b']).toBe('blocked')
    expect(r.scheduler.statuses['c']).toBe('blocked')
    expect(r.scheduler.statuses['d']).not.toBe('blocked')

    r.stall.release()
    const report = await running

    expect(report.statuses).toEqual({ a: 'failed', b: 'blocked', c: 'blocked', d: 'done' })
    expect(report.failures).toEqual({ a: 'aborted by the operator' })
    expect(transcriptOf(r, 'a')).toContainEqual({ type: 'session_ended', result: 'interrupted' })
    expect(operationsOf(r, 'a')).toEqual([{ op: 'abort', delivery: 'sent' }])
    expectDrained(r)
  })

  it('aborts a node that is parked on a question, without stranding its lane', async () => {
    const workflow = makeWorkflow([node('a', [], { pipeline: 'gated' }), node('b', ['a'])])
    const r = rig(workflow)

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'node a to park')
    expect(r.journal.pendingQuestion('run-1', 'a')).toBeDefined()

    await r.scheduler.abortNode('a')
    const report = await running

    expect(report.statuses).toEqual({ a: 'failed', b: 'blocked' })
    // The pause ended without being answered, so nothing is still pending on it.
    expect(r.journal.pendingQuestion('run-1', 'a')).toBeUndefined()
    expectDrained(r)
  })

  it('records every operation on a node that is not running, and throws at none of them', async () => {
    const workflow = makeWorkflow([node('a', [], { pipeline: 'explode' }), node('b', ['a'])])
    const r = rig(workflow)
    const report = await r.scheduler.run()
    expect(report.statuses).toEqual({ a: 'failed', b: 'blocked' })

    // Every verb, against a failed node and against a blocked one. An operator
    // clicking a button on a node that settled a second ago gets a recorded
    // no-op, never a rejected promise nobody is waiting on.
    await expect(
      Promise.all([
        r.scheduler.addContext('a', 'too late'),
        r.scheduler.redirect('a', 'too late'),
        r.scheduler.pause('a'),
        r.scheduler.abortNode('a'),
        r.scheduler.addContext('b', 'too late'),
        r.scheduler.redirect('b', 'too late'),
        r.scheduler.pause('b'),
        r.scheduler.abortNode('b'),
      ]),
    ).resolves.toHaveLength(8)

    expect(r.scheduler.statuses).toEqual({ a: 'failed', b: 'blocked' })
    for (const nodeId of ['a', 'b']) {
      expect(operationsOf(r, nodeId)).toEqual([
        { op: 'add_context', text: 'too late', delivery: 'ignored' },
        { op: 'redirect', text: 'too late', delivery: 'ignored' },
        { op: 'pause', delivery: 'ignored' },
        { op: 'abort', delivery: 'ignored' },
      ])
    }
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 9: §9.1's question, journalled with the pause
// ---------------------------------------------------------------------------

describe('human gates journal their question', () => {
  it('journals the whole question shape from the effect params, and the answer', async () => {
    const asking = {
      states: [
        {
          id: 'gate',
          name: 'Gate',
          position: { x: 0, y: 0 },
          onEnter: [
            {
              id: 'e-ask',
              definitionId: 'await_human',
              params: {
                question: 'Two migrations landed. Ship the branch?',
                kind: 'choice',
                choices: ['ship', 'hold'],
                context: { diffRef: 'phase/a', gateLogRef: 'unit', transcriptCursor: 7 },
              },
            },
          ],
        },
        { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
      ],
      transitions: [{ id: 't-done', from: 'gate', to: 'done', guard: "human.answer == 'ship'" }],
      initialStateIds: ['gate'],
      finalStateIds: ['done'],
    }
    const r = rig(makeWorkflow([node('a')], { pipelines: { asking }, pipeline: 'asking' }))

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'node a to park')

    expect(r.journal.pendingQuestion('run-1', 'a')).toMatchObject({
      effectId: 'e-ask',
      question: {
        question: 'Two migrations landed. Ship the branch?',
        kind: 'choice',
        choices: ['ship', 'hold'],
        context: { diffRef: 'phase/a', gateLogRef: 'unit', transcriptCursor: 7 },
      },
    })
    // Asked once. A second ask is a second notification, which §9.1 forbids.
    expect(
      r.journal.events('run-1').filter((event) => event.type === 'human_question'),
    ).toHaveLength(1)

    r.scheduler.answer('a', { human: { answer: 'ship' } })
    const report = await running

    expect(report.statuses).toEqual({ a: 'done' })
    expect(
      r.journal.events('run-1').find((event) => event.type === 'human_answered')?.payload,
    ).toEqual({ effect_id: 'e-ask', answer: 'ship' })
    expect(r.journal.pendingQuestions('run-1')).toEqual([])
    expectDrained(r)
  })

  it('falls back to the older one-line `reason` param as the question', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'gated' })]))
    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'node a to park')

    expect(r.journal.pendingQuestion('run-1', 'a')?.question).toEqual({
      question: 'gate-review',
      kind: 'confirm',
    })

    r.scheduler.answer('a', { human: { answer: 'ship' } })
    await running
    expectDrained(r)
  })
})
