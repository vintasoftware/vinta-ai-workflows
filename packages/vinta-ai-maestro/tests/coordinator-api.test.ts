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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CoordinatorForbidden, type Actor } from '../src/coordinator/actor.ts'
import { execPort, type ExecPort } from '../src/coordinator/exec.ts'
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
}

/** A `RunControl` that records who asked, which is the one thing these tests are about. */
function actorControl(): RunControl & { readonly calls: ActorCall[] } {
  const calls: ActorCall[] = []
  return {
    calls,
    statuses: { a: 'running', b: 'pending' },
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

async function call(
  daemon: Daemon,
  path: string,
  options: { readonly method?: string; readonly token?: string | null; readonly body?: unknown } = {},
): Promise<Result> {
  const token = options.token === undefined ? daemon.token : options.token
  const response = await fetch(`${daemon.url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
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
  /** Ending the run is a decision about the whole of it, and the coordinator lives inside it. */
  it('cannot pause or stop the run; the operator still can', async () => {
    const r = await rig()
    const modes: string[] = []
    r.register({
      halt: async (mode) => {
        modes.push(mode)
      },
    })

    for (const verb of ['pause', 'stop']) {
      const refused = await call(r.daemon, `/api/runs/${RUN_ID}/${verb}`, {
        method: 'POST',
        token: r.daemon.coordinatorToken,
        body: {},
      })
      expect(refused.status).toBe(403)
      expect(ErrorResponseSchema.parse(refused.body).error).toBe('coordinator_forbidden')
    }
    expect(modes).toEqual([])

    expect((await call(r.daemon, `/api/runs/${RUN_ID}/pause`, { method: 'POST', body: {} })).status).toBe(202)
    expect((await call(r.daemon, `/api/runs/${RUN_ID}/stop`, { method: 'POST', body: {} })).status).toBe(202)
    expect(modes).toEqual(['paused', 'cancelled'])
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
