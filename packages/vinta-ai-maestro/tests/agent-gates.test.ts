/**
 * The gate an agent runs from inside its own turn.
 *
 * The three properties this exists for are all properties of *where* the gate
 * runs rather than of the gate, so they are asserted here rather than through
 * the prompt that asks for them: the cache is the run's, the lease is taken by
 * the daemon instead of by the agent, and the command is the workflow's.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GateCache } from '../src/gates/cache.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import { AgentGateBroker, AgentGateRefusal } from '../src/resources/agent-gates.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'
import { renderGate, type GateScript } from './support/gate-script.ts'

const RUN_ID = 'run-1'
const NODE = 'api-layer'
const LANE = 'run-1-lane-1'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

interface Rig {
  readonly broker: AgentGateBroker
  readonly journal: Journal
  readonly pools: ResourcePools
  readonly lane: string
  readonly counter: string
  runs(): number
}

/**
 * A run with one node, one lane and one gate.
 *
 * The lane is a real git repository because `laneTreeHash` is real; the store
 * that holds the journal, the cache and the run counter is outside it, so none
 * of the bookkeeping can move the hash the cache keys on.
 */
function rig(
  options: {
    readonly script?: GateScript
    readonly requires?: readonly string[]
    readonly timeoutS?: number
  } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), 'vinta-agent-gate-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))

  const lane = join(root, 'lane')
  const store = join(root, 'store')
  mkdirSync(lane, { recursive: true })
  mkdirSync(store, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: lane, encoding: 'utf8' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(lane, 'src.txt'), 'v1\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const counter = join(store, 'runs.txt')
  const workflow: Workflow = WorkflowSchema.parse({
    schema_version: 1,
    id: 'bookmarks',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: {
      lane: { capacity: 1, kind: 'worktree' },
      'test-suite': { capacity: 1, kind: 'semaphore' },
    },
    gates: {
      unit: {
        cmd: renderGate({ append: { path: counter, line: 'ran' }, ...options.script }),
        requires: options.requires ?? ['test-suite'],
        ...(options.timeoutS === undefined ? {} : { timeout_s: options.timeoutS }),
      },
    },
    nodes: [{ id: NODE, name: 'API', prompt_ref: 'plan.md#api-layer', gates: ['unit'] }],
  })

  const journal = openJournal(store)
  cleanups.push(() => journal.close())
  journal.createRun(RUN_ID, workflow)
  // What the scheduler writes when it admits the node. Without it the broker
  // has no lane to run in, which is its own test below.
  journal.append({ runId: RUN_ID, nodeId: NODE, type: 'node_assigned', payload: { lane: LANE } })

  const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
  const cache = new GateCache(store)
  cleanups.push(() => cache.close())

  return {
    broker: new AgentGateBroker({
      workflow,
      runId: RUN_ID,
      journal,
      pools,
      cache,
      lane: (name) => {
        if (name !== LANE) throw new Error(`unexpected lane "${name}"`)
        return { path: lane, env: { LANE_MARKER: 'set' } }
      },
    }),
    journal,
    pools,
    lane,
    counter,
    runs: () => {
      try {
        return readFileSync(counter, 'utf8').split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    },
  }
}

const transcript = (journal: Journal): unknown[] => journal.tailTranscript(RUN_ID, NODE, 50)

describe('a gate run on an agent’s behalf', () => {
  it('runs the declared command in the node’s lane, holding the gate’s pool', async () => {
    const r = rig({ script: { printCwd: true, echoEnv: ['LANE_MARKER'] } })
    const acquire = vi.spyOn(r.pools, 'acquire')

    const result = await r.broker.run('unit', NODE)

    expect(result).toMatchObject({ gateId: 'unit', status: 'passed', exitCode: 0, cached: false })
    // The lease is the daemon's, not the agent's — which is the half of this
    // that `with` could never guarantee, because `with` is something an agent
    // has to remember.
    expect(acquire).toHaveBeenCalledWith(['test-suite'])
    expect(r.pools.held('test-suite')).toBe(0)

    // It ran where the node lives, with the lane's environment: a gate against
    // the wrong worktree or an unforked database is the failure mode the lane
    // wiring exists to prevent.
    const log = readFileSync(result.logRef, 'utf8')
    expect(log).toContain(r.lane)
    expect(log).toContain('set')
  })

  it('serves an unchanged lane from the same cache the gate node reads', async () => {
    const r = rig()
    await r.broker.run('unit', NODE)

    const acquire = vi.spyOn(r.pools, 'acquire')
    const second = await r.broker.run('unit', NODE)

    expect(second.cached).toBe(true)
    expect(second.exitCode).toBe(0)
    // A hit never enters the queue for the suite, which is where the cost is.
    expect(acquire).not.toHaveBeenCalled()
    expect(r.runs()).toBe(1)
  })

  it('records the run in the journal and under the transcript’s GATE band', async () => {
    const r = rig({ script: { exit: 2 } })
    await r.broker.run('unit', NODE)

    // The same `gate_result` row `run_gate` writes, so §13.6 can say this gate
    // failed here and passed later whichever of the two ran it.
    const results = r.journal
      .events(RUN_ID)
      .filter((event) => event.type === 'gate_result')
      .map((event) => event.payload as Record<string, unknown>)
    expect(results).toMatchObject([{ gate: 'unit', exit_code: 2, status: 'failed', cached: false }])

    // And bracketed by a start, so a gate an agent asked for reads as running
    // in the node view while it runs — the same pair `run_gate` writes.
    expect(
      r.journal
        .events(RUN_ID)
        .filter((event) => event.type === 'gate_started')
        .map((event) => event.payload),
    ).toEqual([{ gate: 'unit' }])

    // And in the phase's own transcript, attributed to `gate` rather than to
    // the agent whose turn happened to ask for it.
    expect(transcript(r.journal)).toEqual([
      { type: 'gate_run', gate: 'unit', exitCode: 2, status: 'failed', cached: false, by: { role: 'gate' } },
    ])
  })

  it('marks a cached run as cached in the record, rather than implying it ran', async () => {
    const r = rig()
    await r.broker.run('unit', NODE)
    await r.broker.run('unit', NODE)

    expect(transcript(r.journal).map((entry) => (entry as { cached: boolean }).cached)).toEqual([
      false,
      true,
    ])
    // The verdict rows say it too, and the second run announces no start:
    // nothing ran, so the node view must not show it as having begun.
    expect(
      r.journal
        .events(RUN_ID)
        .filter((event) => event.type === 'gate_result')
        .map((event) => (event.payload as { cached: boolean }).cached),
    ).toEqual([false, true])
    expect(r.journal.events(RUN_ID).filter((event) => event.type === 'gate_started')).toHaveLength(
      1,
    )
  })

  it('reports a timeout as a non-zero exit rather than as a pass', async () => {
    // A gate that never finished must not reach the agent as `exit 0`. The
    // pid file goes outside the lane for the cache suite's reason: a gate that
    // never returned still must not move the tree hash.
    const r = rig({
      script: { background: { seconds: 30, pidFile: join(tmpdir(), 'vinta-agent-gate-slow.pid') } },
      timeoutS: 1,
    })

    const result = await r.broker.run('unit', NODE)

    expect(result.status).toBe('timed_out')
    expect(result.exitCode).not.toBe(0)
    // And it is not stored: a timeout says the gate did not finish, not that
    // this tree is bad, so the next ask must actually run it.
    expect((await r.broker.run('unit', NODE)).cached).toBe(false)
  }, 30_000)

  describe('refusals', () => {
    it('refuses a gate the plan does not declare', async () => {
      const r = rig()
      await expect(r.broker.run('nope', NODE)).rejects.toThrow(AgentGateRefusal)
      await expect(r.broker.run('nope', NODE)).rejects.toMatchObject({ code: 'unknown_gate' })
    })

    it('refuses a node the run does not have', async () => {
      const r = rig()
      await expect(r.broker.run('unit', 'ghost')).rejects.toMatchObject({ code: 'no_lane' })
    })

    /**
     * The one refusal that is about deadlock rather than about a typo. The node
     * holds `lane` for the whole of its turn, so a gate that also requires it
     * would queue behind the very turn that asked — forever, and silently.
     */
    it('refuses a gate that requires the lane the asking node is holding', async () => {
      const r = rig({ requires: ['lane'] })
      await expect(r.broker.run('unit', NODE)).rejects.toMatchObject({ code: 'gate_needs_lane' })
      expect(r.runs()).toBe(0)
    })
  })
})

/**
 * The wait, which is the half of this that HTTP made necessary.
 *
 * `run` is the whole gate in one promise, and nothing over a socket can await
 * one: Node's own `fetch` abandons a response after five minutes, and a gate
 * that queues for a capacity-1 semaphore and then runs a test suite is
 * routinely slower than that. The observed cost was not a slow gate but a
 * *lying* one — the CLI reported a daemon it could not reach about a gate that
 * was running fine, agents wrote polling loops to work around the lie, and a
 * measured phase spent a quarter of its wall clock inside them.
 *
 * So the wait is hops, and these are the two properties that make hopping safe:
 * a hop that gives up leaves the gate running, and the next ask finds it.
 */
describe('a gate waited for in hops', () => {
  /** A gate that finishes when the test says so, and not before. */
  const held = (): { path: string; release: () => void } => {
    const path = join(mkdtempSync(join(tmpdir(), 'vinta-agent-gate-hold-')), 'go')
    cleanups.push(() => rmSync(dirname(path), { recursive: true, force: true }))
    return { path, release: () => writeFileSync(path, 'go\n') }
  }

  it('answers "still running" without disturbing the gate, then answers with it', async () => {
    const gate = held()
    const r = rig({ script: { until: { path: gate.path } } })

    // Nothing can finish inside zero milliseconds, so this reaches the queued
    // answer without the test having to guess at a duration.
    const first = await r.broker.hop('unit', NODE, { withinMs: 0 })
    expect(first).toEqual({ waiting: true, gateId: 'unit' })

    // Still running: giving up on a hop must not cancel the work behind it.
    // Cancelled here, a client's ceiling would become the gate's, and the
    // suite would restart from nothing every time the harness reached for its
    // timer.
    const second = await r.broker.hop('unit', NODE, { withinMs: 0 })
    expect(second).toEqual({ waiting: true, gateId: 'unit' })

    gate.release()
    const done = await r.broker.hop('unit', NODE, { withinMs: 30_000 })
    expect(done).toMatchObject({ gateId: 'unit', status: 'passed', exitCode: 0, cached: false })

    // One gate ran, though it was asked for three times.
    expect(r.runs()).toBe(1)
  }, 30_000)

  /**
   * The property the whole re-invocation design rests on.
   *
   * An agent harness kills a command at its own ceiling, and a gate may exceed
   * any such ceiling — a plan that declares `timeout_s: 2400` for its suite is
   * declaring forty minutes against a harness budget of ten. So being killed
   * partway is the *ordinary* ending, and what the agent does next is run the
   * command again. That has to attach, not start a second suite beside the
   * first — which is what it did when the only way in was `run`, and it did it
   * behind the very semaphore its own predecessor was still holding.
   */
  it('attaches a second ask to the gate already running rather than starting another', async () => {
    const gate = held()
    const r = rig({ script: { until: { path: gate.path } } })
    const acquire = vi.spyOn(r.pools, 'acquire')

    // Two asks with nothing carried between them — the client was killed and
    // re-invoked, so it has no token and needs none. `(node, gate)` is the
    // whole of the gate's identity.
    expect(await r.broker.hop('unit', NODE, { withinMs: 0 })).toMatchObject({ waiting: true })
    expect(await r.broker.hop('unit', NODE, { withinMs: 0 })).toMatchObject({ waiting: true })

    gate.release()
    const done = await r.broker.hop('unit', NODE, { withinMs: 30_000 })

    expect(done).toMatchObject({ status: 'passed', cached: false })
    expect(r.runs()).toBe(1)
    // And the pool was taken once. Two runs would have been two acquires, the
    // second queued behind the first on a capacity-1 semaphore.
    expect(acquire).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('refuses on the hop that asked, and does not leave the refusal behind it', async () => {
    const r = rig()

    // A refusal rejects before anything is acquired, so it lands inside the
    // hop's own window however short that is — the route needs it there to
    // turn it into a status.
    await expect(r.broker.hop('nope', NODE, { withinMs: 0 })).rejects.toMatchObject({
      code: 'unknown_gate',
    })
    // And asking again is refused the same way rather than inheriting a dead
    // flight, or worse, waiting forever on one.
    await expect(r.broker.hop('nope', NODE, { withinMs: 0 })).rejects.toMatchObject({
      code: 'unknown_gate',
    })
  })

  /**
   * A gate that finished while nobody was watching is not a special case: the
   * flight retires on settling and the next ask runs the gate again, which for
   * a tree that has not moved is a `GateCache` hit. Nothing has to decide how
   * long to hold a finished answer, because the cache already is that decision.
   */
  it('answers from the cache once the flight it was watching has retired', async () => {
    const r = rig()

    const first = await r.broker.hop('unit', NODE, { withinMs: 30_000 })
    expect(first).toMatchObject({ status: 'passed', cached: false })

    const again = await r.broker.hop('unit', NODE, { withinMs: 30_000 })
    expect(again).toMatchObject({ status: 'passed', cached: true })
    expect(r.runs()).toBe(1)
  }, 30_000)
})
