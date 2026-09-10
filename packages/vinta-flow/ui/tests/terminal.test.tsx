/**
 * The Terminal view (§10) and §9's fifth operation in the node view.
 *
 * The socket is real, and — since §10 puts both channels on one connection —
 * it is the *run's* socket: the stub daemon parses the PTY frames the terminal
 * sends with the daemon's own schema and answers with frames validated by it.
 * So `connections` staying at one while a terminal attaches, types, and
 * detaches is the assertion this file exists for. A faked WebSocket would
 * prove the component calls a method; this proves how many times it upgrades.
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
import { afterEach, expect, test } from 'vitest'
import { FrameSchema } from '../../src/daemon/schemas.ts'
import { createPtyLink } from '../src/pty-link.ts'
import { TerminalView } from '../src/Terminal.tsx'
import {
  CLAUDE_CODE_CAPABILITIES,
  harness,
  node,
  nodeDetail,
  RUN_ID,
  runSummary,
  snapshot,
  statusEvent,
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

let stub: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  sessionStorage.clear()
  await stub?.close()
  stub = null
})

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
  return renderApp(daemon, `#/runs/${RUN_ID}/nodes/impl`)
}

/** Opens the node view and takes over, leaving the terminal on screen. */
async function takeOver(): Promise<{ readonly container: HTMLElement; readonly daemon: StubDaemon }> {
  const { container } = await openNode(CLAUDE_CODE_CAPABILITIES)
  await waitFor(() => expect(container.querySelector('[data-op="takeover"]')).not.toBe(null))
  fireEvent.click(container.querySelector('[data-op="takeover"]') as Element)
  const daemon = stub
  if (daemon === null) throw new Error('no daemon')
  await waitFor(() => expect(daemon.ptyFrames.length).toBeGreaterThan(0))
  return { container, daemon }
}

// ---------------------------------------------------------------------------

test('a pty frame parses as a frame of the one socket', () => {
  // The hole this file's whole shape depended on: a client that could not
  // parse this frame had to be handed a second connection to receive it on.
  const attached = FrameSchema.safeParse({
    channel: 'pty',
    type: 'attached',
    nodeId: 'impl',
    sessionId: 'sess-7',
  })
  expect(attached.success).toBe(true)
  expect(FrameSchema.safeParse({ channel: 'pty', type: 'data', data: 'x' }).success).toBe(true)
  expect(FrameSchema.safeParse({ channel: 'events', runId: RUN_ID, cursor: 1, events: [] }).success).toBe(
    true,
  )
  // Still a closed contract: an unknown channel, and a malformed pty frame,
  // are both refused rather than waved through by the widened union.
  expect(FrameSchema.safeParse({ channel: 'shell', type: 'data' }).success).toBe(false)
  expect(FrameSchema.safeParse({ channel: 'pty', type: 'data' }).success).toBe(false)
})

test('the terminal attaches over the run’s socket and opens none of its own', async () => {
  const { container, daemon } = await takeOver()

  // One upgrade for the whole screen: the run view opened it, and the terminal
  // found the PTY channel of it already authenticated and open.
  expect(daemon.connections).toHaveLength(1)
  // The attach names a node and a size — never a command and never a session
  // id, because neither is the client's to choose.
  expect(daemon.ptyFrames[0]).toMatchObject({ channel: 'pty', type: 'attach', nodeId: 'impl' })

  daemon.emitPty({ channel: 'pty', type: 'attached', nodeId: 'impl', sessionId: 'sess-7' })
  await waitFor(() =>
    expect(container.querySelector('[data-terminal-status="attached"]')?.textContent).toContain(
      'sess-7',
    ),
  )

  daemon.emitPty({ channel: 'pty', type: 'data', data: 'lane worktree ready\r\n' })
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
    expect(daemon.ptyFrames.some((frame) => frame.type === 'input' && frame.data === 'a')).toBe(true),
  )
  expect(daemon.connections).toHaveLength(1)
})

test('the run’s own frames keep flowing while a terminal is attached', async () => {
  const { container, daemon } = await takeOver()
  daemon.emitPty({ channel: 'pty', type: 'attached', nodeId: 'impl', sessionId: 's' })
  await waitFor(() =>
    expect(container.querySelector('[data-terminal-status="attached"]')).not.toBe(null),
  )

  // Event frames ride this same socket. They must reach the run view — the
  // status below is projected from one — without disturbing the terminal, and
  // the moving cursor must not cost a reconnect or a second attach.
  daemon.emit(statusEvent('impl', 'done'))
  await waitFor(() => expect(container.textContent).toContain('Done'))
  expect(daemon.connections).toHaveLength(1)
  expect(daemon.ptyFrames.filter((frame) => frame.type === 'attach')).toHaveLength(1)
  expect(container.querySelector('[data-terminal-status="attached"]')).not.toBe(null)
})

test('detaching says so on the socket and leaves the run stream open', async () => {
  const { container, daemon } = await takeOver()
  daemon.emitPty({ channel: 'pty', type: 'attached', nodeId: 'impl', sessionId: 's' })
  await waitFor(() =>
    expect(container.querySelector('[data-terminal-status="attached"]')).not.toBe(null),
  )

  fireEvent.click(container.querySelector('[data-op="takeover"]') as Element)
  await waitFor(() => expect(container.querySelector('[data-terminal="impl"]')).toBe(null))
  // The daemon is told the operator is done, so the node resumes headless —
  // and the connection the run view is watching on is not the price.
  expect(daemon.ptyFrames.at(-1)).toEqual({ channel: 'pty', type: 'detach' })
  expect(daemon.connections).toHaveLength(1)
  daemon.emit(statusEvent('impl', 'failed'))
  await waitFor(() => expect(container.textContent).toContain('Failed'))
})

test('a refusal is reported in the daemon’s own words, never the terminal’s', async () => {
  const { container, daemon } = await takeOver()
  daemon.emitPty({ channel: 'pty', type: 'error', reason: 'not_supported' })
  await waitFor(() =>
    expect(container.querySelector('[data-terminal-note]')?.textContent).toContain(
      'no interactive takeover',
    ),
  )
})

test('a terminal opened on a live link attaches without waiting for a reconnect', () => {
  // The link is the run view's and is already open when the panel mounts, so
  // there is no `open` event coming for the terminal to attach on.
  const link = createPtyLink()
  const sent: unknown[] = []
  link.opened((frame) => sent.push(frame))
  const view = render(<TerminalView nodeId="impl" link={link} />)

  expect(sent).toEqual([
    expect.objectContaining({ channel: 'pty', type: 'attach', nodeId: 'impl' }),
  ])
  view.unmount()
  expect(sent.at(-1)).toEqual({ channel: 'pty', type: 'detach' })
})

// ---------------------------------------------------------------------------
// The node view offers it exactly where the capability says it can.
// ---------------------------------------------------------------------------

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
