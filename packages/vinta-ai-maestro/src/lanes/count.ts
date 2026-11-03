/**
 * How many worktrees a run puts on disk — one answer, read by every place that
 * sizes or explains the pool.
 *
 * There used to be three answers. The doctor charged `capacity + 1`, the pool
 * provisioned one worktree per crew member plus the integration worktree, and
 * the refusal line said `capacity` lanes whatever the pool had counted. They
 * agree only for an unstaffed workflow on a fresh run. A roster of six on a
 * capacity of three provisions seven worktrees while the doctor weighed four,
 * `max_spare_crew` adds desks mid-run that nobody weighed at all, and a resume
 * that adopts every worktree on disk was refused by a doctor charging for all
 * of them again while the pool, correctly, checked for none.
 *
 * Capacity bounds how many phases run at once, never how many worktrees exist:
 * a staffed run gives every member a desk for the whole run (`provision` in
 * `run/host.ts`), and a desk is a worktree whether or not its member is busy.
 */
import { roster } from '../scheduler/crew.ts'
import type { Workflow } from '../types.ts'

type Staffing = Pick<Workflow, 'crew' | 'resources'> & {
  readonly defaults: Pick<Workflow['defaults'], 'max_spare_crew'>
}

/**
 * The pool's own lane worktrees: one per crew member on a staffed run, else
 * one per unit of lane capacity. The scheduler names its slots from the same
 * roster, so these are the directories its nodes will be handed.
 */
export function laneNames(workflow: Pick<Workflow, 'crew' | 'resources'>, runId: string): string[] {
  const crew = roster(workflow.crew)
  if (crew.length > 0) return crew.map((member, i) => `${runId}-crew-${i + 1}-${member.id}`)
  const capacity = workflow.resources['lane']?.capacity ?? 1
  return Array.from({ length: capacity }, (_, i) => `${runId}-lane-${i + 1}`)
}

export const integrationName = (runId: string): string => `${runId}-integ`

export interface WorktreeCount {
  /** Lane worktrees provisioned up front. */
  readonly lanes: number
  /** Always one; spelled out so a sentence built from this names it. */
  readonly integration: 1
  /**
   * Desks a run may add mid-run for spare crew (`defaults.max_spare_crew`).
   * Headroom, not a promise: the scheduler takes one on only when a planned
   * member is busy. Zero on an unstaffed run, which has no member to copy.
   */
  readonly spares: number
  /** Up-front worktrees already on disk that a resume takes over. */
  readonly adopted: number
  /** Every worktree the run can end up with. */
  readonly total: number
  /** The ones that will cost new disk: `total` less `adopted`. */
  readonly creating: number
}

export function countWorktrees(input: {
  readonly lanes: number
  readonly spares?: number
  readonly adopted?: number
}): WorktreeCount {
  const spares = input.spares ?? 0
  const total = input.lanes + 1 + spares
  // Bounded by the up-front worktrees: a spare's desk is never adopted at
  // provision time, because the scheduler of a resumed run starts with no
  // spares and may take on different ones.
  const adopted = Math.min(input.adopted ?? 0, input.lanes + 1)
  return { lanes: input.lanes, integration: 1, spares, adopted, total, creating: total - adopted }
}

/** Spare-crew headroom for a workflow: none without a roster to copy a member from. */
export function spareHeadroom(workflow: Staffing): number {
  return roster(workflow.crew).length === 0 ? 0 : workflow.defaults.max_spare_crew
}

/** `countWorktrees` for a workflow, with `adopted` of its up-front worktrees already on disk. */
export function worktreeCount(workflow: Staffing, adopted = 0): WorktreeCount {
  return countWorktrees({
    lanes: laneNames(workflow, '').length,
    spares: spareHeadroom(workflow),
    adopted,
  })
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The count as an operator reads it: `3 lanes + 1 integration worktree + 2
 * spare-crew worktrees (4 already on disk)`. Shared by the doctor's disk line,
 * the pool's progress line and the refusal, so the three never describe
 * different pools.
 */
export function describeWorktrees(count: WorktreeCount): string {
  const parts = [plural(count.lanes, 'lane'), '1 integration worktree']
  if (count.spares > 0) parts.push(plural(count.spares, 'spare-crew worktree'))
  const onDisk = count.adopted === 0 ? '' : ` (${count.adopted} already on disk)`
  return `${parts.join(' + ')}${onDisk}`
}

/** What shrinks the pool, for a remedy line. */
export function shrinkRemedy(workflow: Pick<Workflow, 'crew'>): string {
  return roster(workflow.crew).length === 0
    ? 'lower resources.lane.capacity in the workflow'
    : 'staff a smaller crew or lower defaults.max_spare_crew in the workflow'
}
