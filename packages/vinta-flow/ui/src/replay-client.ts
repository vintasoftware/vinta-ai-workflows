/**
 * The replay half of the wire: one bounded read of a run's log (§13.2).
 *
 * Separate from `client.ts` for the same reason `editor-client.ts` is — a
 * different resource with a different lifetime. `client.ts` reads a run that is
 * *moving*: a snapshot plus a socket that never stops. This reads a run's
 * *history*, which is immutable below the last id it was told about, and that
 * immutability is the whole caching argument. Mixing the two would put a
 * paging cursor in a module whose entire premise is that it never pages.
 *
 * It follows its neighbours' three rules unchanged: the daemon's own zod
 * schema is the contract, the token rides in a header and never becomes text,
 * and a failure names the endpoint and the status and nothing else — an event
 * payload can hold a phase's prose, and an error message is the one place that
 * must not become a second copy of it (§11).
 */
import { EventPageSchema, type EventPage } from '../../src/daemon/schemas.ts'

/** Mirrors `main.tsx`: the token is in the page's query string and read once. */
const TOKEN_QUERY = 'token'

export interface ReplayClient {
  /** Events after `since`, at most `limit` of them, oldest first. */
  readonly events: (runId: string, since: number, limit: number) => Promise<EventPage>
}

export function createReplayClient(origin: string, token: string): ReplayClient {
  return {
    async events(runId, since, limit) {
      const path =
        `/api/runs/${encodeURIComponent(runId)}/events` +
        `?since=${encodeURIComponent(String(since))}&limit=${encodeURIComponent(String(limit))}`
      const response = await fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        throw new Error(`/api/runs/:runId/events: daemon answered ${response.status}`)
      }
      const parsed = EventPageSchema.safeParse(await response.json())
      if (!parsed.success) {
        throw new Error('/api/runs/:runId/events: response did not match the daemon schema')
      }
      return parsed.data
    },
  }
}

/** The page's own origin and the token the daemon put in the URL (§10). */
export function pageReplayClient(): ReplayClient {
  return createReplayClient(
    location.origin,
    new URLSearchParams(location.search).get(TOKEN_QUERY) ?? '',
  )
}
