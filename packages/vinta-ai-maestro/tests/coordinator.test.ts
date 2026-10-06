/**
 * The run coordinator: what wakes it, what it may change, and the turn it
 * takes when woken.
 *
 * The monitor it replaced could read a run and propose four kinds of tuning,
 * and an operator found it "sort of useless": it could explain why a phase was
 * stuck and do nothing about it, and nothing woke it when maestro itself
 * failed. These hold the coordinator to the two halves of the redesign: it is
 * woken for trouble (a failure, an error maestro logged, a phase stuck behind
 * the integration worktree), and what it may change is bounded where the
 * change lands (`coordinator/policy.ts`), not in its brief.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createErrorFeed, tapErrors } from '../src/coordinator/errors.ts'
import { startCoordinatorLoop, type CoordinatorLoop } from '../src/coordinator/loop.ts'
import { addedTokens, coordinatorRefusals, tokenize } from '../src/coordinator/policy.ts'
import { triggersFrom, type CoordinatorTrigger } from '../src/coordinator/triggers.ts'
import type { AgentTask, HarnessAdapter, SpawnOutcome } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import type { Logger } from '../src/log/index.ts'
import { Monitor, MonitorUnavailable, runDigest, type RunDigest } from '../src/monitor/monitor.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

const temps: string[] = []
const opened: Journal[] = []
const loops: CoordinatorLoop[] = []

afterEach(() => {
  for (const loop of loops.splice(0)) loop.stop()
  for (const journal of opened.splice(0)) journal.close()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const RUN = 'run-1'
const HOUR = 60 * 60 * 1000

function workflowOf(overrides: Record<string, unknown> = {}): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'coordinated',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase', gates: ['unit'] },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    project: { migrate_cmd: 'true', hooks: 'run', env_files: ['.env'] },
    gates: {
      unit: {
        cmd: 'uv run pytest -n auto',
        timeout_s: 900,
        tuning: { allowed_flags: ['--reuse-db'] },
      },
      lint: { cmd: 'ruff check' },
      taste: { judge: { question: 'Is this idiomatic?', labels: ['yes', 'no'], fail_on: ['no'] } },
    },
    nodes: [
      { id: 'p1', name: 'Schema', prompt_ref: 'plan.md#p1', gates: ['unit', 'lint'] },
      {
        id: 'p2',
        name: 'Filters',
        prompt_ref: 'plan.md#p2',
        depends_on: [{ node: 'p1', artifact: 'the table' }],
        gates: ['unit', 'taste'],
      },
      {
        id: 'p3',
        name: 'Remove the flag',
        prompt_ref: 'plan.md#p3',
        depends_on: [{ node: 'p2', artifact: 'the filters' }],
        deferred: 'until the flag has soaked a week',
      },
    ],
    ...overrides,
  })
}

/** The workflow with `edit` applied to a deep copy of its JSON. */
function edited(workflow: Workflow, edit: (draft: Record<string, any>) => void): Workflow {
  const draft = JSON.parse(JSON.stringify(workflow)) as Record<string, any>
  edit(draft)
  return WorkflowSchema.parse(draft)
}

function journalWith(workflow: Workflow): Journal {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-coordinator-'))
  temps.push(dir)
  const journal = openJournal(dir)
  opened.push(journal)
  journal.createRun(RUN, workflow)
  return journal
}

// ---------------------------------------------------------------------------
// What it may change
// ---------------------------------------------------------------------------

describe('the coordinator’s amendment policy', () => {
  const allowed = (edit: (draft: Record<string, any>) => void): readonly string[] => {
    const before = workflowOf()
    return coordinatorRefusals(before, edited(before, edit)).map((issue) => issue.path.join('.'))
  }

  it('lets it change how the run executes', () => {
    expect(allowed((draft) => {
      draft.nodes[1].model = 'sonnet'
      draft.nodes[1].max_fix_rounds = 6
      draft.gates.unit.timeout_s = 1800
      draft.project.env_files = ['.env', '.env.test']
      draft.resources.lane.capacity = 3
      draft.defaults.wave_gates = 'every'
    })).toEqual([])
  })

  it('lets a gate gain a flag its tuning allows, and nothing else', () => {
    expect(allowed((draft) => {
      draft.gates.unit.cmd = 'uv run pytest -n auto --reuse-db'
    })).toEqual([])
    expect(allowed((draft) => {
      draft.gates.unit.cmd = 'uv run pytest -n auto -k "not slow"'
    })).toEqual(['gates.unit.cmd'])
    // `-n auto` dropped: the same suite, run differently, is a rewrite.
    expect(allowed((draft) => {
      draft.gates.unit.cmd = 'uv run pytest --reuse-db'
    })).toEqual(['gates.unit.cmd'])
    // No `tuning` block at all: not the coordinator's to change.
    expect(allowed((draft) => {
      draft.gates.lint.cmd = 'ruff check --fix'
    })).toEqual(['gates.lint.cmd'])
    expect(allowed((draft) => {
      draft.gates.unit.tuning.allowed_flags = ['--reuse-db', '-x']
    })).toEqual(['gates.unit.tuning'])
  })

  it('refuses every change to what the plan builds', () => {
    expect(allowed((draft) => {
      draft.nodes.push({ id: 'p4', name: 'Extra', prompt_ref: 'plan.md#p4' })
    })).toContain('nodes.p4')
    expect(allowed((draft) => {
      draft.nodes[1].depends_on = []
    })).toContain('nodes.p2')
    expect(allowed((draft) => {
      draft.nodes[0].prompt_ref = 'plan.md#other'
    })).toEqual(['nodes.p1.prompt_ref'])
    // Releasing a soak-gated phase by deleting its condition is the operator's.
    expect(allowed((draft) => {
      delete draft.nodes[2].deferred
    })).toEqual(['nodes.p3.deferred'])
    expect(allowed((draft) => {
      draft.base_branch = 'develop'
    })).toContain('base_branch')
  })

  it('refuses every change that weakens a check', () => {
    expect(allowed((draft) => {
      draft.nodes[0].gates = ['unit']
    })).toEqual(['nodes.p1.gates'])
    expect(allowed((draft) => {
      draft.defaults.gates = []
    })).toEqual(['defaults.gates'])
    expect(allowed((draft) => {
      draft.gates.taste.judge.threshold = 0.99
    })).toEqual(['gates.taste'])
    expect(allowed((draft) => {
      draft.project.hooks = 'skip'
    })).toEqual(['project.hooks'])
    expect(allowed((draft) => {
      draft.defaults.allow_ungated_phases = true
    })).toEqual(['defaults.allow_ungated_phases'])
    expect(allowed((draft) => {
      draft.defaults.wave_gates = 'off'
    })).toEqual(['defaults.wave_gates'])
  })

  it('lets a check get stricter', () => {
    expect(allowed((draft) => {
      draft.nodes[0].gates = ['unit', 'lint', 'taste']
    })).toEqual([])
  })

  it('reads an addition only out of a command it can split', () => {
    expect(tokenize('uv run pytest | tee log')).toBeNull()
    expect(tokenize('pytest "a b" \'\'')).toEqual(['pytest', 'a b', ''])
    expect(addedTokens(['pytest', '-n', 'auto'], ['pytest', '-n', 'auto', '--reuse-db'])).toEqual(['--reuse-db'])
    // Order matters: a flag moved ahead of the subcommand is a rewrite.
    expect(addedTokens(['uv', 'run', 'pytest'], ['uv', 'pytest', 'run'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// What wakes it
// ---------------------------------------------------------------------------

describe('what wakes the coordinator', () => {
  it('reads failures after the cursor only, and thresholds over the whole run', () => {
    const journal = journalWith(workflowOf())
    const t0 = Date.now()
    journal.append({ runId: RUN, nodeId: 'p1', type: 'node_status', payload: { status: 'running' } })
    const seen = journal.events(RUN).at(-1)?.id ?? 0
    journal.append({ runId: RUN, nodeId: 'p1', type: 'node_error', payload: { reason: 'git checkout exited 128', attempt: 1 } })

    const found = triggersFrom(journal.events(RUN), seen, { now: t0 + 2 * HOUR })
    expect(found.map((trigger) => trigger.kind).sort()).toEqual(['attempt_failed', 'phase_elapsed'])
    // Before the cursor, the error is history; the elapsed phase is still news.
    expect(triggersFrom(journal.events(RUN), Number.MAX_SAFE_INTEGER, { now: t0 + 2 * HOUR }).map((t) => t.kind)).toEqual([
      'phase_elapsed',
    ])
  })

  it('wakes for a phase stuck behind the integration worktree, naming the holder', () => {
    // The watch item from a real run: a phase read `running` for 2h40m with no
    // agent process. `node_wait` now says what it waits on; this says it out loud.
    const journal = journalWith(workflowOf())
    const t0 = Date.now()
    journal.append({ runId: RUN, nodeId: 'p2', type: 'node_status', payload: { status: 'running' } })
    journal.append({
      runId: RUN,
      nodeId: 'p2',
      type: 'node_wait',
      payload: { on: 'integration_worktree', state: 'queued', holder: 'p1' },
    })
    const found = triggersFrom(journal.events(RUN), Number.MAX_SAFE_INTEGER, {
      now: t0 + 30 * 60 * 1000,
      phaseThresholdMs: 10 * HOUR,
    })
    expect(found).toEqual([expect.objectContaining({ kind: 'integration_wait', nodeId: 'p2', holder: 'p1' })])
  })
})

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** A coordinator that records what it was woken with. */
function fakeCoordinator(answer: () => Promise<string> = async () => 'looked'): {
  readonly coordinator: Monitor
  readonly wakes: string[]
} {
  const wakes: string[] = []
  const coordinator = {
    wake: async (_digest: RunDigest, lines: string) => {
      wakes.push(lines)
      return await answer()
    },
  } as unknown as Monitor
  return { coordinator, wakes }
}

function loopOver(
  journal: Journal,
  coordinator: Monitor,
  options: { readonly budget?: number; readonly cooldownMs?: number; readonly now?: () => number } = {},
): CoordinatorLoop {
  const loop = startCoordinatorLoop({
    journal,
    runId: RUN,
    workflow: () => journal.readWorkflow(RUN),
    coordinator,
    tickMs: 10 * HOUR,
    cooldownMs: options.cooldownMs ?? 0,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  loops.push(loop)
  return loop
}

const failPhase = (journal: Journal, nodeId: string, reason: string): void => {
  journal.append({ runId: RUN, nodeId, type: 'node_status', payload: { status: 'failed', reason } })
}

const woke = (journal: Journal) =>
  journal.events(RUN).filter((event) => event.type === 'coordinator_woke').map((event) => event.payload)

describe('the coordinator loop', () => {
  it('stays quiet, and spends nothing, while nothing is wrong', async () => {
    const journal = journalWith(workflowOf())
    const { coordinator, wakes } = fakeCoordinator()
    const loop = loopOver(journal, coordinator)
    await expect(loop.tick()).resolves.toEqual({ kind: 'quiet' })
    expect(wakes).toEqual([])
  })

  it('wakes once for a failed phase, and records it', async () => {
    const journal = journalWith(workflowOf())
    const { coordinator, wakes } = fakeCoordinator()
    const loop = loopOver(journal, coordinator)
    failPhase(journal, 'p1', 'gate unit exited 1')

    await expect(loop.tick()).resolves.toMatchObject({ kind: 'answered' })
    expect(wakes).toEqual([expect.stringContaining('phase p1 failed: gate unit exited 1')])
    expect(woke(journal)).toEqual([{ outcome: 'answered', triggers: [{ kind: 'phase_failed', node: 'p1' }] }])

    // Told once.
    await expect(loop.tick()).resolves.toEqual({ kind: 'quiet' })
    expect(wakes).toHaveLength(1)
  })

  it('ignores what happened before it started', async () => {
    const journal = journalWith(workflowOf())
    failPhase(journal, 'p1', 'from the last host')
    const { coordinator, wakes } = fakeCoordinator()
    const loop = loopOver(journal, coordinator)
    await loop.tick()
    expect(wakes).toEqual([])
  })

  it('wakes for an error maestro logged about itself', async () => {
    // The request this exists for: "be called if we get any errors in maestro
    // itself". The tap sits on the job's logger, so nothing needs to be
    // journalled for the coordinator to hear of it.
    const journal = journalWith(workflowOf())
    const { coordinator, wakes } = fakeCoordinator()
    const loop = loopOver(journal, coordinator)
    const feed = createErrorFeed()
    const log = tapErrors(silentLogger(), feed.push)
    log.error('run.provision_failed', { error: 'LanePrepareError', message: 'compose up exited 1' })
    feed.listen((trigger) => loop.notify(trigger))

    await loop.tick()
    expect(wakes).toEqual([expect.stringContaining('maestro logged an error: run.provision_failed: LanePrepareError: compose up exited 1')])
  })

  it('carries what it found through a cool-down rather than dropping it', async () => {
    const journal = journalWith(workflowOf())
    const { coordinator, wakes } = fakeCoordinator()
    let clock = 1_000_000
    const loop = loopOver(journal, coordinator, { cooldownMs: 60_000, now: () => clock })
    failPhase(journal, 'p1', 'first')
    await loop.tick()
    failPhase(journal, 'p2', 'second')
    failPhase(journal, 'p3', 'third')
    await expect(loop.tick()).resolves.toEqual({ kind: 'deferred', pending: 2 })

    clock += 60_000
    await loop.tick()
    // A burst is one wake.
    expect(wakes).toHaveLength(2)
    expect(wakes[1]).toContain('phase p2 failed')
    expect(wakes[1]).toContain('phase p3 failed')
  })

  it('stops waking at its budget, says so on the last wake, and records the rest once', async () => {
    const journal = journalWith(workflowOf())
    const { coordinator, wakes } = fakeCoordinator()
    const loop = loopOver(journal, coordinator, { budget: 1 })
    failPhase(journal, 'p1', 'one')
    await loop.tick()
    expect(wakes[0]).toContain('This is the last time this run will wake you')

    failPhase(journal, 'p2', 'two')
    await expect(loop.tick()).resolves.toMatchObject({ kind: 'budget_spent' })
    failPhase(journal, 'p3', 'three')
    await loop.tick()
    expect(wakes).toHaveLength(1)
    expect(woke(journal).map((payload) => (payload as { outcome: string }).outcome)).toEqual(['answered', 'budget_spent'])
  })

  it('records a coordinator it could not reach, and does not crash the run', async () => {
    const journal = journalWith(workflowOf())
    const { coordinator } = fakeCoordinator(async () => {
      throw new MonitorUnavailable('quota')
    })
    const loop = loopOver(journal, coordinator)
    failPhase(journal, 'p1', 'one')
    await expect(loop.tick()).resolves.toMatchObject({ kind: 'unavailable' })
    expect(woke(journal)).toEqual([expect.objectContaining({ outcome: 'unavailable' })])
  })

  it('does not wake for a run that is no longer running', async () => {
    const journal = journalWith(workflowOf())
    const { coordinator, wakes } = fakeCoordinator()
    const loop = loopOver(journal, coordinator)
    failPhase(journal, 'p1', 'one')
    journal.append({ runId: RUN, type: 'run_ended', payload: { status: 'failed' } })
    await loop.tick()
    expect(wakes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The error tap
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    enabled: () => true,
  }
  return logger
}

describe('the error tap', () => {
  it('tells a repeating error on its 1st, 2nd, 4th and 8th occurrence, and never its own', () => {
    const told: CoordinatorTrigger[] = []
    const log = tapErrors(silentLogger(), (trigger) => told.push(trigger))
    for (let i = 0; i < 9; i += 1) log.child({ nodeId: 'p13' }).error('node.commit_refused', {})
    log.error('coordinator.unavailable', {})
    log.warn('node.slow', {})
    expect(told.map((trigger) => trigger.key)).toEqual([
      'log:node.commit_refused:p13#1',
      'log:node.commit_refused:p13#2',
      'log:node.commit_refused:p13#4',
      'log:node.commit_refused:p13#8',
    ])
  })

  it('keeps what arrived before anything listened', () => {
    const feed = createErrorFeed()
    const log = tapErrors(silentLogger(), feed.push)
    log.error('run.provision_failed', {})
    const told: CoordinatorTrigger[] = []
    feed.listen((trigger) => told.push(trigger))
    expect(told).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

describe('the coordinator’s turn', () => {
  function recorder(delayMs = 0): { adapter: HarnessAdapter; tasks: AgentTask[]; order: string[] } {
    const inner = new MockAdapter({ id: 'claude-code' })
    const tasks: AgentTask[] = []
    const order: string[] = []
    const adapter: HarnessAdapter = {
      id: inner.id,
      capabilities: inner.capabilities,
      preflight: () => inner.preflight(),
      spawn: async (task: AgentTask): Promise<SpawnOutcome> => {
        order.push(`start ${tasks.length}`)
        tasks.push(task)
        await new Promise((done) => setTimeout(done, delayMs))
        const outcome = await inner.spawn(task)
        order.push(`end ${tasks.length - 1}`)
        return outcome
      },
    }
    return { adapter, tasks, order }
  }

  const digestOf = (journal: Journal): RunDigest =>
    runDigest(journal, RUN, journal.readWorkflow(RUN)) as RunDigest

  it('is handed its powers on a live run, and told what it may not do', async () => {
    const journal = journalWith(workflowOf())
    const { adapter, tasks } = recorder()
    const env = { VINTA_AI_MAESTRO_URL: 'http://127.0.0.1:1', VINTA_AI_MAESTRO_TOKEN: 'coordinator', VINTA_AI_MAESTRO_RUN_ID: RUN }
    const monitor = new Monitor({ adapter, model: 'dear', cwd: '/repo', env: () => env })

    await monitor.wake(digestOf(journal), '- phase p1 failed: gate unit exited 1')
    const task = tasks[0] as AgentTask
    expect(task.env).toEqual(env)
    expect(task.prompt).toContain('You are the run coordinator')
    expect(task.prompt).toContain(`vinta-ai-maestro exec ${RUN} <lane|integration> -- <command>`)
    expect(task.prompt).toContain('what you may not do')
    expect(task.prompt).toContain('--- you were woken because ---\n- phase p1 failed: gate unit exited 1')
  })

  it('reads, and only reads, a run that is not live', async () => {
    const journal = journalWith(workflowOf())
    const { adapter, tasks } = recorder()
    const monitor = new Monitor({ adapter, model: 'dear', cwd: '/repo' })
    await monitor.ask(digestOf(journal), 'why did p1 fail?')
    expect(tasks[0]?.env).toBeUndefined()
    expect(tasks[0]?.prompt).toContain('This run is not live')
    expect(tasks[0]?.prompt).not.toContain('vinta-ai-maestro exec')
  })

  it('takes one turn at a time, so a wake-up and a question share one session', async () => {
    const journal = journalWith(workflowOf())
    const { adapter, tasks, order } = recorder(20)
    const monitor = new Monitor({ adapter, model: 'dear', cwd: '/repo' })
    const digest = digestOf(journal)

    await Promise.all([monitor.wake(digest, '- phase p1 failed: x'), monitor.ask(digest, 'what did you do?')])
    expect(order).toEqual(['start 0', 'end 0', 'start 1', 'end 1'])
    expect(tasks[1]?.resumeSessionId).toBe(monitor.session)
  })
})
