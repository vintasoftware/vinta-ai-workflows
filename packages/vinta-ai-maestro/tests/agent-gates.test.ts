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
import { join } from 'node:path'
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
