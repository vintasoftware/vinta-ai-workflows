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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdmissionControl } from '../src/admission/admission.ts'
import { analyzeRun } from '../src/analytics/analytics.ts'
import type { Clock } from '../src/admission/clock.ts'
import { PtyRegistry } from '../src/daemon/pty.ts'
import type {
  AgentSession,
  HarnessAdapter,
  HarnessCapabilities,
  SpawnRefusalKind,
} from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import type { NodeStatus } from '../src/journal/events.ts'
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
  const attachPty = inner.attachPty

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
    // Transparent about what the harness can do, terminal included: a wrapper
    // that dropped `attachPty` would make a takeover-capable harness look
    // unattachable, which is the thing these tests are checking.
    ...(attachPty === undefined ? {} : { attachPty: attachPty.bind(inner) }),
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
  /** Where the lane slots would live. Empty until a test plants a checkout in one. */
  readonly laneRoot: string
  /** Present when `stall` was asked for: holds every session open mid-stream. */
  readonly stall: { live(): boolean; release(): void }
  /**
   * This run's takeover registry — its own, never the process-wide one, so
   * what a test sees offered was offered by the scheduler it built.
   */
  readonly takeovers: PtyRegistry
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
    /** `LanePool.recycle`'s seam: called as a used lane is handed on (§8). */
    readonly recycleLane?: (name: string) => Promise<void>
    /** Session ids this harness has forgotten (§15.4). */
    readonly staleSessions?: readonly string[]
    /**
     * What a failed node does. Defaults to `stop` here; production defaults to
     * `retry`. `null` passes nothing, which is how one test exercises the real
     * default rather than the rig's.
     */
    readonly onFailure?: 'stop' | 'retry' | 'ask' | null
    /** Automatic attempts under `retry`. */
    readonly retries?: number
  readonly retryAfterMs?: number
    /** `LanePool`'s `Lane.env`: what makes a lane isolated, by slot name. */
    readonly laneEnv?: (name: string) => Readonly<Record<string, string>>
    /**
     * The state a killed process left in the journal, by node id: the run is
     * then built as a resume of it.
     *
     * Written as the `node_status` events the dead run would have written,
     * rather than as hand-built rows, so the scheduler resumes from a real
     * projection and the duplicate-event assertions are counting the same log
     * the post-mortem reads.
     */
    readonly resumeFrom?: Readonly<Record<string, NodeStatus>>
    /** What that process had assigned, for the fields a row carries past a status. */
    readonly assigned?: Readonly<Record<string, { readonly session_id?: string }>>
  } = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-scheduler-'))
  const journal = openJournal(dir)
  const runId = 'run-1'
  if (options.register !== false) journal.createRun(runId, workflow)

  for (const [nodeId, payload] of Object.entries(options.assigned ?? {})) {
    journal.append({ runId, nodeId, type: 'node_assigned', payload })
  }
  for (const [nodeId, status] of Object.entries(options.resumeFrom ?? {})) {
    journal.append({ runId, nodeId, type: 'node_status', payload: { status } })
  }

  // Strict FIFO: the aging window is a wall-clock affordance, and a test that
  // depended on it would be asserting about `Date.now()`.
  const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
  const { clock, advance } = fakeClock()
  const adapter = new MockAdapter({
    id: HARNESS,
    ...(options.spawns === undefined ? {} : { spawns: options.spawns }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.staleSessions === undefined ? {} : { staleSessions: options.staleSessions }),
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
  const takeovers = new PtyRegistry()

  const scheduler = createScheduler({
    workflow,
    runId,
    journal,
    pools,
    admission,
    adapters: { [HARNESS]: options.stall === true ? stall.adapter : adapter },
    executor,
    laneRoot: join(dir, 'lanes'),
    takeovers,
    ...(options.recycleLane === undefined ? {} : { recycleLane: options.recycleLane }),
    ...(options.laneEnv === undefined ? {} : { laneEnv: options.laneEnv }),
    ...(options.resumeFrom === undefined ? {} : { resumeFrom: journal.nodes(runId) }),
    // **`stop` unless a test says otherwise, and production's default is
    // `retry`.** Every test below that asserts about a failure — containment,
    // the reason text, which dependents block — is about what a *final* failure
    // does, not about the recovery policy in front of it. Left on the
    // production default they would all silently be testing the second attempt.
    //
    // The divergence is deliberate and is itself covered: `the default recovery
    // policy` asserts that a scheduler built without this option retries. A rig
    // default that quietly disagreed with production, with nothing holding the
    // two together, is how a mode gets asserted by name instead of behaviour.
    ...(options.onFailure === null ? {} : { onFailure: options.onFailure ?? 'stop' }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs, clock }),
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
    laneRoot: join(dir, 'lanes'),
    stall,
    takeovers,
  }
}

/** Every journalled §9 operation for a node, in order. */
const operationsOf = (rig_: Rig, nodeId: string): unknown[] =>
  rig_.journal
    .events('run-1')
    .filter((event) => event.type === 'node_operation' && event.nodeId === nodeId)
    .map((event) => event.payload)

/**
 * Every status this node's log claims, in order — including the ones a
 * previous process wrote, which is what makes a duplicated transition visible.
 */
const statusesOf = (rig_: Rig, nodeId: string): string[] =>
  rig_.journal
    .events('run-1')
    .filter((event) => event.type === 'node_status' && event.nodeId === nodeId)
    .map((event) => String((event.payload as { status?: unknown }).status))

/** Every §15 session decision for a node, in order. */
const sessionsOf = (rig_: Rig, nodeId: string): unknown[] =>
  rig_.journal
    .events('run-1')
    .filter((event) => event.type === 'node_session' && event.nodeId === nodeId)
    .map((event) => event.payload)

/**
 * The node's normalized transcript, which is where a session's own record is.
 *
 * Entries also carry `by` — who wrote the line (`journal/transcript.ts`) — which
 * is why the assertions below match on the fields they mean rather than on the
 * whole object. A test that pinned the exact shape would fail on every key the
 * daemon ever adds, without any of them being wrong.
 */
const transcriptOf = (
  rig_: Rig,
  nodeId: string,
): { type: string; text?: string; result?: string; by?: { role: string; slot?: string } }[] =>
  rig_.journal.tailTranscript('run-1', nodeId, 100) as {
    type: string
    text?: string
    result?: string
    by?: { role: string; slot?: string }
  }[]

/** No leaked leases: every pool back to zero, and nobody still queued. */
function expectDrained(rig_: Rig): void {
  for (const name of rig_.poolNames) expect([name, rig_.pools.held(name)]).toEqual([name, 0])
  expect(rig_.pools.waiting).toBe(0)
  expect(rig_.journal.leases()).toEqual([])
  // A member held past the end of a run is not a leaked resource the pools can
  // see: nothing counts them, so a stall would show up only as a later phase
  // waiting forever on an agent that no longer exists.
  expect(rig_.scheduler.busyCrew()).toEqual([])
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
/**
 * A pipeline with nowhere to go: `work` has one outgoing transition and a guard
 * that can never hold, so the interpreter gets stuck rather than reaching a
 * final state. The shape a plan defect takes at runtime.
 */
const STUCK = {
  states: [
    { id: 'work', name: 'Work', position: { x: 0, y: 0 }, onEnter: [spawn('e-work', 'implementer')] },
    { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [{ id: 't-never', from: 'work', to: 'done', guard: "review.verdict == 'nope'" }],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

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

const slotSpawn = (id: string, role: string, session: string): Record<string, unknown> => ({
  id,
  definitionId: 'spawn_agent',
  params: { role, session },
})

/** Two turns on one slot (§15.1): the second must continue the first. */
const REUSE = {
  states: [
    {
      id: 'first',
      name: 'First',
      position: { x: 0, y: 0 },
      onEnter: [slotSpawn('e-first', 'implementer', 'main')],
    },
    {
      id: 'second',
      name: 'Second',
      position: { x: 200, y: 0 },
      onEnter: [slotSpawn('e-second', 'implementer', 'main')],
    },
    { id: 'done', name: 'Done', position: { x: 400, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [
    { id: 't-second', from: 'first', to: 'second' },
    { id: 't-done', from: 'second', to: 'done' },
  ],
  initialStateIds: ['first'],
  finalStateIds: ['done'],
}

/** Two slots that must never cross: the shape `standard-phase` actually uses. */
const SLOTS = {
  states: [
    {
      id: 'work',
      name: 'Work',
      position: { x: 0, y: 0 },
      onEnter: [slotSpawn('e-work', 'implementer', 'main')],
    },
    {
      id: 'review',
      name: 'Review',
      position: { x: 200, y: 0 },
      onEnter: [slotSpawn('e-review', 'reviewer', 'review')],
    },
    {
      id: 'rework',
      name: 'Rework',
      position: { x: 400, y: 0 },
      onEnter: [slotSpawn('e-rework', 'implementer', 'main')],
    },
    { id: 'done', name: 'Done', position: { x: 600, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [
    { id: 't-review', from: 'work', to: 'review' },
    { id: 't-rework', from: 'review', to: 'rework' },
    { id: 't-done', from: 'rework', to: 'done' },
  ],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

/**
 * Fix rounds on the implementer's slot. `check` carries no effects and exists
 * only to give the loop somewhere to evaluate `fix_rounds` from, exactly as
 * `standard-phase` evaluates it on the way out of `fix`.
 */
const FIXES = {
  states: [
    {
      id: 'implement',
      name: 'Implement',
      position: { x: 0, y: 0 },
      onEnter: [slotSpawn('e-implement', 'implementer', 'main')],
    },
    {
      id: 'fix',
      name: 'Fix',
      position: { x: 200, y: 0 },
      onEnter: [slotSpawn('e-fix', 'fixer', 'main')],
    },
    { id: 'check', name: 'Check', position: { x: 400, y: 0 } },
    { id: 'done', name: 'Done', position: { x: 600, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [
    { id: 't-fix', from: 'implement', to: 'fix' },
    { id: 't-check', from: 'fix', to: 'check' },
    { id: 't-again', from: 'check', to: 'fix', guard: 'fix_rounds < node.max_fix_rounds' },
    { id: 't-done', from: 'check', to: 'done', guard: 'fix_rounds >= node.max_fix_rounds' },
  ],
  initialStateIds: ['implement'],
  finalStateIds: ['done'],
}

/** `FIXES`, but the exhausted budget ends the phase instead of completing it. */
const FIX_THEN_FAIL = {
  ...FIXES,
  states: FIXES.states.map((state) =>
    state.id === 'done' ? { ...state, data: { outcome: 'failed' } } : state,
  ),
}

function makeWorkflow(
  nodes: readonly Record<string, unknown>[],
  options: {
    readonly lanes?: number
    readonly resources?: Record<string, unknown>
    readonly gates?: Record<string, unknown>
    readonly pipelines?: Record<string, unknown>
    readonly pipeline?: string
    readonly crew?: Record<string, unknown>
  } = {},
): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'test-flow',
    base_branch: 'main',
    ...(options.crew === undefined ? {} : { crew: options.crew }),
    defaults: { harness: HARNESS, model: 'opus', pipeline: options.pipeline ?? 'solo' },
    resources: options.resources ?? { lane: { capacity: options.lanes ?? 4, kind: 'worktree' } },
    gates: options.gates ?? {},
    nodes,
    pipelines: options.pipelines ?? {
      solo: SOLO,
      explode: EXPLODE,
      stuck: STUCK,
      long: LONG,
      gated: GATED,
      'gate-work': GATE_WORK,
      reuse: REUSE,
      slots: SLOTS,
      fixes: FIXES,
      'fix-then-fail': FIX_THEN_FAIL,
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

  /**
   * The wait above is real and, until these events existed, invisible: the
   * scheduler took those pools through `leases`, a table cleared on open whose
   * rows vanish on release, so §13.3's "is gate capacity the constraint, or
   * lane count" was half unanswerable. All three edges are journalled, in
   * order, per node — and `analyzeRun` reading them back off a *real* journal
   * is what proves the producer and the consumer agree.
   */
  it('journals every edge of a gate-pool acquisition', async () => {
    const nodes = ['a', 'b', 'c'].map((id) => node(id, [], { gates: ['unit'], pipeline: 'gate' }))
    const r = rig(
      makeWorkflow(nodes, {
        resources: {
          lane: { capacity: 3, kind: 'worktree' },
          'test-suite': { capacity: 1, kind: 'semaphore' },
        },
        gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
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
    )

    await r.scheduler.run()

    for (const id of ['a', 'b', 'c']) {
      const edges = r.journal
        .events('run-1')
        .filter((event) => event.type === 'gate_pool' && event.nodeId === id)
      expect(edges.map((event) => (event.payload as { phase: string }).phase)).toEqual([
        'requested',
        'granted',
        'released',
      ])
      // Pool ids and a phase. Nothing about the gate's command or its output.
      expect(edges.map((event) => Object.keys(event.payload).sort())).toEqual([
        ['phase', 'resources'],
        ['phase', 'resources'],
        ['phase', 'resources'],
      ])
      expect((edges[0]?.payload as { resources: string[] }).resources).toEqual(['test-suite'])
    }

    // The consumer's half: a pool that used to come back `unattributed` is now
    // measured off exactly these events, on a journal nothing hand-wrote.
    const pool = analyzeRun(r.journal, 'run-1').pools.find((p) => p.resource === 'test-suite')
    expect(pool).toMatchObject({ attribution: 'exact', capacity: 1, peakHeld: 1 })
    expect(analyzeRun(r.journal, 'run-1').gaps).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2b: lane reuse (§8)
//
// A plan with more phases than lanes is the normal case, so a lane slot serves
// several phases in turn. What these assert is *when* the pool is asked to
// recycle one — between the phases that share it, never at the end of a run,
// where §8 keeps the last phase's lane as evidence.
// ---------------------------------------------------------------------------

/**
 * A lane's isolation is a set of environment variables — its compose project,
 * the override that strips the host ports its siblings also publish, its own
 * connection strings — and for a long time they reached gates and not agents.
 *
 * Which is the half that matters least. A gate is a declared command run once;
 * an agent spends a whole phase in that worktree running `docker compose up`
 * and the project's test suite, and with the daemon's bare environment every
 * lane's agent resolved to the *same* compose project. The isolation existed
 * and the processes that needed it could not see it.
 */
describe('the lane’s environment', () => {
  it('reaches the agent, not only the gate', async () => {
    const r = rig(makeWorkflow([node('a'), node('b')], { lanes: 2 }), {
      laneEnv: (name) => ({ COMPOSE_PROJECT_NAME: `app_${name}`, LANE_PORT_API_8000: '21080' }),
    })

    await r.scheduler.run()

    expect(r.adapter.spawned).not.toHaveLength(0)
    for (const task of r.adapter.spawned) {
      // Each task carries the environment of the lane it is dispatched into,
      // and the lane is the directory it was given.
      expect(task.env?.['COMPOSE_PROJECT_NAME']).toBe(`app_${basename(task.cwd)}`)
      expect(task.env?.['LANE_PORT_API_8000']).toBe('21080')
    }
    // Two lanes, two compose projects. One would be the bug.
    const projects = new Set(r.adapter.spawned.map((task) => task.env?.['COMPOSE_PROJECT_NAME']))
    expect(projects.size).toBe(2)
  })

  it('carries nothing where the host owns its own lanes', async () => {
    // A host that injected its own executor has no `Lane` to ask about, and a
    // task with no environment is a child inheriting the daemon's — which is
    // exactly what every such host had before this existed.
    const r = rig(makeWorkflow([node('a')]))

    await r.scheduler.run()

    expect(r.adapter.spawned[0]?.env).toBeUndefined()
  })
})

describe('lane reuse', () => {
  it('recycles a lane between the phases that share it, and never after the last', async () => {
    // Three nodes, one lane: the slot is handed on twice.
    const recycled: string[] = []
    const timeline: string[] = []
    const r = rig(makeWorkflow([node('a'), node('b'), node('c')], { lanes: 1 }), {
      tap: (call) => timeline.push(`run:${call.nodeId}`),
      recycleLane: async (name) => {
        recycled.push(name)
        timeline.push(`recycle:${name}`)
      },
    })

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done' })
    // Twice, not three times: the first node gets the lane the pool
    // provisioned, and the run ends without touching the third node's.
    expect(recycled).toEqual(['run-1-lane-1', 'run-1-lane-1'])
    expect(timeline).toEqual([
      'run:a',
      'recycle:run-1-lane-1',
      'run:b',
      'recycle:run-1-lane-1',
      'run:c',
    ])
    expectDrained(r)
  })

  it('leaves a lane alone when every node had one of its own', async () => {
    const recycled: string[] = []
    const r = rig(makeWorkflow([node('a'), node('b')], { lanes: 2 }), {
      recycleLane: async (name) => {
        recycled.push(name)
      },
    })

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    expect(recycled).toEqual([])
    expectDrained(r)
  })

  it('fails the node rather than running it in a lane that would not recycle', async () => {
    const r = rig(makeWorkflow([node('a'), node('b')], { lanes: 1 }), {
      recycleLane: async () => {
        throw new Error('dropdb: connection refused to db "app_wt_run_1_lane_1"')
      },
    })

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'failed' })
    // The second node never started: no effect of its ever ran, so it cannot
    // have implemented anything in the first node's worktree.
    expect(nodeIdsOf(r.calls)).toEqual(['a'])
    expect(r.adapter.spawned.map((task) => task.nodeId)).toEqual(['a'])
    // Loud, and by lane name: §11 keeps the recycle command's own output —
    // database names, paths, whatever it printed — out of the failure.
    // The kind is on the message, and the lane's own contents are not. This
    // fixture throws a bare `Error`, so `Error` is all there is to say about
    // it; a real `LaneRecycleError` names which of its three stages failed.
    // Without that suffix "could not be recycled" sends a reader to three
    // different pieces of machinery — which is exactly what it did on Windows.
    expect(report.failures['b']).toBe('lane "run-1-lane-1" could not be recycled (Error)')
    expect(report.failures['b']).not.toContain('dropdb')
    // And the lane went back on the free list rather than stranding capacity.
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
// 5b: resuming a run the journal already has
//
// The process that started the run was killed, so everything it held is gone
// and everything it wrote is not. These tests are about the seam between those
// two: which phases the resume believes, which it re-runs, and what it is
// careful *not* to write a second time into a log the post-mortem folds.
// ---------------------------------------------------------------------------

describe('resuming a run', () => {
  it('does not re-dispatch a node the journal left done', async () => {
    const r = rig(makeWorkflow([node('a'), node('b', ['a'])]), { resumeFrom: { a: 'done' } })

    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    // The phase that finished before the kill is not paid for twice.
    expect(r.adapter.spawned.map((task) => task.nodeId)).toEqual(['b'])
    expectDrained(r)
  })

  it('re-dispatches a node the journal left running', async () => {
    const r = rig(makeWorkflow([node('a')]), { resumeFrom: { a: 'running' } })

    const report = await r.scheduler.run()

    // Nothing was behind that `running` — the process holding its session died
    // with it — so the phase runs again from the start of its pipeline.
    expect(report.statuses).toEqual({ a: 'done' })
    expect(r.adapter.spawned.map((task) => task.nodeId)).toEqual(['a'])
    expectDrained(r)
  })

  it('re-dispatches the nodes a previous failure left failed and blocked', async () => {
    const r = rig(makeWorkflow([node('a'), node('b', ['a'])]), {
      resumeFrom: { a: 'failed', b: 'blocked' },
    })

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    expect(r.adapter.spawned.map((task) => task.nodeId)).toEqual(['a', 'b'])
    expectDrained(r)
  })

  it('seeds a done node without journalling its status a second time', async () => {
    const r = rig(makeWorkflow([node('a'), node('b', ['a'])]), {
      resumeFrom: { a: 'done', b: 'running' },
    })

    await r.scheduler.run()

    // One `done`: the one the dead process wrote. A second would read as a
    // phase that finished twice.
    expect(statusesOf(r, 'a')).toEqual(['done'])
    // `b` is the other half of the rule. The projection was claiming `running`
    // with nothing behind it, so the correction to `pending` *is* journalled,
    // and the re-run follows it.
    expect(statusesOf(r, 'b')).toEqual(['running', 'pending', 'running', 'done'])
    expectDrained(r)
  })

  it('settles immediately when the journal says every node is done', async () => {
    const r = rig(makeWorkflow([node('a'), node('b', ['a']), node('c', ['b'])]), {
      resumeFrom: { a: 'done', b: 'done', c: 'done' },
    })

    const report = await r.scheduler.run()

    // Completed rather than hung, and not mistaken for a deadlock: `#settled`
    // is asked before `#deadlock` is.
    expect(report.status).toBe('completed')
    expect(report.stop).toBeUndefined()
    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done' })
    expect(r.adapter.spawned).toEqual([])
    // One turn of the loop: dispatch nothing, settle, stop.
    expect(report.iterations).toBe(1)
    expectDrained(r)
  })

  it('dispatches a wave whose dependencies were done before the resume', async () => {
    const r = rig(
      makeWorkflow([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])]),
      { resumeFrom: { a: 'done', b: 'done' } },
    )

    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done', d: 'done' })
    // `#dispatchReady` counts a dependency green only when its *state* says
    // `done`, so `c` starting at all is the seeding working, and `d` starting
    // after it is the half of its dependency set that survived the kill.
    expect(r.adapter.spawned.map((task) => task.nodeId)).toEqual(['c', 'd'])
    expect(report.waves).toEqual({ a: 1, b: 2, c: 2, d: 3 })
    expectDrained(r)
  })

  it('does not hand the resumed node the session id the journal recorded', async () => {
    const r = rig(makeWorkflow([node('a')]), {
      resumeFrom: { a: 'running' },
      assigned: { a: { session_id: 'sess-before-the-kill' } },
    })

    await r.scheduler.run()

    // `solo` names no slot, which is the one path a staged id would reach
    // (§15's `takeoverSessionId`). The row's id says which role spawned *last*
    // and nothing about the lane, the harness or the turns behind it, so there
    // is no §15.2 rule that could decline it — and the phase is re-driven from
    // its initial state anyway. Cold is the only honest spawn.
    expect(r.adapter.spawned).toHaveLength(1)
    expect(r.adapter.spawned[0]?.resumeSessionId).toBeUndefined()
    expect(sessionsOf(r, 'a')).toEqual([])
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
      // Tracking before the merge: the phase record has to be in the commit
      // the wave branch merges — see the `integrate` state in `standard.ts`.
      'write_tracking',
      'git_merge',
      'git_push',
      'open_pr',
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

  /**
   * Every spawn on a node appends to the same transcript file whatever its
   * role, so a phase that took two fix rounds holds five agents' output in one
   * stream. Both facts needed to tell them apart — the role and the session
   * slot — were in scope at the append and simply not written down, and the one
   * question the file could not answer was who said what.
   */
  it('records which agent wrote each transcript entry, and on which slot', async () => {
    const r = rig(
      standardWorkflow([node('a', [], { gates: ['unit'] })]),
      {
        outcomes: {
          'e-review': { facts: { review: { verdict: 'fail' } } },
          'e-gate': { facts: { gate: { exit_code: 0 } } },
        },
      },
    )

    await r.scheduler.run()

    const attributions = r.journal
      .tailTranscript('run-1', 'a', 200)
      .map((entry) => (entry as { by?: { role: string; slot?: string } }).by)

    // Not one entry unattributed, and the roles are the pipeline's own.
    expect(attributions.every((by) => by !== undefined)).toBe(true)
    expect(new Set(attributions.map((by) => by?.role))).toEqual(
      new Set(['implementer', 'reviewer', 'fixer']),
    )
    // §15's slots: the fixer continues the implementer's, the reviewer holds
    // its own — which is exactly what the transcript now says out loud.
    const slotFor = (role: string): Set<string | undefined> =>
      new Set(attributions.filter((by) => by?.role === role).map((by) => by?.slot))
    expect(slotFor('implementer')).toEqual(new Set(['main']))
    expect(slotFor('fixer')).toEqual(new Set(['main']))
    expect(slotFor('review')).toEqual(new Set())
    expect(slotFor('reviewer')).toEqual(new Set(['review']))
  })

  /**
   * The complaint a real 14-hour run produced: three `node_error` events, all
   * three reading `pipeline ended in state "failed"`, which is the name of a
   * state and not a cause. `standard-phase` has two edges into `failed` — a red
   * gate with the budget spent, and a reviewer that kept saying no — and from
   * the state id alone they are the same sentence. An operator learned that a
   * phase failed twice and nothing about why, which is the complaint the event
   * was added to answer one level out.
   *
   * Both shapes are driven here in one test, because what is being asserted is
   * that they *differ*: either reason alone would have passed against the old
   * text too.
   */
  it('says which of the two ways a phase reached `failed` it took', async () => {
    const reasonsFor = (r: Rig, nodeId: string): string[] =>
      r.journal
        .events('run-1')
        .filter((event) => event.type === 'node_error' && event.nodeId === nodeId)
        .map((event) => String((event.payload as { reason: unknown }).reason))

    // A gate that stays red under a reviewer that keeps passing: review → gate
    // → fix, twice, and then `t-gate-exhausted`.
    const red = rig(standardWorkflow([node('a', [], { gates: ['unit'] })]), {
      outcomes: {
        'e-review': { facts: { review: { verdict: 'pass' } } },
        'e-gate': { facts: { gate: { id: 'unit', exit_code: 2 } } },
      },
    })
    expect((await red.scheduler.run()).statuses).toEqual({ a: 'failed' })

    // A reviewer that never passes: review → fix, twice, and then
    // `t-review-exhausted`. The gate never runs, so there is no gate to name.
    const rejected = rig(standardWorkflow([node('a', [], { gates: ['unit'] })]), {
      outcomes: { 'e-review': { facts: { review: { verdict: 'fail' } } } },
    })
    expect((await rejected.scheduler.run()).statuses).toEqual({ a: 'failed' })

    expect(reasonsFor(red, 'a')).toEqual([
      'pipeline ended in state "failed" via "t-gate-exhausted"; gate "unit" exited 2; ' +
        '2 of 2 fix rounds spent',
    ])
    expect(reasonsFor(rejected, 'a')).toEqual([
      'pipeline ended in state "failed" via "t-review-exhausted"; review verdict "fail"; ' +
        '2 of 2 fix rounds spent',
    ])

    // §11: a gate id and an exit code, never what the gate printed. The
    // reviewer's own words are in the transcript and reach nothing here — the
    // verdict is one of two fixed strings.
    for (const reason of [...reasonsFor(red, 'a'), ...reasonsFor(rejected, 'a')]) {
      expect(reason).not.toContain('log_ref')
      expect(reason).not.toContain(red.laneRoot)
    }

    expectDrained(red)
    expectDrained(rejected)
  })

  /**
   * A gate that ran out of time exits `TIMEOUT_EXIT` (124), which is the gate
   * runner's own convention and means nothing to the person reading the
   * journal. "exited 124" and "exited 2" send them to the same place; "timed
   * out" and "exited 2" do not.
   */
  it('says a gate timed out rather than quoting the runner’s exit convention', async () => {
    const r = rig(standardWorkflow([node('a', [], { gates: ['unit'] })]), {
      outcomes: {
        'e-review': { facts: { review: { verdict: 'pass' } } },
        'e-gate': { facts: { gate: { id: 'unit', exit_code: 124, status: 'timed_out' } } },
      },
    })

    expect((await r.scheduler.run()).statuses).toEqual({ a: 'failed' })
    expect(
      r.journal
        .events('run-1')
        .filter((event) => event.type === 'node_error')
        .map((event) => String((event.payload as { reason: unknown }).reason)),
    ).toEqual([
      'pipeline ended in state "failed" via "t-gate-exhausted"; gate "unit" timed out; ' +
        '2 of 2 fix rounds spent',
    ])
    expectDrained(r)
  })

  /**
   * The stale-fact guard, on a pipeline of its own because `standard-phase`
   * cannot reach the shape: a green gate there goes straight to `integrate`
   * and the phase is done. Any pipeline that keeps going after a gate passes
   * can reach it, and there the last gate that ran is a gate that had nothing
   * to do with the failure — naming it would read as evidence.
   */
  it('leaves a gate that passed out of the reason', async () => {
    const workflow = makeWorkflow([node('a', [], { gates: ['unit'] })], {
      resources: {
        lane: { capacity: 2, kind: 'worktree' },
        'test-suite': { capacity: 1, kind: 'semaphore' },
      },
      gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
      pipelines: {
        'green-gate-then-fail': {
          states: [
            {
              id: 'gate',
              name: 'Gate',
              position: { x: 0, y: 0 },
              onEnter: [{ id: 'e-gate', definitionId: 'run_gate', params: {} }],
            },
            {
              id: 'failed',
              name: 'Failed',
              position: { x: 200, y: 0 },
              data: { outcome: 'failed' },
            },
          ],
          transitions: [{ id: 't-gave-up', from: 'gate', to: 'failed' }],
          initialStateIds: ['gate'],
          finalStateIds: ['failed'],
        },
      },
      pipeline: 'green-gate-then-fail',
    })
    const r = rig(workflow, { outcomes: { 'e-gate': { facts: { gate: { id: 'unit', exit_code: 0 } } } } })

    expect((await r.scheduler.run()).statuses).toEqual({ a: 'failed' })
    expect(r.calls.some((call) => call.effect === 'e-gate')).toBe(true)

    // The gate ran and it is not in the sentence. The fix-round count is,
    // because `0 of 2` is itself the news: nothing was even tried.
    expect(
      r.journal
        .events('run-1')
        .filter((event) => event.type === 'node_error')
        .map((event) => String((event.payload as { reason: unknown }).reason)),
    ).toEqual(['pipeline ended in state "failed" via "t-gave-up"; 0 of 2 fix rounds spent'])
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// Prompt composition, at the scheduler's seam
//
// `#spawn` used to hand every role `node.prompt_ref` as its whole prompt. It
// now composes one (`src/prompts`), selected by the effect's `prompt_template`,
// out of a brief resolved from the lane. Both halves of that are asserted here:
// what the agent is handed, and what happens when the reference resolves to
// nothing.
// ---------------------------------------------------------------------------

/** A plan in every lane slot — which is what makes a lane slot a checkout. */
function plant(r: Rig, body: string): void {
  for (const slot of ['run-1-lane-1', 'run-1-lane-2']) {
    mkdirSync(join(r.laneRoot, slot), { recursive: true })
    writeFileSync(join(r.laneRoot, slot, 'plan.md'), body)
  }
}

describe('prompt composition', () => {
  it('hands each role a composed prompt rather than the bare reference', async () => {
    const r = rig(standardWorkflow([node('a', [], { gates: ['unit'] })]), {
      outcomes: {
        'e-review': { facts: { review: { verdict: 'pass' } } },
        'e-gate': { facts: { gate: { exit_code: 0 } } },
      },
    })
    plant(r, '## a\n\nAdd the Folder model and its migration.\n')

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done' })
    const prompts = r.adapter.spawned.map((task) => task.prompt)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('You are implementing a')
    expect(prompts[0]).toContain('Add the Folder model and its migration.')
    expect(prompts[1]).toContain('You are reviewing a')
    expect(prompts.every((prompt) => prompt !== 'plan.md#a')).toBe(true)
    expectDrained(r)
  })

  it('fails the node, naming it and the reference, when the brief resolves to nothing', async () => {
    const r = rig(standardWorkflow([node('a', [], { gates: ['unit'] })]))
    plant(r, '## some other phase\n\nBRIEF BODY\n')

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'failed' })
    expect(report.failures['a']).toContain('node "a"')
    expect(report.failures['a']).toContain('plan.md#a')
    // Identifiers only: the file it did read never reaches the failure reason.
    expect(report.failures['a']).not.toContain('BRIEF BODY')
    expect(r.adapter.spawned).toEqual([])
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
    expect(transcriptOf(r, 'a')).toContainEqual(
      expect.objectContaining({
        type: 'user_message',
        text: 'the composite index is the fast one',
        // §7: the operator's, never the implementer's — even though the adapter
        // echoes it back on the implementer's own event stream, which is how it
        // reaches this file in the first place.
        by: { role: 'operator' },
      }),
    )
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
    expect(transcriptOf(r, 'a')).toContainEqual(
      expect.objectContaining({
        type: 'user_message',
        text: 'prefer a migration over a backfill',
      }),
    )
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
    expect(transcriptOf(r, 'a')).toContainEqual(
      expect.objectContaining({ type: 'session_ended', result: 'interrupted' }),
    )
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
    expect(transcriptOf(r, 'a')).toContainEqual(
      expect.objectContaining({ type: 'session_ended', result: 'interrupted' }),
    )
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
// 8.1: §9's fifth operation — the offer the PTY channel resolves against
//
// The registry is the daemon's third security boundary: nothing is reachable
// by default, and a node becomes reachable only while it has a live session in
// its own lane. So the assertions here are as much about what is *not* offered
// — a settled node, a finished turn, a harness with no terminal — as about
// what is.
// ---------------------------------------------------------------------------

/** The id the live session actually announced, read back off the transcript. */
const sessionIdOf = (rig_: Rig, nodeId: string): string | undefined =>
  (
    rig_.journal
      .tailTranscript('run-1', nodeId, 100)
      .find((event) => (event as { type: string }).type === 'session_started') as
      | { sessionId: string }
      | undefined
  )?.sessionId

describe('§9 take over', () => {
  it('offers a live turn, with the session id of that turn and the lane it runs in', async () => {
    const r = rig(makeWorkflow([node('a')]), { stall: true })
    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")

    const target = r.takeovers.find('run-1', 'a')
    expect(target).toBeDefined()
    // The handoff token is this session's, not an id the registry invented.
    expect(target?.sessionId).toBe(sessionIdOf(r, 'a'))
    // And the terminal opens in the lane worktree this node was assigned,
    // never in the repository.
    const lane = r.journal.nodes('run-1').find((row) => row.node_id === 'a')?.lane
    expect(lane).toBeTruthy()
    expect(target?.cwd).toBe(join(r.laneRoot, lane as string))
    expect(target?.adapter.id).toBe(HARNESS)
    expect(target?.adapter.capabilities.pty).toBe(true)

    r.stall.release()
    const report = await running
    expect(report.statuses).toEqual({ a: 'done' })
    expectDrained(r)
  })

  it('withdraws the offer as each turn ends, and leaves none behind when the run does', async () => {
    let registry: PtyRegistry | null = null
    const offeredAtEndOfTurn: (string | undefined)[] = []
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'long' })]), {
      // A spawn effect reaches the host executor only once its session's
      // stream has ended, so this samples the registry at exactly the moment
      // the turn it pointed at is over.
      tap: (call) => {
        if (call.verb === 'spawn_agent') {
          offeredAtEndOfTurn.push(registry?.find('run-1', 'a')?.sessionId)
        }
      },
    })
    registry = r.takeovers

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done' })
    // Three turns, and after each one there is nothing pointing at a stream
    // that has already ended.
    expect(offeredAtEndOfTurn).toEqual([undefined, undefined, undefined])
    expect(r.takeovers.find('run-1', 'a')).toBeUndefined()
    expectDrained(r)
  })

  it('withdraws the offer when the operator aborts the node', async () => {
    const r = rig(makeWorkflow([node('a')]), { stall: true })
    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")
    expect(r.takeovers.find('run-1', 'a')).toBeDefined()

    await r.scheduler.abortNode('a')
    r.stall.release()
    const report = await running

    expect(report.statuses).toEqual({ a: 'failed' })
    await until(() => r.takeovers.find('run-1', 'a') === undefined, 'the offer to be withdrawn')
    expectDrained(r)
  })

  it('never offers a harness that has no terminal', async () => {
    const r = rig(makeWorkflow([node('a')]), { stall: true, capabilities: { pty: false } })
    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")

    // The channel refuses `pty: false` too, but a target whose only possible
    // answer is a refusal has no business being reachable at all.
    expect(r.takeovers.find('run-1', 'a')).toBeUndefined()

    r.stall.release()
    await running
    expectDrained(r)
  })

  it('interrupts and parks on the takeover, then resumes headless from the same session id', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'long' })]), { stall: true })
    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")

    const target = r.takeovers.find('run-1', 'a')
    const sessionId = target?.sessionId as string
    expect(sessionId).toBe(sessionIdOf(r, 'a'))

    // §9's first step. The headless turn is stopped before a terminal exists,
    // and the node parks rather than stepping on into the lane the operator is
    // about to be typing in.
    await target?.interrupt()
    r.stall.release()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'node a to park')
    expect(transcriptOf(r, 'a')).toContainEqual(
      expect.objectContaining({ type: 'session_ended', result: 'interrupted' }),
    )
    expect(r.pools.held('lane')).toBe(1)

    // §9's last step, which the channel hangs off the terminal's exit.
    await target?.resume(sessionId)
    const report = await running

    expect(report.statuses).toEqual({ a: 'done' })
    // A resume, not a new session: the id the terminal held reached the task.
    expect(r.adapter.spawned[1]?.resumeSessionId).toBe(sessionId)
    // And it is spent once, not carried into every later turn.
    expect(r.adapter.spawned[2]?.resumeSessionId).toBeUndefined()
    expect(r.takeovers.find('run-1', 'a')).toBeUndefined()
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

// ---------------------------------------------------------------------------
// 9: session reuse (§15)
// ---------------------------------------------------------------------------

describe('session slots', () => {
  it('continues the slot’s session on the next turn', async () => {
    const workflow = makeWorkflow([node('a', [], { pipeline: 'reuse' })])
    const r = rig(workflow)
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done' })
    const [first, second] = r.adapter.spawned
    // The first turn opens the session; nothing to continue yet.
    expect(first?.resumeSessionId).toBeUndefined()
    // The second continues it — the whole point of §15.
    expect(second?.resumeSessionId).toBe('claude-code-session-1')
    expectDrained(r)
  })

  it('journals what each turn decided, with the id it continued', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'reuse' })]))
    await r.scheduler.run()

    expect(sessionsOf(r, 'a')).toEqual([
      { slot: 'main', disposition: 'fresh', reason: 'no_prior_session' },
      { slot: 'main', disposition: 'reused', session_id: 'claude-code-session-1' },
    ])
  })

  it('keeps the reviewer out of the session it is reviewing', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'slots' })]))
    await r.scheduler.run()

    const [work, review, rework] = r.adapter.spawned
    expect(work?.resumeSessionId).toBeUndefined()
    // A separate slot: the reviewer opens its own session rather than
    // inheriting the implementer's and grading its own work from inside it.
    expect(review?.resumeSessionId).toBeUndefined()
    // ...and the implementer picks its own session back up, not the reviewer's.
    expect(rework?.resumeSessionId).toBe('claude-code-session-1')
    expectDrained(r)
  })

  it('starts fresh on a harness that cannot resume, and says so', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'reuse' })]), {
      capabilities: { resume: false },
    })
    await r.scheduler.run()

    expect(r.adapter.spawned.map((task) => task.resumeSessionId)).toEqual([undefined, undefined])
    expect(sessionsOf(r, 'a')).toEqual([
      { slot: 'main', disposition: 'fresh', reason: 'no_resume_capability' },
      { slot: 'main', disposition: 'fresh', reason: 'no_resume_capability' },
    ])
    expectDrained(r)
  })

  it('starts fresh once the slot hits its turn ceiling', async () => {
    const workflow = WorkflowSchema.parse({
      ...makeWorkflow([node('a', [], { pipeline: 'reuse' })]),
      defaults: { harness: HARNESS, model: 'opus', pipeline: 'reuse', max_session_turns: 1 },
    })
    const r = rig(workflow)
    await r.scheduler.run()

    expect(r.adapter.spawned.map((task) => task.resumeSessionId)).toEqual([undefined, undefined])
    expect(sessionsOf(r, 'a')).toEqual([
      { slot: 'main', disposition: 'fresh', reason: 'no_prior_session' },
      { slot: 'main', disposition: 'fresh', reason: 'turn_ceiling' },
    ])
    expectDrained(r)
  })

  it('forgets its sessions when a capacity refusal re-drives the node', async () => {
    // The lane usually comes back with the same *name* — the free list hands
    // back what was just released — and is then recycled, so the worktree the
    // sessions describe is gone while nothing about the name says so. Resuming
    // into it would give an agent a memory of files it wrote and a tree with
    // none of them.
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'reuse' })], { lanes: 1 }), {
      // First turn admitted, then a refusal that unwinds the whole attempt.
      spawns: ['ok', 'rate_limit', 'ok', 'ok'],
    })
    const run = r.scheduler.run()
    // Both halves matter. `held === 0` is true before the node ever acquires,
    // so on its own it lets the clock advance past a backoff that has not been
    // set yet and the run then waits forever. One admitted spawn is what says
    // the attempt happened, and the refusal is the turn after it.
    await until(
      () => r.adapter.spawned.length === 1 && r.pools.held('lane') === 0,
      'the node to take a turn and then release its lane',
    )
    await r.advance(2_000)
    const report = await run

    expect(report.statuses).toEqual({ a: 'done' })
    // Attempt two starts from the initial state with an empty ledger, so its
    // first turn is cold — not a continuation of a session from attempt one.
    expect(sessionsOf(r, 'a')).toEqual([
      { slot: 'main', disposition: 'fresh', reason: 'no_prior_session' },
      { slot: 'main', disposition: 'fresh', reason: 'no_prior_session' },
      { slot: 'main', disposition: 'reused', session_id: 'claude-code-session-2' },
    ])
    expectDrained(r)
  })

  it('records nothing for a pipeline that named no slot', async () => {
    // The regression guard: every workflow written before §15 must behave
    // exactly as it did, which means a cold session every turn and a silent journal.
    const r = rig(makeWorkflow([node('a')]))
    await r.scheduler.run()

    expect(r.adapter.spawned.map((task) => task.resumeSessionId)).toEqual([undefined])
    expect(sessionsOf(r, 'a')).toEqual([])
    expectDrained(r)
  })
})

describe('the last fix round (§15.5)', () => {
  it('reuses the implementer’s session, then escalates the final round', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'fixes', max_fix_rounds: 2 })]))
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done' })
    const [implement, firstFix, lastFix] = r.adapter.spawned
    expect(implement?.resumeSessionId).toBeUndefined()
    // The agent that wrote the code fixes it: it knows why the code is that way.
    expect(firstFix?.resumeSessionId).toBe('claude-code-session-1')
    // And when that failed, the work goes to an agent that has not seen it —
    // the original assumptions are now the likeliest suspect.
    expect(lastFix?.resumeSessionId).toBeUndefined()

    expect(sessionsOf(r, 'a')).toEqual([
      { slot: 'main', disposition: 'fresh', reason: 'no_prior_session' },
      { slot: 'main', disposition: 'reused', session_id: 'claude-code-session-1' },
      { slot: 'main', disposition: 'fresh', reason: 'final_fix_round' },
    ])
    expectDrained(r)
  })

  it('does not escalate a single-round budget', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'fixes', max_fix_rounds: 1 })]))
    await r.scheduler.run()

    const [, onlyFix] = r.adapter.spawned
    expect(onlyFix?.resumeSessionId).toBe('claude-code-session-1')
    expectDrained(r)
  })
})

describe('a session the vendor has forgotten (§15.4)', () => {
  it('retries once, cold, and the node still completes', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'reuse' })]), {
      staleSessions: ['claude-code-session-1'],
    })
    const report = await r.scheduler.run()

    // Not a failure and not a capacity wait: the run finishes normally.
    expect(report.statuses).toEqual({ a: 'done' })
    // Two turns ran. The second was refused with the stale token and
    // immediately re-spawned without one.
    expect(r.adapter.spawned).toHaveLength(2)
    expect(r.adapter.spawned[1]?.resumeSessionId).toBeUndefined()
    expect(sessionsOf(r, 'a')).toEqual([
      { slot: 'main', disposition: 'fresh', reason: 'no_prior_session' },
      { slot: 'main', disposition: 'fresh', reason: 'stale_session' },
    ])
    expectDrained(r)
  })

  it('retries cold when a resuming spawn comes back broken, whatever it was called', async () => {
    // The safety net, not the classification. The vendor wording each adapter
    // matches on was inferred rather than observed, and a pattern that misses
    // would otherwise turn a routine expired token into a failed node and a
    // blocked subtree. The second turn is the resuming one.
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'reuse' })]), {
      spawns: ['ok', 'fatal', 'ok'],
    })
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done' })
    expect(r.adapter.spawned[1]?.resumeSessionId).toBeUndefined()
    expectDrained(r)
  })

  it('lets a cold spawn fail immediately, because a retry would change nothing', async () => {
    const r = rig(makeWorkflow([node('a', [], { pipeline: 'reuse' })]), { spawns: ['fatal'] })
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'failed' })
    // One attempt. A broken harness must not be spawned against twice per turn.
    expect(r.adapter.spawned).toHaveLength(0)
    expectDrained(r)
  })

  it('does not park the harness, so other nodes are untouched', async () => {
    // The reason `stale_session` is not a `CapacityRefusalKind`: parking would
    // stall every other node behind one node's expired token.
    const r = rig(
      makeWorkflow(
        [node('a', [], { pipeline: 'reuse' }), node('b', [], { pipeline: 'reuse' })],
        { lanes: 2 },
      ),
      { staleSessions: ['claude-code-session-1', 'claude-code-session-2'] },
    )
    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    expectDrained(r)
  })
})

// ---------------------------------------------------------------------------
// 9: staffing
// ---------------------------------------------------------------------------

describe('crew', () => {
  const CREW = {
    tier1: { role: 'implementer', tier: 1, model: 'cheap' },
    'tier2-1': { role: 'implementer', tier: 2, model: 'medium' },
    'tier2-2': { role: 'implementer', tier: 2, model: 'medium' },
    tier4: { role: 'implementer', tier: 4, model: 'dear' },
  } as const

  const CHECKER = { role: 'reviewer', tier: 4, model: 'checker' } as const

  /** Every spawn's model, in the order the harness was asked for them. */
  const modelsOf = (r: Rig): string[] => r.adapter.spawned.map((task) => task.model)

  const crewEvents = (r: Rig): Record<string, unknown>[] =>
    r.journal
      .events('run-1')
      .filter((event) => event.type === 'node_crew')
      .map((event) => event.payload as Record<string, unknown>)

  it('runs each node on its member’s model, not on defaults.model', async () => {
    const r = rig(
      makeWorkflow(
        [node('a', [], { crew: 'tier1' }), node('b', ['a'], { crew: 'tier4' })],
        { crew: { tier1: CREW.tier1, tier4: CREW.tier4 } },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.status).toBe('completed')
    expect(modelsOf(r)).toEqual(['cheap', 'dear'])
    expectDrained(r)
  })

  it('leaves an unstaffed workflow on the model it always used', async () => {
    const r = rig(makeWorkflow([node('a'), node('b', ['a'], { model: 'override' })]))
    await r.scheduler.run()

    expect(modelsOf(r)).toEqual(['opus', 'override'])
    expectDrained(r)
  })

  /**
   * The substitution, end to end. Two same-wave phases are both assigned to
   * `tier2-1`; `tier2-2` is free and equally qualified, so the wave still runs
   * two wide instead of serialising behind one member.
   */
  it('covers for a busy member with a free peer at the same tier', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier2-1' }), node('b', [], { crew: 'tier2-1' })], {
        lanes: 2,
        crew: { 'tier2-1': CREW['tier2-1'], 'tier2-2': CREW['tier2-2'] },
      }),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    // Both ran, both on the tier the plan asked for, and exactly one of them
    // was somebody else's work.
    expect(modelsOf(r)).toEqual(['medium', 'medium'])
    const members = crewEvents(r)
    expect(members.map((event) => event['member']).sort()).toEqual(['tier2-1', 'tier2-2'])
    expect(members.filter((event) => event['substitute'] === true)).toHaveLength(1)
    expect(members.find((event) => event['substitute'] === true)?.['instead_of']).toBe('tier2-1')
    expectDrained(r)
  })

  /**
   * The floor, end to end, and the one case where staffing costs throughput:
   * two lanes, a free Tier 1 member, a ready phase — and it waits anyway,
   * because the phase is Tier 2 work.
   */
  it('leaves a lane idle rather than run a phase below its tier', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier2-1' }),
          node('b', [], { crew: 'tier2-1' }),
          node('c', [], { crew: 'tier1' }),
        ],
        { lanes: 3, crew: { tier1: CREW.tier1, 'tier2-1': CREW['tier2-1'] } },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done', c: 'done' })
    // Three phases, two members, and nothing ran on a tier it was not entitled
    // to: the Tier 1 model appears exactly once.
    expect(modelsOf(r).filter((model) => model === 'cheap')).toHaveLength(1)
    expect(modelsOf(r).filter((model) => model === 'medium')).toHaveLength(2)
    expect(crewEvents(r).some((event) => event['substitute'] === true)).toBe(false)
    expectDrained(r)
  })

  /**
   * `SLOTS` spawns implementer → reviewer → implementer, so the middle turn is
   * the only one that should differ — and it should differ because a *different
   * member* took it, not because a tier was borrowed.
   */
  it('sends the review to the reviewer and keeps the fix with the author', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier1', pipeline: 'slots' })], {
        crew: { tier1: CREW.tier1, checker: CHECKER },
      }),
    )
    await r.scheduler.run()

    expect(modelsOf(r)).toEqual(['cheap', 'checker', 'cheap'])
    const roles = crewEvents(r).map((event) => event['role'] ?? 'implementer')
    expect(roles).toEqual(['implementer', 'reviewer'])
    expectDrained(r)
  })

  it('reviews on the node’s own model when the roster staffs no reviewer', async () => {
    // Every workflow written before reviewers were members. The review is still
    // its own session; it simply has nobody of its own to run as.
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier4', pipeline: 'slots' })], {
        crew: { tier4: CREW.tier4 },
      }),
    )
    await r.scheduler.run()

    expect(modelsOf(r)).toEqual(['dear', 'dear', 'dear'])
    expectDrained(r)
  })

  /**
   * One reviewer, two phases running at once. The reviewer cannot read two
   * diffs in one worktree, so the second review queues — and the run still
   * completes, which is the half that would break if the wait could deadlock.
   */
  it('queues two phases behind a single reviewer without stalling', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier2-1', pipeline: 'slots' }),
          node('b', [], { crew: 'tier2-2', pipeline: 'slots' }),
        ],
        {
          lanes: 2,
          crew: { 'tier2-1': CREW['tier2-1'], 'tier2-2': CREW['tier2-2'], checker: CHECKER },
        },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    expect(modelsOf(r).filter((model) => model === 'checker')).toHaveLength(2)
    expectDrained(r)
  })

  /**
   * The reviewer reads where the work is, uncommitted changes and all. Giving it
   * a checkout of its own would mean reviewing a committed snapshot — strictly
   * less than what is in the tree, and too late to fix anything before the
   * commit that recorded it.
   */
  it('reviews in the implementer’s own lane, not a tree of its own', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier2-1', pipeline: 'slots' })], {
        crew: { 'tier2-1': CREW['tier2-1'], checker: CHECKER },
      }),
    )
    await r.scheduler.run()

    const cwds = new Set(r.adapter.spawned.map((task) => task.cwd))
    expect(cwds.size).toBe(1)
    // And it is the member's desk, named for them rather than numbered.
    expect([...cwds][0]).toContain('tier2-1')
    expectDrained(r)
  })

  it('gives desks to implementers only — a reviewer has no worktree', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier2-1', pipeline: 'slots' })], {
        crew: { 'tier2-1': CREW['tier2-1'], checker: CHECKER },
      }),
    )
    await r.scheduler.run()

    expect(r.adapter.spawned.every((task) => !task.cwd.includes('checker'))).toBe(true)
    expectDrained(r)
  })

  it('never lets the phase’s own author review it', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier4', pipeline: 'slots' })], {
        crew: { tier4: CREW.tier4, checker: CHECKER },
      }),
    )
    await r.scheduler.run()

    const reviewTurns = crewEvents(r).filter((event) => event['role'] === 'reviewer')
    expect(reviewTurns.map((event) => event['member'])).toEqual(['checker'])
    expect(modelsOf(r)[1]).toBe('checker')
    expectDrained(r)
  })

  /**
   * The point of the whole thing. Two phases, one member, one session — so the
   * second phase does not pay to rediscover the repository the first one
   * already read.
   */
  it('keeps a member’s session across the phases it takes', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier4', pipeline: 'reuse' }),
          node('b', ['a'], { crew: 'tier4', pipeline: 'reuse' }),
        ],
        { crew: { tier4: CREW.tier4 }, lanes: 1 },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    // Four turns, one session: cold once, and continued every turn after —
    // including across the phase boundary, which is the turn that used to be
    // cold for no reason but the lane's name.
    const resumed = r.adapter.spawned.map((task) => task.resumeSessionId)
    expect(resumed[0]).toBeUndefined()
    expect(resumed.slice(1).every((id) => id === resumed[1])).toBe(true)
    expect(sessionsOf(r, 'b')).toEqual([
      { slot: 'main', disposition: 'reused', session_id: 'claude-code-session-1' },
      { slot: 'main', disposition: 'reused', session_id: 'claude-code-session-1' },
    ])
    expectDrained(r)
  })

  /**
   * The ledgers are per member and do not leak between them.
   *
   * **The tiers here are load-bearing and were the other way round.** It used
   * to be a warm `tier2-1` followed by a `tier1` phase, which stopped testing
   * this the moment warmth became a staffing input: `tier2-1` clears a Tier 1
   * floor, so the second phase was promoted to `tier2-1` and legitimately
   * resumed — the assertion failed on the feature working, not on a leak. The
   * Tier 4 floor is the one thing a warm `tier2-1` cannot clear, so `b` is
   * still guaranteed to be staffed to a member who has never run, which is
   * what makes "cold" mean "did not inherit" rather than "was not promoted".
   */
  it('does not carry one member’s session into another member’s phase', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier2-1', pipeline: 'reuse' }),
          node('b', ['a'], { crew: 'tier4', pipeline: 'reuse' }),
        ],
        { crew: { 'tier2-1': CREW['tier2-1'], tier4: CREW.tier4 }, lanes: 2 },
      ),
    )
    await r.scheduler.run()

    expect(crewEvents(r).map((event) => event['member'])).toEqual(['tier2-1', 'tier4'])
    // `tier4` has never run: its first turn is cold, whatever `tier2-1` built up.
    expect(sessionsOf(r, 'b')[0]).toEqual({
      slot: 'main',
      disposition: 'fresh',
      reason: 'no_prior_session',
    })
    expectDrained(r)
  })

  /**
   * Warmth, end to end, and the whole point of computing it from `planSession`
   * rather than from "has this member run before".
   *
   * `a` is `tier4`'s; `b` is `tier2-1`'s and `tier2-1` is free. Today's rule
   * staffs `b` as written and opens a second session. The new one hands it to
   * `tier4` — dearer per token, and it resumes instead of cold-starting, which
   * is the trade. Both halves are asserted, because either alone would pass on
   * a bug: the promotion without the resume is the failure mode that costs on
   * both axes.
   */
  it('gives a phase to a warm higher-tier member rather than cold-start the member the plan named', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier4', pipeline: 'reuse' }),
          node('b', ['a'], { crew: 'tier2-1', pipeline: 'reuse' }),
        ],
        { crew: { 'tier2-1': CREW['tier2-1'], tier4: CREW.tier4 }, lanes: 2 },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    // `medium` never appears: the Tier 2 phase ran on the Tier 4 model.
    expect(modelsOf(r)).toEqual(['dear', 'dear', 'dear', 'dear'])
    expect(crewEvents(r).map((event) => event['member'])).toEqual(['tier4', 'tier4'])
    // The reason token, which is the only thing that tells this apart from a
    // busy-peer cover afterwards — and `tier2-1` was never busy.
    expect(crewEvents(r)[1]).toMatchObject({
      member: 'tier4',
      substitute: true,
      instead_of: 'tier2-1',
      reason: 'warm_session',
    })
    // What was actually bought: `b`'s first turn continued rather than opened.
    expect(sessionsOf(r, 'b')[0]).toMatchObject({
      slot: 'main',
      disposition: 'reused',
      session_id: 'claude-code-session-1',
    })
    expectDrained(r)
  })

  /**
   * The other side of the user's rule: only when a session is already up.
   * `tier4` here has never run, so both members would open one and the dearer
   * model would buy nothing whatsoever. The plan's own level stands.
   */
  it('staffs a phase as written when the higher tier is cold, however idle they are', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier2-1', pipeline: 'reuse' })], {
        crew: { 'tier2-1': CREW['tier2-1'], tier4: CREW.tier4 },
        lanes: 2,
      }),
    )
    await r.scheduler.run()

    expect(modelsOf(r)).toEqual(['medium', 'medium'])
    expect(crewEvents(r)).toEqual([{ member: 'tier2-1', tier: 2, substitute: false }])
    expectDrained(r)
  })

  /**
   * The floor, against the new pressure. A Tier 1 member with a warm session is
   * the cheapest possible way to avoid a cold start, and a Tier 2 phase still
   * does not go to them. Warmth reorders who qualifies; it never widens the set.
   */
  it('will not promote a phase down to a warm lower-tier member', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier1', pipeline: 'reuse' }),
          node('b', ['a'], { crew: 'tier2-1', pipeline: 'reuse' }),
        ],
        { crew: { tier1: CREW.tier1, 'tier2-1': CREW['tier2-1'] }, lanes: 2 },
      ),
    )
    await r.scheduler.run()

    expect(crewEvents(r).map((event) => event['member'])).toEqual(['tier1', 'tier2-1'])
    expect(crewEvents(r)[1]).toMatchObject({ substitute: false })
    expectDrained(r)
  })

  /**
   * The refusals are the reason warmth is `planSession`'s answer and not a
   * `has-run-before` flag. `tier4`'s slot is at its ceiling, so its next
   * turn is cold whatever we do — and a promotion bought on that would pay the
   * Tier 4 rate *and* cold-start, which is strictly worse than changing
   * nothing. `turn_ceiling` stands in for its siblings here because it is the
   * one a test can reach without a second vendor.
   */
  it('does not count a member as warm when their next turn would be refused', async () => {
    const workflow = WorkflowSchema.parse({
      ...makeWorkflow(
        [
          node('a', [], { crew: 'tier4', pipeline: 'reuse' }),
          node('b', ['a'], { crew: 'tier2-1', pipeline: 'reuse' }),
        ],
        { crew: { 'tier2-1': CREW['tier2-1'], tier4: CREW.tier4 }, lanes: 2 },
      ),
      defaults: { harness: HARNESS, model: 'opus', pipeline: 'solo', max_session_turns: 1 },
    })
    const r = rig(workflow)
    await r.scheduler.run()

    expect(crewEvents(r).map((event) => event['member'])).toEqual(['tier4', 'tier2-1'])
    expect(crewEvents(r)[1]).toMatchObject({ member: 'tier2-1', substitute: false })
    expectDrained(r)
  })

  /** A harness that cannot resume makes nobody warm, so nothing is promoted. */
  it('promotes nothing on a harness that cannot continue a session', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier4', pipeline: 'reuse' }),
          node('b', ['a'], { crew: 'tier2-1', pipeline: 'reuse' }),
        ],
        { crew: { 'tier2-1': CREW['tier2-1'], tier4: CREW.tier4 }, lanes: 2 },
      ),
      { capabilities: { resume: false } },
    )
    await r.scheduler.run()

    expect(crewEvents(r).map((event) => event['member'])).toEqual(['tier4', 'tier2-1'])
    expectDrained(r)
  })

  /**
   * A member whose last phase failed is `prior_phase_failed` on their next
   * turn, so they are cold — and promoting a phase onto a poisoned session
   * would be buying the one context §15.2 deliberately throws away.
   */
  it('does not treat a poisoned member as warm', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier4', pipeline: 'explode' }),
          node('b', [], { crew: 'tier2-1', pipeline: 'reuse' }),
        ],
        { crew: { 'tier2-1': CREW['tier2-1'], tier4: CREW.tier4 }, lanes: 1 },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.statuses['a']).toBe('failed')
    expect(crewEvents(r).find((event) => event['instead_of'] !== undefined)).toBeUndefined()
    expect(crewEvents(r).map((event) => event['member'])).toEqual(['tier4', 'tier2-1'])
    expectDrained(r)
  })

  /**
   * Warmth is per slot, and a reviewer's session is filed under the reviewer.
   * `SLOTS` spawns the implementer on `main` and the reviewer on `review`, so
   * the checker being warm on `review` must not make it a candidate for a
   * phase — the two roles are disjoint sets, and a staffing shortcut is exactly
   * how that gets breached one layer down.
   */
  it('never lets a warm reviewer take a phase', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier1', pipeline: 'slots' }),
          node('b', ['a'], { crew: 'tier1', pipeline: 'slots' }),
        ],
        { crew: { tier1: CREW.tier1, checker: CHECKER }, lanes: 2 },
      ),
    )
    await r.scheduler.run()

    const phases = crewEvents(r).filter((event) => event['role'] !== 'reviewer')
    expect(phases.map((event) => event['member'])).toEqual(['tier1', 'tier1'])
    expectDrained(r)
  })

  /**
   * A failed phase's context is the context that failed. Carrying it forward
   * carries whatever wrong turn it took, and a wrong conclusion costs more to
   * inherit than a repository costs to re-read.
   */
  it('starts a member cold after their phase failed', async () => {
    const r = rig(
      makeWorkflow(
        [
          node('a', [], { crew: 'tier4', pipeline: 'explode' }),
          node('b', [], { crew: 'tier4', pipeline: 'reuse' }),
        ],
        { crew: { tier4: CREW.tier4 }, lanes: 1 },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.statuses['a']).toBe('failed')
    expect(sessionsOf(r, 'b')[0]).toEqual({
      slot: 'main',
      disposition: 'fresh',
      reason: 'prior_phase_failed',
    })
    expectDrained(r)
  })

  it('gives the member back when a waiting node is aborted', async () => {
    // `b` cannot start: the roster has one Tier 4 member and `a` is holding
    // them. An abort has to reach it *while it waits*, and has to leave the
    // roster in a state where a third phase could still be staffed.
    const r = rig(
      makeWorkflow(
        [node('a', [], { crew: 'tier4' }), node('b', [], { crew: 'tier4' })],
        { lanes: 2, crew: { tier4: CREW.tier4 } },
      ),
      { stall: true },
    )

    const running = r.scheduler.run()
    await until(() => r.stall.live(), "node a's session to open")
    expect(r.scheduler.busyCrew()).toEqual(['tier4'])

    await r.scheduler.abortNode('b')
    r.stall.release()
    const report = await running

    expect(report.statuses).toEqual({ a: 'done', b: 'failed' })
    expectDrained(r)
  })

  it('gives the member back when the node settles, so the next one can have them', async () => {
    const r = rig(
      makeWorkflow(
        [node('a', [], { crew: 'tier4' }), node('b', ['a'], { crew: 'tier4' })],
        { lanes: 2, crew: { tier4: CREW.tier4 } },
      ),
    )
    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    expect(crewEvents(r).map((event) => event['member'])).toEqual(['tier4', 'tier4'])
    expectDrained(r)
  })
})

/**
 * Recovering from a failed phase without re-running the plan.
 *
 * A failure is usually environmental — a permission wall, a missing grant, a
 * gate that needed a service that was not up — and until now the only recovery
 * was to start the whole plan again, re-running every phase that had already
 * succeeded. These cover the operator being asked instead.
 *
 * `EXPLODE` is a pipeline that always fails, which is what makes the retries
 * observable: a node that recovered would prove the plumbing once, while one
 * that fails every time can be asked, answered, and asked again.
 */
/**
 * `fixRounds` was set to 0 when a node was created and never again. So a phase
 * that spent its whole budget on attempt 1 started attempt 2 already exhausted:
 * one review, one fix, and the exhaustion transition fired straight away.
 * Observed with `max_fix_rounds: 4` — the retry got a single round before the
 * operator was asked about it again, forty seconds standing in for four rounds
 * of work.
 */
describe('the fix budget on a second attempt', () => {
  const phase = () =>
    makeWorkflow([{ ...node('a'), max_fix_rounds: 2 }], { pipeline: 'fix-then-fail' })

  it('starts over rather than inheriting the count that ended attempt one', async () => {
    const r = rig(phase(), { onFailure: 'ask' })

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer')
    // One implementer plus two fixers: the budget, spent.
    expect(r.adapter.spawned).toHaveLength(3)

    r.scheduler.answer('a', { human: { answer: 'retry' } })
    // Waited on by spawn count rather than by status: answering does not change
    // the status synchronously, so waiting for `awaiting_human` would match the
    // park the node was just told to leave. Three more spawns, not one — a node
    // that inherited the count would go from its implementer straight to the
    // exhaustion transition, and this wait would time out at four.
    await until(
      () => r.adapter.spawned.length >= 6,
      'the second attempt to spend a fresh budget',
    )
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the second offer')

    expect(r.adapter.spawned).toHaveLength(6)

    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await running
    expectDrained(r)
  })

  it('starts over on an automatic retry too', async () => {
    // Same reset, the other door into it — and the one the default policy uses,
    // so it is the one an operator hits without choosing to.
    const r = rig(phase(), { onFailure: 'retry', retries: 1 })

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer after the retry')

    expect(r.adapter.spawned).toHaveLength(6)

    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await running
    expectDrained(r)
  })
})

describe('a failed phase the operator can retry', () => {
  const ROSTER = {
    tier1: { role: 'implementer', tier: 1, model: 'cheap' },
    tier4: { role: 'implementer', tier: 4, model: 'dear' },
  } as const

  /** Every spawn's model, in the order the harness was asked for them. */
  const modelsOf = (r: Rig): string[] => r.adapter.spawned.map((task) => task.model)

  /**
   * The production default, exercised here and nowhere else — the rig pins
   * `stop` so the failure tests stay about failures. Without this, the two
   * could drift apart with nothing to notice.
   */
  it('retries once and then asks, with no policy given', async () => {
    // `null` is the rig passing nothing, so this is production's own default.
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), { onFailure: null })

    const running = r.scheduler.run()
    // Two attempts, unprompted, and then it waits for a person.
    await until(() => r.adapter.spawned.length === 2, 'the automatic second attempt')
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer after it')
    r.scheduler.answer('a', { human: { answer: 'stop' } })
    const report = await running

    expect(report.statuses).toEqual({ a: 'failed' })
    // The reason says how hard it tried, which no event otherwise records.
    expect(report.failures['a']).toContain('after 2 attempts')
    expectDrained(r)
  })

  /**
   * The gap a real run fell into: a phase failed three times in provisioning —
   * before any agent ran, so with no transcript and no gate log either — and
   * the journal held a status, a lane and a question offering a retry, with
   * nothing anywhere saying what went wrong. The reason was computed at the
   * failure site and then handed to `#fail`, which is reached only when
   * `#recover` declines to recover; under the default policy it does not.
   */
  it('journals why every attempt failed, including the ones it recovers from', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), {
      onFailure: 'retry',
      retries: 1,
    })

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer')

    // Both attempts are on the record *before* the operator is asked anything —
    // which is the point: the question offers a retry, and answering it is the
    // only thing that used to be possible without knowing why.
    const errors = r.journal
      .events('run-1')
      .filter((event) => event.type === 'node_error')
    expect(errors.map((event) => (event.payload as { attempt: number }).attempt)).toEqual([1, 2])
    for (const event of errors) {
      expect((event.payload as { reason: string }).reason).toBeTruthy()
    }

    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await running
    expectDrained(r)
  })

  /**
   * A pipeline that cannot progress said `"Error"` and nothing else.
   *
   * The interpreter composes an id-safe sentence for exactly this — which state,
   * and which trigger failed to match — and the scheduler threw it as a bare
   * `Error`. `failureReason` reports an unrecognised error by its *name*, so the
   * sentence was discarded at the one moment it was worth keeping. The same
   * shape as the non-zero git exit `GitCommandError` was added for.
   */
  it('journals which state a stuck pipeline could not leave', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'stuck' }), { onFailure: 'stop' })

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'failed' })
    const reason = String(report.failures['a'])
    expect(reason).toContain('work')
    expect(reason).not.toBe('Error')

    const errors = r.journal
      .events('run-1')
      .filter((event) => event.type === 'node_error' && event.nodeId === 'a')
    expect(errors).toHaveLength(1)
    const journalled = String((errors[0]?.payload as { reason: string }).reason)
    // The state it could not leave, rather than the word "Error".
    expect(journalled).toContain('work')
    expect(journalled).not.toBe('Error')
    // §11: a state id, never the guard expression or anything it read.
    expect(journalled).not.toContain('verdict ==')
    expectDrained(r)
  })

  /**
   * The four hours this exists for.
   *
   * An observed fourteen-hour run spent 4h07m — 29% of its wall clock — parked
   * on "This phase failed. Try it again?" with nobody at the keyboard. The
   * answer, when it finally came, was `retry`, and it worked.
   */
  describe('an unanswered failure question', () => {
    it('answers itself after the interval, and says so on the record', async () => {
      const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), {
        onFailure: 'retry',
        retries: 0,
        retryAfterMs: 900_000,
      })

      const running = r.scheduler.run()
      await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer')
      // Nothing happens before the interval is up: the operator still owns the
      // decision for as long as they were given.
      await r.advance(899_000)
      expect(r.scheduler.statuses['a']).toBe('awaiting_human')

      await r.advance(2_000)
      await until(() => r.adapter.spawned.length === 2, 'the unattended second attempt')

      const answered = r.journal
        .events('run-1')
        .filter((event) => event.type === 'human_answered')
      expect(answered).toHaveLength(1)
      const payload = answered[0]?.payload as { answer: string; unattended?: true }
      expect(payload.answer).toBe('retry')
      // The flag that separates "a human said try again" from "nobody was here":
      // a post-mortem without it reports a decision that was never made.
      expect(payload.unattended).toBe(true)

      r.scheduler.answer('a', { human: { answer: 'stop' } })
      await running
      expectDrained(r)
    })

    it('keeps going rather than stalling at a cap', async () => {
      const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), {
        onFailure: 'retry',
        retries: 0,
        retryAfterMs: 60_000,
      })

      const running = r.scheduler.run()
      // Three unattended retries off one `retries: 0` budget. A version bounded
      // by that budget would stall after the first and idle for the rest of the
      // night, which is the failure this is for.
      for (let attempt = 2; attempt <= 4; attempt += 1) {
        await until(() => r.scheduler.statuses['a'] === 'awaiting_human', `offer ${attempt}`)
        await r.advance(61_000)
        await until(() => r.adapter.spawned.length === attempt, `attempt ${attempt}`)
      }

      r.scheduler.answer('a', { human: { answer: 'stop' } })
      await running
      expectDrained(r)
    })

    it('does not fire once the operator has answered', async () => {
      const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), {
        onFailure: 'retry',
        retries: 0,
        retryAfterMs: 60_000,
      })

      const running = r.scheduler.run()
      await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer')
      r.scheduler.answer('a', { human: { answer: 'stop' } })
      const report = await running

      // A timer left armed would fire against a node that has settled, and
      // `answer` throws for a node that is not awaiting one.
      await r.advance(600_000)
      expect(report.statuses).toEqual({ a: 'failed' })
      expect(r.journal.events('run-1').filter((e) => e.type === 'human_answered')).toHaveLength(1)
      expectDrained(r)
    })

    /**
     * The line this must not cross. A plan-authored `await_human` is a question
     * the plan wanted a person to answer — "is this migration safe to deploy" —
     * and both it and the failure offer park through the same `#park`. A timer
     * there would be the orchestrator overruling the plan on the operator's
     * behalf, so it lives in `#offerRetry` instead.
     */
    it('never answers a plan’s own await_human gate', async () => {
      const r = rig(makeWorkflow([node('a', [], { pipeline: 'gated' })]), {
        onFailure: 'retry',
        retries: 0,
        retryAfterMs: 60_000,
      })

      const running = r.scheduler.run()
      await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the plan’s own gate')

      await r.advance(3_600_000)
      // An hour later it is still waiting, because a person has to decide.
      expect(r.scheduler.statuses['a']).toBe('awaiting_human')
      expect(r.journal.events('run-1').filter((e) => e.type === 'human_answered')).toEqual([])

      r.scheduler.answer('a', { human: { answer: 'ship' } })
      await running
      expectDrained(r)
    })
  })

  it('spends its whole budget before asking', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), {
      onFailure: 'retry',
      retries: 3,
    })

    const running = r.scheduler.run()
    await until(() => r.adapter.spawned.length === 4, 'three retries after the first attempt')
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer')
    r.scheduler.answer('a', { human: { answer: 'stop' } })
    const report = await running

    expect(report.failures['a']).toContain('after 4 attempts')
    expectDrained(r)
  })

  /** `ask` skips the automatic attempts: the operator wanted the question. */
  it('asks immediately when asked to', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), { onFailure: 'ask' })

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer')

    expect(r.adapter.spawned).toHaveLength(1)
    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await running
  })

  /**
   * The operator pointing at a stopped phase, rather than answering a question
   * about one. It brings back the subtree the failure blocked, because a phase
   * that failed for an environmental reason held up work that was never broken.
   */
  it('runs a failed phase again when the operator asks, and unblocks what it held', async () => {
    // `c` is independent and parks, which is what keeps the run in flight while
    // the operator deals with `a`. That is not a contrivance — it is the only
    // situation a manual retry applies to, since a run whose nodes have all
    // settled has already returned.
    const r = rig(
      makeWorkflow([node('a'), node('b', ['a']), node('c')], { pipeline: 'explode', lanes: 3 }),
      { onFailure: 'ask' },
    )

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'a to park')
    await until(() => r.scheduler.statuses['c'] === 'awaiting_human', 'c to park')
    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await until(() => r.scheduler.statuses['a'] === 'failed', 'a to fail')
    expect(r.scheduler.statuses['b']).toBe('blocked')

    r.scheduler.retry('a')

    // Back in the ready set, and its dependent with it.
    expect(r.scheduler.statuses['b']).toBe('pending')
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'a to park again')

    r.scheduler.answer('a', { human: { answer: 'stop' } })
    r.scheduler.answer('c', { human: { answer: 'stop' } })
    const report = await running

    // `a` was spawned twice: once on its own, once because the operator said so.
    expect(r.adapter.spawned.filter((task) => task.nodeId === 'a')).toHaveLength(2)
    expect(report.statuses['b']).toBe('blocked')
    expectDrained(r)
  })

  it('refuses to retry a phase that has not failed', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), { onFailure: 'stop' })
    expect(() => r.scheduler.retry('a')).toThrow(/not failed/)
    expect(() => r.scheduler.retry('nope')).toThrow(/unknown node/)
  })

  /**
   * A run that has ended has no loop left to dispatch into. Saying so is the
   * difference between an operator re-running the plan and one clicking a
   * button that does nothing.
   */
  it('refuses once the run has ended, because there is nothing left to dispatch', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), { onFailure: 'stop' })
    await r.scheduler.run()

    // The honest refusal. A button that silently did nothing here is worse than
    // one that says the plan has to be started again.
    expect(() => r.scheduler.retry('a')).toThrow(/run has ended/)
  })

  /** `stop` is for CI, where waiting is worse than failing. */
  it('fails without asking when nobody said to ask', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }))

    const report = await r.scheduler.run()

    expect(report.statuses).toEqual({ a: 'failed' })
    expect(r.journal.pendingQuestion('run-1', 'a')).toBeUndefined()
    expect(r.adapter.spawned).toHaveLength(1)
    expectDrained(r)
  })

  it('parks the node on a question instead of failing it', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), { onFailure: 'ask' })

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'node a to park')

    const question = r.journal.pendingQuestion('run-1', 'a')?.question
    expect(question?.kind).toBe('choice')
    expect(question?.choices).toEqual(['retry', 'stop'])
    // §6.1: everything is back before the wait. An operator at lunch must not
    // be holding a lane that another phase could be using.
    expect(r.pools.held('lane')).toBe(0)

    r.scheduler.answer('a', { human: { answer: 'stop' } })
    const report = await running

    expect(report.statuses).toEqual({ a: 'failed' })
    expect(r.adapter.spawned).toHaveLength(1)
    expectDrained(r)
  })

  it('runs the phase again when the operator asks it to', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), { onFailure: 'ask' })

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the first offer')
    r.scheduler.answer('a', { human: { answer: 'retry' } })

    // It fails again — `EXPLODE` always does — and asks again rather than
    // giving up on the strength of one answer.
    await until(() => r.adapter.spawned.length === 2, 'the second attempt')
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the second offer')
    r.scheduler.answer('a', { human: { answer: 'stop' } })
    const report = await running

    expect(report.statuses).toEqual({ a: 'failed' })
    expectDrained(r)
  })

  /**
   * The attempt starts cold. The context that failed is what is being retried
   * away from, and the branch it built is gone — the worktree under it gets
   * recycled — so a resumed session would carry a memory of files it wrote and
   * a tree without them.
   */
  it('starts the retry cold rather than resuming the session that failed', async () => {
    const r = rig(makeWorkflow([node('a')], { pipeline: 'explode' }), { onFailure: 'ask' })

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the first offer')
    r.scheduler.answer('a', { human: { answer: 'retry' } })
    await until(() => r.adapter.spawned.length === 2, 'the second attempt')
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the second offer')
    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await running

    expect(r.adapter.spawned.map((task) => task.resumeSessionId)).toEqual([undefined, undefined])
  })

  /**
   * The alternatives are members of the crew, not models. A staffed run has no
   * free-floating models in it — a phase is taken by a member, and the tier
   * floor that decides who may take it is the assigned member's own — so a
   * model is something the plan cannot express and nobody could be found to
   * hold.
   */
  it('offers the members who could take the phase, and honours the pick', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier1' })], {
        pipeline: 'explode',
        crew: { tier1: ROSTER.tier1, tier4: ROSTER.tier4 },
      }),
      { onFailure: 'ask' },
    )

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the first offer')

    expect(r.journal.pendingQuestion('run-1', 'a')?.question.choices).toEqual([
      'retry',
      'retry with tier4',
      'stop',
    ])

    r.scheduler.answer('a', { human: { answer: 'retry with tier4' } })
    await until(() => r.adapter.spawned.length === 2, 'the second attempt')
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the second offer')
    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await running

    // `tier1` took the first attempt and `tier4` the second.
    expect(modelsOf(r)).toEqual(['cheap', 'dear'])
    expectDrained(r)
  })

  /**
   * The member that actually ran is never offered as the alternative to itself.
   *
   * Both phases are assigned `tier1`, so one of them is covered by `tier4` —
   * and it is that substituted phase whose failure is offered here. The menu
   * used to exclude only the member the *plan* named, so it offered "retry with
   * tier4" to a phase `tier4` had just failed: an escalation that had already
   * happened, and a third of the menu doing nothing.
   */
  it('does not offer the member that just failed the phase', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier1' }), node('b', [], { crew: 'tier1' })], {
        pipeline: 'explode',
        lanes: 2,
        crew: { tier1: ROSTER.tier1, tier4: ROSTER.tier4 },
      }),
      { onFailure: 'ask' },
    )

    const running = r.scheduler.run()
    await until(
      () => r.scheduler.statuses['a'] === 'awaiting_human' && r.scheduler.statuses['b'] === 'awaiting_human',
      'both offers',
    )

    // Whichever phase `tier4` covered: its menu names neither the member the
    // plan asked for nor the one that ran, so nothing is left to escalate to.
    const covered = r.journal
      .events('run-1')
      .filter((event) => event.type === 'node_crew')
      .find((event) => (event.payload as Record<string, unknown>)['substitute'] === true)
    expect(covered).toBeDefined()
    const substituted = String(covered?.nodeId)
    const offered = r.journal.pendingQuestion('run-1', substituted)?.question.choices ?? []
    expect(offered).not.toContain('retry with tier4')
    // And the phase that ran on the member the plan named still gets the
    // escalation, because there really is a higher tier that could take it.
    const other = substituted === 'a' ? 'b' : 'a'
    expect(r.journal.pendingQuestion('run-1', other)?.question.choices).toContain('retry with tier4')

    r.scheduler.answer('a', { human: { answer: 'stop' } })
    r.scheduler.answer('b', { human: { answer: 'stop' } })
    await running
    expectDrained(r)
  })

  /**
   * A member below the phase's tier is not offered. The floor is the whole
   * point of staffing a plan, and an operator answering a question is not a
   * reason to hand a phase to somebody the plan judged too low a tier for it.
   */
  it('never offers a member below the phase’s tier', async () => {
    const r = rig(
      makeWorkflow([node('a', [], { crew: 'tier4' })], {
        pipeline: 'explode',
        crew: { tier1: ROSTER.tier1, tier4: ROSTER.tier4 },
      }),
      { onFailure: 'ask' },
    )

    const running = r.scheduler.run()
    await until(() => r.scheduler.statuses['a'] === 'awaiting_human', 'the offer')

    expect(r.journal.pendingQuestion('run-1', 'a')?.question.choices).toEqual(['retry', 'stop'])

    r.scheduler.answer('a', { human: { answer: 'stop' } })
    await running
  })
})
