/**
 * One intervention, end to end, against a real journal.
 *
 * The unit tests hold each piece to its own contract. This holds the *seam*:
 * that a threshold firing reaches `amendRun` with the monitor's proposal in
 * it, that the run's snapshot moves, and — the property the whole design rests
 * on — that a proposal outside the monitor's authority changes nothing at all,
 * however the model phrases it.
 *
 * The monitor is a stub returning a string, which is exactly what the real one
 * returns. Nothing here spawns a harness: what is under test is what happens
 * to an answer, not how it was produced.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { intervene } from '../src/intervention/index.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import type { Monitor } from '../src/monitor/monitor.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

const RUN_ID = 'run-1'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function store(): { journal: Journal; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-intervene-'))
  const journal = openJournal(dir)
  cleanups.push(() => {
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { journal, dir }
}

const workflow = (): Workflow =>
  WorkflowSchema.parse({
    schema_version: 1,
    id: 'wf',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    gates: {
      unit: { cmd: 'pytest', timeout_s: 600, tuning: { allowed_flags: ['--reuse-db'] } },
    },
    nodes: [
      { id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit'] },
      { id: 'p2', name: 'Two', prompt_ref: 'plan.md#2', gates: ['unit'] },
    ],
  })

/** A monitor that answers with whatever the test put in its mouth. */
const monitorSaying = (answer: string): Monitor =>
  ({ intervene: async () => answer, model: 'opus' }) as unknown as Monitor

/**
 * A run with an expensive gate: three uncached runs of `unit` at eleven
 * minutes, which is past the ceiling and is the `--reuse-db` shape exactly.
 */
function costlyRun(journal: Journal, wf: Workflow): void {
  journal.createRun(RUN_ID, wf)
  for (const node of ['p1', 'p2', 'p1']) {
    journal.append({
      runId: RUN_ID,
      nodeId: node,
      type: 'gate_result',
      payload: {
        gate: 'unit',
        exit_code: 0,
        status: 'passed',
        duration_ms: 11 * 60_000,
        cached: false,
      },
    })
  }
}

const answer = (changes: unknown[]): string =>
  JSON.stringify({ schema_version: 1, summary: 'the unit gate rebuilds its database', changes })

describe('a run tuning itself', () => {
  it('does nothing when nothing crossed a threshold', async () => {
    const { journal } = store()
    const wf = workflow()
    journal.createRun(RUN_ID, wf)

    // No model turn at all: a monitor that answered here would be a monitor
    // being paid to look at a run nobody asked about.
    const outcome = await intervene({
      journal,
      runId: RUN_ID,
      workflow: wf,
      monitor: monitorSaying('should never be read'),
    })
    expect(outcome.kind).toBe('quiet')
  })

  it('amends the gate command the monitor proposed, and records why', async () => {
    const { journal } = store()
    const wf = workflow()
    costlyRun(journal, wf)

    const outcome = await intervene({
      journal,
      runId: RUN_ID,
      workflow: wf,
      monitor: monitorSaying(
        answer([
          {
            verb: 'retune_gate',
            gate: 'unit',
            cmd: 'pytest --reuse-db',
            evidence: 'each gate log opens with "Creating test database for alias default"',
          },
        ]),
      ),
    })

    expect(outcome.kind).toBe('amended')
    if (outcome.kind !== 'amended') throw new Error(outcome.kind)
    expect(outcome.workflow.gates['unit']?.cmd).toBe('pytest --reuse-db')
    // The durable side moved: this is what the next gate run reads, and what a
    // resume reads.
    expect(journal.readWorkflow(RUN_ID).gates['unit']?.cmd).toBe('pytest --reuse-db')

    // Journalled as the run's own act, with what it touched — which is what
    // the cooldown is folded from.
    const amendment = journal
      .events(RUN_ID)
      .filter((event) => event.type === 'workflow_amended')
      .map((event) => event.payload as { author?: string; targets?: readonly string[] })
    expect(amendment).toEqual([expect.objectContaining({ author: 'monitor', targets: ['gate:unit'] })])
  })

  it('leaves the run untouched when the monitor proposes something it may not', async () => {
    // The property everything else rests on. The model asks for a narrower
    // suite, in well-formed JSON, naming a gate that *is* tunable — and the
    // run does not move.
    const { journal } = store()
    const wf = workflow()
    costlyRun(journal, wf)

    const outcome = await intervene({
      journal,
      runId: RUN_ID,
      workflow: wf,
      monitor: monitorSaying(
        answer([
          {
            verb: 'retune_gate',
            gate: 'unit',
            cmd: 'pytest -k "not slow" --reuse-db',
            evidence: 'the slow tests are the expensive ones',
          },
        ]),
      ),
    })

    expect(outcome.kind).toBe('refused')
    expect(journal.readWorkflow(RUN_ID).gates['unit']?.cmd).toBe('pytest')
    expect(journal.events(RUN_ID).filter((e) => e.type === 'workflow_amended')).toEqual([])
  })

  it('takes “nothing to change” as an answer', async () => {
    const { journal } = store()
    const wf = workflow()
    costlyRun(journal, wf)

    const outcome = await intervene({
      journal,
      runId: RUN_ID,
      workflow: wf,
      monitor: monitorSaying(
        JSON.stringify({
          schema_version: 1,
          summary: 'the suite is genuinely large; nothing here is worth an amendment',
          changes: [],
        }),
      ),
    })

    expect(outcome.kind).toBe('no_change')
    expect(journal.events(RUN_ID).filter((e) => e.type === 'workflow_amended')).toEqual([])
  })

  it('survives an answer that is not JSON at all', async () => {
    const { journal } = store()
    const wf = workflow()
    costlyRun(journal, wf)

    const outcome = await intervene({
      journal,
      runId: RUN_ID,
      workflow: wf,
      monitor: monitorSaying('I had a look and I think the gate is fine, honestly.'),
    })

    expect(outcome.kind).toBe('unreadable')
    expect(journal.readWorkflow(RUN_ID).gates['unit']?.cmd).toBe('pytest')
  })

  it('reads a proposal the model wrapped in a code fence', async () => {
    // Told to reply with JSON and nothing else, a model will sometimes fence
    // it anyway. Losing a correct proposal to two backticks would be a silly
    // way to fail.
    const { journal } = store()
    const wf = workflow()
    costlyRun(journal, wf)

    const outcome = await intervene({
      journal,
      runId: RUN_ID,
      workflow: wf,
      monitor: monitorSaying(
        '```json\n' +
          answer([
            {
              verb: 'retune_gate',
              gate: 'unit',
              cmd: 'pytest --reuse-db',
              evidence: 'the database is rebuilt every run',
            },
          ]) +
          '\n```',
      ),
    })

    expect(outcome.kind).toBe('amended')
  })

  it('stops once the run has spent its budget, without asking the monitor', async () => {
    const { journal, dir } = store()
    const wf = workflow()
    costlyRun(journal, wf)

    let asked = 0
    const counting = {
      model: 'opus',
      intervene: async () => {
        asked += 1
        return answer([])
      },
    } as unknown as Monitor

    for (let i = 0; i < 3; i += 1) {
      journal.append({
        runId: RUN_ID,
        type: 'workflow_amended',
        payload: {
          amendment: i + 1,
          changes: [],
          affected: [],
          applied: [],
          rebased: [],
          superseded: '',
          author: 'monitor',
          targets: [`gate:g${i}`],
        },
      })
    }

    const outcome = await intervene({ journal, runId: RUN_ID, workflow: wf, monitor: counting })
    expect(outcome.kind).toBe('exhausted')
    // The refusal is cheap and comes *before* the model turn: a run that
    // cannot take advice should not pay for any.
    expect(asked).toBe(0)

    const record = readFileSync(
      join(dir, '.vinta-ai-maestro', 'runs', RUN_ID, 'interventions.jsonl'),
      'utf8',
    )
    expect(record).toContain('"kind":"exhausted"')
  })

  it('keeps the monitor’s prose out of the event payloads', async () => {
    // §11. `summary` and `evidence` are a model's words about a repository;
    // they belong in the record beside the run, never in a row the API serves.
    const { journal, dir } = store()
    const wf = workflow()
    costlyRun(journal, wf)

    await intervene({
      journal,
      runId: RUN_ID,
      workflow: wf,
      monitor: monitorSaying(
        answer([
          {
            verb: 'retune_gate',
            gate: 'unit',
            cmd: 'pytest --reuse-db',
            evidence: 'SECRET-FROM-THE-REPO is what the log says',
          },
        ]),
      ),
    })

    const payloads = JSON.stringify(journal.events(RUN_ID).map((event) => event.payload))
    expect(payloads).not.toContain('SECRET-FROM-THE-REPO')
    // Not even the command, which is repository text of its own.
    expect(payloads).not.toContain('pytest')

    const record = readFileSync(
      join(dir, '.vinta-ai-maestro', 'runs', RUN_ID, 'interventions.jsonl'),
      'utf8',
    )
    expect(record).toContain('SECRET-FROM-THE-REPO')
  })
})
