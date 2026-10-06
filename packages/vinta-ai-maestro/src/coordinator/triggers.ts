/**
 * What wakes the run coordinator.
 *
 * Two kinds of thing, read two ways.
 *
 * **Something went wrong**, read from the journal as it happens: a phase that
 * failed, an attempt that errored, a phase queued behind the integration
 * worktree for longer than any merge should take, and — handed in by the
 * job's logger rather than read from the journal — an error maestro logged
 * about itself. These are why the coordinator exists: the run used to sit on
 * them until a person happened to look.
 *
 * **Something is costing too much**, read as thresholds over the whole run:
 * a phase that has been running for an hour, a gate whose uncached runs have
 * cost half an hour between them. Most of the time the answer is that the
 * work is hard; sometimes it is a test command rebuilding its database on
 * every run in every lane, which is what the coordinator is woken to tell
 * apart.
 *
 * Every trigger carries a `key`, and the loop wakes the coordinator once per
 * key: a phase that has been running for an hour is news once, not every
 * tick for the rest of the afternoon.
 */
import type { StoredEvent } from '../journal/events.ts'

/** A phase that has been running this long is worth a look. */
export const DEFAULT_PHASE_THRESHOLD_MS = 60 * 60 * 1000

/** A gate whose uncached runs add up to this is worth a look. */
export const DEFAULT_GATE_COST_CEILING_MS = 30 * 60 * 1000

/** A phase queued behind the integration worktree this long is stuck behind something. */
export const DEFAULT_INTEGRATION_WAIT_MS = 20 * 60 * 1000

export type CoordinatorTrigger =
  | {
      readonly kind: 'phase_elapsed'
      readonly key: string
      readonly nodeId: string
      readonly observedMs: number
      readonly thresholdMs: number
    }
  | {
      readonly kind: 'gate_cost'
      readonly key: string
      readonly nodeId: string
      readonly gateId: string
      readonly observedMs: number
      readonly thresholdMs: number
    }
  | { readonly kind: 'phase_failed'; readonly key: string; readonly nodeId: string; readonly reason: string }
  | { readonly kind: 'attempt_failed'; readonly key: string; readonly nodeId: string; readonly reason: string }
  | {
      readonly kind: 'integration_wait'
      readonly key: string
      readonly nodeId: string
      readonly holder: string | null
      readonly observedMs: number
    }
  | {
      readonly kind: 'maestro_error'
      readonly key: string
      readonly event: string
      readonly nodeId?: string
      readonly detail?: string
    }

export interface TriggerOptions {
  readonly phaseThresholdMs?: number
  readonly gateCostCeilingMs?: number
  readonly integrationWaitMs?: number
  /** Injected in tests. */
  readonly now?: number
}

/**
 * Every trigger the journal shows. Failures are read from events after
 * `sinceId` only — they are news once, when they happen; thresholds are read
 * over the whole run, because elapsed time and cumulative cost are.
 */
export function triggersFrom(
  events: readonly StoredEvent[],
  sinceId: number,
  options: TriggerOptions = {},
): readonly CoordinatorTrigger[] {
  const now = options.now ?? Date.now()
  const phaseThresholdMs = options.phaseThresholdMs ?? DEFAULT_PHASE_THRESHOLD_MS
  const gateCostCeilingMs = options.gateCostCeilingMs ?? DEFAULT_GATE_COST_CEILING_MS
  const integrationWaitMs = options.integrationWaitMs ?? DEFAULT_INTEGRATION_WAIT_MS

  const found: CoordinatorTrigger[] = []

  for (const event of events) {
    const nodeId = nodeOf(event)
    if (event.id <= sinceId || nodeId === null) continue
    const payload = event.payload as { status?: string; reason?: string }
    if (event.type === 'node_status' && payload.status === 'failed') {
      found.push({ kind: 'phase_failed', key: `failed:${event.id}`, nodeId, reason: payload.reason ?? 'no reason recorded' })
    } else if (event.type === 'node_error') {
      found.push({ kind: 'attempt_failed', key: `error:${event.id}`, nodeId, reason: payload.reason ?? 'no reason recorded' })
    }
  }

  for (const [nodeId, startedAt] of runningSince(events)) {
    const observedMs = now - startedAt
    if (observedMs >= phaseThresholdMs) {
      found.push({ kind: 'phase_elapsed', key: `elapsed:${nodeId}@${startedAt}`, nodeId, observedMs, thresholdMs: phaseThresholdMs })
    }
  }

  for (const [gateId, cost] of gateCost(events)) {
    if (cost.totalMs < gateCostCeilingMs) continue
    // Once per multiple of the ceiling: a gate that keeps costing is news again
    // each time it costs another ceiling's worth, not on every tick.
    const multiple = Math.floor(cost.totalMs / gateCostCeilingMs)
    found.push({
      kind: 'gate_cost',
      key: `gate:${gateId}#${multiple}`,
      nodeId: cost.lastNodeId,
      gateId,
      observedMs: cost.totalMs,
      thresholdMs: gateCostCeilingMs,
    })
  }

  for (const [nodeId, wait] of integrationWaits(events)) {
    const observedMs = now - wait.since
    if (observedMs >= integrationWaitMs) {
      found.push({ kind: 'integration_wait', key: `wait:${nodeId}@${wait.since}`, nodeId, holder: wait.holder, observedMs })
    }
  }

  return found
}

/** The triggers as the coordinator reads them: one line each. */
export function describeTriggers(found: readonly CoordinatorTrigger[]): string {
  return found.map(describeTrigger).join('\n')
}

function describeTrigger(trigger: CoordinatorTrigger): string {
  switch (trigger.kind) {
    case 'phase_failed':
      return `- phase ${trigger.nodeId} failed: ${trigger.reason}`
    case 'attempt_failed':
      return `- an attempt at phase ${trigger.nodeId} failed: ${trigger.reason}`
    case 'phase_elapsed':
      return (
        `- phase ${trigger.nodeId} has been running for ${minutes(trigger.observedMs)} minutes ` +
        `(threshold ${minutes(trigger.thresholdMs)})`
      )
    case 'gate_cost':
      return (
        `- gate ${trigger.gateId} has cost ${minutes(trigger.observedMs)} minutes across this run, ` +
        `uncached (ceiling ${minutes(trigger.thresholdMs)}); last run by ${trigger.nodeId}`
      )
    case 'integration_wait':
      return (
        `- phase ${trigger.nodeId} has waited ${minutes(trigger.observedMs)} minutes for the integration ` +
        `worktree${trigger.holder === null ? '' : `, held by ${trigger.holder}`}`
      )
    case 'maestro_error':
      return (
        `- maestro logged an error: ${trigger.event}` +
        `${trigger.nodeId === undefined ? '' : ` (phase ${trigger.nodeId})`}` +
        `${trigger.detail === undefined ? '' : `: ${trigger.detail}`}`
      )
  }
}

/** Each node's current `running` stint, by when it began. */
function runningSince(events: readonly StoredEvent[]): ReadonlyMap<string, number> {
  const since = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'node_status' || event.nodeId === null) continue
    const status = (event.payload as { status?: string }).status
    if (status === 'running') {
      // A node already running stays on its first timestamp: a re-announced
      // status is not a new stint.
      if (!since.has(event.nodeId)) since.set(event.nodeId, event.ts)
    } else {
      since.delete(event.nodeId)
    }
  }
  return since
}

interface GateCost {
  readonly totalMs: number
  /** The last phase to run it — somewhere to start reading. */
  readonly lastNodeId: string
}

/** Uncached gate time per gate id, across the run. A cache hit cost nothing. */
function gateCost(events: readonly StoredEvent[]): ReadonlyMap<string, GateCost> {
  const totals = new Map<string, GateCost>()
  for (const event of events) {
    if (event.type !== 'gate_result' || event.nodeId === null) continue
    const payload = event.payload as { gate?: string; duration_ms?: number; cached?: boolean }
    if (payload.gate === undefined || typeof payload.duration_ms !== 'number' || payload.cached === true) continue
    totals.set(payload.gate, {
      totalMs: (totals.get(payload.gate)?.totalMs ?? 0) + payload.duration_ms,
      lastNodeId: event.nodeId,
    })
  }
  return totals
}

/** Nodes still queued behind the integration worktree: since when, and behind whom. */
function integrationWaits(
  events: readonly StoredEvent[],
): ReadonlyMap<string, { readonly since: number; readonly holder: string | null }> {
  const waits = new Map<string, { readonly since: number; readonly holder: string | null }>()
  for (const event of events) {
    if (event.type === 'run_resumed') {
      waits.clear()
      continue
    }
    const nodeId = nodeOf(event)
    if (nodeId === null) continue
    if (event.type === 'node_wait') {
      const payload = event.payload as { state?: string; holder?: string | null }
      if (payload.state === 'queued') waits.set(nodeId, { since: event.ts, holder: payload.holder ?? null })
      else waits.delete(nodeId)
    } else if (event.type === 'node_status') {
      // A node that settled or restarted is no longer queued, whatever the
      // last `node_wait` said.
      const status = (event.payload as { status?: string }).status
      if (status !== 'running') waits.delete(nodeId)
    }
  }
  return waits
}

function nodeOf(event: StoredEvent): string | null {
  return 'nodeId' in event ? (event.nodeId as string | null) : null
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}
