/**
 * The fold the run view renders, on the one event a status cannot express:
 * a `running` node that is queued behind the integration worktree.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_PROJECTION, applyFrame } from '../src/projection.ts'

const frame = (events: readonly { id: number; type: string; nodeId: string | null; payload: unknown }[]) => ({
  cursor: events.at(-1)?.id ?? 0,
  events: events.map((event) => ({ ...event, ts: 0, runId: 'r' })),
})

describe('the projection', () => {
  it('knows which nodes are waiting for the integration worktree, and who holds it', () => {
    const queued = applyFrame(
      EMPTY_PROJECTION,
      frame([
        { id: 1, type: 'node_status', nodeId: 'p2', payload: { status: 'running' } },
        { id: 2, type: 'node_wait', nodeId: 'p2', payload: { on: 'integration_worktree', state: 'queued', holder: 'p1' } },
      ]) as never,
    )
    expect(queued.statuses.get('p2')).toBe('running')
    expect(queued.waits.get('p2')).toBe('p1')

    const granted = applyFrame(
      queued,
      frame([
        { id: 3, type: 'node_wait', nodeId: 'p2', payload: { on: 'integration_worktree', state: 'granted', holder: 'p1' } },
      ]) as never,
    )
    expect(granted.waits.has('p2')).toBe(false)

    // A resume starts from no waits: whatever was queued belongs to the process that died.
    const again = applyFrame(
      queued,
      frame([{ id: 3, type: 'run_resumed', nodeId: null, payload: { attempt: 2 } }]) as never,
    )
    expect(again.waits.size).toBe(0)
  })

  it('knows which parked nodes the operator paused, until someone answers', () => {
    const held = applyFrame(
      EMPTY_PROJECTION,
      frame([
        { id: 1, type: 'node_status', nodeId: 'p13', payload: { status: 'awaiting_human' } },
        { id: 2, type: 'node_operation', nodeId: 'p13', payload: { op: 'pause', delivery: 'held' } },
      ]) as never,
    )
    expect(held.held.has('p13')).toBe(true)

    const answered = applyFrame(
      held,
      frame([{ id: 3, type: 'human_answered', nodeId: 'p13', payload: { effect_id: 'e', answer: 'retry' } }]) as never,
    )
    expect(answered.held.has('p13')).toBe(false)

    // An ignored pause holds nothing.
    const ignored = applyFrame(
      EMPTY_PROJECTION,
      frame([{ id: 1, type: 'node_operation', nodeId: 'p1', payload: { op: 'pause', delivery: 'ignored' } }]) as never,
    )
    expect(ignored.held.size).toBe(0)
  })
})
