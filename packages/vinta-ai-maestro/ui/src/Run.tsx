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
import { ChevronRightIcon, HistoryIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Dag } from 'vinta-dag-editor/src/index.ts'
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderMeta,
  PageHeaderTitle,
} from 'vinta-design-system/layout'
import { Badge } from 'vinta-design-system/ui/badge'
import { Button } from 'vinta-design-system/ui/button'
import { Progress } from 'vinta-design-system/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'vinta-design-system/ui/table'
import type { RunSnapshot, RunUsageResponse } from '../../src/daemon/schemas.ts'
import { cacheShare } from '../../src/usage/usage.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { DagView } from './Dag.tsx'
import { Explain } from './Explain.tsx'
import { Live } from './Live.tsx'
import { EmptyNote, ErrorNote, Hint, Panel } from './Panel.tsx'
import { nodeLabel, nodeTone, runTone } from './status.ts'
import { elapsed, useNow } from './time.ts'
import { MonitorPanel } from './Monitor.tsx'
import { RunControls } from './RunControls.tsx'
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

  // The node view (§10), by the same fragment the roster's Open button uses.
  const openNode = (nodeId: string): void => {
    location.hash = `#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`
  }

  if (snapshot === null) {
    return (
      <section className="run">
        <EmptyNote>{error ?? 'Loading run…'}</EmptyNote>
      </section>
    )
  }

  const status = projection.runStatus ?? snapshot.run.status
  const endedAt = snapshot.run.endedAt
  const waves = new Set(nodes.map((node) => node.wave)).size

  return (
    <section className="run flex flex-col gap-5">
      <PageHeader className="run-head">
        <PageHeaderHeading>
          <PageHeaderTitle>{snapshot.run.workflowId}</PageHeaderTitle>
          <PageHeaderMeta>
            <span>{snapshot.run.runId}</span>
            <span>base {snapshot.run.baseBranch}</span>
            <span>
              {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'} · {waves}{' '}
              {waves === 1 ? 'wave' : 'waves'}
            </span>
          </PageHeaderMeta>
        </PageHeaderHeading>
        <PageHeaderActions className="run-meta">
          <Chip tone={runTone(status)}>{status}</Chip>
          <span className="muted font-mono text-[13px] text-muted-foreground">
            {elapsed(snapshot.run.startedAt, endedAt ?? now)}
          </span>
          <Live connected={connected} />
          <RunControls client={client} runId={runId} status={status} />
          {/* Offered on a live run too: §13.2's value is answering "which minute
              did it go wrong", which is a question you ask while it is still
              going. Replay covers the events journalled so far and says so. */}
          <Button asChild variant="outline" size="sm">
            <a href={`#/runs/${encodeURIComponent(runId)}/replay`}>
              <HistoryIcon />
              Replay
            </a>
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <DagView dag={dag} selected={selected} onSelect={setSelected} onOpen={openNode} />
      <Hint className="-mt-3 text-xs">
        Click a node to see what it depends on and what waits for it; double-click to open it.
        Drag to pan, ⌘ or Ctrl + scroll to zoom.
      </Hint>

      <div className="panels grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Nodes
          runId={snapshot.run.runId}
          nodes={nodes}
          selected={selected}
          onSelect={setSelected}
        />
        <Rollup client={client} runId={runId} />
        <MonitorPanel client={client} runId={runId} />
        <Pools resources={snapshot.resources} />
        <GateQueue queue={snapshot.gateQueue} now={now} />
        <Harnesses harnesses={snapshot.harnesses} now={now} />
      </div>
    </section>
  )
}

/**
 * A lane name with the run's own id taken off the front.
 *
 * Every lane in a run is named `${runId}-...` (`run/host.ts` derives crew lane
 * names, `lanes/pool.ts` the numbered ones), so on this table the prefix is
 * identical on every row: width, and nothing else. What distinguishes the
 * lanes is the tail — `crew-3-tier4`, `lane-2`, `integ`. The full name stays
 * in `title`, because that is what the worktree directory and the branch are
 * actually called.
 */
function laneLabel(lane: string, runId: string): string {
  return lane.startsWith(`${runId}-`) ? lane.slice(runId.length + 1) : lane
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
    <Panel
      title="Nodes"
      description="Status is the stream's where it has spoken, the snapshot's otherwise."
      className="md:col-span-2"
      contentClassName="px-0"
    >
      {nodes.length === 0 ? (
        <EmptyNote className="px-4">No nodes registered yet.</EmptyNote>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Node</TableHead>
              <TableHead>Wave</TableHead>
              <TableHead>Harness</TableHead>
              <TableHead>Lane</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-px pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((node) => (
              <TableRow
                key={node.nodeId}
                data-node={node.nodeId}
                aria-current={node.nodeId === selected}
                className="aria-[current=true]:bg-muted"
              >
                <TableCell className="whitespace-normal pl-4">
                  {/* A phase description is a sentence, and the cell is
                      `whitespace-nowrap` by default — so left alone one node's
                      name sets the width of the whole table. Bounded and
                      wrapping, it costs a row a second line instead. */}
                  <div className="max-w-md">
                    <button
                      type="button"
                      className="link cursor-pointer font-medium text-primary underline-offset-4 hover:underline"
                      onClick={() => onSelect(node.nodeId)}
                    >
                      {node.nodeId}
                    </button>
                    <span className="ml-2 text-muted-foreground">{node.name}</span>
                  </div>
                </TableCell>
                <TableCell>{node.wave}</TableCell>
                <TableCell className="font-mono text-xs">{node.harness}</TableCell>
                <TableCell className="font-mono text-xs">
                  {node.lane === null ? (
                    '—'
                  ) : (
                    <span title={node.lane}>{laneLabel(node.lane, runId)}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Chip tone={nodeTone(node.status)}>{nodeLabel(node.status)}</Chip>
                </TableCell>
                <TableCell className="pr-4 text-right">
                  {/* The node view (§10). A fragment, so the token in the
                      page's query string is neither copied nor dropped. */}
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={`#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node.nodeId)}`}
                    >
                      Open
                      <ChevronRightIcon />
                    </a>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}

function Pools({
  resources,
}: {
  readonly resources: RunSnapshot['resources']
}): ReactElement {
  return (
    <Panel title="Resource pools">
      {resources.length === 0 ? (
        <EmptyNote>No pools declared.</EmptyNote>
      ) : (
        <ul className="pools divide-y">
          {resources.map((resource) => (
            <li
              key={resource.id}
              data-resource={resource.id}
              className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0"
            >
              <div className="pool-head flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{resource.id}</span>
                  <Badge variant="outline" className="muted">
                    {resource.kind}
                  </Badge>
                </span>
                <span className="font-mono text-xs" data-occupancy>
                  {resource.held} / {resource.capacity}
                </span>
              </div>
              <Progress
                value={fraction(resource)}
                aria-label={`${resource.id} occupancy`}
                className="meter h-1.5 bg-muted *:data-[slot=progress-indicator]:bg-tone-active"
              />
              <Hint className="text-xs">
                {resource.holders.length === 0
                  ? 'idle'
                  : `held by ${resource.holders.join(', ')}`}
              </Hint>
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
    <Panel
      title="Gate queue"
      action={
        <span data-waiting>
          <Chip tone={queue.waiting > 0 ? 'wait' : 'idle'}>{queue.waiting} waiting</Chip>
        </span>
      }
    >
      {queue.holders.length === 0 ? (
        <EmptyNote>No gate held.</EmptyNote>
      ) : (
        <ul className="holders divide-y text-sm">
          {queue.holders.map((holder) => (
            <li
              key={`${holder.resource}:${holder.nodeId}`}
              data-holder={holder.nodeId}
              className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <span>
                <span className="font-mono text-xs font-medium">{holder.nodeId}</span> holds{' '}
                <span className="font-mono text-xs">{holder.resource}</span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {elapsed(holder.acquiredAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
    <Panel title="Harness capacity" description="A parked harness is throttled, not broken.">
      {harnesses.length === 0 ? (
        <EmptyNote>No harness in use.</EmptyNote>
      ) : (
        <ul className="harnesses divide-y">
          {harnesses.map((harness) => (
            <li
              key={harness.id}
              data-harness={harness.id}
              className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <span className="flex items-center gap-2.5">
                <span className="font-mono text-[13px]">{harness.id}</span>
                <span className="font-mono text-xs text-muted-foreground" data-inflight>
                  {harness.inFlight} / {harness.ceiling}
                </span>
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
    </Panel>
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
      <Panel title="Sessions and cost" data-rollup>
        <EmptyNote>Reading the run’s totals…</EmptyNote>
      </Panel>
    )
  }

  const { reuse, crew } = usage
  const share = cacheShare(usage.cache)
  const staffed = crew.members.length > 0 || crew.idle.length > 0

  return (
    <Panel
      title="Sessions and cost"
      description="Every figure sits behind its status."
      data-rollup
    >
      <DescriptionList>
        <DescriptionTerm>Reuse</DescriptionTerm>
        <DescriptionDetails data-reuse>
          {reuse.turns === 0
            ? // Not "0%": a pipeline that names no slots asked for no reuse,
              // and reporting that as a rate would read as a feature that broke.
              'No agent turn asked to continue a session.'
            : `${percent(reuse.reused / reuse.turns)} of ${reuse.turns} turns continued a session.`}
        </DescriptionDetails>

        <DescriptionTerm className="flex items-center gap-1">
          Cache
          <Explain label="How the cache share is calculated">
            <CacheExplanation cache={usage.cache} />
          </Explain>
        </DescriptionTerm>
        <DescriptionDetails data-cache>
          {share === undefined
            ? 'Not reported by this run’s harnesses.'
            : `${percent(share)} of prompt tokens served from cache${
                usage.cache.status === 'partial' ? ', across the sessions that reported' : ''
              }.`}
        </DescriptionDetails>

        <DescriptionTerm className="flex items-center gap-1">
          Tokens
          <Explain label="How tokens are counted">
            <TokensExplanation usage={usage} />
          </Explain>
        </DescriptionTerm>
        <DescriptionDetails className="font-mono text-xs" data-tokens>
          {compact(usage.inputTokens)} in · {compact(usage.outputTokens)} out ·{' '}
          {usage.sessions} {usage.sessions === 1 ? 'session' : 'sessions'}
        </DescriptionDetails>

        <DescriptionTerm className="flex items-center gap-1">
          Cost
          <Explain label="Where the cost comes from">
            <CostExplanation cost={usage.cost} sessions={usage.sessions} />
          </Explain>
        </DescriptionTerm>
        <DescriptionDetails className="font-mono text-xs" data-cost>
          {cost(usage.cost)}
        </DescriptionDetails>
      </DescriptionList>

      {staffed && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          {/* The roster against what it actually did. `substituted` is the
              number worth reading next to the cost above: a substitution always
              runs at or above the tier the plan budgeted for, so a run can be
              entirely green and still have been staffed dearer than planned.
              `warmReuse` is split out of it rather than folded in, because the
              two are answerable differently — a peer covering for a busy member
              costs what was planned, while a warm promotion is the scheduler
              deliberately buying a dearer model to avoid a cold start. Reported
              as "covered by a peer" alone, a run that promoted every phase to
              the top tier read as an ordinary busy wave. */}
          <Hint className="crew-head text-xs">
            Crew
            {crew.substituted > 0 &&
              ` — ${crew.substituted} of ${crew.asPlanned + crew.substituted} phases covered by a peer`}
            {crew.warmReuse > 0 && `, ${crew.warmReuse} to reuse a warm session`}
            {crew.promoted > 0 && (
              <span data-crew-promoted>
                {` — ${crew.promoted} ran above their planned tier`}
              </span>
            )}
          </Hint>
          <ul className="crew-members flex flex-col gap-1 text-xs">
            {crew.members.map((member) => (
              <li
                key={member.member}
                data-crew-member={member.member}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-muted-foreground">
                  {member.member} · tier {member.tier}
                </span>
                <span className="font-mono">
                  {member.nodes}
                  {member.coveredFor > 0 && ` (${member.coveredFor} covering)`}
                </span>
              </li>
            ))}
            {/* Only reachable on a run that stopped early — a validated
                workflow cannot declare a member nobody is assigned to — so
                this says "not reached yet", not "the plan overstaffed". */}
            {crew.idle.map((member) => (
              <li
                key={member}
                data-crew-idle={member}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-muted-foreground">{member}</span>
                <span className="font-mono">not reached</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reuse.fresh.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          {/* Labelled, because the tally is a column of bare numbers directly
              under a column of bare numbers. Without this it reads as more
              cost rows, and the reader has to infer what is being counted. */}
          <Hint className="fresh-head text-xs">Cold turns, by reason</Hint>
          <ul className="fresh-reasons flex flex-col gap-1 text-xs">
            {reuse.fresh.map((entry) => (
              <li
                key={entry.reason}
                data-fresh-reason={entry.reason}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-muted-foreground">{entry.reason.replaceAll('_', ' ')}</span>
                <span className="font-mono">{entry.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
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

/*
 * The explanations behind the rollup's info icons. Each states where its figure
 * comes from and then the exact counts it was built from — the row shows a
 * rounded figure, and an operator who doubts it has to be able to redo the sum.
 * They say nothing the daemon did not report, under the same rule as the rows.
 */

function TokensExplanation({ usage }: { readonly usage: RunUsageResponse }) {
  const { cache } = usage
  return (
    <>
      <p>
        Counted, not estimated. Each agent session — every implementer, fixer and chore turn —
        reports one token total when it ends, and this is the sum of those reports.
      </p>
      <p>
        <strong>In</strong> is the prompt the model processed fresh. Prompt tokens read from or
        written to the prompt cache are counted under Cache instead, so the full prompt was larger
        {cache.status === 'complete' && cache.promptTokens > 0
          ? `: ${exact(cache.promptTokens)} tokens in all.`
          : '.'}
      </p>
      <p>
        <strong>Out</strong> is what the model generated, reasoning and tool calls included.
      </p>
      <p className="font-mono" data-explain-tokens>
        {exact(usage.inputTokens)} in · {exact(usage.outputTokens)} out, over {usage.sessions}{' '}
        {usage.sessions === 1 ? 'session' : 'sessions'}
      </p>
      <p className="text-muted-foreground">
        A session still running is not in the total until it ends. Refreshed every{' '}
        {USAGE_REFRESH_MS / 1_000} seconds.
      </p>
    </>
  )
}

function CostExplanation({
  cost: total,
  sessions,
}: {
  readonly cost: RunUsageResponse['cost']
  readonly sessions: number
}) {
  return (
    <>
      <p>
        Maestro prices nothing itself. Each session’s harness reports its own dollar figure when it
        ends, and this is their sum.
      </p>
      <p>
        Claude Code and OpenCode report one, estimated from the session’s tokens at the model’s
        API list price. On a subscription plan that is what the work would cost at API rates, not
        what you are billed. Codex reports tokens only, so its sessions carry no cost — shown as
        not reported, never as $0.
      </p>
      <p className="font-mono" data-explain-cost>
        {sessions === 0
          ? 'No session has finished yet.'
          : total.status === 'complete'
            ? `All ${total.reportedSessions} sessions reported a cost, $${total.usd.toFixed(4)} in total.`
            : total.status === 'partial'
              ? `${total.reportedSessions} of ${total.reportedSessions + total.missingSessions} sessions reported a cost, $${total.usdSoFar.toFixed(4)} between them. The other ${total.missingSessions} cost an unknown amount more, so this is a lower bound.`
              : `None of the ${total.missingSessions} sessions reported a cost.`}
      </p>
    </>
  )
}

function CacheExplanation({ cache }: { readonly cache: RunUsageResponse['cache'] }) {
  return (
    <>
      <p>
        The share of prompt tokens served from the prompt cache rather than processed fresh: cache
        reads ÷ (fresh input + cache reads + cache writes). Cache reads are billed at a fraction of
        fresh input, so a higher share is a cheaper run.
      </p>
      <p className="font-mono" data-explain-cache>
        {cache.status === 'complete'
          ? `${exact(cache.readTokens)} read ÷ ${exact(cache.promptTokens)} prompt tokens (${exact(cache.writeTokens)} written to cache).`
          : cache.status === 'partial'
            ? `${exact(cache.readTokensSoFar)} read ÷ ${exact(cache.promptTokensSoFar)} prompt tokens (${exact(cache.writeTokensSoFar)} written), over the ${cache.reportedSessions} of ${cache.reportedSessions + cache.missingSessions} sessions that reported cache figures. The rest are left out of both sides rather than counted as misses.`
            : 'No session reported cache figures, so there is no share to state.'}
      </p>
    </>
  )
}

const exact = (tokens: number): string => tokens.toLocaleString('en-US')

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
