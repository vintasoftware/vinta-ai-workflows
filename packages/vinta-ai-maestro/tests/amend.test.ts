/**
 * §9's amend path: changing a live run's workflow at a safe point.
 *
 * Two rigs, because the rule has two halves that fail in different ways.
 *
 * - A **scheduler rig** (`MockAdapter`, no git) for the gate and for "an
 *   unstarted node takes the change immediately": the only honest way to
 *   assert that a node ran with a new definition is to let it run and read the
 *   task the adapter was handed.
 * - A **git rig** (real repositories in temp directories) for the rebase.
 *   Every topology claim here is made against git itself — `merge-base
 *   --is-ancestor` — rather than against the branch name the code picked. A
 *   base computed correctly and a base *named* correctly are different claims,
 *   and only the first survives a merge.
 *
 * Every `git` invocation targets a repository created under `tmpdir()` and
 * removed in `afterEach`. Nothing here runs git against the checkout the suite
 * itself lives in.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AdmissionControl } from '../src/admission/admission.ts'
import { amendRun, createRebaser, diffWorkflows, type AmendRunner } from '../src/amend/index.ts'
import type { AgentSession, HarnessAdapter } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import type { EffectExecutor } from '../src/pipeline/effects.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import { createScheduler, type Scheduler } from '../src/scheduler/index.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

const HARNESS = 'claude-code'
const RUN_ID = 'run-1'

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/** One agent turn, then done. Enough for "which task did the adapter get". */
const SOLO = {
  states: [
    {
      id: 'work',
      name: 'Work',
      position: { x: 0, y: 0 },
      onEnter: [{ id: 'e-work', definitionId: 'spawn_agent', params: { role: 'implementer' } }],
    },
    { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [{ id: 't-done', from: 'work', to: 'done' }],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

interface NodeSpec {
  readonly id: string
  readonly deps?: readonly string[]
  readonly prompt?: string
  readonly model?: string
}

function workflow(nodes: readonly NodeSpec[], pipeline = 'solo'): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'wf',
    base_branch: 'main',
    defaults: { harness: HARNESS, model: 'opus', pipeline },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    gates: {},
    nodes: nodes.map((node) => ({
      id: node.id,
      name: `Phase ${node.id}`,
      prompt_ref: node.prompt ?? `plan.md#${node.id}`,
      ...(node.model === undefined ? {} : { model: node.model }),
      depends_on: (node.deps ?? []).map((dep) => ({ node: dep, artifact: `${dep}'s output` })),
    })),
    pipelines: pipeline === 'solo' ? { solo: SOLO } : {},
  })
}

/** Replaces one node's fields in an already-parsed workflow. */
function edit(base: Workflow, id: string, patch: Partial<Workflow['nodes'][number]>): Workflow {
  return WorkflowSchema.parse({
    ...base,
    nodes: base.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
  })
}

const dep = (node: string) => ({ node, artifact: `${node}'s output` })

// ---------------------------------------------------------------------------
// Rigs
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function store(): { readonly journal: Journal; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-amend-'))
  const journal = openJournal(dir)
  cleanups.push(() => {
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { journal, dir }
}

const flush = async (turns = 5): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function until(read: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (read()) return
    await flush(1)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Holds every session open after its first event, so there is a moment at
 * which a node is genuinely `running` and an amendment can be attempted
 * against it. Without it a `MockAdapter` run drains in microtasks.
 */
function stalling(inner: HarnessAdapter): {
  readonly adapter: HarnessAdapter
  live(): boolean
  release(): void
} {
  let parked = 0
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })

  const adapter: HarnessAdapter = {
    id: inner.id,
    capabilities: inner.capabilities,
    preflight: () => inner.preflight(),
    async spawn(task) {
      const outcome = await inner.spawn(task)
      if (!outcome.ok) return outcome
      const session = outcome.session
      const stalled: AgentSession = {
        id: session.id,
        events: {
          async *[Symbol.asyncIterator]() {
            let first = true
            for await (const event of session.events) {
              yield event
              if (first) {
                first = false
                parked += 1
                await gate
                parked -= 1
              }
            }
          },
        },
        send: (text) => session.send(text),
        interrupt: () => session.interrupt(),
        kill: () => session.kill(),
      }
      return { ok: true, session: stalled }
    },
  }
  return { adapter, live: () => parked > 0, release: () => open() }
}

const NO_EFFECTS: EffectExecutor = { execute: async () => ({}) }

interface SchedulerRig {
  readonly journal: Journal
  readonly scheduler: Scheduler
  readonly adapter: MockAdapter
  readonly runner: AmendRunner
  readonly stall: { live(): boolean; release(): void }
  readonly finished: Promise<unknown>
}

function schedulerRig(wf: Workflow): SchedulerRig {
  const { journal, dir } = store()
  journal.createRun(RUN_ID, wf)

  const pools = new ResourcePools(wf.resources, { agingMs: 0 })
  const admission = new AdmissionControl({ journal, runId: RUN_ID, ceilings: { [HARNESS]: 8 } })
  const adapter = new MockAdapter({ id: HARNESS })
  const stall = stalling(adapter)

  const scheduler = createScheduler({
    workflow: wf,
    runId: RUN_ID,
    journal,
    pools,
    admission,
    adapters: { [HARNESS]: stall.adapter },
    executor: NO_EFFECTS,
    laneRoot: join(dir, 'lanes'),
  })
  cleanups.push(() => admission.close())

  return {
    journal,
    scheduler,
    adapter,
    stall,
    // The live half of §9's gate: the scheduler's own view, and the hand-off
    // that lets its unstarted nodes take a new definition.
    runner: {
      statuses: () => scheduler.statuses,
      adopt: (amended) => scheduler.adopt(amended),
    },
    finished: scheduler.run(),
  }
}

// ---------------------------------------------------------------------------
// The git rig
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => {
  try {
    git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant)
    return true
  } catch {
    return false
  }
}

interface GitRig {
  readonly journal: Journal
  readonly integ: string
  readonly workflow: Workflow
  /** Node ids in the order the rebaser moved them. */
  readonly order: string[]
  readonly runner: AmendRunner
}

const PHASES = ['a', 'b', 'c', 'd', 'e'] as const

/**
 * A run whose every node is `done`: five phase branches with the topology the
 * snapshot declares, and a journal that says so.
 *
 * Nodes are declared **out of topological order** on purpose — `e, c, a, d, b`
 * — so that a rebase queue in declaration order and one in topological order
 * are visibly different lists.
 */
function gitRig(): GitRig {
  const { journal } = store()
  const root = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-amend-git-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))

  const main = join(root, 'repo')
  mkdirSync(main, { recursive: true })
  git(main, 'init', '-b', 'main')
  git(main, 'config', 'user.email', 'fixture@example.invalid')
  git(main, 'config', 'user.name', 'fixture')
  git(main, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(main, 'README.md'), 'fixture\n')
  git(main, 'add', '--all')
  git(main, 'commit', '-m', 'base')

  const integ = join(root, 'integ')
  git(main, 'worktree', 'add', '--detach', integ, 'main')

  const bases: Record<string, string> = {
    a: 'main',
    b: 'main',
    c: 'plan/wf/phase-a',
    d: 'plan/wf/phase-c',
    e: 'plan/wf/phase-d',
  }
  for (const id of PHASES) {
    git(integ, 'checkout', '-B', `plan/wf/phase-${id}`, bases[id] as string)
    writeFileSync(join(integ, `${id}.txt`), `phase ${id}\n`)
    git(integ, 'add', '--all')
    git(integ, 'commit', '-m', `phase ${id}`)
  }
  git(integ, 'checkout', '--detach', 'main')

  const wf = workflow(
    [
      { id: 'e', deps: ['d'] },
      { id: 'c', deps: ['a'] },
      { id: 'a' },
      { id: 'd', deps: ['c'] },
      { id: 'b' },
    ],
    'standard-phase',
  )
  journal.createRun(RUN_ID, wf)
  for (const id of PHASES) {
    journal.append({
      runId: RUN_ID,
      nodeId: id,
      type: 'node_assigned',
      payload: { branch: `plan/wf/phase-${id}`, base_branch: bases[id] as string },
    })
    journal.append({ runId: RUN_ID, nodeId: id, type: 'node_status', payload: { status: 'done' } })
  }

  const order: string[] = []
  const runner: AmendRunner = {
    rebase: createRebaser({
      integrationPath: integ,
      baseOf: (nodeId) =>
        journal.nodes(RUN_ID).find((row) => row.node_id === nodeId)?.base_branch ?? null,
      onRebased: (nodeId, base) => {
        order.push(nodeId)
        // Why the base moved, in the run's own history (§5.3's projected event).
        journal.append({
          runId: RUN_ID,
          nodeId,
          type: 'node_assigned',
          payload: { base_branch: base },
        })
      },
    }),
  }
  return { journal, integ, workflow: wf, order, runner }
}

// ---------------------------------------------------------------------------
// 1: classification
// ---------------------------------------------------------------------------

describe('classifying an amendment', () => {
  it('names what moved per node, and closes over both graphs', () => {
    const before = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }])
    const after = WorkflowSchema.parse({
      ...before,
      nodes: [
        before.nodes[0],
        { ...before.nodes[1], depends_on: [] },
        { ...before.nodes[2], model: 'sonnet' },
      ],
    })

    const diff = diffWorkflows(before, after)
    expect(diff.changes).toEqual([
      { node: 'b', kind: 'dependency_removed' },
      { node: 'c', kind: 'model_changed' },
    ])
    // `b` lost an edge and `c` changed: the closure over the *union* graph
    // still reaches `c` through the edge that only the snapshot has.
    expect(diff.affected).toEqual(['b', 'c'])
    // Only the dependency change moves a base; a model change moves content.
    expect(diff.rebaseable).toEqual(['b', 'c'])
    expect(diff.contentChanged).toEqual(['c'])
  })

  it('resolves defaults and gate definitions before comparing', () => {
    const before = workflow([{ id: 'a' }, { id: 'b' }])
    const withGate = WorkflowSchema.parse({
      ...before,
      gates: { unit: { cmd: 'pnpm test', requires: [] } },
      nodes: before.nodes.map((node) => ({ ...node, gates: ['unit'] })),
    })
    const retimed = WorkflowSchema.parse({
      ...withGate,
      gates: { unit: { cmd: 'pnpm test --silent', requires: [] } },
    })
    // The nodes are byte-identical; the gate they declare is not.
    expect(diffWorkflows(withGate, retimed).changes).toEqual([
      { node: 'a', kind: 'gates_changed' },
      { node: 'b', kind: 'gates_changed' },
    ])

    const defaulted = WorkflowSchema.parse({
      ...before,
      defaults: { ...before.defaults, model: 'sonnet' },
    })
    expect(diffWorkflows(before, defaulted).changes).toEqual([
      { node: 'a', kind: 'model_changed' },
      { node: 'b', kind: 'model_changed' },
    ])
  })

  it('treats a reordered dependency list as a base change, because `integ-` merges in order', () => {
    const before = workflow([{ id: 'a' }, { id: 'b' }, { id: 'c', deps: ['a', 'b'] }])
    const after = edit(before, 'c', { depends_on: [dep('b'), dep('a')] })

    const diff = diffWorkflows(before, after)
    expect(diff.changes).toEqual([{ node: 'c', kind: 'dependency_reordered' }])
    expect(diff.rebaseable).toEqual(['c'])
  })
})

// ---------------------------------------------------------------------------
// 2: the gate, and the immediate half of the apply
// ---------------------------------------------------------------------------

describe('amending a live run', () => {
  it('applies to a node that has not started, and the node runs with the new definition', async () => {
    const wf = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }])
    const rig = schedulerRig(wf)
    await until(() => rig.stall.live(), 'node a to be running')
    expect(rig.scheduler.statuses).toMatchObject({ a: 'running', b: 'pending' })

    const amended = edit(wf, 'b', { prompt_ref: 'plan.md#b-amended', model: 'sonnet' })
    const result = await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: amended,
      runner: rig.runner,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.applied).toEqual(['b'])
    expect(result.rebased).toEqual([])

    rig.stall.release()
    await rig.finished

    const task = rig.adapter.spawned.find((spawned) => spawned.nodeId === 'b')
    expect(task?.prompt).toBe('plan.md#b-amended')
    expect(task?.model).toBe('sonnet')
    // The frozen snapshot moved with it, so a resume reads the same definition.
    expect(rig.journal.readWorkflow(RUN_ID).nodes[1]?.prompt_ref).toBe('plan.md#b-amended')
  })

  it('refuses while an affected node is running, and names the nodes', async () => {
    const wf = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }])
    const rig = schedulerRig(wf)
    await until(() => rig.stall.live(), 'node a to be running')

    const amended = edit(wf, 'a', { prompt_ref: 'plan.md#a-amended' })
    const result = await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: amended,
      runner: rig.runner,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('nodes_in_flight')
    // Both the changed node and the dependent it reaches are named.
    expect(result.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('node "a" is running'),
    ])
    expect(result.issues.map((issue) => issue.path)).toEqual([['nodes', 0]])
    // Refused means nothing moved: the snapshot still says what it said.
    expect(rig.journal.readWorkflow(RUN_ID).nodes[0]?.prompt_ref).toBe('plan.md#a')

    rig.stall.release()
    await rig.finished
  })

  it('lets an amendment through while an *unaffected* node is running', async () => {
    // `a` and `x` are independent and both dispatch at once; `b` waits on `a`.
    // The amendment touches only `b`, so two live nodes must not block it.
    const wf = workflow([{ id: 'a' }, { id: 'x' }, { id: 'b', deps: ['a'] }])
    const rig = schedulerRig(wf)
    await until(
      () => rig.scheduler.statuses['a'] === 'running' && rig.scheduler.statuses['x'] === 'running',
      'a and x to be running',
    )

    const result = await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: edit(wf, 'b', { prompt_ref: 'plan.md#b-amended' }),
      runner: rig.runner,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.affected).toEqual(['b'])

    rig.stall.release()
    await rig.finished
    expect(rig.adapter.spawned.find((task) => task.nodeId === 'b')?.prompt).toBe('plan.md#b-amended')
  })

  it('refuses for a node parked on capacity or on a human, and says which', async () => {
    const { journal } = store()
    const wf = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }])
    journal.createRun(RUN_ID, wf)

    for (const [status, phrase] of [
      ['waiting_on_capacity', 'waiting on harness capacity'],
      ['awaiting_human', 'paused on a human question'],
    ] as const) {
      const result = await amendRun({
        journal,
        runId: RUN_ID,
        proposed: edit(wf, 'a', { prompt_ref: `plan.md#a-${status}` }),
        runner: { statuses: () => ({ a: status }) },
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('applied')
      expect(result.code).toBe('nodes_in_flight')
      expect(result.issues[0]?.message).toContain(phrase)
    }
  })

  it('refuses a cycle with a located issue, before it can reach the run', async () => {
    const { journal } = store()
    const wf = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }])
    journal.createRun(RUN_ID, wf)

    const result = await amendRun({
      journal,
      runId: RUN_ID,
      // `a` now depends on `b`, which already depends on `a`.
      proposed: edit(wf, 'a', { depends_on: [dep('b')] }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('invalid_workflow')
    expect(result.issues.map((issue) => issue.path)).toContainEqual(['nodes'])
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain('dependency cycle')
  })

  it('refuses removing a node others still depend on, and one that has already run', async () => {
    const { journal } = store()
    const wf = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }])
    journal.createRun(RUN_ID, wf)
    journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'done' } })

    // Dropping `a` while `b` still names it is refused by the same validator
    // the executor uses, located at the dangling edge.
    const dangling = await amendRun({
      journal,
      runId: RUN_ID,
      proposed: { ...wf, nodes: [wf.nodes[1]] },
    })
    expect(dangling.ok).toBe(false)
    if (dangling.ok) throw new Error('applied')
    expect(dangling.code).toBe('invalid_workflow')
    expect(dangling.issues.map((issue) => issue.path)).toContainEqual([
      'nodes',
      0,
      'depends_on',
      0,
      'node',
    ])

    // Dropping `a` *and* the edge into it is a legal workflow — and is still
    // refused, because `a` already ran and its branch is the record of it.
    const orphaned = await amendRun({
      journal,
      runId: RUN_ID,
      proposed: { ...wf, nodes: [{ ...wf.nodes[1], depends_on: [] }] },
    })
    expect(orphaned.ok).toBe(false)
    if (orphaned.ok) throw new Error('applied')
    expect(orphaned.code).toBe('node_removed_after_start')
    expect(orphaned.issues[0]?.message).toContain('node "a"')
    expect(orphaned.issues[0]?.path).toEqual(['nodes', 0])
  })

  it('refuses a rewrite of a node that is already done, and points at the forward path', async () => {
    const { journal } = store()
    const wf = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }])
    journal.createRun(RUN_ID, wf)
    journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'done' } })

    const result = await amendRun({
      journal,
      runId: RUN_ID,
      proposed: edit(wf, 'a', { prompt_ref: 'plan.md#a-rewritten' }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('body_changed_after_done')
    expect(result.issues[0]?.message).toContain('add a node that depends on it')
  })

  it('refuses to move a done node when the run has no worktree to rebase in', async () => {
    const { journal } = store()
    const wf = workflow([{ id: 'a' }, { id: 'b' }, { id: 'c', deps: ['a'] }])
    journal.createRun(RUN_ID, wf)
    for (const id of ['a', 'b', 'c']) {
      journal.append({ runId: RUN_ID, nodeId: id, type: 'node_status', payload: { status: 'done' } })
    }

    const result = await amendRun({
      journal,
      runId: RUN_ID,
      proposed: edit(wf, 'c', { depends_on: [dep('a'), dep('b')] }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('rebase_unavailable')
    expect(result.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('node "c"'),
    ])
  })

  it('refuses to rebase a done node onto a dependency that has not completed', async () => {
    const { journal } = store()
    const wf = workflow([{ id: 'a' }, { id: 'b' }, { id: 'c', deps: ['a'] }])
    journal.createRun(RUN_ID, wf)
    for (const id of ['a', 'c']) {
      journal.append({ runId: RUN_ID, nodeId: id, type: 'node_status', payload: { status: 'done' } })
    }

    const result = await amendRun({
      journal,
      runId: RUN_ID,
      proposed: edit(wf, 'c', { depends_on: [dep('a'), dep('b')] }),
      runner: { rebase: async () => {} },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('applied')
    expect(result.code).toBe('dependency_not_done')
    expect(result.issues[0]?.path).toEqual(['nodes', 2, 'depends_on', 1, 'node'])
  })
})

// ---------------------------------------------------------------------------
// 3: the rebase, against real git
// ---------------------------------------------------------------------------

/**
 * What a test that drives real git gets instead of Vitest's 5s default.
 *
 * The same number, and the same reason, as `cli.test.ts` and `executor.test.ts`:
 * these two suites create repositories under `tmpdir()`, commit into them and
 * rebase branches across them, and on a machine running the other 53 test files
 * beside them that is regularly slower than five seconds. The number is not a
 * performance budget — it is the point past which "slow" becomes "stuck", so a
 * real deadlock still fails, just later.
 */
const REAL_GIT_TIMEOUT_MS = 30_000

describe('rebasing the done nodes', () => {
  it('rebases the closure in topological order, not declaration order', async () => {
    const rig = gitRig()
    // Declaration order is `e, c, a, d, b`; the queue must be `c, d, e`.
    expect(rig.workflow.nodes.map((node) => node.id)).toEqual(['e', 'c', 'a', 'd', 'b'])

    const result = await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: edit(rig.workflow, 'c', { depends_on: [dep('a'), dep('b')] }),
      runner: rig.runner,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.affected).toEqual(['c', 'd', 'e'])
    expect(result.rebased).toEqual(['c', 'd', 'e'])
    // The order git was actually driven in, not just the order that was planned.
    expect(rig.order).toEqual(['c', 'd', 'e'])
    // `a` and `b` are upstream of the change and were never touched.
    expect(result.changes).toEqual([{ node: 'c', kind: 'dependency_added' }])
  })

  it('rebuilds the `integ-` base before the node that sits on it', async () => {
    const rig = gitRig()
    const branch = (id: string) => `plan/wf/phase-${id}`

    // Before: `c` is cut from `a` alone, and knows nothing of `b`.
    expect(isAncestor(rig.integ, branch('b'), branch('c'))).toBe(false)
    expect(existsSync(join(rig.integ, '.git'))).toBe(true)

    const result = await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: edit(rig.workflow, 'c', { depends_on: [dep('a'), dep('b')] }),
      runner: rig.runner,
    })
    expect(result.ok).toBe(true)

    // The `integ-c` branch merges both dependencies…
    expect(isAncestor(rig.integ, branch('a'), 'plan/wf/integ-c')).toBe(true)
    expect(isAncestor(rig.integ, branch('b'), 'plan/wf/integ-c')).toBe(true)
    // …and `c` sits on top of it, which is only possible if it was built first.
    expect(isAncestor(rig.integ, 'plan/wf/integ-c', branch('c'))).toBe(true)
    // The dependents followed, so `b`'s work reaches the bottom of the chain.
    expect(isAncestor(rig.integ, branch('c'), branch('d'))).toBe(true)
    expect(isAncestor(rig.integ, branch('d'), branch('e'))).toBe(true)
    expect(isAncestor(rig.integ, branch('b'), branch('e'))).toBe(true)
    // Every phase's own commit is reachable exactly once — a rebase that
    // replayed a range twice would show up here as a duplicate.
    const subjects = git(rig.integ, 'log', '--format=%s', branch('e')).split('\n')
    for (const id of PHASES) {
      expect([id, subjects.filter((subject) => subject === `phase ${id}`).length]).toEqual([id, 1])
    }
    // …and the `integ-` merge is the only merge in the chain (§8: `--no-ff`).
    expect(subjects.filter((subject) => subject.startsWith('Merge branch'))).toEqual([
      "Merge branch 'plan/wf/phase-b' into plan/wf/integ-c",
    ])
  })

  it('records the moved base on the node it moved', async () => {
    const rig = gitRig()
    await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: edit(rig.workflow, 'c', { depends_on: [dep('a'), dep('b')] }),
      runner: rig.runner,
    })

    const bases = Object.fromEntries(
      rig.journal.nodes(RUN_ID).map((row) => [row.node_id, row.base_branch]),
    )
    expect(bases['c']).toBe('plan/wf/integ-c')
    expect(bases['d']).toBe('plan/wf/phase-c')
    expect(bases['a']).toBe('main')
  })
}, REAL_GIT_TIMEOUT_MS)

// ---------------------------------------------------------------------------
// 4: the durable record
// ---------------------------------------------------------------------------

describe('journalling an amendment', () => {
  it('records what moved, keeps the superseded snapshot, and replaces the frozen one', async () => {
    const rig = gitRig()
    const before = JSON.stringify(rig.journal.readWorkflow(RUN_ID))

    const result = await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: edit(rig.workflow, 'c', { depends_on: [dep('a'), dep('b')] }),
      runner: rig.runner,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.amendment).toBe(1)

    const amended = rig.journal
      .events(RUN_ID)
      .filter((event) => event.type === 'workflow_amended')
      .map((event) => event.payload)
    expect(amended).toEqual([
      {
        amendment: 1,
        changes: [{ node: 'c', kind: 'dependency_added' }],
        affected: ['c', 'd', 'e'],
        applied: [],
        rebased: ['c', 'd', 'e'],
        superseded: join('amendments', '1.json'),
      },
    ])

    // The run's definition moved…
    expect(rig.journal.readWorkflow(RUN_ID).nodes.find((n) => n.id === 'c')?.depends_on).toEqual([
      dep('a'),
      dep('b'),
    ])
    // …and the version it replaced is still on disk, where the row points.
    const kept = join(
      rig.journal.root,
      'runs',
      RUN_ID,
      'amendments',
      '1.json',
    )
    expect(JSON.parse(readFileSync(kept, 'utf8'))).toEqual(JSON.parse(before))
  })

  it('leaves the projections derivable from `events` alone', async () => {
    const rig = gitRig()
    await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: edit(rig.workflow, 'c', { depends_on: [dep('a'), dep('b')] }),
      runner: rig.runner,
    })

    const nodes = rig.journal.nodes(RUN_ID)
    const run = rig.journal.run(RUN_ID)
    // Nothing reads the snapshot during a rebuild (§5.3), so removing it must
    // change nothing about what replaying the log produces.
    rmSync(join(rig.journal.root, 'runs', RUN_ID, 'workflow.json'))
    rig.journal.rebuildProjections()

    expect(rig.journal.nodes(RUN_ID)).toEqual(nodes)
    expect(rig.journal.run(RUN_ID)).toEqual(run)
    expect(nodes.map((row) => row.status)).toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('registers a node the amendment adds, so the projection knows about it', async () => {
    const wf = workflow([{ id: 'a' }, { id: 'b', deps: ['a'] }])
    const rig = schedulerRig(wf)
    await until(() => rig.stall.live(), 'node a to be running')

    const amended = WorkflowSchema.parse({
      ...wf,
      nodes: [...wf.nodes, { id: 'c', name: 'Phase c', prompt_ref: 'plan.md#c', depends_on: [dep('b')] }],
    })
    const result = await amendRun({
      journal: rig.journal,
      runId: RUN_ID,
      proposed: amended,
      runner: rig.runner,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('refused')
    expect(result.applied).toEqual(['c'])

    expect(rig.journal.nodes(RUN_ID).map((row) => row.node_id)).toEqual(['a', 'b', 'c'])
    expect(rig.journal.nodes(RUN_ID).find((row) => row.node_id === 'c')?.wave).toBe(3)

    rig.stall.release()
    await rig.finished
    // The node the run gained actually ran.
    expect(rig.adapter.spawned.map((task) => task.nodeId)).toEqual(['a', 'b', 'c'])
    expect(rig.scheduler.statuses['c']).toBe('done')
  })
}, REAL_GIT_TIMEOUT_MS)
