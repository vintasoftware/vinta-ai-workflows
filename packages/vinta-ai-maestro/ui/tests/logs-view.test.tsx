/**
 * The Logs view, against a fake reader rather than a listener.
 *
 * The daemon's side of this route has its own tests (`tests/daemon-logs.ts`),
 * and what is left here are claims about the *view*, all of which are about
 * how it asks rather than how it looks:
 *
 * - the opening read is a tail and every read after it carries the cursor, so
 *   following costs one small read rather than re-reading the file;
 * - a filter goes to the daemon, so narrowing reads less instead of rendering
 *   less;
 * - a rotation that ate records this view had not shown says so, rather than
 *   joining the two ends into a stream with an invisible hole in it.
 */
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Logs } from '../src/Logs.tsx'
import type { LogQuery, LogsClient } from '../src/logs-client.ts'
import type { LogPage, LogRecordResponse } from '../../src/daemon/schemas.ts'

afterEach(cleanup)

let seq = 0

function record(over: Partial<LogRecordResponse> = {}): LogRecordResponse {
  seq += 1
  return {
    ts: Date.parse('2026-09-16T14:02:31.184Z') + seq,
    seq,
    pid: 4242,
    level: 'info',
    event: 'daemon.listening',
    runId: null,
    nodeId: null,
    fields: {},
    ...over,
  }
}

/** A reader that records what it was asked for, and answers from a script. */
function fakeLogs(pages: readonly Partial<LogPage>[]): LogsClient & { asked: LogQuery[] } {
  const asked: LogQuery[] = []
  let index = 0
  return {
    asked,
    logs: async (query) => {
      asked.push(query)
      const page = pages[Math.min(index, pages.length - 1)]
      index += 1
      return {
        records: [],
        cursor: 'c1',
        reset: false,
        more: false,
        path: '/p/.vinta-ai-maestro/logs/daemon.ndjson',
        ...page,
      }
    },
  }
}

test('opens with a tail and then follows from the cursor', async () => {
  const logs = fakeLogs([
    { records: [record({ event: 'daemon.listening' })], cursor: 'c1' },
    { records: [record({ event: 'scheduler.dispatch' })], cursor: 'c2' },
  ])
  render(<Logs logs={logs} />)

  await screen.findByText('daemon.listening')
  // The first read asks for a tail and carries no cursor; it cannot, because
  // there is nothing yet to continue from.
  expect(logs.asked[0]).toMatchObject({ tail: expect.any(Number) })
  expect(logs.asked[0]?.after).toBeUndefined()

  await waitFor(() => expect(logs.asked.length).toBeGreaterThan(1))
  // Every read after it continues rather than re-reading the file — the
  // property that keeps a follow cheap however long the daemon has been up.
  expect(logs.asked[1]?.after).toBe('c1')
  expect(logs.asked[1]?.tail).toBeUndefined()
})

test('renders a record as a timeline row with its level, event and fields', async () => {
  const logs = fakeLogs([
    {
      records: [
        record({
          level: 'error',
          event: 'daemon.uncaught_exception',
          runId: 'run-7',
          nodeId: 'p1',
          fields: {
            error: 'TypeError',
            runs: 2,
            message: "Cannot read properties of undefined (reading 'lane')",
            stack_1: 'at listOnTimeout (node:internal/timers:605:17)',
            stack_0: 'at Scheduler.#release (scheduler.ts:2131:9)',
          },
        }),
      ],
    },
  ])
  const { container } = render(<Logs logs={logs} />)

  const row = await waitFor(() => {
    const found = container.querySelector('.log-row')
    if (found === null) throw new Error('no row yet')
    return found
  })
  expect(row.getAttribute('data-level')).toBe('error')
  expect(row.getAttribute('data-event')).toBe('daemon.uncaught_exception')
  expect(row.querySelector('[data-part="run"]')?.textContent).toBe('run-7/p1')
  expect(row.querySelector('[data-part="fields"]')?.textContent).toContain('error=TypeError')
  // The message gets its own line rather than joining the identifier run — it
  // is a sentence, and the rest of the row is `key=value` shorthand.
  expect(row.querySelector('[data-part="message"]')?.textContent).toBe(
    "Cannot read properties of undefined (reading 'lane')",
  )
  expect(row.querySelector('[data-part="fields"]')?.textContent).not.toContain('message=')
  // Frames are their own block, numerically ordered whatever order they
  // arrived in, and below the message: what happened reads before where.
  const stack = row.querySelector('[data-part="stack"]')
  expect(stack?.textContent).toBe(
    'at Scheduler.#release (scheduler.ts:2131:9)at listOnTimeout (node:internal/timers:605:17)',
  )
  expect(row.querySelector('[data-part="fields"]')?.textContent).not.toContain('stack_0')
  const messageNode = row.querySelector('[data-part="message"]') as Node
  expect(
    messageNode.compareDocumentPosition(stack as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  // The tone is the meaning; the colour is only the colour (see `status.ts`).
  expect(row.querySelector('.chip')?.getAttribute('data-tone')).toBe('error')
})

test('sends a level filter to the daemon rather than filtering the list', async () => {
  const logs = fakeLogs([{ records: [record()] }])
  const { container } = render(<Logs logs={logs} />)
  await screen.findByText('daemon.listening')

  const select = container.querySelector('[data-filter="level"]') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'error' } })

  // A filter change starts a fresh tail: the records that match it are mostly
  // in the past, and continuing from the cursor would never find them.
  await waitFor(() => {
    const last = logs.asked.at(-1)
    expect(last?.level).toBe('error')
    expect(last?.after).toBeUndefined()
  })
})

test('sends the search box and the run box as query parameters', async () => {
  const logs = fakeLogs([{ records: [record()] }])
  const { container } = render(<Logs logs={logs} />)
  await screen.findByText('daemon.listening')

  fireEvent.change(container.querySelector('[data-filter="run"]') as HTMLInputElement, {
    target: { value: 'run-7' },
  })
  await waitFor(() => expect(logs.asked.at(-1)?.run).toBe('run-7'))

  fireEvent.change(container.querySelector('[data-filter="q"]') as HTMLInputElement, {
    target: { value: 'lane-2' },
  })
  await waitFor(() => expect(logs.asked.at(-1)?.q).toBe('lane-2'))
})

test('says so when a rotation left a gap instead of hiding it', async () => {
  const logs = fakeLogs([{ records: [record()], reset: true }])
  const { container } = render(<Logs logs={logs} />)

  await waitFor(() => {
    expect(container.querySelector('[data-note="gap"]')?.textContent).toContain('gap')
  })
})

test('names the file on disk, so the log outlives the tab', async () => {
  const logs = fakeLogs([{ records: [record()] }])
  render(<Logs logs={logs} />)
  expect(await screen.findByText('/p/.vinta-ai-maestro/logs/daemon.ndjson')).toBeTruthy()
})

test('surfaces an unreachable daemon rather than showing an empty log', async () => {
  const logs: LogsClient = {
    logs: async () => {
      throw new Error('/api/logs: daemon answered 500')
    },
  }
  render(<Logs logs={logs} />)
  // The distinction that matters: "nothing was logged" and "nothing could be
  // read" look identical on an empty list.
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    '/api/logs: daemon answered 500',
  )
})
