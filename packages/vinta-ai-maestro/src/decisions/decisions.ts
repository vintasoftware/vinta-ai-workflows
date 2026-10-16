/**
 * A phase's decisions: what was settled for it, kept so that every later
 * prompt carries it whichever session runs that prompt.
 *
 * A decision used to live only in the session it was made in. An agent's
 * question answered unattended reached the session that asked and no other;
 * an operator's note reached the next spawn and was then cleared; a finding
 * the review rejected lived in the implementer's context. Each review pass is
 * a fresh reviewer, so it raised the same finding again, the same question was
 * asked four times, and a phase ran some thirty rounds without converging. A
 * session replaced after a stale token or a cold retry lost the operator's note
 * the same way.
 *
 * Three kinds, each recorded where it happens:
 *
 * - **`answer`** — an agent's question and the answer it got: the operator's,
 *   the run coordinator's, or the recommended option under `--retry-after`.
 * - **`context`** — what an operator (or the coordinator) told the node with
 *   `node context` or `redirect`.
 * - **`rejected`** — a finding the review chore rejected, with its
 *   counter-evidence, from the `REJECTED:` lines its report ends with.
 *
 * All three are prose — the agent's and the operator's — so they live in a
 * file beside the transcript, never in the event log (§11).
 */
import type { AgentAnswer, AgentAsk } from '../questions/shape.ts'

export type DecisionKind = 'answer' | 'context' | 'rejected'

/** Who settled it. `unattended` is the run answering for an absent operator. */
export type DecidedBy = 'operator' | 'coordinator' | 'unattended' | 'review'

export interface Decision {
  readonly kind: DecisionKind
  readonly by: DecidedBy
  readonly text: string
}

const KINDS: ReadonlySet<string> = new Set<DecisionKind>(['answer', 'context', 'rejected'])
const BY: ReadonlySet<string> = new Set<DecidedBy>(['operator', 'coordinator', 'unattended', 'review'])

/** One decision's text, at most. Longer is cut, never dropped. */
export const DECISION_TEXT_LIMIT = 800

/**
 * How many of each group a prompt carries, newest first. Rejected findings
 * have their own allowance, because a long review rejects many and would
 * otherwise push the operator's answers out of every later prompt.
 */
export const SETTLED_LIMIT = 12
export const REJECTED_LIMIT = 8

/** The line a review report states a rejected finding on. */
export const REJECTED_MARKER = 'REJECTED:'

const REJECTED_LINE = /^[ \t]*(?:[-*][ \t]+)?`?REJECTED:[ \t]*(.+?)`?[ \t]*$/gm

/** A stored line, or null for one this build cannot read. */
export function parseDecision(raw: unknown): Decision | null {
  if (raw === null || typeof raw !== 'object') return null
  const { kind, by, text } = raw as Record<string, unknown>
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  if (typeof by !== 'string' || !BY.has(by)) return null
  if (typeof text !== 'string' || text.trim() === '') return null
  return { kind: kind as DecisionKind, by: by as DecidedBy, text: clip(text) }
}

/** A decision as it is stored: trimmed and cut to `DECISION_TEXT_LIMIT`. */
export function decision(kind: DecisionKind, by: DecidedBy, text: string): Decision {
  return { kind, by, text: clip(text) }
}

/**
 * Appends `entry` unless the list already holds the same kind with the same
 * words. A finding rejected in two passes, or a note sent twice, is one
 * decision. Returns whether it was added.
 */
export function appendDecision(list: Decision[], entry: Decision): boolean {
  const key = normalize(entry.text)
  if (list.some((existing) => existing.kind === entry.kind && normalize(existing.text) === key)) return false
  list.push(entry)
  return true
}

/**
 * What a prompt carries: the newest `SETTLED_LIMIT` answers and notes and the
 * newest `REJECTED_LIMIT` rejected findings, in the order they were made, and
 * how many were left out.
 */
export function selectDecisions(list: readonly Decision[]): {
  readonly shown: readonly Decision[]
  readonly omitted: number
} {
  const keep = new Set<Decision>([
    ...list.filter((entry) => entry.kind !== 'rejected').slice(-SETTLED_LIMIT),
    ...list.filter((entry) => entry.kind === 'rejected').slice(-REJECTED_LIMIT),
  ])
  const shown = list.filter((entry) => keep.has(entry))
  return { shown, omitted: list.length - shown.length }
}

/**
 * An answered agent question, one decision per question: the question as the
 * agent put it and the option it got, with that option's consequence, so it
 * reads without the card in view. A question nobody answered settles nothing.
 */
export function answerDecisions(ask: AgentAsk, answers: readonly AgentAnswer[], by: DecidedBy): Decision[] {
  return ask.questions.flatMap((question, index) => {
    const answer = answers[index] ?? { selected: [] }
    const picked = answer.selected.flatMap((choice) => {
      const option = question.options[choice]
      if (option === undefined) return []
      return [option.description === undefined ? option.label : `${option.label} (${option.description})`]
    })
    const lines = [`${question.header} — ${question.question}`]
    if (picked.length > 0) lines.push(`Answer: ${picked.join('; ')}`)
    if (answer.text !== undefined) lines.push(`${picked.length > 0 ? 'Also' : 'Answer'}: ${answer.text}`)
    return lines.length === 1 ? [] : [decision('answer', by, lines.join('\n'))]
  })
}

/** The findings a review report states as rejected, one per `REJECTED:` line. */
export function readRejections(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(REJECTED_LINE)) {
    const finding = match[1]?.trim()
    if (finding !== undefined && finding !== '') found.push(finding)
  }
  return found
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > DECISION_TEXT_LIMIT ? `${trimmed.slice(0, DECISION_TEXT_LIMIT)}…` : trimmed
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}
