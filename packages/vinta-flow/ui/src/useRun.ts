/**
 * One run, watched live.
 *
 * The shape of this hook is dictated by what the daemon can and cannot tell
 * us:
 *
 * - **Node status comes off the stream.** Every `node_status` event folds into
 *   the projection the moment it arrives, which is what makes the graph move.
 * - **Pools, gate leases and harness windows come off the snapshot**, because
 *   they are live scheduler state and no event carries them. Rather than poll
 *   on a timer, the snapshot is re-read whenever a frame lands: a frame is the
 *   daemon saying something moved, and nothing moves the pools without also
 *   writing an event.
 * - **Resume is the cursor, and only the cursor.** Every frame carries the id
 *   of its last event; that id is the next connection's `since` and is kept in
 *   `sessionStorage` so a reload resumes where the tab left off instead of
 *   replaying the run. It is a read position, not state: losing it costs a
 *   replay, and the fold is idempotent, so a replay costs nothing.
 *
 * A dropped socket reconnects on a fixed delay. A frame that does not match
 * the daemon's schema does not: a server this client cannot read will not
 * become readable by trying again, and a reconnect loop against one is just a
 * quieter way of failing.
 */
import { useEffect, useState } from 'react'
import type { RunSnapshot } from '../../src/daemon/schemas.ts'
import type { Client } from './client.ts'
import { applyFrame, EMPTY_PROJECTION, type Projection } from './projection.ts'

const RECONNECT_MS = 300
const CURSOR_KEY = 'vinta-flow:cursor:'

export interface RunView {
  readonly snapshot: RunSnapshot | null
  readonly projection: Projection
  readonly connected: boolean
  readonly error: string | null
}

export function useRun(client: Client, runId: string): RunView {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [projection, setProjection] = useState<Projection>(EMPTY_PROJECTION)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    let cursor = readCursor(runId)
    let detach: (() => void) | null = null
    let retry: ReturnType<typeof setTimeout> | null = null

    const refresh = (): void => {
      client.snapshot(runId).then(
        (next) => {
          if (stopped) return
          setSnapshot(next)
          setError(null)
        },
        (cause: unknown) => {
          if (!stopped) setError(messageOf(cause))
        },
      )
    }

    const open = (): void => {
      detach = client.stream(runId, cursor, {
        onOpen: () => {
          if (!stopped) setConnected(true)
        },
        onFrame: (frame) => {
          if (stopped) return
          cursor = Math.max(cursor, frame.cursor)
          writeCursor(runId, cursor)
          setProjection((current) => applyFrame(current, frame))
          refresh()
        },
        onClose: (reason) => {
          if (stopped) return
          setConnected(false)
          if (reason === 'invalid_frame') {
            setError('event stream did not match the daemon schema')
            return
          }
          retry = setTimeout(open, RECONNECT_MS)
        },
      })
    }

    refresh()
    open()

    return () => {
      stopped = true
      if (retry !== null) clearTimeout(retry)
      detach?.()
    }
  }, [client, runId])

  return { snapshot, projection, connected, error }
}

/** Errors from `client.ts` name an endpoint and a status; nothing else is relayed. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the daemon could not be reached'
}

function readCursor(runId: string): number {
  try {
    const stored = Number(sessionStorage.getItem(CURSOR_KEY + runId))
    return Number.isSafeInteger(stored) && stored > 0 ? stored : 0
  } catch {
    return 0
  }
}

function writeCursor(runId: string, cursor: number): void {
  try {
    sessionStorage.setItem(CURSOR_KEY + runId, String(cursor))
  } catch {
    // A tab that cannot store a resume position simply replays on reload.
  }
}
