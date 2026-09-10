/**
 * The daemon, driven over a real socket.
 *
 * Everything here goes through the network: `fetch` against a listener bound
 * to `127.0.0.1:0`, and a real `ws` client against the same port. An in-process
 * `app.fetch(...)` would test the router and skip the two things this step
 * exists for — that the bind is loopback, and that an upgrade without a token
 * never becomes a WebSocket.
 *
 * Every port is OS-assigned and every server is closed in `afterEach`, on the
 * failure paths too: a suite that leaks listeners fails the next run for a
 * reason that has nothing to do with the code under test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { AdmissionControl } from '../src/admission/admission.ts'
import {
  ErrorResponseSchema,
  EventFrameSchema,
  FrameSchema,
  NodeDetailSchema,
  OkResponseSchema,
  RunListResponseSchema,
  RunSnapshotSchema,
  EventStream,
  startDaemon,
  runControl,
  type Daemon,
  type Frame,
  type RunControl,
} from '../src/daemon/index.ts'
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

/** Asks the operator, then branches on `human.answer` exactly as §9.1 says. */
const GATED = {
  states: [
    {
      id: 'gate',
      name: 'Gate',
      position: { x: 0, y: 0 },
      onEnter: [
        {
          id: 'e-ask',
          definitionId: 'await_human',
          params: {
            question: 'The branch is green. Ship it?',
            kind: 'choice',
            choices: ['ship', 'hold'],
            context: { diffRef: 'phase/a' },
          },
        },
      ],
    },
    {
      id: 'done',
      name: 'Done',
      position: { x: 200, y: 0 },
      // Runs after the answer, so the guard context it sees is the assertion
      // that `human.answer` really reached the pipeline.
      onEnter: [{ id: 'e-track', definitionId: 'write_tracking', params: { scope: 'phase' } }],
      data: { outcome: 'done' },
    },
  ],
  transitions: [{ id: 't-answered', from: 'gate', to: 'done', guard: "human.answer == 'ship'" }],
  initialStateIds: ['gate'],
  finalStateIds: ['done'],
}

function makeWorkflow(pipeline = 'solo'): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'daemon-flow',
    base_branch: 'main',
    defaults: { harness: HARNESS, model: 'opus', pipeline },
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
        depends_on: [{ node: 'a', artifact: "a's model" }],
      },
    ],
    pipelines: { solo: SOLO, gated: GATED },
  })
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface ControlCall {
  readonly op: string
  readonly nodeId: string
  readonly arg: unknown
}

/** A `RunControl` that records instead of running. Requirement 5's stand-in. */
function recordingControl(): RunControl & { readonly calls: ControlCall[] } {
  const calls: ControlCall[] = []
  const record = (op: string) => (nodeId: string, arg?: unknown) => {
    calls.push({ op, nodeId, arg: arg ?? null })
  }
  return {
    calls,
    statuses: { a: 'running', b: 'pending' },
    answer: record('answer'),
    addContext: record('addContext'),
    redirect: record('redirect'),
    pause: record('pause'),
    abortNode: record('abortNode'),
    question: (nodeId) =>
      nodeId === 'a'
        ? { question: 'Ship it?', kind: 'confirm' as const, context: { diffRef: 'phase/a' } }
        : undefined,
  }
}

interface Rig {
  readonly daemon: Daemon
  readonly journal: Journal
  readonly pools: ResourcePools
  readonly control: RunControl & { readonly calls: ControlCall[] }
  readonly dir: string
  readonly warnings: string[]
}

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function rig(
  options: {
    readonly host?: string
    readonly workflow?: Workflow
    readonly uiDir?: string
  } = {},
): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-daemon-'))
  const journal = openJournal(dir)
  const workflow = options.workflow ?? makeWorkflow()
  journal.createRun(RUN_ID, workflow)

  const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
  const control = recordingControl()
  const warnings: string[] = []
  const daemon = await startDaemon({
    journal,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.uiDir === undefined ? {} : { uiDir: options.uiDir }),
    pollMs: 5,
    warn: (message) => warnings.push(message),
  })
  daemon.register({
    runId: RUN_ID,
    control,
    pools,
    admission: { ceiling: () => 4, inFlight: () => 1, wakeAt: () => undefined },
  })

  cleanups.push(async () => {
    await daemon.close()
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { daemon, journal, pools, control, dir, warnings }
}

interface Result {
  readonly status: number
  readonly body: unknown
}

async function call(
  daemon: Daemon,
  path: string,
  options: {
    readonly method?: string
    readonly token?: string | null
    readonly body?: unknown
    readonly raw?: string
  } = {},
): Promise<Result> {
  const token = options.token === undefined ? daemon.token : options.token
  const response = await fetch(`${daemon.url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(options.raw !== undefined
      ? { body: options.raw }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: await response.json() }
}

type Connection = { readonly socket: WebSocket; readonly frames: Frame[] } | { readonly status: number }

/** Resolves with a live socket, or with the HTTP status the handshake was refused with. */
function connect(daemon: Daemon, query: string): Promise<Connection> {
  return new Promise<Connection>((resolve, reject) => {
    const socket = new WebSocket(`${daemon.url}/ws${query}`)
    const frames: Frame[] = []
    socket.on('message', (data) => frames.push(FrameSchema.parse(JSON.parse(String(data)))))
    socket.once('open', () => {
      cleanups.push(() => {
        socket.close()
      })
      resolve({ socket, frames })
    })
    socket.once('unexpected-response', (request, response) => {
      response.resume()
      request.destroy()
      resolve({ status: response.statusCode ?? 0 })
    })
    socket.once('error', reject)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `read` until it returns a value. Nothing here waits on a fixed delay. */
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const value = read()
    if (value !== undefined) return value
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ---------------------------------------------------------------------------
// 1: the token
// ---------------------------------------------------------------------------

describe('token auth', () => {
  it('rejects an HTTP request with no token', async () => {
    const r = await rig()
    const result = await call(r.daemon, '/api/runs', { token: null })

    expect(result.status).toBe(401)
    expect(ErrorResponseSchema.parse(result.body).error).toBe('unauthorized')
  })

  it('rejects a WebSocket upgrade with no token, at the handshake', async () => {
    const r = await rig()
    const connection = await connect(r.daemon, `?run=${RUN_ID}`)

    // No socket was ever handed out: the protocol switch did not happen.
    expect(connection).toEqual({ status: 401 })
  })

  it('rejects a wrong token on both transports', async () => {
    const r = await rig()

    expect((await call(r.daemon, '/api/runs', { token: 'not-the-token' })).status).toBe(401)
    expect(await connect(r.daemon, `?run=${RUN_ID}&token=not-the-token`)).toEqual({ status: 401 })
  })

  it('accepts the right token on both transports', async () => {
    const r = await rig()

    expect((await call(r.daemon, '/api/runs')).status).toBe(200)
    const connection = await connect(r.daemon, `?run=${RUN_ID}&token=${r.daemon.token}`)
    expect('socket' in connection).toBe(true)
  })

  it('mints a token from crypto randomness, and never repeats one', async () => {
    const first = await rig()
    const second = await rig()

    expect(first.daemon.token).not.toBe(second.daemon.token)
    // 256 bits, base64url: 43 characters, and no padding or reserved bytes.
    expect(first.daemon.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('requires the token on unknown paths too, so 404s cannot probe the surface', async () => {
    const r = await rig()
    expect((await call(r.daemon, '/api/nope', { token: null })).status).toBe(401)
    expect((await call(r.daemon, '/api/nope')).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// 2: the response contract
// ---------------------------------------------------------------------------

describe('snapshots', () => {
  it('lists runs', async () => {
    const r = await rig()
    const result = await call(r.daemon, '/api/runs')

    const listed = RunListResponseSchema.parse(result.body)
    expect(listed.runs).toHaveLength(1)
    expect(listed.runs[0]).toMatchObject({
      runId: RUN_ID,
      workflowId: 'daemon-flow',
      status: 'running',
      baseBranch: 'main',
      endedAt: null,
    })
  })

  it('serves a run snapshot: nodes, pool occupancy, gate queue and harness state', async () => {
    const r = await rig()
    // One node holding a lane and the gate pool, as the scheduler would leave it.
    const lease = await r.pools.acquire(['lane', 'test-suite'])
    r.journal.acquireLease('lane', 'a')
    r.journal.acquireLease('test-suite', 'a')

    const result = await call(r.daemon, `/api/runs/${RUN_ID}`)
    expect(result.status).toBe(200)
    const snapshot = RunSnapshotSchema.parse(result.body)

    expect(snapshot.nodes.map((node) => [node.nodeId, node.status, node.wave])).toEqual([
      ['a', 'pending', 1],
      ['b', 'pending', 2],
    ])

    // §10's graph: display names, waves and the dependency edges with the
    // artifact they are labelled with, all out of the frozen workflow.
    expect(snapshot.nodes.map((node) => [node.nodeId, node.name])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ])
    expect(snapshot.edges).toEqual([{ from: 'a', to: 'b', artifact: "a's model" }])
    // The waves are the ones the run was registered with, not a second count.
    expect(snapshot.nodes.map((node) => node.wave)).toEqual(
      r.journal.nodes(RUN_ID).map((node) => node.wave),
    )

    expect(snapshot.resources).toEqual([
      { id: 'lane', kind: 'worktree', capacity: 2, held: 1, holders: ['a'] },
      { id: 'test-suite', kind: 'semaphore', capacity: 1, held: 1, holders: ['a'] },
    ])
    expect(snapshot.gateQueue).toEqual({
      waiting: 0,
      holders: [{ resource: 'test-suite', nodeId: 'a', acquiredAt: expect.any(Number) }],
    })
    expect(snapshot.harnesses).toEqual([
      { id: HARNESS, ceiling: 4, inFlight: 1, wakeAt: null },
    ])
    lease.release()
  })

  it('serves a node detail: transcript page, gate log and diff ref', async () => {
    const r = await rig()
    for (const index of [1, 2, 3]) {
      r.journal.appendTranscript(RUN_ID, 'a', { type: 'text', index })
    }
    writeFileSync(r.journal.gateLogPath(RUN_ID, 'a', 'unit'), 'FAIL tests/x\n')
    r.journal.append({
      runId: RUN_ID,
      nodeId: 'a',
      type: 'node_assigned',
      payload: { lane: 'run-1-lane-1', branch: 'phase/a', base_branch: 'main' },
    })
    r.journal.append({
      runId: RUN_ID,
      nodeId: 'a',
      type: 'node_status',
      payload: { status: 'awaiting_human' },
    })

    const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a?limit=2`)
    const detail = NodeDetailSchema.parse(result.body)

    expect(detail.transcript).toEqual({
      stream: 'transcript',
      entries: [
        { type: 'text', index: 2 },
        { type: 'text', index: 3 },
      ],
    })
    expect(detail.gates).toEqual([{ gateId: 'unit', log: 'FAIL tests/x\n' }])
    expect(detail.diff).toEqual({ branch: 'phase/a', baseBranch: 'main', lane: 'run-1-lane-1' })
    expect(detail.question).toEqual({
      question: 'Ship it?',
      kind: 'confirm',
      context: { diffRef: 'phase/a' },
    })
  })

  it('404s an unknown run and an unknown node', async () => {
    const r = await rig()
    expect((await call(r.daemon, '/api/runs/nope')).status).toBe(404)
    expect((await call(r.daemon, `/api/runs/${RUN_ID}/nodes/nope`)).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// 3: request validation
// ---------------------------------------------------------------------------

describe('request validation', () => {
  const cases = [
    { path: 'context', body: {}, path_: 'text' },
    { path: 'context', body: { text: '' }, path_: 'text' },
    { path: 'redirect', body: { instruction: 42 }, path_: 'instruction' },
    { path: 'answer', body: { answer: { nested: true } }, path_: 'answer' },
    { path: 'pause', body: { unexpected: 1 }, path_: '' },
  ] as const

  for (const testCase of cases) {
    it(`locates a malformed body for ${testCase.path}`, async () => {
      const r = await rig()
      const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/${testCase.path}`, {
        method: 'POST',
        body: testCase.body,
      })

      expect(result.status).toBe(400)
      const error = ErrorResponseSchema.parse(result.body)
      expect(error.error).toBe('invalid_request')
      expect(error.issues?.[0]?.path).toBe(testCase.path_)
      expect(r.control.calls).toEqual([])
    })
  }

  it('rejects a body that is not JSON at all', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/context`, {
      method: 'POST',
      raw: '{not json',
    })

    expect(result.status).toBe(400)
    expect(ErrorResponseSchema.parse(result.body).issues?.[0]?.code).toBe('invalid_json')
  })

  it('never echoes the offending value back', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/pause`, {
      method: 'POST',
      body: { 'patient-record-42': 'contents' },
    })

    expect(JSON.stringify(result.body)).not.toContain('patient-record-42')
    expect(JSON.stringify(result.body)).not.toContain('contents')
  })

  it('rejects a malformed query on the node detail', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a?limit=0`)

    expect(result.status).toBe(400)
    expect(ErrorResponseSchema.parse(result.body).issues?.[0]?.path).toBe('limit')
  })
})

// ---------------------------------------------------------------------------
// 4: the five operations of §9
// ---------------------------------------------------------------------------

describe('§9 operations', () => {
  const operations = [
    { path: 'context', body: { text: 'try the other index' }, op: 'addContext', arg: 'try the other index' },
    { path: 'redirect', body: { instruction: 'use a migration' }, op: 'redirect', arg: 'use a migration' },
    { path: 'pause', body: {}, op: 'pause', arg: null },
    { path: 'abort', body: {}, op: 'abortNode', arg: null },
  ] as const

  for (const operation of operations) {
    it(`${operation.op} reaches the run's control`, async () => {
      const r = await rig()
      const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/${operation.path}`, {
        method: 'POST',
        body: operation.body,
      })

      expect(result.status).toBe(200)
      expect(OkResponseSchema.parse(result.body)).toEqual({ ok: true })
      expect(r.control.calls).toEqual([{ op: operation.op, nodeId: 'a', arg: operation.arg }])
    })
  }

  it('forwards an answer as the guard context human.answer (§9.1)', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/answer`, {
      method: 'POST',
      body: { answer: 'ship' },
    })

    expect(result.status).toBe(200)
    expect(r.control.calls).toEqual([
      { op: 'answer', nodeId: 'a', arg: { human: { answer: 'ship' } } },
    ])
  })

  it('reports a refused operation as a code, with no message from below', async () => {
    const r = await rig()
    const control = runControl({
      statuses: {},
      answer: () => {
        throw new Error('node "a" is not awaiting an answer')
      },
    })
    r.daemon.register({
      runId: RUN_ID,
      control,
      pools: r.pools,
      admission: { ceiling: () => 1, inFlight: () => 0, wakeAt: () => undefined },
    })

    const answered = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/answer`, {
      method: 'POST',
      body: { answer: true },
    })
    expect(answered.status).toBe(409)
    expect(ErrorResponseSchema.parse(answered.body)).toEqual({
      error: 'operation_failed',
      issues: null,
    })

    // A verb the host never wired up refuses rather than reporting success.
    const paused = await call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/pause`, {
      method: 'POST',
      body: {},
    })
    expect(paused.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// 5: the event stream
// ---------------------------------------------------------------------------

describe('event stream', () => {
  it('delivers the backlog and then live events', async () => {
    const r = await rig()
    const connection = await connect(r.daemon, `?run=${RUN_ID}&token=${r.daemon.token}`)
    if (!('socket' in connection)) throw new Error('handshake refused')

    // The backlog is three events: run_started and one node_registered each.
    const backlog = await until(
      () => (connection.frames.length > 0 ? connection.frames[0] : undefined),
      'the backlog frame',
    )
    const first = EventFrameSchema.parse(backlog)
    expect(first.channel).toBe('events')
    expect(first.events.map((event) => event.type)).toEqual([
      'run_started',
      'node_registered',
      'node_registered',
    ])
    expect(first.cursor).toBe(first.events.at(-1)?.id)

    r.journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'running' } })
    const live = await until(
      () => connection.frames.find((frame) => frame !== backlog),
      'a live frame',
    )
    expect(EventFrameSchema.parse(live).events.map((event) => event.type)).toEqual(['node_status'])
  })

  it('resumes from an exclusive sinceId with no gap and no duplicate', async () => {
    const r = await rig()
    const first = await connect(r.daemon, `?run=${RUN_ID}&token=${r.daemon.token}`)
    if (!('socket' in first)) throw new Error('handshake refused')

    const opening = EventFrameSchema.parse(
      await until(() => first.frames[0], 'the opening frame'),
    )
    const cursor = opening.cursor
    first.socket.close()
    await until(() => (first.socket.readyState === WebSocket.CLOSED ? true : undefined), 'a close')

    // Two events land while nothing is listening. Neither may be lost.
    const missed = [
      r.journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'running' } }),
      r.journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'done' } }),
    ]

    const second = await connect(
      r.daemon,
      `?run=${RUN_ID}&since=${cursor}&token=${r.daemon.token}`,
    )
    if (!('socket' in second)) throw new Error('handshake refused')

    const resumed = EventFrameSchema.parse(await until(() => second.frames[0], 'the resume frame'))
    expect(resumed.events.map((event) => event.id)).toEqual(missed)
    expect(resumed.cursor).toBe(missed[1])

    // And nothing already seen came back: every id is strictly past the cursor.
    const ids = second.frames.flatMap((frame) => EventFrameSchema.parse(frame).events.map((e) => e.id))
    expect(ids).toEqual([...new Set(ids)])
    expect(Math.min(...ids)).toBeGreaterThan(cursor)
  })

  it('refuses an upgrade for a run it does not serve', async () => {
    const r = await rig()
    expect(await connect(r.daemon, `?run=nope&token=${r.daemon.token}`)).toEqual({ status: 404 })
  })
})

// ---------------------------------------------------------------------------
// 6: answering a human gate resumes the node, against the real scheduler
// ---------------------------------------------------------------------------

describe('human gates', () => {
  it('resumes a suspended node when the answer arrives over the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-daemon-gate-'))
    const journal = openJournal(dir)
    const workflow = makeWorkflow('gated')
    journal.createRun(RUN_ID, workflow)

    const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
    const admission = new AdmissionControl({ journal, runId: RUN_ID, ceilings: { [HARNESS]: 4 } })
    const seen: { effectId: string; answer: unknown }[] = []
    const executor: EffectExecutor = {
      execute: async (invocation) => {
        seen.push({
          effectId: invocation.effect.id,
          answer: invocation.context.human?.['answer'] ?? null,
        })
        return {}
      },
    }
    const scheduler: Scheduler = createScheduler({
      workflow,
      runId: RUN_ID,
      journal,
      pools,
      admission,
      adapters: { [HARNESS]: new MockAdapter({ id: HARNESS }) },
      executor,
      laneRoot: join(dir, 'lanes'),
    })

    const daemon = await startDaemon({ journal, pollMs: 5 })
    daemon.register({
      runId: RUN_ID,
      control: runControl(scheduler),
      pools,
      admission,
    })
    cleanups.push(async () => {
      await daemon.close()
      admission.close()
      journal.close()
      rmSync(dir, { recursive: true, force: true })
    })

    const running = scheduler.run()
    await until(
      () => (scheduler.statuses['a'] === 'awaiting_human' ? true : undefined),
      'node a to park',
    )

    // The question comes off the journal projection, not off live host state:
    // `runControl(scheduler)` supplies no `question` callback at all.
    const parked = await call(daemon, `/api/runs/${RUN_ID}/nodes/a`)
    expect(NodeDetailSchema.parse(parked.body).question).toEqual({
      question: 'The branch is green. Ship it?',
      kind: 'choice',
      choices: ['ship', 'hold'],
      context: { diffRef: 'phase/a' },
    })

    const answered = await call(daemon, `/api/runs/${RUN_ID}/nodes/a/answer`, {
      method: 'POST',
      body: { answer: 'ship' },
    })
    expect(answered.status).toBe(200)

    await until(
      () => (scheduler.statuses['b'] === 'awaiting_human' ? true : undefined),
      'node b to start',
    )
    const answeredB = await call(daemon, `/api/runs/${RUN_ID}/nodes/b/answer`, {
      method: 'POST',
      body: { answer: 'ship' },
    })
    expect(answeredB.status).toBe(200)

    const report = await running
    expect(report.statuses).toEqual({ a: 'done', b: 'done' })

    // §9.1: the answer entered the guard context, which is what a pipeline
    // branches on — the transition out of the gate is guarded on exactly this.
    expect(seen.filter((call_) => call_.effectId === 'e-track')).toEqual([
      { effectId: 'e-track', answer: 'ship' },
      { effectId: 'e-track', answer: 'ship' },
    ])
    // Answered pauses stop being pending, and both nodes gave everything back.
    expect(journal.pendingQuestions(RUN_ID)).toEqual([])
    expect(pools.held('lane')).toBe(0)
    expect(pools.waiting).toBe(0)
    expect(journal.leases()).toEqual([])
  })

  it('drives the four §9 operations against a real scheduler over the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-daemon-ops-'))
    const journal = openJournal(dir)
    const workflow = makeWorkflow('gated')
    journal.createRun(RUN_ID, workflow)

    const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
    const admission = new AdmissionControl({ journal, runId: RUN_ID, ceilings: { [HARNESS]: 4 } })
    const scheduler: Scheduler = createScheduler({
      workflow,
      runId: RUN_ID,
      journal,
      pools,
      admission,
      adapters: { [HARNESS]: new MockAdapter({ id: HARNESS }) },
      executor: { execute: async () => ({}) },
      laneRoot: join(dir, 'lanes'),
    })

    const daemon = await startDaemon({ journal, pollMs: 5 })
    daemon.register({ runId: RUN_ID, control: runControl(scheduler), pools, admission })
    cleanups.push(async () => {
      await daemon.close()
      admission.close()
      journal.close()
      rmSync(dir, { recursive: true, force: true })
    })

    const running = scheduler.run()
    await until(
      () => (scheduler.statuses['a'] === 'awaiting_human' ? true : undefined),
      'node a to park',
    )

    // None of these answer 200 by pretending: the mechanism behind each one is
    // the scheduler's, and a verb with no mechanism would still be a 409.
    for (const operation of [
      { path: 'context', body: { text: 'watch the unique index' } },
      { path: 'redirect', body: { instruction: 'use a migration' } },
      { path: 'pause', body: {} },
    ]) {
      const result = await call(daemon, `/api/runs/${RUN_ID}/nodes/a/${operation.path}`, {
        method: 'POST',
        body: operation.body,
      })
      expect([operation.path, result.status]).toEqual([operation.path, 200])
    }

    const aborted = await call(daemon, `/api/runs/${RUN_ID}/nodes/b/abort`, {
      method: 'POST',
      body: {},
    })
    expect(aborted.status).toBe(200)

    scheduler.answer('a', { human: { answer: 'ship' } })
    const report = await running

    expect(report.statuses).toEqual({ a: 'done', b: 'failed' })
    const operations = journal
      .events(RUN_ID)
      .filter((event) => event.type === 'node_operation')
      .map((event) => event.payload as { op: string; delivery: string })
    expect(operations).toEqual([
      // Node `a` is parked, so both steering messages queue; the pause is a
      // recorded no-op on a node that is already waiting for the operator.
      { op: 'add_context', text: 'watch the unique index', delivery: 'queued' },
      { op: 'redirect', text: 'use a migration', delivery: 'queued' },
      { op: 'pause', delivery: 'ignored' },
      { op: 'abort', delivery: 'sent' },
      // …and both are delivered into the guard context when `a` resumes.
      { op: 'add_context', text: 'watch the unique index', delivery: 'delivered' },
      { op: 'redirect', text: 'use a migration', delivery: 'delivered' },
    ])
    expect(pools.held('lane')).toBe(0)
    expect(journal.leases()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 7: binding
// ---------------------------------------------------------------------------

const external = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)

describe('binding', () => {
  it('binds loopback by default and warns about nothing', async () => {
    const r = await rig()

    expect(r.daemon.host).toBe('127.0.0.1')
    expect(r.daemon.url).toBe(`http://127.0.0.1:${r.daemon.port}`)
    expect(r.warnings).toEqual([])
  })

  it.skipIf(external === undefined)(
    'is not reachable on a non-loopback address unless --host was given',
    async () => {
      const address = (external as { address: string }).address
      const loopbackOnly = await rig()

      await expect(
        fetch(`http://${address}:${loopbackOnly.daemon.port}/api/runs`),
      ).rejects.toThrow()

      // The same request, against a daemon that was explicitly told to bind wide.
      const wide = await rig({ host: address })
      const response = await fetch(`http://${address}:${wide.daemon.port}/api/runs`, {
        headers: { authorization: `Bearer ${wide.daemon.token}` },
      })
      expect(response.status).toBe(200)
      await response.arrayBuffer()

      expect(wide.warnings).toHaveLength(1)
      expect(wide.warnings[0]).toContain(address)
      expect(wide.warnings[0]).not.toContain(wide.daemon.token)
    },
  )
})

// ---------------------------------------------------------------------------
// 8: shutdown
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  it('leaves no listening socket behind, and closes the sockets it handed out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-daemon-close-'))
    const journal = openJournal(dir)
    journal.createRun(RUN_ID, makeWorkflow())
    const daemon = await startDaemon({ journal, pollMs: 5 })
    daemon.register({
      runId: RUN_ID,
      control: recordingControl(),
      pools: new ResourcePools(makeWorkflow().resources),
      admission: { ceiling: () => 1, inFlight: () => 0, wakeAt: () => undefined },
    })

    const { url, port } = daemon
    expect((await call(daemon, '/api/runs')).status).toBe(200)
    const connection = await connect(daemon, `?run=${RUN_ID}&token=${daemon.token}`)
    if (!('socket' in connection)) throw new Error('handshake refused')
    await until(() => connection.frames[0], 'a first frame')

    try {
      await daemon.close()
    } finally {
      journal.close()
      rmSync(dir, { recursive: true, force: true })
    }

    await expect(fetch(`${url}/api/runs`)).rejects.toThrow()

    // Rebinding the same port is the assertion a refused connection is not:
    // it fails with EADDRINUSE if anything is still listening there. Counting
    // process handles would be measuring the test runner's timers as much as
    // the daemon's.
    const rebound = createServer()
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject)
      rebound.listen(port, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => rebound.close(() => resolve()))

    // And the socket the client was holding was closed from this side rather
    // than left open until it timed out.
    await until(
      () => (connection.socket.readyState === WebSocket.CLOSED ? true : undefined),
      'the client socket to close',
    )
  })

  it('stops the tail poll when the stream closes', async () => {
    const r = await rig()
    const stream = new EventStream(r.journal, 5)
    const sent: string[] = []
    const socket = {
      readyState: 1,
      send: (data: string) => sent.push(data),
      on: () => undefined,
    } as unknown as WebSocket

    stream.attach(socket, RUN_ID, 0)
    expect(sent).toHaveLength(1)

    stream.close()
    r.journal.append({
      runId: RUN_ID,
      nodeId: 'a',
      type: 'node_status',
      payload: { status: 'running' },
    })
    // Several poll intervals: a timer still running would have sent by now.
    await sleep(40)
    expect(sent).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 9: the app shell (§10)
// ---------------------------------------------------------------------------

/** A built bundle, plus a file beside it that no request may ever reach. */
function bundle(): { readonly uiDir: string; readonly secret: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-ui-'))
  const uiDir = join(dir, 'ui')
  mkdirSync(join(uiDir, 'assets'), { recursive: true })
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><div id="root"></div>\n')
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log("shell")\n')
  writeFileSync(join(dir, 'outside.txt'), 'not-for-the-browser\n')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { uiDir, secret: 'not-for-the-browser' }
}

interface Fetched {
  readonly status: number
  readonly type: string
  readonly text: string
}

/** A raw GET: static responses are not JSON, and one of them must not be. */
async function raw(
  daemon: Daemon,
  path: string,
  options: { readonly token?: string | null; readonly method?: string } = {},
): Promise<Fetched> {
  const token = options.token === undefined ? daemon.token : options.token
  const response = await fetch(`${daemon.url}${path}`, {
    method: options.method ?? 'GET',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    text: await response.text(),
  }
}

describe('the built UI', () => {
  it('serves the shell and its assets', async () => {
    const built = bundle()
    const r = await rig({ uiDir: built.uiDir })

    const index = await raw(r.daemon, '/')
    expect(index.status).toBe(200)
    expect(index.type).toContain('text/html')
    expect(index.text).toContain('<div id="root">')

    const asset = await raw(r.daemon, '/assets/app.js')
    expect(asset.status).toBe(200)
    expect(asset.type).toContain('text/javascript')
    expect(asset.text).toContain('shell')
  })

  it('falls back to index.html on a deep link, and 404s a missing asset', async () => {
    const built = bundle()
    const r = await rig({ uiDir: built.uiDir })

    // A client route, not a file: the app owns everything past the origin.
    const deep = await raw(r.daemon, `/runs/${RUN_ID}/nodes/a`)
    expect(deep.status).toBe(200)
    expect(deep.type).toContain('text/html')
    expect(deep.text).toContain('<div id="root">')

    // A request that named a file and missed it is not a document. Serving
    // HTML there turns a missing bundle chunk into a parse error elsewhere.
    expect((await raw(r.daemon, '/assets/missing.js')).status).toBe(404)
  })

  it('refuses a path that resolves outside the UI directory', async () => {
    const built = bundle()
    const r = await rig({ uiDir: built.uiDir })

    // Percent-encoded, because `new URL` collapses a literal `../` before any
    // handler sees it — the encoded form is the one that actually arrives.
    for (const path of [
      '/%2e%2e%2foutside.txt',
      '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
      '/..%2f..%2fpackage.json',
    ]) {
      const refused = await raw(r.daemon, path)
      expect([path, refused.status]).toEqual([path, 403])
      expect(refused.text).not.toContain(built.secret)
    }
  })

  it('says how to build the bundle rather than 404ing, when it is absent', async () => {
    const r = await rig({ uiDir: join(tmpdir(), 'vinta-flow-ui-that-was-never-built') })

    const index = await raw(r.daemon, '/')
    expect(index.status).toBe(503)
    expect(index.type).toContain('text/plain')
    expect(index.text).toContain('ui:build')
    expect(index.text).toContain('dist/ui')
  })

  it('is reachable without a token, and is not a way into the API', async () => {
    const built = bundle()
    const r = await rig({ uiDir: built.uiDir })

    // The decision (see daemon/static.ts): the shell carries no run data and a
    // browser cannot present a token for a subresource, so these bytes are
    // open…
    expect((await raw(r.daemon, '/', { token: null })).status).toBe(200)
    expect((await raw(r.daemon, '/assets/app.js', { token: null })).status).toBe(200)

    // …and nothing else moved. Every API path, and the upgrade, still refuse.
    for (const path of ['/api/runs', `/api/runs/${RUN_ID}`, `/api/runs/${RUN_ID}/nodes/a`, '/api']) {
      const refused = await raw(r.daemon, path, { token: null })
      expect([path, refused.status]).toEqual([path, 401])
      expect(refused.type).toContain('application/json')
      expect(refused.text).not.toContain('<div id="root">')
    }
    expect(await connect(r.daemon, `?run=${RUN_ID}`)).toEqual({ status: 401 })

    // An encoded path that dodges the `/api` prefix reaches the file server
    // rather than the router — and the file server answers only out of the UI
    // directory, so what comes back is the shell and never a snapshot.
    const smuggled = await raw(r.daemon, '/api%2f..%2fruns', { token: null })
    expect(smuggled.text).not.toContain(RUN_ID)
    expect(smuggled.text).not.toContain('workflowId')
    // And the token still buys the API, so none of this weakened it.
    expect((await raw(r.daemon, '/api/runs')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 10: the snapshot's cursor, and the run list after a restart
// ---------------------------------------------------------------------------

describe('cold start', () => {
  it("streams from the snapshot's cursor with no gap and no duplicate", async () => {
    const r = await rig()
    // Events before the snapshot: the backlog a cold client must not replay.
    const before = [
      r.journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'running' } }),
      r.journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'done' } }),
    ]

    const snapshot = RunSnapshotSchema.parse((await call(r.daemon, `/api/runs/${RUN_ID}`)).body)
    expect(snapshot.cursor).toBe(before[1])
    // The projection the snapshot shows is at least as new as its cursor.
    expect(snapshot.nodes.find((node) => node.nodeId === 'a')?.status).toBe('done')

    // …and events after it: the ones the client must receive.
    const after = [
      r.journal.append({ runId: RUN_ID, nodeId: 'b', type: 'node_status', payload: { status: 'running' } }),
      r.journal.append({ runId: RUN_ID, nodeId: 'b', type: 'node_status', payload: { status: 'done' } }),
    ]

    const connection = await connect(
      r.daemon,
      `?run=${RUN_ID}&since=${snapshot.cursor}&token=${r.daemon.token}`,
    )
    if (!('socket' in connection)) throw new Error('handshake refused')
    const frame = EventFrameSchema.parse(await until(() => connection.frames[0], 'the first frame'))

    // No gap: both events past the cursor arrived. No duplicate: nothing the
    // snapshot already accounted for came with them.
    expect(frame.events.map((event) => event.id)).toEqual(after)
    expect(frame.events.every((event) => !before.includes(event.id))).toBe(true)
    expect(frame.cursor).toBe(after[1])
  })

  it('lists runs the journal knows about, not runs this process started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-daemon-restart-'))
    const first = openJournal(dir)
    first.createRun('run-old', makeWorkflow())
    first.append({ runId: 'run-old', type: 'run_ended', payload: { status: 'done' } })
    first.close()

    // A brand new process, holding a registry with nothing in it.
    const journal = openJournal(dir)
    const daemon = await startDaemon({ journal, pollMs: 5 })
    cleanups.push(async () => {
      await daemon.close()
      journal.close()
      rmSync(dir, { recursive: true, force: true })
    })

    const listed = RunListResponseSchema.parse((await call(daemon, '/api/runs')).body)
    expect(listed.runs).toHaveLength(1)
    expect(listed.runs[0]).toMatchObject({
      runId: 'run-old',
      workflowId: 'daemon-flow',
      status: 'done',
    })
    expect(listed.runs[0]?.endedAt).toEqual(expect.any(Number))
  })
})
