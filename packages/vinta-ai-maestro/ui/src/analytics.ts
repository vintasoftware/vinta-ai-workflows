/**
 * The folds behind the analytics page: the daemon serves one flat list of
 * activities, each tagged with its phase's staffing, and this is where the
 * browser filters it, buckets it and sums it. Pure, so it is tested without
 * a page around it.
 *
 * **Open rows are timed against `now`.** The daemon leaves `endedAt` null on
 * anything still in progress, and this module is what turns that into a
 * figure that moves — the page ticks and re-folds, which is the whole point
 * of showing this mid-run.
 *
 * **Steps partition working time; the rest is nested.** A gate runs inside
 * the `gate` or `verify` step, a chore inside `review` or `polish`, a merge
 * inside `integrate`. So the headline split is over *steps*, and gates,
 * chores and integration steps are reported as their own tables rather than
 * added to it — adding them would count the same minute twice.
 */
import type { RunAnalyticsResponse, WireActivity } from '../../src/daemon/schemas.ts'

export type Report = RunAnalyticsResponse
export type ReportNode = Report['nodes'][number]

export interface Filters {
  readonly node: string | null
  readonly wave: number | null
  readonly harness: string | null
  readonly crew: string | null
  readonly model: string | null
}

export const NO_FILTERS: Filters = { node: null, wave: null, harness: null, crew: null, model: null }

/** The headline buckets, in the order the pipeline runs them. */
export const BUCKETS = ['Implementation', 'Gates', 'Review', 'Polish', 'Integration'] as const
export type Bucket = (typeof BUCKETS)[number] | string

/**
 * The bucket a pipeline state falls into. `standard-phase`'s states by name;
 * a custom pipeline's states keep their own names, so nothing is hidden.
 */
export function bucketOf(step: string): Bucket {
  switch (step) {
    case 'implement':
    case 'fix':
      return 'Implementation'
    case 'gate':
    case 'verify':
      return 'Gates'
    case 'review':
    case 'unapproved':
      return 'Review'
    case 'polish':
      return 'Polish'
    case 'integrate':
      return 'Integration'
    default:
      return step
  }
}

export function durationOf(row: WireActivity, now: number): number {
  return Math.max(0, (row.endedAt ?? now) - row.startedAt)
}

export function matches(row: WireActivity, waves: ReadonlyMap<string, number>, filters: Filters): boolean {
  if (filters.node !== null && row.node !== filters.node) return false
  if (filters.wave !== null && waves.get(row.node) !== filters.wave) return false
  if (filters.harness !== null && row.harness !== filters.harness) return false
  if (filters.crew !== null && row.crew !== filters.crew) return false
  if (filters.model !== null && row.model !== filters.model) return false
  return true
}

export function nodeMatches(node: ReportNode, filters: Filters): boolean {
  if (filters.node !== null && node.nodeId !== filters.node) return false
  if (filters.wave !== null && node.wave !== filters.wave) return false
  if (filters.harness !== null && node.harness !== filters.harness) return false
  if (filters.crew !== null && node.crew !== filters.crew) return false
  if (filters.model !== null && node.model !== filters.model) return false
  return true
}

export interface Tally {
  readonly key: string
  readonly ms: number
  readonly count: number
  readonly slowestMs: number
  /** Rows still in progress. */
  readonly open: number
  /** Rows by outcome — `passed`, `failed`, `ran`, … */
  readonly outcomes: ReadonlyMap<string, number>
  /** Gate verdicts the cache served: counted in `count`, not in `ms`. */
  readonly cached: number
}

/** Sums rows under `keyOf`, keeping the order keys first appear. */
export function tally(rows: readonly WireActivity[], keyOf: (row: WireActivity) => string, now: number): Tally[] {
  const acc = new Map<string, { ms: number; count: number; slowestMs: number; open: number; outcomes: Map<string, number>; cached: number }>()
  for (const row of rows) {
    const key = keyOf(row)
    const held = acc.get(key) ?? { ms: 0, count: 0, slowestMs: 0, open: 0, outcomes: new Map(), cached: 0 }
    const ms = row.cached ? 0 : durationOf(row, now)
    held.ms += ms
    held.count += 1
    held.slowestMs = Math.max(held.slowestMs, ms)
    if (row.endedAt === null) held.open += 1
    if (row.cached) held.cached += 1
    if (row.outcome !== null) held.outcomes.set(row.outcome, (held.outcomes.get(row.outcome) ?? 0) + 1)
    acc.set(key, held)
  }
  return [...acc].map(([key, held]) => ({ key, ...held }))
}

/** The headline: working time by bucket, in pipeline order, custom states after. */
export function byBucket(rows: readonly WireActivity[], now: number): Tally[] {
  const tallies = tally(
    rows.filter((row) => row.kind === 'step'),
    (row) => bucketOf(row.id),
    now,
  )
  const rank = (key: string): number => {
    const index = (BUCKETS as readonly string[]).indexOf(key)
    return index === -1 ? BUCKETS.length : index
  }
  return tallies.sort((a, b) => rank(a.key) - rank(b.key) || b.ms - a.ms)
}

export type GroupBy = 'node' | 'wave' | 'harness' | 'crew' | 'model'

export interface GroupRow {
  readonly key: string
  readonly label: string
  readonly nodes: number
  /** Σ step time. */
  readonly workingMs: number
  readonly implementationMs: number
  readonly gatesMs: number
  readonly choresMs: number
  readonly integrationMs: number
  /** Lane queue + capacity wait + parked on a question, from the scheduling split. */
  readonly waitingMs: number
  readonly open: boolean
}

const groupKey = (groupBy: GroupBy, node: ReportNode): string => {
  switch (groupBy) {
    case 'node':
      return node.nodeId
    case 'wave':
      return String(node.wave)
    case 'harness':
      return node.harness
    case 'crew':
      return node.crew === null ? '—' : node.crew
    case 'model':
      return node.model
  }
}

const rowKey = (groupBy: GroupBy, row: WireActivity, waves: ReadonlyMap<string, number>): string => {
  switch (groupBy) {
    case 'node':
      return row.node
    case 'wave':
      return String(waves.get(row.node) ?? 0)
    case 'harness':
      return row.harness
    case 'crew':
      return row.crew === null ? '—' : row.crew
    case 'model':
      return row.model
  }
}

/** One row per group, the way the breakdown table draws it. */
export function groupRows(report: Report, filters: Filters, groupBy: GroupBy, now: number): GroupRow[] {
  const waves = new Map(report.nodes.map((node) => [node.nodeId, node.wave]))
  const nodes = report.nodes.filter((node) => nodeMatches(node, filters))
  const rows = report.activities.filter((row) => matches(row, waves, filters))
  const groups = new Map<string, GroupRow>()
  const labelOf = (key: string, node: ReportNode): string => {
    if (groupBy === 'node') return `${node.nodeId} · ${node.name}`
    if (groupBy === 'wave') return `wave ${key}`
    if (groupBy === 'crew' && node.crew !== null) return node.tier === null ? key : `${key} · tier ${node.tier}`
    return key
  }
  const ensure = (key: string, node: ReportNode): GroupRow => {
    const held = groups.get(key)
    if (held !== undefined) return held
    const fresh: GroupRow = {
      key,
      label: labelOf(key, node),
      nodes: 0,
      workingMs: 0,
      implementationMs: 0,
      gatesMs: 0,
      choresMs: 0,
      integrationMs: 0,
      waitingMs: 0,
      open: false,
    }
    groups.set(key, fresh)
    return fresh
  }
  for (const node of nodes) {
    const held = ensure(groupKey(groupBy, node), node)
    groups.set(held.key, {
      ...held,
      nodes: held.nodes + 1,
      waitingMs: held.waitingMs + node.split.laneQueueMs + node.split.capacityWaitMs + node.split.suspendedMs,
      open: held.open || node.inFlight,
    })
  }
  const byId = new Map(report.nodes.map((node) => [node.nodeId, node]))
  for (const row of rows) {
    const node = byId.get(row.node)
    if (node === undefined) continue
    const held = ensure(rowKey(groupBy, row, waves), node)
    const ms = row.cached ? 0 : durationOf(row, now)
    const bucket = row.kind === 'step' ? bucketOf(row.id) : null
    groups.set(held.key, {
      ...held,
      workingMs: held.workingMs + (row.kind === 'step' ? ms : 0),
      implementationMs: held.implementationMs + (bucket === 'Implementation' ? ms : 0),
      gatesMs: held.gatesMs + (row.kind === 'gate' ? ms : 0),
      choresMs: held.choresMs + (row.kind === 'chore' ? ms : 0),
      integrationMs: held.integrationMs + (bucket === 'Integration' ? ms : 0),
    })
  }
  return [...groups.values()].sort((a, b) => b.workingMs - a.workingMs)
}

/** The distinct values a filter can take, in first-seen order. */
export function options(report: Report): {
  readonly harnesses: string[]
  readonly crews: string[]
  readonly models: string[]
  readonly waves: number[]
} {
  const harnesses = new Set<string>()
  const crews = new Set<string>()
  const models = new Set<string>()
  const waves = new Set<number>()
  for (const node of report.nodes) {
    harnesses.add(node.harness)
    if (node.crew !== null) crews.add(node.crew)
    models.add(node.model)
    waves.add(node.wave)
  }
  for (const row of report.activities) {
    harnesses.add(row.harness)
    if (row.crew !== null) crews.add(row.crew)
    models.add(row.model)
  }
  return {
    harnesses: [...harnesses],
    crews: [...crews],
    models: [...models],
    waves: [...waves].sort((a, b) => a - b),
  }
}

/** Σ over the filtered nodes of one bucket of the scheduling split. */
export function waitingSplit(
  report: Report,
  filters: Filters,
): { readonly laneQueueMs: number; readonly capacityWaitMs: number; readonly suspendedMs: number } {
  let laneQueueMs = 0
  let capacityWaitMs = 0
  let suspendedMs = 0
  for (const node of report.nodes) {
    if (!nodeMatches(node, filters)) continue
    laneQueueMs += node.split.laneQueueMs
    capacityWaitMs += node.split.capacityWaitMs
    suspendedMs += node.split.suspendedMs
  }
  return { laneQueueMs, capacityWaitMs, suspendedMs }
}
