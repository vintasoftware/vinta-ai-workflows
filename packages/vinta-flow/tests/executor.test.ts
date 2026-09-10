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
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdmissionControl } from '../src/admission/admission.ts'
import {
  createOsNotifier,
  createRunExecutor,
  notificationBody,
  trackingDir,
  type ExecutorLane,
  type Notification,
  type Notifier,
  type RunEffectExecutor,
} from '../src/executor/index.ts'
import { GateCache } from '../src/gates/cache.ts'
import type { HarnessAdapter } from '../src/harness/adapter.ts'
import { MockAdapter, type MockScript } from '../src/harness/mock.ts'
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
  readonly adapters: Readonly<Record<string, MockAdapter>>
  readonly notifications: Notification[]
  run(): Promise<RunReport>
  /** One effect, invoked directly — for the verbs no pipeline path exercises. */
  invoke(
    nodeId: string,
    verb: EffectId,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<EffectOutcome>
}

function setup(
  build: (root: string) => Workflow,
  options: { readonly script?: MockScript; readonly cache?: boolean } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), 'vinta-flow-executor-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const workflow = build(root)

  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-b', workflow.base_branch)
  g(repo, 'config', 'user.email', 'fixture@example.invalid')
  g(repo, 'config', 'user.name', 'fixture')
  g(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
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
  const adapters = Object.fromEntries(
    [...harnesses].map((id) => [
      id,
      new MockAdapter({ id, ...(options.script === undefined ? {} : { script: options.script }) }),
    ]),
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
  })
})

// ---------------------------------------------------------------------------
// 2–3. The fix loop
// ---------------------------------------------------------------------------

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
          // The marker lives outside every lane, so flipping it does not move a tree hash.
          cmd: `test -f ${join(root, 'green')} && exit 0; touch ${join(root, 'green')}; exit 1`,
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
