/**
 * Where the run's time is going (§13.3), while it is still going.
 *
 * Two surfaces over one read (`GET /api/runs/:id/analytics`):
 *
 * - **`TimePanel`** on the run view: the headline split of working time —
 *   implementation, gates, review, polish, integration — as one bar, the
 *   waiting time under it, and the way to the page.
 * - **`AnalyticsView`** at `#/runs/:id/analytics`: the same split under
 *   filters (phase, wave, harness, crew member, model), a breakdown table
 *   grouped by any of those, what each gate and each chore cost, the critical
 *   path, and — once the run has ended — the post-mortem (`Report.tsx`), which
 *   is the diagnosis the next plan is built from.
 *
 * **Everything live is a floor.** The daemon reports open activities with no
 * end; this page ticks once a second and times them against its own clock,
 * so the figures move with the run. The read itself is slow (every fifteen
 * seconds, and when a frame lands): two folds over the whole journal is not
 * something to do per event.
 *
 * Nothing here estimates. A figure the journal cannot supply is reported as a
 * gap (`report.gaps`), the way `analytics.ts` reports it, and the page says
 * so rather than printing zero.
 */
import { BarChart3Icon, ChevronLeftIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderMeta,
  PageHeaderTitle,
} from 'vinta-design-system/layout'
import { Badge } from 'vinta-design-system/ui/badge'
import { Button } from 'vinta-design-system/ui/button'
import { NativeSelect, NativeSelectOption } from 'vinta-design-system/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'vinta-design-system/ui/table'
import type { PostMortem } from '../../src/postmortem/postmortem.ts'
import {
  byBucket,
  groupRows,
  matches,
  NO_FILTERS,
  options,
  tally,
  waitingSplit,
  type Filters,
  type GroupBy,
  type Report,
  type Tally,
} from './analytics.ts'
import { Chip } from './Chip.tsx'
import type { Client } from './client.ts'
import { EmptyNote, ErrorNote, Hint, Panel } from './Panel.tsx'
import { ReportView } from './Report.tsx'
import { Segmented } from './Segmented.tsx'
import { runTone } from './status.ts'
import { duration, elapsed, useNow } from './time.ts'
import { useRun } from './useRun.ts'

/** How often the report is re-read. Two folds over the whole journal. */
const REFRESH_MS = 15_000

/** The bar's colours, one per headline bucket; a custom state takes the idle tone. */
const BUCKET_CLASS: Readonly<Record<string, string>> = {
  Implementation: 'bg-tone-active',
  Gates: 'bg-tone-wait',
  Review: 'bg-tone-attention',
  Polish: 'bg-tone-ok',
  Integration: 'bg-primary/60',
}

const bucketClass = (key: string): string => BUCKET_CLASS[key] ?? 'bg-tone-idle'

function useReport(client: Client, runId: string, cursor: number): { report: Report | null; error: string | null } {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tick = useNow(REFRESH_MS)
  useEffect(() => {
    let stopped = false
    client.analytics(runId).then(
      (next) => {
        if (stopped) return
        setReport(next)
        setError(null)
      },
      (cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : 'the daemon could not be reached')
      },
    )
    return () => {
      stopped = true
    }
  }, [client, runId, cursor, tick])
  return { report, error }
}

/**
 * The post-mortem, read once the run has ended and re-read until it exists:
 * the file is written moments after `run_ended`, so the first read after the
 * end can honestly come back empty.
 */
function usePostMortem(client: Client, runId: string, ended: boolean): PostMortem | null | undefined {
  const [report, setReport] = useState<PostMortem | null | undefined>(undefined)
  const tick = useNow(REFRESH_MS)
  useEffect(() => {
    if (!ended || (report !== undefined && report !== null)) return
    let stopped = false
    client.postmortem(runId).then(
      (next) => {
        if (!stopped) setReport(next)
      },
      () => {
        if (!stopped) setReport(null)
      },
    )
    return () => {
      stopped = true
    }
  }, [client, runId, ended, tick, report])
  return ended ? report : undefined
}

// ---------------------------------------------------------------------------
// The run view's panel
// ---------------------------------------------------------------------------

export function TimePanel({ client, runId, ended }: { readonly client: Client; readonly runId: string; readonly ended: boolean }) {
  const { report } = useReport(client, runId, 0)
  const now = useNow()
  const href = `#/runs/${encodeURIComponent(runId)}/analytics`

  return (
    <Panel
      title="Where the time goes"
      description={ended ? 'Working time by what it was spent on.' : 'Working time by what it is being spent on, so far.'}
      data-time-panel
      fill
      action={
        <Button asChild variant="ghost" size="xs">
          <a href={href} data-action="open-analytics">
            <BarChart3Icon aria-hidden="true" />
            {ended ? 'Report' : 'Analytics'}
          </a>
        </Button>
      }
    >
      {report === null ? (
        <EmptyNote>Reading the run’s timings…</EmptyNote>
      ) : (
        <TimeSplit report={report} filters={NO_FILTERS} now={report.partial ? now : report.asOf} compact />
      )}
    </Panel>
  )
}

/** The bar and its legend, then the waiting buckets under it. */
function TimeSplit({
  report,
  filters,
  now,
  compact = false,
}: {
  readonly report: Report
  readonly filters: Filters
  readonly now: number
  readonly compact?: boolean
}) {
  const waves = useMemo(() => new Map(report.nodes.map((node) => [node.nodeId, node.wave])), [report])
  const rows = report.activities.filter((row) => matches(row, waves, filters))
  const buckets = byBucket(rows, now)
  const total = buckets.reduce((sum, bucket) => sum + bucket.ms, 0)
  const waiting = waitingSplit(report, filters)
  const waited = waiting.laneQueueMs + waiting.capacityWaitMs + waiting.suspendedMs

  if (total === 0 && waited === 0) return <EmptyNote>No phase has started working yet.</EmptyNote>

  return (
    <div className="flex flex-col gap-3" data-time-split>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Working time by bucket">
        {buckets.map((bucket) => (
          <span
            key={bucket.key}
            className={bucketClass(bucket.key)}
            style={{ width: `${total === 0 ? 0 : (bucket.ms / total) * 100}%` }}
            title={`${bucket.key}: ${duration(bucket.ms)}`}
          />
        ))}
      </div>
      {/* Compact (the run view's cell): one bucket per line, figure at the
          far end, so five buckets read as a column and never wrap. */}
      <ul className={compact ? 'flex flex-col gap-0.5 text-xs' : 'flex flex-wrap gap-x-5 gap-y-1 text-[13px]'}>
        {buckets.map((bucket) => (
          <li
            key={bucket.key}
            className={compact ? 'flex items-center gap-1.5' : 'flex items-center gap-1.5'}
            data-bucket={bucket.key}
          >
            <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${bucketClass(bucket.key)}`} />
            <span className={compact ? 'flex-1 truncate text-muted-foreground' : 'text-muted-foreground'}>{bucket.key}</span>
            {bucket.open > 0 && <LoaderCircleIcon aria-label="in progress" className="size-3 shrink-0 animate-spin text-tone-active" />}
            <span className="font-mono tabular-nums" data-bucket-ms>
              {duration(bucket.ms)}
            </span>
            {total > 0 && (
              <span className="w-8 text-right text-muted-foreground tabular-nums">{Math.round((bucket.ms / total) * 100)}%</span>
            )}
          </li>
        ))}
      </ul>
      <Hint className="text-xs" data-waiting-split>
        Working {duration(total)}
        {waited > 0 && (
          <>
            {' · '}waiting {duration(waited)}
            {' — '}
            {[
              waiting.laneQueueMs > 0 ? `${duration(waiting.laneQueueMs)} for a lane` : null,
              waiting.capacityWaitMs > 0 ? `${duration(waiting.capacityWaitMs)} on capacity` : null,
              waiting.suspendedMs > 0 ? `${duration(waiting.suspendedMs)} on a person` : null,
            ]
              .filter((part) => part !== null)
              .join(', ')}
          </>
        )}
        {report.partial && ' · so far'}
      </Hint>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function AnalyticsView({ client, runId }: { readonly client: Client; readonly runId: string }) {
  const { snapshot, projection } = useRun(client, runId)
  const { report, error } = useReport(client, runId, projection.cursor)
  const liveNow = useNow()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [groupBy, setGroupBy] = useState<GroupBy>('node')
  const ended = report !== null && !report.partial
  const postmortem = usePostMortem(client, runId, ended)
  const now = report === null || report.partial ? liveNow : report.asOf
  const status = projection.runStatus ?? report?.status ?? snapshot?.run.status ?? 'running'

  const waves = useMemo(() => new Map((report?.nodes ?? []).map((node) => [node.nodeId, node.wave])), [report])
  const choices = useMemo(() => (report === null ? null : options(report)), [report])
  const rows = useMemo(
    () => (report === null ? [] : report.activities.filter((row) => matches(row, waves, filters))),
    [report, waves, filters],
  )
  const gates = tally(
    rows.filter((row) => row.kind === 'gate'),
    (row) => row.id,
    now,
  ).sort((a, b) => b.ms - a.ms)
  const chores = tally(
    rows.filter((row) => row.kind === 'chore'),
    (row) => row.id,
    now,
  ).sort((a, b) => b.ms - a.ms)
  const groups = report === null ? [] : groupRows(report, filters, groupBy, now)
  const filtered = filters !== NO_FILTERS && Object.values(filters).some((value) => value !== null)

  const set = <K extends keyof Filters>(key: K, value: Filters[K]): void =>
    setFilters((current) => ({ ...current, [key]: value }))

  return (
    <section className="run analytics flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <a
          href={`#/runs/${encodeURIComponent(runId)}`}
          className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground hover:no-underline"
        >
          <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
          Back to run
        </a>
        <PageHeader className="run-head">
          <PageHeaderHeading>
            <PageHeaderTitle>
              {ended ? 'Report' : 'Analytics'} · {snapshot?.run.workflowId ?? runId}
            </PageHeaderTitle>
            <PageHeaderMeta>
              <span>{runId}</span>
              {report !== null && (
                <span data-elapsed>
                  {report.partial ? elapsed(report.startedAt, liveNow) : elapsed(report.startedAt, report.asOf)} elapsed
                </span>
              )}
              {report?.partial === true && <span>figures are floors, refreshed every {REFRESH_MS / 1_000}s</span>}
            </PageHeaderMeta>
          </PageHeaderHeading>
          <PageHeaderActions className="run-meta">
            <Chip tone={runTone(status)}>{status}</Chip>
          </PageHeaderActions>
        </PageHeader>
      </div>

      {error !== null && report === null && <ErrorNote>{error}</ErrorNote>}
      {report === null && error === null && <EmptyNote>Reading the run’s timings…</EmptyNote>}

      {report !== null && (
        <>
          {ended && (
            <ReportView
              report={postmortem}
              runId={runId}
              status={report.status}
            />
          )}

          <Panel title="Filters" description="Every figure below is over the phases and activities these match." data-filters>
            <div className="flex flex-wrap items-end gap-3 text-[13px]">
              <Filter label="Phase" value={filters.node} onChange={(value) => set('node', value)} data-filter="node">
                {report.nodes.map((node) => (
                  <NativeSelectOption key={node.nodeId} value={node.nodeId}>
                    {node.nodeId} · {node.name}
                  </NativeSelectOption>
                ))}
              </Filter>
              <Filter
                label="Wave"
                value={filters.wave === null ? null : String(filters.wave)}
                onChange={(value) => set('wave', value === null ? null : Number(value))}
                data-filter="wave"
              >
                {(choices?.waves ?? []).map((wave) => (
                  <NativeSelectOption key={wave} value={String(wave)}>
                    wave {wave}
                  </NativeSelectOption>
                ))}
              </Filter>
              <Filter label="Harness" value={filters.harness} onChange={(value) => set('harness', value)} data-filter="harness">
                {(choices?.harnesses ?? []).map((harness) => (
                  <NativeSelectOption key={harness} value={harness}>
                    {harness}
                  </NativeSelectOption>
                ))}
              </Filter>
              <Filter label="Crew member" value={filters.crew} onChange={(value) => set('crew', value)} data-filter="crew">
                {(choices?.crews ?? []).map((crew) => (
                  <NativeSelectOption key={crew} value={crew}>
                    {crew}
                  </NativeSelectOption>
                ))}
              </Filter>
              <Filter label="Model" value={filters.model} onChange={(value) => set('model', value)} data-filter="model">
                {(choices?.models ?? []).map((model) => (
                  <NativeSelectOption key={model} value={model}>
                    {model}
                  </NativeSelectOption>
                ))}
              </Filter>
              {filtered && (
                <Button type="button" variant="ghost" size="sm" data-action="clear-filters" onClick={() => setFilters(NO_FILTERS)}>
                  Clear
                </Button>
              )}
            </div>
          </Panel>

          <Panel
            title="Where the time goes"
            description="Working time by pipeline step. Gates, chores and the merge run inside a step, so they are below rather than added here."
            data-time-panel
          >
            <TimeSplit report={report} filters={filters} now={now} />
          </Panel>

          <Panel
            title="Breakdown"
            description="One row per group. Waiting is lane queue, capacity windows and time parked on a person."
            data-breakdown
            contentClassName="px-0"
          >
            {/* In the content rather than the header's action slot: five tabs
                beside the title is wider than a phone, and here the row has
                the panel's whole width to scroll in. */}
            <div className="px-4">
              <Segmented<GroupBy>
                label="Group by"
                size="sm"
                className="w-fit max-w-full"
                value={groupBy}
                onChange={setGroupBy}
                options={[
                  { value: 'node', label: 'Phase' },
                  { value: 'wave', label: 'Wave' },
                  { value: 'harness', label: 'Harness' },
                  { value: 'crew', label: 'Crew' },
                  { value: 'model', label: 'Model' },
                ]}
              />
            </div>
            {groups.length === 0 ? (
              <EmptyNote className="px-4">Nothing matches.</EmptyNote>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">{GROUP_LABELS[groupBy]}</TableHead>
                    {groupBy !== 'node' && <TableHead className="text-right">Phases</TableHead>}
                    <TableHead className="text-right">Working</TableHead>
                    <TableHead className="text-right">Implementation</TableHead>
                    <TableHead className="text-right">Gates</TableHead>
                    <TableHead className="text-right">Chores</TableHead>
                    <TableHead className="text-right">Integration</TableHead>
                    <TableHead className="pr-4 text-right">Waiting</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((group) => (
                    <TableRow key={group.key} data-group={group.key}>
                      <TableCell className="min-w-44 whitespace-normal pl-4 font-medium">
                        {groupBy === 'node' ? (
                          <a href={`#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(group.key)}`}>{group.label}</a>
                        ) : (
                          group.label
                        )}
                        {group.open && <LoaderCircleIcon aria-label="in progress" className="ml-2 inline size-3 animate-spin text-tone-active" />}
                      </TableCell>
                      {groupBy !== 'node' && <Num>{group.nodes}</Num>}
                      <Num data-working>{duration(group.workingMs)}</Num>
                      <Num>{duration(group.implementationMs)}</Num>
                      <Num>{duration(group.gatesMs)}</Num>
                      <Num>{duration(group.choresMs)}</Num>
                      <Num>{duration(group.integrationMs)}</Num>
                      <Num className="pr-4">{duration(group.waitingMs)}</Num>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TallyPanel
              title="Gates"
              description="What each gate cost, over every phase and fix round. Cached verdicts are counted, not timed."
              rows={gates}
              empty="No gate has run under these filters."
              data-gates-table=""
              outcomes={['passed', 'failed', 'timed_out']}
            />
            <TallyPanel
              title="Chores"
              description="Review, polish and after-PR chores, each timed by its own clock."
              rows={chores}
              empty="No chore has finished under these filters. A chore is timed when it ends."
              data-chores-table=""
              outcomes={['ran', 'failed', 'skipped']}
            />
          </div>

          <CriticalPath report={report} runId={runId} now={now} />

          {report.gaps.length > 0 && (
            <Hint data-gaps className="flex flex-wrap items-center gap-1.5">
              <span>Not measured, so not claimed:</span>
              {report.gaps.map((gap) => (
                <Badge key={gap.kind} variant="outline" className="muted cursor-help" title={gap.needs}>
                  {gap.kind.replaceAll('_', ' ')}
                </Badge>
              ))}
            </Hint>
          )}
        </>
      )}
    </section>
  )
}

const GROUP_LABELS: Readonly<Record<GroupBy, string>> = {
  node: 'Phase',
  wave: 'Wave',
  harness: 'Harness',
  crew: 'Crew member',
  model: 'Model',
}

function Filter({
  label,
  value,
  onChange,
  children,
  ...attributes
}: {
  readonly label: string
  readonly value: string | null
  readonly onChange: (value: string | null) => void
  readonly children: ReactNode
  readonly [attribute: `data-${string}`]: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <NativeSelect
        size="sm"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        {...attributes}
      >
        <NativeSelectOption value="">All</NativeSelectOption>
        {children}
      </NativeSelect>
    </label>
  )
}

function Num({ className, children, ...props }: { readonly className?: string; readonly children: ReactNode; readonly [attribute: `data-${string}`]: string | undefined }) {
  return (
    <TableCell className={`text-right font-mono text-xs tabular-nums ${className ?? ''}`} {...props}>
      {children}
    </TableCell>
  )
}

function TallyPanel({
  title,
  description,
  rows,
  empty,
  outcomes,
  ...attributes
}: {
  readonly title: string
  readonly description: string
  readonly rows: readonly Tally[]
  readonly empty: string
  readonly outcomes: readonly string[]
  readonly [attribute: `data-${string}`]: string
}) {
  return (
    <Panel title={title} description={description} contentClassName="px-0" bounded fill {...attributes}>
      {rows.length === 0 ? (
        <EmptyNote className="px-4">{empty}</EmptyNote>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Id</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Slowest</TableHead>
              <TableHead className="pr-4">Outcomes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} data-tally={row.key}>
                <TableCell className="pl-4 font-mono text-xs font-medium">
                  {row.key}
                  {row.open > 0 && <LoaderCircleIcon aria-label="in progress" className="ml-2 inline size-3 animate-spin text-tone-active" />}
                </TableCell>
                <Num>
                  {row.count}
                  {row.cached > 0 && <span className="text-muted-foreground"> ({row.cached} cached)</span>}
                </Num>
                <Num data-tally-ms>{duration(row.ms)}</Num>
                <Num>{duration(row.slowestMs)}</Num>
                <TableCell className="pr-4 text-xs text-muted-foreground">
                  {outcomes
                    .filter((outcome) => (row.outcomes.get(outcome) ?? 0) > 0)
                    .map((outcome) => `${row.outcomes.get(outcome)} ${outcome.replaceAll('_', ' ')}`)
                    .join(' · ') || '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}

/** The chain that set the elapsed time, with the gaps between hops reported rather than hidden. */
function CriticalPath({ report, runId, now }: { readonly report: Report; readonly runId: string; readonly now: number }) {
  if (report.criticalPath.length === 0) return null
  return (
    <Panel
      title="Critical path"
      description="The dependency chain the elapsed time followed. Shortening a phase off this list changes nothing."
      data-critical-path
      bounded
    >
      <ol className="flex flex-col divide-y text-[13px]">
        {report.criticalPath.map((step) => (
          <li key={step.nodeId} className="flex items-center gap-3 py-1.5" data-path-node={step.nodeId}>
            <a className="font-mono text-xs font-medium" href={`#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(step.nodeId)}`}>
              {step.nodeId}
            </a>
            <span className="text-xs text-muted-foreground">wave {step.wave}</span>
            <span className="flex-1" />
            {step.gapMs > 0 && <span className="text-xs text-muted-foreground">after {duration(step.gapMs)} idle</span>}
            <span className="font-mono text-xs tabular-nums">
              {duration(Math.max(0, (report.partial && step.endsAt === report.asOf ? now : step.endsAt) - step.startedAt))}
            </span>
          </li>
        ))}
      </ol>
      <Hint className="text-xs">
        Lanes idle {Math.round(report.laneIdleness.idleFraction * 100)}% of the time
        {report.laneIdleness.capacity > 0 && ` across ${report.laneIdleness.capacity} ${report.laneIdleness.capacity === 1 ? 'lane' : 'lanes'}`}
        {report.tailGapMs > 0 && ` · ${duration(report.tailGapMs)} after the last hop`}.
      </Hint>
    </Panel>
  )
}
