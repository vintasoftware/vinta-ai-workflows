/**
 * Errors maestro logs about itself, handed to the run coordinator.
 *
 * A logger wrapper rather than a reader of the log file, so an error reaches
 * the coordinator on the next tick rather than on whoever next opens `logs`,
 * and so nothing re-parses what was just written. The fields it passes on are
 * the record's own, which `log/record.ts` has already redacted and bounded.
 *
 * Two things it will not do. It never forwards the coordinator's own records
 * (`coordinator.*`): a coordinator woken about its own failure to be reached
 * would be a loop. And it does not wake once per occurrence: the same event on
 * the same phase is told on its 1st, 2nd, 4th, 8th… occurrence, so a failure
 * that repeats on every retry is still visible without being the whole budget.
 */
import { sanitize, type Logger } from '../log/index.ts'
import type { CoordinatorTrigger } from './triggers.ts'

/**
 * Where the tap delivers, before and after the run's coordinator exists. The
 * logger is wrapped before the run is composed, so an error in the first
 * minute — provisioning — is kept and handed over once a loop listens.
 */
export interface ErrorFeed {
  readonly push: (trigger: CoordinatorTrigger) => void
  listen(listener: (trigger: CoordinatorTrigger) => void): void
}

/** Errors kept for a listener that is not there yet. Enough to see a pattern. */
const BUFFERED = 20

export function createErrorFeed(): ErrorFeed {
  let listener: ((trigger: CoordinatorTrigger) => void) | null = null
  const early: CoordinatorTrigger[] = []
  return {
    push: (trigger) => {
      if (listener !== null) listener(trigger)
      else if (early.length < BUFFERED) early.push(trigger)
    },
    listen: (next) => {
      listener = next
      for (const trigger of early.splice(0)) next(trigger)
    },
  }
}

export function tapErrors(logger: Logger, notify: (trigger: CoordinatorTrigger) => void): Logger {
  const counts = new Map<string, number>()
  const wrap = (inner: Logger, nodeId: string | undefined): Logger => ({
    debug: (event, fields) => inner.debug(event, fields),
    info: (event, fields) => inner.info(event, fields),
    warn: (event, fields) => inner.warn(event, fields),
    error: (event, fields) => {
      inner.error(event, fields)
      if (event.startsWith('coordinator.')) return
      try {
        const safe = sanitize(fields)
        const node = typeof safe['node'] === 'string' ? safe['node'] : nodeId
        const id = `${event}:${node ?? ''}`
        const count = (counts.get(id) ?? 0) + 1
        counts.set(id, count)
        // Told on powers of two only.
        if ((count & (count - 1)) !== 0) return
        const message = typeof safe['message'] === 'string' ? safe['message'] : undefined
        const kind = typeof safe['error'] === 'string' ? safe['error'] : undefined
        const detail = [kind, message].filter((part) => part !== undefined).join(': ')
        notify({
          kind: 'maestro_error',
          key: `log:${id}#${count}`,
          event,
          ...(node === undefined ? {} : { nodeId: node }),
          ...(detail === '' ? {} : { detail }),
        })
      } catch {
        // The tap must never cost the record it is tapping.
      }
    },
    child: (context) => wrap(inner.child(context), context.nodeId ?? nodeId),
    enabled: (level) => inner.enabled(level),
  })
  return wrap(logger, undefined)
}
