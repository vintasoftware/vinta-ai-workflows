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
import type { PtyClientFrame, PtyServerFrame } from '../../src/daemon/pty-frames.ts'
import {
  AddContextRequestSchema,
  AnswerRequestSchema,
  FrameSchema,
  NoArgsRequestSchema,
  NodeDetailSchema,
  MonitorAnswerSchema,
  MonitorHistorySchema,
  RunUsageResponseSchema,
  OkResponseSchema,
  RedirectRequestSchema,
  RunListResponseSchema,
  RunSnapshotSchema,
  type EventFrame,
  type Frame,
  type NodeDetail,
  type RunUsageResponse,
  type RunSnapshot,
  type RunSummary,
  type MonitorAnswer,
} from '../../src/daemon/schemas.ts'
import type { z } from 'zod'

/** Mirrors `daemon/auth.ts`'s `TOKEN_QUERY`; that module is Node-only. */
const TOKEN_QUERY = 'token'
const WS_PATH = '/ws'

/**
 * How much transcript the node view asks for. The endpoint tails — it never
 * pages backwards — so this is the whole window the operator can scroll, and
 * the view windows it again before it reaches the DOM.
 */
export const TRANSCRIPT_LIMIT = 500

/**
 * The five operations of §9, keyed by their endpoint segment and carrying the
 * daemon's own request schema. Bodies are validated here before they are sent:
 * the daemon rejects an unknown key with a 400, and a client that can only
 * post what the schema accepts cannot earn one.
 */
const OPERATIONS = {
  context: AddContextRequestSchema,
  redirect: RedirectRequestSchema,
  pause: NoArgsRequestSchema,
  abort: NoArgsRequestSchema,
  answer: AnswerRequestSchema,
  // Not one of §9's five: it reaches a node that has stopped rather than
  // steering one that is running. It travels the same way because the shape is
  // the same — a node, a verb, a code back.
  retry: NoArgsRequestSchema,
} as const

export type NodeOperation = keyof typeof OPERATIONS
export type OperationBody<K extends NodeOperation> = z.infer<(typeof OPERATIONS)[K]>

export type StreamClose = 'closed' | 'invalid_frame'

export interface StreamHandlers {
  readonly onOpen: () => void
  readonly onFrame: (frame: EventFrame) => void
  /** The PTY half of the same socket (§10). Bytes are passed on, never read. */
  readonly onPty: (frame: PtyServerFrame) => void
  /** `invalid_frame` is fatal — a server this client cannot read is not one to retry. */
  readonly onClose: (reason: StreamClose) => void
}

/** An open run stream. Both channels of §10's socket, and the one close. */
export interface Stream {
  /** Puts a PTY frame on this socket; dropped while it is not open. */
  readonly send: (frame: PtyClientFrame) => void
  readonly close: () => void
}

export interface Client {
  readonly runs: () => Promise<readonly RunSummary[]>
  readonly snapshot: (runId: string) => Promise<RunSnapshot>
  /** The node view's read: transcript tail, gate logs, diff ref, question (§10). */
  readonly node: (runId: string, nodeId: string) => Promise<NodeDetail>
  /**
   * The run-level rollup: reuse counts and token/cost/cache totals (§15.6).
   *
   * Its own read rather than part of the snapshot, because the daemon folds
   * every transcript in the run to answer it — see the route's own note. The
   * run view therefore asks for it on a slow cadence, not on every frame.
   */
  readonly usage: (runId: string) => Promise<RunUsageResponse>
  /** One §9 operation. Resolves when the daemon accepted it, and returns nothing. */
  readonly operate: <K extends NodeOperation>(
    runId: string,
    nodeId: string,
    operation: K,
    body: OperationBody<K>,
  ) => Promise<void>
  /**
   * Ask the run's monitor a question, and wait for its answer.
   *
   * Not an operation: it changes nothing about the run, and it works on one
   * that has already finished — which is when most of the questions get asked.
   * Slow by nature, because a model is thinking; the caller shows that.
   */
  readonly ask: (runId: string, text: string) => Promise<MonitorAnswer>
  /**
   * Everything said to and by the monitor about this run, oldest first.
   *
   * Entries are transcript entries — the same shape a phase's are — so the
   * conversation renders through the component that already knows how.
   */
  readonly conversation: (runId: string) => Promise<readonly unknown[]>
  /** Tails `runId` from after `since`. Closing the returned stream detaches. */
  readonly stream: (runId: string, since: number, handlers: StreamHandlers) => Stream
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
    async node(runId, nodeId) {
      return await get(`${nodePath(runId, nodeId)}?limit=${TRANSCRIPT_LIMIT}`, NodeDetailSchema)
    },
    async usage(runId) {
      return await get(`/api/runs/${encodeURIComponent(runId)}/usage`, RunUsageResponseSchema)
    },
    async operate(runId, nodeId, operation, body) {
      const path = `${nodePath(runId, nodeId)}/${operation}`
      const parsed = OPERATIONS[operation].safeParse(body)
      // The body never reaches this message: it is steering text the operator
      // typed, and an error is the one place it must not be copied to (§11).
      if (!parsed.success) throw new Error(`${path}: request did not match the daemon schema`)
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      })
      if (!response.ok) throw new Error(`${path}: daemon answered ${response.status}`)
      if (!OkResponseSchema.safeParse(await response.json()).success) {
        throw new Error(`${path}: response did not match the daemon schema`)
      }
    },
    async conversation(runId) {
      const path = `/api/runs/${encodeURIComponent(runId)}/monitor`
      const response = await fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error(`${path}: daemon answered ${response.status}`)
      const parsed = MonitorHistorySchema.safeParse(await response.json())
      if (!parsed.success) throw new Error(`${path}: response did not match the daemon schema`)
      return parsed.data.entries
    },
    async ask(runId, text) {
      const path = `/api/runs/${encodeURIComponent(runId)}/monitor`
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      // The operator's own question never reaches this message, for the reason
      // `operate` gives: what they typed is not error-message material (§11).
      if (!response.ok) throw new Error(`${path}: daemon answered ${response.status}`)
      const parsed = MonitorAnswerSchema.safeParse(await response.json())
      if (!parsed.success) throw new Error(`${path}: response did not match the daemon schema`)
      return parsed.data
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
        // Both channels ride this socket (§10), which is why the terminal
        // does not open a second one: a `pty` frame is handed to the channel
        // that wants it rather than being unparseable and closing the run's.
        if (frame.channel === 'pty') {
          handlers.onPty(frame)
          return
        }
        handlers.onFrame(frame)
      })
      // A socket error is always followed by a close, so `close` is the only
      // place that has to decide anything.
      socket.addEventListener('error', () => {})
      socket.addEventListener('close', () => handlers.onClose(reason))

      return {
        send(frame) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
        },
        close() {
          socket.close()
        },
      }
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

function nodePath(runId: string, nodeId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`
}

function readFrame(data: unknown): Frame | null {
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
