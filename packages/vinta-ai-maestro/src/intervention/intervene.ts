/**
 * One intervention, end to end: a threshold fired, and this is what the run
 * does about it.
 *
 * The pieces each do one thing and this is the only place they meet, which is
 * deliberate — every step below can refuse, and a refusal at any of them must
 * leave the run exactly as it was:
 *
 *     watchdog.triggers    has anything crossed a threshold?
 *     ledger.readLedger    has this run already changed itself enough?
 *     Monitor.intervene    what does the model propose, having read the logs?
 *     InterventionSchema   is the proposal a proposal at all?
 *     ledger.admit         may these particular verbs be applied now?
 *     applyIntervention    are they within the monitor's authority?
 *     amendRun             may the *run* take the result right now?
 *
 * The ordering is not arbitrary. The two cheap refusals come before the model
 * turn, because the expensive thing here is the turn and a run that has spent
 * its budget should not pay for advice it cannot take. The two authority
 * checks come after it, because they need what it said. And `amendRun` is last
 * because it is the only one that can move anything.
 *
 * **Every outcome is recorded, including the ones that changed nothing.** A
 * proposal that was refused is the most interesting thing this feature
 * produces: it is a monitor trying to do something it may not do, with nobody
 * in the room, and a version of this that quietly dropped those would be a
 * version whose safety properties nobody could check after the fact. The
 * record is a file beside the run, because it carries the monitor's prose and
 * prose does not go in event payloads (§11); the event says what changed, in
 * identifiers.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { amendRun, type AmendRunner } from '../amend/amend.ts'
import type { Journal } from '../journal/journal.ts'
import { Monitor, runDigest } from '../monitor/monitor.ts'
import type { Workflow } from '../types.ts'
import {
  applyIntervention,
  InterventionSchema,
  type Intervention,
  type InterventionVerb,
} from './intervention.ts'
import { admit, readLedger, targetOf, type LedgerRefusalCode } from './ledger.ts'
import { describeTriggers, triggers, type WatchdogOptions, type WatchdogTrigger } from './watchdog.ts'

/** What one intervention attempt did. Every arm is journalled. */
export type InterventionOutcome =
  /** Nothing crossed a threshold. The common case, and free — no model turn. */
  | { readonly kind: 'quiet' }
  /** Thresholds crossed, but this run may not change itself any further. */
  | { readonly kind: 'exhausted'; readonly triggers: readonly WatchdogTrigger[] }
  /** The monitor looked and proposed nothing. Also a success. */
  | { readonly kind: 'no_change'; readonly summary: string }
  /** The monitor answered with something that is not an intervention document. */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /** Everything proposed was refused, by the ledger or by the verb rules. */
  | { readonly kind: 'refused'; readonly summary: string; readonly reasons: readonly string[] }
  /** The run took it. */
  | {
      readonly kind: 'amended'
      readonly summary: string
      readonly applied: readonly InterventionVerb[]
      readonly amendment: number
      readonly workflow: Workflow
    }

export interface InterveneOptions {
  readonly journal: Journal
  readonly runId: string
  /** The run's current definition — the frozen snapshot, or the last amendment. */
  readonly workflow: Workflow
  /** Built per call by the host, exactly as the API builds one. */
  readonly monitor: Monitor
  readonly runner?: AmendRunner
  readonly watchdog?: WatchdogOptions
  /** Autonomous amendments this run may make in total. */
  readonly budget?: number
}

/**
 * Evaluates the run and, if it is warranted and permitted, amends it.
 *
 * Never throws for an ordinary refusal — a watchdog that could crash the
 * process it runs beside would be a worse bug than any mis-tuned gate. A
 * harness that cannot be reached surfaces as `unreadable`, which is what it is
 * from here: no proposal arrived.
 */
export async function intervene(options: InterveneOptions): Promise<InterventionOutcome> {
  const { journal, runId, workflow } = options

  const found = triggers(journal.events(runId), options.watchdog ?? {})
  if (found.length === 0) return { kind: 'quiet' }

  const ledger = readLedger(journal, runId, options.budget)
  if (ledger.remaining <= 0) {
    record(journal, runId, { kind: 'exhausted', triggers: found, ledger: ledger.spent })
    return { kind: 'exhausted', triggers: found }
  }

  const digest = runDigest(journal, runId, workflow)
  if (digest === null) return { kind: 'quiet' }

  let answer: string
  try {
    answer = await options.monitor.intervene(digest, describeTriggers(found), allowedVerbs(workflow))
  } catch {
    // A harness that would not start, a session that would not resume. The
    // kind is on the error and the vendor's prose is on it too; neither
    // belongs in a record that is read back later (§11).
    const reason = 'the monitor could not be reached'
    record(journal, runId, { kind: 'unreadable', triggers: found, reason })
    return { kind: 'unreadable', reason }
  }

  const parsed = parse(answer)
  if (parsed === null) {
    const reason = 'the monitor did not answer with an intervention document'
    record(journal, runId, { kind: 'unreadable', triggers: found, reason })
    return { kind: 'unreadable', reason }
  }

  if (parsed.changes.length === 0) {
    record(journal, runId, { kind: 'no_change', triggers: found, intervention: parsed })
    return { kind: 'no_change', summary: parsed.summary }
  }

  const verdict = admit(ledger, parsed.changes)
  const reasons = verdict.held.map((entry) => heldReason(entry.verb, entry.code))

  if (verdict.allowed.length === 0) {
    record(journal, runId, { kind: 'refused', triggers: found, intervention: parsed, reasons })
    return { kind: 'refused', summary: parsed.summary, reasons }
  }

  const applied = applyIntervention(workflow, { ...parsed, changes: [...verdict.allowed] })
  if (!applied.ok) {
    const all = [...reasons, ...applied.issues.map((issue) => issue.message)]
    record(journal, runId, { kind: 'refused', triggers: found, intervention: parsed, reasons: all })
    return { kind: 'refused', summary: parsed.summary, reasons: all }
  }

  const refusedByVerb = applied.refused.flatMap((entry) =>
    entry.refusal.issues.map((issue) => issue.message),
  )

  // §9's own gate, unchanged and unbypassed. The monitor's authority decides
  // what may be *proposed*; this decides whether the run can take it right now,
  // and it answers the same way for an autonomous amendment as for an
  // operator's — which is the property that makes this safe to run unattended.
  const result = await amendRun({
    journal,
    runId,
    proposed: applied.workflow,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    author: 'monitor',
    targets: applied.applied.map(targetOf),
  })

  if (!result.ok) {
    const all = [...reasons, ...refusedByVerb, ...result.issues.map((issue) => issue.message)]
    record(journal, runId, { kind: 'refused', triggers: found, intervention: parsed, reasons: all })
    return { kind: 'refused', summary: parsed.summary, reasons: all }
  }

  record(journal, runId, {
    kind: 'amended',
    triggers: found,
    intervention: parsed,
    applied: applied.applied,
    reasons: [...reasons, ...refusedByVerb],
    amendment: result.amendment,
  })

  return {
    kind: 'amended',
    summary: parsed.summary,
    applied: applied.applied,
    amendment: result.amendment,
    workflow: result.workflow,
  }
}

// ---------------------------------------------------------------------------

/**
 * What this workflow actually permits, spelled for the model.
 *
 * Built from the workflow rather than written as a constant, because the
 * answer differs per run: a gate with no `tuning` block is not retunable, and
 * telling the monitor it may retune gates when this run has none that it may
 * is how a turn is spent producing a proposal that was always going to be
 * refused.
 */
export function allowedVerbs(workflow: Workflow): string {
  const lines: string[] = []

  const tunable = Object.entries(workflow.gates).filter(([, gate]) => gate.tuning !== undefined)
  if (tunable.length === 0) {
    lines.push(
      '- `retune_gate` is NOT available on this run: no gate declares a `tuning` block, so no',
      '  gate command may be changed. Do not propose one.',
    )
  } else {
    lines.push('- `retune_gate` — {gate, cmd, evidence}. Available for these gates only:')
    for (const [id, gate] of tunable) {
      lines.push(
        `    ${id}: may ADD ${(gate.tuning?.allowed_flags ?? []).map((flag) => `\`${flag}\``).join(', ')}`,
      )
    }
    lines.push(
      '  The command you propose must be the current one’s argv tokens, in the same order,',
      '  plus flags from that list. Removing or rewriting an existing token is refused, and',
      '  a flag not on the list is refused — including one that would obviously help.',
    )
  }

  lines.push(
    '- `retime_gate` — {gate, timeout_s, evidence}. For a gate that is being killed before',
    '  it finishes, not for one that is merely slow.',
    '- `rebudget_fixes` — {node, max_fix_rounds, evidence}. For a phase whose review rounds',
    '  are making progress and running out.',
    `- \`retier_phase\` — {node, model, evidence}. Only these models are on this run’s roster: ${[
      ...new Set([workflow.defaults.model, ...Object.values(workflow.crew).map((m) => m.model)]),
    ]
      .sort()
      .map((model) => `\`${model}\``)
      .join(', ')}.`,
    '',
    'At most one change per gate and per phase, and at most four in total. A run may make',
    'a limited number of these in its whole life, so a change that is not clearly worth it',
    'is worse than no change: it spends the budget that a real finding would have needed.',
  )

  return lines.join('\n')
}

/**
 * The monitor's answer, if it is one.
 *
 * Lenient about the wrapper and strict about the content. A model told to
 * reply with JSON and nothing else will sometimes fence it anyway, and losing
 * a correct proposal to a pair of backticks would be an annoying way to fail;
 * what is *inside* goes through the schema like everything else.
 */
function parse(answer: string): Intervention | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer)
  const body = fenced?.[1] ?? answer
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let raw: unknown
  try {
    raw = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  const parsed = InterventionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function heldReason(verb: InterventionVerb, code: LedgerRefusalCode): string {
  const target = targetOf(verb)
  return code === 'budget_spent'
    ? `${verb.verb} on ${target}: this run has spent its intervention budget`
    : `${verb.verb} on ${target}: the monitor has already changed ${target} in this run`
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

interface Record_ {
  readonly kind: InterventionOutcome['kind']
  readonly triggers: readonly WatchdogTrigger[]
  readonly intervention?: Intervention
  readonly applied?: readonly InterventionVerb[]
  readonly reasons?: readonly string[]
  readonly reason?: string
  readonly amendment?: number
  readonly ledger?: number
}

/**
 * Appends one line of JSON to `interventions.jsonl` in the run directory.
 *
 * A file rather than an event, and JSONL rather than one document per
 * intervention, for three separate reasons. It carries the monitor's prose —
 * `summary` and every `evidence` — which is exactly what §11 keeps out of
 * event payloads and out of anything the API serves by default. It is
 * append-only history with no projection to fold it into. And a run that
 * considered intervening four times has four records, of which three probably
 * changed nothing; a single file that grows is the honest shape for that,
 * where four numbered files would imply four decisions of equal weight.
 *
 * Failing to write it never fails the intervention. The amendment is already
 * journalled by then, and losing the prose beside it is worse than losing
 * nothing but much better than unwinding a change that has landed.
 */
function record(journal: Journal, runId: string, entry: Record_): void {
  try {
    const dir = join(journal.root, 'runs', runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'interventions.jsonl'),
      `${JSON.stringify({ at: Date.now(), ...entry })}\n`,
      { encoding: 'utf8', flag: 'a' },
    )
  } catch {
    // Deliberately silent: see above.
  }
}
