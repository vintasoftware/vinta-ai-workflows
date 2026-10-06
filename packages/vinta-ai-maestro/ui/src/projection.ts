/**
 * The fold the run view renders (§10: "the UI holds no authoritative state").
 *
 * The journal is the truth; this is a projection of it that happens to live in
 * a browser. Two consequences worth naming:
 *
 * - **It is idempotent.** `since` is exclusive, so the daemon never resends an
 *   event — but a resume that overlaps, a second socket, or a reload that
 *   starts from a stale cursor all have to be harmless. Every event id at or
 *   below the cursor is dropped, and a frame that contributes nothing returns
 *   the *same object*, so React does not re-render for a replay.
 * - **It projects only what events carry.** Pool occupancy, gate leases and
 *   the per-harness wait window are live scheduler state, not journalled
 *   facts, so they are not derivable here and are re-read from the snapshot
 *   endpoint instead.
 *
 * The payload schemas below are built from the daemon's own field schemas
 * rather than restated, so the set of statuses cannot drift from the API's.
 */
import { z } from 'zod'
import {
  NodeSummarySchema,
  RunSummarySchema,
  type EventFrame,
  type RunSnapshot,
  type RunSummary,
} from '../../src/daemon/schemas.ts'

export type NodeStatus = RunSnapshot['nodes'][number]['status']
export type RunStatus = RunSummary['status']

const NodeStatusPayloadSchema = z.object({ status: NodeSummarySchema.shape.status })
const RunEndedPayloadSchema = z.object({ status: RunSummarySchema.shape.status })

export interface Projection {
  /** The id of the last event applied — the `since` of the next connection. */
  readonly cursor: number
  readonly statuses: ReadonlyMap<string, NodeStatus>
  readonly runStatus: RunStatus | null
}

export const EMPTY_PROJECTION: Projection = {
  cursor: 0,
  statuses: new Map(),
  runStatus: null,
}

export function applyFrame(projection: Projection, frame: EventFrame): Projection {
  const statuses = new Map(projection.statuses)
  let runStatus = projection.runStatus
  let applied = 0

  for (const event of frame.events) {
    if (event.id <= projection.cursor) continue
    applied += 1
    if (event.type === 'node_status' && event.nodeId !== null) {
      const payload = NodeStatusPayloadSchema.safeParse(event.payload)
      if (payload.success) statuses.set(event.nodeId, payload.data.status)
    } else if (event.type === 'run_ended') {
      const payload = RunEndedPayloadSchema.safeParse(event.payload)
      if (payload.success) runStatus = payload.data.status
    } else if (event.type === 'run_resumed') {
      // The one event that moves a run *backwards* out of a settled status.
      // Without it a resumed run keeps the badge of the attempt that was
      // interrupted — the operator watches nodes go green under a header that
      // still reads "failed", and the only way out is a reload.
      runStatus = 'running'
    }
  }

  if (applied === 0) return projection
  return { cursor: Math.max(projection.cursor, frame.cursor), statuses, runStatus }
}
