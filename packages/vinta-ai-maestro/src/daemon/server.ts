/**
 * The daemon process: one HTTP listener, one WebSocket path, one token.
 *
 * §11's four rules are enforced here rather than described:
 *
 * - **`127.0.0.1` by default.** `host` defaults to loopback and a non-loopback
 *   bind must be asked for by name. This is the difference between a port only
 *   this machine can reach and a port every machine on the café wifi can, and
 *   the default is the one that cannot surprise anybody.
 * - **A warning on `--host`.** Binding wider is legitimate — a remote dev box,
 *   a container — so it is allowed and announced. The warning names the host
 *   and never the token.
 * - **The token on every request.** Enforced by the API's own middleware for
 *   HTTP, and by `#upgrade` below for the WebSocket.
 * - **Rejected at the handshake.** An unauthenticated upgrade is answered with
 *   a plain `401` on the raw socket and the socket is destroyed — the protocol
 *   switch never happens, so there is no moment at which an unauthenticated
 *   peer holds a WebSocket to close afterwards. Closing after `handleUpgrade`
 *   would mean an anonymous client had already been handed a live channel and
 *   had to be trusted to honour a close frame.
 *
 * Hono runs on the Fetch API, so the bridge below converts one `IncomingMessage`
 * into a `Request` and the `Response` back. Bodies are small JSON commands and
 * bounded snapshot reads, so buffering both directions is honest here; a
 * streaming adapter would be a dependency this package does not have.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { Journal } from '../journal/journal.ts'
import type { Monitor } from '../monitor/monitor.ts'
import { createApi } from './api.ts'
import { createToken, isLoopback, presentedToken, tokenMatches } from './auth.ts'
import type { DaemonRun, RunStartPort } from './control.ts'
import { DEFAULT_POLL_MS, EventStream } from './stream.ts'

/** The only path that upgrades. Everything else is HTTP (§10). */
const WS_PATH = '/ws'
const LOOPBACK = '127.0.0.1'

/** Hop-by-hop and framing headers that belong to the node socket, not the Request. */
const SKIPPED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
])

export interface DaemonOptions {
  readonly journal: Journal
  /** Defaults to `127.0.0.1`. Anything else is `--host`, and is warned about. */
  readonly host?: string
  /** Defaults to `0` — an OS-assigned port, printed with the URL. */
  readonly port?: number
  /** Defaults to a fresh 256-bit random token. Supplying one is for tests. */
  readonly token?: string
  readonly pollMs?: number
  /**
   * Where the built UI is read from (§10). Defaults to this package's
   * `dist/ui`; supplying one is for tests. Nothing outside it is ever served.
   */
  readonly uiDir?: string
  /** Where the `--host` warning goes. `console.warn` by default. */
  readonly warn?: (message: string) => void
  /**
   * Builds the monitor for a run (`monitor/monitor.ts`). Absent for a host that
   * wired no harness, and then the endpoint refuses instead of pretending.
   */
  readonly monitorFor?: (runId: string) => Monitor | null
  /** Passed through to the API: how long a lease request waits before `202`. */
  readonly leaseWaitMs?: number
}

export interface Daemon {
  /** `http://host:port`, without the token. */
  readonly url: string
  readonly host: string
  readonly port: number
  /** Required on every request and on the upgrade. Never logged (§11). */
  readonly token: string
  /** Makes a run reachable. Runs are registered as they start. */
  register(run: DaemonRun): void
  /**
   * Lets `POST /api/runs` start runs on this daemon. Until it is called — and
   * on a host that never calls it — that endpoint refuses.
   *
   * After boot rather than in `DaemonOptions`, because of a genuine ordering
   * knot: a run's agents are told where to reach the daemon through
   * `MAESTRO_URL`/`MAESTRO_TOKEN`, so anything that can start a run needs the
   * URL and the token — and both only exist once the listener has a port. The
   * alternative was a factory taking a half-built daemon, which is a worse
   * thing to have to reason about than one setter.
   */
  acceptRuns(starter: RunStartPort): void
  close(): Promise<void>
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const host = options.host ?? LOOPBACK
  const token = options.token ?? createToken()
  const runs = new Map<string, DaemonRun>()
  // Read through a getter below, so `acceptRuns` after boot is visible to a
  // request that arrives after it.
  let starter: RunStartPort | undefined

  if (!isLoopback(host)) {
    const warn = options.warn ?? ((message: string) => console.warn(message))
    warn(
      `vinta-ai-maestro: binding to non-loopback host "${host}". The API and its runs are ` +
        'reachable from other machines on this network; the token is the only thing ' +
        'between them and this project.',
    )
  }

  const app = createApi({
    journal: options.journal,
    token,
    runs,
    get runStarter(): RunStartPort | undefined {
      return starter
    },
    ...(options.uiDir === undefined ? {} : { uiDir: options.uiDir }),
    ...(options.monitorFor === undefined ? {} : { monitorFor: options.monitorFor }),
    ...(options.leaseWaitMs === undefined ? {} : { leaseWaitMs: options.leaseWaitMs }),
  })
  const stream = new EventStream(options.journal, options.pollMs ?? DEFAULT_POLL_MS)
  const sockets = new WebSocketServer({ noServer: true })

  const server = createServer((req, res) => {
    void respond(app, req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    upgrade({ req, socket, head, token, runs, sockets, stream })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('daemon: listener did not report a port')
  }

  return {
    url: `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`,
    host: address.address,
    port: address.port,
    token,
    register(run: DaemonRun): void {
      runs.set(run.runId, run)
    },
    acceptRuns(port: RunStartPort): void {
      starter = port
    },
    async close(): Promise<void> {
      stream.close()
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
      // Keep-alive connections would otherwise hold `close` open until they
      // time out, which is a handle outliving the daemon by any definition.
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}

interface UpgradeContext {
  readonly req: IncomingMessage
  readonly socket: Duplex
  readonly head: Buffer
  readonly token: string
  readonly runs: ReadonlyMap<string, DaemonRun>
  readonly sockets: WebSocketServer
  readonly stream: EventStream
}

/** Auth first, then the run, then the protocol switch. Never the other way round. */
function upgrade(context: UpgradeContext): void {
  const { req, socket, head } = context
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? LOOPBACK}`)

  if (!tokenMatches(context.token, presentedToken(req.headers.authorization, url))) {
    return refuse(socket, 401, 'Unauthorized')
  }
  if (url.pathname !== WS_PATH) return refuse(socket, 404, 'Not Found')

  const runId = url.searchParams.get('run') ?? ''
  if (!context.runs.has(runId)) return refuse(socket, 404, 'Not Found')

  const since = Number(url.searchParams.get('since') ?? '0')
  if (!Number.isInteger(since) || since < 0) return refuse(socket, 400, 'Bad Request')

  context.sockets.handleUpgrade(req, socket, head, (ws) => {
    context.stream.attach(ws, runId, since)
  })
}

/** A bare HTTP response on the raw socket: no protocol switch ever happens. */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

// ---------------------------------------------------------------------------
// The Fetch bridge
// ---------------------------------------------------------------------------

async function respond(
  app: ReturnType<typeof createApi>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const response = await app.fetch(await toRequest(req))
    const body = Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(body)
  } catch {
    // Identifiers only, and here there are none worth carrying: the failure is
    // in the bridge, and the caller gets a status rather than an internal.
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":"internal","issues":null}')
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] as string).toLowerCase()
    if (!SKIPPED_HEADERS.has(name)) headers.append(name, req.rawHeaders[i + 1] as string)
  }

  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? LOOPBACK}`)
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers })

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new Request(url, { method, headers, body: Buffer.concat(chunks) })
}
