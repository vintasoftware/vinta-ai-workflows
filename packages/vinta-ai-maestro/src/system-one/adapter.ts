/**
 * System One — a fast classifier the daemon consults, never an agent (§17).
 *
 * A System One model answers one kind of question: given a text and a closed
 * set of labels, how likely is each label. A yes/no question is the two-label
 * case. It writes nothing, edits nothing, runs no tools and keeps no session,
 * which is the whole reason it is not a `HarnessAdapter`: there is no turn to
 * admit, no transcript to drain and no lane to sandbox. What it costs is one
 * request, and what it buys is a decision the daemon would otherwise either
 * hard-code or spend a frontier-model turn on.
 *
 * The interface is the seam the operator plugs a vendor into. Nothing above
 * this file knows which classifier answered; everything above it knows only
 * labels and scores.
 *
 * **Scores are normalized here, once.** Adapters hand back whatever their
 * vendor said; `normalizeScores` turns it into a distribution over exactly the
 * labels that were asked about, or refuses it. Every judge downstream compares
 * a sum of scores against a threshold, and that comparison only means
 * something if every adapter's numbers mean the same thing.
 *
 * **The input never leaves this layer in a message.** It is repository
 * content — a diff, a gate log, a shell command — and an error that quoted it
 * would carry it into the daemon log and the journal (§11). Refusals say what
 * went wrong in terms of status codes and shapes, never in terms of what was
 * being judged.
 */

export const YES_NO = ['yes', 'no'] as const

export interface SystemOneQuestion {
  /** What is being asked, in prose the plan or the operator authored. */
  readonly question: string
  /** The closed label set. `YES_NO` for a yes/no question. At least two, distinct. */
  readonly labels: readonly string[]
  /** The text being judged. Repository content — see the module note. */
  readonly input: string
}

/** A probability per asked label, summing to 1. */
export type SystemOneScores = Readonly<Record<string, number>>

/**
 * Why a classifier gave no answer.
 *
 * - `unavailable` — it could not be reached, timed out, or said it was busy.
 *   Nothing about the question is wrong; asking again later might work.
 * - `invalid` — it answered, and the answer was not a distribution over the
 *   labels asked about. Asking again will not help.
 *
 * Every judge decides for itself what an unanswered question means, and the
 * answer differs on purpose: a gate the operator marked advisory passes, a
 * permission request is denied. That decision belongs to the caller, so this
 * type only says which of the two happened.
 */
export type SystemOneRefusalKind = 'unavailable' | 'invalid'

export type SystemOneOutcome =
  | { readonly ok: true; readonly scores: SystemOneScores; readonly latencyMs: number }
  | { readonly ok: false; readonly kind: SystemOneRefusalKind; readonly message: string }

export interface SystemOnePreflight {
  readonly ready: boolean
  /** What the operator does about it. Never a credential. */
  readonly hint?: string
}

export interface SystemOneAdapter {
  /** Registry key, for the journal and the doctor report. Not a vendor's model id. */
  readonly id: string
  /**
   * Whether the adapter can be asked anything at all — configured, with its
   * key present where it needs one. Deliberately cheap and offline: a doctor
   * check that spends a classifier call per run is one that gets turned off.
   */
  preflight(): Promise<SystemOnePreflight>
  /** Never throws. A failure is a refusal, for the reason a spawn is (§6.1). */
  classify(question: SystemOneQuestion): Promise<SystemOneOutcome>
}

/** Whether a label set is the yes/no pair, in either order. */
export function isYesNo(labels: readonly string[]): boolean {
  return labels.length === 2 && labels.includes('yes') && labels.includes('no')
}

/**
 * The vendor's raw answer, as a distribution over exactly `labels`.
 *
 * Accepts the two shapes an adapter's wire contract allows: `{ scores }` for
 * any label set, and `{ yes }` — one probability — for a yes/no question,
 * which is how most binary classifiers report. Anything else is `invalid`.
 *
 * A label the vendor did not mention scores zero; a label nobody asked about
 * is refused rather than dropped, because a classifier answering a different
 * question than the one asked is not one whose other numbers can be trusted.
 * Scores that do not sum to one are rescaled, so a vendor reporting
 * independent sigmoids and one reporting a softmax land on the same scale.
 */
export function normalizeScores(
  labels: readonly string[],
  raw: unknown,
): { readonly ok: true; readonly scores: SystemOneScores } | { readonly ok: false; readonly message: string } {
  if (raw === null || typeof raw !== 'object') return { ok: false, message: 'answer is not an object' }
  const body = raw as Record<string, unknown>

  let given: Record<string, unknown>
  if (body['scores'] !== undefined) {
    if (body['scores'] === null || typeof body['scores'] !== 'object') {
      return { ok: false, message: '`scores` is not an object' }
    }
    given = body['scores'] as Record<string, unknown>
  } else if (body['yes'] !== undefined && isYesNo(labels)) {
    const yes = body['yes']
    if (!isProbability(yes)) return { ok: false, message: '`yes` is not a probability' }
    given = { yes, no: 1 - yes }
  } else {
    return { ok: false, message: 'answer has neither `scores` nor `yes`' }
  }

  const asked = new Set(labels)
  for (const label of Object.keys(given)) {
    if (!asked.has(label)) return { ok: false, message: `answer scores a label that was not asked: ${label}` }
  }
  const values: Record<string, number> = {}
  let total = 0
  for (const label of labels) {
    const value = given[label] ?? 0
    if (!isProbability(value)) return { ok: false, message: `score for ${label} is not a probability` }
    values[label] = value
    total += value
  }
  if (total <= 0) return { ok: false, message: 'every score is zero' }
  const scores: Record<string, number> = {}
  for (const label of labels) scores[label] = (values[label] as number) / total
  return { ok: true, scores }
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * The share of the distribution that falls on `labels` — what every judge
 * compares against its threshold. Summed rather than maxed, so "is this
 * change architectural or a schema change" is one number and not two
 * near-misses either side of a threshold.
 */
export function mass(scores: SystemOneScores, labels: readonly string[]): number {
  let total = 0
  for (const label of new Set(labels)) total += scores[label] ?? 0
  return total
}

/**
 * Checks a question before it is sent. Shared by every adapter so a malformed
 * question is the caller's bug in one place rather than a vendor 400 in three.
 */
export function questionProblem(question: SystemOneQuestion): string | null {
  if (question.question.trim() === '') return 'question is empty'
  if (question.labels.length < 2) return 'a question needs at least two labels'
  if (new Set(question.labels).size !== question.labels.length) return 'labels are not distinct'
  if (question.labels.some((label) => label.trim() === '')) return 'a label is empty'
  return null
}

/** The body every wire adapter sends. One shape, so a shim in front of any vendor is one mapping. */
export function wireRequest(question: SystemOneQuestion): Record<string, unknown> {
  return {
    kind: isYesNo(question.labels) ? 'yes_no' : 'classify',
    question: question.question,
    labels: [...question.labels],
    input: question.input,
  }
}
