/**
 * The daemon's own log, as the browser reads it.
 *
 * Its own module for the reason `replay-client.ts` and `editor-client.ts` are
 * theirs: a different resource with a different lifetime. `client.ts` reads a
 * *run* — a snapshot plus a socket. This reads the *process*, which has no run
 * id, outlives every run, and is most interesting precisely when there is no
 * run to ask about.
 *
 * Same three rules as its neighbours: the daemon's own zod schema is the
 * contract, the token rides in a header and never becomes text, and a failure
 * names the endpoint and the status and nothing else.
 */
import { LogPageSchema, type LogPage } from '../../src/daemon/schemas.ts'

/** Mirrors `main.tsx`: the token is in the page's query string and read once. */
const TOKEN_QUERY = 'token'

export interface LogQuery {
  /** A cursor from a previous page. Absent asks for the tail. */
  readonly after?: string
  readonly tail?: number
  readonly level?: string
  readonly run?: string
  readonly node?: string
  readonly q?: string
}

export interface LogsClient {
  readonly logs: (query: LogQuery) => Promise<LogPage>
}

export function createLogsClient(origin: string, token: string): LogsClient {
  return {
    async logs(query) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') params.set(key, String(value))
      }
      const path = `/api/logs?${params.toString()}`
      const response = await fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error(`/api/logs: daemon answered ${response.status}`)
      const parsed = LogPageSchema.safeParse(await response.json())
      if (!parsed.success) throw new Error('/api/logs: response did not match the daemon schema')
      return parsed.data
    },
  }
}

/** The page's own origin and the token the daemon put in the URL (§10). */
export function pageLogsClient(): LogsClient {
  return createLogsClient(
    location.origin,
    new URLSearchParams(location.search).get(TOKEN_QUERY) ?? '',
  )
}
