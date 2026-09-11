/**
 * The run view (§10): the live DAG, the pools, the gate queue and the
 * per-harness capacity state.
 *
 * Everything on this screen is a projection. Node status is the fold over the
 * stream where the stream has said something, and the snapshot otherwise —
 * never a local guess, and never sticky: a reload rebuilds the identical
 * screen from the same two sources.
 *
 * The capacity panels exist because §6.1's backpressure is otherwise
 * invisible. A node parked on a rate limit and a harness parked on a quota
 * window look, from the graph alone, like nothing happening at all; the
 * operator's next move depends entirely on knowing which it is.
 */
import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Dag } from 'vinta-dag-editor/src/index.ts'
import type { RunSnapshot, RunUsageResponse } from '../../src/daemon/schemas.ts'
import { cacheShare } from '../../src/usage/usage.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { DagView } from './Dag.tsx'
import { nodeLabel, nodeTone, runTone } from './status.ts'
import { elapsed, useNow } from './time.ts'
import { useRun } from './useRun.ts'

/**
 * How often the rollup is re-read.
 *
 * Far slower than everything else on this screen, and deliberately: the daemon
 * folds every transcript in the run to answer it. These are totals that move
 * once per agent turn — minutes apart — so polling them at the cadence of the
 * event stream would buy nothing and cost a full scan per agent message.
 */
const USAGE_REFRESH_MS = 30_000

export function Run({ client, runId }: { readonly client: Client; readonly runId: string }) {
  const { snapshot, projection, connected, error } = useRun(client, runId)
  const now = useNow()
  const [selected, setSelected] = useState<string | null>(null)

  const nodes = useMemo(
    () =>
      (snapshot?.nodes ?? []).map((node) => ({
        ...node,
        status: projection.statuses.get(node.nodeId) ?? node.status,
      })),
    [snapshot, projection],
  )

  // Names, waves and edges all come off the snapshot: they are the frozen
  // workflow's, which `/api/runs/:runId` reads and this view must not. Status
  // is the one field the stream overrides, above.
  const edges = snapshot?.edges
  const dag = useMemo<Dag>(
    () => ({
      nodes: nodes.map((node) => ({
        id: node.nodeId,
        name: node.name,
        status: node.status,
        wave: node.wave,
      })),
      edges: (edges ?? []).map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        from: edge.from,
        to: edge.to,
        artifact: edge.artifact,
      })),
    }),
    [nodes, edges],
  )

  if (snapshot === null) {
    return (
      <section className="run">
        <p className="empty">{error ?? 'Loading run…'}</p>
      </section>
    )
  }

  const status = projection.runStatus ?? snapshot.run.status
  const endedAt = snapshot.run.endedAt

  return (
    <section className="run">
      <header className="run-head">
        <div>
          <h2>{snapshot.run.workflowId}</h2>
          <p className="muted">
            {snapshot.run.runId} · base {snapshot.run.baseBranch}
          </p>
        </div>
        <div className="run-meta">
          <Chip tone={runTone(status)}>{status}</Chip>
          <span className="muted">{elapsed(snapshot.run.startedAt, endedAt ?? now)}</span>
          <span className={connected ? 'live' : 'live off'}>
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
          {/* Offered on a live run too: §13.2's value is answering "which minute
              did it go wrong", which is a question you ask while it is still
              going. Replay covers the events journalled so far and says so. */}
          <a href={`#/runs/${encodeURIComponent(runId)}/replay`}>Replay</a>
        </div>
      </header>

      {error !== null && <p className="error">{error}</p>}

      <DagView dag={dag} selected={selected} onSelect={setSelected} />

      <div className="panels">
        <Nodes
          runId={snapshot.run.runId}
          nodes={nodes}
          selected={selected}
          onSelect={setSelected}
        />
        <Pools resources={snapshot.resources} />
        <GateQueue queue={snapshot.gateQueue} now={now} />
        <Harnesses harnesses={snapshot.harnesses} now={now} />
        <Rollup client={client} runId={runId} />
      </div>
    </section>
  )
}

function Nodes({
  runId,
  nodes,
  selected,
  onSelect,
}: {
  readonly runId: string
  readonly nodes: readonly RunSnapshot['nodes'][number][]
  readonly selected: string | null
  readonly onSelect: (nodeId: string) => void
}): ReactElement {
  return (
    <section className="panel">
      <h3>Nodes</h3>
      {nodes.length === 0 ? (
        <p className="empty">No nodes registered yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>Wave</th>
              <th>Harness</th>
              <th>Lane</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.nodeId} data-node={node.nodeId} aria-current={node.nodeId === selected}>
                <td>
                  <button type="button" className="link" onClick={() => onSelect(node.nodeId)}>
                    {node.nodeId}
                  </button>
                </td>
                <td>{node.wave}</td>
                <td>{node.harness}</td>
                <td>{node.lane ?? '—'}</td>
                <td>
                  <Chip tone={nodeTone(node.status)}>{nodeLabel(node.status)}</Chip>
                </td>
                <td>
                  {/* The node view (§10). A fragment, so the token in the
                      page's query string is neither copied nor dropped. */}
                  <a
                    href={`#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node.nodeId)}`}
                  >
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Pools({
  resources,
}: {
  readonly resources: RunSnapshot['resources']
}): ReactElement {
  return (
    <section className="panel">
      <h3>Resource pools</h3>
      {resources.length === 0 ? (
        <p className="empty">No pools declared.</p>
      ) : (
        <ul className="pools">
          {resources.map((resource) => (
            <li key={resource.id} data-resource={resource.id}>
              <div className="pool-head">
                <span>{resource.id}</span>
                <span className="muted">{resource.kind}</span>
                <span data-occupancy>
                  {resource.held} / {resource.capacity}
                </span>
              </div>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${fraction(resource)}%` }} />
              </div>
              <p className="muted">
                {resource.holders.length === 0 ? 'idle' : resource.holders.join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function GateQueue({
  queue,
  now,
}: {
  readonly queue: RunSnapshot['gateQueue']
  readonly now: number
}): ReactElement {
  return (
    <section className="panel">
      <h3>Gate queue</h3>
      <p data-waiting>
        <Chip tone={queue.waiting > 0 ? 'wait' : 'idle'}>{queue.waiting} waiting</Chip>
      </p>
      {queue.holders.length === 0 ? (
        <p className="empty">No gate held.</p>
      ) : (
        <ul className="holders">
          {queue.holders.map((holder) => (
            <li key={`${holder.resource}:${holder.nodeId}`} data-holder={holder.nodeId}>
              {holder.nodeId} holds {holder.resource} · {elapsed(holder.acquiredAt, now)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * §6.1's discovered ceiling, and the wait window when a vendor has said "not
 * right now". A parked harness is `wait`, never `error` — the run is being
 * throttled, not broken, and it will resume without anyone touching it.
 */
function Harnesses({
  harnesses,
  now,
}: {
  readonly harnesses: RunSnapshot['harnesses']
  readonly now: number
}): ReactElement {
  return (
    <section className="panel">
      <h3>Harness capacity</h3>
      {harnesses.length === 0 ? (
        <p className="empty">No harness in use.</p>
      ) : (
        <ul className="harnesses">
          {harnesses.map((harness) => (
            <li key={harness.id} data-harness={harness.id}>
              <span>{harness.id}</span>
              <span data-inflight>
                {harness.inFlight} / {harness.ceiling}
              </span>
              {harness.wakeAt === null ? (
                <Chip tone="ok">accepting</Chip>
              ) : (
                <Chip tone="wait">
                  {harness.wakeAt > now
                    ? `waiting on capacity · retries in ${elapsed(now, harness.wakeAt)}`
                    : 'waiting on capacity · retrying'}
                </Chip>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * §15.6's rollup: what the run's agents cost, and what reuse bought.
 *
 * The two halves belong on one panel because neither answers the question
 * alone. A poor cache hit rate can mean reuse is working and the prompts are
 * simply short; it can also mean reuse silently stopped. The turn counts
 * separate those, and the reason tally says which of §15.2's rules is doing it.
 *
 * **Nothing here prints a number the daemon did not report.** A harness that
 * reports no cost gives this run an unknown bill, not a free one, and a
 * `?? 0` anywhere below would turn that into a confident zero — the failure
 * §15.6 exists to prevent. Every figure is behind its status.
 */
function Rollup({ client, runId }: { readonly client: Client; readonly runId: string }) {
  const [usage, setUsage] = useState<RunUsageResponse | null>(null)
  const tick = useNow(USAGE_REFRESH_MS)

  useEffect(() => {
    let stopped = false
    client.usage(runId).then(
      (next) => {
        if (!stopped) setUsage(next)
      },
      // A rollup that cannot be read is not worth an error banner over the
      // whole run: the panel says nothing rather than pushing a failure at an
      // operator who came here to watch the graph.
      () => {},
    )
    return () => {
      stopped = true
    }
  }, [client, runId, tick])

  if (usage === null) {
    return (
      <section className="panel" data-rollup>
        <h3>Sessions and cost</h3>
        <p className="empty">Reading the run’s totals…</p>
      </section>
    )
  }

  const { reuse } = usage
  const share = cacheShare(usage.cache)

  return (
    <section className="panel" data-rollup>
      <h3>Sessions and cost</h3>
      <dl className="ref">
        <dt>Reuse</dt>
        <dd data-reuse>
          {reuse.turns === 0
            ? // Not "0%": a pipeline that names no slots asked for no reuse,
              // and reporting that as a rate would read as a feature that broke.
              'No agent turn asked to continue a session.'
            : `${percent(reuse.reused / reuse.turns)} of ${reuse.turns} turns continued a session.`}
        </dd>

        <dt>Cache</dt>
        <dd data-cache>
          {share === undefined
            ? 'Not reported by this run’s harnesses.'
            : `${percent(share)} of prompt tokens served from cache${
                usage.cache.status === 'partial' ? ', across the sessions that reported' : ''
              }.`}
        </dd>

        <dt>Tokens</dt>
        <dd data-tokens>
          {compact(usage.inputTokens)} in · {compact(usage.outputTokens)} out ·{' '}
          {usage.sessions} {usage.sessions === 1 ? 'session' : 'sessions'}
        </dd>

        <dt>Cost</dt>
        <dd data-cost>{cost(usage.cost)}</dd>
      </dl>

      {reuse.fresh.length > 0 && (
        <>
          {/* Labelled, because the tally is a column of bare numbers directly
              under a column of bare numbers. Without this it reads as more
              cost rows, and the reader has to infer what is being counted. */}
          <p className="muted fresh-head">Cold turns, by reason</p>
          <ul className="fresh-reasons">
            {reuse.fresh.map((entry) => (
              <li key={entry.reason} data-fresh-reason={entry.reason}>
                <span className="muted">{entry.reason.replaceAll('_', ' ')}</span>
                <span>{entry.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** Cost, never invented. A silent harness is unknown, not free (§15.6). */
function cost(total: RunUsageResponse['cost']): string {
  if (total.status === 'complete') return `$${total.usd.toFixed(2)}`
  if (total.status === 'partial') {
    return `$${total.usdSoFar.toFixed(2)} so far — ${total.missingSessions} of ${
      total.reportedSessions + total.missingSessions
    } sessions reported no cost.`
  }
  return 'Not reported by this run’s harnesses.'
}

const percent = (value: number): string => `${Math.round(value * 100)}%`

/** Token counts are read at a glance and compared, never summed by eye. */
function compact(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

function fraction(resource: RunSnapshot['resources'][number]): number {
  if (resource.capacity <= 0) return 0
  return Math.min(100, Math.round((resource.held / resource.capacity) * 100))
}
