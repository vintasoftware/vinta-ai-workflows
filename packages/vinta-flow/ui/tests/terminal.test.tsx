/**
 * The Terminal view (§10) and §9's fifth operation in the node view.
 *
 * The socket is real: a `ws` server on an ephemeral port, speaking the
 * daemon's own PTY frames, validated with the daemon's own schemas on the way
 * in and out. A faked WebSocket would prove the component calls a method; this
 * proves it would speak to the daemon.
 *
 * `xterm` measures the DOM and asks the window for its device pixel ratio,
 * which jsdom does not implement — `matchMedia` is stubbed for that reason and
 * that reason only. Everything else is the component as it ships.
 *
 * Nothing here asserts on terminal bytes beyond the fixed markers this file
 * sends itself; the rule that they never reach a log or an error is the
 * component's, and there is nothing in it that could.
 */
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react'
import { createServer, type Server } from 'node:http'
import { afterEach, expect, test } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PtyClientFrameSchema,
  PtyServerFrameSchema,
  type PtyClientFrame,
  type PtyServerFrame,
} from '../../src/daemon/pty-frames.ts'
import { TerminalView } from '../src/Terminal.tsx'
import {
  CLAUDE_CODE_CAPABILITIES,
  harness,
  node,
  nodeDetail,
  RUN_ID,
  runSummary,
  snapshot,
} from './fixtures.ts'
import { renderApp } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

// jsdom implements neither of these, and xterm asks for both on `open`.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

let view: RenderResult | null = null
let stub: StubDaemon | null = null
let terminals: StubTerminal | null = null

afterEach(async () => {
  view = null
  cleanup()
  sessionStorage.clear()
  await terminals?.close()
  terminals = null
  await stub?.close()
  stub = null
})

// ---------------------------------------------------------------------------
// A daemon that speaks only the PTY channel.
// ---------------------------------------------------------------------------

interface StubTerminal {
  readonly origin: string
  /** Every client frame the component sent, parsed by the daemon's schema. */
  readonly received: PtyClientFrame[]
  /** The token the upgrade presented — the one thing that gates a shell (§11). */
  tokens: (string | null)[]
  emit(frame: PtyServerFrame): void
  /** A frame from another channel, sent verbatim. */
  raw(text: string): void
  close(): Promise<void>
}

async function startStubTerminal(): Promise<StubTerminal> {
  const received: PtyClientFrame[] = []
  const tokens: (string | null)[] = []
  const sockets = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true })
  const server: Server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    tokens.push(url.searchParams.get('token'))
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      ws.on('message', (raw) => {
        const parsed = PtyClientFrameSchema.safeParse(JSON.parse(String(raw)))
        if (parsed.success) received.push(parsed.data)
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')

  return {
    origin: `http://127.0.0.1:${address.port}`,
    received,
    tokens,
    emit(frame) {
      // Validated on the way out, so this stub cannot drift from the contract.
      const text = JSON.stringify(PtyServerFrameSchema.parse(frame))
      for (const ws of sockets) ws.send(text)
    },
    raw(text) {
      for (const ws of sockets) ws.send(text)
    },
    async close() {
      for (const ws of sockets) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// ---------------------------------------------------------------------------

test('the terminal attaches, renders what the daemon sends, and sends what is typed', async () => {
  const pty = await startStubTerminal()
  terminals = pty

  const { container } = render(
    <TerminalView runId={RUN_ID} nodeId="impl" origin={pty.origin} token="secret-token" />,
  )

  // The attach names a node and a size — never a command and never a session
  // id, because neither is the client's to choose.
  await waitFor(() => expect(pty.received.length).toBeGreaterThan(0))
  expect(pty.received[0]).toMatchObject({ channel: 'pty', type: 'attach', nodeId: 'impl' })
  // The token is on the upgrade, which is the only place a browser can put it.
  expect(pty.tokens).toEqual(['secret-token'])

  pty.emit({ channel: 'pty', type: 'attached', nodeId: 'impl', sessionId: 'sess-7' })
  await waitFor(() =>
    expect(container.querySelector('[data-terminal-status="attached"]')?.textContent).toContain(
      'sess-7',
    ),
  )

  pty.emit({ channel: 'pty', type: 'data', data: 'lane worktree ready\r\n' })
  await waitFor(() =>
    expect(container.querySelector('.xterm-rows')?.textContent ?? '').toContain(
      'lane worktree ready',
    ),
  )

  // A keystroke on xterm's own input element is the path a real one takes.
  const input = container.querySelector('textarea.xterm-helper-textarea')
  expect(input).not.toBe(null)
  fireEvent.keyDown(input as Element, { key: 'a', keyCode: 65 })
  await waitFor(() =>
    expect(pty.received.some((frame) => frame.type === 'input' && frame.data === 'a')).toBe(true),
  )
})

test('an event frame on the shared socket is ignored, not an error', async () => {
  const pty = await startStubTerminal()
  terminals = pty
  const { container } = render(
    <TerminalView runId={RUN_ID} nodeId="impl" origin={pty.origin} token="t" />,
  )
  await waitFor(() => expect(pty.received.length).toBeGreaterThan(0))

  // The event channel's frames ride this same socket by design (§10) — that is
  // what the `channel` discriminator buys. The terminal must skip them, not
  // treat one as a protocol failure the way `client.ts` treats an unreadable
  // frame on the run stream.
  pty.raw(JSON.stringify({ channel: 'events', runId: RUN_ID, cursor: 3, events: [] }))
  pty.emit({ channel: 'pty', type: 'attached', nodeId: 'impl', sessionId: 's' })
  await waitFor(() =>
    expect(container.querySelector('[data-terminal-status="attached"]')).not.toBe(null),
  )
})

test('the run cursor moving does not reconnect the terminal', async () => {
  const pty = await startStubTerminal()
  terminals = pty
  const panel = render(
    <TerminalView runId={RUN_ID} nodeId="impl" since={0} origin={pty.origin} token="t" />,
  )
  await waitFor(() => expect(pty.tokens).toHaveLength(1))

  // `since` is the run stream's cursor, which advances with every frame. If it
  // were a dependency of the socket, the operator's shell would be killed and
  // reopened every few hundred milliseconds while the run moved.
  panel.rerender(
    <TerminalView runId={RUN_ID} nodeId="impl" since={99} origin={pty.origin} token="t" />,
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(pty.tokens).toHaveLength(1)
})

test('a refusal is reported in the daemon’s own words, never the terminal’s', async () => {
  const pty = await startStubTerminal()
  terminals = pty
  const { container } = render(
    <TerminalView runId={RUN_ID} nodeId="impl" origin={pty.origin} token="t" />,
  )
  await waitFor(() => expect(pty.received.length).toBeGreaterThan(0))

  pty.emit({ channel: 'pty', type: 'error', reason: 'not_supported' })
  await waitFor(() =>
    expect(container.querySelector('[data-terminal-note]')?.textContent).toContain(
      'no interactive takeover',
    ),
  )
})

// ---------------------------------------------------------------------------
// The node view offers it exactly where the capability says it can.
// ---------------------------------------------------------------------------

type Capabilities = NonNullable<ReturnType<typeof harness>['capabilities']>

const PTY_LESS: Capabilities = { ...CLAUDE_CODE_CAPABILITIES, pty: false }

async function openNode(capabilities: Capabilities | null): Promise<RenderResult> {
  const daemon = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        nodes: [node('impl', 'running')],
        harnesses: [harness('claude-code', 4, 1, null, capabilities)],
      }),
    },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
  })
  stub = daemon
  view = renderApp(daemon, `#/runs/${RUN_ID}/nodes/impl`)
  return view
}

test('take over is offered where the harness declares a pty', async () => {
  const { container } = await openNode(CLAUDE_CODE_CAPABILITIES)
  await waitFor(() => expect(container.querySelector('[data-op="takeover"]')).not.toBe(null))
  expect(container.querySelector('[data-takeover]')?.textContent).toContain(
    'interrupts the headless session',
  )
  // And it is a toggle, not a fire-and-forget: the terminal is the detach.
  fireEvent.click(container.querySelector('[data-op="takeover"]') as Element)
  await waitFor(() => expect(container.querySelector('[data-terminal="impl"]')).not.toBe(null))
  expect(container.querySelector('[data-op="takeover"]')?.textContent).toBe('Detach')
})

test('the limitation is still stated where the harness declares none', async () => {
  const { container } = await openNode(PTY_LESS)
  await waitFor(() =>
    expect(container.querySelector('[data-takeover]')?.textContent).toContain(
      'has no interactive takeover',
    ),
  )
  expect(container.querySelector('[data-op="takeover"]')).toBe(null)
  expect(container.querySelector('[data-terminal="impl"]')).toBe(null)
})

test('a harness that declared nothing gets the limitation, never the button', async () => {
  const { container } = await openNode(null)
  await waitFor(() =>
    expect(container.querySelector('[data-takeover]')?.textContent).toContain(
      'assumed absent',
    ),
  )
  expect(container.querySelector('[data-op="takeover"]')).toBe(null)
})
