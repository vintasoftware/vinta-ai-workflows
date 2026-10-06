/**
 * The production `EffectExecutor`, against real git repositories in temp
 * directories and `MockAdapter`.
 *
 * The headline is the first test: the shipped `standard-phase` pipeline, driven
 * by the real scheduler over the golden workflow's graph, with gates that
 * actually execute — the end-to-end run the package had no coverage for. Every
 * existing pipeline test drove a hand-written one-turn machine, which is how
 * `standard-phase` reached a release with nothing supplying `review.verdict` or
 * `gate.exit_code`.
 *
 * Topology is asserted against git itself — `merge-base --is-ancestor`, parent
 * counts, `git show <branch>:<path>` — rather than against the branch names the
 * code chose. `gh` is never on the path these tests take: every `Integrator`
 * here is built with a `ghPath` that does not exist, so `open_pr` exercises its
 * degraded branch and nothing reaches a remote.
 *
 * Every git command below runs against a fresh temp repository. Nothing here
 * touches the repository the suite runs in.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdmissionControl } from '../src/admission/admission.ts'
import {
  createOsNotifier,
  createRunExecutor,
  notificationBody,
  trackingDir,
  trackingPath,
  type ExecutorLane,
  type Notification,
  type Notifier,
  type RunEffectExecutor,
} from '../src/executor/index.ts'
import { GateCache } from '../src/gates/cache.ts'
import type {
  AgentSession,
  AgentTask,
  HarnessAdapter,
  HarnessCapabilities,
  PreflightResult,
  SpawnOutcome,
} from '../src/harness/adapter.ts'
import { DEFAULT_SCRIPT, MockAdapter, type MockScript } from '../src/harness/mock.ts'
import { VERDICT_MARKER } from '../src/prompts/index.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import type { EffectInvocation, EffectOutcome } from '../src/pipeline/effects.ts'
import { Integrator } from '../src/integration/integrator.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import { createScheduler, type RunReport } from '../src/scheduler/index.ts'
import { SideEffectSchema, WorkflowSchema, type EffectId, type Workflow } from '../src/types.ts'
import type { SystemOne } from '../src/system-one/config.ts'
import { MockSystemOneAdapter } from '../src/system-one/mock.ts'
import { renderGate } from './support/gate-script.ts'

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = []

afterEach(() => {
  // Databases first, then the directories holding them: on failure as on success.
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** stderr piped rather than inherited: git narrates every worktree add. */
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const RUN_ID = 'run-1'

/**
 * The budget for a test that drives a whole run, matching the one `within`
 * already promises those tests.
 *
 * The two disagreed. Seven tests here wrap their run in `within(60_000, …)` so
 * that a hang is reported as *which await hung* rather than as a generic
 * timeout — and all but one of them then ran under Vitest's 5s default, where
 * the runner kills the test first and the named message can never appear. The
 * helper's whole reason for existing was unreachable on two of three platforms.
 *
 * Wide on purpose. It is not a performance budget; it is the line past which
 * "slow" becomes "stuck", and these suites spawn real processes, create real
 * git worktrees and run real gates.
 *
 * Kept after `vitest.config.ts` raised the default for every platform, because
 * this is longer than that default and says so deliberately: `within(60_000, …)`
 * has to be the thing that fires, not the runner.
 */
const REAL_RUN_TIMEOUT_MS = 60_000

/** A reviewer that states a verdict the executor can read back out of the transcript. */
const PASSING: MockScript = {
  events: [{ type: 'assistant_text', text: 'VERDICT: pass' }],
  result: 'ok',
}

/**
 * A `MockAdapter` whose script is chosen per spawn, out of the prompt the task
 * carries.
 *
 * Every adapter in this suite replays the same words whatever it is told, which
 * is how prompt composition could be missing entirely and every test still
 * pass. This one lets a test behave like an agent that actually read what it
 * was handed.
 */
class ScriptedAdapter implements HarnessAdapter {
  readonly spawned: AgentTask[] = []
  readonly capabilities: HarnessCapabilities
  #sessions = 0

  constructor(
    readonly id: string,
    private readonly script: (task: AgentTask) => MockScript,
  ) {
    this.capabilities = new MockAdapter({ id }).capabilities
  }

  async preflight(): Promise<PreflightResult> {
    return { installed: true, authenticated: true, version: 'scripted' }
  }

  async spawn(task: AgentTask): Promise<SpawnOutcome> {
    this.spawned.push(task)
    const outcome = await new MockAdapter({ id: this.id, script: this.script(task) }).spawn(task)
    if (!outcome.ok) return outcome
    // Choosing the script per spawn means a *new* `MockAdapter` per spawn,
    // which restarts its session counter — so without this every cold session
    // in this file is handed the same id. That is invisible until §15, and then
    // it is worse than a missing test: "the reviewer is not inside the
    // implementer's session" would pass on two distinct sessions that merely
    // share a name. No real harness reissues an id, and neither does this.
    const id = task.resumeSessionId ?? `${this.id}-session-${(this.#sessions += 1)}`
    return { ok: true, session: renamed(outcome.session, id) }
  }
}

/**
 * The same session under a caller-chosen id, `session_started` included — the
 * event is what the scheduler records, so renaming only the handle would leave
 * the ledger holding the id this wrapper was built to replace.
 */
function renamed(session: AgentSession, id: string): AgentSession {
  return {
    id,
    events: {
      async *[Symbol.asyncIterator]() {
        for await (const event of session.events) {
          yield event.type === 'session_started' ? { ...event, sessionId: id } : event
        }
      },
    },
    send: (text) => session.send(text),
    interrupt: () => session.interrupt(),
    kill: () => session.kill(),
  }
}

interface Rig {
  readonly root: string
  readonly repo: string
  readonly integ: string
  readonly laneRoot: string
  readonly lanes: readonly ExecutorLane[]
  readonly workflow: Workflow
  readonly journal: Journal
  readonly executor: RunEffectExecutor
  /** The one the executor was given — amended in the §9 tests, as the host does. */
  readonly integrator: Integrator
  readonly pools: ResourcePools
  readonly adapters: Readonly<Record<string, ScriptedAdapter>>
  readonly notifications: Notification[]
  run(): Promise<RunReport>
  /** One effect, invoked directly — for the verbs no pipeline path exercises. */
  invoke(
    nodeId: string,
    verb: EffectId,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<EffectOutcome>
}

/**
 * One markdown section per node, in the file its `prompt_ref` names — the
 * minimum shape `resolveBrief` reads. The body is distinctive per node so a
 * test can assert *which* brief reached *which* agent.
 */
function writePlan(repo: string, workflow: Workflow): void {
  const files = new Map<string, string[]>()
  for (const node of workflow.nodes) {
    const hash = node.prompt_ref.lastIndexOf('#')
    const file = hash === -1 ? node.prompt_ref : node.prompt_ref.slice(0, hash)
    const anchor = hash === -1 ? 'phase' : node.prompt_ref.slice(hash + 1)
    const body = files.get(file) ?? []
    body.push(`## ${anchor}`, '', `Phase brief for ${node.id}: build the ${node.id} thing.`, '')
    files.set(file, body)
  }
  for (const [file, body] of files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), `${body.join('\n')}\n`)
  }
}

function setup(
  build: (root: string) => Workflow,
  options: {
    readonly script?: MockScript
    /** Answers out of the task's prompt — an agent that read what it was told. */
    readonly reply?: (task: AgentTask) => MockScript
    readonly cache?: boolean
    /**
     * `--retry-after`, for a run that reaches a question with an unattended
     * answer — `standard-phase`'s exhausted budget answers itself `stop` (§16.5).
     */
    readonly retryAfterMs?: number
    /** The operator's classifier (§17). */
    readonly systemOne?: SystemOne
  } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-executor-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const workflow = build(root)

  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-b', workflow.base_branch)
  g(repo, 'config', 'user.email', 'fixture@example.invalid')
  g(repo, 'config', 'user.name', 'fixture')
  g(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  // The plan every `prompt_ref` points at, committed on the base branch so it
  // is in every lane. Prompt composition resolves the brief out of the lane
  // (`src/prompts`), so a repository with no plan in it is a run whose agents
  // are handed a bare reference — which is the bug this file now covers.
  writePlan(repo, workflow)
  g(repo, 'add', '--all')
  g(repo, 'commit', '-m', 'base')

  // The dedicated integration worktree, detached so `base_branch` stays checked
  // out in the main checkout exactly as a real `LanePool` leaves it.
  const integ = join(root, 'integ')
  g(repo, 'worktree', 'add', '--detach', integ, workflow.base_branch)

  // Lane worktrees, named the way `LanePool` names them — which is the same
  // way the scheduler names the slots it hands out.
  const laneRoot = join(root, 'lanes')
  const lanes: ExecutorLane[] = []
  for (let i = 1; i <= (workflow.resources['lane']?.capacity ?? 1); i += 1) {
    const name = `${RUN_ID}-lane-${i}`
    const path = join(laneRoot, name)
    g(repo, 'worktree', 'add', '--detach', path, workflow.base_branch)
    lanes.push({ name, path, env: {} })
  }

  // Outside the repo: the journal's own store must not move any lane's tree hash.
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  const journal = openJournal(state)
  cleanups.push(() => journal.close())
  journal.createRun(RUN_ID, workflow)

  const integrator = new Integrator({
    plan: workflow,
    integrationPath: integ,
    fixer: { fix: async () => undefined },
    // Never a real `gh`, and never a real remote.
    ghPath: join(root, 'no-such-gh'),
  })

  let cache: GateCache | undefined
  if (options.cache === true) {
    cache = new GateCache(state)
    const open = cache
    cleanups.push(() => open.close())
  }

  const notifications: Notification[] = []
  const notifier: Notifier = {
    notify: async (notification) => {
      notifications.push(notification)
      return true
    },
  }

  const executor = createRunExecutor({
    workflow,
    runId: RUN_ID,
    journal,
    integrator,
    integrationPath: integ,
    laneRoot,
    lanes,
    notifier,
    ...(cache === undefined ? {} : { cache }),
    ...(options.systemOne === undefined ? {} : { systemOne: options.systemOne }),
  })

  const harnesses = new Set<string>([workflow.defaults.harness])
  for (const node of workflow.nodes) if (node.harness) harnesses.add(node.harness)
  // `reply` answers out of the prompt; `script` is the same words every turn.
  const reply = options.reply ?? ((): MockScript => options.script ?? DEFAULT_SCRIPT)
  const adapters = Object.fromEntries(
    [...harnesses].map((id) => [id, new ScriptedAdapter(id, reply)]),
  )

  const pools = new ResourcePools(workflow.resources)

  return {
    integrator,
    root,
    repo,
    integ,
    laneRoot,
    lanes,
    workflow,
    journal,
    executor,
    pools,
    adapters,
    notifications,
    async run(): Promise<RunReport> {
      const admission = new AdmissionControl({
        journal,
        runId: RUN_ID,
        ceilings: Object.fromEntries([...harnesses].map((id) => [id, 100])),
      })
      try {
        return await createScheduler({
          workflow,
          runId: RUN_ID,
          journal,
          // These drive the *executor* through a real scheduler, and the two
          // that assert about a failure are about what a final failure does —
          // not about the recovery policy in front of it. Production defaults
          // to `retry`, which would silently make them assert the second
          // attempt (`scheduler.test.ts` covers that default).
          onFailure: 'stop',
          pools,
          admission,
          adapters: adapters as Readonly<Record<string, HarnessAdapter>>,
          executor,
          laneRoot,
          ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
        }).run()
      } finally {
        admission.close()
      }
    },
    async invoke(nodeId, verb, params = {}) {
      const invocation: EffectInvocation = {
        effect: SideEffectSchema.parse({ id: `e-${verb.replace(/_/g, '-')}`, definitionId: verb, params }),
        origin: { kind: 'onEnter', stateId: 'direct' },
        context: { node: { id: nodeId } },
      }
      return await executor.execute(invocation)
    },
  }
}

/** The golden workflow's graph, on the pipeline the package actually ships. */
const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/golden-workflow.json'), 'utf8'),
) as Record<string, unknown>

/**
 * The fixture declares its own `standard-phase`, and a declared id shadows a
 * built-in of the same name. That copy is a *schema* fixture — its states carry
 * almost no effects — so dropping it is what makes this the shipped pipeline's
 * test rather than the fixture's. The gates are re-pointed at commands that
 * cost milliseconds; everything else is the fixture verbatim.
 */
function goldenWorkflow(
  gates: Readonly<Record<string, unknown>>,
  chores: Readonly<Record<string, unknown>> = {},
): Workflow {
  const { pipelines: _shadowed, ...rest } = GOLDEN
  return WorkflowSchema.parse({
    ...rest,
    gates,
    chores,
    defaults: { ...(rest['defaults'] as object), chores: Object.keys(chores) },
  })
}

/** The phase review every plan `plan-feature` writes carries, minus the skill. */
const REVIEW_CHORE = { review: { prompt: 'Review this phase’s diff.', when: 'review' } }

const branchOf = (workflow: Workflow, nodeId: string): string =>
  `plan/${workflow.id}/phase-${nodeId}`

const waveBranch = (workflow: Workflow, wave: number): string => `plan/${workflow.id}/wave-${wave}`

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** Fails loudly rather than leaning on the suite timeout. */
async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not terminate`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 1. The clean run the project was missing
// ---------------------------------------------------------------------------

describe('the shipped standard-phase, end to end', () => {
  it('drives the golden workflow’s graph to done, gates and all', async () => {
    const rig = setup(
      () =>
        goldenWorkflow({
          types: { cmd: 'exit 0', timeout_s: 30 },
          unit: { cmd: 'exit 0', requires: ['test-suite'], timeout_s: 30 },
        }),
      { script: PASSING },
    )

    const report = await within(60_000, rig.run(), 'the clean run')

    expect(report.status).toBe('completed')
    expect(report.failures).toEqual({})
    expect(report.statuses).toEqual({ p1: 'done', p2: 'done', p3: 'done', p4: 'done' })

    // The gates actually executed: the runner streams to the journal's path,
    // and only a real child process creates it.
    for (const [nodeId, gates] of [
      ['p1', ['types', 'unit']],
      ['p2', ['types', 'unit']],
      ['p3', ['types', 'unit']],
      ['p4', ['types']],
    ] as const) {
      for (const gateId of gates) {
        expect(
          existsSync(join(rig.journal.root, 'runs', RUN_ID, 'nodes', nodeId, 'gates', `${gateId}.log`)),
        ).toBe(true)
      }
    }

    // Topology, asked of git. Dependency-derived bases, then the wave spine.
    const { workflow, repo } = rig
    expect(isAncestor(repo, branchOf(workflow, 'p1'), branchOf(workflow, 'p2'))).toBe(true)
    expect(isAncestor(repo, branchOf(workflow, 'p1'), branchOf(workflow, 'p3'))).toBe(true)
    expect(isAncestor(repo, branchOf(workflow, 'p2'), branchOf(workflow, 'p4'))).toBe(true)
    expect(isAncestor(repo, branchOf(workflow, 'p3'), branchOf(workflow, 'p4'))).toBe(true)
    for (const [wave, nodes] of [
      [1, ['p1']],
      [2, ['p2', 'p3']],
      [3, ['p4']],
    ] as const) {
      for (const nodeId of nodes) {
        expect(isAncestor(repo, branchOf(workflow, nodeId), waveBranch(workflow, wave))).toBe(true)
      }
    }

    // Phase tracking rode its own branch all the way into the final wave — the
    // lane owns that one path and no other writer touches it, which is what
    // makes the wave merges clean, and it only gets there because `integrate`
    // writes it *before* the merge.
    const dir = trackingDir(workflow)
    for (const nodeId of ['p1', 'p2', 'p3', 'p4']) {
      const shown = g(repo, 'show', `${waveBranch(workflow, 3)}:${dir}/phase-${nodeId}.md`)
      expect(shown).toContain(`# Phase ${nodeId}`)
      // Identifiers only: no agent narration, no diff, no gate output.
      expect(shown).not.toContain('VERDICT')
    }

    // No lease outlived the run.
    for (const name of Object.keys(workflow.resources)) {
      expect([name, rig.pools.held(name)]).toEqual([name, 0])
    }
    expect(rig.pools.waiting).toBe(0)
    // Real git worktrees, real gate processes: ~1.5s alone, but it sits close
    // to vitest's 5s default and times out when the machine is loaded.
  })
}, REAL_RUN_TIMEOUT_MS)

// ---------------------------------------------------------------------------
// 2–3. The fix loop
// ---------------------------------------------------------------------------

/**
 * Red the first time it runs, green every time after, by leaving a marker file.
 *
 * The two shells agree on nothing here — `test -f` against `if exist`, `touch`
 * against `copy nul`, `exit` against `exit /b`. `copy` rather than the usual
 * `type nul >` because the marker only has to exist; its contents are never
 * read, and `copy` keeps the command free of a redirect.
 */
const flipOnceGate = (marker: string): string =>
  process.platform === 'win32'
    ? `if exist "${marker}" (exit /b 0) else (copy /y nul "${marker}" & exit /b 1)`
    : `test -f '${marker}' && exit 0; touch '${marker}'; exit 1`

describe('the fix loop', () => {
  /** One node, one gate whose result flips once a marker file exists. */
  const flakyGate = (root: string, maxFixRounds: number): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'fixloop',
      base_branch: 'main',
      resources: { lane: { capacity: 1, kind: 'worktree' } },
      chores: REVIEW_CHORE,
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase', chores: ['review'] },
      gates: {
        unit: {
          // The marker lives outside every lane, so flipping it does not move a
          // tree hash. Rendered per platform for `noisyGate`'s reason: the
          // POSIX form is three commands separated by `;`, which `cmd.exe`
          // reads as one.
          cmd: flipOnceGate(join(root, 'green')),
          timeout_s: 30,
        },
      },
      nodes: [
        {
          id: 'p1',
          name: 'One',
          prompt_ref: 'plan.md#phase-1',
          gates: ['unit'],
          max_fix_rounds: maxFixRounds,
        },
        {
          id: 'p2',
          name: 'Two',
          prompt_ref: 'plan.md#phase-2',
          depends_on: [{ node: 'p1', artifact: 'the thing p1 built' }],
        },
      ],
    })

  /** Which turn a task was, read off the prompt it was handed. */
  const turnOf = (task: AgentTask): string =>
    task.prompt.includes(VERDICT_MARKER)
      ? 'review'
      : task.prompt.includes('You are fixing') || task.prompt.includes('## How to fix')
        ? 'fixer'
        : 'implementer'

  it('red gate → fix → green gate → review → done', async () => {
    const rig = setup((root) => flakyGate(root, 2), { script: PASSING })
    const report = await within(60_000, rig.run(), 'the fix loop')

    expect(report.statuses['p1']).toBe('done')
    expect(report.statuses['p2']).toBe('done')
    // The review waits for a green gate: it never reads code that does not pass.
    const p1 = (rig.adapters['claude-code']?.spawned ?? []).filter((task) => task.nodeId === 'p1')
    expect(p1.map(turnOf)).toEqual(['implementer', 'fixer', 'review'])
  })

  it('continues the implementer’s session for the fixer and the review, with a delta', async () => {
    // §15 end to end, with real worktrees and a real git history — the one
    // place the two halves of the feature are checked *together*. Resuming a
    // session while re-sending the whole brief wastes the saving; sending a
    // delta into a session that was never opened asks an agent to fix a gate
    // against work it has never seen. Either half alone passes its own unit
    // tests.
    const rig = setup((root) => flakyGate(root, 2), { script: PASSING })
    await within(60_000, rig.run(), 'the fix loop')

    const [implement, fix, review] = (rig.adapters['claude-code']?.spawned ?? []).filter(
      (task) => task.nodeId === 'p1',
    )

    expect(implement?.resumeSessionId).toBeUndefined()
    // Both continue `main` — the session that wrote the code.
    expect(fix?.resumeSessionId).toBeDefined()
    expect(review?.resumeSessionId).toBeDefined()

    // And the prompts match the sessions. A continuation says so in as many
    // words and carries no brief; the cold prompt that opened the slot does.
    expect(fix?.prompt).toContain('same session')
    expect(review?.prompt).toContain('same session')
    expect(implement?.prompt).not.toContain('same session')
    expect(implement?.prompt).toContain('## Your tasks')
    expect(fix?.prompt).not.toContain('## Your tasks')
    expect(fix?.prompt).not.toContain('## The phase this branch is implementing')

    // The one thing a review continuation may never drop: without it the
    // executor reads no verdict and the phase goes to the operator (§15.3).
    expect(review?.prompt).toContain(VERDICT_MARKER)
  })

  it('gates and reviews the last fix rather than failing the phase unchecked', async () => {
    // `fix` used to go straight to `failed` once the budget was up, so the
    // final fixer's work was never checked at all. Two phases in one run ended
    // on a fixer reporting "all gates green, committed, tree clean" and were
    // failed anyway.
    //
    // Here the gate flips green exactly once, on the attempt the old pipeline
    // never reached: the first gate is red, the fixer spends the only round,
    // and what happens next is the whole question.
    const rig = setup((root) => flakyGate(root, 1), { script: PASSING })

    const report = await within(60_000, rig.run(), 'the fix loop')

    expect(report.statuses['p1']).toBe('done')
    const p1 = (rig.adapters['claude-code']?.spawned ?? []).filter((task) => task.nodeId === 'p1')
    expect(p1.map(turnOf)).toEqual(['implementer', 'fixer', 'review'])
  })

  it('exhausted fix rounds fail the node and block its dependents', async () => {
    const rig = setup(
      (root) => {
        const workflow = flakyGate(root, 1)
        // Never green: the marker the flaky gate flips is never reached.
        return WorkflowSchema.parse({
          ...workflow,
          gates: { unit: { cmd: 'exit 1', timeout_s: 30 } },
        })
      },
      // Nobody is at the exhausted-budget question, so it takes its unattended
      // answer — `stop` — once the window passes, exactly as an exhausted
      // budget failed the phase before the question existed.
      { script: PASSING, retryAfterMs: 10 },
    )
    const report = await within(60_000, rig.run(), 'the exhausted fix loop')

    expect(report.statuses['p1']).toBe('failed')
    expect(report.statuses['p2']).toBe('blocked')
    // The exhausted-budget question notifies as any question does, and then
    // `standard-phase`'s `failed` state does — identifiers and fixed reasons.
    expect(rig.notifications).toEqual([
      { scope: 'node', id: 'p1', reason: 'waiting for the operator' },
      { scope: 'node', id: 'p1', reason: 'phase failed' },
    ])
  })
}, REAL_RUN_TIMEOUT_MS)

// ---------------------------------------------------------------------------
// §16: the verdict a review chore's turn states
// ---------------------------------------------------------------------------

describe('the review verdict', () => {
  const onePhase = (): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'verdict',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 1, kind: 'worktree' } },
      nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1' }],
    })

  /** One finished turn in the transcript, ending on `text`. */
  const turn = (rig: Rig, text: string, result = 'ok'): void => {
    rig.journal.appendTranscript(RUN_ID, 'p1', { type: 'assistant_text', text })
    rig.journal.appendTranscript(RUN_ID, 'p1', { type: 'session_ended', result })
  }

  const spawn = (rig: Rig, params: Record<string, unknown>) =>
    rig.executor.execute({
      effect: SideEffectSchema.parse({ id: 'e-spawn', definitionId: 'spawn_agent', params }),
      origin: { kind: 'onEnter', stateId: 'direct' },
      context: { node: { id: 'p1' } },
    })

  it('reads the verdict a review turn ended on', async () => {
    const rig = setup(onePhase)
    turn(rig, `Approved after two passes.\n${VERDICT_MARKER} pass`)
    expect((await spawn(rig, { role: 'chore', verdict: true })).facts).toEqual({
      review: { verdict: 'pass' },
    })

    turn(rig, `One blocker left.\n${VERDICT_MARKER} fail`)
    expect((await spawn(rig, { role: 'chore', verdict: true })).facts).toEqual({
      review: { verdict: 'fail' },
    })
  })

  it('fails closed on a review turn that stated nothing, or one that errored', async () => {
    const rig = setup(onePhase)
    turn(rig, 'Looks good to me.')
    expect((await spawn(rig, { role: 'chore', verdict: true })).facts).toEqual({
      review: { verdict: 'fail' },
    })

    turn(rig, `${VERDICT_MARKER} pass`, 'error')
    expect((await spawn(rig, { role: 'chore', verdict: true })).facts).toEqual({
      review: { verdict: 'fail' },
    })
  })

  it('states nothing for a turn that was not asked for a verdict', async () => {
    const rig = setup(onePhase)
    turn(rig, `${VERDICT_MARKER} pass`)

    expect((await spawn(rig, { role: 'chore' })).facts).toBeUndefined()
    expect((await spawn(rig, { role: 'fixer' })).facts).toBeUndefined()
  })
}, REAL_RUN_TIMEOUT_MS)

// ---------------------------------------------------------------------------
// 4. run_gate does not double-acquire
// ---------------------------------------------------------------------------

describe('gate pools', () => {
  it('completes with the gate pool at capacity 1 rather than self-deadlocking', async () => {
    const rig = setup(
      () =>
        WorkflowSchema.parse({
          schema_version: 1,
          id: 'onepool',
          base_branch: 'main',
          defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
          resources: {
            lane: { capacity: 2, kind: 'worktree' },
            'test-suite': { capacity: 1, kind: 'semaphore' },
          },
          gates: { unit: { cmd: 'exit 0', requires: ['test-suite'], timeout_s: 30 } },
          nodes: [
            { id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit'] },
            { id: 'p2', name: 'Two', prompt_ref: 'plan.md#2', gates: ['unit'] },
          ],
        }),
      { script: PASSING },
    )

    // The scheduler holds `test-suite` across the whole `run_gate` effect. An
    // executor that reached for `runGate` — which acquires it again — would
    // never resolve this. Asserted with an explicit deadline, not a suite timeout.
    const report = await within(30_000, rig.run(), 'the capacity-1 gate run')
    expect(report.statuses).toEqual({ p1: 'done', p2: 'done' })
  })
}, REAL_RUN_TIMEOUT_MS)

// ---------------------------------------------------------------------------
// 5. Gate caching
// ---------------------------------------------------------------------------

describe('gate caching', () => {
  it('skips a second identical gate on an unchanged tree', async () => {
    const counter = 'counter'
    const rig = setup(
      (root) =>
        WorkflowSchema.parse({
          schema_version: 1,
          id: 'cached',
          base_branch: 'main',
          defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
          resources: { lane: { capacity: 1, kind: 'worktree' } },
          // Counts runs outside the lane, so counting does not move the tree hash.
          gates: { unit: { cmd: `echo ran >> ${join(root, counter)}`, timeout_s: 30 } },
          nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit'] }],
        }),
      { cache: true },
    )

    const lane = rig.lanes[0] as ExecutorLane
    rig.journal.append({
      runId: RUN_ID,
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: lane.name },
    })

    const first = await rig.invoke('p1', 'run_gate')
    expect(first.facts?.gate?.['exit_code']).toBe(0)
    expect(first.facts?.gate?.['cached']).toBe(false)

    const second = await rig.invoke('p1', 'run_gate')
    expect(second.facts?.gate?.['exit_code']).toBe(0)
    expect(second.facts?.gate?.['cached']).toBe(true)

    // The gate command ran exactly once: the hit skipped the runner entirely.
    expect(readFileSync(join(rig.root, counter), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  /**
   * A gate that leaves one named marker behind and nothing else.
   *
   * `node -e` rather than a shell line, for `tests/support/gate-script.ts`'s
   * reason: the two shells share no redirection syntax, and what this fixture
   * has to say is only *which* command ran.
   */
  const marker = (path: string): string =>
    `node -e "require('fs').writeFileSync(${JSON.stringify(path).replaceAll('"', "'")}, 'ran')"`

  it('runs the amended command after adopt, and does not serve the old verdict', async () => {
    // §9's amend can move `gates[id].cmd` under a live run. Three objects read
    // that command and the executor is the one that runs it, so an amendment
    // that stopped at the scheduler moved the snapshot, the journal and the
    // pool reservations while the gate went on running the old line.
    const before = 'ran-before'
    const after = 'ran-after'
    const rig = setup(
      (root) =>
        WorkflowSchema.parse({
          schema_version: 1,
          id: 'adopted',
          base_branch: 'main',
          defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
          resources: { lane: { capacity: 1, kind: 'worktree' } },
          // The marker lands outside the lane, so it cannot move the tree hash
          // and turn this into a test about the tree rather than the command.
          gates: { unit: { cmd: marker(join(root, before)), timeout_s: 30 } },
          nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit'] }],
        }),
      { cache: true },
    )

    const lane = rig.lanes[0] as ExecutorLane
    rig.journal.append({
      runId: RUN_ID,
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: lane.name },
    })

    expect((await rig.invoke('p1', 'run_gate')).facts?.gate?.['cached']).toBe(false)
    expect(existsSync(join(rig.root, before))).toBe(true)
    expect(existsSync(join(rig.root, after))).toBe(false)

    rig.executor.adopt(
      WorkflowSchema.parse({
        ...rig.workflow,
        gates: { unit: { cmd: marker(join(rig.root, after)), timeout_s: 30 } },
      }),
    )

    const amended = await rig.invoke('p1', 'run_gate')
    // Not a hit. The tree has not moved, so a cache keyed on the tree alone
    // would have answered from a command that no longer exists.
    expect(amended.facts?.gate?.['cached']).toBe(false)
    expect(existsSync(join(rig.root, after))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5b. The gate's result is journalled; the gate's output is not
// ---------------------------------------------------------------------------

describe('journalled gate results', () => {
  /** A gate that fails loudly, printing something no event may ever contain. */
  /**
   * Prints to both streams and exits with a chosen code, in the shell the gate
   * runner actually uses on this platform (`src/platform/platform.ts`).
   *
   * `cmd.exe` shares no syntax with `sh`, and `;` is not a command separator
   * there: the POSIX form ran as a single `echo` of the whole literal line and
   * exited 0, so the gate came back **green on Windows whatever exit code it
   * was asked for** — a fixture that had silently stopped testing the thing it
   * is named after. Rendered per platform rather than skipped, because what it
   * asserts (the code is recorded, and the gate's output reaches no event
   * payload) is not POSIX-specific.
   */
  const noisyGate = (exit: number): string =>
    process.platform === 'win32'
      ? `echo SECRET-FROM-THE-REPO& echo on-stderr 1>&2& exit /b ${exit}`
      : `echo SECRET-FROM-THE-REPO; echo on-stderr >&2; exit ${exit}`

  const noisy = (exit: number): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'noisy',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 1, kind: 'worktree' } },
      gates: {
        unit: { cmd: noisyGate(exit), timeout_s: 30 },
      },
      nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit'] }],
    })

  const assign = (rig: Rig): void => {
    rig.journal.append({
      runId: RUN_ID,
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: (rig.lanes[0] as ExecutorLane).name },
    })
  }

  /** The three identifier fields of each verdict. Timings are asserted apart. */
  const gateResults = (rig: Rig): { gate: string; exit_code: number; status: string }[] =>
    rig.journal
      .events(RUN_ID)
      .filter((event) => event.type === 'gate_result')
      .map((event) => {
        const { gate, exit_code, status } = event.payload as {
          gate: string
          exit_code: number
          status: string
        }
        return { gate, exit_code, status }
      })

  it('records the gate id, its exit code and its status', async () => {
    const rig = setup(() => noisy(3))
    assign(rig)

    const outcome = await rig.invoke('p1', 'run_gate')

    expect(outcome.facts?.gate?.['exit_code']).toBe(3)
    expect(gateResults(rig)).toEqual([{ gate: 'unit', exit_code: 3, status: 'failed' }])
  })

  it('records what a timed-out gate looked like when it was killed, as numbers', async () => {
    const hang =
      process.platform === 'win32'
        ? 'echo SECRET-FROM-THE-REPO& ping -n 30 127.0.0.1 >nul'
        : 'echo SECRET-FROM-THE-REPO; sleep 30'
    const rig = setup(() => {
      const workflow = noisy(0)
      return { ...workflow, gates: { unit: { cmd: hang, requires: [], timeout_s: 1 } } }
    })
    assign(rig)

    await rig.invoke('p1', 'run_gate')

    const row = rig.journal.events(RUN_ID).find((event) => event.type === 'gate_result')
    const payload = row?.payload as {
      status: string
      timeout?: { quiet_ms: number; output_bytes: number; load_1m?: number; cpus: number }
    }
    expect(payload.status).toBe('timed_out')
    expect(payload.timeout?.output_bytes).toBeGreaterThan(0)
    expect(payload.timeout?.quiet_ms).toBeGreaterThan(0)
    expect(payload.timeout?.cpus).toBeGreaterThan(0)
    expect(JSON.stringify(payload)).not.toContain('SECRET')
  }, 20_000)

  it('records a passing gate as passed with exit code 0', async () => {
    const rig = setup(() => noisy(0))
    assign(rig)

    await rig.invoke('p1', 'run_gate')

    expect(gateResults(rig)).toEqual([{ gate: 'unit', exit_code: 0, status: 'passed' }])
  })

  /**
   * And again in the node's transcript, which is where somebody reading what
   * happened to this phase actually looks. The gates were the one thing missing
   * from it: four agents' output in order, and no sign of the thing that judged
   * them.
   */
  it('puts the gate in the node’s transcript, attributed to the gate', async () => {
    const rig = setup(() => noisy(3))
    assign(rig)

    await rig.invoke('p1', 'run_gate')

    expect(rig.journal.tailTranscript(RUN_ID, 'p1', 100)).toEqual([
      {
        type: 'gate_run',
        gate: 'unit',
        exitCode: 3,
        status: 'failed',
        cached: false,
        by: { role: 'gate' },
      },
    ])
  })

  /** §11 again, on the other file this step now writes. */
  it('keeps the gate’s output out of the transcript too', async () => {
    const rig = setup(() => noisy(3))
    assign(rig)

    await rig.invoke('p1', 'run_gate')

    const entries = JSON.stringify(rig.journal.tailTranscript(RUN_ID, 'p1', 100))
    expect(entries).not.toContain('SECRET-FROM-THE-REPO')
    expect(entries).not.toContain('on-stderr')
    expect(entries).not.toContain('echo')
  })

  /**
   * The line this step is not allowed to cross. Gate output is repository
   * content verbatim (§5.3, §11): it belongs in `gates/unit.log` and nowhere
   * else. This asserts against *every* event payload in the run, not just the
   * gate's, so a future field that quietly carried a line of it fails here.
   */
  it('keeps the gate’s output in the log file and out of every event payload', async () => {
    const rig = setup(() => noisy(3))
    assign(rig)

    await rig.invoke('p1', 'run_gate')

    const log = join(rig.journal.root, 'runs', RUN_ID, 'nodes', 'p1', 'gates', 'unit.log')
    expect(readFileSync(log, 'utf8')).toContain('SECRET-FROM-THE-REPO')

    const payloads = JSON.stringify(rig.journal.events(RUN_ID).map((event) => event.payload))
    expect(payloads).not.toContain('SECRET-FROM-THE-REPO')
    expect(payloads).not.toContain('on-stderr')
    // Not even the gate's command, which is repository text of its own.
    expect(payloads).not.toContain('echo')
    // Identifiers, an exit code, a status and two measurements — the whole
    // payload. Neither measurement is content: one is a millisecond count and
    // the other a flag.
    expect(
      rig.journal
        .events(RUN_ID)
        .filter((event) => event.type === 'gate_result')
        .map((event) => Object.keys(event.payload).sort()),
    ).toEqual([['cached', 'duration_ms', 'exit_code', 'gate', 'status']])
    // And the start, which carries the gate id alone.
    expect(
      rig.journal
        .events(RUN_ID)
        .filter((event) => event.type === 'gate_started')
        .map((event) => Object.keys(event.payload).sort()),
    ).toEqual([['gate']])
  })

  /**
   * The pair the node view's live clock reads. The start is written at the
   * spawn rather than at the call, so the distance between the two rows is the
   * gate's own runtime — and `duration_ms` is the runner's measurement of the
   * same interval, which is what makes the two agree.
   */
  it('brackets the gate with a start event and reports what it measured', async () => {
    const rig = setup(() => noisy(0))
    assign(rig)

    await rig.invoke('p1', 'run_gate')

    const gateEvents = rig.journal
      .events(RUN_ID)
      .filter((event) => event.type === 'gate_started' || event.type === 'gate_result')
    expect(gateEvents.map((event) => event.type)).toEqual(['gate_started', 'gate_result'])
    expect(gateEvents[0]?.payload).toEqual({ gate: 'unit' })

    const verdict = gateEvents[1]?.payload as { duration_ms: number; cached: boolean }
    expect(verdict.cached).toBe(false)
    expect(verdict.duration_ms).toBeGreaterThanOrEqual(0)
    // The measurement cannot exceed the wall time between the two rows.
    const bracket = (gateEvents[1]?.ts ?? 0) - (gateEvents[0]?.ts ?? 0)
    expect(verdict.duration_ms).toBeLessThanOrEqual(bracket + 1)
  })
})

// ---------------------------------------------------------------------------
// 6. git_branch / git_merge / open_pr
// ---------------------------------------------------------------------------

describe('the git verbs', () => {
  const twoNodes = (): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'topology',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 2, kind: 'worktree' } },
      nodes: [
        { id: 'p1', name: 'One', prompt_ref: 'plan.md#1' },
        {
          id: 'p2',
          name: 'Two',
          prompt_ref: 'plan.md#2',
          depends_on: [{ node: 'p1', artifact: 'the thing p1 built' }],
        },
      ],
    })

  /**
   * A wave of two with a spare lane, so the completeness decision is a real one
   * rather than a single node standing in for its own wave.
   */
  const twoPeers = (): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'peers',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 3, kind: 'worktree' } },
      nodes: [
        { id: 'p1', name: 'One', prompt_ref: 'plan.md#1' },
        { id: 'p2', name: 'Two', prompt_ref: 'plan.md#2' },
      ],
    })

  /** Branch and commit one file, in the lane this node is assigned. */
  const work = async (rig: Rig, nodeId: string, index: number): Promise<void> => {
    const lane = rig.lanes[index] as ExecutorLane
    // What `amendRun`'s `registerNodes` emits for a node the run gains: a
    // phase with no row has no lane, and the executor refuses it. Replay-safe
    // for the nodes `createRun` already registered.
    rig.journal.append({
      runId: RUN_ID,
      nodeId,
      type: 'node_registered',
      payload: { wave: 1, harness: 'claude-code' },
    })
    rig.journal.append({
      runId: RUN_ID,
      nodeId,
      type: 'node_assigned',
      payload: { lane: lane.name },
    })
    await rig.invoke(nodeId, 'git_branch')
    writeFileSync(join(lane.path, `${nodeId}.txt`), `${nodeId}\n`)
    g(lane.path, 'add', '--all')
    g(lane.path, 'commit', '-m', `${nodeId} work`)
  }

  const hasBranch = (cwd: string, ref: string): boolean => {
    try {
      g(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`)
      return true
    } catch {
      return false
    }
  }

  /** The amended plan, with one more phase alone in wave 1. */
  const plus = (workflow: Workflow, id: string): Workflow =>
    WorkflowSchema.parse({
      ...workflow,
      nodes: [...workflow.nodes, { id, name: id, prompt_ref: `plan.md#${id}` }],
    })

  it('does not build a wave until every phase an amendment added has arrived', async () => {
    // §9 refuses an amendment while a node it *blocks* is in flight, and a
    // phase nobody depends on blocks nothing — so it lands beside running
    // wave-mates. The wave must not close without it.
    const rig = setup(twoPeers)
    await work(rig, 'p1', 0)
    await work(rig, 'p2', 1)

    const amended = plus(rig.workflow, 'p3')
    rig.executor.adopt(amended)
    rig.integrator.adopt(amended)

    // Both original phases arrive, and the wave is no longer complete: `p3` is
    // in it now and has not run.
    await rig.invoke('p1', 'git_merge')
    await rig.invoke('p2', 'git_merge')
    expect(hasBranch(rig.repo, waveBranch(amended, 1))).toBe(false)

    // Once it does arrive, the merge includes it.
    await work(rig, 'p3', 2)
    await rig.invoke('p3', 'git_merge')
    for (const nodeId of ['p1', 'p2', 'p3']) {
      expect(isAncestor(rig.repo, branchOf(amended, nodeId), waveBranch(amended, 1))).toBe(true)
    }
  })

  it('merges the membership it counted, not the plan that arrived later', async () => {
    // The decision and the merge are separated by the integration worktree's
    // queue, and an amendment can land in between. A phase added to this wave
    // in that window has no branch: merging it would fail on a missing ref, and
    // the wave that was declared complete would not be the wave that was built.
    const rig = setup(twoPeers)
    await work(rig, 'p1', 0)
    await work(rig, 'p2', 1)
    await rig.invoke('p1', 'git_merge')

    // The integrator takes the amendment; the executor has already counted.
    // That is the window, from the queued merge's point of view.
    rig.integrator.adopt(plus(rig.workflow, 'p9'))

    await expect(rig.invoke('p2', 'git_merge')).resolves.toEqual({})
    const wave1 = waveBranch(rig.workflow, 1)
    expect(isAncestor(rig.repo, branchOf(rig.workflow, 'p1'), wave1)).toBe(true)
    expect(isAncestor(rig.repo, branchOf(rig.workflow, 'p2'), wave1)).toBe(true)
  })

  /** `twoPeers` with one gate that has a scoped form: what the wave gate is for. */
  const scopedPeers = (fullGate: string) => (): Workflow =>
    WorkflowSchema.parse({
      ...twoPeers(),
      gates: { unit: { cmd: fullGate, scoped_cmd: 'echo {changed_files}' } },
      nodes: twoPeers().nodes.map((node) => ({ ...node, gates: ['unit'] })),
    })

  it('runs the full form of a gate the wave’s phases ran narrowed, once, on the merged tree', async () => {
    const counter = join(mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-wave-gate-')), 'ran')
    cleanups.push(() => rmSync(dirname(counter), { recursive: true, force: true }))
    const rig = setup(scopedPeers(renderGate({ append: { path: counter, line: 'full' } })))
    await work(rig, 'p1', 0)
    await work(rig, 'p2', 1)
    await rig.invoke('p1', 'git_merge')
    await rig.invoke('p2', 'git_merge')

    expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['full'])
    const rows = rig.journal.events(RUN_ID).filter((event) => event.type === 'wave_gate_result')
    expect(rows.map((row) => ({ node: row.nodeId, ...row.payload }))).toEqual([
      { node: 'p2', wave: 1, gate: 'unit', exit_code: 0, status: 'passed', duration_ms: expect.any(Number) },
    ])
  })

  it('fails the merge when the full form is red, naming the wave and the gate', async () => {
    const rig = setup(scopedPeers(renderGate({ exit: 3 })))
    await work(rig, 'p1', 0)
    await work(rig, 'p2', 1)
    await rig.invoke('p1', 'git_merge')
    await expect(rig.invoke('p2', 'git_merge')).rejects.toThrow(/wave 1 merged, but gate "unit" failed/)
  })

  it('runs no wave gate when phases already ran the full command', async () => {
    const rig = setup(() =>
      WorkflowSchema.parse({ ...scopedPeers('true')(), defaults: { ...twoPeers().defaults, gate_scope: 'full' } }),
    )
    await work(rig, 'p1', 0)
    await work(rig, 'p2', 1)
    await rig.invoke('p1', 'git_merge')
    await rig.invoke('p2', 'git_merge')
    expect(rig.journal.events(RUN_ID).some((event) => event.type === 'wave_gate_result')).toBe(false)
  })

  it('produces the expected ancestry, and degrades cleanly with no gh', async () => {
    const rig = setup(twoNodes)
    const lane = rig.lanes[0] as ExecutorLane
    rig.journal.append({
      runId: RUN_ID,
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: lane.name },
    })

    await rig.invoke('p1', 'git_branch')
    expect(g(lane.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchOf(rig.workflow, 'p1'))
    writeFileSync(join(lane.path, 'p1.txt'), 'one\n')
    g(lane.path, 'add', '--all')
    g(lane.path, 'commit', '-m', 'p1 work')

    // p1 is alone in wave 1, so its `git_merge` is the wave merge (§6's
    // "on done: … maybe build wave branch").
    await rig.invoke('p1', 'git_merge', { strategy: '--no-ff' })

    const wave1 = waveBranch(rig.workflow, 1)
    expect(isAncestor(rig.repo, branchOf(rig.workflow, 'p1'), wave1)).toBe(true)
    // `--no-ff`, never a fast-forward: the wave tip is a real merge commit.
    expect(g(rig.repo, 'rev-list', '--parents', '-n', '1', wave1).split(' ')).toHaveLength(3)

    // p2's base is its dependency's branch, not `base_branch`.
    const lane2 = rig.lanes[1] as ExecutorLane
    rig.journal.append({
      runId: RUN_ID,
      nodeId: 'p2',
      type: 'node_assigned',
      payload: { lane: lane2.name },
    })
    await rig.invoke('p2', 'git_branch')
    expect(isAncestor(rig.repo, branchOf(rig.workflow, 'p1'), branchOf(rig.workflow, 'p2'))).toBe(
      true,
    )

    // No `gh` on the path this takes: a degraded PR is reported, never thrown,
    // and stated as a fact so an `after_pr` chore knows there is nothing to do.
    await expect(rig.invoke('p1', 'open_pr', { draft: true })).resolves.toEqual({
      facts: { pr: { opened: false } },
    })
    // And no remote: pushing is a documented no-op rather than a failure.
    await expect(rig.invoke('p1', 'git_push')).resolves.toEqual({})

    // **The refusal is on the record.** `openPullRequest` never throws — a
    // missing `gh` must not fail a finished run — but the result used to be
    // discarded, which turned "never fails" into "never tells you": a phase in
    // a real run completed with no pull request and the only way to notice was
    // a gap in a list on the forge.
    const prs = rig.journal
      .events(RUN_ID)
      .filter((event) => event.type === 'node_pr' && event.nodeId === 'p1')
    expect(prs).toHaveLength(1)
    expect((prs[0]?.payload as { opened: boolean }).opened).toBe(false)
    expect((prs[0]?.payload as { reason?: string }).reason).toBeDefined()
    // Identifiers only: `gh`'s own words are composed from its output (§11).
    expect(JSON.stringify(prs[0]?.payload)).not.toContain('no-such-gh')
  })

  /**
   * Every PR a plan needs to reach `base_branch`: one per phase, one per
   * `integ-` branch, and the plan PR off the final wave, opened by the phase
   * that closed it — after that phase's own PR, so the plan PR can list it.
   */
  it('opens the integration and plan PRs a diamond needs to land', async () => {
    const diamond = (): Workflow =>
      WorkflowSchema.parse({
        schema_version: 1,
        id: 'diamond',
        base_branch: 'main',
        defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
        resources: { lane: { capacity: 3, kind: 'worktree' } },
        nodes: [
          { id: 'p1', name: 'One', prompt_ref: 'plan.md#1' },
          { id: 'p2', name: 'Two', prompt_ref: 'plan.md#2' },
          {
            id: 'p3',
            name: 'Three',
            prompt_ref: 'plan.md#3',
            depends_on: [
              { node: 'p1', artifact: 'one' },
              { node: 'p2', artifact: 'two' },
            ],
          },
        ],
      })
    const rig = setup(diamond)
    const prs = (): { nodeId: string | null; payload: Record<string, unknown> }[] =>
      rig.journal
        .events(RUN_ID)
        .filter((event) => event.type === 'node_pr' || event.type === 'run_pr')
        .map((event) => ({
          nodeId: 'nodeId' in event ? event.nodeId : null,
          payload: event.payload as Record<string, unknown>,
        }))

    await work(rig, 'p1', 0)
    await work(rig, 'p2', 1)
    for (const nodeId of ['p1', 'p2']) {
      await rig.invoke(nodeId, 'git_merge')
      await rig.invoke(nodeId, 'open_pr', { draft: true })
    }
    // Wave 1 is not the last wave: no plan PR yet, and no integration PR for
    // phases based on `base_branch`.
    expect(prs().map((pr) => pr.payload['kind'])).toEqual(['phase', 'phase'])

    await work(rig, 'p3', 2)
    await rig.invoke('p3', 'git_merge')
    // The final wave is built, but the plan PR waits for p3's own `open_pr`.
    expect(prs().some((pr) => pr.nodeId === null)).toBe(false)
    await rig.invoke('p3', 'open_pr', { draft: true })

    const p3 = prs().filter((pr) => pr.nodeId === 'p3')
    expect(p3.map((pr) => pr.payload['kind'])).toEqual(['integration', 'phase'])
    expect(p3[0]?.payload).toMatchObject({ base: 'main', head: 'plan/diamond/integ-p3' })
    expect(p3[1]?.payload).toMatchObject({
      base: 'plan/diamond/integ-p3',
      head: branchOf(rig.workflow, 'p3'),
    })

    const plan = prs().filter((pr) => pr.nodeId === null)
    expect(plan).toHaveLength(1)
    expect(plan[0]?.payload).toMatchObject({
      base: 'main',
      head: waveBranch(rig.workflow, 2),
      // No `gh` in the rig: recorded as not opened, never thrown.
      opened: false,
    })

    // Spent: a second `open_pr` from the same phase does not open it again.
    await rig.invoke('p3', 'open_pr', { draft: true })
    expect(prs().filter((pr) => pr.nodeId === null)).toHaveLength(1)
  })

  /**
   * The half of the retry fix that lives here: *whether* this is a second
   * attempt is a question about this run, and only the journal answers it.
   * `node_assigned` carrying the phase branch is the record that the node has
   * already been branched.
   */
  it('keeps the previous attempt’s commits when the node is branched again', async () => {
    const rig = setup(twoNodes)
    const lane = rig.lanes[0] as ExecutorLane
    rig.journal.append({
      runId: RUN_ID,
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: lane.name },
    })

    await rig.invoke('p1', 'git_branch')
    writeFileSync(join(lane.path, 'p1.txt'), 'the first attempt\n')
    g(lane.path, 'add', '--all')
    g(lane.path, 'commit', '-m', 'p1 work')
    const attemptOne = g(lane.path, 'rev-parse', 'HEAD')

    // The retry: same node, same effect, second time round.
    await rig.invoke('p1', 'git_branch')

    expect(g(lane.path, 'rev-parse', 'HEAD')).toBe(attemptOne)
    expect(existsSync(join(lane.path, 'p1.txt'))).toBe(true)

    // And the journal says what the branch pointed at when this attempt took
    // it over — null the first time, the previous tip the second.
    const assigned = rig.journal
      .events(RUN_ID)
      .filter((event) => event.type === 'node_assigned' && event.nodeId === 'p1')
      .map((event) => (event.payload as { previous_head?: string | null }).previous_head)
    expect(assigned).toEqual([undefined, null, attemptOne])
  })

  it('writes the run and wave tracking records in the integration worktree', async () => {
    const rig = setup(twoNodes)
    const lane = rig.lanes[0] as ExecutorLane
    rig.journal.append({
      runId: RUN_ID,
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: lane.name },
    })

    await rig.invoke('p1', 'write_tracking', { scope: 'run' })
    await rig.invoke('p1', 'write_tracking', { scope: 'wave' })

    const dir = trackingDir(rig.workflow)
    const run = readFileSync(join(rig.integ, dir, 'run.md'), 'utf8')
    expect(run).toContain(`# Run ${RUN_ID}`)
    expect(run).toContain('| p1 |')
    expect(readFileSync(join(rig.integ, dir, 'waves', 'wave-1.md'), 'utf8')).toContain('# Wave 1')
  })

  it('builds tracking paths for git, which means forward slashes everywhere', () => {
    // These strings are handed to `git add`, `git commit -- <path>` and
    // `git show <rev>:<path>`, and git speaks posix paths on every platform.
    // Built with `node:path`'s join they came out as `ai-plans\TRACKING_x` on
    // Windows, `git show` answered `fatal: path ... does not exist`, and the
    // phase's tracking file was silently never committed — the node failed on
    // a path separator.
    //
    // **A posix machine cannot fully prove this**: `posix.join` and the
    // platform `join` are the same function here, so this test passes on macOS
    // and Linux either way. It is pinned as an exact string so that a revert to
    // `join` fails on the Windows leg, which now runs the suite. That leg is
    // the enforcement; this is the statement of the rule.
    const workflow = { id: 'bookmark-folders', plan_ref: 'ai-plans/PLAN_x.md#phase-1' }

    expect(trackingDir(workflow)).toBe('ai-plans/TRACKING_bookmark-folders')
    expect(trackingPath(workflow, 'run.md')).toBe('ai-plans/TRACKING_bookmark-folders/run.md')
    expect(trackingPath(workflow, 'waves', 'wave-2.md')).toBe(
      'ai-plans/TRACKING_bookmark-folders/waves/wave-2.md',
    )
    for (const path of [
      trackingDir(workflow),
      trackingPath(workflow, 'run.md'),
      trackingPath(workflow, 'waves', 'wave-2.md'),
    ]) {
      expect(path).not.toContain('\\')
    }
  })

  it('tracks at the repository root when the workflow names no plan', () => {
    // The one location that needs no guess, and the branch where there is no
    // directory to join — so it must not gain a leading separator either.
    const workflow = { id: 'adhoc', plan_ref: undefined }

    expect(trackingDir(workflow)).toBe('TRACKING_adhoc')
    expect(trackingPath(workflow, 'run.md')).toBe('TRACKING_adhoc/run.md')
  })
})

// ---------------------------------------------------------------------------
// 7. notify
// ---------------------------------------------------------------------------

describe('notify', () => {
  it('carries an identifier and a reason from a fixed vocabulary, and nothing else', async () => {
    const rig = setup(() =>
      WorkflowSchema.parse({
        schema_version: 1,
        id: 'notifying',
        base_branch: 'main',
        defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
        resources: { lane: { capacity: 1, kind: 'worktree' } },
        nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1' }],
      }),
    )

    await rig.invoke('p1', 'notify', { channel: 'os', text: 'phase failed' })
    // Author text outside the vocabulary never reaches the notification centre.
    await rig.invoke('p1', 'notify', {
      channel: 'os',
      text: 'diff: -  secret = "hunter2"\n+  secret = os.environ["SECRET"]',
    })
    // §9.1's OS channel, raised by the pause itself.
    await rig.invoke('p1', 'await_human', { question: 'ship it?', kind: 'confirm' })

    expect(rig.notifications).toEqual([
      { scope: 'node', id: 'p1', reason: 'phase failed' },
      { scope: 'node', id: 'p1', reason: 'attention required' },
      { scope: 'node', id: 'p1', reason: 'waiting for the operator' },
    ])
    expect(rig.notifications.map((notification) => notificationBody(notification))).toEqual([
      'node p1: phase failed',
      'node p1: attention required',
      'node p1: waiting for the operator',
    ])
  })

  it('no-ops rather than throwing on a platform with no notification channel', async () => {
    await expect(
      createOsNotifier('win32').notify({ scope: 'node', id: 'p1', reason: 'phase failed' }),
    ).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. The prompt the agent is actually handed
//
// Every test above scripts an adapter that says `VERDICT: pass` whatever it was
// told, so all of them passed while `spawn_agent` handed every role the bare
// `prompt_ref` and the reviewer was never told it was reviewing. The pair below
// closes that: one agent answers out of its prompt, the other ignores it, and
// only the first can reach `done`.
// ---------------------------------------------------------------------------

const CLEAN_GATES = {
  types: { cmd: 'exit 0', timeout_s: 30 },
  unit: { cmd: 'exit 0', requires: ['test-suite'], timeout_s: 30 },
}

/**
 * An agent that read its prompt: it ends on the verdict line only where the
 * prompt asked it to end on one, echoing the exact line it was given. An agent
 * that ignored the prompt could not produce it.
 */
const answersThePrompt = (task: AgentTask): MockScript => {
  const asked = task.prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line === `${VERDICT_MARKER} pass`)
  return {
    events: [
      { type: 'assistant_text', text: asked ?? 'Status: SUCCESS. Implemented the phase.' },
    ],
    result: 'ok',
  }
}

describe('composed prompts, end to end', () => {
  it('reaches done, because the review was told the verdict protocol', async () => {
    const rig = setup(() => goldenWorkflow(CLEAN_GATES, REVIEW_CHORE), { reply: answersThePrompt })

    const report = await within(60_000, rig.run(), 'the composed run')

    expect(report.status).toBe('completed')
    expect(report.failures).toEqual({})
    expect(report.statuses).toEqual({ p1: 'done', p2: 'done', p3: 'done', p4: 'done' })

    const spawned = rig.adapters['claude-code']?.spawned ?? []
    // The brief itself, resolved from `prompt_ref` — not the reference.
    expect(spawned.some((task) => task.prompt.includes('Phase brief for p1'))).toBe(true)
    expect(spawned.every((task) => task.prompt !== rig.workflow.nodes[0]?.prompt_ref)).toBe(true)
    // p2 and p3 are siblings off p1: neither may be told about the other.
    const p2 = spawned.filter((task) => task.nodeId === 'p2')
    expect(p2.length).toBeGreaterThan(0)
    expect(p2.every((task) => task.prompt.includes('p1'))).toBe(true)
    expect(p2.some((task) => task.prompt.includes('Phase brief for p3'))).toBe(false)
  })

  it('fails when the agent ignores its prompt — the run this bug produced', async () => {
    const rig = setup(() => goldenWorkflow(CLEAN_GATES, REVIEW_CHORE), {
      reply: () => ({ events: [{ type: 'assistant_text', text: 'ok, done' }], result: 'ok' }),
      retryAfterMs: 10,
    })

    const report = await within(60_000, rig.run(), 'the run nobody told what to do')

    // No verdict stated, so the review's silence fails closed, nobody answers
    // the unapproved-review question, and the node fails with its dependents
    // blocked behind it.
    expect(report.statuses['p1']).toBe('failed')
    expect(report.statuses['p4']).toBe('blocked')
  })
}, REAL_RUN_TIMEOUT_MS)

// ---------------------------------------------------------------------------
// System One (§17): judge gates and gate triage
// ---------------------------------------------------------------------------

describe('System One in run_gate', () => {
  const judged = (gates: Readonly<Record<string, unknown>>, nodeGates: readonly string[]) => (): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'judged',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 1, kind: 'worktree' } },
      gates,
      nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: nodeGates }],
    })

  const assign = (rig: Rig): ExecutorLane => {
    const lane = rig.lanes[0] as ExecutorLane
    rig.journal.append({ runId: RUN_ID, nodeId: 'p1', type: 'node_assigned', payload: { lane: lane.name } })
    return lane
  }

  const judgedRows = (rig: Rig) =>
    rig.journal.events(RUN_ID).flatMap((event) => (event.type === 'system_one_judged' ? [event.payload] : []))

  const LOGS_BODIES = {
    judge: { question: 'Does this diff log request bodies?', fail_on: ['yes'], threshold: 0.6 },
  }

  it('fails a judge gate on the classifier answer, sends it the lane diff, and writes the finding to the log', async () => {
    const adapter = new MockSystemOneAdapter(() => ({ yes: 0.8, no: 0.2 }))
    const rig = setup(judged({ 'no-body-logs': LOGS_BODIES }, ['no-body-logs']), {
      systemOne: { adapter, judges: {} },
    })
    const lane = assign(rig)
    writeFileSync(join(lane.path, 'handler.py'), 'log(request.body)\n')

    const outcome = await rig.invoke('p1', 'run_gate')
    expect(outcome.facts?.gate?.['exit_code']).toBe(1)
    expect(outcome.facts?.gate?.['status']).toBe('failed')

    // The diff, untracked file included, against the base — and the plan's question verbatim.
    expect(adapter.asked).toHaveLength(1)
    expect(adapter.asked[0]?.input).toContain('log(request.body)')
    expect(adapter.asked[0]?.question).toBe('Does this diff log request bodies?')

    const log = readFileSync(String(outcome.facts?.gate?.['log_ref']), 'utf8')
    expect(log).toContain('Does this diff log request bodies?')
    expect(log).toContain('FAILED')

    // Identifiers and numbers in the journal, never the diff.
    const rows = judgedRows(rig)
    expect(rows).toEqual([
      expect.objectContaining({ judge: 'gate', subject: 'no-body-logs', outcome: 'answered', decision: 'failed', adapter: 'mock' }),
    ])
    expect(JSON.stringify(rig.journal.events(RUN_ID))).not.toContain('request.body')
  })

  it('passes a judge gate below its threshold', async () => {
    const adapter = new MockSystemOneAdapter(() => ({ yes: 0.3, no: 0.7 }))
    const rig = setup(judged({ 'no-body-logs': LOGS_BODIES }, ['no-body-logs']), {
      systemOne: { adapter, judges: {} },
    })
    assign(rig)
    expect((await rig.invoke('p1', 'run_gate')).facts?.gate?.['exit_code']).toBe(0)
  })

  it('never lets a passing judge gate cover for a red command gate', async () => {
    const adapter = new MockSystemOneAdapter(() => ({ yes: 0, no: 1 }))
    const rig = setup(
      judged({ unit: { cmd: 'exit 1', timeout_s: 30 }, 'no-body-logs': LOGS_BODIES }, ['unit', 'no-body-logs']),
      { systemOne: { adapter, judges: {} } },
    )
    assign(rig)
    const outcome = await rig.invoke('p1', 'run_gate')
    expect(outcome.facts?.gate?.['id']).toBe('unit')
    expect(outcome.facts?.gate?.['exit_code']).toBe(1)
    expect(adapter.asked).toHaveLength(0)
  })

  it('treats an unconfigured classifier as unavailable, under the gate\'s own on_unavailable', async () => {
    const rig = setup(
      judged(
        {
          advisory: LOGS_BODIES,
          required: { judge: { ...LOGS_BODIES.judge, on_unavailable: 'fail' } },
        },
        ['advisory', 'required'],
      ),
    )
    assign(rig)
    const outcome = await rig.invoke('p1', 'run_gate')
    expect(outcome.facts?.gate?.['id']).toBe('required')
    expect(outcome.facts?.gate?.['exit_code']).toBe(1)
    expect(judgedRows(rig).map((row) => [row.subject, row.outcome, row.decision])).toEqual([
      ['advisory', 'unconfigured', 'passed'],
      ['required', 'unconfigured', 'failed'],
    ])
  })

  it('caches an answered judgement on the tree, and never an unavailable one', async () => {
    let refuse = true
    const adapter = new MockSystemOneAdapter(() => (refuse ? { refuse: 'unavailable' } : { yes: 0, no: 1 }))
    const rig = setup(judged({ 'no-body-logs': LOGS_BODIES }, ['no-body-logs']), {
      systemOne: { adapter, judges: {} },
      cache: true,
    })
    assign(rig)
    expect((await rig.invoke('p1', 'run_gate')).facts?.gate?.['cached']).toBe(false)
    refuse = false
    expect((await rig.invoke('p1', 'run_gate')).facts?.gate?.['cached']).toBe(false)
    expect((await rig.invoke('p1', 'run_gate')).facts?.gate?.['cached']).toBe(true)
    expect(adapter.asked).toHaveLength(2)
  })

  it('reruns a red command gate the triage judge calls flaky, and reports the triage', async () => {
    const adapter = new MockSystemOneAdapter(() => ({ flaky: 0.9, real: 0.1 }))
    const rig = setup(
      // Says something first: an empty log gives the classifier nothing to sort, and is not triaged.
      (root) =>
        judged(
          {
            unit: {
              cmd: `${process.platform === 'win32' ? 'echo port in use &' : 'echo port in use;'} ${flipOnceGate(join(root, 'flipped'))}`,
              timeout_s: 30,
            },
          },
          ['unit'],
        )(),
      {
        systemOne: {
          adapter,
          judges: { gate_triage: { rerun_above: 0.8, max_reruns: 1, max_input_bytes: 32 * 1024 } },
        },
      },
    )
    assign(rig)
    const outcome = await rig.invoke('p1', 'run_gate')
    expect(outcome.facts?.gate?.['exit_code']).toBe(0)
    expect(outcome.facts?.gate?.['triage']).toBe('flaky')
    const results = rig.journal.events(RUN_ID).filter((event) => event.type === 'gate_result')
    expect(results.map((event) => (event.payload as { exit_code: number }).exit_code)).toEqual([1, 0])
    expect(judgedRows(rig)).toEqual([expect.objectContaining({ judge: 'gate_triage', decision: 'rerun' })])
  })

  it('leaves a real failure to the fixer', async () => {
    const adapter = new MockSystemOneAdapter(() => ({ real: 0.95, flaky: 0.05 }))
    const rig = setup(judged({ unit: { cmd: 'echo boom && exit 1', timeout_s: 30 } }, ['unit']), {
      systemOne: {
        adapter,
        judges: { gate_triage: { rerun_above: 0.8, max_reruns: 1, max_input_bytes: 32 * 1024 } },
      },
    })
    assign(rig)
    const outcome = await rig.invoke('p1', 'run_gate')
    expect(outcome.facts?.gate?.['exit_code']).toBe(1)
    expect(outcome.facts?.gate?.['triage']).toBe('real')
    expect(rig.journal.events(RUN_ID).filter((event) => event.type === 'gate_result')).toHaveLength(1)
  })
}, REAL_RUN_TIMEOUT_MS)
