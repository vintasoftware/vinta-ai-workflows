/**
 * The plan post-mortem (§13.6).
 *
 * A run knows four things the plan's author could not: which declared
 * dependencies never mattered, which undeclared ones turned up at gate time,
 * which same-wave phases actually collided, and which phases took a wildly
 * different amount of time than their wave placement assumed. This module folds
 * a finished run's journal against its own frozen workflow and emits that as a
 * schema-versioned artifact `plan-feature` reads when planning the next feature
 * in the same repo. It is the only thing that makes the planner and the
 * executor compound rather than merely coexist.
 *
 * **The source is structural, like `analytics.ts`'s and `usage.ts`'s.**
 * `Journal` satisfies `PostMortemSource` and so does a fake, which is what lets
 * these findings be tested against a journal whose timestamps are chosen rather
 * than measured — `Journal.append` stamps `Date.now()`, so a real one cannot
 * express "this phase ran eight times longer than its wave".
 *
 * **Two of the four findings are not in the journal at all, and are handled
 * differently for a reason.**
 *
 * A third — `missing_dependencies` — is now journalled well enough to be
 * worth reading. `gate_result` records each gate's id, exit code and status,
 * so the window a phase spent broken is the window one *named gate* spent
 * red, and the common recovery shape (gate fails, fixer runs, gate passes,
 * node never marked `failed`) is visible at all. It is still ordering
 * evidence, not proof: the finding says an undeclared phase landed while a
 * named gate was red, not that landing it is what turned the gate green.
 *
 * Conflicts are *observed*, but by `src/integration/`, in process: `mergeWave`
 * returns `ConflictRecord`s and no event carries them. So they are an *input*
 * here — pass the integrator's wave results — and their absence is a `gaps[]`
 * entry, never an empty finding. "No conflicts were recorded" and "nobody told
 * us about conflicts" are different sentences and a planner acts on them
 * differently.
 *
 * Dependency *use* is not observed by anything. Nothing in the event
 * vocabulary, the projections or the transcripts records that a node consumed
 * what an upstream node built: the log has status transitions, lane
 * assignments and session ids. The schedule cannot stand in for it either — an
 * edge whose upstream finished long before the dependent started looks
 * identical whether the dependent needed it or not, and the whole value of
 * this finding to the *next* plan is that it is trustworthy. So
 * `unused_dependencies` is reported only from evidence that does not exist
 * yet, and today the artifact carries the gap instead. This is the finding
 * most likely to be fabricated; it is not fabricated here.
 *
 * **An unfinished run is refused, not reported as partial.** `analytics.ts`
 * reports partial figures because its consumer is a live view where "so far"
 * is the useful answer. A post-mortem's consumer is a planning agent in a
 * different session, hours or weeks later, reading a file: a half-run that
 * says a phase never conflicted, or that a dependency was never used, is worse
 * than no file. There is exactly one moment a post-mortem is true, and it is
 * after `run_ended`.
 *
 * Node ids, phase waves, repository paths, epoch milliseconds and counts. No
 * transcript text, no diff hunks, no repository contents, and deliberately not
 * even the plan's own `artifact` prose off the dependency edges — the artifact
 * is read by an agent in another session, which makes it exactly the place
 * where leaked content would be least visible and most harmful.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { computeWaves, transitiveDependents } from '../graph.ts'
import type { NodeStatus, StoredEvent } from '../journal/events.ts'
import type { Workflow } from '../types.ts'

export const POSTMORTEM_SCHEMA_URL =
  'https://github.com/vintasoftware/vinta-ai-workflows/schemas/postmortem.v1.schema.json'

/** Written into the run directory, beside the frozen `workflow.json`. */
export const POSTMORTEM_FILENAME = 'postmortem.json'

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case')
  .min(1)

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const EdgeSchema = z
  .strictObject({
    node: Id.describe('The dependent phase.'),
    depends_on: Id.describe('The upstream phase the edge names.'),
  })
  .describe(
    'One dependency edge, by id. The plan’s own `artifact` prose is deliberately ' +
      'not carried: the reader has the plan, and this file must stay free of repository text.',
  )

export const MissingDependencySchema = z
  .strictObject({
    node: Id.describe('The phase that failed and later passed.'),
    depends_on: Id.describe('The undeclared phase that landed in between.'),
    failed_at_ms: z.number().int().describe('When the phase first failed.'),
    landed_at_ms: z.number().int().describe('When the undeclared phase reached `done`.'),
    passed_at_ms: z.number().int().describe('When the phase finally reached `done`.'),
    gate: Id.optional().describe(
      'The gate whose recorded result is the evidence: it failed at `failed_at_ms` and ' +
        'passed at `passed_at_ms`. Absent when the run recorded no gate result for the ' +
        'phase and the window came from its status transitions instead — a weaker signal, ' +
        'flagged in `gaps`.',
    ),
  })
  .describe(
    'A dependency the run discovered and the plan did not declare: the phase failed, an ' +
      'undeclared phase landed, and only then did it pass. The evidence is still ordering — ' +
      'a recorded gate result narrows the window to one gate and rules out an unrelated ' +
      'failure, but it does not prove the undeclared phase is what fixed it. Confirm the ' +
      'edge against the plan before adding it.',
  )

export const WaveConflictSchema = z
  .strictObject({
    wave: z.number().int().min(1).describe('The wave whose merge produced the conflict.'),
    nodes: z.array(Id).min(2).describe('The phases that both own the contested paths.'),
    paths: z.array(z.string()).describe('Repository paths that conflicted. Paths, never hunks.'),
    fix_rounds: z
      .number()
      .int()
      .min(0)
      .describe('Conflict-fixer rounds the resolution took. High is a strong split signal.'),
  })
  .describe('Two same-wave phases that actually fought over the same code at integration.')

export const DurationDivergenceSchema = z
  .strictObject({
    node: Id,
    wave: z.number().int().min(1),
    span_ms: z.number().int().describe('Dispatch to final settle, including fix rounds.'),
    wave_baseline_ms: z
      .number()
      .int()
      .describe('Median span of the *other* dispatched phases in the same wave.'),
    ratio: z.number().describe('`span_ms / wave_baseline_ms`, rounded to two decimals.'),
    direction: z
      .enum(['longer', 'shorter'])
      .describe('`longer`: the phase set the wave’s wall clock on its own.'),
  })
  .describe(
    'A phase whose real duration was wildly out of line with its wave placement — which is ' +
      'exactly what makes the next plan’s parallelism estimate wrong.',
  )

export const GAP_KINDS = [
  'dependency_use_unrecorded',
  'gate_result_unrecorded',
  'integration_record_unavailable',
] as const

export const PostMortemGapSchema = z
  .strictObject({
    kind: z.enum(GAP_KINDS),
    needs: z.string().describe('What would have to be recorded for the finding to exist.'),
    edges: z.array(EdgeSchema).optional().describe('The edges the gap applies to.'),
    nodes: z.array(Id).optional().describe('The phases the gap applies to.'),
  })
  .describe(
    'A finding this run could not produce, and why. Carried in the artifact rather than ' +
      'thrown or defaulted to an empty list: a reader that treats an empty finding as ' +
      '“nothing happened” has to reach past an explicit statement that nothing was recorded.',
  )

export const PostMortemSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe('Optional URL of this schema, for editor validation. Ignored at runtime.'),
    schema_version: z.literal(1).describe('Schema major version. Bumped only on breaking changes.'),
    run_id: z.string().min(1),
    workflow_id: Id.describe('The workflow this run executed.'),
    plan_ref: z
      .string()
      .optional()
      .describe('The human-readable plan the workflow was emitted alongside, if it named one.'),
    run: z
      .strictObject({
        status: z.enum(['done', 'failed']),
        started_at_ms: z.number().int(),
        ended_at_ms: z.number().int(),
        elapsed_ms: z.number().int(),
        node_count: z.number().int().min(1),
        wave_count: z.number().int().min(1),
      })
      .describe('The run this describes. Always finished — an unfinished run has no post-mortem.'),
    findings: z.strictObject({
      unused_dependencies: z
        .array(EdgeSchema)
        .describe(
          'Edges whose artifact the dependent never needed. Empty on every run today: nothing ' +
            'observes dependency use, and the schedule cannot substitute. See `gaps`.',
        ),
      missing_dependencies: z.array(MissingDependencySchema),
      wave_conflicts: z.array(WaveConflictSchema),
      duration_divergences: z.array(DurationDivergenceSchema),
    }),
    gaps: z.array(PostMortemGapSchema),
  })
  .describe(
    'What one finished `vinta-flow` run learned about the plan that produced it: dependencies ' +
      'that were never used, dependencies discovered missing, same-wave phases that conflicted, ' +
      'and phases whose duration diverged from their wave. Ids, waves, paths, durations and ' +
      'counts only.',
  )

export type PostMortem = z.infer<typeof PostMortemSchema>
export type Edge = z.infer<typeof EdgeSchema>
export type MissingDependency = z.infer<typeof MissingDependencySchema>
export type WaveConflict = z.infer<typeof WaveConflictSchema>
export type DurationDivergence = z.infer<typeof DurationDivergenceSchema>
export type PostMortemGap = z.infer<typeof PostMortemGapSchema>
export type GapKind = (typeof GAP_KINDS)[number]

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The slice of the journal this module needs. Structural on purpose — see the
 * module comment.
 */
export interface PostMortemSource {
  readWorkflow(runId: string): Workflow
  events(runId: string, sinceId?: number): readonly StoredEvent[]
}

/**
 * One wave's integration outcome. `WaveResult` from `src/integration/` satisfies
 * this structurally; a `PlanDefectError` — a conflict no fixer resolved, which
 * is the strongest split signal there is — converts into one conflict entry
 * with its `nodes`, `paths` and `rounds`.
 */
export interface IntegrationWaveRecord {
  readonly wave: number
  readonly conflicts: readonly {
    readonly nodes: readonly string[]
    readonly paths: readonly string[]
    readonly rounds: number
  }[]
}

export interface PostMortemOptions {
  /**
   * The integrator's wave results. Conflicts are never journalled, so omitting
   * this is reported as a gap rather than as "no conflicts". Pass `[]` for a
   * run that integrated with none.
   */
  readonly integration?: readonly IntegrationWaveRecord[]
  /** How many times a span must miss its wave baseline to be a divergence. Default 4. */
  readonly divergenceFactor?: number
  /**
   * Spans below this are never divergences however wrong the ratio is: a phase
   * that took two seconds instead of four teaches the next plan nothing.
   * Default one minute.
   */
  readonly noiseFloorMs?: number
}

/** A run that has not ended. There is exactly one moment a post-mortem is true. */
export class RunNotFinishedError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(
      `run "${runId}" has not ended: a post-mortem describes a finished run, and a partial ` +
        'one would be read as fact by a planner in another session. Use `analyzeRun` for a ' +
        'run in progress.',
    )
    this.name = 'RunNotFinishedError'
    this.runId = runId
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

const SETTLED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'failed', 'blocked'])

/** One journalled gate verdict. Gate id, when, and whether it was green. */
interface GateRun {
  readonly gate: string
  readonly ts: number
  readonly passed: boolean
}

interface Trace {
  wave: number | null
  startedAtMs: number | null
  settledAtMs: number | null
  firstFailedAtMs: number | null
  lastDoneAtMs: number | null
  /** Every `gate_result` for this node, in commit order. */
  gates: GateRun[]
}

const newTrace = (): Trace => ({
  wave: null,
  startedAtMs: null,
  settledAtMs: null,
  firstFailedAtMs: null,
  lastDoneAtMs: null,
  gates: [],
})

/**
 * Derives the post-mortem for a finished run.
 *
 * Throws `RunNotFinishedError` when the run has not ended, and a plain `Error`
 * when the log does not describe a run at all — both are "there is nothing
 * true to say yet", not findings.
 */
export function postMortem(
  source: PostMortemSource,
  runId: string,
  options: PostMortemOptions = {},
): PostMortem {
  const workflow = source.readWorkflow(runId)
  const events = source.events(runId, 0)

  let startedAtMs: number | null = null
  let endedAtMs: number | null = null
  let status: 'done' | 'failed' = 'done'
  const traces = new Map<string, Trace>()

  const traceOf = (nodeId: string): Trace => {
    const existing = traces.get(nodeId)
    if (existing !== undefined) return existing
    const fresh = newTrace()
    traces.set(nodeId, fresh)
    return fresh
  }

  for (const event of events) {
    switch (event.type) {
      case 'run_started':
        startedAtMs = event.ts
        continue
      case 'run_ended':
        endedAtMs = event.ts
        status = event.payload.status
        continue
      case 'node_registered':
        traceOf(event.nodeId).wave = event.payload.wave
        continue
      case 'node_status': {
        const trace = traceOf(event.nodeId)
        const next = event.payload.status
        if (next === 'running' && trace.startedAtMs === null) trace.startedAtMs = event.ts
        if (SETTLED.has(next)) trace.settledAtMs = event.ts
        // Both edges of a re-attempt: the first failure is when the run learned
        // something was missing, the last `done` is when it stopped being.
        if (next === 'failed' && trace.firstFailedAtMs === null) trace.firstFailedAtMs = event.ts
        if (next === 'done') trace.lastDoneAtMs = event.ts
        continue
      }
      case 'gate_result': {
        const { gate, status } = event.payload
        traceOf(event.nodeId).gates.push({ gate, ts: event.ts, passed: status === 'passed' })
        continue
      }
      default:
        // Lane assignments, questions and steering describe how a node spent
        // its time, which is `analytics.ts`'s subject and not this module's.
        continue
    }
  }

  if (startedAtMs === null) throw new Error(`run "${runId}" has no run_started event`)
  if (endedAtMs === null) throw new RunNotFinishedError(runId)

  const waves = computeWaves(workflow.nodes)
  const waveOf = (id: string): number => traces.get(id)?.wave ?? waves.get(id) ?? 1

  return PostMortemSchema.parse({
    $schema: POSTMORTEM_SCHEMA_URL,
    schema_version: 1,
    run_id: runId,
    workflow_id: workflow.id,
    ...(workflow.plan_ref === undefined ? {} : { plan_ref: workflow.plan_ref }),
    run: {
      status,
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
      elapsed_ms: endedAtMs - startedAtMs,
      node_count: workflow.nodes.length,
      wave_count: Math.max(...waves.values()),
    },
    findings: {
      // Not derivable from anything this module can see. The gap below says
      // what would make it derivable; guessing here is the failure mode.
      unused_dependencies: [],
      missing_dependencies: missingDependencies(workflow, traces),
      wave_conflicts: waveConflicts(options.integration),
      duration_divergences: durationDivergences(workflow, traces, waveOf, options),
    },
    gaps: gaps(workflow, traces, options),
  } satisfies PostMortem)
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * The window a phase spent broken: when it first went red, and when the same
 * thing went green again.
 *
 * Gate results are preferred over status transitions, and are the reason this
 * finding is worth reading. A node that fails a gate, runs a fixer and passes
 * never reaches `node_status: failed` at all — the pipeline recovered — so
 * before gate results were journalled the single most common shape of a
 * missing dependency was invisible here. Gate evidence also names *which*
 * gate, which rules out the unrelated-failure reading: the same command went
 * red and then green with an undeclared phase landing in between.
 *
 * The status window remains the fallback, unchanged, for a run whose gates
 * recorded nothing (a host that supplies no `run_gate` body) and for a node
 * that failed outright and was re-run.
 */
function recoveryWindow(
  trace: Trace | undefined,
): { readonly failedAt: number; readonly passedAt: number; readonly gate?: string } | undefined {
  for (const [index, run] of (trace?.gates ?? []).entries()) {
    if (run.passed) continue
    const recovered = trace?.gates.find(
      (later, at) => at > index && later.gate === run.gate && later.passed && later.ts > run.ts,
    )
    if (recovered !== undefined) {
      return { failedAt: run.ts, passedAt: recovered.ts, gate: run.gate }
    }
  }

  const failedAt = trace?.firstFailedAtMs
  const passedAt = trace?.lastDoneAtMs
  if (failedAt == null || passedAt == null || passedAt <= failedAt) return undefined
  return { failedAt, passedAt }
}

/**
 * A phase that failed, and passed only after a phase it does not depend on had
 * landed.
 *
 * Two exclusions keep the suggestion actionable rather than merely true. A
 * candidate already reachable through the declared graph is not a missing
 * edge — the plan says it comes first, so saying it again buys nothing. And a
 * candidate downstream of the failing phase cannot become its dependency: that
 * edge is a cycle, and the real reading is that the two phases are one.
 */
function missingDependencies(
  workflow: Workflow,
  traces: ReadonlyMap<string, Trace>,
): MissingDependency[] {
  const found: MissingDependency[] = []
  const deps = new Map(workflow.nodes.map((n) => [n.id, n.depends_on.map((d) => d.node)]))
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>()
    const queue = [id]
    while (queue.length > 0) {
      for (const dep of deps.get(queue.shift() as string) ?? []) {
        if (seen.has(dep)) continue
        seen.add(dep)
        queue.push(dep)
      }
    }
    return seen
  }

  for (const node of workflow.nodes) {
    const window = recoveryWindow(traces.get(node.id))
    if (window === undefined) continue
    const { failedAt, passedAt } = window

    const declared = ancestors(node.id)
    const downstream = new Set(transitiveDependents(workflow.nodes, node.id))
    for (const candidate of workflow.nodes) {
      if (candidate.id === node.id) continue
      if (declared.has(candidate.id) || downstream.has(candidate.id)) continue
      const landedAt = traces.get(candidate.id)?.lastDoneAtMs
      if (landedAt == null || landedAt <= failedAt || landedAt >= passedAt) continue
      found.push({
        node: node.id,
        depends_on: candidate.id,
        failed_at_ms: failedAt,
        landed_at_ms: landedAt,
        passed_at_ms: passedAt,
        ...(window.gate === undefined ? {} : { gate: window.gate }),
      })
    }
  }
  return found
}

/**
 * Same-wave phases that actually fought, straight off the integration record.
 *
 * A record naming one node is dropped: the integrator always names the
 * incoming node and adds the same-wave peers that touched the contested paths,
 * so a lone name means the merge collided with history from earlier waves —
 * true, and not a fact about two peers being wrongly parallel.
 */
function waveConflicts(
  integration: readonly IntegrationWaveRecord[] | undefined,
): WaveConflict[] {
  if (integration === undefined) return []
  const conflicts: WaveConflict[] = []
  for (const wave of integration) {
    for (const conflict of wave.conflicts) {
      const nodes = [...new Set(conflict.nodes)]
      if (nodes.length < 2) continue
      conflicts.push({
        wave: wave.wave,
        nodes,
        paths: [...conflict.paths],
        fix_rounds: conflict.rounds,
      })
    }
  }
  return conflicts
}

/**
 * Phases whose span was wildly out of line with the rest of their wave.
 *
 * The baseline is the median of the *other* dispatched phases in the wave,
 * leave-one-out: comparing against a median the outlier is inside pulls the
 * baseline towards it, and in a wave of two that hides the divergence
 * completely. A wave with one dispatched phase has no baseline and is skipped
 * — a wave of one is a correct plan, not a finding.
 */
function durationDivergences(
  workflow: Workflow,
  traces: ReadonlyMap<string, Trace>,
  waveOf: (id: string) => number,
  options: PostMortemOptions,
): DurationDivergence[] {
  const factor = options.divergenceFactor ?? 4
  const noiseFloorMs = options.noiseFloorMs ?? 60_000

  const spans = new Map<string, number>()
  for (const node of workflow.nodes) {
    const trace = traces.get(node.id)
    if (trace?.startedAtMs == null || trace.settledAtMs == null) continue
    spans.set(node.id, Math.max(0, trace.settledAtMs - trace.startedAtMs))
  }

  const found: DurationDivergence[] = []
  for (const node of workflow.nodes) {
    const span = spans.get(node.id)
    if (span === undefined) continue
    const wave = waveOf(node.id)
    const others = [...spans]
      .filter(([id]) => id !== node.id && waveOf(id) === wave)
      .map(([, ms]) => ms)
    if (others.length === 0) continue

    const baseline = median(others)
    if (baseline === 0) continue
    const ratio = span / baseline
    if (Math.max(span, baseline) < noiseFloorMs) continue
    if (ratio < factor && ratio > 1 / factor) continue

    found.push({
      node: node.id,
      wave,
      span_ms: span,
      wave_baseline_ms: Math.round(baseline),
      ratio: Math.round(ratio * 100) / 100,
      direction: ratio >= factor ? 'longer' : 'shorter',
    })
  }
  return found
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

// ---------------------------------------------------------------------------
// What the run could not tell you
// ---------------------------------------------------------------------------

function gaps(
  workflow: Workflow,
  traces: ReadonlyMap<string, Trace>,
  options: PostMortemOptions,
): PostMortemGap[] {
  const found: PostMortemGap[] = []

  const edges: Edge[] = workflow.nodes.flatMap((node) =>
    node.depends_on.map((dep) => ({ node: node.id, depends_on: dep.node })),
  )
  if (edges.length > 0) {
    found.push({
      kind: 'dependency_use_unrecorded',
      edges,
      needs:
        'an event recording, per node, which of its declared dependencies its work actually ' +
        'consumed — the implementer naming the `depends_on` entries it used, or a per-node ' +
        'record of the symbols and paths the phase branch read. The journal carries status ' +
        'transitions, lane assignments and session ids; nothing observes consumption. The ' +
        'schedule is not a substitute: an edge whose upstream finished long before the ' +
        'dependent started looks identical whether the artifact was needed or ignored, so ' +
        'every edge above is unproven in both directions and none is reported as unused.',
    })
  }

  // Gate results *are* journalled now, so this gap narrowed from "every failed
  // node" to "the failed nodes this run recorded none for" — a host that
  // supplies no `run_gate` body, or a node that failed before reaching a gate.
  // Their `missing_dependencies` entries carry no `gate` and rest on the node's
  // status transitions alone, which is the weaker evidence the reader must know
  // about. Nodes whose gates *were* recorded are no longer listed here: keeping
  // them would be a stale gap, which is its own kind of lie.
  const unrecorded = workflow.nodes
    .map((node) => node.id)
    .filter((id) => {
      const trace = traces.get(id)
      return trace?.firstFailedAtMs != null && trace.gates.length === 0
    })
  if (unrecorded.length > 0) {
    found.push({
      kind: 'gate_result_unrecorded',
      nodes: unrecorded,
      needs:
        'a `gate_result` event for these phases — gate id, exit code and status, which the ' +
        'executor writes for every gate it runs. This run recorded none for them, so a ' +
        'failure in their gate log is a failure of unknown cause and any ' +
        '`missing_dependencies` entry naming them is ordering evidence (failed, then an ' +
        'undeclared phase landed, then passed) rather than a failure of one identified ' +
        'gate; confirm the edge against the plan before adding it.',
    })
  }

  if (options.integration === undefined) {
    found.push({
      kind: 'integration_record_unavailable',
      needs:
        'the integrator’s wave results, passed as `options.integration`. `mergeWave` returns ' +
        'its `ConflictRecord`s in process and no event carries them, so this run cannot say ' +
        'whether same-wave phases conflicted. `wave_conflicts` being empty here means ' +
        'unrecorded, not clean.',
    })
  }

  return found
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** Beside the frozen workflow: run-scoped facts live in the run directory. */
export function postMortemPath(journalRoot: string, runId: string): string {
  return join(journalRoot, 'runs', runId, POSTMORTEM_FILENAME)
}

export function serializePostMortem(report: PostMortem): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** Writes the artifact into the run directory and returns where it landed. */
export function writePostMortem(journalRoot: string, report: PostMortem): string {
  const path = postMortemPath(journalRoot, report.run_id)
  writeFileSync(path, serializePostMortem(report))
  return path
}

/** Reads one back. The consumer side of the contract, for anything that ingests these. */
export function parsePostMortem(
  raw: unknown,
): { readonly ok: true; readonly report: PostMortem } | { readonly ok: false; readonly issues: z.ZodError } {
  const result = PostMortemSchema.safeParse(raw)
  return result.success ? { ok: true, report: result.data } : { ok: false, issues: result.error }
}
