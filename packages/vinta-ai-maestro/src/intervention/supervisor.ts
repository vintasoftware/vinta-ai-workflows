/**
 * The timer that drives `intervene`, living beside the run rather than inside
 * the daemon.
 *
 * Where this sits is the one design decision in the file. The obvious home is
 * the daemon — it already has the journal, it already serves the monitor, and
 * it is the thing that is up. But `vinta-ai-maestro run` composes a run without
 * the browser ever being involved, and a feature that only worked when someone
 * happened to be using `serve` would be missing from exactly the runs it is for:
 * the unattended ones. So it is wired where the run is composed (`run/start.ts`)
 * and both entry points get it.
 *
 * ## What it does not do
 *
 * It does not race the scheduler. Everything it can change goes through
 * `amendRun`, which refuses while a node it blocks is in flight and is the same
 * gate an operator's edit passes through. This module is a clock; the safety is
 * one layer down, where it can be tested without one.
 *
 * It does not overlap with itself. A tick whose monitor turn is still running
 * when the next tick fires is skipped rather than queued — two monitors reading
 * one run and proposing against the same ledger is the thrash the ledger exists
 * to prevent, arrived at through concurrency instead of through time.
 *
 * It does not keep the process alive. The timer is `unref`'d, so a run that has
 * finished exits when it is done rather than at the next tick; the daemon has
 * its own reasons to stay up and does not need this one.
 */
import type { Workflow } from '../types.ts'
import { intervene, type InterventionOutcome, type InterveneOptions } from './intervene.ts'

/**
 * How often to look — every ten minutes.
 *
 * Well under the one-hour phase threshold, because a tick interval that
 * approached it would turn "an hour" into "somewhere between one and two
 * hours". Well over the cost of a tick, which is one pass over the run's events
 * and no model turn in the overwhelming majority of cases.
 */
export const DEFAULT_TICK_MS = 10 * 60 * 1000

export interface SupervisorOptions extends Omit<InterveneOptions, 'workflow'> {
  /**
   * The run's definition *now*.
   *
   * A function, not a value: the run amends itself, and a supervisor holding
   * the workflow it started with would propose its second intervention against
   * a definition its first one had already replaced.
   */
  readonly workflow: () => Workflow
  readonly tickMs?: number
  /** Called after every tick that did anything. Tests, and the run's own log. */
  readonly onOutcome?: (outcome: InterventionOutcome) => void
}

export interface Supervisor {
  /** Evaluate once, now. The tests' entry point, and the first tick's. */
  tick(): Promise<InterventionOutcome>
  stop(): void
}

export function startSupervisor(options: SupervisorOptions): Supervisor {
  let running = false
  let stopped = false

  const tick = async (): Promise<InterventionOutcome> => {
    if (stopped || running) return { kind: 'quiet' }
    running = true
    try {
      const outcome = await intervene({ ...options, workflow: options.workflow() })
      if (outcome.kind !== 'quiet') options.onOutcome?.(outcome)
      return outcome
    } catch {
      // A watchdog that can kill the run it watches is worse than no watchdog.
      // `intervene` already absorbs the refusals it knows about; this is the
      // backstop for the ones it does not.
      return { kind: 'quiet' }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, options.tickMs ?? DEFAULT_TICK_MS)
  timer.unref?.()

  return {
    tick,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
