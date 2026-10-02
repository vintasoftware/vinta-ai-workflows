/**
 * Forwarding a live run's traffic from `ui` to the job hosting it.
 *
 * A run is a background job: its own process, with its own loopback listener
 * and its own token, which its agents reach it on. `ui` is a separate process
 * that may come and go while the run carries on. Most of what the browser asks
 * for is history, and `ui` answers that from the journal like any other
 * reader. What it cannot answer is anything about the *live* run — the
 * scheduler's statuses, the pools, the five §9 operations, a PTY takeover —
 * because those exist only inside the job.
 *
 * So everything addressed to a run that has a live job is forwarded to it,
 * whole: `/api/runs/<id>` and every path under it, and the run's WebSocket.
 * Per-route forwarding would be a second list of routes to keep in step with
 * `api.ts`; forwarding the prefix is one rule, and the job's API already
 * answers journal reads exactly as `ui` would.
 *
 * **Two tokens, never mixed.** The browser presents `ui`'s token, which `ui`
 * checks before anything is forwarded. The request then leaves with the job's
 * token in `Authorization` and the browser's stripped from the query, so the
 * job never sees `ui`'s secret and the browser never learns the job's.
 *
 * **No fallback once a job is alive.** If the job's process exists but cannot
 * be reached, the answer is a `502`, not the journal's view: a `stop` that fell
 * back to `ui`'s own handler would write a cancellation underneath a scheduler
 * that is still running.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import { errorFields, type Logger } from '../log/index.ts'
import { TOKEN_QUERY } from './auth.ts'

/** Where a live run's job listens, and the token it expects. */
export interface Upstream {
  readonly url: string
  readonly token: string
}

/** Resolves a run id to its live job, or `null` when nothing is hosting it. */
export type UpstreamFor = (runId: string) => Upstream | null

const RUN_PATH = /^\/api\/runs\/([^/]+)(?:\/|$)/

/** The run a path addresses, when it addresses one. `/api/runs` itself does not. */
export function runOfPath(pathname: string): string | null {
  const match = RUN_PATH.exec(pathname)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1] as string)
  } catch {
    return null
  }
}

/** Headers that describe this hop rather than the request. */
const HOP_HEADERS = new Set([
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
])

/** The upstream URL for `url`, minus `ui`'s token. */
function upstreamUrl(upstream: Upstream, url: URL, protocol: 'http' | 'ws'): string {
  const target = new URL(url.pathname, upstream.url)
  for (const [key, value] of url.searchParams) {
    if (key !== TOKEN_QUERY) target.searchParams.append(key, value)
  }
  if (protocol === 'ws') target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  return target.toString()
}

/**
 * One HTTP request, forwarded and answered. Buffered both ways, for the reason
 * the bridge in `server.ts` is: bodies are small commands and bounded reads.
 */
export async function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  upstream: Upstream,
  log: Logger,
): Promise<void> {
  const headers = new Headers()
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] as string).toLowerCase()
    if (!HOP_HEADERS.has(name)) headers.append(name, req.rawHeaders[i + 1] as string)
  }
  headers.set('authorization', `Bearer ${upstream.token}`)

  const method = req.method ?? 'GET'
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    body = Buffer.concat(chunks)
  }

  let response: Response
  try {
    response = await fetch(upstreamUrl(upstream, url, 'http'), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  } catch (error) {
    // The path carries the run id, which is the thing worth knowing; the
    // upstream URL is a port on loopback and is not.
    log.warn('proxy.unreachable', { path: url.pathname, ...errorFields(error) })
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end('{"error":"run_host_unreachable","issues":null}')
    return
  }

  const out: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    // `fetch` has already decoded the body, so its length and encoding are
    // the upstream's and no longer true of the bytes written below.
    if (!HOP_HEADERS.has(name)) out[name] = value
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  res.writeHead(response.status, out)
  res.end(bytes)
}

/**
 * Relays an accepted browser socket to the job's socket for the same URL.
 *
 * Frames are passed through untouched in both directions — event frames one
 * way, PTY frames both — so nothing about the frame contract is restated
 * here. Whichever side closes first closes the other, and a browser frame sent
 * before the upstream socket opened is held, not dropped: the first thing a
 * terminal sends is its size.
 */
export function relaySocket(client: WebSocket, url: URL, upstream: Upstream, log: Logger): void {
  const remote = new WebSocket(upstreamUrl(upstream, url, 'ws'), {
    headers: { authorization: `Bearer ${upstream.token}` },
  })
  const held: { data: WebSocket.RawData; binary: boolean }[] = []

  client.on('message', (data, binary) => {
    if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary })
    else held.push({ data, binary })
  })
  remote.on('open', () => {
    for (const frame of held.splice(0)) remote.send(frame.data, { binary: frame.binary })
  })
  remote.on('message', (data, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
  })

  const closeBoth = (): void => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close()
    }
    if (remote.readyState === WebSocket.OPEN || remote.readyState === WebSocket.CONNECTING) {
      remote.terminate()
    }
  }
  client.on('close', closeBoth)
  remote.on('close', closeBoth)
  client.on('error', closeBoth)
  remote.on('error', (error) => {
    log.warn('proxy.ws_unreachable', { path: url.pathname, ...errorFields(error) })
    closeBoth()
  })
}
