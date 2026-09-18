/**
 * The plan post-mortem (§13.6).
 *
 * Every run here is a **synthetic journal**: events appended at timestamps the
 * test chooses, exactly as `tests/analytics.test.ts` does and for the same
 * reason — `Journal.append` stamps `Date.now()`, so a real journal cannot
 * express "this phase ran eight times longer than the rest of its wave", and
 * every assertion here is about arithmetic and ordering being exact.
 *
 * The assertion that matters most is the negative one. A post-mortem is read by
 * a planning agent in a different session, which cannot cross-check it against
 * anything; a fabricated finding there is invisible and acted upon. So the
 * first test pins that `unused_dependencies` is empty and that the artifact
 * says, in the gap, precisely which event would have to exist for it not to be
 * — the day someone makes that finding non-empty, they have to change this
 * test on purpose.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeWaves } from '../src/graph.ts'
import type {
  GateStatus,
  NewEvent,
  NodeStatus,
  RunStatus,
  StoredEvent,
} from '../src/journal/events.ts'
import {
  parsePostMortem,
  postMortem,
  type PostMortem,
  type PostMortemSource,
  RunNotFinishedError,
  serializePostMortem,
} from '../src/postmortem/postmortem.ts'
import { serializePostMortemSchema } from '../src/postmortem/schema.ts'
import type { Workflow, WorkflowInput } from '../src/types.ts'
import { parseWorkflow } from '../src/validate.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN = 'bookmark-folders-run-1'
const T0 = 1_700_000_000_000
const MIN = 60_000

const workflow = (nodes: WorkflowInput['nodes']): Workflow => {
  const result = parseWorkflow({
    schema_version: 1,
    id: 'bookmark-folders',
    plan_ref: 'ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 4, kind: 'worktree' } },
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
 * A journal with the timestamps written by hand. Satisfies `PostMortemSource`
 * structurally, exactly as `Journal` does.
 */
class Tape implements PostMortemSource {
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
  begin(ts = T0): this {
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

  /** One journalled gate verdict. Ids and an exit code — never the gate's output. */
  gate(ts: number, nodeId: string, gate: string, status: GateStatus): this {
    return this.push(ts, {
      runId: RUN,
      nodeId,
      type: 'gate_result',
      payload: { gate, exit_code: status === 'passed' ? 0 : 1, status },
    })
  }

  /** Dispatched and settled, with nothing interesting in between. */
  ran(nodeId: string, from: number, to: number, settle: NodeStatus = 'done'): this {
    this.status(from, nodeId, 'running')
    return this.status(to, nodeId, settle)
  }
}

/** The shape every test builds on: one foundation phase, two peers, one join. */
const chain = () =>
  workflow([phase('p1'), phase('p2', ['p1']), phase('p3', ['p1']), phase('p4', ['p2', 'p3'])])

/** A run where every phase ran once, in wave order, with no drama. */
const cleanTape = (): Tape => {
  const tape = new Tape(chain()).begin()
  tape.ran('p1', T0 + MIN, T0 + 11 * MIN)
  tape.ran('p2', T0 + 12 * MIN, T0 + 22 * MIN)
  tape.ran('p3', T0 + 12 * MIN, T0 + 24 * MIN)
  tape.ran('p4', T0 + 25 * MIN, T0 + 35 * MIN)
  return tape.end(T0 + 36 * MIN)
}

const gapOf = (report: PostMortem, kind: string) =>
  report.gaps.find((gap) => gap.kind === kind)

/** With the integration record supplied, so only the journal's gaps are in play. */
const report_ = (tape: Tape): PostMortem => postMortem(tape, RUN, { integration: [] })

// ---------------------------------------------------------------------------
// 0. What the schedule cost
// ---------------------------------------------------------------------------

describe('the chain that decided the wall clock', () => {
  /**
   * The diamond: p1 → (p2 ‖ p3) → p4, with p3 the slower arm. The chain is the
   * one through p3, and p2 is nowhere in it — making p2 instant would not move
   * the run by a second, which is the whole point of reporting this.
   */
  it('walks the slow arm of a diamond, not the fast one', () => {
    const report = postMortem(cleanTape(), RUN, { integration: [] })
    const path = report.findings.critical_path

    expect(path?.nodes.map((entry) => entry.node)).toEqual(['p1', 'p3', 'p4'])
    // 10 + 12 + 10 minutes of a 36-minute run.
    expect(path?.span_ms).toBe(32 * MIN)
    expect(path?.share_of_elapsed).toBeCloseTo(32 / 36, 3)
  })

  it('reports the width the graph reached, against the lanes it asked for', () => {
    const report = postMortem(cleanTape(), RUN, { integration: [] })
    const idle = report.findings.idle_capacity

    // p2 and p3 overlap and nothing else does: two wide, never three.
    expect(idle?.peak_concurrency).toBe(2)
    expect(idle?.lane_ms_used).toBe(42 * MIN)
    expect(idle?.idle_share).toBeGreaterThanOrEqual(0)
    expect(idle?.idle_share).toBeLessThanOrEqual(1)
  })

  /**
   * The finding is about the *graph*, and a reader who takes it for an
   * explanation of the wall clock will be wrong whenever a phase waited on a
   * busy lane or an unanswered question. The gap is what stops that reading.
   */
  it('says out loud that it cannot see why a ready phase waited', () => {
    const report = postMortem(cleanTape(), RUN, { integration: [] })

    expect(gapOf(report, 'blocking_cause_unrecorded')?.needs).toContain('not dispatched')
  })

  it('reports neither for a run that dispatched nothing', () => {
    const tape = new Tape(chain()).begin()
    const report = postMortem(tape.end(T0 + MIN), RUN, { integration: [] })

    // Null rather than an empty shape: "no chain" and "a chain of nothing" are
    // different claims, and a planner acts on them differently.
    expect(report.findings.critical_path).toBeNull()
    expect(report.findings.idle_capacity).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 1. Dependencies declared but never used
// ---------------------------------------------------------------------------

describe('dependencies declared but never used', () => {
  it('reports none, and says exactly what event would be needed to report any', () => {
    // p4 declares both peers; the run gives no evidence either way, which is
    // the point — the schedule cannot tell a needed artifact from an ignored
    // one, so nothing is reported and the absence is explained.
    const report = postMortem(cleanTape(), RUN, { integration: [] })

    expect(report.findings.unused_dependencies).toEqual([])

    const gap = gapOf(report, 'dependency_use_unrecorded')
    expect(gap).toBeDefined()
    // Every declared edge is named as unproven — in both directions.
    expect(gap?.edges).toEqual([
      { node: 'p2', depends_on: 'p1' },
      { node: 'p3', depends_on: 'p1' },
      { node: 'p4', depends_on: 'p2' },
      { node: 'p4', depends_on: 'p3' },
    ])
    // The required instrumentation, named concretely rather than as "more data".
    expect(gap?.needs).toContain('which of its declared dependencies its work actually')
    expect(gap?.needs).toContain('The schedule is not a substitute')
  })

  it('carries no gap when the plan declares no edges at all', () => {
    const tape = new Tape(workflow([phase('p1')])).begin()
    tape.ran('p1', T0 + MIN, T0 + 11 * MIN).end(T0 + 12 * MIN)
    const report = postMortem(tape, RUN, { integration: [] })
    expect(report.gaps.map((gap) => gap.kind)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Dependencies discovered missing
// ---------------------------------------------------------------------------

describe('dependencies discovered missing', () => {
  /**
   * p3 fails, p2 — which p3 does not depend on — lands, and only then does p3
   * pass. That ordering is the whole evidence, and the artifact says so: the
   * gate gap states the causal link is not proven.
   */
  const discovered = (): Tape => {
    const tape = new Tape(chain()).begin()
    tape.ran('p1', T0 + MIN, T0 + 11 * MIN)
    tape.status(T0 + 12 * MIN, 'p3', 'running')
    tape.status(T0 + 20 * MIN, 'p3', 'failed')
    tape.ran('p2', T0 + 12 * MIN, T0 + 25 * MIN)
    tape.status(T0 + 26 * MIN, 'p3', 'running')
    tape.status(T0 + 32 * MIN, 'p3', 'done')
    tape.ran('p4', T0 + 33 * MIN, T0 + 43 * MIN)
    return tape.end(T0 + 44 * MIN)
  }

  it('names the undeclared phase that landed between the failure and the pass', () => {
    const report = postMortem(discovered(), RUN, { integration: [] })
    expect(report.findings.missing_dependencies).toEqual([
      {
        node: 'p3',
        depends_on: 'p2',
        failed_at_ms: T0 + 20 * MIN,
        landed_at_ms: T0 + 25 * MIN,
        passed_at_ms: T0 + 32 * MIN,
      },
    ])
  })

  it('states that the evidence is ordering when the run recorded no gate result', () => {
    const gap = gapOf(postMortem(discovered(), RUN, { integration: [] }), 'gate_result_unrecorded')
    expect(gap?.nodes).toEqual(['p3'])
    expect(gap?.needs).toContain('a `gate_result` event for these phases')
    expect(gap?.needs).toContain('ordering evidence')
    // No gate result to name, so the finding carries no gate.
    expect(report_(discovered()).findings.missing_dependencies[0]?.gate).toBeUndefined()
  })

  /**
   * The shape the journal used to lose entirely. `p3`'s gate goes red, a phase
   * it does not depend on lands, the gate goes green — and the node never
   * reaches `node_status: failed` at all, because the pipeline recovered on
   * its own. Before gate results were journalled this run looked like a clean
   * one, which made the most common missing dependency the least visible.
   */
  const gateRecovered = (): Tape => {
    const tape = new Tape(chain()).begin()
    tape.ran('p1', T0 + MIN, T0 + 11 * MIN)
    tape.status(T0 + 12 * MIN, 'p3', 'running')
    tape.gate(T0 + 20 * MIN, 'p3', 'unit', 'failed')
    tape.ran('p2', T0 + 12 * MIN, T0 + 25 * MIN)
    tape.gate(T0 + 30 * MIN, 'p3', 'unit', 'passed')
    tape.status(T0 + 32 * MIN, 'p3', 'done')
    tape.ran('p4', T0 + 33 * MIN, T0 + 43 * MIN)
    return tape.end(T0 + 44 * MIN)
  }

  it('uses a recorded gate result as the window, and names the gate', () => {
    const report = report_(gateRecovered())

    expect(report.findings.missing_dependencies).toEqual([
      {
        node: 'p3',
        depends_on: 'p2',
        // The window is the gate's, not the node's: red at 20, green at 30.
        failed_at_ms: T0 + 20 * MIN,
        landed_at_ms: T0 + 25 * MIN,
        passed_at_ms: T0 + 30 * MIN,
        gate: 'unit',
      },
    ])
  })

  it('drops the gate gap for a run whose gates were recorded', () => {
    const report = report_(gateRecovered())

    expect(gapOf(report, 'gate_result_unrecorded')).toBeUndefined()
    // The gap that is genuinely still open stays open.
    expect(gapOf(report, 'dependency_use_unrecorded')).toBeDefined()
    expect(report.findings.unused_dependencies).toEqual([])
  })

  /** A different gate going green proves nothing about the one that went red. */
  it('does not close a red gate with another gate’s pass', () => {
    const tape = new Tape(chain()).begin()
    tape.ran('p1', T0 + MIN, T0 + 11 * MIN)
    tape.status(T0 + 12 * MIN, 'p3', 'running')
    tape.gate(T0 + 20 * MIN, 'p3', 'unit', 'failed')
    tape.ran('p2', T0 + 12 * MIN, T0 + 25 * MIN)
    tape.gate(T0 + 30 * MIN, 'p3', 'lint', 'passed')
    tape.status(T0 + 32 * MIN, 'p3', 'blocked')
    tape.end(T0 + 44 * MIN)

    expect(report_(tape).findings.missing_dependencies).toEqual([])
  })

  it('does not propose an edge the graph already implies, nor one that would cycle', () => {
    // p4 fails, then passes after p1 (already an ancestor through p2/p3) and
    // after nothing else. p1 must not be proposed; neither must p4 itself.
    const tape = new Tape(chain()).begin()
    tape.ran('p2', T0 + 12 * MIN, T0 + 22 * MIN)
    tape.ran('p3', T0 + 12 * MIN, T0 + 22 * MIN)
    tape.status(T0 + 23 * MIN, 'p4', 'running')
    tape.status(T0 + 25 * MIN, 'p4', 'failed')
    tape.ran('p1', T0 + 26 * MIN, T0 + 30 * MIN)
    tape.status(T0 + 31 * MIN, 'p4', 'running')
    tape.status(T0 + 40 * MIN, 'p4', 'done')
    tape.end(T0 + 41 * MIN)

    expect(postMortem(tape, RUN, { integration: [] }).findings.missing_dependencies).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Same-wave nodes that actually conflicted
// ---------------------------------------------------------------------------

describe('same-wave conflicts', () => {
  it('names both nodes and the contested paths, off the integration record', () => {
    const report = postMortem(cleanTape(), RUN, {
      integration: [
        { wave: 1, conflicts: [] },
        {
          wave: 2,
          conflicts: [
            {
              nodes: ['p2', 'p3'],
              paths: ['apps/bookmarks/api/views.py', 'apps/bookmarks/api/serializers.py'],
              rounds: 2,
            },
          ],
        },
      ],
    })

    expect(report.findings.wave_conflicts).toEqual([
      {
        wave: 2,
        nodes: ['p2', 'p3'],
        paths: ['apps/bookmarks/api/views.py', 'apps/bookmarks/api/serializers.py'],
        fix_rounds: 2,
      },
    ])
    expect(gapOf(report, 'integration_record_unavailable')).toBeUndefined()
  })

  it('drops a record naming one node — that is history, not two wrongly-parallel peers', () => {
    const report = postMortem(cleanTape(), RUN, {
      integration: [{ wave: 2, conflicts: [{ nodes: ['p2'], paths: ['a.py'], rounds: 1 }] }],
    })
    expect(report.findings.wave_conflicts).toEqual([])
  })

  it('distinguishes “no conflicts” from “nobody told us about conflicts”', () => {
    const unknown = postMortem(cleanTape(), RUN)
    expect(unknown.findings.wave_conflicts).toEqual([])
    const gap = gapOf(unknown, 'integration_record_unavailable')
    expect(gap?.needs).toContain('no event carries them')
    expect(gap?.needs).toContain('unrecorded, not clean')

    const clean = postMortem(cleanTape(), RUN, { integration: [] })
    expect(gapOf(clean, 'integration_record_unavailable')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Duration divergence
// ---------------------------------------------------------------------------

describe('duration divergence', () => {
  it('reports a phase whose span is wildly out of line with the rest of its wave', () => {
    const tape = new Tape(chain()).begin()
    tape.ran('p1', T0 + MIN, T0 + 11 * MIN)
    tape.ran('p2', T0 + 12 * MIN, T0 + 22 * MIN) // 10 minutes
    tape.ran('p3', T0 + 12 * MIN, T0 + 92 * MIN) // 80 minutes, same wave
    tape.ran('p4', T0 + 93 * MIN, T0 + 103 * MIN)
    tape.end(T0 + 104 * MIN)

    const divergences = postMortem(tape, RUN, { integration: [] }).findings.duration_divergences
    // The baseline is leave-one-out, so a wave of two reports both ends of the
    // same fact: p3 set the wave's wall clock, p2 was bundled behind it.
    expect(divergences).toEqual([
      {
        node: 'p2',
        wave: 2,
        span_ms: 10 * MIN,
        wave_baseline_ms: 80 * MIN,
        ratio: 0.13,
        direction: 'shorter',
      },
      {
        node: 'p3',
        wave: 2,
        span_ms: 80 * MIN,
        wave_baseline_ms: 10 * MIN,
        ratio: 8,
        direction: 'longer',
      },
    ])
  })

  it('says nothing about a wave of one, and nothing below the noise floor', () => {
    const solo = new Tape(workflow([phase('p1'), phase('p2', ['p1'])])).begin()
    solo.ran('p1', T0, T0 + 200 * MIN)
    solo.ran('p2', T0 + 201 * MIN, T0 + 202 * MIN)
    solo.end(T0 + 203 * MIN)
    expect(postMortem(solo, RUN, { integration: [] }).findings.duration_divergences).toEqual([])

    const fast = new Tape(chain()).begin()
    fast.ran('p1', T0, T0 + 1000)
    fast.ran('p2', T0 + 1000, T0 + 1100) // 100ms
    fast.ran('p3', T0 + 1000, T0 + 6000) // 5s — 50×, and both far too short to matter
    fast.end(T0 + 7000)
    expect(postMortem(fast, RUN, { integration: [] }).findings.duration_divergences).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. A clean run
// ---------------------------------------------------------------------------

describe('a run with nothing to report', () => {
  it('emits a valid, empty post-mortem rather than nothing', () => {
    const report = postMortem(cleanTape(), RUN, { integration: [] })

    expect(report.findings.unused_dependencies).toEqual([])
    expect(report.findings.missing_dependencies).toEqual([])
    expect(report.findings.wave_conflicts).toEqual([])
    expect(report.findings.duration_divergences).toEqual([])
    expect(report.run).toEqual({
      status: 'done',
      started_at_ms: T0,
      ended_at_ms: T0 + 36 * MIN,
      elapsed_ms: 36 * MIN,
      node_count: 4,
      wave_count: 3,
    })
    expect(report.plan_ref).toBe('ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md')
    // The only things it has to say are what it could not see.
    expect(report.gaps.map((gap) => gap.kind).sort()).toEqual([
      'blocking_cause_unrecorded',
      'dependency_use_unrecorded',
    ])
    expect(parsePostMortem(report).ok).toBe(true)
  })

  it('carries nothing but ids, waves, paths, counts and timestamps', () => {
    const report = postMortem(cleanTape(), RUN, {
      integration: [
        { wave: 2, conflicts: [{ nodes: ['p2', 'p3'], paths: ['apps/x.py'], rounds: 1 }] },
      ],
    })
    // The plan's `artifact` prose is repository text and never travels: the
    // fixtures set it to `<id> output` on every edge, so its absence is
    // detectable by searching the serialized artifact for it.
    const serialized = serializePostMortem(report)
    for (const node of ['p1', 'p2', 'p3', 'p4']) {
      expect(serialized).not.toContain(`${node} output`)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. The artifact and its schema
// ---------------------------------------------------------------------------

describe('the artifact', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const SCHEMA_PATH = join(HERE, '..', '..', '..', 'schemas', 'postmortem.v1.schema.json')

  it('matches the committed JSON Schema, byte for byte', () => {
    // The JSON Schema is generated from the zod schema the emitter parses
    // through (`src/postmortem/generate.ts`). Checking the bytes here is what
    // makes "validates against its schema" mean something: the two cannot
    // drift apart without this failing.
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(serializePostMortemSchema())
  })

  it('declares the canonical $schema and every top-level key the schema requires', () => {
    const report = postMortem(cleanTape(), RUN, { integration: [] })
    expect(report.$schema).toBe(
      'https://github.com/vintasoftware/vinta-ai-workflows/schemas/postmortem.v1.schema.json',
    )
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as { required: string[] }
    for (const key of schema.required) expect(report).toHaveProperty(key)
  })

  it('round-trips a golden example through serialize → parse → validate', () => {
    const golden: PostMortem = {
      $schema:
        'https://github.com/vintasoftware/vinta-ai-workflows/schemas/postmortem.v1.schema.json',
      schema_version: 1,
      run_id: 'bookmark-folders-lz4k9',
      workflow_id: 'bookmark-folders',
      plan_ref: 'ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md',
      run: {
        status: 'done',
        started_at_ms: T0,
        ended_at_ms: T0 + 120 * MIN,
        elapsed_ms: 120 * MIN,
        node_count: 5,
        wave_count: 4,
      },
      findings: {
        unused_dependencies: [],
        missing_dependencies: [
          {
            node: 'p3',
            depends_on: 'p2',
            failed_at_ms: T0 + 20 * MIN,
            landed_at_ms: T0 + 25 * MIN,
            passed_at_ms: T0 + 32 * MIN,
          },
        ],
        wave_conflicts: [
          {
            wave: 2,
            nodes: ['p2', 'p3'],
            paths: ['apps/bookmarks/api/views.py'],
            fix_rounds: 2,
          },
        ],
        duration_divergences: [
          {
            node: 'p3',
            wave: 2,
            span_ms: 80 * MIN,
            wave_baseline_ms: 10 * MIN,
            ratio: 8,
            direction: 'longer',
          },
        ],
        critical_path: {
          nodes: [
            { node: 'p1', wave: 1, span_ms: 10 * MIN },
            { node: 'p3', wave: 2, span_ms: 80 * MIN },
          ],
          span_ms: 90 * MIN,
          share_of_elapsed: 0.75,
        },
        idle_capacity: {
          lane_capacity: 2,
          peak_concurrency: 2,
          lane_ms_provisioned: 240 * MIN,
          lane_ms_used: 100 * MIN,
          idle_share: 0.5,
        },
      },
      gaps: [
        {
          kind: 'integration_record_unavailable',
          needs: 'the integrator’s wave results, passed as `options.integration`.',
        },
      ],
    }

    const parsed = parsePostMortem(JSON.parse(serializePostMortem(golden)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.report).toEqual(golden)
  })

  it('refuses a document with an unknown key or a wrong schema_version', () => {
    const report = postMortem(cleanTape(), RUN, { integration: [] })
    expect(parsePostMortem({ ...report, findings_v2: [] }).ok).toBe(false)
    expect(parsePostMortem({ ...report, schema_version: 2 }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. A run that has not finished
// ---------------------------------------------------------------------------

describe('an unfinished run', () => {
  it('is refused, because a partial post-mortem would be read as fact', () => {
    const tape = new Tape(chain()).begin()
    tape.ran('p1', T0 + MIN, T0 + 11 * MIN)
    tape.status(T0 + 12 * MIN, 'p2', 'running')

    expect(() => postMortem(tape, RUN, { integration: [] })).toThrow(RunNotFinishedError)
    expect(() => postMortem(tape, RUN, { integration: [] })).toThrow(RUN)
  })

  it('refuses a log that describes no run at all', () => {
    const empty = new Tape(chain())
    expect(() => postMortem(empty, RUN)).toThrow('no run_started event')
  })
})
