/**
 * Two views, so the route is the fragment and there is no router.
 *
 * The fragment is also the only navigation that is safe to render: the token
 * lives in the page's query string, and a fragment link leaves it exactly
 * where the daemon put it — never copied into an `href`, never in a referrer.
 *
 * `<Run key={runId}>` is deliberate. Switching runs must not carry one run's
 * cursor into another's stream, and remounting is the cheapest way to be sure
 * it cannot.
 */
import { useEffect, useState } from 'react'
import type { Client } from './client.ts'
import { Run } from './Run.tsx'
import { Runs } from './Runs.tsx'

const RUN_ROUTE = /^#\/runs\/(.+)$/

export function App({ client }: { readonly client: Client }) {
  const [runId, setRunId] = useState<string | null>(() => routeOf(location.hash))

  useEffect(() => {
    const onHashChange = (): void => setRunId(routeOf(location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return (
    <main className="app">
      <header className="app-head">
        <h1>
          <a href="#/">vinta-flow</a>
        </h1>
      </header>
      {runId === null ? <Runs client={client} /> : <Run key={runId} client={client} runId={runId} />}
    </main>
  )
}

function routeOf(hash: string): string | null {
  const match = RUN_ROUTE.exec(hash)
  return match?.[1] === undefined ? null : decodeURIComponent(match[1])
}
