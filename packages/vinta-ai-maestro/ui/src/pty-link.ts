/**
 * The PTY channel of §10's one socket, as the terminal view sees it.
 *
 * The run stream owns the socket — it opens it, resumes it at a cursor and
 * reopens it when it drops — and the terminal is a panel that comes and goes
 * inside a view that is already connected. So the two are joined by this
 * indirection rather than by the terminal opening a second connection: the
 * link outlives any one socket, `useRun` points it at whichever one is
 * currently open, and the terminal only ever holds the link.
 *
 * A frame sent while nothing is open is dropped rather than queued. The
 * daemon tears the pty down when the socket goes, so there is no session for a
 * held-back keystroke to arrive in; the terminal re-attaches on `onOpen`
 * instead, which is the honest thing to replay.
 *
 * Nothing here reads `data`. Terminal bytes pass through this module untouched
 * and unlogged (§11), and no frame is ever stringified into a message.
 */
import type { PtyClientFrame, PtyServerFrame } from '../../src/daemon/pty-frames.ts'

export interface PtyListener {
  /** Called on subscribe if a socket is already open, and on every reconnect. */
  readonly onOpen: () => void
  readonly onFrame: (frame: PtyServerFrame) => void
  readonly onClose: () => void
}

/** What the terminal view is given: send, and listen. */
export interface PtyLink {
  readonly send: (frame: PtyClientFrame) => void
  /** Subscribes. The returned function unsubscribes. */
  readonly listen: (listener: PtyListener) => () => void
}

/** The other half, driven by whoever owns the socket. */
export interface PtyPort extends PtyLink {
  readonly opened: (send: (frame: PtyClientFrame) => void) => void
  readonly closed: () => void
  readonly deliver: (frame: PtyServerFrame) => void
}

export function createPtyLink(): PtyPort {
  const listeners = new Set<PtyListener>()
  let write: ((frame: PtyClientFrame) => void) | null = null

  return {
    send(frame) {
      write?.(frame)
    },
    listen(listener) {
      listeners.add(listener)
      // A terminal opened while the run is already connected has no `open`
      // event coming, and would otherwise sit there having attached to nothing.
      if (write !== null) listener.onOpen()
      return () => {
        listeners.delete(listener)
      }
    },
    opened(send) {
      write = send
      for (const listener of listeners) listener.onOpen()
    },
    closed() {
      if (write === null) return
      write = null
      for (const listener of listeners) listener.onClose()
    },
    deliver(frame) {
      for (const listener of listeners) listener.onFrame(frame)
    },
  }
}
