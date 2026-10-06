/**
 * The clock that wakes the run coordinator, living beside the run.
 *
 * Wired where the run is composed (`run/start.ts`), not in the daemon, for the
 * reason the watchdog before it was: `vinta-ai-maestro run` composes a run with
 * no browser involved, and the runs that most need a coordinator are the
 * unattended ones.
 *
 * ## The shape of a wake
 *
 * Each tick reads the journal for new trouble and the thresholds for new
 * costs, adds whatever maestro logged as an error since the last tick
 * (`notify`), and wakes the coordinator once with all of it. Three things
 * keep that from becoming the most expensive part of the run:
 *
 * - **Once per thing.** Every trigger has a key and is told once — an hour-old
 *   phase is news at the hour, not on every tick after it.
 * - **One turn at a time, and a breath between.** A tick while a turn is in
 *   flight, or within the cool-down after one, keeps what it found for the
 *   next wake rather than dropping it. A burst of failures is one wake.
 * - **A budget.** A run wakes its coordinator at most `budget` times; the
 *   last wake is told so, and after it the triggers are recorded and not
 *   acted on. A coordinator that cannot fix something in that many tries is
 *   telling the operator something too.
 *
 * It never throws into the run, and its own failures never wake it: a
 * coordinator that cannot be reached is recorded, not retried in a loop.
 */
import type { Journal } from '../journal/journal.ts'
import type { Logger } from '../log/index.ts'
import { Monitor, MonitorUnavailable, runDigest } from '../monitor/monitor.ts'
import type { Workflow } from '../types.ts'
import { describeTriggers, triggersFrom, type CoordinatorTrigger, type TriggerOptions } from './triggers.ts'

/** How often to look. Cheap: one pass over the run's events, and no model turn unless something is new. */
export const DEFAULT_TICK_MS = 30 * 1000

/** The least time between two wakes. */
export const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000

/** Wakes per run. */
export const DEFAULT_WAKE_BUDGET = 24

export interface CoordinatorLoopOptions {
  readonly journal: Journal
  readonly runId: string
  /** The run's definition now: the run amends itself. */
  readonly workflow: () => Workflow
  readonly coordinator: Monitor
  readonly triggers?: Omit<TriggerOptions, 'now'>
  readonly tickMs?: number
  readonly cooldownMs?: number
  readonly budget?: number
  readonly now?: () => number
  readonly logger?: Logger
}

export type WakeOutcome =
  | { readonly kind: 'quiet' }
  | { readonly kind: 'deferred'; readonly pending: number }
  | { readonly kind: 'answered'; readonly triggers: readonly CoordinatorTrigger[] }
  | { readonly kind: 'unavailable'; readonly triggers: readonly CoordinatorTrigger[] }
  | { readonly kind: 'budget_spent'; readonly triggers: readonly CoordinatorTrigger[] }

export interface CoordinatorLoop {
  /** Look now. The tests' entry point, and every timer tick's. */
  tick(): Promise<WakeOutcome>
  /** An error maestro logged: woken for on the next tick. */
  notify(trigger: CoordinatorTrigger): void
  stop(): void
}

export function startCoordinatorLoop(options: CoordinatorLoopOptions): CoordinatorLoop {
  const { journal, runId } = options
  const now = options.now ?? Date.now
  const budget = options.budget ?? DEFAULT_WAKE_BUDGET
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS

  // History before the loop started is not news: a resumed run's old failures
  // were the last host's to report.
  let cursor = lastEventId(journal, runId)
  const told = new Set<string>()
  const pending = new Map<string, CoordinatorTrigger>()
  let wakes = journal.events(runId).filter((event) => event.type === 'coordinator_woke').length
  let lastWake = Number.NEGATIVE_INFINITY
  let busy = false
  let stopped = false
  let exhausted = false

  const collect = (): void => {
    const events = journal.events(runId)
    for (const trigger of triggersFrom(events, cursor, { ...options.triggers, now: now() })) {
      if (!told.has(trigger.key)) pending.set(trigger.key, trigger)
    }
    cursor = events.reduce((max, event) => Math.max(max, event.id), cursor)
  }

  const record = (outcome: 'answered' | 'unavailable' | 'budget_spent', found: readonly CoordinatorTrigger[]): void => {
    journal.append({
      runId,
      type: 'coordinator_woke',
      payload: {
        outcome,
        triggers: found.map((trigger) => ({
          kind: trigger.kind,
          ...('nodeId' in trigger && trigger.nodeId !== undefined ? { node: trigger.nodeId } : {}),
          ...(trigger.kind === 'gate_cost' ? { gate: trigger.gateId } : {}),
        })),
      },
    })
  }

  const tick = async (): Promise<WakeOutcome> => {
    if (stopped) return { kind: 'quiet' }
    try {
      collect()
      if (pending.size === 0) return { kind: 'quiet' }
      if (journal.run(runId)?.status !== 'running') return { kind: 'quiet' }
      if (busy || now() - lastWake < cooldownMs) return { kind: 'deferred', pending: pending.size }

      const found = [...pending.values()]
      pending.clear()
      for (const trigger of found) told.add(trigger.key)

      if (wakes >= budget) {
        // Recorded once, so the post-mortem says the coordinator stopped
        // being woken and why; later triggers are dropped silently.
        if (!exhausted) record('budget_spent', found)
        exhausted = true
        return { kind: 'budget_spent', triggers: found }
      }

      const digest = runDigest(journal, runId, options.workflow())
      if (digest === null) return { kind: 'quiet' }
      busy = true
      wakes += 1
      lastWake = now()
      const last = wakes === budget
      const lines =
        describeTriggers(found) +
        (last ? '\n\nThis is the last time this run will wake you; after it, only the operator can.' : '')
      try {
        await options.coordinator.wake(digest, lines)
        record('answered', found)
        return { kind: 'answered', triggers: found }
      } catch (error) {
        options.logger?.warn('coordinator.unavailable', {
          run: runId,
          kind: error instanceof MonitorUnavailable ? error.kind : 'error',
        })
        record('unavailable', found)
        return { kind: 'unavailable', triggers: found }
      } finally {
        busy = false
      }
    } catch (error) {
      // A coordinator loop that can crash the run it watches is worse than no
      // coordinator. Recorded at warn: an error here would wake it about itself.
      options.logger?.warn('coordinator.tick_failed', {
        run: runId,
        error: error instanceof Error ? error.name : 'unknown',
      })
      return { kind: 'quiet' }
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, options.tickMs ?? DEFAULT_TICK_MS)
  timer.unref?.()

  return {
    tick,
    notify(trigger) {
      if (stopped || told.has(trigger.key)) return
      pending.set(trigger.key, trigger)
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

function lastEventId(journal: Journal, runId: string): number {
  return journal.events(runId).reduce((max, event) => Math.max(max, event.id), 0)
}
