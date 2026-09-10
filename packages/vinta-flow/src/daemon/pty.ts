/**
 * §9's fifth operation over §10's one socket: interrupt → PTY attach → detach
 * → resume headless, with the session id as the handoff token.
 *
 * ---------------------------------------------------------------------------
 * What stops an unauthenticated peer from getting a shell
 * ---------------------------------------------------------------------------
 *
 * A PTY is a shell on the operator's machine, with the operator's privileges,
 * in a worktree full of their code. It is by a wide margin the most dangerous
 * thing this daemon can be asked for, so the boundary is worth stating rather
 * than assuming. Four things stand between a peer and a prompt, and each is
 * strictly before the next:
 *
 * 1. **The bind.** `127.0.0.1` unless `--host` was asked for by name (§11).
 * 2. **The token, at the handshake.** `server.ts` checks it on the upgrade and
 *    answers a failure with a bare `401` on the raw socket, which it then
 *    destroys — the protocol switch never happens. `EventStream.attach` is the
 *    only caller of `PtyChannel`, and it runs *after* that check, so an
 *    unauthenticated peer never reaches a line of this file. No process is
 *    spawned to be closed afterwards, because none was ever spawned.
 * 3. **The registry.** A `PtyChannel` can only attach to a node some host has
 *    explicitly offered as a takeover target. Nothing is reachable by default:
 *    an attach for a run or node with no offer is a fixed `unknown_node`.
 * 4. **The client names a node, never a command.** `attach` carries a node id
 *    and a terminal size. *What* runs is `adapter.attachPty`'s decision, the
 *    session id is the registry's, and the cwd is the lane's — none of the
 *    three is on the wire. There is no frame that means "run this".
 *
 * ---------------------------------------------------------------------------
 * What never happens to the bytes
 * ---------------------------------------------------------------------------
 *
 * They go from the pty to one socket and back, and nowhere else. Not a log
 * line, not an error message, not the journal, not a transcript. The `error`
 * frame is a fixed token from a closed set for exactly that reason (§11).
 */
import type { WebSocket } from 'ws'
import type { HarnessAdapter, PtyHandle } from '../harness/adapter.ts'
import {
  type PtyError,
  type PtyServerFrame,
  PtyClientFrameSchema,
} from './pty-frames.ts'

const OPEN = 1

/**
 * One node a host is willing to hand over. Assembled by whoever owns the live
 * session — the scheduler keeps `{ session, adapter }` per node and journals
 * the session id — because only it knows which id and which lane are current.
 *
 * `interrupt` and `resume` are the two halves of §9 around the attach. They
 * are the host's because the round trip is a scheduling decision: this module
 * decides *when* they run, never what stopping and restarting a node means.
 */
export interface TakeoverTarget {
  readonly adapter: Pick<HarnessAdapter, 'id' | 'capabilities' | 'attachPty'>
  /** The headless session's id — §9's handoff token. */
  readonly sessionId: string
  /** The lane worktree the headless turn ran in. */
  readonly cwd: string
  /** Stops the headless turn. Runs before the terminal opens. */
  interrupt(): Promise<void>
  /**
   * Restarts the node headless from the id the terminal held. Runs once the
   * operator detaches — which is the whole reason the id had to survive.
   */
  resume(sessionId: string): Promise<void>
}

/**
 * Which nodes may be taken over. Empty until a host offers something, which is
 * what makes "reachable" an explicit decision rather than a consequence of
 * running a node.
 */
export class PtyRegistry {
  readonly #targets = new Map<string, TakeoverTarget>()

  /** Offers a node. The returned function withdraws it. */
  offer(runId: string, nodeId: string, target: TakeoverTarget): () => void {
    const key = keyOf(runId, nodeId)
    this.#targets.set(key, target)
    return () => {
      if (this.#targets.get(key) === target) this.#targets.delete(key)
    }
  }

  find(runId: string, nodeId: string): TakeoverTarget | undefined {
    return this.#targets.get(keyOf(runId, nodeId))
  }
}

const keyOf = (runId: string, nodeId: string): string => `${runId}\0${nodeId}`

/** The process-wide registry `EventStream` consults when a host supplies none. */
export const takeovers = new PtyRegistry()

/**
 * §9's round trip, in the order the spec states it. The resume is hung off
 * `exited` rather than off `detach` so it happens however the terminal ended —
 * the operator detaching, the CLI quitting, the socket dropping.
 */
export async function takeOver(
  target: TakeoverTarget,
  cols: number,
  rows: number,
): Promise<PtyHandle> {
  await target.interrupt()
  const attachPty = target.adapter.attachPty
  if (attachPty === undefined) throw new Error(`harness ${target.adapter.id} has no attachPty`)
  const handle = await attachPty.call(target.adapter, target.sessionId, {
    cwd: target.cwd,
    cols,
    rows,
  })
  void handle.exited.then(
    () => target.resume(handle.sessionId),
    () => {},
  )
  return handle
}

/**
 * The PTY half of one client socket. Created per connection by
 * `EventStream.attach`, which is reached only after the token check.
 *
 * At most one terminal per socket: a second `attach` is refused rather than
 * silently replacing the first, because replacing it would leave a shell
 * running with nothing reading it.
 */
export class PtyChannel {
  #handle: PtyHandle | null = null
  #attaching = false

  constructor(
    private readonly socket: WebSocket,
    private readonly runId: string,
    private readonly registry: PtyRegistry,
  ) {
    socket.on('message', (raw: unknown) => {
      void this.#receive(raw)
    })
  }

  /** Ends the terminal and waits for it to be reaped. Idempotent. */
  async close(): Promise<void> {
    const handle = this.#handle
    this.#handle = null
    await handle?.detach()
  }

  async #receive(raw: unknown): Promise<void> {
    const parsed = PtyClientFrameSchema.safeParse(read(raw))
    // Anything that is not one of our frames is not ours to answer: the same
    // socket may grow other channels, and a client that speaks nonsense on one
    // must not be able to make the daemon speak about it.
    if (!parsed.success) return
    const frame = parsed.data

    switch (frame.type) {
      case 'attach':
        await this.#attach(frame.nodeId, frame.cols, frame.rows)
        return
      case 'input':
        this.#handle?.write(frame.data)
        return
      case 'resize':
        this.#handle?.resize(frame.cols, frame.rows)
        return
      case 'detach':
        await this.close()
        return
    }
  }

  async #attach(nodeId: string, cols: number, rows: number): Promise<void> {
    if (this.#handle !== null || this.#attaching) return this.#fail('already_attached')
    const target = this.registry.find(this.runId, nodeId)
    if (target === undefined) return this.#fail('unknown_node')
    if (!target.adapter.capabilities.pty || target.adapter.attachPty === undefined) {
      return this.#fail('not_supported')
    }

    this.#attaching = true
    let handle: PtyHandle
    try {
      handle = await takeOver(target, cols, rows)
    } catch {
      // Deliberately not carried: the cause is a vendor's words about a
      // session, and the operator gets a status instead (§11).
      this.#attaching = false
      return this.#fail('attach_failed')
    }
    this.#attaching = false

    // The socket closed while the CLI was starting. Tear the terminal down
    // rather than leaving a shell with no reader.
    if (this.socket.readyState !== OPEN) {
      await handle.detach()
      return
    }

    this.#handle = handle
    handle.onData((data) => this.#send({ channel: 'pty', type: 'data', data }))
    void handle.exited.then((code) => {
      if (this.#handle === handle) this.#handle = null
      this.#send({ channel: 'pty', type: 'exit', code })
    })
    this.#send({ channel: 'pty', type: 'attached', nodeId, sessionId: handle.sessionId })
  }

  #fail(reason: PtyError): void {
    this.#send({ channel: 'pty', type: 'error', reason })
  }

  #send(frame: PtyServerFrame): void {
    if (this.socket.readyState !== OPEN) return
    this.socket.send(JSON.stringify(frame))
  }
}

/** `ws` hands a message as a Buffer, an ArrayBuffer or an array of them. */
function read(raw: unknown): unknown {
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw as Buffer[]).toString('utf8')
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString('utf8')
            : null
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
