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
import { useMemo, useState } from 'react'
import type { Dag } from 'vinta-dag-editor/src/index.ts'
import type { RunSnapshot } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { DagView } from './Dag.tsx'
import { nodeLabel, nodeTone, runTone } from './status.ts'
import { elapsed, useNow } from './time.ts'
import { useRun } from './useRun.ts'

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

function fraction(resource: RunSnapshot['resources'][number]): number {
  if (resource.capacity <= 0) return 0
  return Math.min(100, Math.round((resource.held / resource.capacity) * 100))
}
