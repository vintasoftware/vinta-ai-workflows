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
import { useEffect, useMemo, useState } from 'react'
import type { Client } from './client.ts'
import { EditorList, EditorView } from './Editor.tsx'
import { pageWorkflowClient, type WorkflowClient } from './editor-client.ts'
import { NodeView } from './Node.tsx'
import { Notifications } from './Notifications.tsx'
import { Run } from './Run.tsx'
import { Runs } from './Runs.tsx'

// A run id is one segment — `encodeURIComponent` guarantees it — so the node
// route cannot be swallowed by the run route.
const RUN_ROUTE = /^#\/runs\/([^/]+)$/
const NODE_ROUTE = /^#\/runs\/([^/]+)\/nodes\/(.+)$/
const EDITOR_ROUTE = /^#\/editor(?:\/([^/]+))?$/

type Route =
  | { readonly kind: 'run'; readonly runId: string; readonly nodeId: string | null }
  | { readonly kind: 'editor'; readonly workflowId: string | null }

/**
 * The editor talks to workflow endpoints the run client does not carry, so it
 * gets its own. It is built from the page's own origin and the token already
 * in the query string — the same read `main.tsx` does, and the reason this is
 * a prop with a default rather than a second argument to the entry point.
 */
export function App({
  client,
  workflows,
}: {
  readonly client: Client
  readonly workflows?: WorkflowClient
}) {
  const [route, setRoute] = useState<Route | null>(() => routeOf(location.hash))
  const workflowClient = useMemo(() => workflows ?? pageWorkflowClient(), [workflows])

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
        <a href="#/editor">Editor</a>
        {/* §9.1's browser channel: its opt-in, and its degrade when refused. */}
        <Notifications />
      </header>
      {view()}
    </main>
  )

  function view() {
    if (route === null) return <Runs client={client} />
    if (route.kind === 'editor') {
      return route.workflowId === null ? (
        <EditorList workflows={workflowClient} />
      ) : (
        <EditorView
          key={route.workflowId}
          workflows={workflowClient}
          workflowId={route.workflowId}
        />
      )
    }
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
  const editor = EDITOR_ROUTE.exec(hash)
  if (editor !== null) {
    const id = editor[1]
    return { kind: 'editor', workflowId: id === undefined ? null : decodeURIComponent(id) }
  }
  const node = NODE_ROUTE.exec(hash)
  if (node?.[1] !== undefined && node[2] !== undefined) {
    return {
      kind: 'run',
      runId: decodeURIComponent(node[1]),
      nodeId: decodeURIComponent(node[2]),
    }
  }
  const run = RUN_ROUTE.exec(hash)
  return run?.[1] === undefined
    ? null
    : { kind: 'run', runId: decodeURIComponent(run[1]), nodeId: null }
}
