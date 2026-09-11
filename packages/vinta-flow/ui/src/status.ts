/**
 * How a status looks, and — the part that matters — what it *means*.
 *
 * §6.1 is unambiguous: a vendor refusing a spawn is backpressure, not failure.
 * Rate limits, concurrency caps and exhausted usage windows are expected
 * operating conditions, none of them fails a node, and every one of them
 * resolves on its own. A run view that paints `waiting_on_capacity` in the
 * failure colour tells the operator to kill a run that was going to recover,
 * which is the single most expensive mistake this screen can cause.
 *
 * So tone is a separate axis from status, and `waiting_on_capacity` is `wait`
 * — the same tone as a queued gate, not the tone of `failed`. `error` is
 * reserved for the one status that means a human has to do something because
 * the work did not happen.
 *
 * Labels come from the canvas's own string table so the graph and the roster
 * beside it cannot end up calling the same status two different things.
 */
import { DEFAULT_STRINGS } from 'vinta-dag-editor/src/index.ts'
import type { NodeStatus, RunStatus } from './projection.ts'

/** Presentation only. `wait` is patience, `error` is a stop. */
export type Tone = 'idle' | 'active' | 'wait' | 'attention' | 'ok' | 'error'

const NODE_TONES: Readonly<Record<NodeStatus, Tone>> = {
  pending: 'idle',
  running: 'active',
  waiting_on_capacity: 'wait',
  awaiting_human: 'attention',
  blocked: 'idle',
  done: 'ok',
  failed: 'error',
}

const RUN_TONES: Readonly<Record<RunStatus, Tone>> = {
  running: 'active',
  done: 'ok',
  failed: 'error',
}

export function nodeTone(status: NodeStatus): Tone {
  return NODE_TONES[status]
}

export function runTone(status: RunStatus): Tone {
  return RUN_TONES[status]
}

export function nodeLabel(status: NodeStatus): string {
  return DEFAULT_STRINGS.status[status]
}
