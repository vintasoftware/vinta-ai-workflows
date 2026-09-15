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
function goldenWorkflow(gates: Readonly<Record<string, unknown>>): Workflow {
  const { pipelines: _shadowed, ...rest } = GOLDEN
  return WorkflowSchema.parse({ ...rest, gates })
}

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
  }, 60_000)
})

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
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 1, kind: 'worktree' } },
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

  it('red gate → fix → review → green gate → done', async () => {
    const rig = setup((root) => flakyGate(root, 2), { script: PASSING })
    const report = await within(60_000, rig.run(), 'the fix loop')

    expect(report.statuses['p1']).toBe('done')
    expect(report.statuses['p2']).toBe('done')
    // implementer, reviewer, (gate red) fixer, reviewer — then the gate is green.
    const spawned = rig.adapters['claude-code']?.spawned ?? []
    expect(spawned.filter((task) => task.nodeId === 'p1')).toHaveLength(4)
  })

  it('continues the implementer’s session for the fixer, and sends it a delta', async () => {
    // §15 end to end, with real worktrees and a real git history — the one
    // place the two halves of the feature are checked *together*. Resuming a
    // session while re-sending the whole brief wastes the saving; sending a
    // delta into a session that was never opened asks an agent to fix findings
    // it has never seen. Either half alone passes its own unit tests.
    const rig = setup((root) => flakyGate(root, 2), { script: PASSING })
    await within(60_000, rig.run(), 'the fix loop')

    const spawned = (rig.adapters['claude-code']?.spawned ?? []).filter(
      (task) => task.nodeId === 'p1',
    )
    const [implement, review, fix, reReview] = spawned

    // Both slots open cold; neither inherits anything.
    expect(implement?.resumeSessionId).toBeUndefined()
    expect(review?.resumeSessionId).toBeUndefined()

    // The fixer continues `main` — the session that wrote the code.
    expect(fix?.resumeSessionId).toBeDefined()
    // The re-review continues `review`, and the two are different sessions:
    // the reviewer must never end up inside the session it is reviewing.
    expect(reReview?.resumeSessionId).toBeDefined()
    expect(fix?.resumeSessionId).not.toBe(reReview?.resumeSessionId)

    // And the prompts match the sessions. A continuation says so in as many
    // words and carries no brief; the cold prompt that opened the slot does.
    expect(fix?.prompt).toContain('same session')
    expect(implement?.prompt).not.toContain('same session')
    expect(fix?.prompt.length).toBeLessThan((implement?.prompt ?? '').length)

    // The one thing a reviewer continuation may never drop: without it the
    // executor reads no verdict and takes the fail-closed default on a node
    // that just passed (§15.3).
    expect(reReview?.prompt).toContain(VERDICT_MARKER)
  })

  it('reviews the last fix rather than failing the phase unread', async () => {
    // `fix` used to go straight to `failed` once the budget was up, so the
    // final fixer's work was never reviewed and never gated. Two phases in one
    // run ended on a fixer reporting "all gates green, committed, tree clean"
    // and were failed anyway — the work was done and nothing was asked to look
    // at it.
    //
    // Here the gate flips green exactly once, on the attempt the old pipeline
    // never reached: the first gate is red, the fixer spends the only round,
    // and what happens next is the whole question.
    const rig = setup((root) => flakyGate(root, 1), { script: PASSING })

    const report = await within(60_000, rig.run(), 'the fix loop')

    expect(report.statuses['p1']).toBe('done')
    // Matched against both prompt forms. `fix` shares the implementer's
    // session, so a fixer turn is a *continuation* — its delta never says "You
    // are fixing", and a classifier that only knew the cold wording read it as
    // an implementer and made this test lie about what ran.
    const roles = rig.adapters['claude-code']?.spawned
      // p1 only: this fixture also carries a p2, whose own turns would
      // otherwise land in the middle of the sequence under test.
      .filter((task) => task.nodeId === 'p1')
      .map((task) =>
      task.prompt.includes('You are fixing') ||
      task.prompt.includes('Change exactly what is named above')
        ? 'fixer'
        : task.prompt.includes('You are reviewing') || task.prompt.includes('Still reviewing')
          ? 'reviewer'
          : 'implementer',
    )
    // The fixer's turn is followed by a review, and that review is what passes
    // the phase. Under the old pipeline the list ended at the fixer.
    expect(roles).toEqual(['implementer', 'reviewer', 'fixer', 'reviewer'])
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
      { script: PASSING },
    )
    const report = await within(60_000, rig.run(), 'the exhausted fix loop')

    expect(report.statuses['p1']).toBe('failed')
    expect(report.statuses['p2']).toBe('blocked')
    // `standard-phase`'s `failed` state notifies — identifiers and a fixed reason.
    expect(rig.notifications).toEqual([{ scope: 'node', id: 'p1', reason: 'phase failed' }])
  })
})

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
})

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

  const gateResults = (rig: Rig): { gate: string; exit_code: number; status: string }[] =>
    rig.journal
      .events(RUN_ID)
      .filter((event) => event.type === 'gate_result')
      .map((event) => event.payload as { gate: string; exit_code: number; status: string })

  it('records the gate id, its exit code and its status', async () => {
    const rig = setup(() => noisy(3))
    assign(rig)

    const outcome = await rig.invoke('p1', 'run_gate')

    expect(outcome.facts?.gate?.['exit_code']).toBe(3)
    expect(gateResults(rig)).toEqual([{ gate: 'unit', exit_code: 3, status: 'failed' }])
  })

  it('records a passing gate as passed with exit code 0', async () => {
    const rig = setup(() => noisy(0))
    assign(rig)

    await rig.invoke('p1', 'run_gate')

    expect(gateResults(rig)).toEqual([{ gate: 'unit', exit_code: 0, status: 'passed' }])
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
    // Identifiers, an exit code and a status — the whole payload.
    expect(
      rig.journal
        .events(RUN_ID)
        .filter((event) => event.type === 'gate_result')
        .map((event) => Object.keys(event.payload).sort()),
    ).toEqual([['exit_code', 'gate', 'status']])
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

    // No `gh` on the path this takes: a degraded PR is reported, never thrown.
    await expect(rig.invoke('p1', 'open_pr', { draft: true })).resolves.toEqual({})
    // And no remote: pushing is a documented no-op rather than a failure.
    await expect(rig.invoke('p1', 'git_push')).resolves.toEqual({})
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
  it('reaches done, because the reviewer was told the verdict protocol', async () => {
    const rig = setup(() => goldenWorkflow(CLEAN_GATES), { reply: answersThePrompt })

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
    const rig = setup(() => goldenWorkflow(CLEAN_GATES), {
      reply: () => ({ events: [{ type: 'assistant_text', text: 'ok, done' }], result: 'ok' }),
    })

    const report = await within(60_000, rig.run(), 'the run nobody told what to do')

    // No verdict stated, so the reviewer's silence fails closed, the fix rounds
    // run out, and the node fails with its dependents blocked behind it.
    expect(report.statuses['p1']).toBe('failed')
    expect(report.statuses['p4']).toBe('blocked')
  })
})
