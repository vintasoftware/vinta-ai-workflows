/**
 * The one WebSocket (§10): live events now, PTY bytes later.
 *
 * **Resume is the whole design.** `Journal.events(runId, sinceId)` is
 * exclusive, and that cursor is handed straight to the client on every frame
 * as `cursor`. A client that reconnects with `?since=<cursor>` gets exactly
 * the events committed after the last one it saw — no gap, because the id is a
 * total order over a table that only ever appends; no duplicate, because the
 * bound is exclusive. There is no in-memory ring buffer and no "replay window"
 * to fall out of: the journal *is* the buffer, for the life of the run.
 *
 * **One envelope, discriminated by `channel`.** The PTY channel now rides this
 * same socket, which is why the frame was a tagged union with one member
 * before there was anything to discriminate. Nothing about the event frame
 * changed to make room for it: `PtyChannel` reads the client's `pty` frames
 * off the same socket and writes its own back, and the two channels never see
 * each other's traffic.
 *
 * That placement is also the security boundary, and it is deliberate. A PTY is
 * a shell on the operator's machine; `attach` below is called by `server.ts`
 * only after the token check on the upgrade, and it is the *only* thing that
 * ever constructs a `PtyChannel`. An unauthenticated peer is answered with a
 * bare `401` and a destroyed socket before the protocol switch, so it never
 * reaches this function and no terminal is ever spawned on its behalf.
 *
 * **Why a poll, in a package that has none.** The scheduler never polls
 * because it waits on a promise only a state change resolves. Nothing
 * comparable exists here: `Journal` publishes no change notification, and
 * inventing one would mean editing the journal from the daemon. So the tail is
 * an interval over an indexed `WHERE run_id = ? AND id > ?` — the cheapest
 * query in the schema, run only while a client is attached, and stopped with
 * the last one. When the journal grows a subscription, this loop becomes its
 * subscriber and the frame contract does not change.
 */
import type { WebSocket } from 'ws'
import type { Journal } from '../journal/journal.ts'
import { PtyChannel, type PtyRegistry, takeovers } from './pty.ts'
import type { EventFrame } from './schemas.ts'

const OPEN = 1

export const DEFAULT_POLL_MS = 200

interface Subscription {
  readonly socket: WebSocket
  readonly runId: string
  cursor: number
}

export class EventStream {
  readonly #journal: Journal
  readonly #pollMs: number
  readonly #takeovers: PtyRegistry
  readonly #subscriptions = new Set<Subscription>()
  readonly #terminals = new Set<PtyChannel>()
  #timer: NodeJS.Timeout | null = null

  constructor(
    journal: Journal,
    pollMs: number = DEFAULT_POLL_MS,
    /** Which nodes may be taken over. The process-wide registry by default. */
    takeoverRegistry: PtyRegistry = takeovers,
  ) {
    this.#journal = journal
    this.#pollMs = pollMs
    this.#takeovers = takeoverRegistry
  }

  /**
   * Tails `runId` onto `socket`, starting after `since`. The backlog is
   * flushed before this returns, so a reconnecting client is caught up in one
   * frame rather than after a poll interval.
   */
  attach(socket: WebSocket, runId: string, since: number): void {
    const subscription: Subscription = { socket, runId, cursor: since }
    this.#subscriptions.add(subscription)
    // The PTY half of the same socket. This is the one place a `PtyChannel` is
    // ever built, and it is downstream of the upgrade's token check — which is
    // what makes "no shell without the token" a property of the code path
    // rather than a policy someone has to remember.
    const terminal = new PtyChannel(socket, runId, this.#takeovers)
    this.#terminals.add(terminal)
    socket.on('close', () => {
      this.#subscriptions.delete(subscription)
      this.#terminals.delete(terminal)
      // A dropped socket must not leave a shell running with nothing reading it.
      void terminal.close()
      if (this.#subscriptions.size === 0) this.#stop()
    })
    this.#flush(subscription)
    if (this.#timer === null) {
      this.#timer = setInterval(() => this.#tick(), this.#pollMs)
    }
  }

  /**
   * Drops every subscription and the timer, and tears down every terminal.
   *
   * Sockets are closed by the server; a pty is not a socket and would outlive
   * one, so it is signalled here. The signature stays synchronous because the
   * caller's is: a `detach` signals the group immediately and then waits for
   * the reap, so the process is dying before this returns whether or not
   * anybody awaited the wait.
   */
  close(): void {
    this.#subscriptions.clear()
    this.#stop()
    const terminals = [...this.#terminals]
    this.#terminals.clear()
    for (const terminal of terminals) void terminal.close()
  }

  #tick(): void {
    for (const subscription of this.#subscriptions) this.#flush(subscription)
  }

  #flush(subscription: Subscription): void {
    if (subscription.socket.readyState !== OPEN) return
    const events = this.#journal.events(subscription.runId, subscription.cursor)
    const last = events.at(-1)
    if (last === undefined) return

    const frame: EventFrame = {
      channel: 'events',
      runId: subscription.runId,
      cursor: last.id,
      events: events.map((event) => ({
        id: event.id,
        ts: event.ts,
        runId: event.runId,
        nodeId: 'nodeId' in event ? event.nodeId : null,
        type: event.type,
        payload: event.payload,
      })),
    }
    // The cursor advances only once the frame is on the socket, so a send that
    // throws leaves the client's position where the client last saw it.
    subscription.socket.send(JSON.stringify(frame))
    subscription.cursor = last.id
  }

  #stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }
}
