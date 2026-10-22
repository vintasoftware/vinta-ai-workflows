/**
 * Where working time goes, activity by activity (`analytics/activity.ts`).
 *
 * Synthetic journals with chosen timestamps, as `analytics.test.ts` — the
 * assertions are exact durations, and only a tape can promise "this gate ran
 * for exactly forty seconds".
 */
import { describe, expect, it } from 'vitest'
import { collectActivities, type ActivitySource } from '../src/analytics/activity.ts'
import type { NewEvent, NodeStatus, StoredEvent } from '../src/journal/events.ts'
import type { Workflow, WorkflowInput } from '../src/types.ts'
import { parseWorkflow } from '../src/validate.ts'

const RUN = 'run-1'
const T0 = 1_700_000_000_000
const SEC = 1_000

const workflow = (input: Partial<WorkflowInput> = {}): Workflow => {
  const result = parseWorkflow({
    schema_version: 1,
    id: 'activity',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    gates: { unit: { cmd: 'true' } },
    nodes: [
      { id: 'a', name: 'phase a', prompt_ref: 'plan.md#a', gates: ['unit'] },
      { id: 'b', name: 'phase b', prompt_ref: 'plan.md#b', depends_on: [{ node: 'a', artifact: 'a out' }] },
    ],
    ...input,
  } satisfies WorkflowInput)
  if (!result.ok) throw new Error('test workflow fixture is invalid')
  return result.workflow
}

class Tape implements ActivitySource {
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

  begin(ts: number): this {
    this.push(ts, { runId: RUN, type: 'run_started', payload: { workflow_id: 'activity', base_branch: 'main' } })
    for (const [index, node] of this.#workflow.nodes.entries()) {
      this.push(ts, {
        runId: RUN,
        nodeId: node.id,
        type: 'node_registered',
        payload: {
          wave: index + 1,
          harness:
            (node.crew === undefined ? undefined : this.#workflow.crew[node.crew]?.harness) ??
            node.harness ??
            this.#workflow.defaults.harness,
        },
      })
    }
    return this
  }

  status(ts: number, nodeId: string, status: NodeStatus): this {
    return this.push(ts, { runId: RUN, nodeId, type: 'node_status', payload: { status } })
  }

  step(ts: number, nodeId: string, state: string, attempt = 1): this {
    return this.push(ts, { runId: RUN, nodeId, type: 'node_step', payload: { state, attempt } })
  }
}

const of = (tape: Tape, nowMs?: number) =>
  collectActivities(tape, RUN, nowMs === undefined ? {} : { nowMs })

const rows = (tape: Tape, nowMs?: number) =>
  of(tape, nowMs).activities.map((row) => [row.node, row.kind, row.id, row.endedAt === null ? null : row.endedAt - row.startedAt, row.outcome])

describe('pipeline steps', () => {
  it('ends each step at the next, and leaves the last one open on a live run', () => {
    const tape = new Tape(workflow())
      .begin(T0)
      .status(T0, 'a', 'running')
      .step(T0 + 5 * SEC, 'a', 'implement')
      .step(T0 + 65 * SEC, 'a', 'gate')
      .step(T0 + 80 * SEC, 'a', 'review')

    expect(rows(tape, T0 + 100 * SEC)).toEqual([
      ['a', 'step', 'implement', 60 * SEC, null],
      ['a', 'step', 'gate', 15 * SEC, null],
      ['a', 'step', 'review', null, null],
    ])
    const report = of(tape, T0 + 100 * SEC)
    expect(report.partial).toBe(true)
    expect(report.asOfMs).toBe(T0 + 100 * SEC)
    expect(report.elapsedMs).toBe(100 * SEC)
  })

  it("stops a step's clock while the node is parked, and resumes it under the same id", () => {
    const tape = new Tape(workflow())
      .begin(T0)
      .status(T0, 'a', 'running')
      .step(T0, 'a', 'gate')
      .status(T0 + 10 * SEC, 'a', 'awaiting_human')
      .status(T0 + 70 * SEC, 'a', 'running')
      .step(T0 + 90 * SEC, 'a', 'review')
      .status(T0 + 95 * SEC, 'a', 'done')

    expect(rows(tape)).toEqual([
      ['a', 'step', 'gate', 10 * SEC, null],
      ['a', 'step', 'gate', 20 * SEC, null],
      ['a', 'step', 'review', 5 * SEC, null],
    ])
  })

  it('closes whatever was open as interrupted when the run ends or resumes', () => {
    const tape = new Tape(workflow())
      .begin(T0)
      .status(T0, 'a', 'running')
      .step(T0, 'a', 'implement')
      .push(T0 + 30 * SEC, { runId: RUN, nodeId: 'a', type: 'gate_started', payload: { gate: 'unit' } })
      .push(T0 + 40 * SEC, { runId: RUN, type: 'run_resumed', payload: { attempt: 2 } })
      .step(T0 + 41 * SEC, 'a', 'implement', 2)
      .push(T0 + 50 * SEC, { runId: RUN, type: 'run_ended', payload: { status: 'failed' } })

    expect(rows(tape)).toEqual([
      ['a', 'step', 'implement', 40 * SEC, 'interrupted'],
      ['a', 'gate', 'unit', 10 * SEC, 'interrupted'],
      ['a', 'step', 'implement', 9 * SEC, 'interrupted'],
    ])
    const report = of(tape)
    expect(report.partial).toBe(false)
    expect(report.status).toBe('failed')
    expect(report.activities.map((row) => row.attempt)).toEqual([1, 1, 2])
  })
})

describe('gates, chores and integration steps', () => {
  it('times a gate from its start to its verdict, and back-dates a chore by its duration', () => {
    const tape = new Tape(workflow())
      .begin(T0)
      .status(T0, 'a', 'running')
      .step(T0, 'a', 'gate')
      .push(T0 + 1 * SEC, { runId: RUN, nodeId: 'a', type: 'gate_started', payload: { gate: 'unit' } })
      .push(T0 + 41 * SEC, {
        runId: RUN,
        nodeId: 'a',
        type: 'gate_result',
        payload: { gate: 'unit', exit_code: 1, status: 'failed', duration_ms: 40 * SEC, cached: false },
      })
      .step(T0 + 42 * SEC, 'a', 'review')
      .push(T0 + 72 * SEC, {
        runId: RUN,
        nodeId: 'a',
        type: 'chore_result',
        payload: { chore: 'review', status: 'ran', duration_ms: 30 * SEC },
      })

    expect(rows(tape, T0 + 72 * SEC)).toEqual([
      ['a', 'step', 'gate', 42 * SEC, null],
      ['a', 'gate', 'unit', 40 * SEC, 'failed'],
      ['a', 'step', 'review', null, null],
      ['a', 'chore', 'review', 30 * SEC, 'ran'],
    ])
  })

  it('counts a cached verdict as a run of zero length, marked cached', () => {
    const tape = new Tape(workflow()).begin(T0).status(T0, 'a', 'running').push(T0 + 5 * SEC, {
      runId: RUN,
      nodeId: 'a',
      type: 'gate_result',
      payload: { gate: 'unit', exit_code: 0, status: 'passed', duration_ms: 90 * SEC, cached: true },
    })
    const [hit] = of(tape).activities
    expect(hit).toMatchObject({ kind: 'gate', id: 'unit', cached: true, outcome: 'passed' })
    expect(hit?.endedAt).toBe(hit?.startedAt)
  })

  it('pairs integration steps by kind, gate and round, and leaves `hold` out', () => {
    const tape = new Tape(workflow())
      .begin(T0)
      .status(T0, 'b', 'running')
      .step(T0, 'b', 'integrate')
      .push(T0, { runId: RUN, nodeId: 'b', type: 'integration_step', payload: { step: 'hold', state: 'started' } })
      .push(T0 + 1 * SEC, {
        runId: RUN,
        nodeId: 'b',
        type: 'integration_step',
        payload: { step: 'merge', state: 'started', incoming: 'b', branch: 'plan/x/wave-2' },
      })
      .push(T0 + 2 * SEC, {
        runId: RUN,
        nodeId: 'b',
        type: 'integration_step',
        payload: { step: 'verify', state: 'started', gate: 'unit', log: '/l/unit.log' },
      })
      .push(T0 + 22 * SEC, {
        runId: RUN,
        nodeId: 'b',
        type: 'integration_step',
        payload: { step: 'verify', state: 'finished', gate: 'unit', outcome: 'ok' },
      })
      .push(T0 + 23 * SEC, {
        runId: RUN,
        nodeId: 'b',
        type: 'integration_step',
        payload: { step: 'merge', state: 'finished', outcome: 'resolved' },
      })

    expect(rows(tape, T0 + 30 * SEC)).toEqual([
      ['b', 'step', 'integrate', null, null],
      ['b', 'integration', 'merge', 22 * SEC, 'resolved'],
      ['b', 'integration', 'verify', 20 * SEC, 'ok'],
    ])
  })
})

describe('staffing on every row', () => {
  it('tags each activity with the harness, model, crew member and tier in force when it started', () => {
    const wf = workflow({
      crew: { senior: { tier: 1, model: 'opus-big' }, junior: { tier: 3, model: 'haiku', harness: 'codex' } },
      nodes: [
        { id: 'a', name: 'phase a', prompt_ref: 'plan.md#a', crew: 'senior' },
        { id: 'b', name: 'phase b', prompt_ref: 'plan.md#b', crew: 'junior' },
      ],
    })
    const tape = new Tape(wf)
      .begin(T0)
      .push(T0, {
        runId: RUN,
        nodeId: 'a',
        type: 'node_crew',
        payload: { member: 'junior', tier: 3, substitute: true, instead_of: 'senior', planned_tier: 1 },
      })
      .status(T0, 'a', 'running')
      .step(T0, 'a', 'implement')
      .push(T0 + 10 * SEC, {
        runId: RUN,
        nodeId: 'a',
        type: 'node_model_fallback',
        payload: { harness: 'claude-code', from: 'haiku', to: 'sonnet', known: false },
      })
      .step(T0 + 20 * SEC, 'a', 'gate')

    const report = of(tape, T0 + 30 * SEC)
    expect(report.activities.map((row) => [row.id, row.crew, row.tier, row.model, row.harness])).toEqual([
      ['implement', 'junior', 3, 'haiku', 'claude-code'],
      ['gate', 'junior', 3, 'sonnet', 'claude-code'],
    ])
    // The roster: what the plan named, until the run says otherwise.
    expect(report.nodes.map((node) => [node.nodeId, node.crew, node.model, node.harness, node.status])).toEqual([
      ['a', 'junior', 'sonnet', 'claude-code', 'running'],
      ['b', 'junior', 'haiku', 'codex', 'pending'],
    ])
  })
})
