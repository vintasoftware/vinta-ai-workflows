/**
 * Three views, so the route is the fragment and there is still no router.
 *
 * The fragment is also the only navigation that is safe to render: the token
 * lives in the page's query string, and a fragment link leaves it exactly
 * where the daemon put it — never copied into an `href`, never in a referrer.
 *
 * The `key` on both live views is deliberate. Switching runs must not carry
 * one run's cursor into another's stream, and switching nodes must not show
 * one node's transcript under another's name; remounting is the cheapest way
 * to be sure neither can happen.
 */
import { useEffect, useState } from 'react'
import type { Client } from './client.ts'
import { NodeView } from './Node.tsx'
import { Notifications } from './Notifications.tsx'
import { Run } from './Run.tsx'
import { Runs } from './Runs.tsx'

// A run id is one segment — `encodeURIComponent` guarantees it — so the node
// route cannot be swallowed by the run route.
const RUN_ROUTE = /^#\/runs\/([^/]+)$/
const NODE_ROUTE = /^#\/runs\/([^/]+)\/nodes\/(.+)$/

interface Route {
  readonly runId: string
  readonly nodeId: string | null
}

export function App({ client }: { readonly client: Client }) {
  const [route, setRoute] = useState<Route | null>(() => routeOf(location.hash))

  useEffect(() => {
    const onHashChange = (): void => setRoute(routeOf(location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return (
    <main className="app">
      <header className="app-head">
        <h1>
          <a href="#/">vinta-flow</a>
        </h1>
        {/* §9.1's browser channel: its opt-in, and its degrade when refused. */}
        <Notifications />
      </header>
      {view()}
    </main>
  )

  function view() {
    if (route === null) return <Runs client={client} />
    if (route.nodeId === null) {
      return <Run key={route.runId} client={client} runId={route.runId} />
    }
    return (
      <NodeView
        key={`${route.runId}/${route.nodeId}`}
        client={client}
        runId={route.runId}
        nodeId={route.nodeId}
      />
    )
  }
}

function routeOf(hash: string): Route | null {
  const node = NODE_ROUTE.exec(hash)
  if (node?.[1] !== undefined && node[2] !== undefined) {
    return { runId: decodeURIComponent(node[1]), nodeId: decodeURIComponent(node[2]) }
  }
  const run = RUN_ROUTE.exec(hash)
  return run?.[1] === undefined ? null : { runId: decodeURIComponent(run[1]), nodeId: null }
}
