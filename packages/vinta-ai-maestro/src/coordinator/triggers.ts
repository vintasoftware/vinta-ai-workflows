/**
 * What wakes the run coordinator.
 *
 * Two kinds of thing, read two ways.
 *
 * **Something went wrong**, read from the journal as it happens: a phase that
 * failed, an attempt that errored, a fix loop that stalled on a gate (§13.4),
 * a phase queued behind the integration
 * worktree for longer than any merge should take, and — handed in by the
 * job's logger rather than read from the journal — an error maestro logged
 * about itself. These are why the coordinator exists: the run used to sit on
 * them until a person happened to look.
 *
 * **Something is costing too much**, read as thresholds over the whole run:
 * a phase that has been running for an hour, a gate whose uncached runs have
 * cost more than the phases that ran it can account for. Most of the time the
 * answer is that the work is hard; sometimes it is a test command rebuilding
 * its database on every run in every lane, which is what the coordinator is
 * woken to tell apart.
 *
 * Every trigger carries a `key`, and the loop wakes the coordinator once per
 * key: a phase that has been running for an hour is news once, not every
 * tick for the rest of the afternoon.
 */
import { unscopedGates } from '../config/resolve.ts'
import type { StoredEvent } from '../journal/events.ts'
import type { Workflow } from '../types.ts'

/** A phase that has been running this long is worth a look. */
export const DEFAULT_PHASE_THRESHOLD_MS = 60 * 60 * 1000

/**
 * The least a gate's uncached runs must add up to before they are worth a
 * look, however few phases ran it. The floor under the ceiling: below it, two
 * phases' worth of a slow suite is not news.
 */
export const DEFAULT_GATE_COST_CEILING_MS = 30 * 60 * 1000

/**
 * What one phase may spend on one gate, uncached, before the gate's total is
 * out of proportion. The ceiling is this times the phases that have run the
 * gate, never less than the floor above.
 *
 * A fixed ceiling read a long run as a costly one. One observed run woke its
 * coordinator five times on the test gate, and it did nothing each time,
 * because there was nothing to do: every phase spent its six minutes on the
 * suite, and enough phases add up to half an hour over and over. A phase's
 * gate runs inside its fix loop — the implementer asks for it, the reviewer,
 * a fixer round or two — so a suite of about five minutes legitimately runs
 * two or three times per phase. Fifteen minutes is that; a gate past it across
 * the run is being rerun out of proportion — a flake retried, a fix loop that
 * does not converge, a suite rebuilding its database every time — which is
 * what the coordinator can do something about.
 */
export const DEFAULT_GATE_COST_PER_PHASE_MS = 15 * 60 * 1000

/**
 * One uncached run of a gate this long is probably a cold lane: a scoped form
 * whose cache the lane did not have yet ran everything. One observed run's
 * `gate_cost` wake fired at 246 minutes, most of it first runs in new lanes.
 */
export const DEFAULT_COLD_RUN_MS = 20 * 60 * 1000

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
      /** The phases whose uncached runs the total is over — what the ceiling scaled by. */
      readonly phases: number
      /**
       * The gate runs its full command on every phase because it has no scoped
       * form (`unscopedGates`): the likeliest reason it costs this much, and one
       * the coordinator cannot amend away — its policy refuses adding a
       * `scoped_cmd` (`coordinator/policy.ts`).
       * False when the trigger was read without the workflow.
       */
      readonly fullEveryPhase: boolean
      /** Uncached minutes per phase, largest first, and the phase's longest single run. */
      readonly perPhase: readonly { readonly nodeId: string; readonly ms: number; readonly longestMs: number }[]
      /** The single-run threshold `perPhase` entries are flagged against as probably a cold lane. */
      readonly coldRunMs: number
      /**
       * Runs left out of the total because they ran the gate's `cold_cmd` (a
       * lane with no scope cache): slow by design, and nothing to act on.
       */
      readonly coldRunsExcluded: number
    }
  | { readonly kind: 'phase_failed'; readonly key: string; readonly nodeId: string; readonly reason: string }
  /**
   * A fixer round left the tree as it found it and the gate, run fresh, was
   * red on it again (`gate_stalled`, `escalated`). The phase is now asking
   * whether to continue. Something outside the lane's tracked files is the
   * likely cause — an ignored file, a cache, the lane's database — which an
   * agent working on the code cannot see and `exec` can.
   */
  | {
      readonly kind: 'gate_stalled'
      readonly key: string
      readonly nodeId: string
      readonly gateId: string
      readonly tree: string
    }
  | { readonly kind: 'attempt_failed'; readonly key: string; readonly nodeId: string; readonly reason: string }
  /** A session ended with tool calls that never returned (`tool_calls_unfinished`). */
  | {
      readonly kind: 'tool_calls_unfinished'
      readonly key: string
      readonly nodeId: string
      readonly tools: readonly string[]
      readonly count: number
    }
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
  /** The floor under the gate-cost ceiling. */
  readonly gateCostCeilingMs?: number
  readonly gateCostPerPhaseMs?: number
  readonly integrationWaitMs?: number
  /** A single uncached run this long reads as a cold lane (`DEFAULT_COLD_RUN_MS`). */
  readonly coldRunMs?: number
  /**
   * The run's definition now, when the caller has it: lets a `gate_cost`
   * trigger say that the gate has no scoped form. Read without the project's
   * file, so it can say *that*, not why.
   */
  readonly workflow?: Workflow
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
  const gateCostFloorMs = options.gateCostCeilingMs ?? DEFAULT_GATE_COST_CEILING_MS
  const gateCostPerPhaseMs = options.gateCostPerPhaseMs ?? DEFAULT_GATE_COST_PER_PHASE_MS
  const unscoped = new Set(
    options.workflow === undefined ? [] : unscopedGates(options.workflow, null).map((finding) => finding.gateId),
  )
  const integrationWaitMs = options.integrationWaitMs ?? DEFAULT_INTEGRATION_WAIT_MS
  const coldRunMs = options.coldRunMs ?? DEFAULT_COLD_RUN_MS

  const found: CoordinatorTrigger[] = []
  // Where each node's current attempt began, and the coordinator's last act
  // on it: an attempt that fails after the coordinator already acted on it —
  // a fix that landed while the attempt was still in flight — is handled.
  const attemptStart = new Map<string, number>()
  const coordinatorActed = new Map<string, number>()

  for (const event of events) {
    const nodeId = nodeOf(event)
    noteCoordinatorAct(event, coordinatorActed)
    if (nodeId !== null && event.type === 'node_status' && (event.payload as { status?: string }).status === 'running') {
      attemptStart.set(nodeId, event.id)
    }
    if (event.id <= sinceId || nodeId === null) continue
    const payload = event.payload as { status?: string; reason?: string }
    if (event.type === 'node_status' && payload.status === 'failed') {
      found.push({ kind: 'phase_failed', key: `failed:${event.id}`, nodeId, reason: payload.reason ?? 'no reason recorded' })
    } else if (event.type === 'node_error') {
      if ((coordinatorActed.get(nodeId) ?? -1) > (attemptStart.get(nodeId) ?? -1)) continue
      found.push({ kind: 'attempt_failed', key: `error:${event.id}`, nodeId, reason: payload.reason ?? 'no reason recorded' })
    } else if (event.type === 'tool_calls_unfinished') {
      const unfinished = event.payload as { tools?: readonly string[]; count?: number }
      found.push({
        kind: 'tool_calls_unfinished',
        key: `unfinished:${event.id}`,
        nodeId,
        tools: unfinished.tools ?? [],
        count: unfinished.count ?? 0,
      })
    } else if (event.type === 'gate_stalled') {
      const stalled = event.payload as { gate?: string; tree?: string; outcome?: string }
      if (stalled.outcome === 'escalated' && stalled.gate !== undefined && stalled.tree !== undefined) {
        found.push({ kind: 'gate_stalled', key: `stalled:${event.id}`, nodeId, gateId: stalled.gate, tree: stalled.tree })
      }
    }
  }

  for (const [nodeId, startedAt] of runningSince(events)) {
    const observedMs = now - startedAt
    if (observedMs >= phaseThresholdMs) {
      found.push({ kind: 'phase_elapsed', key: `elapsed:${nodeId}@${startedAt}`, nodeId, observedMs, thresholdMs: phaseThresholdMs })
    }
  }

  for (const [gateId, cost] of gateCost(events)) {
    // Scaled by the phases that have run the gate *so far*, not by the plan's
    // count: a plan's full allowance up front would hide the reruns of its
    // first phases until the run was nearly over.
    const ceilingMs = Math.max(gateCostFloorMs, gateCostPerPhaseMs * cost.phases)
    if (cost.totalMs < ceilingMs) continue
    // Once per multiple of the ceiling: a gate that keeps costing is news again
    // each time it costs another ceiling's worth, not on every tick. The
    // ceiling grows with the run, so a multiple already told can come round
    // again; it is not told twice, which errs on the side of the quiet the
    // scaling exists for.
    const multiple = Math.floor(cost.totalMs / ceilingMs)
    found.push({
      kind: 'gate_cost',
      key: `gate:${gateId}#${multiple}`,
      nodeId: cost.lastNodeId,
      gateId,
      observedMs: cost.totalMs,
      thresholdMs: ceilingMs,
      phases: cost.phases,
      fullEveryPhase: unscoped.has(gateId),
      perPhase: cost.perPhase,
      coldRunMs,
      coldRunsExcluded: cost.coldRuns,
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
    case 'gate_stalled':
      return (
        `- phase ${trigger.nodeId}'s fixer changed nothing and gate ${trigger.gateId} is still red on ` +
        `the same tree (${trigger.tree.slice(0, 12)}), run fresh. The phase is asking whether to ` +
        'continue. Look in its lane for a cause outside the tracked files (an ignored file, a tool ' +
        'cache, the database); once it is fixed, `gate-cache invalidate` the gate and answer `continue`'
      )
    case 'phase_elapsed':
      return (
        `- phase ${trigger.nodeId} has been running for ${minutes(trigger.observedMs)} minutes ` +
        `(threshold ${minutes(trigger.thresholdMs)})`
      )
    case 'gate_cost': {
      const cold = trigger.perPhase.filter((entry) => entry.longestMs >= trigger.coldRunMs)
      return (
        `- gate ${trigger.gateId} has cost ${minutes(trigger.observedMs)} minutes across this run, ` +
        `uncached, over ${trigger.phases} phase${trigger.phases === 1 ? '' : 's'} ` +
        `(ceiling ${minutes(trigger.thresholdMs)}); last run by ${trigger.nodeId}. Per phase: ` +
        trigger.perPhase.map((entry) => `${entry.nodeId} ${minutes(entry.ms)}m`).join(', ') +
        (cold.length === 0
          ? ''
          : `. A single run of ${minutes(trigger.coldRunMs)}m or more — ${cold.map((entry) => entry.nodeId).join(', ')} — ` +
            'is probably a cold lane (a scoped run with no cache yet runs everything); give the gate ' +
            '`scope_cache` and `cold_cmd`, and `project.lane_seed`, rather than retuning its command') +
        (trigger.coldRunsExcluded === 0
          ? ''
          : ` (${trigger.coldRunsExcluded} cold-lane run${trigger.coldRunsExcluded === 1 ? '' : 's'} of its cold_cmd left out)`) +
        (trigger.fullEveryPhase
          ? '. It has no scoped_cmd, so every phase and fix round runs its full command under ' +
            'gate_scope: scoped; adding one (a line with {changed_files} or {touches}) is the ' +
            'operator’s change, not an amendment you can make — tell them'
          : '')
      )
    }
    case 'tool_calls_unfinished':
      return (
        `- phase ${trigger.nodeId}'s agent ended its session with ${trigger.count} tool call` +
        `${trigger.count === 1 ? '' : 's'} (${trigger.tools.join(', ')}) that never returned: a command it ` +
        'started is still running, or hung, with nobody waiting for it. Look in its lane (`exec`, ' +
        '`docker ps` for its compose project) and stop what should not be running'
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
  /** How many distinct phases ran it uncached — what the ceiling scales by. */
  readonly phases: number
  /** The last phase to run it — somewhere to start reading. */
  readonly lastNodeId: string
  readonly perPhase: readonly { readonly nodeId: string; readonly ms: number; readonly longestMs: number }[]
  /** Runs of the gate's `cold_cmd`, left out of the total. */
  readonly coldRuns: number
}

/** A coordinator act on a node, by event id: operations, answers, amendments naming it. */
function noteCoordinatorAct(event: StoredEvent, acted: Map<string, number>): void {
  const payload = event.payload as { by?: string; author?: string; targets?: readonly string[] }
  if ((event.type === 'node_operation' || event.type === 'human_answered') && payload.by === 'coordinator') {
    const nodeId = nodeOf(event)
    if (nodeId !== null) acted.set(nodeId, event.id)
  } else if (event.type === 'workflow_amended' && payload.author === 'coordinator') {
    for (const target of payload.targets ?? []) {
      if (target.startsWith('node:')) acted.set(target.slice('node:'.length), event.id)
    }
  }
}

/**
 * Uncached gate time per gate id, across the run. A cache hit cost nothing,
 * and a phase that only ever hit the cache earns its gate no allowance.
 * `gate_result` is phase gates only — a wave's gates are `wave_gate_result` —
 * so the phases counted are the ones that ran it inside their own fix loops.
 */
function gateCost(events: readonly StoredEvent[]): ReadonlyMap<string, GateCost> {
  const totals = new Map<
    string,
    { totalMs: number; perNode: Map<string, { ms: number; longestMs: number }>; lastNodeId: string; coldRuns: number }
  >()
  // The form the next result of a node's gate ran in, from its `gate_started`.
  const form = new Map<string, string | undefined>()
  for (const event of events) {
    if (event.type === 'gate_started') {
      form.set(`${event.nodeId}\u0000${event.payload.gate}`, event.payload.form)
      continue
    }
    if (event.type !== 'gate_result' || event.nodeId === null) continue
    const payload = event.payload as { gate?: string; duration_ms?: number; cached?: boolean }
    if (payload.gate === undefined || typeof payload.duration_ms !== 'number' || payload.cached === true) continue
    const entry = totals.get(payload.gate) ?? {
      totalMs: 0,
      perNode: new Map<string, { ms: number; longestMs: number }>(),
      lastNodeId: event.nodeId,
      coldRuns: 0,
    }
    totals.set(payload.gate, entry)
    const key = `${event.nodeId}\u0000${payload.gate}`
    const ranCold = form.get(key) === 'cold'
    form.delete(key)
    if (ranCold) {
      entry.coldRuns += 1
      continue
    }
    entry.totalMs += payload.duration_ms
    const node = entry.perNode.get(event.nodeId) ?? { ms: 0, longestMs: 0 }
    node.ms += payload.duration_ms
    node.longestMs = Math.max(node.longestMs, payload.duration_ms)
    entry.perNode.set(event.nodeId, node)
    entry.lastNodeId = event.nodeId
  }
  return new Map(
    [...totals].map(([gate, entry]) => [
      gate,
      {
        totalMs: entry.totalMs,
        phases: entry.perNode.size,
        lastNodeId: entry.lastNodeId,
        perPhase: [...entry.perNode]
          .map(([nodeId, node]) => ({ nodeId, ms: node.ms, longestMs: node.longestMs }))
          .sort((left, right) => right.ms - left.ms),
        coldRuns: entry.coldRuns,
      },
    ]),
  )
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
