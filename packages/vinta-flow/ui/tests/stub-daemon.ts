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
import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  EventFrameSchema,
  RunListResponseSchema,
  RunSnapshotSchema,
  type EventFrame,
  type RunSnapshot,
  type RunSummary,
} from '../../src/daemon/schemas.ts'

type StoredEvent = EventFrame['events'][number]

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

export interface StubOptions {
  readonly runs: readonly RunSummary[]
  readonly snapshots: Readonly<Record<string, RunSnapshot>>
  readonly events?: readonly NewEvent[]
  /** Serve a body that does not match the schema, to prove the client parses. */
  readonly corrupt?: 'snapshot' | 'frame'
}

export interface StubDaemon {
  readonly origin: string
  readonly token: string
  /** One entry per accepted upgrade, in order, with the `since` it asked for. */
  readonly connections: readonly Connection[]
  readonly emit: (...events: NewEvent[]) => void
  readonly setSnapshot: (runId: string, snapshot: RunSnapshot) => void
  /** Kills every open socket without a close handshake — a dropped connection. */
  readonly drop: () => void
  readonly close: () => Promise<void>
}

const TOKEN = 'stub-token'

export async function startStubDaemon(options: StubOptions): Promise<StubDaemon> {
  const snapshots = new Map(Object.entries(options.snapshots))
  const log: StoredEvent[] = []
  const connections: Connection[] = []
  const attached = new Map<WebSocket, { runId: string; cursor: number; record: Connection }>()

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!authorized(request.headers.authorization, url)) return json(response, 401, { error: 'unauthorized', issues: null })

    if (url.pathname === '/api/runs') {
      return json(response, 200, RunListResponseSchema.parse({ runs: options.runs }))
    }
    const match = /^\/api\/runs\/([^/]+)$/.exec(url.pathname)
    const snapshot = match?.[1] === undefined ? undefined : snapshots.get(decodeURIComponent(match[1]))
    if (snapshot === undefined) return json(response, 404, { error: 'unknown_run', issues: null })
    if (options.corrupt === 'snapshot') return json(response, 200, { run: snapshot.run })
    return json(response, 200, RunSnapshotSchema.parse(snapshot))
  })

  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const runId = url.searchParams.get('run') ?? ''
    const since = Number(url.searchParams.get('since') ?? '0')
    if (!authorized(request.headers.authorization, url) || url.pathname !== '/ws' || !snapshots.has(runId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const record: Connection = { since, sent: [] }
      connections.push(record)
      attached.set(ws, { runId, cursor: since, record })
      ws.on('close', () => attached.delete(ws))
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
    emit(...events) {
      for (const event of events) append(event)
      for (const ws of attached.keys()) flush(ws)
    },
    setSnapshot(runId, snapshot) {
      snapshots.set(runId, snapshot)
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
    ws.send(JSON.stringify(options.corrupt === 'frame' ? { channel: 'events', events: 'nope' } : EventFrameSchema.parse(frame)))
    state.cursor = last.id
    state.record.sent.push(...pending.map((event) => event.id))
  }
}

function authorized(authorization: string | undefined, url: URL): boolean {
  return authorization === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
