/**
 * The run coordinator's side of the daemon API, driven over a real socket.
 *
 * The coordinator reaches a run through the same routes the operator does,
 * with a token of its own. What is under test is that the token is the whole
 * of the distinction: it is what attributes an operation to the coordinator,
 * and it is what every limit on the coordinator is enforced against — at the
 * route, not in the coordinator's brief.
 *
 * Every daemon here is closed in `afterEach`, on the failure paths too, as in
 * `daemon.test.ts`; the small helpers are copied from there rather than
 * imported, so one suite's rig can change without breaking another's.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CoordinatorForbidden, type Actor } from '../src/coordinator/actor.ts'
import { execPort, resolveExecTarget, type ExecPort } from '../src/coordinator/exec.ts'
import { AgentLeaseBroker, MAESTRO_NODE_ENV, MAESTRO_TURN_ENV } from '../src/resources/agent-leases.ts'
import {
  AmendResponseSchema,
  ErrorResponseSchema,
  runControl,
  startDaemon,
  type Daemon,
  type RunControl,
} from '../src/daemon/index.ts'
import type { DaemonRun } from '../src/daemon/control.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'
import { REASON_HEADER } from '../src/daemon/schemas.ts'
import { ReassignRefused, StepRefused } from '../src/scheduler/index.ts'

const RUN_ID = 'run-1'

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

function makeWorkflow(): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'coordinator-flow',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'solo' },
    resources: {
      lane: { capacity: 2, kind: 'worktree' },
      'test-suite': { capacity: 1, kind: 'semaphore' },
    },
    gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
    nodes: [
      { id: 'a', name: 'A', prompt_ref: 'plan.md#a', gates: ['unit'] },
      {
        id: 'b',
        name: 'B',
        prompt_ref: 'plan.md#b',
        gates: ['unit'],
        depends_on: [{ node: 'a', artifact: "a's model" }],
      },
    ],
    pipelines: { solo: SOLO },
  })
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface ActorCall {
  readonly op: string
  readonly nodeId: string
  readonly actor: Actor | undefined
  /** Present only on the phase-control verbs, whose tests are about it. */
  readonly reason?: string | undefined
  readonly detail?: unknown
}

/** A `RunControl` that records who asked, which is the one thing these tests are about. */
function actorControl(): RunControl & { readonly calls: ActorCall[] } {
  const calls: ActorCall[] = []
  return {
    calls,
    statuses: { a: 'running', b: 'pending' },
    interrupt: (nodeId, actor, reason) => {
      calls.push({ op: 'interrupt', nodeId, actor, reason })
      return 'sent'
    },
    reassign: (nodeId, target, options) => {
      if (target.crew === 'busy') throw new ReassignRefused('crew member "busy" is working on another phase')
      calls.push({ op: 'reassign', nodeId, actor: options?.actor, reason: options?.reason, detail: { target, when: options?.when } })
      return 'sent'
    },
    step: (nodeId, to, actor, reason) => {
      if (to === 'done') throw new StepRefused('"done" is a final state; the gates decide when a phase is done')
      calls.push({ op: 'step', nodeId, actor, reason, detail: to })
      return 'delivered'
    },
    switchHarness: async (from, to, model, options) => {
      calls.push({ op: 'switchHarness', nodeId: '', actor: options?.actor, reason: options?.reason, detail: { from, to, model } })
      return ['a']
    },
    answer: (nodeId, _facts, actor) => {
      calls.push({ op: 'answer', nodeId, actor })
    },
    addContext: (nodeId, _text, actor) => {
      calls.push({ op: 'addContext', nodeId, actor })
    },
    redirect: (nodeId, _instruction, actor) => {
      calls.push({ op: 'redirect', nodeId, actor })
    },
    pause: (nodeId, actor) => {
      calls.push({ op: 'pause', nodeId, actor })
    },
    abortNode: (nodeId, actor) => {
      calls.push({ op: 'abortNode', nodeId, actor })
    },
    freshSession: (nodeId, actor) => {
      calls.push({ op: 'freshSession', nodeId, actor })
    },
  }
}

interface Rig {
  readonly daemon: Daemon
  readonly journal: Journal
  readonly control: RunControl & { readonly calls: ActorCall[] }
  readonly dir: string
  /** Re-registers the run with these extra ports, keeping the control. */
  register(extra?: Partial<DaemonRun>): void
}

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-coordinator-'))
  const journal = openJournal(dir)
  const workflow = makeWorkflow()
  journal.createRun(RUN_ID, workflow)

  const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
  const control = actorControl()
  const daemon = await startDaemon({ journal, pollMs: 5, warn: () => {} })
  const register = (extra: Partial<DaemonRun> = {}): void => {
    daemon.register({
      runId: RUN_ID,
      control,
      pools,
      admission: { ceiling: () => 4, inFlight: () => 1, wakeAt: () => undefined },
      ...extra,
    })
  }
  register()

  cleanups.push(async () => {
    await daemon.close()
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { daemon, journal, control, dir, register }
}

interface Result {
  readonly status: number
  readonly body: unknown
}

/**
 * One request. The coordinator's carry a reason unless `reason: null` says
 * otherwise — it is refused without one — and an operator's carry one only
 * when given.
 */
async function call(
  daemon: Daemon,
  path: string,
  options: {
    readonly method?: string
    readonly token?: string | null
    readonly body?: unknown
    readonly reason?: string | null
  } = {},
): Promise<Result> {
  const token = options.token === undefined ? daemon.token : options.token
  const reason =
    options.reason === undefined ? (token === daemon.coordinatorToken ? 'the coordinator’s reason' : null) : options.reason
  const response = await fetch(`${daemon.url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(reason === null ? {} : { [REASON_HEADER]: encodeURIComponent(reason) }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: await response.json() }
}

/** An exec answer, read to its end and split into its NDJSON frames. */
async function exec(
  daemon: Daemon,
  body: unknown,
  token: string,
): Promise<{ readonly status: number; readonly frames: Record<string, unknown>[] }> {
  const response = await fetch(`${daemon.url}/api/runs/${RUN_ID}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const frames = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { status: response.status, frames }
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

describe('who is asking', () => {
  const operations = [
    { path: 'context', body: { text: 'stop rerunning the suite' }, op: 'addContext' },
    { path: 'redirect', body: { instruction: 'use the fixture' }, op: 'redirect' },
    { path: 'pause', body: {}, op: 'pause' },
    { path: 'abort', body: {}, op: 'abortNode' },
    { path: 'fresh', body: {}, op: 'freshSession' },
    { path: 'answer', body: { answer: 'retry' }, op: 'answer' },
  ] as const

  for (const operation of operations) {
    /**
     * The scheduler decides what the coordinator may do from the actor it is
     * handed, so a route that dropped it would let the coordinator act as the
     * operator with no error anywhere.
     */
    it(`${operation.op} carries the actor its token names`, async () => {
      const r = await rig()
      const path = `/api/runs/${RUN_ID}/nodes/a/${operation.path}`

      const asCoordinator = await call(r.daemon, path, {
        method: 'POST',
        token: r.daemon.coordinatorToken,
        body: operation.body,
      })
      const asOperator = await call(r.daemon, path, { method: 'POST', body: operation.body })

      expect(asCoordinator.status).toBe(200)
      expect(asOperator.status).toBe(200)
      expect(r.control.calls).toEqual([
        { op: operation.op, nodeId: 'a', actor: 'coordinator' },
        { op: operation.op, nodeId: 'a', actor: 'operator' },
      ])
    })
  }

  /** Every decision the coordinator makes unattended has to say why, so it can be listed with it. */
  it('refuses the coordinator without a reason, and not the operator', async () => {
    const r = await rig()
    const path = `/api/runs/${RUN_ID}/nodes/a/pause`
    const refused = await call(r.daemon, path, { method: 'POST', token: r.daemon.coordinatorToken, body: {}, reason: null })
    expect(refused.status).toBe(400)
    expect(ErrorResponseSchema.parse(refused.body).error).toBe('reason_required')
    expect(r.control.calls).toEqual([])
    expect((await call(r.daemon, path, { method: 'POST', body: {} })).status).toBe(200)
  })

  /** A second accepted token must not widen the check to "any token at all". */
  it('still refuses a token that is neither', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/context`, {
      method: 'POST',
      token: 'not-a-token',
      body: { text: 'hello' },
    })
    expect(result.status).toBe(401)
    expect(ErrorResponseSchema.parse(result.body).error).toBe('unauthorized')
    expect(r.control.calls).toEqual([])
  })

  /**
   * The coordinator reads `coordinator_forbidden` to know to stop asking; a
   * generic `operation_failed` would read as "try again".
   */
  it('answers a refusal of the coordinator with its own code', async () => {
    const r = await rig()
    r.register({
      control: runControl({
        statuses: {},
        answer: (_nodeId, _facts, actor) => {
          if (actor === 'coordinator') throw new CoordinatorForbidden('the question is not one a timer answers')
        },
      }),
    })

    const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/answer`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: { answer: 'retry' },
    })
    expect(result.status).toBe(403)
    expect(ErrorResponseSchema.parse(result.body)).toEqual({ error: 'coordinator_forbidden', issues: null })

    // The same answer from the operator goes through.
    const operator = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/answer`, {
      method: 'POST',
      body: { answer: 'retry' },
    })
    expect(operator.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// What only the operator may do
// ---------------------------------------------------------------------------

describe('what the coordinator may not do', () => {
  /**
   * A pause is resumable and runs nothing twice that a resume would not, so
   * the coordinator may; a stop is final, and is the operator's unless they
   * gave it full authority. Both are journalled with who asked and why.
   */
  it('may pause the run, and stop it only under full authority', async () => {
    const r = await rig()
    const modes: string[] = []
    const halt = async (mode: 'paused' | 'cancelled'): Promise<void> => {
      modes.push(mode)
    }
    r.register({ halt })

    const stop = () =>
      call(r.daemon, `/api/runs/${RUN_ID}/stop`, {
        method: 'POST',
        token: r.daemon.coordinatorToken,
        body: {},
        reason: 'every phase is blocked on the same broken fixture',
      })
    const refused = await stop()
    expect(refused.status).toBe(403)
    expect(ErrorResponseSchema.parse(refused.body).error).toBe('coordinator_forbidden')

    const paused = await call(r.daemon, `/api/runs/${RUN_ID}/pause`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: {},
      reason: 'the database container is down',
    })
    expect(paused.status).toBe(202)
    expect(modes).toEqual(['paused'])
    expect(r.journal.events(RUN_ID).find((event) => event.type === 'run_halt_requested')?.payload).toEqual({
      mode: 'paused',
      by: 'coordinator',
      reason: 'the database container is down',
    })

    r.register({ halt, coordinatorAuthority: 'full' })
    expect((await stop()).status).toBe(202)
    expect(modes).toEqual(['paused', 'cancelled'])

    expect((await call(r.daemon, `/api/runs/${RUN_ID}/stop`, { method: 'POST', body: {} })).status).toBe(202)
  })

  /** The plan documents are reviewed source; the coordinator amends the live run through `/amend`. */
  it('cannot save a workflow document', async () => {
    const r = await rig()
    const result = await call(r.daemon, '/api/workflows/coordinator-flow', {
      method: 'PUT',
      token: r.daemon.coordinatorToken,
      body: r.journal.readWorkflow(RUN_ID),
    })
    expect(result.status).toBe(403)
    expect(ErrorResponseSchema.parse(result.body).error).toBe('coordinator_forbidden')
  })
})

// ---------------------------------------------------------------------------
// Amending
// ---------------------------------------------------------------------------

describe('a coordinator amendment', () => {
  async function amendable() {
    const r = await rig()
    const adopted: Workflow[] = []
    r.register({ amend: { adopt: (workflow) => adopted.push(workflow) } })
    return { r, adopted, base: r.journal.readWorkflow(RUN_ID) }
  }

  const amended = (r: Rig) => r.journal.events(RUN_ID).filter((event) => event.type === 'workflow_amended')

  /**
   * What the plan builds is the operator's. The refusal names the path, so a
   * coordinator that tried two things at once learns which one was wrong.
   */
  it('is refused, located, when it adds a phase or drops a gate', async () => {
    const { r, adopted, base } = await amendable()
    const proposal = {
      ...base,
      nodes: [
        base.nodes[0],
        { ...base.nodes[1], gates: [] },
        { id: 'c', name: 'C', prompt_ref: 'plan.md#c', gates: ['unit'] },
      ],
    }

    const result = await call(r.daemon, `/api/runs/${RUN_ID}/amend`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: proposal,
    })
    expect(result.status).toBe(409)
    const body = ErrorResponseSchema.parse(result.body)
    expect(body.error).toBe('coordinator_forbidden')
    expect(body.issues?.map((issue) => issue.path)).toEqual(expect.arrayContaining(['nodes.c', 'nodes.b.gates']))
    // Refused means nothing moved.
    expect(adopted).toEqual([])
    expect(amended(r)).toEqual([])
    expect(r.journal.readWorkflow(RUN_ID).nodes.map((node) => node.id)).toEqual(['a', 'b'])
  })

  /**
   * Full authority reaches the plan's shape — a phase added, a phase split —
   * and still never a check: the dropped gate is refused just the same.
   */
  it('may add a phase under full authority, and still may not drop a gate', async () => {
    const { r, adopted, base } = await amendable()
    r.register({ amend: { adopt: (workflow) => adopted.push(workflow) }, coordinatorAuthority: 'full' })
    const phase = { id: 'c', name: 'C', prompt_ref: 'plan.md#c', gates: ['unit'] }

    const weakened = await call(r.daemon, `/api/runs/${RUN_ID}/amend`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: { ...base, nodes: [base.nodes[0], { ...base.nodes[1], gates: [] }, phase] },
    })
    expect(weakened.status).toBe(409)
    expect(ErrorResponseSchema.parse(weakened.body).issues?.map((issue) => issue.path)).toEqual(['nodes.b.gates'])

    const split = await call(r.daemon, `/api/runs/${RUN_ID}/amend`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: { ...base, nodes: [...base.nodes, phase] },
      reason: 'b is two phases: the model and its admin',
    })
    expect(split.status).toBe(200)
    expect(amended(r)[0]?.payload).toMatchObject({
      author: 'coordinator',
      reason: 'b is two phases: the model and its admin',
    })
  })

  /** The same proposal from the operator is a policy-free amendment, so the refusal above is the token's. */
  it('lets the operator make the change the coordinator may not', async () => {
    const { r, base } = await amendable()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/amend`, {
      method: 'POST',
      body: { ...base, nodes: [base.nodes[0], { ...base.nodes[1], gates: [] }] },
    })
    expect(result.status).toBe(200)
  })

  /**
   * How the run executes is the coordinator's, and the record says it was the
   * coordinator who changed it — the post-mortem reads `author` to tell its
   * edits from the operator's.
   */
  it('applies a model change and journals the coordinator as its author', async () => {
    const { r, adopted, base } = await amendable()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/amend`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: { ...base, nodes: [base.nodes[0], { ...base.nodes[1], model: 'sonnet' }] },
    })

    expect(result.status).toBe(200)
    expect(AmendResponseSchema.parse(result.body)).toMatchObject({ ok: true, runId: RUN_ID, applied: ['b'] })
    expect(adopted.map((workflow) => workflow.nodes[1]?.model)).toEqual(['sonnet'])
    expect(r.journal.readWorkflow(RUN_ID).nodes[1]?.model).toBe('sonnet')
    const events = amended(r)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ author: 'coordinator' })
  })
})

// ---------------------------------------------------------------------------
// Taking a phase over, and the conflict fixer
// ---------------------------------------------------------------------------

describe('phase control', () => {
  it('interrupts, reassigns and steps a phase for either caller, with the actor and the reason', async () => {
    const r = await rig()
    const base = `/api/runs/${RUN_ID}/nodes/a`
    const post = (path: string, body: unknown, coordinator = true) =>
      call(r.daemon, `${base}/${path}`, {
        method: 'POST',
        body,
        ...(coordinator ? { token: r.daemon.coordinatorToken, reason: 'a is looping' } : {}),
      })

    expect((await post('interrupt', {})).body).toEqual({ ok: true, delivery: 'sent' })
    expect((await post('reassign', { harness: 'codex', model: 'gpt-5', when: 'after_turn' })).status).toBe(200)
    expect((await post('step', { to: 'verify' }, false)).body).toEqual({ ok: true, delivery: 'delivered' })

    expect(r.control.calls).toEqual([
      { op: 'interrupt', nodeId: 'a', actor: 'coordinator', reason: 'a is looping' },
      {
        op: 'reassign',
        nodeId: 'a',
        actor: 'coordinator',
        reason: 'a is looping',
        detail: { target: { harness: 'codex', model: 'gpt-5' }, when: 'after_turn' },
      },
      { op: 'step', nodeId: 'a', actor: 'operator', reason: undefined, detail: 'verify' },
    ])
  })

  it('says what a reassignment or a step could not do, located by code', async () => {
    const r = await rig()
    const busy = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/reassign`, { method: 'POST', body: { crew: 'busy' } })
    expect(busy.status).toBe(409)
    expect(ErrorResponseSchema.parse(busy.body)).toEqual({
      error: 'reassign_refused',
      issues: [{ path: '', code: 'reassign_refused', message: 'crew member "busy" is working on another phase' }],
    })
    const final = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/step`, { method: 'POST', body: { to: 'done' } })
    expect(ErrorResponseSchema.parse(final.body).error).toBe('step_refused')
    const empty = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/reassign`, { method: 'POST', body: {} })
    expect(empty.status).toBe(400)
  })

  it('switches the run off a harness and answers with the phases it moved', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/switch-harness`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: { from: 'codex', to: 'claude-code', model: 'opus' },
      reason: 'codex is out of credits',
    })
    expect(result).toEqual({ status: 200, body: { ok: true, moved: ['a'] } })
    expect(r.control.calls).toEqual([
      {
        op: 'switchHarness',
        nodeId: '',
        actor: 'coordinator',
        reason: 'codex is out of credits',
        detail: { from: 'codex', to: 'claude-code', model: 'opus' },
      },
    ])
  })

  it('ends and re-staffs the conflict fixer’s round, and journals who and why', async () => {
    const r = await rig()
    const asked: unknown[] = []
    r.register({
      fixer: {
        interrupt: async () => true,
        reassign: async (harness, model, now) => {
          asked.push({ harness, model, now })
          return now
        },
        running: () => ({ harness: 'codex', model: 'gpt-5' }),
      },
    })

    const ended = await call(r.daemon, `/api/runs/${RUN_ID}/fixer/reassign`, {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: { harness: 'claude-code', model: 'opus' },
      reason: 'the fixer keeps undoing the rename',
    })
    expect(ended).toEqual({ status: 200, body: { ok: true, ended: true } })
    expect(asked).toEqual([{ harness: 'claude-code', model: 'opus', now: true }])
    expect(r.journal.events(RUN_ID).find((event) => event.type === 'fixer_operation')?.payload).toEqual({
      op: 'reassign',
      ended: true,
      from: { harness: 'codex', model: 'gpt-5' },
      to: { harness: 'claude-code', model: 'opus' },
      by: 'coordinator',
      reason: 'the fixer keeps undoing the rename',
    })
    expect((await call(r.daemon, `/api/runs/${RUN_ID}/fixer/interrupt`, { method: 'POST', body: {} })).body).toEqual({
      ok: true,
      ended: true,
    })
  })
})

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('exec', () => {
  /** A lane workspace over a temp directory, carrying an env var only the lane has. */
  function laneExec(): { readonly port: ExecPort; readonly path: string } {
    const path = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-lane-'))
    cleanups.push(() => rmSync(path, { recursive: true, force: true }))
    const port = execPort({
      workspace: (target) => (target === 'lane-1' ? { path, env: { PROBE: 'lane-env' } } : null),
    })
    return { port, path }
  }

  const PROBE = 'node -e "process.stdout.write(process.env.PROBE); process.exit(3)"'

  /**
   * The point of exec is the lane's environment, not the caller's: a probe
   * that printed anything but the lane's value would be the wrong-database bug
   * this route exists to prevent. The exit code is the command's own.
   */
  it('runs the command in the lane, streams its output, and journals who ran it', async () => {
    const r = await rig()
    r.register({ exec: laneExec().port })

    const result = await exec(r.daemon, { target: 'lane-1', command: PROBE }, r.daemon.coordinatorToken)

    expect(result.status).toBe(200)
    const output = result.frames.flatMap((frame) => (typeof frame.output === 'string' ? [frame.output] : []))
    expect(output.join('')).toBe('lane-env')
    expect(result.frames.at(-1)).toEqual({ exit: 3 })
    const journalled = r.journal.events(RUN_ID).filter((event) => event.type === 'workspace_exec')
    expect(journalled).toHaveLength(1)
    expect(journalled[0]?.payload).toMatchObject({ target: 'lane-1', exit_code: 3, by: 'coordinator' })
  })

  /** `by` marks the coordinator's commands; an operator's row carries none, like every pre-coordinator row. */
  it('leaves `by` off an operator’s command', async () => {
    const r = await rig()
    r.register({ exec: laneExec().port })

    await exec(r.daemon, { target: 'lane-1', command: PROBE }, r.daemon.token)

    const journalled = r.journal.events(RUN_ID).filter((event) => event.type === 'workspace_exec')
    expect(journalled).toHaveLength(1)
    expect(journalled[0]?.payload).not.toHaveProperty('by')
  })

  /** Refused before streaming starts, so the caller gets a status rather than a stream that ends oddly. */
  it('refuses a target the run does not have', async () => {
    const r = await rig()
    r.register({ exec: laneExec().port })
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/exec`, {
      method: 'POST',
      body: { target: 'lane-9', command: 'true' },
    })
    expect(result.status).toBe(404)
    expect(ErrorResponseSchema.parse(result.body).error).toBe('unknown_target')
    expect(r.journal.events(RUN_ID).filter((event) => event.type === 'workspace_exec')).toEqual([])
  })

  /**
   * `exec <run> crew-3-tier2-2` and `exec <run> p1` were both refused
   * `unknown_target`; only `<run-id>-crew-3-tier2-2` worked, and nothing said
   * so. The refusal now lists what the run has.
   */
  it('lists the run’s targets when it refuses one', async () => {
    const r = await rig()
    const port = execPort({
      workspace: () => null,
      targets: () => ['integration', `${RUN_ID}-crew-1 (crew-1, phase a)`],
    })
    r.register({ exec: port })

    const result = await call(r.daemon, `/api/runs/${RUN_ID}/exec`, {
      method: 'POST',
      body: { target: 'crew-9', command: 'true' },
    })

    expect(result.status).toBe(404)
    const body = ErrorResponseSchema.parse(result.body)
    expect(body.error).toBe('unknown_target')
    expect(JSON.stringify(body.issues)).toContain(`${RUN_ID}-crew-1 (crew-1, phase a)`)
  })

  /**
   * Inside `exec`, `vinta-ai-maestro with test-suite -- make test` said "no
   * live run is available" while the run was live: the command had the run's
   * address and token but no holder. An exec on an idle lane holds leases as
   * itself, for as long as it runs and no longer.
   */
  it('lets the command take a lease as itself while it runs, and not after', async () => {
    const r = await rig()
    const path = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-lane-'))
    cleanups.push(() => rmSync(path, { recursive: true, force: true }))
    const pools = new ResourcePools(makeWorkflow().resources, { agingMs: 0 })
    const ended: string[] = []
    const port = execPort({
      workspace: (target) => (target === 'lane-1' ? { path, env: {} } : null),
      onEnded: (holder) => ended.push(holder),
    })
    r.register({ exec: port, agentLeases: new AgentLeaseBroker(pools, r.journal, RUN_ID), pools })
    const lease = () =>
      call(r.daemon, `/api/runs/${RUN_ID}/leases`, {
        method: 'POST',
        token: r.daemon.agentToken,
        body: { resources: ['test-suite'], holderNode: 'exec:lane-1' },
      })

    expect((await lease()).status).toBeGreaterThanOrEqual(400)
    const running = exec(
      r.daemon,
      {
        target: 'lane-1',
        command: `node -e "process.stdout.write(process.env.${MAESTRO_NODE_ENV} + ' ' + (process.env.${MAESTRO_TURN_ENV} ? 'turn' : 'none')); setTimeout(() => {}, 1500)"`,
      },
      r.daemon.token,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const granted = await lease()
    const result = await running

    expect(granted.status).toBe(201)
    expect(result.frames.flatMap((frame) => (typeof frame.output === 'string' ? [frame.output] : [])).join('')).toBe(
      'exec:lane-1 turn',
    )
    expect(ended).toEqual(['exec:lane-1'])
    expect((await lease()).status).toBeGreaterThanOrEqual(400)
  })

  /**
   * A command queued behind the integration worktree used to send nothing
   * until it ran, so its client read the silence as a dead daemon, printed
   * "not live" and left, while the command ran later with nobody attached.
   */
  describe('queued behind the integration worktree', () => {
    function heldIntegration() {
      const path = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-integ-'))
      cleanups.push(() => rmSync(path, { recursive: true, force: true }))
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const port = execPort({
        workspace: (target) => (target === 'integration' ? { path, env: {} } : null),
        holdIntegration: async (_label, work) => {
          await held
          return work()
        },
        integrationHolder: () => 'p6',
      })
      return { port, path, release }
    }

    // Run in the worktree, so a relative path lands there.
    const marker = (_path: string) => `node -e "require('fs').writeFileSync('ran', 'x')"`

    it('says it was accepted and who it is queued behind before it runs, and journals the reason', async () => {
      const r = await rig()
      const { port, path, release } = heldIntegration()
      r.register({ exec: port })

      const response = await fetch(`${r.daemon.url}/api/runs/${RUN_ID}/exec`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${r.daemon.coordinatorToken}`,
          [REASON_HEADER]: encodeURIComponent('reset the test database'),
        },
        body: JSON.stringify({ target: 'integration', command: marker(path) }),
      })
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      let text = ''
      while (!text.includes('queued')) text += new TextDecoder().decode((await reader.read()).value)
      const early = text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
      expect(early[0]).toHaveProperty('accepted')
      expect(early[1]).toEqual({ queued: 'p6' })
      expect(existsSync(join(path, 'ran'))).toBe(false)

      release()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += new TextDecoder().decode(chunk.value)
      }
      expect(text).toContain('"running":true')
      expect(text).toContain('"exit":0')
      const journalled = r.journal.events(RUN_ID).filter((event) => event.type === 'workspace_exec')
      expect(journalled[0]?.payload).toMatchObject({ target: 'integration', reason: 'reset the test database', by: 'coordinator' })
    })

    it('lists a detached command and cancels it before it ever starts', async () => {
      const r = await rig()
      const { port, path, release } = heldIntegration()
      r.register({ exec: port })

      const started = await call(r.daemon, `/api/runs/${RUN_ID}/exec`, {
        method: 'POST',
        body: { target: 'integration', command: marker(path), detach: true },
      })
      expect(started.status).toBe(202)
      const id = (started.body as { id: string }).id
      const listed = await call(r.daemon, `/api/runs/${RUN_ID}/exec`)
      expect((listed.body as { execs: { id: string; state: string }[] }).execs).toEqual([
        expect.objectContaining({ id, state: 'queued', target: 'integration' }),
      ])

      const cancelled = await call(r.daemon, `/api/runs/${RUN_ID}/exec/${id}`, { method: 'DELETE' })
      expect(cancelled.body).toEqual({ id, cancelled: true, was: 'queued' })
      release()
      await until(() => r.journal.events(RUN_ID).some((event) => event.type === 'workspace_exec'))
      expect(existsSync(join(path, 'ran'))).toBe(false)
      const journalled = r.journal.events(RUN_ID).find((event) => event.type === 'workspace_exec')
      expect(journalled?.payload).toMatchObject({ id, cancelled: true })
      expect(((await call(r.daemon, `/api/runs/${RUN_ID}/exec`)).body as { execs: unknown[] }).execs).toEqual([])
    })

    it('cancels a queued command whose client went away', async () => {
      const r = await rig()
      const { port, path, release } = heldIntegration()
      r.register({ exec: port })

      const gone = new AbortController()
      const response = await fetch(`${r.daemon.url}/api/runs/${RUN_ID}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${r.daemon.token}` },
        body: JSON.stringify({ target: 'integration', command: marker(path) }),
        signal: gone.signal,
      })
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      gone.abort()
      await new Promise((resolve) => setTimeout(resolve, 200))
      release()
      await until(() => r.journal.events(RUN_ID).some((event) => event.type === 'workspace_exec'))
      expect(existsSync(join(path, 'ran'))).toBe(false)
    })
  })

  /** A host with no worktrees to offer says so, rather than running the command somewhere it guessed. */
  it('refuses on a host with no exec port', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/exec`, {
      method: 'POST',
      body: { target: 'lane-1', command: 'true' },
    })
    expect(result.status).toBe(501)
    expect(ErrorResponseSchema.parse(result.body).error).toBe('exec_unsupported')
  })
})

describe('resolveExecTarget', () => {
  const lanes = [`${RUN_ID}-crew-1-a`, `${RUN_ID}-crew-3-tier2-2`]
  const phaseLanes = new Map([['p1', `${RUN_ID}-crew-3-tier2-2`]])

  it('takes the full name, the name without the run prefix, or a phase running in the lane', () => {
    const resolve = (target: string) => resolveExecTarget(target, { runId: RUN_ID, lanes, phaseLanes })
    expect(resolve(`${RUN_ID}-crew-3-tier2-2`)).toBe(`${RUN_ID}-crew-3-tier2-2`)
    expect(resolve('crew-3-tier2-2')).toBe(`${RUN_ID}-crew-3-tier2-2`)
    expect(resolve('p1')).toBe(`${RUN_ID}-crew-3-tier2-2`)
    expect(resolve('integration')).toBe('integration')
    expect(resolve('crew-9')).toBeNull()
  })
})

describe('execPort', () => {
  /**
   * The integration worktree is shared with wave merges and unattended
   * retries; a command run there must hold its queue for as long as it runs,
   * and the hold is labelled with who took it.
   */
  it('runs an integration command inside the integration hold, labelled with the actor', async () => {
    const path = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-integration-'))
    cleanups.push(() => rmSync(path, { recursive: true, force: true }))
    const labels: string[] = []
    let holding = false
    const outputWhileHeld: boolean[] = []
    const port = execPort({
      workspace: (target) => (target === 'integration' ? { path, env: {} } : null),
      holdIntegration: async (label, work) => {
        labels.push(label)
        holding = true
        try {
          return await work()
        } finally {
          holding = false
        }
      },
    })

    const code = await port.run(
      { target: 'integration', command: 'node -e "process.stdout.write(String(1))"', actor: 'coordinator' },
      () => outputWhileHeld.push(holding),
      new AbortController().signal,
    )

    expect(code).toBe(0)
    expect(labels).toEqual(['coordinator'])
    expect(outputWhileHeld.length).toBeGreaterThan(0)
    expect(outputWhileHeld.every(Boolean)).toBe(true)
  })

  /** A lane is the lane's alone, so taking the integration queue for it would stall merges for nothing. */
  it('does not hold the integration worktree for a lane command', async () => {
    const path = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-lane-'))
    cleanups.push(() => rmSync(path, { recursive: true, force: true }))
    const labels: string[] = []
    const port = execPort({
      workspace: () => ({ path, env: {} }),
      holdIntegration: async (label, work) => {
        labels.push(label)
        return await work()
      },
    })

    const code = await port.run(
      { target: 'lane-1', command: 'node -e "process.exit(0)"', actor: 'operator' },
      () => {},
      new AbortController().signal,
    )
    expect(code).toBe(0)
    expect(labels).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Forgetting a gate verdict (§13.4)
// ---------------------------------------------------------------------------

describe('gate cache invalidation', () => {
  const TREE = 'a'.repeat(40)

  /** Records what it was asked to forget, and says one entry went each time. */
  const recordingCache = () => {
    const calls: { gateId: string; tree: string | undefined }[] = []
    return {
      calls,
      invalidate: (gateId: string, tree?: string) => {
        calls.push({ gateId, tree })
        return 1
      },
    }
  }
  const path = (gate: string): string => `/api/runs/${RUN_ID}/gates/${gate}/invalidate`

  it('is the coordinator’s as well as the operator’s, and journals who asked', async () => {
    const r = await rig()
    const cache = recordingCache()
    r.register({ gateCache: cache })

    const byCoordinator = await call(r.daemon, path('unit'), {
      method: 'POST',
      token: r.daemon.coordinatorToken,
      body: { tree: TREE },
    })
    const byOperator = await call(r.daemon, path('unit'), { method: 'POST', body: {} })

    expect(byCoordinator).toEqual({ status: 200, body: { gate: 'unit', removed: 1 } })
    expect(byOperator.status).toBe(200)
    expect(cache.calls).toEqual([
      { gateId: 'unit', tree: TREE },
      { gateId: 'unit', tree: undefined },
    ])
    const rows = r.journal.events(RUN_ID).filter((event) => event.type === 'gate_cache_invalidated')
    expect(rows.map((event) => event.payload)).toEqual([
      { gate: 'unit', tree: TREE, removed: 1, by: 'coordinator', reason: 'the coordinator’s reason' },
      { gate: 'unit', removed: 1 },
    ])
  })

  it('is not an agent’s: its way past a stale verdict is `gate --no-cache`', async () => {
    const r = await rig()
    const cache = recordingCache()
    r.register({ gateCache: cache })

    const asAgent = await call(r.daemon, path('unit'), { method: 'POST', token: r.daemon.agentToken, body: {} })

    expect(asAgent.status).toBe(403)
    expect(cache.calls).toEqual([])
  })

  it('refuses an undeclared gate, a tree that is not an object id, and a host with no cache', async () => {
    const r = await rig()
    const unsupported = await call(r.daemon, path('unit'), { method: 'POST', body: {} })
    expect(unsupported.status).toBe(501)

    const cache = recordingCache()
    r.register({ gateCache: cache })
    const unknown = await call(r.daemon, path('nope'), { method: 'POST', body: {} })
    const badTree = await call(r.daemon, path('unit'), { method: 'POST', body: { tree: 'HEAD; rm -rf /' } })

    expect(ErrorResponseSchema.parse(unknown.body).error).toBe('unknown_gate')
    expect(badTree.status).toBe(400)
    expect(cache.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// propagate and sync-base on a live run
// ---------------------------------------------------------------------------

describe('branches', () => {
  /**
   * The CLI used to refuse a live run outright. Now its job does the merges,
   * and the route is the job's side of that: it hands the request to the
   * run's port and journals what moved, for the coordinator as for anyone.
   */
  it('hands propagate and sync-base to the run, and journals what moved', async () => {
    const r = await rig()
    const asked: unknown[] = []
    r.register({
      branches: {
        propagate: async (request) => {
          asked.push(request)
          return request.nodeId === 'a'
            ? { kind: 'done', steps: [{ branch: 'plan/x/wave-1', source: 'plan/x/phase-a' }], pushed: [] }
            : null
        },
        syncBase: async (request) => {
          asked.push(request)
          return {
            kind: 'conflict',
            done: [{ branch: 'plan/x/base', source: 'main' }],
            at: { branch: 'plan/x/wave-1', source: 'plan/x/base' },
            paths: ['uv.lock'],
          }
        },
      },
    })

    const carried = await call(r.daemon, `/api/runs/${RUN_ID}/branches/propagate`, {
      method: 'POST',
      body: { phase: 'a' },
      token: r.daemon.coordinatorToken,
    })
    expect(carried.status).toBe(200)
    expect(carried.body).toMatchObject({ kind: 'done' })
    const unknown = await call(r.daemon, `/api/runs/${RUN_ID}/branches/propagate`, { method: 'POST', body: { phase: 'zz' } })
    expect(unknown.status).toBe(404)
    const synced = await call(r.daemon, `/api/runs/${RUN_ID}/branches/sync-base`, { method: 'POST', body: { dryRun: false } })
    expect(synced.status).toBe(200)

    expect(asked).toEqual([
      { nodeId: 'a', dryRun: false, push: true },
      { nodeId: 'zz', dryRun: false, push: true },
      { dryRun: false, push: true },
    ])
    const rows = r.journal.events(RUN_ID).filter((event) => event.type === 'branches_moved')
    expect(rows.map((row) => row.payload)).toEqual([
      { op: 'propagate', node: 'a', moved: ['plan/x/wave-1'], outcome: 'done', by: 'coordinator' },
      { op: 'sync_base', moved: ['plan/x/base'], outcome: 'conflict', at: 'plan/x/wave-1', paths: ['uv.lock'] },
    ])
  })

  it('refuses a run whose host offers no branch port', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/branches/sync-base`, { method: 'POST', body: {} })
    expect(result.status).toBe(501)
    expect(ErrorResponseSchema.parse(result.body).error).toBe('branches_unsupported')
  })
})

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
