/**
 * The bridge from `node:http` to a Hono app.
 *
 * Hono runs on the Fetch API, so one `IncomingMessage` becomes a `Request` and
 * the `Response` is written back. Bodies are small JSON commands and bounded
 * reads, so buffering the request is honest here; a streaming adapter would be
 * a dependency this package does not have. The *response* is streamed, chunk
 * by chunk: an answer that streams (`exec`'s NDJSON, an event stream) must
 * reach the client as it is produced, not once it has ended.
 *
 * Shared by the daemon (`server.ts`) and the interview server
 * (`../interview/server.ts`), which is the reason it is its own module: two
 * copies of this would be two places for the abort handling to drift.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Hono } from 'hono'
import { errorFields, type Logger } from '../log/index.ts'

export const LOOPBACK = '127.0.0.1'

/** Hop-by-hop and framing headers that belong to the node socket, not the Request. */
const SKIPPED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
])

export async function respond(
  app: Hono,
  req: IncomingMessage,
  res: ServerResponse,
  log: Logger,
): Promise<void> {
  // The client going away aborts the request, which a streaming route (`exec`)
  // listens to; before this nothing did, and a command whose client was gone
  // ran on with nobody attached.
  const gone = new AbortController()
  res.once('close', () => {
    if (!res.writableFinished) gone.abort()
  })
  try {
    const response = await app.fetch(await toRequest(req, gone.signal))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    // Streamed, chunk by chunk, rather than read whole first: an answer that
    // streams (`exec`'s NDJSON) used to reach the client only once it had
    // ended — so a command queued behind the integration worktree sent
    // nothing at all for minutes, and its client gave up on a daemon that was
    // there.
    if (response.body === null) {
      res.end()
      return
    }
    const reader = response.body.getReader()
    gone.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      res.write(chunk.value)
    }
    res.end()
  } catch (error) {
    if (gone.signal.aborted) return
    // The client still gets a status and no internals — that part of the
    // contract is unchanged. What changed is that the failure is no longer
    // *only* a status: this used to be a bare `catch {}`, so a bridge that
    // broke on every request produced a UI showing 500s and a daemon with
    // nothing at all to say about them.
    //
    // The error's kind, never its message (`errorKind`): a body that failed to
    // parse is a body, and this is the handler that was holding it.
    log.error('bridge.threw', {
      method: req.method ?? 'GET',
      path: new URL(req.url ?? '/', `http://${req.headers.host ?? LOOPBACK}`).pathname,
      ...errorFields(error),
    })
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":"internal","issues":null}')
  }
}

async function toRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const headers = new Headers()
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] as string).toLowerCase()
    if (!SKIPPED_HEADERS.has(name)) headers.append(name, req.rawHeaders[i + 1] as string)
  }

  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? LOOPBACK}`)
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers, signal })

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new Request(url, { method, headers, body: Buffer.concat(chunks), signal })
}
