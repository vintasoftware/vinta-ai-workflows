/**
 * Cost and token accounting (§13.7).
 *
 * The interesting cases are all about *not* adding things up wrongly: one
 * session's cumulative usage counted once however many times it appears, a
 * node's several turns counted separately, and a cost total that never claims
 * to be whole when a harness reporting tokens only was part of the run.
 *
 * The source is faked rather than driven through a real journal: these are
 * assertions about a fold, and a fake keeps them from failing for SQLite's
 * reasons. `tests/journal.test.ts` owns the round-trip through a real file.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournal } from '../src/journal/journal.ts'
import type { AgentEvent } from '../src/harness/adapter.ts'
import {
  collectNodeUsage,
  collectRunUsage,
  sumTotals,
  type RunUsage,
  type UsageSource,
  type UsageTotals,
} from '../src/usage/usage.ts'
import type { Workflow, WorkflowInput } from '../src/types.ts'
import { parseWorkflow } from '../src/validate.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workflow = (nodes: WorkflowInput['nodes']): Workflow => {
  const result = parseWorkflow({
    schema_version: 1,
    id: 'accounting',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    nodes,
  } satisfies WorkflowInput)
  if (!result.ok) throw new Error('test workflow fixture is invalid')
  return result.workflow
}

const phase = (id: string, extra: Partial<WorkflowInput['nodes'][number]> = {}) => ({
  id,
  name: `phase ${id}`,
  prompt_ref: `plan.md#${id}`,
  ...extra,
})

const session = (
  sessionId: string,
  input: number,
  output: number,
  costUsd?: number,
): AgentEvent[] => [
  { type: 'session_started', sessionId },
  { type: 'assistant_text', text: 'work happened' },
  { type: 'usage', input, output, ...(costUsd === undefined ? {} : { costUsd }) },
  { type: 'session_ended', result: 'ok' },
]

const nodeTotals = (run: RunUsage, nodeId: string): UsageTotals => {
  const node = run.nodes.find((n) => n.nodeId === nodeId)
  if (!node) throw new Error(`node ${nodeId} missing from run usage`)
  return node.totals
}

/** A `UsageSource` over in-memory transcripts. Nodes with no entry never ran. */
const fake = (wf: Workflow, transcripts: Record<string, AgentEvent[]>): UsageSource => ({
  readWorkflow: () => wf,
  tailTranscript: (_runId, nodeId) => transcripts[nodeId] ?? [],
})

// ---------------------------------------------------------------------------

describe('usage accounting', () => {
  it('sums a node across its sessions, and counts one session once', () => {
    const wf = workflow([phase('p1')])
    const source = fake(wf, {
      p1: [
        ...session('s1', 1000, 100, 0.5),
        ...session('s2', 2000, 200, 0.25),
        ...session('s3', 4000, 400, 0.25),
      ],
    })

    const { totals } = collectNodeUsage(source, 'r1', 'p1')
    expect(totals.sessions).toBe(3)
    expect(totals.inputTokens).toBe(7000)
    expect(totals.outputTokens).toBe(700)
    expect(totals.cost).toEqual({ status: 'complete', usd: 1, reportedSessions: 3 })
  })

  it('never adds two usage events from one session — the last wins, and it says so', () => {
    const wf = workflow([phase('p1')])
    const source = fake(wf, {
      p1: [
        { type: 'session_started', sessionId: 's1' },
        // A cumulative total, then the same session's final one. Adding these
        // would report 4500 input for a session that used 3000.
        { type: 'usage', input: 1500, output: 150, costUsd: 0.5 },
        { type: 'usage', input: 3000, output: 300, costUsd: 0.9 },
        { type: 'session_ended', result: 'ok' },
      ],
    })

    const { totals, anomalies } = collectNodeUsage(source, 'r1', 'p1')
    expect(totals.sessions).toBe(1)
    expect(totals.inputTokens).toBe(3000)
    expect(totals.outputTokens).toBe(300)
    expect(totals.cost).toEqual({ status: 'complete', usd: 0.9, reportedSessions: 1 })
    expect(anomalies).toEqual([
      { kind: 'duplicate_session_usage', nodeId: 'p1', sessionId: 's1', count: 2 },
    ])
  })

  it('run totals equal the sum of node totals, and waves partition the run', () => {
    const wf = workflow([
      phase('p1'),
      phase('p2', { depends_on: [{ node: 'p1', artifact: 'the model' }] }),
      phase('p3', { depends_on: [{ node: 'p1', artifact: 'the model' }] }),
      phase('p4', {
        depends_on: [
          { node: 'p2', artifact: 'the endpoint' },
          { node: 'p3', artifact: 'the form' },
        ],
      }),
    ])
    const source = fake(wf, {
      p1: session('a', 100, 10, 0.1),
      p2: [...session('b', 200, 20, 0.2), ...session('c', 300, 30, 0.3)],
      p3: session('d', 400, 40, 0.4),
      p4: session('e', 500, 50, 0.5),
    })

    const run = collectRunUsage(source, 'r1')

    expect(run.totals.inputTokens).toBe(1500)
    expect(run.totals.outputTokens).toBe(150)
    expect(run.totals.sessions).toBe(5)
    expect(run.totals).toEqual(sumTotals(run.nodes.map((n) => n.totals)))

    expect(run.waves.map((w) => w.wave)).toEqual([1, 2, 3])
    expect(run.waves.map((w) => w.nodeIds)).toEqual([['p1'], ['p2', 'p3'], ['p4']])
    expect(run.waves.map((w) => w.totals.inputTokens)).toEqual([100, 900, 500])
    expect(sumTotals(run.waves.map((w) => w.totals))).toEqual(run.totals)

    // Every node accounted for exactly once by the wave partition.
    expect(run.waves.flatMap((w) => w.nodeIds).sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('marks cost unreported — distinctly from a reported zero — when a harness omits it', () => {
    const wf = workflow([phase('silent', { harness: 'codex' }), phase('free')])
    const source = fake(wf, {
      // codex reports tokens only.
      silent: session('s1', 900, 90),
      // A harness that did report, and reported nothing spent.
      free: session('s2', 900, 90, 0),
    })

    const run = collectRunUsage(source, 'r1')
    const silent = nodeTotals(run, 'silent')
    const free = nodeTotals(run, 'free')

    // Tokens are still counted; only the cost is unknown.
    expect(silent.inputTokens).toBe(900)
    expect(silent.cost).toEqual({ status: 'unreported', missingSessions: 1 })
    expect(free.cost).toEqual({ status: 'complete', usd: 0, reportedSessions: 1 })

    // The distinction survives into the type: an unreported total has no
    // number to read at all, while a genuine zero does.
    expect(silent.cost.status === 'complete' ? silent.cost.usd : null).toBeNull()
    expect(free.cost.status === 'complete' ? free.cost.usd : null).toBe(0)
    expect(silent.cost).not.toHaveProperty('usd')
  })

  it('flags a mixed run as partial rather than presenting a floor as the total', () => {
    const wf = workflow([
      phase('a'),
      phase('b', { harness: 'codex', depends_on: [{ node: 'a', artifact: 'the model' }] }),
    ])
    const source = fake(wf, {
      a: session('s1', 1000, 100, 2.5),
      b: session('s2', 1000, 100),
    })

    const run = collectRunUsage(source, 'r1')
    expect(run.totals.cost).toEqual({
      status: 'partial',
      usdSoFar: 2.5,
      reportedSessions: 1,
      missingSessions: 1,
    })
    // The floor is not exposed under the name a complete total uses, so a
    // caller cannot print it as the whole figure by accident.
    expect(run.totals.cost).not.toHaveProperty('usd')

    // Each harness on its own is unambiguous; only the mix is partial.
    expect(run.byHarness['claude-code']?.cost).toEqual({
      status: 'complete',
      usd: 2.5,
      reportedSessions: 1,
    })
    expect(run.byHarness['codex']?.cost).toEqual({ status: 'unreported', missingSessions: 1 })

    // And the partial status propagates through further aggregation.
    expect(sumTotals(run.nodes.map((n) => n.totals))).toEqual(run.totals)
  })

  it('reports zeroes for a node that never ran and a run with no usage at all', () => {
    const wf = workflow([phase('ran'), phase('never')])
    const source = fake(wf, { ran: [{ type: 'session_started', sessionId: 's1' }] })

    const run = collectRunUsage(source, 'r1')
    const zero = {
      inputTokens: 0,
      outputTokens: 0,
      sessions: 0,
      cost: { status: 'unreported', missingSessions: 0 },
    }
    expect(run.nodes.find((n) => n.nodeId === 'never')?.totals).toEqual(zero)
    expect(run.totals).toEqual(zero)
    expect(run.anomalies).toEqual([])
    expect(() => collectNodeUsage(source, 'r1', 'never')).not.toThrow()
    expect(collectNodeUsage(source, 'r1', 'never').totals).toEqual(zero)
  })

  it('breaks a multi-model run down by model', () => {
    const wf = workflow([
      phase('cheap', { model: 'haiku' }),
      phase('mid', { model: 'sonnet', depends_on: [{ node: 'cheap', artifact: 'the model' }] }),
      phase('deep', { depends_on: [{ node: 'cheap', artifact: 'the model' }] }), // defaults.model
    ])
    const source = fake(wf, {
      cheap: session('s1', 100, 10, 0.01),
      mid: [...session('s2', 200, 20, 0.2), ...session('s3', 300, 30, 0.3)],
      deep: session('s4', 400, 40, 4),
    })

    const run = collectRunUsage(source, 'r1')
    expect(Object.keys(run.byModel).sort()).toEqual(['haiku', 'opus', 'sonnet'])
    expect(run.byModel['haiku']?.inputTokens).toBe(100)
    expect(run.byModel['sonnet']).toMatchObject({
      inputTokens: 500,
      sessions: 2,
      cost: { status: 'complete', usd: 0.5, reportedSessions: 2 },
    })
    expect(run.byModel['opus']?.inputTokens).toBe(400)
    expect(sumTotals(Object.values(run.byModel))).toEqual(run.totals)

    // A wave's breakdown covers only that wave's nodes.
    expect(Object.keys(run.waves[0]?.byModel ?? {})).toEqual(['haiku'])
    expect(Object.keys(run.waves[1]?.byModel ?? {}).sort()).toEqual(['opus', 'sonnet'])
  })

  it('counts usage that arrives with no session started, without folding it together', () => {
    const wf = workflow([phase('p1')])
    const source = fake(wf, {
      p1: [
        { type: 'usage', input: 10, output: 1 },
        { type: 'usage', input: 20, output: 2 },
      ],
    })

    const { totals, anomalies } = collectNodeUsage(source, 'r1', 'p1')
    expect(totals.sessions).toBe(2)
    expect(totals.inputTokens).toBe(30)
    expect(anomalies).toEqual([{ kind: 'usage_without_session', nodeId: 'p1', count: 2 }])
  })
})

describe('usage accounting over a real journal', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads a whole transcript back off disk, past tailTranscript’s default window', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'vinta-flow-usage-'))
    dirs.push(projectDir)
    const journal = openJournal(projectDir)
    try {
      const wf = workflow([phase('p1')])
      journal.createRun('r1', wf)

      // More than the 100-entry default tail, so a naive read would miss the
      // first session's usage entirely.
      for (const event of session('s1', 1000, 100, 0.5)) {
        journal.appendTranscript('r1', 'p1', event)
      }
      for (let i = 0; i < 400; i += 1) {
        journal.appendTranscript('r1', 'p1', {
          type: 'tool_use',
          name: 'Read',
          input: {},
          id: `t${i}`,
        } satisfies AgentEvent)
      }
      for (const event of session('s2', 2000, 200, 0.25)) {
        journal.appendTranscript('r1', 'p1', event)
      }

      const run = collectRunUsage(journal, 'r1')
      expect(run.totals.sessions).toBe(2)
      expect(run.totals.inputTokens).toBe(3000)
      expect(run.totals.cost).toEqual({ status: 'complete', usd: 0.75, reportedSessions: 2 })
    } finally {
      journal.close()
    }
  })
})
