/**
 * The Terminal view (§10): `xterm.js` over the daemon's WebSocket, which is
 * §9's take over — the fifth operation, and the only one that is not a POST.
 *
 * **Its own socket, deliberately.** §10 puts events and PTY bytes on one
 * WebSocket and the daemon serves both on one connection; this view opens a
 * second connection to that same endpoint rather than sharing the run
 * stream's. Two reasons, and the first is the load-bearing one:
 * `client.ts` validates every frame against `FrameSchema` and treats an
 * unparseable one as fatal, so a PTY frame arriving on the run stream's socket
 * would close it — the run's own event channel is not this view's to put at
 * risk. The second is lifetime: a terminal is opened and detached while the
 * run view stays connected, and a socket whose close means "detach" is the
 * simplest way to guarantee no shell is left running with nobody reading it.
 *
 * **Nothing here logs.** The bytes on this socket are a live terminal: the
 * repository's contents, whatever the operator ran, and whatever they typed —
 * which can include a credential they pasted. They go from the socket into
 * `xterm` and nowhere else (§11). The status line below reports fixed tokens
 * the daemon chose from a closed set, never anything the terminal said.
 *
 * The token is read from the page's query string the same way `main.tsx`
 * reads it, and put in the socket URL because a browser cannot set a header on
 * an upgrade. It is never rendered, never stored and never logged.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import {
  PtyServerFrameSchema,
  type PtyClientFrame,
  type PtyError,
} from '../../src/daemon/pty-frames.ts'

/** Mirrors `daemon/auth.ts`'s `TOKEN_QUERY`; that module is Node-only. */
const TOKEN_QUERY = 'token'
const WS_PATH = '/ws'

/** What the operator is told, in the daemon's own vocabulary. */
const REFUSALS: Record<PtyError, string> = {
  unknown_run: 'This run is not one the daemon is serving.',
  unknown_node: 'This node has no live session to take over.',
  not_supported: 'This harness has no interactive takeover.',
  attach_failed: 'The harness could not open a terminal on that session.',
  already_attached: 'This connection already holds a terminal.',
}

export type TerminalStatus = 'connecting' | 'attached' | 'ended' | 'refused' | 'closed'

export function TerminalView({
  runId,
  nodeId,
  since = 0,
  origin = location.origin,
  token = tokenFromLocation(),
}: {
  readonly runId: string
  readonly nodeId: string
  /**
   * Where this socket starts the *event* channel. The daemon tails events onto
   * every connection; passing the position the run view already reached keeps
   * this one from replaying a journal it will throw away.
   */
  readonly since?: number
  readonly origin?: string
  readonly token?: string
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [note, setNote] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // A read position, used once when the socket opens. Held in a ref and kept
  // out of the effect's dependencies because the caller's cursor advances with
  // every frame on the run stream, and a terminal that reconnected each time
  // the run moved would kill the operator's shell every few hundred
  // milliseconds.
  const start = useRef(since)

  useEffect(() => {
    const element = host.current
    if (element === null) return

    const term = new Terminal({ convertEol: false, cursorBlink: true, fontSize: 13 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    resize()

    const url = new URL(WS_PATH, origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('run', runId)
    url.searchParams.set('since', String(start.current))
    url.searchParams.set(TOKEN_QUERY, token)
    const socket = new WebSocket(url.toString())

    const send = (frame: PtyClientFrame): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
    }

    socket.addEventListener('open', () => {
      send({ channel: 'pty', type: 'attach', nodeId, cols: term.cols, rows: term.rows })
    })
    socket.addEventListener('message', (event) => {
      const parsed = readFrame(event.data)
      // Event frames share this socket. They are not this view's business, and
      // an unrecognised frame is ignored rather than treated as an error —
      // that is what the `channel` discriminator is for.
      if (parsed === null) return
      switch (parsed.type) {
        case 'attached':
          setSessionId(parsed.sessionId)
          setStatus('attached')
          setNote(null)
          return
        case 'data':
          term.write(parsed.data)
          return
        case 'exit':
          setStatus('ended')
          setNote('The terminal exited. Close this panel to resume the node headless.')
          return
        case 'error':
          setStatus('refused')
          setNote(REFUSALS[parsed.reason])
          return
      }
    })
    socket.addEventListener('error', () => {})
    socket.addEventListener('close', () => {
      setStatus((current) => (current === 'attached' || current === 'connecting' ? 'closed' : current))
    })

    const typed = term.onData((data) => send({ channel: 'pty', type: 'input', data }))
    window.addEventListener('resize', onWindowResize)

    return () => {
      window.removeEventListener('resize', onWindowResize)
      typed.dispose()
      // Detach explicitly, then close: the daemon tears the terminal down on
      // either, and saying so first means the shell is gone before the socket
      // is, rather than a moment after it.
      send({ channel: 'pty', type: 'detach' })
      socket.close()
      term.dispose()
    }

    function onWindowResize(): void {
      resize()
      send({ channel: 'pty', type: 'resize', cols: term.cols, rows: term.rows })
    }

    /** `fit` measures the DOM, which can measure to nothing before layout. */
    function resize(): void {
      try {
        fit.fit()
      } catch {
        // An unmeasurable host keeps the terminal's default geometry.
      }
    }
  }, [runId, nodeId, origin, token])

  return (
    <section className="panel" data-terminal={nodeId}>
      <h3>Terminal</h3>
      <p className="muted" data-terminal-status={status}>
        {label(status)}
        {sessionId === null ? '' : ` Session ${sessionId}.`}
      </p>
      {note !== null && (
        <p className="muted" data-terminal-note>
          {note}
        </p>
      )}
      <div ref={host} data-terminal-host style={{ height: '24em', width: '100%' }} />
    </section>
  )
}

function label(status: TerminalStatus): string {
  switch (status) {
    case 'connecting':
      return 'Attaching…'
    case 'attached':
      return 'Attached. The headless session is interrupted while you hold this terminal.'
    case 'ended':
      return 'The terminal ended.'
    case 'refused':
      return 'The daemon refused the attach.'
    case 'closed':
      return 'Detached.'
  }
}

/** The same read `main.tsx` does. Never rendered, never stored. */
function tokenFromLocation(): string {
  return new URLSearchParams(location.search).get(TOKEN_QUERY) ?? ''
}

function readFrame(data: unknown): ReturnType<typeof PtyServerFrameSchema.parse> | null {
  if (typeof data !== 'string') return null
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = PtyServerFrameSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
