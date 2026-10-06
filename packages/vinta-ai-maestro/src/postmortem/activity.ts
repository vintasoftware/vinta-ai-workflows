/**
 * What a run did to itself and what was done to it, read off the journal for
 * the post-mortem.
 *
 * The post-mortem was written to describe the *plan*: its dependencies, its
 * waves, its gates. One 34-hour run showed how little that says about the
 * *run*. Its post-mortem reported no conflicts, no interventions and no
 * missing dependencies, while its journal held 16 conflicts, 3 amendments, 8
 * operator operations, 485 failed attempts — one setup failure repeated up to
 * 48 times on one phase — 861 questions, and 73 phases staffed above the
 * tier their plan named. `plan-feature` reads these files to draw the next
 * plan, and a quiet post-mortem teaches it that the last one went fine.
 *
 * Everything here is folded from journal events, not from what the host held
 * in memory: an integrator's wave results die with the process, and this run
 * restarted three times.
 *
 * Ids, counts, tiers, model ids and the scheduler's own failure reasons — the
 * same identifiers-only reasons `node_error` carries (§11), bounded here.
 */
import { z } from 'zod'

import type { StoredEvent } from '../journal/events.ts'

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case')
  .min(1)

/** A failure reason as the post-mortem carries it: the scheduler's sentence, bounded. */
export const REASON_LIMIT = 300

export const FailureCauseSchema = z
  .strictObject({
    reason: z.string().max(REASON_LIMIT).describe('The scheduler’s recorded reason, verbatim up to 300 characters.'),
    setup: z
      .boolean()
      .describe(
        'Whether these attempts failed before any agent ran — provisioning, a base merge, a ' +
          'checkout. The machinery’s failure rather than the work’s, and the kind a plan cannot fix ' +
          'but a project configuration can.',
      ),
    attempts: z.number().int().min(1).describe('Attempts that failed with this reason, across every phase.'),
    nodes: z.array(Id).min(1).describe('The phases it hit.'),
  })
  .describe('One cause of failed attempts, and what it cost: the run’s retries, grouped.')

export const CrewSubstitutionSchema = z
  .strictObject({
    node: Id,
    planned: z.string().min(1).describe('The member the plan named.'),
    planned_tier: z.number().int().optional().describe('Their tier. Absent on rows written before it was recorded.'),
    member: z.string().min(1).describe('Who ran it instead.'),
    tier: z.number().int(),
    model: z.string().optional().describe('The model that member ran on, from the roster.'),
    reason: z
      .enum(['peer_busy', 'warm_session'])
      .describe('`peer_busy`: the planned member was working. `warm_session`: promoted to reuse an open session.'),
    attempts: z.number().int().min(1).describe('Attempts this member took the phase for.'),
    above_plan: z.boolean().describe('Whether this ran at a higher tier than the plan named — dearer than budgeted.'),
    node_cost_usd: z
      .number()
      .min(0)
      .optional()
      .describe('What the whole phase cost, every attempt and member included, when its harness reported cost.'),
  })
  .describe('A phase run by somebody other than the member its plan named.')

export const ConflictWhereSchema = z.enum(['base', 'wave'])

export const OperationsSchema = z
  .strictObject({
    amendments: z
      .array(
        z.strictObject({
          amendment: z.number().int().min(1),
          at_ms: z.number().int(),
          author: z.enum(['operator', 'monitor', 'coordinator', 'config']),
        }),
      )
      .describe('Every change to the run’s definition while it ran, whoever made it.'),
    node_operations: z
      .array(
        z.strictObject({
          node: Id,
          op: z.enum(['add_context', 'redirect', 'pause', 'abort']),
          by: z.enum(['operator', 'coordinator']),
          count: z.number().int().min(1),
        }),
      )
      .describe('Steering, pauses and aborts, per phase.'),
    questions: z
      .strictObject({
        asked: z.number().int().min(0),
        by_operator: z.number().int().min(0),
        unattended: z.number().int().min(0).describe('Answered by a `--retry-after` timer.'),
        by_coordinator: z.number().int().min(0),
        unanswered: z.number().int().min(0),
      })
      .describe('Every question a phase was parked on, and who answered it.'),
    exec_runs: z
      .array(
        z.strictObject({
          target: z.string().min(1),
          by: z.enum(['operator', 'coordinator']),
          count: z.number().int().min(1),
          failed: z.number().int().min(0),
        }),
      )
      .describe('Commands run by hand in a lane or the integration worktree (`vinta-ai-maestro exec`).'),
  })
  .describe(
    'What was done to the run while it ran, by a person or its coordinator. Repairs made outside ' +
      'maestro — a wave branch rebuilt in another checkout — leave no record and are not counted.',
  )

export const CrossPhaseFailureSchema = z
  .strictObject({
    wave: z.number().int().min(1),
    gate: Id,
    members: z.array(Id).min(1).describe('The phases merged in that wave.'),
    at_ms: z.number().int(),
    exit_code: z.number().int(),
  })
  .describe(
    'A gate that every phase passed on its own branch and that failed on the merged wave: two ' +
      'of `members` (or one of them and an earlier wave) disagree. The evidence of a missing ' +
      'dependency or a missing contract test that `missing_dependencies`’ ordering cannot see.',
  )

export type FailureCause = z.infer<typeof FailureCauseSchema>
export type CrewSubstitution = z.infer<typeof CrewSubstitutionSchema>
export type Operations = z.infer<typeof OperationsSchema>
export type CrossPhaseFailure = z.infer<typeof CrossPhaseFailureSchema>

export interface JournalConflict {
  readonly where: 'base' | 'wave'
  readonly wave: number
  readonly nodes: readonly string[]
  readonly paths: readonly string[]
  readonly rounds: number
}

type Payload = Record<string, unknown>
const payloadOf = (event: StoredEvent): Payload => (event.payload ?? {}) as Payload
const nodeOf = (event: StoredEvent): string | null => ('nodeId' in event ? (event.nodeId as string | null) : null)

/**
 * Every conflict the integrator settled — base merges as well as wave merges.
 * A base conflict is two of a phase's dependencies fighting while its
 * `integ-` base was built, which is the same "these should not have been
 * parallel" signal a wave conflict is, a wave earlier.
 */
export function journalConflicts(
  events: readonly StoredEvent[],
  waveOf: (nodeId: string) => number,
): readonly JournalConflict[] {
  const found: JournalConflict[] = []
  for (const event of events) {
    if (event.type !== 'node_conflict') continue
    const payload = payloadOf(event)
    const where = payload['where'] === 'base' ? 'base' : 'wave'
    const branch = typeof payload['branch'] === 'string' ? payload['branch'] : ''
    const waveMatch = /wave-(\d+)$/.exec(branch)
    const node = nodeOf(event)
    const wave =
      where === 'wave' && waveMatch !== null ? Number(waveMatch[1]) : node === null ? 1 : waveOf(node)
    found.push({
      where,
      wave: Math.max(1, wave),
      nodes: [...new Set((payload['nodes'] as string[] | undefined) ?? [])],
      paths: [...((payload['paths'] as string[] | undefined) ?? [])],
      rounds: typeof payload['rounds'] === 'number' ? payload['rounds'] : 0,
    })
  }
  return found
}

/** Failed attempts grouped by reason, most expensive first. */
export function failureCauses(events: readonly StoredEvent[]): FailureCause[] {
  const causes = new Map<string, { reason: string; setup: boolean; attempts: number; nodes: Set<string> }>()
  for (const event of events) {
    if (event.type !== 'node_error') continue
    const node = nodeOf(event)
    if (node === null) continue
    const payload = payloadOf(event)
    const reason = bounded(typeof payload['reason'] === 'string' ? payload['reason'] : 'no reason recorded')
    const setup = payload['setup'] === true
    const key = `${setup ? 'setup' : 'work'}\u0000${reason}`
    const entry = causes.get(key) ?? { reason, setup, attempts: 0, nodes: new Set<string>() }
    entry.attempts += 1
    entry.nodes.add(node)
    causes.set(key, entry)
  }
  return [...causes.values()]
    .map((entry) => ({ reason: entry.reason, setup: entry.setup, attempts: entry.attempts, nodes: [...entry.nodes].sort() }))
    .sort((a, b) => b.attempts - a.attempts || a.reason.localeCompare(b.reason))
}

/** Substitutions, one entry per phase, member and reason. */
export function crewSubstitutions(
  events: readonly StoredEvent[],
  crew: Readonly<Record<string, { readonly tier: number; readonly model: string }>>,
  nodeCostUsd?: (nodeId: string) => number | null,
): CrewSubstitution[] {
  const found = new Map<string, Omit<CrewSubstitution, 'node_cost_usd'>>()
  for (const event of events) {
    if (event.type !== 'node_crew') continue
    const node = nodeOf(event)
    const payload = payloadOf(event)
    if (node === null || payload['substitute'] !== true) continue
    const member = String(payload['member'])
    const planned = typeof payload['instead_of'] === 'string' ? payload['instead_of'] : '?'
    const tier = typeof payload['tier'] === 'number' ? payload['tier'] : (crew[member]?.tier ?? 0)
    const plannedTier =
      typeof payload['planned_tier'] === 'number' ? payload['planned_tier'] : crew[planned]?.tier
    // Rows from before there were two reasons read as the one there was.
    const reason = payload['reason'] === 'warm_session' ? 'warm_session' : 'peer_busy'
    const key = `${node}\u0000${member}\u0000${reason}`
    const existing = found.get(key)
    if (existing !== undefined) {
      found.set(key, { ...existing, attempts: existing.attempts + 1 })
      continue
    }
    const model = crew[member]?.model
    found.set(key, {
      node,
      planned,
      ...(plannedTier === undefined ? {} : { planned_tier: plannedTier }),
      member,
      tier,
      ...(model === undefined ? {} : { model }),
      reason,
      attempts: 1,
      above_plan: plannedTier !== undefined && tier > plannedTier,
    })
  }
  return [...found.values()].map((entry) => {
    const cost = nodeCostUsd?.(entry.node) ?? null
    return cost === null ? entry : { ...entry, node_cost_usd: Math.round(cost * 100) / 100 }
  })
}

/** Everything done to the run while it ran. */
export function operations(events: readonly StoredEvent[]): Operations {
  const amendments: Operations['amendments'] = []
  const ops = new Map<string, Operations['node_operations'][number]>()
  const execs = new Map<string, Operations['exec_runs'][number]>()
  const parked = new Set<string>()
  const questions = { asked: 0, by_operator: 0, unattended: 0, by_coordinator: 0, unanswered: 0 }

  for (const event of events) {
    const payload = payloadOf(event)
    const node = nodeOf(event)
    switch (event.type) {
      case 'workflow_amended': {
        const author = payload['author']
        amendments.push({
          amendment: Number(payload['amendment']),
          at_ms: event.ts,
          author: author === 'monitor' || author === 'coordinator' || author === 'config' ? author : 'operator',
        })
        continue
      }
      case 'node_operation': {
        if (node === null || payload['delivery'] === 'delivered') continue
        const op = payload['op'] as Operations['node_operations'][number]['op']
        const by = payload['by'] === 'coordinator' ? 'coordinator' : 'operator'
        const key = `${node}\u0000${op}\u0000${by}`
        const entry = ops.get(key)
        ops.set(key, entry === undefined ? { node, op, by, count: 1 } : { ...entry, count: entry.count + 1 })
        continue
      }
      case 'human_question':
        questions.asked += 1
        if (node !== null) parked.add(node)
        continue
      case 'human_answered':
        if (payload['by'] === 'coordinator') questions.by_coordinator += 1
        else if (payload['unattended'] === true) questions.unattended += 1
        else questions.by_operator += 1
        if (node !== null) parked.delete(node)
        continue
      case 'workspace_exec': {
        const target = String(payload['target'])
        const by = payload['by'] === 'coordinator' ? 'coordinator' : 'operator'
        const key = `${target}\u0000${by}`
        const failed = payload['exit_code'] === 0 ? 0 : 1
        const entry = execs.get(key)
        execs.set(
          key,
          entry === undefined
            ? { target, by, count: 1, failed }
            : { ...entry, count: entry.count + 1, failed: entry.failed + failed },
        )
        continue
      }
      default:
        continue
    }
  }
  questions.unanswered = Math.max(0, questions.asked - questions.by_operator - questions.unattended - questions.by_coordinator)
  return { amendments, node_operations: [...ops.values()], questions, exec_runs: [...execs.values()] }
}

/** Wave gates that failed on a merged tree, with the wave's members. */
export function crossPhaseFailures(
  events: readonly StoredEvent[],
  membersOf: (wave: number) => readonly string[],
): CrossPhaseFailure[] {
  const found: CrossPhaseFailure[] = []
  for (const event of events) {
    if (event.type !== 'wave_gate_result') continue
    const payload = payloadOf(event)
    const exitCode = typeof payload['exit_code'] === 'number' ? payload['exit_code'] : 1
    if (exitCode === 0) continue
    const wave = Number(payload['wave'])
    const members = membersOf(wave)
    if (members.length === 0) continue
    found.push({ wave, gate: String(payload['gate']), members: [...members], at_ms: event.ts, exit_code: exitCode })
  }
  return found
}

function bounded(text: string): string {
  return text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`
}
