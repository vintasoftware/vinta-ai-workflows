/**
 * Eight views, so the route is the fragment and there is still no router.
 *
 * The fragment is also the only navigation that is safe to render: the token
 * lives in the page's query string, and a fragment link leaves it exactly
 * where the daemon put it — never copied into an `href`, never in a referrer.
 *
 * The `key` on both live views is deliberate. Switching runs must not carry
 * one run's cursor into another's stream, and switching nodes must not show
 * one node's transcript under another's name; remounting is the cheapest way
 * to be sure neither can happen.
 *
 * The chrome is the design system’s shell: one sticky bar — brand, the three
 * sections, the notification inbox, the theme — and one bounded column under it.
 * Nothing decorative; this is a tool, and the bar's whole job is to say where
 * you are and get out of the way.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  AppBrand,
  AppMain,
  AppNav,
  AppNavLink,
  AppShell,
  AppTopbar,
  AppTopbarActions,
} from 'vinta-design-system/layout'
import type { Client } from './client.ts'
import { DiffView } from './DiffView.tsx'
import { EditorList, EditorView } from './Editor.tsx'
import { Logs } from './Logs.tsx'
import { pageLogsClient, type LogsClient } from './logs-client.ts'
import { pageWorkflowClient, type WorkflowClient } from './editor-client.ts'
import { NodeView } from './Node.tsx'
import { PlanReviewView, PlansList } from './PlanReview.tsx'
import { pagePlansClient, type PlansClient } from './plans-client.ts'
import { Notifications } from './Notifications.tsx'
import { Replay } from './Replay.tsx'
import { pageReplayClient, type ReplayClient } from './replay-client.ts'
import { Run } from './Run.tsx'
import { Runs } from './Runs.tsx'
import { ThemeProvider, ThemeToggle } from './theme.tsx'
import { useRunWatch } from './watch.ts'

// A run id is one segment — `encodeURIComponent` guarantees it — so the node
// route cannot be swallowed by the run route.
const RUN_ROUTE = /^#\/runs\/([^/]+)$/
const NODE_ROUTE = /^#\/runs\/([^/]+)\/nodes\/(.+)$/
// A node id is one segment too (same guarantee), so `/changes` after it is
// this route and not part of the id. The optional `?file=` is which file to
// scroll to — a query inside the fragment, because the real query string is
// the token's and nothing else may be written into it.
const CHANGES_ROUTE = /^#\/runs\/([^/]+)\/nodes\/([^/]+)\/changes(?:\?file=(.*))?$/
const REPLAY_ROUTE = /^#\/runs\/([^/]+)\/replay$/
const EDITOR_ROUTE = /^#\/editor(?:\/([^/]+))?$/
const LOGS_ROUTE = /^#\/logs$/
const PLANS_ROUTE = /^#\/plans(?:\/([^/]+))?$/

type Route =
  | { readonly kind: 'run'; readonly runId: string; readonly nodeId: string | null }
  // §13.2's replay is its own member rather than a flag on `run`: it reads a
  // different endpoint, holds a scrub position instead of a socket, and must
  // remount when the run changes. A boolean field would have made those three
  // facts conditional inside one view.
  | { readonly kind: 'replay'; readonly runId: string }
  // §10's diff, full page. Its own member for the same reasons replay is: a
  // different read, a different layout, and a remount when the node changes.
  | {
      readonly kind: 'changes'
      readonly runId: string
      readonly nodeId: string
      readonly file: string | null
    }
  | { readonly kind: 'editor'; readonly workflowId: string | null }
  // §19: a plan under review. Its own member, not the editor's: it reads the
  // plan and its review rather than the bare workflow, and it writes comments
  // rather than the document.
  | { readonly kind: 'plans'; readonly workflowId: string | null }
  // Not addressed by a run, because the records worth reading most are the
  // ones with no run to address them by: a bind that failed, a start request
  // refused before a run id existed, a crash with three runs in flight.
  | { readonly kind: 'logs' }

/**
 * The editor talks to workflow endpoints the run client does not carry, so it
 * gets its own. It is built from the page's own origin and the token already
 * in the query string — the same read `main.tsx` does, and the reason this is
 * a prop with a default rather than a second argument to the entry point.
 */
export function App({
  client,
  workflows,
  replay,
  logs,
  plans,
}: {
  readonly client: Client
  readonly workflows?: WorkflowClient
  /** §13.2's log reader, for the same reason `workflows` is a prop. */
  readonly replay?: ReplayClient
  /** The daemon's own log, for the same reason again. */
  readonly logs?: LogsClient
  /** §19's plan review, for the same reason again. */
  readonly plans?: PlansClient
}) {
  const [route, setRoute] = useState<Route | null>(() => routeOf(location.hash))
  const workflowClient = useMemo(() => workflows ?? pageWorkflowClient(), [workflows])
  const replayClient = useMemo(() => replay ?? pageReplayClient(), [replay])
  const logsClient = useMemo(() => logs ?? pageLogsClient(), [logs])
  const plansClient = useMemo(() => plans ?? pagePlansClient(), [plans])
  // §9.1: a pause is announced whatever is on screen, not only on its run.
  useRunWatch(client)

  useEffect(() => {
    const onHashChange = (): void => setRoute(routeOf(location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const section =
    route?.kind === 'editor'
      ? 'editor'
      : route?.kind === 'logs'
        ? 'logs'
        : route?.kind === 'plans'
          ? 'plans'
          : 'runs'

  return (
    <ThemeProvider>
      <AppShell className="app">
        <AppTopbar className="app-head">
          <AppBrand href="#/">
            <BrandMark />
            vinta-ai-maestro
          </AppBrand>
          <AppNav>
            <AppNavLink href="#/" current={section === 'runs'}>
              Runs
            </AppNavLink>
            <AppNavLink href="#/plans" current={section === 'plans'}>
              Plans
            </AppNavLink>
            <AppNavLink href="#/editor" current={section === 'editor'}>
              Editor
            </AppNavLink>
            <AppNavLink href="#/logs" current={section === 'logs'}>
              Logs
            </AppNavLink>
          </AppNav>
          <AppTopbarActions>
            {/* §9.1's browser channel: the inbox, the opt-in and the reminders. */}
            <Notifications />
            <ThemeToggle />
          </AppTopbarActions>
        </AppTopbar>
        <AppMain>{view()}</AppMain>
      </AppShell>
    </ThemeProvider>
  )

  function view() {
    if (route === null) return <Runs client={client} />
    if (route.kind === 'logs') return <Logs logs={logsClient} />
    if (route.kind === 'plans') {
      return route.workflowId === null ? (
        <PlansList plans={plansClient} />
      ) : (
        <PlanReviewView key={route.workflowId} plans={plansClient} planId={route.workflowId} />
      )
    }
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
    if (route.kind === 'replay') {
      return (
        <Replay key={route.runId} client={client} replay={replayClient} runId={route.runId} />
      )
    }
    if (route.kind === 'changes') {
      return (
        <DiffView
          key={`${route.runId}/${route.nodeId}`}
          client={client}
          runId={route.runId}
          nodeId={route.nodeId}
          file={route.file}
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

/** The mark beside the name: a V, drawn rather than typed, in the brand blue. */
function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-grid size-[18px] place-items-center rounded-[5px] bg-primary text-primary-foreground"
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 4l5 8 5-8" />
      </svg>
    </span>
  )
}

function routeOf(hash: string): Route | null {
  if (LOGS_ROUTE.test(hash)) return { kind: 'logs' }
  const plans = PLANS_ROUTE.exec(hash)
  if (plans !== null) {
    const id = plans[1]
    return { kind: 'plans', workflowId: id === undefined ? null : decodeURIComponent(id) }
  }
  const editor = EDITOR_ROUTE.exec(hash)
  if (editor !== null) {
    const id = editor[1]
    return { kind: 'editor', workflowId: id === undefined ? null : decodeURIComponent(id) }
  }
  const replay = REPLAY_ROUTE.exec(hash)
  if (replay?.[1] !== undefined) {
    return { kind: 'replay', runId: decodeURIComponent(replay[1]) }
  }
  const changes = CHANGES_ROUTE.exec(hash)
  if (changes?.[1] !== undefined && changes[2] !== undefined) {
    return {
      kind: 'changes',
      runId: decodeURIComponent(changes[1]),
      nodeId: decodeURIComponent(changes[2]),
      file: changes[3] === undefined || changes[3] === '' ? null : decodeURIComponent(changes[3]),
    }
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
