/**
 * The run's spokesperson.
 *
 * Two things are worth holding it to, and neither is "the model gave a good
 * answer" — that is a test about a model's mood.
 *
 * The **digest** is one: it is assembled from the journal by pure code, and
 * what it includes decides what the monitor can possibly know. These assert the
 * facts it must carry (a failure reason, a pending question, the refusals that
 * explain a dead phase) and the bound that keeps it from becoming the run.
 *
 * The **conversation** is the other: that a second question resumes rather than
 * re-reads, and that a forgotten session is recovered rather than surfaced.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentTask, HarnessAdapter, SpawnOutcome } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import {
  MONITOR_NODE,
  Monitor,
  MonitorUnavailable,
  describe as describeRun,
  monitorModel,
  runDigest,
} from '../src/monitor/monitor.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

const temps: string[] = []
const opened: Journal[] = []

/**
 * Close before removing, and that order is not tidiness.
 *
 * The journal is SQLite, and Windows will not delete a file that is still open,
 * where POSIX shrugs and drops the directory entry. A test that leaks an open
 * handle passes on two platforms and fails on the third with `EBUSY` — an error
 * that says nothing about the journal and everything about the teardown.
 */
afterEach(() => {
  for (const journal of opened.splice(0)) journal.close()
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

const HARNESS = 'claude-code'
const RUN = 'run-1'

function workflowOf(crew: Record<string, unknown> = {}): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'test-flow',
    base_branch: 'main',
    ...(Object.keys(crew).length === 0 ? {} : { crew }),
    defaults: { harness: HARNESS, model: 'opus', pipeline: 'solo' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    gates: {},
    nodes: [
      {
        id: 'p0',
        name: 'Schema',
        harness: HARNESS,
        prompt_ref: 'plan.md#p0',
        depends_on: [],
        gates: [],
      },
      {
        id: 'p1',
        name: 'Filters',
        harness: HARNESS,
        prompt_ref: 'plan.md#p1',
        depends_on: [],
        gates: [],
      },
    ],
    pipelines: {
      solo: {
        states: [
          { id: 'work', name: 'Work', position: { x: 0, y: 0 }, onEnter: [] },
          { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
        ],
        transitions: [{ id: 't', from: 'work', to: 'done' }],
        initialStateIds: ['work'],
        finalStateIds: ['done'],
      },
    },
  })
}

function journalWith(workflow: Workflow): Journal {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-monitor-'))
  temps.push(dir)
  const journal = openJournal(dir)
  opened.push(journal)
  journal.createRun(RUN, workflow)
  return journal
}

describe('the digest', () => {
  it('carries why a phase failed, as the scheduler recorded it', () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    journal.append({
      runId: RUN,
      nodeId: 'p1',
      type: 'node_status',
      payload: { status: 'failed', reason: 'pipeline ended in state "failed"' },
    })

    const digest = runDigest(journal, RUN, workflow)

    expect(digest?.nodes.find((node) => node.nodeId === 'p1')?.failure).toBe(
      'pipeline ended in state "failed"',
    )
    expect(digest?.nodes.find((node) => node.nodeId === 'p0')?.failure).toBeNull()
  })

  /**
   * The case the monitor exists for. A phase refused sixty-nine shell commands
   * fails at a gate, and the gate is not the reason — these lines are.
   */
  it('carries the refusals that explain a dead phase, with their sentences', () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    journal.appendTranscript(RUN, 'p1', { type: 'tool_use', name: 'Bash', id: 't1', input: {} })
    journal.appendTranscript(RUN, 'p1', {
      type: 'permission_denied',
      tool: 'Bash',
      reason: 'subcommandResults',
      detail: 'This Bash command contains multiple operations. The following parts require approval',
    })

    const digest = runDigest(journal, RUN, workflow)

    expect(digest?.nodes.find((node) => node.nodeId === 'p1')?.trouble).toEqual([
      'refused Bash: This Bash command contains multiple operations. The following parts require approval',
    ])
  })

  it('carries the question a parked phase is waiting on', () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    journal.append({
      runId: RUN,
      nodeId: 'p0',
      type: 'human_question',
      payload: { question: 'Two migrations landed. Ship the branch?', kind: 'confirm', effect_id: 'e1' },
    })

    const digest = runDigest(journal, RUN, workflow)

    expect(digest?.nodes.find((node) => node.nodeId === 'p0')?.question).toBe(
      'Two migrations landed. Ship the branch?',
    )
  })

  /**
   * The bound that keeps the monitor's cost a function of the operator's
   * curiosity rather than of the run's length. A phase that refused a hundred
   * commands must not produce a hundred-line digest.
   */
  it('keeps a long run’s digest the size of a short one’s', () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    for (let i = 0; i < 100; i += 1) {
      journal.appendTranscript(RUN, 'p1', {
        type: 'permission_denied',
        tool: 'Bash',
        reason: 'other',
        detail: `refusal ${i}`,
      })
    }
    journal.appendTranscript(RUN, 'p1', { type: 'assistant_text', text: 'x'.repeat(5_000) })

    const node = runDigest(journal, RUN, workflow)?.nodes.find((n) => n.nodeId === 'p1')

    expect(node?.trouble).toHaveLength(6)
    // The newest, because those are the ones that ended the turn.
    expect(node?.trouble.at(-1)).toContain('refusal 99')
    expect(node?.lastWord?.length).toBeLessThanOrEqual(600)
  })

  it('is nothing at all for a run the journal has never heard of', () => {
    expect(runDigest(journalWith(workflowOf()), 'no-such-run', workflowOf())).toBeNull()
  })

  it('reads as prose, naming each phase and its state', () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    const digest = runDigest(journal, RUN, workflow)

    const text = describeRun(digest as NonNullable<typeof digest>)
    expect(text).toContain('p0 — Schema')
    expect(text).toContain('p1 — Filters')
  })
})

describe('which model it thinks with', () => {
  /** The dearest tier on the roster: this is read by a person making a decision. */
  it('takes the highest tier on the crew', () => {
    expect(
      monitorModel(
        workflowOf({
          tier1: { role: 'implementer', tier: 1, model: 'cheap' },
          tier4: { role: 'implementer', tier: 4, model: 'dear' },
        }),
      ),
    ).toBe('dear')
  })

  it('falls back to the plan’s default when there is no crew', () => {
    expect(monitorModel(workflowOf())).toBe('opus')
  })
})

describe('the conversation', () => {
  /** Records what each spawn was asked, so a resume is observable. */
  function recorder(): { adapter: HarnessAdapter; tasks: AgentTask[] } {
    const inner = new MockAdapter({ id: HARNESS })
    const tasks: AgentTask[] = []
    const adapter: HarnessAdapter = {
      id: inner.id,
      capabilities: inner.capabilities,
      preflight: () => inner.preflight(),
      spawn: async (task: AgentTask): Promise<SpawnOutcome> => {
        tasks.push(task)
        return await inner.spawn(task)
      },
    }
    return { adapter, tasks }
  }

  it('answers in the agent’s own words', async () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    const { adapter } = recorder()
    const monitor = new Monitor({ adapter, model: 'dear', cwd: '/repo' })

    const answer = await monitor.ask(
      runDigest(journal, RUN, workflow) as NonNullable<ReturnType<typeof runDigest>>,
      'why did p1 fail?',
    )

    // The mock's own script, joined: the monitor returns what the agent said
    // and nothing it added itself.
    expect(answer).toBe('reading the phase brief\ndone')
  })

  /**
   * A second question resumes: the first paid for the brief and the digest, and
   * paying again for both is the cost this design exists to avoid (§15).
   * The current digest still travels, because the run moves while the operator
   * reads and a confident answer from stale state is worse than "I don't know".
   */
  it('resumes rather than starting over, and re-states the run each time', async () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    const { adapter, tasks } = recorder()
    const monitor = new Monitor({ adapter, model: 'dear', cwd: '/repo' })
    const digest = runDigest(journal, RUN, workflow) as NonNullable<ReturnType<typeof runDigest>>

    await monitor.ask(digest, 'what is happening?')
    await monitor.ask(digest, 'and now?')

    expect(tasks).toHaveLength(2)
    expect(tasks[0]?.resumeSessionId).toBeUndefined()
    expect(tasks[1]?.resumeSessionId).toBe(monitor.session)
    // The brief is paid for once; the state is re-stated every time.
    expect(tasks[0]?.prompt).toContain('You are the technical project manager')
    expect(tasks[1]?.prompt).not.toContain('You are the technical project manager')
    expect(tasks[1]?.prompt).toContain('p1 — Filters')
  })

  /**
   * A vendor that has forgotten the conversation is not an error worth showing
   * an operator: the question is still answerable, cold, for the price of a
   * digest.
   */
  it('recovers from a session the harness has forgotten', async () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    const inner = new MockAdapter({ id: HARNESS })
    const carried: (string | undefined)[] = []
    // Refuses exactly one resume, then behaves. That is the shape of a vendor
    // that has expired a conversation the operator still wants to have.
    let refusedOnce = false
    const adapter: HarnessAdapter = {
      id: inner.id,
      capabilities: inner.capabilities,
      preflight: () => inner.preflight(),
      spawn: async (task: AgentTask): Promise<SpawnOutcome> => {
        carried.push(task.resumeSessionId)
        if (task.resumeSessionId !== undefined && !refusedOnce) {
          refusedOnce = true
          return { ok: false, kind: 'stale_session', message: 'no conversation found' }
        }
        return await inner.spawn(task)
      },
    }
    const monitor = new Monitor({ adapter, model: 'dear', cwd: '/repo' })
    const digest = runDigest(journal, RUN, workflow) as NonNullable<ReturnType<typeof runDigest>>

    await monitor.ask(digest, 'first')
    const answer = await monitor.ask(digest, 'second')

    // Cold, refused resume, cold again — and the operator sees an answer.
    expect(carried).toEqual([undefined, expect.any(String), undefined])
    expect(answer).toBe('reading the phase brief\ndone')
  })

  /** A harness that will not start is a refusal kind, never a vendor's prose (§11). */
  it('raises a kind and nothing else when the harness refuses', async () => {
    const workflow = workflowOf()
    const journal = journalWith(workflow)
    const adapter = new MockAdapter({ id: HARNESS, spawns: ['quota'] })
    const monitor = new Monitor({ adapter, model: 'dear', cwd: '/repo' })

    await expect(
      monitor.ask(
        runDigest(journal, RUN, workflow) as NonNullable<ReturnType<typeof runDigest>>,
        'why?',
      ),
    ).rejects.toBeInstanceOf(MonitorUnavailable)
  })
})

/**
 * The reserved id is a *directory name*, and that was a Windows bug for as long
 * as the conversation has existed.
 *
 * It was `monitor:conversation` — a colon, chosen because no phase id may
 * contain one. But the id becomes
 * `<journal>/runs/<run>/nodes/<MONITOR_NODE>`, and on Windows a colon is the
 * drive and alternate-stream separator: `mkdir` fails with `ENOENT`, so every
 * question threw on its first append and the endpoint reported the monitor
 * unavailable. It had never worked there and could not have.
 *
 * What hid it for so long is that a colon is perfectly legal in a macOS or
 * Linux filename, so a round-trip test passes on every machine this was
 * developed on. That is why this asserts the *characters* rather than writing a
 * file: a test that only fails on one platform is a test that fails in CI,
 * after the fact, for somebody else.
 */
describe('the reserved node id', () => {
  it('is a legal directory name on every platform', () => {
    // The set Windows forbids outright, plus the control characters.
    // eslint-disable-next-line no-control-regex
    expect(MONITOR_NODE).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/)
    // And nothing that needs quoting or trips a shell glob.
    expect(MONITOR_NODE).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('cannot collide with a phase, which is why it is reserved at all', () => {
    // Node ids are lowercase kebab-case (`types.ts`), so one that does not
    // begin with a letter or a digit is not merely unused but unrepresentable.
    const asNodeId = WorkflowSchema.safeParse({
      id: 'w',
      version: 1,
      base_branch: 'main',
      nodes: [{ id: MONITOR_NODE, name: 'n', prompt_ref: 'p.md#1' }],
    })
    expect(asNodeId.success).toBe(false)
  })
})
