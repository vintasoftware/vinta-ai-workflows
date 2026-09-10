/**
 * The daemon, as the browser sees it: two GETs and one WebSocket (§10).
 *
 * Three rules shaped this file.
 *
 * - **The daemon's schemas are the contract.** Every response is run through
 *   the zod schema the daemon serialised it from, imported rather than
 *   restated. A field that changes shape fails here, loudly, instead of
 *   rendering as `undefined` three components away.
 * - **The token never becomes text.** It rides in an `Authorization` header on
 *   HTTP. The one place it must appear in a URL is the WebSocket upgrade — a
 *   browser cannot set a header there — and that URL is built, used and
 *   dropped: it is never rendered into an `href`, never put in a message, and
 *   nothing in this file logs.
 * - **Failures carry a status, not a body.** A response body may hold
 *   transcript text; an error message that quoted one would be a second copy
 *   of the repository in the browser's console (§11). Errors here name the
 *   endpoint and the status code, and nothing else.
 */
import {
  FrameSchema,
  RunListResponseSchema,
  RunSnapshotSchema,
  type EventFrame,
  type RunSnapshot,
  type RunSummary,
} from '../../src/daemon/schemas.ts'
import type { z } from 'zod'

/** Mirrors `daemon/auth.ts`'s `TOKEN_QUERY`; that module is Node-only. */
const TOKEN_QUERY = 'token'
const WS_PATH = '/ws'

export type StreamClose = 'closed' | 'invalid_frame'

export interface StreamHandlers {
  readonly onOpen: () => void
  readonly onFrame: (frame: EventFrame) => void
  /** `invalid_frame` is fatal — a server this client cannot read is not one to retry. */
  readonly onClose: (reason: StreamClose) => void
}

export interface Client {
  readonly runs: () => Promise<readonly RunSummary[]>
  readonly snapshot: (runId: string) => Promise<RunSnapshot>
  /** Tails `runId` from after `since`. The returned function detaches. */
  readonly stream: (runId: string, since: number, handlers: StreamHandlers) => () => void
}

/**
 * `origin` is where the daemon lives — the page's own origin in the browser,
 * since the daemon serves this bundle, and an ephemeral port in tests.
 */
export function createClient(origin: string, token: string): Client {
  return {
    async runs() {
      return (await get('/api/runs', RunListResponseSchema)).runs
    },
    async snapshot(runId) {
      return await get(`/api/runs/${encodeURIComponent(runId)}`, RunSnapshotSchema)
    },
    stream(runId, since, handlers) {
      const url = new URL(WS_PATH, origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('run', runId)
      url.searchParams.set('since', String(since))
      url.searchParams.set(TOKEN_QUERY, token)

      let reason: StreamClose = 'closed'
      const socket = new WebSocket(url.toString())
      socket.addEventListener('open', () => handlers.onOpen())
      socket.addEventListener('message', (event) => {
        const frame = readFrame(event.data)
        if (frame === null) {
          reason = 'invalid_frame'
          socket.close()
          return
        }
        // Step 17 adds a PTY channel to this same socket; this switch is why
        // a client written today keeps working when it does.
        if (frame.channel !== 'events') return
        handlers.onFrame(frame)
      })
      // A socket error is always followed by a close, so `close` is the only
      // place that has to decide anything.
      socket.addEventListener('error', () => {})
      socket.addEventListener('close', () => handlers.onClose(reason))

      return () => socket.close()
    },
  }

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`${path}: daemon answered ${response.status}`)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new Error(`${path}: response did not match the daemon schema`)
    return parsed.data
  }
}

function readFrame(data: unknown): EventFrame | null {
  if (typeof data !== 'string') return null
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = FrameSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
