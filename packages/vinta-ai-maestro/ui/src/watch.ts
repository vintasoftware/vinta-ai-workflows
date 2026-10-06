/**
 * Every live run, heard from whichever view is on screen.
 *
 * §9.1's browser channel used to fold only the frames of the run being looked
 * at, so an operator reading the runs list, the editor or the logs heard
 * nothing: a pause in a run they had navigated away from was exactly the
 * silence the channel exists to prevent. This keeps one quiet stream open per
 * running run for the notifier and nothing else — no projection, no PTY.
 *
 * **One socket per run, never two.** A run view already streams its run, so
 * it claims the run for as long as it is mounted and this watcher stands
 * back. When the view lets go it hands over its cursor, and the watcher picks
 * up from there rather than from the snapshot — the gap between the two
 * streams is zero events, not "whatever happened during a snapshot read".
 *
 * The run list is re-read on a slow timer: it is how a newly started run is
 * noticed and how a finished one is let go. The fold is keyed by the journal,
 * so an overlap between a released claim and a watcher stream costs nothing.
 */
import { useEffect } from 'react'
import type { Client, Stream } from './client.ts'
import { notifier } from './notifications.ts'

const POLL_MS = 5000
const RECONNECT_MS = 1000

/**
 * Per client, because a cursor is a position in one daemon's journal: a
 * position handed over by a view of one daemon means nothing to another.
 */
interface Registry {
  /** Runs a view is streaming itself, with how many views hold each. */
  readonly claims: Map<string, number>
  /** Where a released stream left off, for whoever listens next. */
  readonly handedOver: Map<string, number>
  readonly listeners: Set<() => void>
}

const registries = new WeakMap<Client, Registry>()

function registryOf(client: Client): Registry {
  let registry = registries.get(client)
  if (registry === undefined) {
    registry = { claims: new Map(), handedOver: new Map(), listeners: new Set() }
    registries.set(client, registry)
  }
  return registry
}

function handOver(registry: Registry, runId: string, cursor: number): void {
  if (cursor > 0) registry.handedOver.set(runId, Math.max(cursor, registry.handedOver.get(runId) ?? 0))
}

/**
 * Held by a view that streams `runId` itself. The returned release takes the
 * view's cursor, so whoever listens next starts where it stopped.
 */
export function claimRun(client: Client, runId: string): (cursor: number) => void {
  const registry = registryOf(client)
  registry.claims.set(runId, (registry.claims.get(runId) ?? 0) + 1)
  for (const listener of registry.listeners) listener()
  let released = false
  return (cursor) => {
    if (released) return
    released = true
    const held = (registry.claims.get(runId) ?? 1) - 1
    if (held <= 0) registry.claims.delete(runId)
    else registry.claims.set(runId, held)
    handOver(registry, runId, cursor)
    for (const listener of registry.listeners) listener()
  }
}

interface Watch {
  cursor: number
  socket: Stream | null
  retry: ReturnType<typeof setTimeout> | null
}

export function useRunWatch(client: Client): void {
  useEffect(() => {
    const registry = registryOf(client)
    const { claims, handedOver } = registry
    let stopped = false
    let live: ReadonlySet<string> = new Set()
    const watches = new Map<string, Watch>()

    const sync = (): void => {
      if (stopped) return
      for (const runId of live) if (!claims.has(runId) && !watches.has(runId)) begin(runId)
      for (const runId of [...watches.keys()]) if (!live.has(runId) || claims.has(runId)) end(runId)
    }

    const poll = (): void => {
      client.runs().then(
        (runs) => {
          if (stopped) return
          live = new Set(runs.filter((run) => run.status === 'running').map((run) => run.runId))
          sync()
        },
        () => {
          // An unreachable daemon is the run views' to report; try next tick.
        },
      )
    }

    const begin = (runId: string): void => {
      const watch: Watch = { cursor: 0, socket: null, retry: null }
      watches.set(runId, watch)
      const resumed = handedOver.get(runId)
      if (resumed !== undefined) {
        handedOver.delete(runId)
        watch.cursor = resumed
        open(runId, watch)
        return
      }
      // A cold start begins at the snapshot's cursor, as a run view does:
      // what happened before this page was open is the OS channel's to have
      // said, not something to announce now.
      client.snapshot(runId).then(
        (snapshot) => {
          if (watches.get(runId) !== watch) return
          watch.cursor = snapshot.cursor
          open(runId, watch)
        },
        () => {
          // Forget it, so the next poll tries again.
          if (watches.get(runId) === watch) watches.delete(runId)
        },
      )
    }

    const open = (runId: string, watch: Watch): void => {
      watch.retry = null
      watch.socket = client.stream(runId, watch.cursor, {
        onOpen: () => {},
        onFrame: (frame) => {
          if (watches.get(runId) !== watch) return
          watch.cursor = Math.max(watch.cursor, frame.cursor)
          notifier.ingest(runId, frame.events)
        },
        onPty: () => {},
        onClose: (reason) => {
          if (watches.get(runId) !== watch) return
          watch.socket = null
          // A frame this client cannot read will not become readable by
          // reconnecting; leave the run to its own view's error.
          if (reason === 'invalid_frame') return
          watch.retry = setTimeout(() => open(runId, watch), RECONNECT_MS)
        },
      })
    }

    const end = (runId: string): void => {
      const watch = watches.get(runId)
      if (watch === undefined) return
      watches.delete(runId)
      if (watch.retry !== null) clearTimeout(watch.retry)
      watch.socket?.close()
      // A claim is what usually ends a watch; the view takes over from here.
      handOver(registry, runId, watch.cursor)
    }

    registry.listeners.add(sync)
    poll()
    const timer = setInterval(poll, POLL_MS)

    return () => {
      stopped = true
      clearInterval(timer)
      registry.listeners.delete(sync)
      for (const runId of [...watches.keys()]) end(runId)
    }
  }, [client])
}
