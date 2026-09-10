/**
 * The node view (§10, §9, §9.1): the transcript, the gate logs, the diff ref,
 * the steering box and the pending question.
 *
 * The operations are asserted **on the wire**, against the stub's record of
 * what it received — parsed with the daemon's own request schemas. A test that
 * spied on the client would prove the button called a function; this proves
 * the daemon would have accepted the request.
 */
import { cleanup, fireEvent, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { ENTRY_KINDS_COVERED, TRANSCRIPT_KINDS } from '../src/transcript.ts'
import { TRANSCRIPT_WINDOW } from '../src/Transcript.tsx'
import {
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  entry,
  harness,
  node,
  nodeDetail,
  RUN_ID,
  runSummary,
  snapshot,
} from './fixtures.ts'
import { renderApp, textOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

let daemon: StubDaemon | null = null
let view: RenderResult | null = null

afterEach(async () => {
  view = null
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

function open(stub: StubDaemon, nodeId: string): RenderResult {
  view?.unmount()
  view = renderApp(stub, `#/runs/${RUN_ID}/nodes/${nodeId}`)
  return view
}

const ALL_KINDS = [
  entry({ type: 'session_started', sessionId: 'sess-1' }),
  entry({ type: 'assistant_text', text: 'Reading the billing module.' }),
  entry({ type: 'thinking', text: 'The invoice table is the seam.' }),
  entry({ type: 'tool_use', name: 'Read', id: 't1', input: { path: 'src/billing.ts' } }),
  entry({ type: 'tool_result', id: 't1', ok: true, summary: '120 lines' }),
  entry({ type: 'user_message', text: 'Use the existing invoice serializer.' }),
  entry({ type: 'permission_request', tool: 'Bash', detail: { cmd: 'pnpm test' } }),
  entry({ type: 'usage', input: 1200, output: 340, costUsd: 0.12 }),
  entry({ type: 'error', message: 'the harness stream ended early' }),
  entry({ type: 'session_ended', result: 'ok' }),
]

test('every normalized event kind renders, and the operator’s own message is attributed to them', async () => {
  // Compile-time coverage, asserted at runtime so the check has a witness.
  expect(ENTRY_KINDS_COVERED).toBe(true)

  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: {
      [`${RUN_ID}/impl`]: nodeDetail({
        transcript: { stream: 'transcript', entries: ALL_KINDS },
      }),
    },
  })
  daemon = stub
  const { container } = open(stub, 'impl')

  await waitFor(() => expect(container.querySelectorAll('[data-entry]')).toHaveLength(10))

  // Not one kind falls through to a blank row, and no two look alike.
  const labels = TRANSCRIPT_KINDS.map((kind) => {
    const row = container.querySelector(`[data-kind="${kind}"] .entry-author`)
    expect(row, kind).not.toBe(null)
    return row?.textContent ?? ''
  })
  expect(new Set(labels).size).toBe(TRANSCRIPT_KINDS.length)

  // §7: the steering the operator typed is the operator's, and the row says so
  // before it says anything else. It must never read as the agent speaking.
  const operator = container.querySelector('[data-kind="user_message"] .entry-author')
  expect(operator?.getAttribute('data-author')).toBe('operator')
  expect(operator?.textContent).toContain('Operator')
  expect(textOf(container, '[data-kind="user_message"] .entry-body')).toContain(
    'Use the existing invoice serializer.',
  )
  expect(
    container.querySelector('[data-kind="assistant_text"] .entry-author')?.getAttribute('data-author'),
  ).toBe('agent')

  // A failing tool result is distinguishable from a passing one by more than text.
  expect(container.querySelector('[data-kind="tool_result"] .chip')?.getAttribute('data-tone')).toBe(
    'ok',
  )
  expect(container.querySelector('[data-kind="error"] .chip')?.getAttribute('data-tone')).toBe(
    'error',
  )

  // …and the chip carries the tone and nothing else. It used to print the raw
  // event type beside a row that already said what the row was, so "Operator
  // (you)" was followed by a pill reading `user_message`. The type is still on
  // the row as `data-kind`, where this test reads it; it is not on screen.
  const transcript = container.querySelector('.transcript')
  for (const chip of container.querySelectorAll('.entries .chip')) {
    expect(chip.textContent).toBe('')
  }
  // The snake_case ones are the tell: `session_started` and `tool_result` can
  // only have come from the event stream, where a human label never would.
  for (const kind of TRANSCRIPT_KINDS.filter((candidate) => candidate.includes('_'))) {
    expect(transcript?.textContent ?? '', kind).not.toContain(kind)
  }
})

test('a long transcript mounts a window over its tail, not every row', async () => {
  const entries = Array.from({ length: 400 }, (_, index) =>
    entry({ type: 'assistant_text', text: `line ${index}` }),
  )
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: {
      [`${RUN_ID}/impl`]: nodeDetail({ transcript: { stream: 'transcript', entries } }),
    },
  })
  daemon = stub
  const { container } = open(stub, 'impl')

  await waitFor(() => expect(container.querySelector('[data-entry]')).not.toBe(null))

  // The window, not the tail: 400 entries arrived and 60 rows exist.
  expect(container.querySelectorAll('[data-entry]')).toHaveLength(TRANSCRIPT_WINDOW)
  expect(textOf(container, '[data-transcript-window]')).toBe(
    `Showing ${TRANSCRIPT_WINDOW} of 400`,
  )
  // Anchored at the end, where a live agent is writing.
  expect(container.textContent).toContain('line 399')
  expect(container.textContent).not.toContain('line 0')
  expect(container.querySelector('[data-entry="0"]')).toBe(null)
  expect(container.querySelector(`[data-entry="${400 - TRANSCRIPT_WINDOW}"]`)).not.toBe(null)

  fireEvent.click(container.querySelector('[data-action="show-earlier"]') as HTMLElement)
  expect(container.querySelectorAll('[data-entry]')).toHaveLength(TRANSCRIPT_WINDOW * 2)
  expect(container.querySelector('[data-entry="0"]')).toBe(null)

  // Scrolling to the top of the box grows it too, without a library.
  fireEvent.scroll(container.querySelector('.entries') as HTMLElement, {
    target: { scrollTop: 0 },
  })
  await waitFor(() =>
    expect(container.querySelectorAll('[data-entry]')).toHaveLength(TRANSCRIPT_WINDOW * 3),
  )
})

test('each of the five operations posts to its own endpoint with a body the daemon accepts', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({ nodes: [node('impl', 'running'), node('review', 'awaiting_human')] }),
    },
    details: {
      [`${RUN_ID}/impl`]: nodeDetail(),
      [`${RUN_ID}/review`]: nodeDetail({
        node: node('review', 'awaiting_human'),
        question: { question: 'Merge it?', kind: 'confirm' },
      }),
    },
  })
  daemon = stub
  const { container } = open(stub, 'impl')
  await waitFor(() => expect(container.querySelector('[data-op="context"]')).not.toBe(null))

  const type = (text: string): void => {
    fireEvent.change(container.querySelector('[data-field="steering"]') as HTMLElement, {
      target: { value: text },
    })
  }
  const press = (op: string): void => {
    fireEvent.click(container.querySelector(`[data-op="${op}"]`) as HTMLElement)
  }

  type('check the invoice serializer')
  press('context')
  await waitFor(() => expect(stub.posts).toHaveLength(1))
  expect(stub.posts[0]).toEqual({
    runId: RUN_ID,
    nodeId: 'impl',
    operation: 'context',
    body: { text: 'check the invoice serializer' },
  })

  type('drop the cache layer instead')
  press('redirect')
  await waitFor(() => expect(stub.posts).toHaveLength(2))
  expect(stub.posts[1]).toEqual({
    runId: RUN_ID,
    nodeId: 'impl',
    operation: 'redirect',
    body: { instruction: 'drop the cache layer instead' },
  })

  press('pause')
  await waitFor(() => expect(stub.posts).toHaveLength(3))
  expect(stub.posts[2]).toEqual({ runId: RUN_ID, nodeId: 'impl', operation: 'pause', body: {} })

  press('abort')
  await waitFor(() => expect(stub.posts).toHaveLength(4))
  expect(stub.posts[3]).toEqual({ runId: RUN_ID, nodeId: 'impl', operation: 'abort', body: {} })

  // The fifth is §9.1's answer, which only a parked node can be asked.
  const answering = open(stub, 'review')
  await waitFor(() => expect(answering.container.querySelector('[data-question]')).not.toBe(null))
  fireEvent.click(
    answering.container.querySelector('[data-answer="true"]') as HTMLElement,
  )
  await waitFor(() => expect(stub.posts).toHaveLength(5))
  expect(stub.posts[4]).toEqual({
    runId: RUN_ID,
    nodeId: 'review',
    operation: 'answer',
    body: { answer: true },
  })
})

test('a harness that cannot inject says the message waits for the next resume', async () => {
  const codex = { ...node('impl', 'running'), harness: 'codex' }
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      // §7's blocks arrive on the wire, read off the adapters themselves —
      // this view has no table of its own to consult any more.
      [RUN_ID]: snapshot({
        nodes: [codex, node('claude', 'running')],
        harnesses: [
          harness('codex', 2, 1, null, CODEX_CAPABILITIES),
          harness('claude-code', 2, 1, null, CLAUDE_CODE_CAPABILITIES),
        ],
      }),
    },
    details: {
      [`${RUN_ID}/impl`]: nodeDetail({ node: codex }),
      [`${RUN_ID}/claude`]: nodeDetail({ node: node('claude', 'running') }),
    },
  })
  daemon = stub

  const parked = open(stub, 'impl')
  await waitFor(() => expect(textOf(parked.container, '[data-delivery]')).not.toBe(''))
  // §7: greying out beats failing at the moment the operator presses the button.
  expect(textOf(parked.container, '[data-delivery]')).toContain(
    'queued and delivered on the next resume',
  )
  expect(textOf(parked.container, '[data-delivery]')).toContain('codex')

  const live = open(stub, 'claude')
  await waitFor(() => expect(textOf(live.container, '[data-delivery]')).not.toBe(''))
  expect(textOf(live.container, '[data-delivery]')).not.toContain('next resume')
  expect(textOf(live.container, '[data-delivery]')).not.toContain('queued')
  expect(textOf(live.container, '[data-delivery]')).toContain('running claude-code session')
})

test('a node that is not in a turn queues steering whatever its harness can do', async () => {
  const waiting = node('impl', 'waiting_on_capacity')
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [waiting] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail({ node: waiting }) },
  })
  daemon = stub
  const { container } = open(stub, 'impl')

  await waitFor(() => expect(textOf(container, '[data-delivery]')).not.toBe(''))
  expect(textOf(container, '[data-delivery]')).toContain('next resume')
  // Pause is meaningless on a node with no turn to finish; it is greyed, not offered.
  expect(container.querySelector('[data-op="pause"]')).toHaveProperty('disabled', true)
  expect(container.querySelector('[data-op="abort"]')).toHaveProperty('disabled', false)
})

test('a pending question renders with its context and is answerable in all three kinds', async () => {
  const parked = (nodeId: string) => node(nodeId, 'awaiting_human')
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({ nodes: [parked('a'), parked('b'), parked('c')] }),
    },
    details: {
      [`${RUN_ID}/a`]: nodeDetail({
        node: parked('a'),
        question: {
          question: 'Ship the migration?',
          kind: 'confirm',
          context: { diffRef: 'phase/a', gateLogRef: 'unit', transcriptCursor: 42 },
        },
      }),
      [`${RUN_ID}/b`]: nodeDetail({
        node: parked('b'),
        question: { question: 'Which base?', kind: 'choice', choices: ['main', 'release'] },
      }),
      [`${RUN_ID}/c`]: nodeDetail({
        node: parked('c'),
        question: { question: 'What should it do instead?', kind: 'text' },
      }),
    },
  })
  daemon = stub

  const confirm = open(stub, 'a')
  await waitFor(() => expect(confirm.container.querySelector('[data-question]')).not.toBe(null))
  expect(confirm.container.textContent).toContain('Ship the migration?')
  // §9.1: the question is rendered *with* its context — the diff, the failing
  // gate log, the transcript position it paused at.
  expect(textOf(confirm.container, '[data-context="diff"]')).toContain('phase/a')
  expect(textOf(confirm.container, '[data-context="gate"]')).toContain('unit')
  expect(textOf(confirm.container, '[data-context="cursor"]')).toContain('42')
  fireEvent.click(confirm.container.querySelector('[data-answer="false"]') as HTMLElement)
  await waitFor(() => expect(stub.posts).toHaveLength(1))
  expect(stub.posts[0]?.body).toEqual({ answer: false })

  const choice = open(stub, 'b')
  await waitFor(() => expect(choice.container.querySelector('[data-question]')).not.toBe(null))
  expect(choice.container.querySelectorAll('[data-op="answer"]')).toHaveLength(2)
  fireEvent.click(choice.container.querySelector('[data-answer="release"]') as HTMLElement)
  await waitFor(() => expect(stub.posts).toHaveLength(2))
  expect(stub.posts[1]).toEqual({
    runId: RUN_ID,
    nodeId: 'b',
    operation: 'answer',
    body: { answer: 'release' },
  })

  const free = open(stub, 'c')
  await waitFor(() => expect(free.container.querySelector('[data-question]')).not.toBe(null))
  const field = free.container.querySelector('[data-field="answer"]') as HTMLElement
  fireEvent.change(field, { target: { value: 'use the queue' } })
  fireEvent.click(free.container.querySelector('[data-op="answer"]') as HTMLElement)
  await waitFor(() => expect(stub.posts).toHaveLength(3))
  expect(stub.posts[2]).toEqual({
    runId: RUN_ID,
    nodeId: 'c',
    operation: 'answer',
    body: { answer: 'use the queue' },
  })
})

test('gate logs and the diff ref render, and the gate a question points at reads as failing', async () => {
  const parked = node('impl', 'awaiting_human')
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [parked] }) },
    details: {
      [`${RUN_ID}/impl`]: nodeDetail({
        node: parked,
        diff: { branch: 'phase/impl', baseBranch: 'wave-0', lane: 'lane-2' },
        gates: [
          { gateId: 'lint', log: 'lint: 0 problems\n' },
          { gateId: 'unit', log: '2 failing\n  invoices › totals\n' },
        ],
        question: {
          question: 'Unit gate failed. Retry or stop?',
          kind: 'choice',
          choices: ['retry', 'stop'],
          context: { gateLogRef: 'unit' },
        },
      }),
    },
  })
  daemon = stub
  const { container } = open(stub, 'impl')

  await waitFor(() => expect(container.querySelector('[data-gate="unit"]')).not.toBe(null))
  expect(textOf(container, '[data-gate-log="unit"]')).toContain('invoices › totals')
  expect(textOf(container, '[data-gate-log="lint"]')).toContain('0 problems')

  // The failing one is named by the question's context, which is the only
  // verdict the API carries: `NodeDetailSchema` has no exit code.
  expect(container.querySelector('[data-gate="unit"] .chip')?.getAttribute('data-tone')).toBe(
    'error',
  )
  expect(container.querySelector('[data-gate="lint"] .chip')).toBe(null)

  // The diff is a *ref* — branch, base, lane — because that is what §10 serves.
  expect(textOf(container, '[data-diff-branch]')).toBe('phase/impl')
  expect(textOf(container, '[data-diff-base]')).toBe('wave-0')
  expect(textOf(container, '[data-diff-lane]')).toBe('lane-2')
  expect(textOf(container, '[data-diff]')).toContain('git diff wave-0...phase/impl')
})

test('a node with no transcript, no gates and no question renders', async () => {
  const fresh = { ...node('impl', 'pending'), lane: null, branch: null, baseBranch: null }
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [fresh] }) },
    details: {
      [`${RUN_ID}/impl`]: nodeDetail({
        node: fresh,
        diff: { branch: null, baseBranch: null, lane: null },
      }),
    },
  })
  daemon = stub
  const { container } = open(stub, 'impl')

  await waitFor(() => expect(container.textContent).toContain('No transcript yet.'))
  expect(container.textContent).toContain('No gate has run yet.')
  expect(container.textContent).toContain('This node has no branch yet.')
  expect(container.querySelector('[data-question]')).toBe(null)
  expect(container.querySelector('[data-entry]')).toBe(null)
  expect(container.querySelector('[data-transcript-window]')).toBe(null)
})

test('the node view is reachable from the run view', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
  })
  daemon = stub
  view = renderApp(stub, `#/runs/${RUN_ID}`)
  const { container } = view

  await waitFor(() => expect(container.querySelector('tr[data-node="impl"]')).not.toBe(null))
  const link = container.querySelector('tr[data-node="impl"] a') as HTMLAnchorElement
  expect(link.getAttribute('href')).toBe(`#/runs/${RUN_ID}/nodes/impl`)
  // The token lives in the query string; a fragment link cannot carry it away.
  expect(link.getAttribute('href')).not.toContain(stub.token)

  fireEvent.click(link)
  await waitFor(() => expect(container.querySelector('.steering')).not.toBe(null))
})

test('a harness the daemon declares nothing for is assumed to do nothing', async () => {
  const mystery = { ...node('impl', 'running'), harness: 'some-other-harness' }
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      // What the API serves for an id it has no adapter for: not a block of
      // falses pretending to be a declaration — nothing.
      [RUN_ID]: snapshot({
        nodes: [mystery],
        harnesses: [harness('some-other-harness', 1, 1, null, null)],
      }),
    },
    details: { [`${RUN_ID}/impl`]: nodeDetail({ node: mystery }) },
  })
  daemon = stub
  const { container } = open(stub, 'impl')

  await waitFor(() => expect(textOf(container, '[data-takeover]')).toContain('assumed absent'))
  expect(textOf(container, '[data-delivery]')).toContain('next resume')
  expect(textOf(container, '[data-takeover]')).toContain('no interactive takeover')
})

test('the UI has no capability table of its own left to drift', () => {
  // §7's blocks are the adapters', and the daemon reads them off the adapters
  // themselves. `ui/src/capabilities.ts` used to restate all three by hand,
  // keyed by registry id, where nothing could catch it going stale — and the
  // node view greys controls out on what it said. This is the assertion that
  // it does not come back.
  const modules = Object.keys(import.meta.glob('../src/*.ts'))
  expect(modules.some((path) => path.endsWith('/capabilities.ts'))).toBe(false)
})
