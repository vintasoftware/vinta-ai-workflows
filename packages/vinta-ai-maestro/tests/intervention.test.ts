/**
 * The run's ability to tune itself (`docs/monitor-intervention.md`).
 *
 * Four things are under test and they fail in different ways, so they are
 * tested apart:
 *
 * - **The verbs**, as a pure function of a workflow and a proposal. Every
 *   refusal here is a bound on what an unattended agent may do, so each one is
 *   asserted by its code rather than by "it did not apply" — a verb refused for
 *   the wrong reason is a bound that is not doing its job.
 * - **The additive-argv rule**, which is the guard that stands between
 *   `--reuse-db` and `-k not_slow`. Tested against the commands a mis-tuned
 *   gate actually has.
 * - **The watchdog**, against a journal whose timestamps are chosen. A real one
 *   stamps `Date.now()`, so "this phase has been running for ninety minutes"
 *   cannot be expressed in one without waiting ninety minutes.
 * - **The ledger**, against the rows an amendment really writes.
 */
import { describe, expect, it } from 'vitest'

import {
  admit,
  applyIntervention,
  InterventionSchema,
  readLedger,
  targetOf,
  triggers,
  type Intervention,
  type InterventionVerb,
} from '../src/intervention/index.ts'
import { serializeInterventionSchema } from '../src/intervention/schema.ts'
import { allowedVerbs } from '../src/intervention/intervene.ts'
import type { NodeStatus, StoredEvent } from '../src/journal/events.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workflow = (overrides: Partial<Workflow> = {}): Workflow =>
  WorkflowSchema.parse({
    schema_version: 1,
    id: 'wf',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    crew: {
      junior: { role: 'implementer', tier: 1, model: 'haiku' },
      senior: { role: 'implementer', tier: 3, model: 'opus' },
    },
    gates: {
      unit: { cmd: 'pytest', timeout_s: 600, tuning: { allowed_flags: ['--reuse-db', '-n', 'auto'] } },
      lint: { cmd: 'ruff check .', timeout_s: 120 },
    },
    nodes: [
      { id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit'], crew: 'junior' },
      { id: 'p2', name: 'Two', prompt_ref: 'plan.md#2', gates: ['unit', 'lint'] },
    ],
    ...overrides,
  })

const proposal = (changes: readonly InterventionVerb[]): Intervention => ({
  schema_version: 1,
  summary: 'a summary',
  changes: [...changes],
})

const retune = (cmd: string): InterventionVerb => ({
  verb: 'retune_gate',
  gate: 'unit',
  cmd,
  evidence: 'the gate log rebuilds the test database on every run',
})

// ---------------------------------------------------------------------------

describe('what the monitor may change', () => {
  it('adds an allowed flag to a tunable gate', () => {
    const result = applyIntervention(workflow(), proposal([retune('pytest --reuse-db')]))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.workflow.gates['unit']?.cmd).toBe('pytest --reuse-db')
    // Everything else is untouched: this is a gate command, not a plan edit.
    expect(result.workflow.gates['lint']?.cmd).toBe('ruff check .')
    expect(result.workflow.nodes).toEqual(workflow().nodes)
  })

  it('refuses a gate that declares no tuning block', () => {
    const result = applyIntervention(
      workflow(),
      proposal([
        { verb: 'retune_gate', gate: 'lint', cmd: 'ruff check . --fix', evidence: 'slow' },
      ]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    // The default. A gate is not tunable unless a human wrote down that it is.
    expect(result.code).toBe('gate_not_tunable')
  })

  it('refuses a flag the gate did not list, however sensible', () => {
    const result = applyIntervention(workflow(), proposal([retune('pytest --numprocesses=4')]))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('flag_not_allowed')
    // Named, so an operator reading the record can add it rather than diff two
    // commands to work out what was wanted.
    expect(result.issues[0]?.message).toContain('--numprocesses=4')
  })

  it('refuses a command that rewrites the suite, even using an allowed flag', () => {
    // The failure this rule exists for. `--reuse-db` is on the list; the
    // proposal smuggles a selection change past it, and a rule that only
    // checked the additions would accept a gate that no longer proves
    // anything.
    const result = applyIntervention(
      workflow(),
      proposal([retune('pytest -k not_slow --reuse-db')]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('flag_not_allowed')
  })

  it('refuses a command that drops an existing token', () => {
    const wf = workflow({
      gates: {
        unit: {
          cmd: 'pytest tests/unit --strict-markers',
          requires: [],
          timeout_s: 600,
          tuning: { allowed_flags: ['--reuse-db'] },
        },
      },
    })
    const result = applyIntervention(
      wf,
      proposal([retune('pytest tests/unit --reuse-db')]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('command_not_additive')
  })

  it('refuses a command it cannot read as argv at all', () => {
    const wf = workflow({
      gates: {
        unit: {
          cmd: 'pytest && ruff check .',
          requires: [],
          timeout_s: 600,
          tuning: { allowed_flags: ['--reuse-db'] },
        },
      },
    })
    const result = applyIntervention(wf, proposal([retune('pytest --reuse-db && ruff check .')]))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    // "The old tokens plus new ones" says nothing true about a shell program,
    // so a gate that is one is simply not tunable.
    expect(result.code).toBe('command_unparseable')
  })

  it('keeps a quoted argument together', () => {
    const wf = workflow({
      gates: {
        unit: {
          cmd: 'pytest -m "not slow"',
          requires: [],
          timeout_s: 600,
          tuning: { allowed_flags: ['--reuse-db'] },
        },
      },
    })
    const result = applyIntervention(wf, proposal([retune('pytest -m "not slow" --reuse-db')]))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.workflow.gates['unit']?.cmd).toBe('pytest -m "not slow" --reuse-db')
  })

  it('refuses a model that is not on the run’s roster', () => {
    const result = applyIntervention(
      workflow(),
      proposal([{ verb: 'retier_phase', node: 'p1', model: 'gpt-9', evidence: 'struggling' }]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('model_not_on_roster')
  })

  it('moves a phase off its crew member when it retiers it', () => {
    // `crew` carries a model of its own and is mutually exclusive with `model`,
    // so a phase that keeps both would have two sources of truth for the one
    // question the verb exists to answer.
    const result = applyIntervention(
      workflow(),
      proposal([{ verb: 'retier_phase', node: 'p1', model: 'opus', evidence: 'tier too junior' }]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.workflow.nodes[0]?.model).toBe('opus')
    expect(result.workflow.nodes[0]?.crew).toBeUndefined()
    // And it still parses: a verb that produced an invalid workflow would be
    // refused by `amendRun` much later, with a worse message.
    expect(() => WorkflowSchema.parse(result.workflow)).not.toThrow()
  })

  it('applies the good verbs of a mixed proposal and reports the rest', () => {
    // Partial application. One hallucinated gate id must not discard a correct
    // change, because nothing is in the loop to be told to try again.
    const result = applyIntervention(
      workflow(),
      proposal([
        retune('pytest --reuse-db'),
        { verb: 'retime_gate', gate: 'nope', timeout_s: 900, evidence: 'times out' },
      ]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.applied).toHaveLength(1)
    expect(result.refused[0]?.refusal.code).toBe('unknown_gate')
    expect(result.workflow.gates['unit']?.cmd).toBe('pytest --reuse-db')
  })

  it('refuses a proposal that would change nothing', () => {
    const result = applyIntervention(workflow(), proposal([retune('pytest')]))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('no_effect')
  })
})

describe('what the monitor is told it may change', () => {
  it('names the tunable gates and their flags, and the roster', () => {
    const text = allowedVerbs(workflow())
    expect(text).toContain('unit: may ADD `--reuse-db`')
    expect(text).toContain('`haiku`, `opus`')
    // `lint` has no tuning block, so it is not offered.
    expect(text).not.toContain('lint: may ADD')
  })

  it('says plainly when no gate is tunable at all', () => {
    // A monitor told it may retune gates on a run where none may be retuned
    // spends a turn producing a proposal that was always going to be refused.
    const wf = workflow({ gates: { lint: { cmd: 'ruff check .', requires: [], timeout_s: 120 } } })
    expect(allowedVerbs(wf)).toContain('`retune_gate` is NOT available on this run')
  })
})

// ---------------------------------------------------------------------------

describe('when a run is worth waking the monitor about', () => {
  const at = (ts: number, event: Partial<StoredEvent>): StoredEvent =>
    ({ id: ts, ts, runId: 'r', nodeId: null, ...event }) as StoredEvent

  const status = (ts: number, nodeId: string, s: NodeStatus): StoredEvent =>
    at(ts, { nodeId, type: 'node_status', payload: { status: s } })

  const gate = (
    ts: number,
    nodeId: string,
    id: string,
    durationMs: number,
    cached = false,
  ): StoredEvent =>
    at(ts, {
      nodeId,
      type: 'gate_result',
      payload: { gate: id, exit_code: 0, status: 'passed', duration_ms: durationMs, cached },
    })

  it('fires for a phase past its threshold, and not before', () => {
    const events = [status(0, 'p1', 'running')]
    expect(triggers(events, { now: 59 * 60_000 })).toEqual([])

    const found = triggers(events, { now: 61 * 60_000 })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'phase_elapsed', nodeId: 'p1' })
  })

  it('restarts the clock when a phase is retried', () => {
    // A node on its second attempt has been running for as long as *that*
    // attempt. Counting from the first would fire on a phase that has been
    // going for ten minutes.
    const events = [
      status(0, 'p1', 'running'),
      status(50 * 60_000, 'p1', 'failed'),
      status(55 * 60_000, 'p1', 'running'),
    ]
    expect(triggers(events, { now: 70 * 60_000 })).toEqual([])
  })

  it('does not fire for a phase parked on a human', () => {
    // A parked node is burning nothing, and the question it is parked on is
    // not one an amendment can answer.
    const events = [status(0, 'p1', 'running'), status(10 * 60_000, 'p1', 'awaiting_human')]
    expect(triggers(events, { now: 300 * 60_000 })).toEqual([])
  })

  it('adds a gate’s cost across every phase that ran it', () => {
    // The trigger the feature exists for. No single phase is slow — the gate is
    // wasteful in every lane at once, and only the sum says so.
    const events = [
      gate(1, 'p1', 'unit', 11 * 60_000),
      gate(2, 'p2', 'unit', 11 * 60_000),
      gate(3, 'p3', 'unit', 11 * 60_000),
    ]
    const found = triggers(events, { now: 10 * 60_000 })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'gate_cost', gateId: 'unit', observedMs: 33 * 60_000 })
  })

  it('does not count a cache hit toward a gate’s cost', () => {
    // A hit reports the duration of the run that filled the cache. Counting it
    // again would make a cache *raise* the cost it saved.
    const events = [
      gate(1, 'p1', 'unit', 20 * 60_000),
      gate(2, 'p2', 'unit', 20 * 60_000, true),
      gate(3, 'p3', 'unit', 20 * 60_000, true),
    ]
    expect(triggers(events, { now: 0 })).toEqual([])
  })

  it('ignores a gate result written before durations existed', () => {
    // Unmeasured is not free: reading a missing duration as zero would report
    // an old run's gates as costing nothing.
    //
    // `duration_ms` and `cached` are required on the payload *type*, so this
    // row cannot be built through it — and that is exactly why the cast is
    // here rather than the test being deleted. The journal is JSON on disk and
    // holds rows written before either field existed; a fold that trusted the
    // type would read `undefined` as a number on any run that predates them.
    const events = [
      at(1, {
        nodeId: 'p1',
        type: 'gate_result',
        payload: { gate: 'unit', exit_code: 0, status: 'passed' },
      } as unknown as Partial<StoredEvent>),
    ]
    expect(triggers(events, { now: 0 })).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('the anti-thrash ledger', () => {
  const amended = (targets: readonly string[], author = 'monitor'): StoredEvent =>
    ({
      id: 1,
      ts: 1,
      runId: 'r',
      type: 'workflow_amended',
      payload: { amendment: 1, changes: [], affected: [], applied: [], rebased: [], superseded: '', author, targets },
    }) as unknown as StoredEvent

  const journalOf = (events: readonly StoredEvent[]) =>
    ({ events: () => events }) as unknown as Parameters<typeof readLedger>[0]

  it('does not count an operator’s amendment against the run’s budget', () => {
    const ledger = readLedger(journalOf([amended([], 'operator')]), 'r')
    expect(ledger.spent).toBe(0)
  })

  it('refuses a second change to a target it already changed', () => {
    const ledger = readLedger(journalOf([amended(['gate:unit'])]), 'r')
    const verdict = admit(ledger, [retune('pytest --reuse-db')])
    expect(verdict.allowed).toEqual([])
    expect(verdict.held[0]?.code).toBe('target_already_changed')
  })

  it('holds the second of two verbs targeting one gate in a single proposal', () => {
    // Same oscillation, one hour earlier. The monitor cannot see whether its
    // first change to this gate helped, inside one proposal or across two.
    const verdict = admit(readLedger(journalOf([]), 'r'), [
      retune('pytest --reuse-db'),
      { verb: 'retime_gate', gate: 'unit', timeout_s: 900, evidence: 'slow' },
    ])
    expect(verdict.allowed).toHaveLength(1)
    expect(verdict.held[0]?.code).toBe('target_already_changed')
  })

  it('stops entirely once the budget is spent', () => {
    const history = [amended(['gate:a']), amended(['gate:b']), amended(['gate:c'])]
    const verdict = admit(readLedger(journalOf(history), 'r'), [retune('pytest --reuse-db')])
    expect(verdict.allowed).toEqual([])
    expect(verdict.held[0]?.code).toBe('budget_spent')
  })

  it('keys a verb on what it is about', () => {
    expect(targetOf(retune('pytest --reuse-db'))).toBe('gate:unit')
    expect(
      targetOf({ verb: 'rebudget_fixes', node: 'p1', max_fix_rounds: 4, evidence: 'progress' }),
    ).toBe('node:p1')
  })
})

// ---------------------------------------------------------------------------

describe('the intervention schema', () => {
  it('matches the committed JSON Schema', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const committed = readFileSync(join(root, 'schemas', 'intervention.v1.schema.json'), 'utf8')
    expect(committed).toBe(serializeInterventionSchema())
  })

  it('refuses a verb with no evidence', () => {
    const parsed = InterventionSchema.safeParse({
      schema_version: 1,
      summary: 'x',
      changes: [{ verb: 'retune_gate', gate: 'unit', cmd: 'pytest --reuse-db' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts a proposal that changes nothing', () => {
    // The expected outcome most of the time, and it has to be expressible or
    // the monitor invents a change to justify having been woken.
    const parsed = InterventionSchema.safeParse({
      schema_version: 1,
      summary: 'phase 3 is slow because its work is genuinely large; nothing to tune',
      changes: [],
    })
    expect(parsed.success).toBe(true)
  })

  it('cannot express a change to what a phase builds', () => {
    for (const verb of [
      { verb: 'repoint_phase', node: 'p1', prompt_ref: 'plan.md#other', evidence: 'x' },
      { verb: 'add_dependency', node: 'p2', on: 'p1', evidence: 'x' },
    ]) {
      const parsed = InterventionSchema.safeParse({
        schema_version: 1,
        summary: 'x',
        changes: [verb],
      })
      expect(parsed.success).toBe(false)
    }
  })
})
