/**
 * The runs list (§10): what exists, what it is doing, and how long it has been
 * doing it.
 *
 * §10's row also names resume and purge. The daemon serves neither — its
 * command surface is the five per-node operations of §9 — so the only action
 * offered here is opening the run. An action the API cannot perform does not
 * belong on a button.
 *
 * There is no stream for the list itself, so it re-reads on the same tick that
 * advances the elapsed clocks: one interval, both jobs.
 */
import { useEffect, useState } from 'react'
import type { RunSummary } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { runTone } from './status.ts'
import { elapsed, useNow } from './time.ts'

const REFRESH_MS = 2000

export function Runs({ client }: { readonly client: Client }) {
  const now = useNow(REFRESH_MS)
  const [runs, setRuns] = useState<readonly RunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    client.runs().then(
      (next) => {
        if (stopped) return
        setRuns(next)
        setError(null)
      },
      (cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : 'the daemon is unreachable')
      },
    )
    return () => {
      stopped = true
    }
  }, [client, now])

  if (error !== null) return <p className="error">{error}</p>
  if (runs === null) return <p className="empty">Loading runs…</p>
  if (runs.length === 0) return <p className="empty">No runs yet.</p>

  return (
    <table className="runs">
      <thead>
        <tr>
          <th>Workflow</th>
          <th>Run</th>
          <th>Status</th>
          <th>Elapsed</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.runId} data-run={run.runId}>
            <td>{run.workflowId}</td>
            <td className="muted">{run.runId}</td>
            <td>
              <Chip tone={runTone(run.status)}>{run.status}</Chip>
            </td>
            <td>{elapsed(run.startedAt, run.endedAt ?? now)}</td>
            <td>
              {/* A fragment, so the token in the page's query string is neither
                  copied into the link nor dropped from the address bar. */}
              <a href={`#/runs/${encodeURIComponent(run.runId)}`}>Open</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
