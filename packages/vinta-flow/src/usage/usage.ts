/**
 * Cost and token accounting (§13.7).
 *
 * This is a fold over data that already exists. Every harness emits exactly one
 * `usage` event per session — cumulative and terminal (§7) — the journal writes
 * it into the node's transcript, and this module adds those records up per
 * node, per wave and per run, broken down by harness and model. There is no
 * new machinery here and there should never be: the moment this file starts
 * *deriving* usage rather than counting it, the numbers stop matching the
 * figures the harnesses themselves report, which is the only property that
 * makes them worth showing.
 *
 * Two rules decide correctness.
 *
 * **A session contributes one record, never two.** `usage` is a session total,
 * not a delta, so adding two of them for one session double-counts the whole
 * session. A transcript that somehow carries two takes the last and reports an
 * anomaly — silently summing them is exactly the failure §7 froze the event
 * shape to prevent. Summing *across* sessions is the opposite case and is
 * correct: a node that implements, is reviewed, and is fixed twice ran four
 * turns, and its cost is all four.
 *
 * **`costUsd` is optional and a missing one is not a zero.** codex reports
 * tokens only. A total therefore never carries a bare number: it is `complete`,
 * `partial` or `unreported`, and only a `complete` total exposes `usd`. A
 * partial total exposes `usdSoFar` under a different name on purpose — a
 * caller cannot reach the figure without acknowledging in the type system that
 * it is not the whole one.
 *
 * The cache counters (§15.6) follow that second rule exactly, and for a sharper
 * version of the same reason. Session reuse exists to turn a cold prompt into a
 * cache read, so the figure the run report wants is a *share* — and a share has
 * a denominator, which means a harness reporting nothing must not fold into one
 * as zeroes. Aggregated that way, one silent harness would drag the whole run's
 * hit rate down and the feature would look like it had stopped working. So
 * `CacheTotal` carries the same three statuses, and the tokens it divides by
 * are only those of the sessions that reported.
 *
 * Nothing here reads prompt text, assistant output or tool payloads. It matches
 * on `type`, takes three numbers and an opaque session id, and ignores the rest
 * of every entry.
 */
import { computeWaves } from '../graph.ts'
import type { Workflow } from '../types.ts'

/** Mirrors the journal's transcript streams; usage only ever reads the normalized one. */
export type TranscriptStream = 'transcript' | 'raw'

/**
 * The slice of the journal this module needs. Structural on purpose: `Journal`
 * satisfies it, and so does a fake, so accounting is testable without a
 * database and does not break when the journal grows methods.
 */
export interface UsageSource {
  readWorkflow(runId: string): Workflow
  tailTranscript(
    runId: string,
    nodeId: string,
    limit?: number,
    stream?: TranscriptStream,
  ): unknown[]
}

/** One session's cumulative total, as the harness reported it. */
export interface SessionUsage {
  /** Opaque harness session id, or a synthetic key for a usage event with no session. */
  readonly sessionId: string
  /**
   * The prompt tokens the vendor processed fresh — cached ones are the two
   * fields below and are *not* included here, in every adapter this package
   * ships. `inputTokens + cacheReadTokens + cacheWriteTokens` is the whole
   * prompt.
   */
  readonly inputTokens: number
  readonly outputTokens: number
  /** Absent when the harness does not report cost. Absent is not zero. */
  readonly costUsd?: number
  /** Prompt prefix served from cache. Absent where the harness reports none. */
  readonly cacheReadTokens?: number
  /** Prompt prefix written into cache — a first turn pays it, later ones do not. */
  readonly cacheWriteTokens?: number
}

/**
 * A transcript that did not read the way §7 says it should. Identifiers and
 * counts only — an anomaly is a footnote on a number, never a place to put
 * transcript content.
 */
export type UsageAnomaly =
  | {
      readonly kind: 'duplicate_session_usage'
      readonly nodeId: string
      readonly sessionId: string
      /** How many usage events the session emitted. The last one was used. */
      readonly count: number
    }
  | {
      readonly kind: 'usage_without_session'
      readonly nodeId: string
      /** Usage events that appeared before any `session_started`. Each counted once. */
      readonly count: number
    }

/**
 * Money, with its reporting status attached.
 *
 * `complete` — every session that reported tokens also reported cost, so `usd`
 * is the whole figure (and `usd: 0` is a genuine, reported zero).
 * `partial` — some sessions reported cost and some did not. The figure is a
 * floor, which is why it is not called `usd`.
 * `unreported` — nothing reported cost: either the run produced no usage at
 * all, or its harnesses report tokens only. There is no number to show.
 */
export type CostTotal =
  | { readonly status: 'complete'; readonly usd: number; readonly reportedSessions: number }
  | {
      readonly status: 'partial'
      /** A lower bound. The sessions in `missingSessions` cost an unknown amount more. */
      readonly usdSoFar: number
      readonly reportedSessions: number
      readonly missingSessions: number
    }
  | { readonly status: 'unreported'; readonly missingSessions: number }

/**
 * Prompt-cache tokens, with their reporting status attached — `CostTotal`'s
 * shape, for `CostTotal`'s reason (§15.6).
 *
 * `promptTokens` is the denominator of the cache-read share and is deliberately
 * *not* the total's `inputTokens`: it counts only the sessions that reported
 * cache figures at all. A share over a denominator that included the silent
 * sessions would be arithmetic about a population it cannot describe.
 *
 * `complete` — every session that reported tokens also reported cache figures.
 * `partial` — some did and some did not; the figures cover only those that did,
 * which is why they are named `…SoFar`.
 * `unreported` — nothing reported. There is no share to state, and stating 0%
 * would be a claim about a harness that never spoke.
 */
export type CacheTotal =
  | {
      readonly status: 'complete'
      readonly readTokens: number
      readonly writeTokens: number
      /** Fresh + cached prompt tokens across the reporting sessions. */
      readonly promptTokens: number
      readonly reportedSessions: number
    }
  | {
      readonly status: 'partial'
      readonly readTokensSoFar: number
      readonly writeTokensSoFar: number
      /** Covers the reporting sessions only — the share's honest denominator. */
      readonly promptTokensSoFar: number
      readonly reportedSessions: number
      readonly missingSessions: number
    }
  | { readonly status: 'unreported'; readonly missingSessions: number }

export interface UsageTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Sessions counted — one per session, however many turns a node took. */
  readonly sessions: number
  readonly cost: CostTotal
  readonly cache: CacheTotal
}

export interface NodeUsage {
  readonly nodeId: string
  readonly wave: number
  readonly harness: string
  readonly model: string
  readonly totals: UsageTotals
}

export interface WaveUsage {
  readonly wave: number
  readonly nodeIds: readonly string[]
  readonly totals: UsageTotals
  readonly byHarness: Readonly<Record<string, UsageTotals>>
  readonly byModel: Readonly<Record<string, UsageTotals>>
}

export interface RunUsage {
  readonly runId: string
  readonly totals: UsageTotals
  readonly byHarness: Readonly<Record<string, UsageTotals>>
  readonly byModel: Readonly<Record<string, UsageTotals>>
  /** Ascending. Waves partition the run: their totals sum back to `totals`. */
  readonly waves: readonly WaveUsage[]
  /** Every node in the frozen workflow, including those that never ran (zeroes). */
  readonly nodes: readonly NodeUsage[]
  readonly anomalies: readonly UsageAnomaly[]
}

/** `tailTranscript` grows its window until it reaches byte 0 — i.e. the whole file. */
const EVERY_ENTRY = Number.MAX_SAFE_INTEGER

/**
 * The per-session records in one node's transcript, deduplicated.
 *
 * A missing transcript — a node that never ran — is an empty list, not an
 * error: "this node cost nothing yet" is the true answer, and making the
 * caller catch for it would push that judgement into every consumer.
 */
export function readNodeSessions(
  source: UsageSource,
  runId: string,
  nodeId: string,
): { readonly sessions: readonly SessionUsage[]; readonly anomalies: readonly UsageAnomaly[] } {
  const entries = source.tailTranscript(runId, nodeId, EVERY_ENTRY, 'transcript')

  // Insertion-ordered, so sessions come back in the order the node ran them.
  const bySession = new Map<string, { usage: SessionUsage; count: number }>()
  let currentSession: string | undefined
  let orphans = 0

  for (const entry of entries) {
    if (!isRecord(entry)) continue

    if (entry['type'] === 'session_started') {
      const id = entry['sessionId']
      if (typeof id === 'string' && id !== '') currentSession = id
      continue
    }
    // `session_ended` deliberately does not clear the current session: the
    // usage frame is terminal, and a harness that emits it just after the end
    // marker still means "this session's total".
    if (entry['type'] !== 'usage') continue

    const tokens = readTokens(entry)
    if (!tokens) continue

    // No session id to key on: assume each such event is its own session
    // rather than folding them together, which would lose real usage.
    const key = currentSession ?? `\0orphan-${(orphans += 1)}`
    const prior = bySession.get(key)
    // Last wins. Two records for one session is a duplicate, never a sum.
    bySession.set(key, { usage: { sessionId: key, ...tokens }, count: (prior?.count ?? 0) + 1 })
  }

  const sessions: SessionUsage[] = []
  const anomalies: UsageAnomaly[] = []
  for (const [key, { usage, count }] of bySession) {
    sessions.push(usage)
    if (count > 1) {
      anomalies.push({ kind: 'duplicate_session_usage', nodeId, sessionId: key, count })
    }
  }
  if (orphans > 0) anomalies.push({ kind: 'usage_without_session', nodeId, count: orphans })

  return { sessions, anomalies }
}

/** One node's totals, summed across every session the node ran. */
export function collectNodeUsage(
  source: UsageSource,
  runId: string,
  nodeId: string,
): { readonly totals: UsageTotals; readonly anomalies: readonly UsageAnomaly[] } {
  const { sessions, anomalies } = readNodeSessions(source, runId, nodeId)
  const acc = newAcc()
  for (const session of sessions) addSession(acc, session)
  return { totals: seal(acc), anomalies }
}

/**
 * Every total for a run: the run, its waves, its nodes, and harness/model
 * breakdowns of each. A run with no usage at all reports zeroes.
 */
export function collectRunUsage(source: UsageSource, runId: string): RunUsage {
  const workflow = source.readWorkflow(runId)
  const waveOf = computeWaves(workflow.nodes)

  const run = newAcc()
  const runByHarness = new Map<string, Acc>()
  const runByModel = new Map<string, Acc>()
  const waves = new Map<number, WaveAcc>()
  const nodes: NodeUsage[] = []
  const anomalies: UsageAnomaly[] = []

  for (const node of workflow.nodes) {
    const { sessions, anomalies: nodeAnomalies } = readNodeSessions(source, runId, node.id)
    anomalies.push(...nodeAnomalies)

    const harness = node.harness ?? workflow.defaults.harness
    const model = node.model ?? workflow.defaults.model
    const wave = waveOf.get(node.id) ?? 1
    let bucket = waves.get(wave)
    if (!bucket) {
      bucket = { nodeIds: [], acc: newAcc(), harness: new Map(), model: new Map() }
      waves.set(wave, bucket)
    }
    bucket.nodeIds.push(node.id)

    const nodeAcc = newAcc()
    for (const session of sessions) {
      for (const acc of [
        nodeAcc,
        run,
        bucket.acc,
        into(runByHarness, harness),
        into(runByModel, model),
        into(bucket.harness, harness),
        into(bucket.model, model),
      ]) {
        addSession(acc, session)
      }
    }

    nodes.push({ nodeId: node.id, wave, harness, model, totals: seal(nodeAcc) })
  }

  return {
    runId,
    totals: seal(run),
    byHarness: sealAll(runByHarness),
    byModel: sealAll(runByModel),
    waves: [...waves.entries()]
      .sort(([a], [b]) => a - b)
      .map(([wave, bucket]) => ({
        wave,
        nodeIds: bucket.nodeIds,
        totals: seal(bucket.acc),
        byHarness: sealAll(bucket.harness),
        byModel: sealAll(bucket.model),
      })),
    nodes,
    anomalies,
  }
}

/** Adds independent totals — e.g. two runs, or a hand-picked set of nodes. */
export function sumTotals(totals: readonly UsageTotals[]): UsageTotals {
  const acc = newAcc()
  for (const one of totals) {
    acc.input += one.inputTokens
    acc.output += one.outputTokens
    acc.sessions += one.sessions
    switch (one.cost.status) {
      case 'complete':
        acc.usd += one.cost.usd
        acc.reported += one.cost.reportedSessions
        break
      case 'partial':
        acc.usd += one.cost.usdSoFar
        acc.reported += one.cost.reportedSessions
        break
      case 'unreported':
        break
    }
    switch (one.cache.status) {
      case 'complete':
        acc.cacheRead += one.cache.readTokens
        acc.cacheWrite += one.cache.writeTokens
        acc.cachePrompt += one.cache.promptTokens
        acc.cacheReported += one.cache.reportedSessions
        break
      case 'partial':
        acc.cacheRead += one.cache.readTokensSoFar
        acc.cacheWrite += one.cache.writeTokensSoFar
        acc.cachePrompt += one.cache.promptTokensSoFar
        acc.cacheReported += one.cache.reportedSessions
        break
      case 'unreported':
        break
    }
  }
  return seal(acc)
}

// ---------------------------------------------------------------------------
// The fold itself
// ---------------------------------------------------------------------------

interface WaveAcc {
  readonly nodeIds: string[]
  readonly acc: Acc
  readonly harness: Map<string, Acc>
  readonly model: Map<string, Acc>
}

interface Acc {
  input: number
  output: number
  usd: number
  sessions: number
  /** Sessions that reported a cost. `sessions - reported` is what is missing. */
  reported: number
  cacheRead: number
  cacheWrite: number
  /** Prompt tokens of the cache-reporting sessions only — the share's denominator. */
  cachePrompt: number
  /** Sessions that reported either cache figure. */
  cacheReported: number
}

const newAcc = (): Acc => ({
  input: 0,
  output: 0,
  usd: 0,
  sessions: 0,
  reported: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cachePrompt: 0,
  cacheReported: 0,
})

function addSession(acc: Acc, session: SessionUsage): void {
  acc.input += session.inputTokens
  acc.output += session.outputTokens
  acc.sessions += 1
  if (session.costUsd !== undefined) {
    acc.usd += session.costUsd
    acc.reported += 1
  }
  // Either counter is enough to make the session a reporting one: a harness
  // that read from cache and wrote nothing legitimately sends one of the two,
  // and dropping such a session from the denominator would understate exactly
  // the turns §15 is trying to produce.
  const read = session.cacheReadTokens
  const write = session.cacheWriteTokens
  if (read === undefined && write === undefined) return
  acc.cacheRead += read ?? 0
  acc.cacheWrite += write ?? 0
  acc.cachePrompt += session.inputTokens + (read ?? 0) + (write ?? 0)
  acc.cacheReported += 1
}

function seal(acc: Acc): UsageTotals {
  const missingSessions = acc.sessions - acc.reported
  const cost: CostTotal =
    acc.reported === 0
      ? { status: 'unreported', missingSessions }
      : missingSessions === 0
        ? { status: 'complete', usd: acc.usd, reportedSessions: acc.reported }
        : {
            status: 'partial',
            usdSoFar: acc.usd,
            reportedSessions: acc.reported,
            missingSessions,
          }
  const missingCache = acc.sessions - acc.cacheReported
  const cache: CacheTotal =
    acc.cacheReported === 0
      ? { status: 'unreported', missingSessions: missingCache }
      : missingCache === 0
        ? {
            status: 'complete',
            readTokens: acc.cacheRead,
            writeTokens: acc.cacheWrite,
            promptTokens: acc.cachePrompt,
            reportedSessions: acc.cacheReported,
          }
        : {
            status: 'partial',
            readTokensSoFar: acc.cacheRead,
            writeTokensSoFar: acc.cacheWrite,
            promptTokensSoFar: acc.cachePrompt,
            reportedSessions: acc.cacheReported,
            missingSessions: missingCache,
          }
  return {
    inputTokens: acc.input,
    outputTokens: acc.output,
    sessions: acc.sessions,
    cost,
    cache,
  }
}

/**
 * The cached share of the prompt, in `[0, 1]` — what §15 bought, in the one
 * number that says it.
 *
 * `undefined` where nothing reported, and that is the point: a run whose
 * harnesses report no cache figures has an *unknown* hit rate, not a zero one,
 * and a caller that has to handle `undefined` cannot print the second by
 * accident. It is also `undefined` for a total with no prompt tokens at all,
 * because 0/0 is not 0%.
 *
 * On a `partial` total this is the share over the sessions that reported —
 * honest about its own population, but not a statement about the whole run. A
 * caller presenting it as one reads `cache.status` and says so.
 */
export function cacheReadShare(totals: UsageTotals): number | undefined {
  const { cache } = totals
  if (cache.status === 'unreported') return undefined
  const prompt = cache.status === 'complete' ? cache.promptTokens : cache.promptTokensSoFar
  if (prompt <= 0) return undefined
  const read = cache.status === 'complete' ? cache.readTokens : cache.readTokensSoFar
  return read / prompt
}

function sealAll(accs: ReadonlyMap<string, Acc>): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {}
  for (const [key, acc] of accs) out[key] = seal(acc)
  return out
}

function into(accs: Map<string, Acc>, key: string): Acc {
  const existing = accs.get(key)
  if (existing) return existing
  const fresh = newAcc()
  accs.set(key, fresh)
  return fresh
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The counts, and nothing else off the entry. A non-finite or negative count is
 * treated as no usage at all rather than poisoning a run total with `NaN`; a
 * non-finite cost drops the cost and leaves the tokens, which the `partial`
 * status then flags. A cache figure that fails the same check drops the same
 * way, and drops to *absent* rather than to 0 — an unreadable figure is exactly
 * as unknown as an unsent one (§15.6).
 */
function readTokens(entry: Record<string, unknown>): Omit<SessionUsage, 'sessionId'> | null {
  const input = entry['input']
  const output = entry['output']
  if (!isCount(input) || !isCount(output)) return null
  const cost = entry['costUsd']
  const cacheRead = entry['cacheRead']
  const cacheWrite = entry['cacheWrite']
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    ...(isCount(cacheRead) ? { cacheReadTokens: cacheRead } : {}),
    ...(isCount(cacheWrite) ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
