/**
 * The review ledger (§16.3): what survives between a fixer and a reviewer that
 * do not share a session.
 *
 * Two kinds of fact cross that line and neither fits anywhere else. A finding
 * the fixer **rejected**, with the counter-evidence, has to reach the next
 * review or the reviewer raises it again with no idea it was answered. A
 * **settled decision** — a person's answer to a scope question the fixer would
 * not decide for them — has to reach every later review and fix, or each new
 * round re-asks it. Both are prose about the repository, so they live in a file
 * beside the transcript (`Journal.appendReviewLedger`), never in an event.
 *
 * **The fixer's block and its parser are one definition**, for the reason
 * `VERDICT_MARKER` and `readVerdict` are: the fixer prompt asks for exactly what
 * `readFixerReport` accepts. A block the parser cannot read is treated as no
 * block — nothing rejected, nothing gated — so the next review sees every
 * finding again, which is the safe direction to be wrong in.
 */
import { z } from 'zod'

/** The info string of the fenced block the fixer ends its report with. */
export const LEDGER_FENCE = 'review-ledger'

/**
 * What a gate item is about (§16.2). The four triggers of the thermo-nuclear
 * loop's gate, as words a person reading the question can act on.
 */
export const GATE_TRIGGERS = ['unreachable', 'defensive', 'ambiguity', 'destructive'] as const

const Text = z.string().trim().min(1)

const RejectedSchema = z.object({
  finding: Text,
  counter_evidence: Text,
})

const GatedSchema = z.object({
  id: Text,
  trigger: z.enum(GATE_TRIGGERS),
  finding: Text,
  evidence: Text,
  reviewer_recommendation: Text,
  recommendation: Text,
  default: Text,
})

const ReportBlockSchema = z.object({
  rejected: z.array(RejectedSchema).default([]),
  gated: z.array(GatedSchema).default([]),
})

export type RejectedFinding = z.infer<typeof RejectedSchema>
export type GatedFinding = z.infer<typeof GatedSchema>
export type FixerReport = z.infer<typeof ReportBlockSchema>

const LedgerEntrySchema = z.discriminatedUnion('kind', [
  ReportBlockSchema.extend({ kind: z.literal('report'), at: z.string() }),
  z.object({
    kind: z.literal('decision'),
    at: z.string(),
    /** The operator's answer verbatim, or null when nobody answered it. */
    answer: z.string().nullable(),
    unattended: z.boolean(),
  }),
])

/** One line of the ledger file. `at` is an ISO date, which is what a decision is dated by. */
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

const FENCE_PATTERN = new RegExp('```' + LEDGER_FENCE + '[^\\n]*\\n([\\s\\S]*?)```', 'g')

/**
 * The block the fixer ended its report with, or `undefined` when it wrote none
 * or wrote one that does not parse. The *last* block wins: a report that quotes
 * the format before filling it in must not be read as the empty template.
 */
export function readFixerReport(text: string): FixerReport | undefined {
  let last: string | undefined
  for (const match of text.matchAll(FENCE_PATTERN)) last = match[1]
  if (last === undefined) return undefined
  try {
    const parsed = ReportBlockSchema.safeParse(JSON.parse(last))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * The ledger as written, with any line that does not parse dropped. A torn or
 * hand-edited line costs that line, never the review that reads the rest.
 */
export function parseLedger(raw: readonly unknown[]): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  for (const value of raw) {
    const parsed = LedgerEntrySchema.safeParse(value)
    if (parsed.success) entries.push(parsed.data)
  }
  return entries
}

/** A person's answer to one batch of scope questions, paired with that batch. */
export interface SettledDecision {
  readonly at: string
  readonly items: readonly GatedFinding[]
  readonly answer: string | null
  readonly unattended: boolean
}

export interface LedgerView {
  readonly rejected: readonly RejectedFinding[]
  readonly settled: readonly SettledDecision[]
}

/**
 * What every later prompt is told: every finding ever rejected, and every
 * decision paired with the batch it answered.
 *
 * Pairing is by order, which the file guarantees: a decision answers the most
 * recent report before it, because the shipped pipeline asks only after a
 * fixer turn that gated something. A decision with no gated report before it
 * answers nothing and is dropped rather than shown against the wrong batch.
 */
export function viewLedger(entries: readonly LedgerEntry[]): LedgerView {
  const rejected: RejectedFinding[] = []
  const settled: SettledDecision[] = []
  let open: readonly GatedFinding[] = []
  for (const entry of entries) {
    if (entry.kind === 'report') {
      rejected.push(...entry.rejected)
      open = entry.gated
      continue
    }
    if (open.length === 0) continue
    settled.push({ at: entry.at, items: open, answer: entry.answer, unattended: entry.unattended })
    open = []
  }
  return { rejected, settled }
}
