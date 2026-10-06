/**
 * The agents' side of the daemon API, driven over a real socket.
 *
 * A run's lanes are handed a token of their own (`VINTA_AI_MAESTRO_TOKEN`),
 * not the operator's. What is under test is that it is good for exactly what a
 * lane calls — `with`'s leases, `gate`, the judge and guard hooks — and for
 * nothing that steers the run: every other route answers `403
 * agent_forbidden`, the WebSocket refuses it at the handshake, and `ui` never
 * forwards it to a job under the job's operator token.
 *
 * The small helpers are copied from `coordinator-api.test.ts` rather than
 * imported, so one suite's rig can change without breaking another's.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { agentMayReach } from '../src/daemon/api.ts'
import { runControl, startDaemon, type Daemon } from '../src/daemon/index.ts'
import type { DaemonRun } from '../src/daemon/control.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import { AgentLeaseBroker } from '../src/resources/agent-leases.ts'
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
    id: 'agent-token-flow',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'solo' },
    resources: {
      lane: { capacity: 2, kind: 'worktree' },
      'test-suite': { capacity: 1, kind: 'semaphore' },
    },
    gates: { unit: { cmd: 'true', requires: ['test-suite'] } },
    nodes: [{ id: 'a', name: 'A', prompt_ref: 'plan.md#a', gates: ['unit'] }],
    pipelines: { solo: SOLO },
  })
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface Rig {
  readonly daemon: Daemon
  readonly journal: Journal
  readonly dir: string
  /** Every operation that reached the run's host, in order. */
  readonly calls: string[]
}

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function rig(options: { readonly upstream?: Daemon } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-agent-token-'))
  const journal = openJournal(dir)
  const workflow = makeWorkflow()
  journal.createRun(RUN_ID, workflow)

  const calls: string[] = []
  const pools = new ResourcePools(workflow.resources, { agingMs: 0 })
  const agentLeases = new AgentLeaseBroker(pools, journal, RUN_ID)
  const upstream = options.upstream
  const daemon = await startDaemon({
    journal,
    pollMs: 5,
    warn: () => {},
    ...(upstream === undefined
      ? {}
      : { upstream: () => ({ url: upstream.url, token: upstream.token }) }),
  })

  // `ui` hosts no runs of its own: everything addressed to one is the job's.
  if (upstream === undefined) {
    const run: DaemonRun = {
      runId: RUN_ID,
      control: runControl({
        statuses: { a: 'running' },
        answer: () => {
          calls.push('answer')
        },
        addContext: () => {
          calls.push('addContext')
        },
        redirect: () => {
          calls.push('redirect')
        },
        pause: () => {
          calls.push('pause')
        },
        abortNode: () => {
          calls.push('abortNode')
        },
      }),
      pools,
      admission: { ceiling: () => 4, inFlight: () => 1, wakeAt: () => undefined },
      agentLeases,
      agentGates: {
        hop: async (gateId) => {
          calls.push('gate')
          return { gateId, status: 'passed', exitCode: 0, cached: false, logRef: 'gates/unit.log' }
        },
      },
      permissionJudge: {
        judge: async () => {
          calls.push('permission')
          return { allow: true, reason: 'fine' }
        },
      },
      gateGuard: {
        check: () => {
          calls.push('guard')
          return { allow: true }
        },
      },
      halt: async (mode) => {
        calls.push(`halt:${mode}`)
      },
    }
    daemon.register(run)
  }

  cleanups.push(async () => {
    agentLeases.close()
    await daemon.close()
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { daemon, journal, dir, calls }
}

interface Result {
  readonly status: number
  readonly body: unknown
}

async function call(
  daemon: Daemon,
  path: string,
  options: { readonly method?: string; readonly token?: string; readonly body?: unknown } = {},
): Promise<Result> {
  const response = await fetch(`${daemon.url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token ?? daemon.agentToken}`,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: await response.json() }
}

/** The status a WebSocket handshake ends with: `101` when it opened. */
function handshake(daemon: Daemon, token: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${daemon.url}/ws?run=${RUN_ID}&token=${token}`)
    socket.once('open', () => {
      socket.close()
      resolve(101)
    })
    socket.once('unexpected-response', (request, response) => {
      response.resume()
      request.destroy()
      resolve(response.statusCode ?? 0)
    })
    socket.once('error', reject)
  })
}

const FORBIDDEN = { error: 'agent_forbidden', issues: null }

// ---------------------------------------------------------------------------
// What a lane may do
// ---------------------------------------------------------------------------

describe('the agent token on its own routes', () => {
  it('is a different secret from the operator’s and the coordinator’s', async () => {
    const r = await rig()
    expect(r.daemon.agentToken).not.toBe(r.daemon.token)
    expect(r.daemon.agentToken).not.toBe(r.daemon.coordinatorToken)
  })

  it('takes, renews and releases a lease', async () => {
    const r = await rig()
    const granted = await call(r.daemon, `/api/runs/${RUN_ID}/leases`, {
      method: 'POST',
      body: { resources: ['test-suite'], holderNode: 'a' },
    })
    expect(granted.status).toBe(201)
    const { leaseId } = granted.body as { leaseId: string }

    const renewed = await call(r.daemon, `/api/runs/${RUN_ID}/leases/${leaseId}`, { method: 'PUT' })
    expect(renewed.status).toBe(200)

    const released = await call(r.daemon, `/api/runs/${RUN_ID}/leases/${leaseId}`, { method: 'DELETE' })
    expect(released).toEqual({ status: 200, body: { ok: true } })
    expect(r.journal.leases()).toEqual([])
  })

  it('runs a gate', async () => {
    const r = await rig()
    const result = await call(r.daemon, `/api/runs/${RUN_ID}/gates`, {
      method: 'POST',
      body: { gate: 'unit', holderNode: 'a' },
    })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ gateId: 'unit', exitCode: 0 })
    expect(r.calls).toEqual(['gate'])
  })

  it('asks the permission judge and the gate guard', async () => {
    const r = await rig()
    const judged = await call(r.daemon, `/api/runs/${RUN_ID}/permission`, {
      method: 'POST',
      body: { holderNode: 'a', tool: 'Bash', input: { command: 'ls' }, cwd: '/tmp' },
    })
    const guarded = await call(r.daemon, `/api/runs/${RUN_ID}/guard`, {
      method: 'POST',
      body: { holderNode: 'a', command: 'ls' },
    })
    expect(judged).toEqual({ status: 200, body: { allow: true, reason: 'fine' } })
    expect(guarded).toEqual({ status: 200, body: { allow: true } })
    expect(r.calls).toEqual(['permission', 'guard'])
  })
})

// ---------------------------------------------------------------------------
// What it may not
// ---------------------------------------------------------------------------

describe('the agent token everywhere else', () => {
  /**
   * The three that matter most: an agent that could abort a node, rewrite the
   * plan under its own run or stop the run outright would be the operator.
   */
  const steering = [
    { path: `/api/runs/${RUN_ID}/nodes/a/abort`, body: {} },
    { path: `/api/runs/${RUN_ID}/amend`, body: makeWorkflow() },
    { path: `/api/runs/${RUN_ID}/stop`, body: {} },
  ] as const

  for (const route of steering) {
    it(`is refused on ${route.path.slice(`/api/runs/${RUN_ID}`.length)}, which the operator reaches`, async () => {
      const r = await rig()
      const refused = await call(r.daemon, route.path, { method: 'POST', body: route.body })
      expect(refused).toEqual({ status: 403, body: FORBIDDEN })
      expect(r.calls).toEqual([])

      // The same request on the operator's token is not refused at the door,
      // so the 403 above is the token's and not the route's.
      const asOperator = await call(r.daemon, route.path, {
        method: 'POST',
        token: r.daemon.token,
        body: route.body,
      })
      expect(asOperator.status).not.toBe(403)
      expect(asOperator.status).not.toBe(401)
    })
  }

  it('is refused on the rest of the steering and editor surface', async () => {
    const r = await rig()
    const refusals = await Promise.all([
      call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/context`, { method: 'POST', body: { text: 'x' } }),
      call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/redirect`, { method: 'POST', body: { instruction: 'x' } }),
      call(r.daemon, `/api/runs/${RUN_ID}/nodes/a/answer`, { method: 'POST', body: { answer: 'x' } }),
      call(r.daemon, `/api/runs/${RUN_ID}/pause`, { method: 'POST', body: {} }),
      call(r.daemon, `/api/runs/${RUN_ID}/exec`, { method: 'POST', body: { target: 'a', command: 'ls' } }),
      call(r.daemon, `/api/runs`, { method: 'POST', body: {} }),
      call(r.daemon, `/api/workflows/agent-token-flow`, { method: 'PUT', body: makeWorkflow() }),
      call(r.daemon, `/api/runs/${RUN_ID}`),
      call(r.daemon, `/api/logs`),
    ])
    for (const refused of refusals) expect(refused).toEqual({ status: 403, body: FORBIDDEN })
    expect(r.calls).toEqual([])
  })

  it('cannot reach an agent route under a method it does not use', async () => {
    const r = await rig()
    const listed = await call(r.daemon, `/api/runs/${RUN_ID}/leases/lease-1`)
    expect(listed).toEqual({ status: 403, body: FORBIDDEN })
  })

  it('does not open the WebSocket, which carries PTY takeover', async () => {
    const r = await rig()
    expect(await handshake(r.daemon, r.daemon.agentToken)).toBe(401)
    expect(await handshake(r.daemon, r.daemon.token)).toBe(101)
  })
})

// ---------------------------------------------------------------------------
// Through `ui`
// ---------------------------------------------------------------------------

describe('the agent token at `ui`', () => {
  /**
   * `ui` forwards a live run's requests to its job *with the job's operator
   * token*. Forwarding on an agent's token would turn the agent's narrow
   * secret into the operator's at the hop.
   */
  it('is never forwarded to the job', async () => {
    const job = await rig()
    const ui = await rig({ upstream: job.daemon })

    const refused = await call(ui.daemon, `/api/runs/${RUN_ID}/stop`, {
      method: 'POST',
      token: ui.daemon.agentToken,
      body: {},
    })
    expect(refused).toEqual({ status: 403, body: FORBIDDEN })

    const foreign = await call(ui.daemon, `/api/runs/${RUN_ID}/stop`, {
      method: 'POST',
      token: job.daemon.agentToken,
      body: {},
    })
    expect(foreign.status).toBe(401)
    expect(job.calls).toEqual([])

    // The operator's token at `ui` is forwarded, and lands.
    const forwarded = await call(ui.daemon, `/api/runs/${RUN_ID}/stop`, {
      method: 'POST',
      token: ui.daemon.token,
      body: {},
    })
    expect(forwarded.status).toBe(202)
    expect(job.calls).toEqual(['halt:cancelled'])
  })
})

describe('agentMayReach', () => {
  it('admits only the lease, gate and hook routes', () => {
    expect(agentMayReach('POST', '/api/runs/r/leases')).toBe(true)
    expect(agentMayReach('PUT', '/api/runs/r/leases/l')).toBe(true)
    expect(agentMayReach('DELETE', '/api/runs/r/leases/l')).toBe(true)
    expect(agentMayReach('POST', '/api/runs/r/gates')).toBe(true)
    expect(agentMayReach('POST', '/api/runs/r/permission')).toBe(true)
    expect(agentMayReach('POST', '/api/runs/r/guard')).toBe(true)

    expect(agentMayReach('GET', '/api/runs/r/leases')).toBe(false)
    expect(agentMayReach('POST', '/api/runs/r/leases/l')).toBe(false)
    expect(agentMayReach('POST', '/api/runs/r/nodes/a/abort')).toBe(false)
    expect(agentMayReach('POST', '/api/runs/r/x/leases')).toBe(false)
    expect(agentMayReach('POST', '/api/runs/r/leases/')).toBe(false)
    expect(agentMayReach('POST', '/api/runs/r/gates/extra')).toBe(false)
  })
})
