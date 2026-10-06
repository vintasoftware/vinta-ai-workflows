/**
 * The fold, on its own. Idempotence is the property the reconnect story rests
 * on, and it is cheaper to prove here than through a socket.
 */
import { expect, test } from 'vitest'
import type { EventFrame } from '../../src/daemon/schemas.ts'
import { applyFrame, EMPTY_PROJECTION } from '../src/projection.ts'
import { RUN_ID } from './fixtures.ts'

function frame(...events: EventFrame['events']): EventFrame {
  const last = events.at(-1)
  return {
    channel: 'events',
    runId: RUN_ID,
    cursor: last?.id ?? 0,
    events,
  }
}

function event(id: number, type: string, nodeId: string | null, payload: unknown) {
  return { id, ts: 1_700_000_000_000 + id, runId: RUN_ID, nodeId, type, payload }
}

test('node statuses fold in order and the cursor follows the last event', () => {
  const applied = applyFrame(
    EMPTY_PROJECTION,
    frame(
      event(1, 'node_status', 'impl', { status: 'running' }),
      event(2, 'node_status', 'impl', { status: 'waiting_on_capacity' }),
      event(3, 'node_status', 'review', { status: 'pending' }),
    ),
  )
  expect(applied.statuses.get('impl')).toBe('waiting_on_capacity')
  expect(applied.statuses.get('review')).toBe('pending')
  expect(applied.cursor).toBe(3)
})

test('re-applying a frame changes nothing and does not even allocate', () => {
  const once = applyFrame(EMPTY_PROJECTION, frame(event(1, 'node_status', 'impl', { status: 'running' })))
  const twice = applyFrame(once, frame(event(1, 'node_status', 'impl', { status: 'running' })))
  // Identity, not equality: a replay must not re-render the run view.
  expect(twice).toBe(once)
})

test('an overlapping resume applies only the events past the cursor', () => {
  const once = applyFrame(
    EMPTY_PROJECTION,
    frame(event(1, 'node_status', 'impl', { status: 'running' })),
  )
  const resumed = applyFrame(
    once,
    frame(
      event(1, 'node_status', 'impl', { status: 'running' }),
      event(2, 'node_status', 'impl', { status: 'done' }),
    ),
  )
  expect(resumed.statuses.get('impl')).toBe('done')
  expect(resumed.cursor).toBe(2)
})

test('unknown types and unreadable payloads advance the cursor without throwing', () => {
  const applied = applyFrame(
    EMPTY_PROJECTION,
    frame(
      event(1, 'node_assigned', 'impl', { lane: 'lane-1' }),
      event(2, 'node_status', 'impl', { status: 'not-a-status' }),
      event(3, 'run_ended', null, { status: 'failed' }),
    ),
  )
  expect(applied.statuses.size).toBe(0)
  expect(applied.runStatus).toBe('failed')
  expect(applied.cursor).toBe(3)
})
