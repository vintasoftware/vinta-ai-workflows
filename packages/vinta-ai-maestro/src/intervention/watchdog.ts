/**
 * When a run is worth waking the monitor about.
 *
 * Pure, and folded entirely out of `events`. That is not tidiness — it is what
 * makes the thresholds testable against a journal whose timestamps are chosen
 * rather than measured, exactly as `postmortem.ts` is. `Journal.append` stamps
 * `Date.now()`, so a real journal cannot express "this phase has been running
 * for ninety minutes" without ninety minutes passing.
 *
 * ## Two triggers, and the second is the useful one
 *
 * **A phase past its threshold** is the trigger that was asked for and the one
 * an operator would name: a phase has been `running` for more than an hour, so
 * something is worth a look. It is also the *blunt* one. A phase can be slow
 * because its work is hard, and an hour of a difficult phase is not evidence
 * of anything. Most firings of this trigger should end in a proposal that
 * changes nothing, which is why the intervention schema makes an empty
 * `changes` a first-class answer.
 *
 * **A gate past its cumulative ceiling** is the one that catches the case this
 * feature exists for. A `unit` gate missing `--reuse-db` does not make any
 * single phase slow enough to notice — it makes *every* gate run in *every*
 * lane pay a database rebuild, and the cost only becomes visible added up.
 * That sum is now in the journal (`gate_result.duration_ms`), and it fires
 * long before any one phase has been running for an hour. A run of six phases
 * at four minutes of wasted setup per gate run crosses this ceiling before the
 * first phase is halfway through.
 *
 * Both are deliberately cheap to evaluate: one pass over the run's events, no
 * git, no transcripts, no model. The expensive part is the monitor turn that
 * follows, and it only happens when one of these says so.
 *
 * ## Why elapsed is derived rather than stored
 *
 * `nodes` has no `started_at`, and adding one would be a projection field with
 * no event behind it — which §5.3 forbids for good reason. The last
 * `node_status` row moving a node to `running` is the start of its current
 * attempt, and a retry legitimately restarts that clock: a node on its second
 * attempt has been running for as long as *that* attempt, not since the first
 * one began. Deriving it gets the retry case right for free.
 */
import type { StoredEvent } from '../journal/events.ts'

/** One hour. The threshold the feature was asked for, and the default. */
export const DEFAULT_PHASE_THRESHOLD_MS = 60 * 60 * 1000

/**
 * Cumulative gate time before a gate is worth a look — thirty minutes.
 *
 * Summed across every run of that gate in the whole run, cached hits excluded.
 * Low enough that a gate wasting a few minutes per run trips it inside the
 * first wave, and high enough that a genuinely expensive suite run twice does
 * not.
 */
export const DEFAULT_GATE_COST_CEILING_MS = 30 * 60 * 1000

export type WatchdogTriggerKind = 'phase_elapsed' | 'gate_cost'

export interface WatchdogTrigger {
  readonly kind: WatchdogTriggerKind
  /** The phase that tripped it, or the phase whose gate did. */
  readonly nodeId: string
  /** The gate that tripped it. Only on `gate_cost`. */
  readonly gateId?: string
  /** Milliseconds observed: the phase's elapsed time, or the gate's total. */
  readonly observedMs: number
  /** What it was measured against. */
  readonly thresholdMs: number
}

export interface WatchdogOptions {
  readonly phaseThresholdMs?: number
  readonly gateCostCeilingMs?: number
  /** Injected in tests, and by the simulator's clock. */
  readonly now?: number
}

/**
 * Every threshold this run has crossed, dearest first.
 *
 * Returns all of them rather than the first, so the monitor is told the whole
 * picture in one turn: a run with a slow phase *and* an expensive gate is
 * usually one problem, and waking the monitor twice to see the two halves
 * separately costs two turns to reach a worse answer.
 */
export function triggers(
  events: readonly StoredEvent[],
  options: WatchdogOptions = {},
): readonly WatchdogTrigger[] {
  const phaseThresholdMs = options.phaseThresholdMs ?? DEFAULT_PHASE_THRESHOLD_MS
  const gateCostCeilingMs = options.gateCostCeilingMs ?? DEFAULT_GATE_COST_CEILING_MS
  const now = options.now ?? Date.now()

  const found: WatchdogTrigger[] = []

  for (const [nodeId, startedAt] of runningSince(events)) {
    const observedMs = now - startedAt
    if (observedMs >= phaseThresholdMs) {
      found.push({ kind: 'phase_elapsed', nodeId, observedMs, thresholdMs: phaseThresholdMs })
    }
  }

  for (const [key, cost] of gateCost(events)) {
    if (cost.totalMs < gateCostCeilingMs) continue
    found.push({
      kind: 'gate_cost',
      nodeId: cost.lastNodeId,
      gateId: key,
      observedMs: cost.totalMs,
      thresholdMs: gateCostCeilingMs,
    })
  }

  return found.sort((a, b) => b.observedMs - a.observedMs)
}

/**
 * When each currently-running node started its current attempt.
 *
 * A node that moved to `running` and has not moved since. Any later status —
 * `done`, `failed`, a park on capacity or on a human — clears it, because a
 * parked node is not burning anything and a settled one has nothing left to
 * intervene in.
 */
function runningSince(events: readonly StoredEvent[]): ReadonlyMap<string, number> {
  const since = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'node_status' || event.nodeId === null) continue
    const status = (event.payload as { status?: string }).status
    if (status === 'running') since.set(event.nodeId, event.ts)
    else since.delete(event.nodeId)
  }
  return since
}

interface GateCost {
  readonly totalMs: number
  /** The last phase to run it — somewhere for the monitor to start reading. */
  readonly lastNodeId: string
}

/**
 * Total wall-clock per gate id, across every phase that ran it.
 *
 * Keyed on the gate rather than on the pair, which is the whole point: a
 * mis-tuned gate is mis-tuned in every lane at once, and per-phase totals hide
 * exactly the cost that adding them up reveals.
 *
 * A cached result contributes nothing: its `duration_ms` is the duration of the
 * run that filled the cache, already counted once, so counting it again would
 * make a cache *raise* a gate's apparent cost. Rows written before durations
 * existed contribute nothing either — unmeasured is not free, and reading a
 * missing duration as zero is exactly what the optional field exists to
 * prevent.
 */
function gateCost(events: readonly StoredEvent[]): ReadonlyMap<string, GateCost> {
  const totals = new Map<string, GateCost>()

  for (const event of events) {
    if (event.type !== 'gate_result' || event.nodeId === null) continue
    const payload = event.payload as {
      gate?: string
      duration_ms?: number
      cached?: boolean
    }
    const gate = payload.gate
    const duration = payload.duration_ms
    if (gate === undefined || typeof duration !== 'number' || payload.cached === true) continue

    totals.set(gate, {
      totalMs: (totals.get(gate)?.totalMs ?? 0) + duration,
      lastNodeId: event.nodeId,
    })
  }

  return totals
}

/** One line per trigger, for the monitor's brief. Identifiers and numbers. */
export function describeTriggers(found: readonly WatchdogTrigger[]): string {
  return found
    .map((trigger) =>
      trigger.kind === 'phase_elapsed'
        ? `- phase ${trigger.nodeId} has been running for ${minutes(trigger.observedMs)} minutes ` +
          `(threshold ${minutes(trigger.thresholdMs)})`
        : `- gate ${trigger.gateId ?? '?'} has cost ${minutes(trigger.observedMs)} minutes across ` +
          `this run, uncached (ceiling ${minutes(trigger.thresholdMs)}); last run by ${trigger.nodeId}`,
    )
    .join('\n')
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}
