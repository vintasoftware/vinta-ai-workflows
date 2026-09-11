/**
 * §13.2's replay: the run view, with a slider where the socket was.
 *
 * The claim this screen has to earn is that what it shows is what happened —
 * not an approximation of it — so it is built out of the same two pieces the
 * live view is built from and nothing else:
 *
 * - **The fold**, `projection.ts`'s `applyFrame`, stopped at a position in the
 *   log rather than run to its end. `replay.ts` caches and checkpoints it; no
 *   status on this screen is computed anywhere else.
 * - **The snapshot**, for the frozen workflow's names, waves and edges. Those
 *   are plan structure, not run state — no event carries them (§5.3) — so they
 *   are the same at every position and are read exactly as the live view reads
 *   them.
 *
 * What it deliberately does *not* borrow is the snapshot's node statuses. Those
 * are the run *now*, and showing them for a node the fold has not reached yet
 * would put the future on screen at position zero. The fold's own default is
 * the truthful one and it is not a guess: `node_registered` projects `pending`
 * and only `node_status` moves it, so "no event yet" is `pending` in the
 * journal too — which is also why replaying to the end reproduces the live view
 * exactly rather than nearly.
 *
 * Payloads are never rendered. An event's type and node id are identifiers; its
 * payload can hold phase prose, so the timeline shows what happened and where,
 * and the node view remains the place transcripts are read (§11).
 */
import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Dag } from 'vinta-dag-editor/src/index.ts'
import type { RunSnapshot } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { DagView } from './Dag.tsx'
import type { NodeStatus, RunStatus } from './projection.ts'
import type { ReplayClient } from './replay-client.ts'
import { useReplay } from './replay.ts'
import { nodeLabel, nodeTone, runTone } from './status.ts'
import { elapsed } from './time.ts'

/** Before its first `node_status`, a node is `pending` — in the journal too. */
const UNTOUCHED: NodeStatus = 'pending'

/** Before `run_ended`, a run is running. The status event is the only mover. */
const UNENDED: RunStatus = 'running'

export function Replay({
  client,
  replay,
  runId,
}: {
  readonly client: Client
  readonly replay: ReplayClient
  readonly runId: string
}): ReactElement {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const { history, projection, position, seek, total, loaded, opened, loading, error } = useReplay(
    replay,
    runId,
  )

  useEffect(() => {
    let stopped = false
    client.snapshot(runId).then(
      (next) => {
        if (!stopped) setSnapshot(next)
      },
      (cause: unknown) => {
        if (!stopped) setSnapshotError(cause instanceof Error ? cause.message : 'snapshot failed')
      },
    )
    return () => {
      stopped = true
    }
  }, [client, runId])

  // Node identity comes from the snapshot when there is one. When there is not
  // — a run the daemon is no longer running, which is the reviewer's case — the
  // log still names every node that ever moved, so replay degrades to ids
  // rather than to nothing.
  const declared = snapshot?.nodes
  const statuses = projection.statuses
  const nodes = useMemo(
    () =>
      declared === undefined
        ? [...statuses.keys()].sort().map((nodeId) => ({ nodeId, name: nodeId, wave: 0 }))
        : declared.map((node) => ({ nodeId: node.nodeId, name: node.name, wave: node.wave })),
    [declared, statuses],
  )

  const edges = snapshot?.edges
  const dag = useMemo<Dag>(
    () => ({
      nodes: nodes.map((node) => ({
        id: node.nodeId,
        name: node.name,
        status: statuses.get(node.nodeId) ?? UNTOUCHED,
        wave: node.wave,
      })),
      edges: (edges ?? []).map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        from: edge.from,
        to: edge.to,
        artifact: edge.artifact,
      })),
    }),
    [nodes, edges, statuses],
  )

  const event = history.eventAt(position)
  const startedAt = snapshot?.run.startedAt ?? history.eventAt(1)?.ts ?? null
  const at = event?.ts ?? startedAt
  const status = projection.runStatus ?? UNENDED
  const inProgress = snapshot !== null && snapshot.run.status === 'running'

  return (
    <section className="run">
      <header className="run-head">
        <div>
          <h2>Replay · {snapshot?.run.workflowId ?? runId}</h2>
          <p className="muted">
            {runId}
            {snapshot === null ? '' : ` · base ${snapshot.run.baseBranch}`}
          </p>
        </div>
        <div className="run-meta">
          <Chip tone={runTone(status)}>{status}</Chip>
          <span className="muted" data-position>
            event {position} of {total}
          </span>
        </div>
      </header>

      {/* A run still moving can be replayed up to whatever the log holds now —
          which is a prefix of the run, not the run. Saying so is the whole
          difference between a history and a half-read one. */}
      {inProgress && (
        <p className="muted" data-inprogress>
          This run is still in progress. Replay covers the {total} event
          {total === 1 ? '' : 's'} journalled so far, not the whole run.
        </p>
      )}
      {snapshotError !== null && (
        <p className="muted" data-degraded>
          The run graph is unavailable ({snapshotError}); replaying from the log alone.
        </p>
      )}
      {error !== null && <p className="error">{error}</p>}

      <section className="panel">
        <h3>Position</h3>
        <p className="run-meta">
          {at === null ? (
            <span className="muted" data-at="">
              —
            </span>
          ) : (
            <time data-at={at} dateTime={new Date(at).toISOString()}>
              {new Date(at).toLocaleTimeString()}
            </time>
          )}
          <span className="muted" data-elapsed>
            {startedAt === null || at === null ? '—' : `+${elapsed(startedAt, at)}`}
          </span>
          <span className="muted" data-event>
            {event === undefined
              ? 'before the first event'
              : `${event.type}${event.nodeId === null ? '' : ` · ${event.nodeId}`}`}
          </span>
          {loading && <span className="muted">loading…</span>}
        </p>
        <input
          type="range"
          aria-label="Replay position"
          data-slider
          min={0}
          max={total}
          step={1}
          value={Math.min(position, total)}
          disabled={total === 0}
          onChange={(change) => seek(Number(change.target.value))}
        />
        <p className="run-meta">
          <button type="button" onClick={() => seek(0)} disabled={position === 0}>
            Start
          </button>
          <button type="button" onClick={() => seek(position - 1)} disabled={position === 0}>
            Back
          </button>
          <button type="button" onClick={() => seek(position + 1)} disabled={position >= total}>
            Forward
          </button>
          <button type="button" onClick={() => seek(total)} disabled={position >= total}>
            End
          </button>
          <a href={`#/runs/${encodeURIComponent(runId)}`}>Live view</a>
        </p>
        {opened && total === 0 && <p className="empty">This run has no events yet.</p>}
        {position > loaded && <p className="muted">Reading the log up to that point…</p>}
      </section>

      <DagView dag={dag} selected={selected} onSelect={setSelected} />

      <div className="panels">
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
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => {
                  const nodeStatus = statuses.get(node.nodeId) ?? UNTOUCHED
                  return (
                    <tr
                      key={node.nodeId}
                      data-node={node.nodeId}
                      aria-current={node.nodeId === selected}
                    >
                      <td>{node.nodeId}</td>
                      <td>{node.wave}</td>
                      <td>
                        <Chip tone={nodeTone(nodeStatus)}>{nodeLabel(nodeStatus)}</Chip>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </section>
  )
}
