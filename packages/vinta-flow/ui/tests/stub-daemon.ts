/**
 * A stand-in daemon: a real `node:http` listener on an ephemeral port, a real
 * WebSocket upgrade, and an append-only event log with the journal's exclusive
 * `since` semantics.
 *
 * A fetch/WebSocket fake would have been less code, and would have tested less
 * than nothing here. The two properties this step has to prove — that a
 * reconnect resumes at its cursor with no gap and no duplicate, and that a
 * reload rebuilds from a snapshot plus that cursor — are properties of the
 * transport. Faking the transport would leave the assertions describing the
 * fake. So the socket is real, the upgrade is real, the token is checked on
 * both, and the only thing simulated is the scheduler behind it.
 *
 * Every response is validated with the daemon's own schemas **on the way out**,
 * so this stub cannot drift from the contract either: a shape change breaks
 * the tests from both sides at once. `corrupt` is the deliberate exception —
 * that is the test that proves the client is parsing at all.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { z } from 'zod'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PtyClientFrameSchema,
  PtyServerFrameSchema,
  type PtyClientFrame,
  type PtyServerFrame,
} from '../../src/daemon/pty-frames.ts'
import {
  AddContextRequestSchema,
  AnswerRequestSchema,
  EventFrameSchema,
  EventPageSchema,
  NoArgsRequestSchema,
  NodeDetailSchema,
  OkResponseSchema,
  RunUsageResponseSchema,
  RedirectRequestSchema,
  RunListResponseSchema,
  RunSnapshotSchema,
  WorkflowListResponseSchema,
  WorkflowResponseSchema,
  toIssues,
  toWireIssues,
  type EventFrame,
  type NodeDetail,
  type RunSnapshot,
  type RunUsageResponse,
  type RunSummary,
} from '../../src/daemon/schemas.ts'
import { parseWorkflow } from '../../src/validate.ts'

type StoredEvent = EventFrame['events'][number]

/**
 * The five operations of §9, with the daemon's own request schemas. A body the
 * daemon would reject is rejected here too, which is what makes "posts the
 * right body" an assertion about the contract rather than about this file.
 */
const OPERATIONS: Readonly<Record<string, z.ZodType>> = {
  context: AddContextRequestSchema,
  redirect: RedirectRequestSchema,
  pause: NoArgsRequestSchema,
  abort: NoArgsRequestSchema,
  answer: AnswerRequestSchema,
}

/** One accepted §9 operation, as the stub received it off the wire. */
export interface Post {
  readonly runId: string
  readonly nodeId: string
  /** The endpoint segment: `context`, `redirect`, `pause`, `abort`, `answer`. */
  readonly operation: string
  /** Parsed by the daemon's schema for that endpoint. */
  readonly body: unknown
}

/** One accepted workflow save, as the stub received it off the wire. */
export interface WorkflowPut {
  readonly id: string
  /** The body, parsed by the same validator the daemon uses. */
  readonly workflow: unknown
}

/** An event as a test writes it: the log assigns `id` and `ts`. */
export interface NewEvent {
  readonly nodeId: string | null
  readonly type: string
  readonly payload: unknown
}

export interface Connection {
  readonly since: number
  readonly sent: number[]
}

/** One accepted read of §13.2's event page, as the stub received it. */
export interface EventRead {
  readonly runId: string
  readonly since: number
  readonly limit: number
  /** How many events the stub answered with. */
  readonly served: number
}

export interface StubOptions {
  readonly runs: readonly RunSummary[]
  readonly snapshots: Readonly<Record<string, RunSnapshot>>
  /** Node details, keyed `${runId}/${nodeId}`. Anything else is `unknown_node`. */
  readonly details?: Readonly<Record<string, NodeDetail>>
  /**
   * §15.6's rollup, by run id. A run with no entry answers 404 — which is what
   * a daemon older than this browser looks like, and the run view has to keep
   * drawing the graph through it.
   */
  readonly usage?: Readonly<Record<string, RunUsageResponse>>
  readonly events?: readonly NewEvent[]
  /** Serve a body that does not match the schema, to prove the client parses. */
  readonly corrupt?: 'snapshot' | 'frame'
  /**
   * The editable workflow documents, by id. Served and saved with the daemon's
   * own schemas and its own validator, so a workflow this stub accepts is one
   * the daemon would accept too.
   */
  readonly workflows?: Readonly<Record<string, unknown>>
}

export interface StubDaemon {
  readonly origin: string
  readonly token: string
  /** One entry per accepted upgrade, in order, with the `since` it asked for. */
  readonly connections: readonly Connection[]
  /**
   * Every PTY frame a client sent, in order, parsed by the daemon's own
   * schema. They arrive on the run's socket, which is the point: §10 carries
   * both channels on one connection, so `connections` staying at one while
   * these accumulate is what proves the terminal opened none of its own.
   */
  readonly ptyFrames: readonly PtyClientFrame[]
  /** Sends a PTY frame to every attached socket, validated on the way out. */
  readonly emitPty: (frame: PtyServerFrame) => void
  /** Every §9 operation the stub accepted, in order. */
  readonly posts: readonly Post[]
  /** Every workflow save the stub accepted, in order. */
  readonly puts: readonly WorkflowPut[]
  /** Every §13.2 event-page read the stub served, in order. */
  readonly eventReads: readonly EventRead[]
  /** What the stub holds for a workflow id right now. */
  readonly workflow: (id: string) => unknown
  readonly emit: (...events: NewEvent[]) => void
  readonly setSnapshot: (runId: string, snapshot: RunSnapshot) => void
  readonly setNodeDetail: (runId: string, nodeId: string, detail: NodeDetail) => void
  /** Kills every open socket without a close handshake — a dropped connection. */
  readonly drop: () => void
  readonly close: () => Promise<void>
}

const TOKEN = 'stub-token'

export async function startStubDaemon(options: StubOptions): Promise<StubDaemon> {
  const snapshots = new Map(Object.entries(options.snapshots))
  const details = new Map(Object.entries(options.details ?? {}))
  const usageByRun = new Map(Object.entries(options.usage ?? {}))
  const posts: Post[] = []
  const puts: WorkflowPut[] = []
  const workflows = new Map(Object.entries(options.workflows ?? {}))
  const log: StoredEvent[] = []
  const eventReads: EventRead[] = []
  const connections: Connection[] = []
  const ptyFrames: PtyClientFrame[] = []
  const attached = new Map<WebSocket, { runId: string; cursor: number; record: Connection }>()

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!authorized(request.headers.authorization, url)) {
      return json(response, 401, { error: 'unauthorized', issues: null })
    }

    // The Editor row's three endpoints. The save runs `parseWorkflow` exactly
    // as the daemon does, so "the client posted a body the daemon accepts" is
    // an assertion about the contract rather than about this file.
    if (url.pathname === '/api/workflows') {
      return json(
        response,
        200,
        WorkflowListResponseSchema.parse({
          workflows: [...workflows.keys()].sort().map((id) => ({ id })),
        }),
      )
    }
    const workflow = /^\/api\/workflows\/([^/]+)$/.exec(url.pathname)
    if (workflow !== null) {
      const id = decodeURIComponent(workflow[1] ?? '')
      if (request.method === 'PUT') {
        let raw: unknown
        try {
          raw = JSON.parse(await readBody(request))
        } catch {
          return json(response, 400, { error: 'invalid_workflow', issues: null })
        }
        const parsed = parseWorkflow(raw)
        if (!parsed.ok) {
          return json(response, 400, {
            error: 'invalid_workflow',
            issues: toWireIssues(parsed.issues),
          })
        }
        workflows.set(id, parsed.workflow)
        puts.push({ id, workflow: parsed.workflow })
        return json(response, 200, OkResponseSchema.parse({ ok: true }))
      }
      const held = workflows.get(id)
      if (held === undefined) return json(response, 404, { error: 'unknown_workflow', issues: null })
      const parsed = parseWorkflow(held)
      if (!parsed.ok) {
        return json(response, 409, {
          error: 'invalid_workflow',
          issues: toWireIssues(parsed.issues),
        })
      }
      return json(response, 200, WorkflowResponseSchema.parse({ id, workflow: parsed.workflow }))
    }

    // The five §9 operations. Validated with the daemon's request schemas, so
    // a client posting a shape the real daemon would 400 gets a 400 here.
    const operation = /^\/api\/runs\/([^/]+)\/nodes\/([^/]+)\/([a-z]+)$/.exec(url.pathname)
    if (request.method === 'POST' && operation !== null) {
      const [, rawRun = '', rawNode = '', name = ''] = operation
      const schema = OPERATIONS[name]
      if (schema === undefined) return json(response, 404, { error: 'not_found', issues: null })
      let raw: unknown
      try {
        const text = await readBody(request)
        raw = text.trim() === '' ? {} : JSON.parse(text)
      } catch {
        return json(response, 400, { error: 'invalid_request', issues: null })
      }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        return json(response, 400, { error: 'invalid_request', issues: toIssues(parsed.error) })
      }
      posts.push({
        runId: decodeURIComponent(rawRun),
        nodeId: decodeURIComponent(rawNode),
        operation: name,
        body: parsed.data,
      })
      return json(response, 200, OkResponseSchema.parse({ ok: true }))
    }

    if (url.pathname === '/api/runs') {
      return json(response, 200, RunListResponseSchema.parse({ runs: options.runs }))
    }

    // §13.2's bounded page, with the daemon's own `since`/`limit` semantics:
    // exclusive lower bound, at most `limit` events, and a count of what is
    // left. The reads are recorded because "scrubbing does not refetch" is a
    // claim about requests, and only the server can settle it.
    const events = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname)
    if (events !== null) {
      const runId = decodeURIComponent(events[1] ?? '')
      if (!snapshots.has(runId)) return json(response, 404, { error: 'unknown_run', issues: null })
      const since = Number(url.searchParams.get('since') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '500')
      if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        return json(response, 400, { error: 'invalid_request', issues: null })
      }
      const after = log.filter((event) => event.id > since && event.runId === runId)
      const page = after.slice(0, limit)
      eventReads.push({ runId, since, limit, served: page.length })
      return json(
        response,
        200,
        EventPageSchema.parse({
          runId,
          cursor: page.at(-1)?.id ?? since,
          remaining: after.length - page.length,
          events: page,
        }),
      )
    }

    const usage = /^\/api\/runs\/([^/]+)\/usage$/.exec(url.pathname)
    if (usage !== null) {
      const totals = usageByRun.get(decodeURIComponent(usage[1] ?? ''))
      if (totals === undefined) return json(response, 404, { error: 'unknown_run', issues: null })
      return json(response, 200, RunUsageResponseSchema.parse(totals))
    }

    const node = /^\/api\/runs\/([^/]+)\/nodes\/([^/]+)$/.exec(url.pathname)
    if (node !== null) {
      const key = `${decodeURIComponent(node[1] ?? '')}/${decodeURIComponent(node[2] ?? '')}`
      const detail = details.get(key)
      if (detail === undefined) return json(response, 404, { error: 'unknown_node', issues: null })
      return json(response, 200, NodeDetailSchema.parse(detail))
    }

    const match = /^\/api\/runs\/([^/]+)$/.exec(url.pathname)
    const snapshot =
      match?.[1] === undefined ? undefined : snapshots.get(decodeURIComponent(match[1]))
    if (snapshot === undefined) return json(response, 404, { error: 'unknown_run', issues: null })
    if (options.corrupt === 'snapshot') return json(response, 200, { run: snapshot.run })
    return json(response, 200, RunSnapshotSchema.parse(snapshot))
  }

  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const runId = url.searchParams.get('run') ?? ''
    const since = Number(url.searchParams.get('since') ?? '0')
    const allowed =
      authorized(request.headers.authorization, url) &&
      url.pathname === '/ws' &&
      snapshots.has(runId)
    if (!allowed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const record: Connection = { since, sent: [] }
      connections.push(record)
      attached.set(ws, { runId, cursor: since, record })
      ws.on('close', () => attached.delete(ws))
      // The PTY half of the same socket. The stub does not open a terminal; it
      // records what was said on the channel and answers when a test tells it to.
      ws.on('message', (raw) => {
        const parsed = PtyClientFrameSchema.safeParse(JSON.parse(String(raw)))
        if (parsed.success) ptyFrames.push(parsed.data)
      })
      flush(ws)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub: no port')

  for (const event of options.events ?? []) append(event)

  return {
    origin: `http://127.0.0.1:${address.port}`,
    token: TOKEN,
    connections,
    ptyFrames,
    emitPty(frame) {
      const text = JSON.stringify(PtyServerFrameSchema.parse(frame))
      for (const ws of attached.keys()) {
        if (ws.readyState === ws.OPEN) ws.send(text)
      }
    },
    posts,
    puts,
    eventReads,
    workflow(id) {
      return workflows.get(id)
    },
    emit(...events) {
      for (const event of events) append(event)
      for (const ws of attached.keys()) flush(ws)
    },
    setSnapshot(runId, snapshot) {
      snapshots.set(runId, snapshot)
    },
    setNodeDetail(runId, nodeId, detail) {
      details.set(`${runId}/${nodeId}`, detail)
    },
    drop() {
      for (const ws of [...attached.keys()]) ws.terminate()
    },
    async close() {
      for (const ws of [...attached.keys()]) ws.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }

  function append(event: NewEvent): void {
    const runId = options.runs[0]?.runId ?? ''
    log.push({ id: log.length + 1, ts: Date.now(), runId, ...event })
  }

  /** The journal's contract: everything after the cursor, and nothing else. */
  function flush(ws: WebSocket): void {
    const state = attached.get(ws)
    if (state === undefined || ws.readyState !== ws.OPEN) return
    const pending = log.filter((event) => event.id > state.cursor && event.runId === state.runId)
    const last = pending.at(-1)
    if (last === undefined) return

    const frame: EventFrame = {
      channel: 'events',
      runId: state.runId,
      cursor: last.id,
      events: pending,
    }
    const body =
      options.corrupt === 'frame'
        ? { channel: 'events', events: 'nope' }
        : EventFrameSchema.parse(frame)
    ws.send(JSON.stringify(body))
    state.cursor = last.id
    state.record.sent.push(...pending.map((event) => event.id))
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function authorized(authorization: string | undefined, url: URL): boolean {
  return authorization === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
