/**
 * The Terminal view (§10): `xterm.js` over the daemon's WebSocket, which is
 * §9's take over — the fifth operation, and the only one that is not a POST.
 *
 * **On the run stream's socket, not one of its own.** §10 puts events and PTY
 * bytes on one WebSocket and the daemon serves both on one connection; this
 * view now uses that connection, through the `PtyLink` the run view hands it.
 * It used to open a second one because `client.ts` could not parse a PTY frame
 * and treated it as fatal — which was a hole in `FrameSchema`, not a reason
 * for a second upgrade, a second token in a second URL and a second channel
 * the daemon had to serve.
 *
 * The link, not the socket, is what this view holds: the run stream reconnects
 * on its own schedule, and a terminal that had captured a socket would be
 * talking to a closed one. `onOpen` fires on subscribe and on every reconnect,
 * and the attach is sent from there, so the terminal follows the connection
 * rather than owning it.
 *
 * **Nothing here logs.** The bytes on this channel are a live terminal: the
 * repository's contents, whatever the operator ran, and whatever they typed —
 * which can include a credential they pasted. They go from the link into
 * `xterm` and nowhere else (§11). The status line below reports fixed tokens
 * the daemon chose from a closed set, never anything the terminal said.
 *
 * The token is not here at all any more: the socket this rides on was
 * authenticated once, at its upgrade, by the code that owns it.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { PtyError } from '../../src/daemon/pty-frames.ts'
import type { PtyLink } from './pty-link.ts'
import { Hint, Panel } from './Panel.tsx'

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
  nodeId,
  link,
}: {
  readonly nodeId: string
  /** The PTY channel of the run's own socket (§10). */
  readonly link: PtyLink
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [note, setNote] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  useEffect(() => {
    const element = host.current
    if (element === null) return

    const term = new Terminal({ convertEol: false, cursorBlink: true, fontSize: 13 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    resize()

    const stop = link.listen({
      onOpen: () => {
        setStatus('connecting')
        setNote(null)
        link.send({ channel: 'pty', type: 'attach', nodeId, cols: term.cols, rows: term.rows })
      },
      onFrame: (frame) => {
        switch (frame.type) {
          case 'attached':
            setSessionId(frame.sessionId)
            setStatus('attached')
            setNote(null)
            return
          case 'data':
            term.write(frame.data)
            return
          case 'exit':
            setStatus('ended')
            setNote('The terminal exited. Close this panel to resume the node headless.')
            return
          case 'error':
            setStatus('refused')
            setNote(REFUSALS[frame.reason])
            return
        }
      },
      onClose: () => {
        setStatus((current) => (current === 'attached' || current === 'connecting' ? 'closed' : current))
      },
    })

    const typed = term.onData((data) => link.send({ channel: 'pty', type: 'input', data }))
    window.addEventListener('resize', onWindowResize)

    return () => {
      window.removeEventListener('resize', onWindowResize)
      typed.dispose()
      // Detach explicitly: the socket outlives this panel now, so nothing else
      // would tell the daemon the operator is done and the node may resume.
      link.send({ channel: 'pty', type: 'detach' })
      stop()
      term.dispose()
    }

    function onWindowResize(): void {
      resize()
      link.send({ channel: 'pty', type: 'resize', cols: term.cols, rows: term.rows })
    }

    /** `fit` measures the DOM, which can measure to nothing before layout. */
    function resize(): void {
      try {
        fit.fit()
      } catch {
        // An unmeasurable host keeps the terminal's default geometry.
      }
    }
  }, [nodeId, link])

  return (
    <Panel
      title="Terminal"
      data-terminal={nodeId}
      description={
        <span data-terminal-status={status}>
          {label(status)}
          {sessionId === null ? '' : ` Session ${sessionId}.`}
        </span>
      }
    >
      {note !== null && (
        <Hint className="muted" data-terminal-note>
          {note}
        </Hint>
      )}
      {/* xterm paints its own dark theme; the host gives it a rounded, padded
          well so the terminal reads as one surface inside the card. */}
      <div
        ref={host}
        data-terminal-host
        className="overflow-hidden rounded-lg bg-slate-950 p-2"
        style={{ height: '24em', width: '100%' }}
      />
    </Panel>
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
