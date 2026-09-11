/**
 * §13.2's replay, which is the run view's own fold stopped early.
 *
 * The whole feature rests on one property of the journal: it is append-only,
 * so every event below the run's last id is immutable. Two things follow, and
 * they are the two things this module is.
 *
 * - **A page fetched once is never fetched again.** The cache below holds a
 *   contiguous prefix of the log and grows only forward. Scrubbing backwards
 *   is arithmetic over memory and issues no request at all; scrubbing forwards
 *   issues at most one request per `REPLAY_PAGE` events, ever, for the life of
 *   the view. A run of five thousand events costs ten reads however many times
 *   the slider is dragged across it — the alternative, re-reading the prefix
 *   on every tick, is quadratic in the thing that is already large.
 * - **Rewinding is not re-folding from zero.** `applyFrame` is cheap but it is
 *   not free, and a slider fires on every pixel. So the fold is checkpointed
 *   every `CHECKPOINT_STRIDE` events as the log loads — one pass, done once —
 *   and any position is reached by folding at most a stride's worth of events
 *   forward from the checkpoint below it. Seeking is O(stride), not O(n).
 *
 * **The fold is `projection.ts`'s, unmodified.** Not a copy of it, not a
 * variant of it: `applyFrame`, called on frames assembled out of the same
 * events the socket delivers. A second fold would be a second answer to "what
 * happened", and the point of replay is that there is only one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EventFrame, EventPage, JournalEvent } from '../../src/daemon/schemas.ts'
import { applyFrame, EMPTY_PROJECTION, type Projection } from './projection.ts'
import type { ReplayClient } from './replay-client.ts'

/** Events per read. Bounded by the endpoint at 1000; this is well under it. */
export const REPLAY_PAGE = 500

/** How many events a seek may have to fold. The cost of a slider tick. */
export const CHECKPOINT_STRIDE = 100

/**
 * A contiguous prefix of one run's log, plus the fold at every stride of it.
 *
 * Positions, not ids, are the coordinate: position 0 is the run before its
 * first event, position `k` is the run immediately after its `k`-th. Ids are
 * global across runs and therefore not dense within one, so a slider over ids
 * would be a slider over gaps.
 */
export class ReplayHistory {
  readonly #runId: string
  readonly #events: JournalEvent[] = []
  /** `#checkpoints[k]` is the fold over the first `k * CHECKPOINT_STRIDE` events. */
  readonly #checkpoints: Projection[] = [EMPTY_PROJECTION]
  #remaining = 0
  #opened = false

  constructor(runId: string) {
    this.#runId = runId
  }

  /** True once a page has landed — before that, `total` is not yet known. */
  get opened(): boolean {
    return this.#opened
  }

  get loaded(): number {
    return this.#events.length
  }

  /** Events the daemon holds beyond what is cached, as of the last page. */
  get remaining(): number {
    return this.#remaining
  }

  get total(): number {
    return this.#events.length + this.#remaining
  }

  /** The id to read from next. The journal's `since` is exclusive. */
  get cursor(): number {
    return this.#events.at(-1)?.id ?? 0
  }

  /** The event at a position, 1-based. `undefined` at position 0 and past the end. */
  eventAt(position: number): JournalEvent | undefined {
    return position <= 0 ? undefined : this.#events[position - 1]
  }

  /** Appends a page. Events at or below the cursor are dropped, as in the fold. */
  append(page: EventPage): void {
    this.#opened = true
    for (const event of page.events) {
      if (event.id <= this.cursor) continue
      this.#events.push(event)
    }
    this.#remaining = page.remaining
    this.#extend()
  }

  /** The run as it stood after `position` events. Clamped to what is cached. */
  at(position: number): Projection {
    const target = Math.max(0, Math.min(position, this.#events.length))
    const checkpoint = Math.floor(target / CHECKPOINT_STRIDE)
    return this.#fold(
      this.#checkpoints[checkpoint] ?? EMPTY_PROJECTION,
      checkpoint * CHECKPOINT_STRIDE,
      target,
    )
  }

  #fold(base: Projection, from: number, to: number): Projection {
    if (to <= from) return base
    return applyFrame(base, this.#frame(this.#events.slice(from, to)))
  }

  /**
   * A slice of the log, in the envelope the live socket delivers. The fold
   * takes frames, so replay hands it frames; nothing about `projection.ts`
   * had to learn that this one was assembled locally.
   */
  #frame(events: readonly JournalEvent[]): EventFrame {
    return {
      channel: 'events',
      runId: this.#runId,
      cursor: events.at(-1)?.id ?? 0,
      events: [...events],
    }
  }

  /** One fold per event over the life of the cache, amortised across pages. */
  #extend(): void {
    while (this.#checkpoints.length * CHECKPOINT_STRIDE <= this.#events.length) {
      const next = this.#checkpoints.length
      this.#checkpoints.push(
        this.#fold(
          this.#checkpoints[next - 1] ?? EMPTY_PROJECTION,
          (next - 1) * CHECKPOINT_STRIDE,
          next * CHECKPOINT_STRIDE,
        ),
      )
    }
  }
}

export interface ReplayView {
  readonly history: ReplayHistory
  /** The run as it stood at `position`, folded by `projection.ts`. */
  readonly projection: Projection
  readonly position: number
  readonly seek: (position: number) => void
  /** Events in the run, known from the first page onward. */
  readonly total: number
  readonly loaded: number
  readonly opened: boolean
  readonly loading: boolean
  readonly error: string | null
}

/**
 * The cache, the slider position and the reads that keep the two in step.
 *
 * Reads are serialised behind one promise chain and driven by a high-water
 * mark rather than by the current position: a drag emits dozens of positions
 * and none of them should start its own request. A seek into cached territory
 * starts nothing at all — which is the assertion the tests make, because "it
 * felt fast" is not a property.
 *
 * The history is created once. Switching runs is a remount (the route keys on
 * the run id), for the same reason the live view remounts: one run's cursor
 * must never be read against another's log.
 */
export function useReplay(client: ReplayClient, runId: string): ReplayView {
  const [history] = useState(() => new ReplayHistory(runId))
  const [revision, setRevision] = useState(0)
  const [position, setPosition] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const alive = useRef(true)
  const wanted = useRef(0)
  const pump = useRef<Promise<void>>(Promise.resolve())

  const fill = useCallback(
    (upto: number): void => {
      wanted.current = Math.max(wanted.current, upto)
      if (!needsRead(history, wanted.current)) return
      setLoading(true)
      pump.current = pump.current.then(async () => {
        try {
          while (alive.current && needsRead(history, wanted.current)) {
            const page = await client.events(runId, history.cursor, REPLAY_PAGE)
            if (!alive.current) return
            history.append(page)
            setRevision((n) => n + 1)
          }
          if (alive.current) setError(null)
        } catch (cause) {
          // The endpoint and the status, never a payload (§11).
          if (alive.current) setError(messageOf(cause))
        } finally {
          if (alive.current) setLoading(false)
        }
      })
    },
    [client, history, runId],
  )

  useEffect(() => {
    alive.current = true
    fill(0)
    return () => {
      alive.current = false
    }
  }, [fill])

  const seek = useCallback(
    (next: number): void => {
      setPosition(Math.max(0, next))
      fill(next)
    },
    [fill],
  )

  // `revision` is the dependency that matters: the history mutates in place,
  // so its identity says nothing about whether more of the log has landed.
  const projection = useMemo(() => history.at(position), [history, position, revision])

  return {
    history,
    projection,
    position,
    seek,
    total: history.total,
    loaded: history.loaded,
    opened: history.opened,
    loading,
    error,
  }
}

/** Nothing to read once the first page has landed and the target is cached. */
function needsRead(history: ReplayHistory, upto: number): boolean {
  if (!history.opened) return true
  return history.remaining > 0 && history.loaded < upto
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the daemon could not be reached'
}
