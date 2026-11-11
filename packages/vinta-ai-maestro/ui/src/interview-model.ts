/**
 * The interview form's state, as pure functions over the round and a draft.
 *
 * The page keeps a draft per round in the browser — what is picked, typed and
 * asked — and turns it into an `interview-answers.v1` payload on submit. The
 * rules that decide what "answered" means, which decisions still block a
 * submit, and what shape the answers take, live here so they can be asserted
 * without a DOM.
 */
import type {
  Decision,
  Group,
  InterviewAnswers,
  InterviewRound,
  Question,
} from '../../src/interview/document.ts'

/** One decision with the group it belongs to and its place in the round. */
export interface Placed {
  readonly decision: Decision
  readonly group: Group
  /** Position in the round, 0-based. */
  readonly index: number
  /** Position within its group, 0-based. */
  readonly inGroup: number
}

export function flatten(round: InterviewRound): readonly Placed[] {
  const placed: Placed[] = []
  for (const group of round.groups) {
    group.decisions.forEach((decision, inGroup) => {
      placed.push({ decision, group, index: placed.length, inGroup })
    })
  }
  return placed
}

export interface DraftAnswer {
  readonly status: 'answered' | 'waived' | 'skipped'
  readonly values: readonly string[]
  readonly other: string
  readonly text: string
  readonly note: string
}

export interface Draft {
  readonly answers: Readonly<Record<string, DraftAnswer>>
  readonly questions: readonly Question[]
  readonly general_note: string
}

export const EMPTY_ANSWER: DraftAnswer = { status: 'skipped', values: [], other: '', text: '', note: '' }
export const EMPTY_DRAFT: Draft = { answers: {}, questions: [], general_note: '' }

export const answerOf = (draft: Draft, decision: Decision): DraftAnswer =>
  draft.answers[decision.id] ?? EMPTY_ANSWER

/** Whether the "Something else" card is offered: asked for, or the only way to answer. */
export const offersOther = (decision: Decision): boolean =>
  decision.input.allow_other === true ||
  (decision.input.allow_other !== false && (decision.input.options ?? []).length === 0)

export function hasValue(decision: Decision, answer: DraftAnswer): boolean {
  if (decision.input.type === 'text') return answer.text.trim() !== ''
  return answer.values.length > 0 || answer.other.trim() !== ''
}

/** Answered with a value, or explicitly waived. A note alone decides nothing. */
export function isDone(decision: Decision, answer: DraftAnswer): boolean {
  return answer.status === 'waived' || (answer.status === 'answered' && hasValue(decision, answer))
}

/** The decisions a submit is refused for: required and neither answered nor waived. */
export function missing(placed: readonly Placed[], draft: Draft): readonly Placed[] {
  return placed.filter(({ decision }) => decision.required && !isDone(decision, answerOf(draft, decision)))
}

/** The first decision that is not done, else the first: where a reopened draft lands. */
export function firstOpen(placed: readonly Placed[], draft: Draft): number {
  const open = placed.findIndex(({ decision }) => !isDone(decision, answerOf(draft, decision)))
  return open === -1 ? 0 : open
}

export function toAnswers(round: InterviewRound, placed: readonly Placed[], draft: Draft): InterviewAnswers {
  const general = draft.general_note.trim()
  return {
    schema_version: 1,
    round: round.round,
    interview: round.interview.slug,
    answers: placed.map(({ decision }) => {
      const answer = answerOf(draft, decision)
      const status =
        answer.status === 'waived' ? 'waived' : hasValue(decision, answer) ? 'answered' : 'skipped'
      const note = answer.note.trim()
      return {
        decision_id: decision.id,
        status,
        ...(status !== 'answered'
          ? {}
          : decision.input.type === 'text'
            ? { text: answer.text.trim() }
            : {
                values: [...answer.values],
                ...(answer.other.trim() === '' ? {} : { other: answer.other.trim() }),
              }),
        ...(note === '' ? {} : { note }),
      }
    }),
    questions: draft.questions.map((question) => ({
      id: question.id,
      decision_id: question.decision_id ?? null,
      body: question.body,
    })),
    ...(general === '' ? {} : { general_note: general }),
  }
}

/** A submitted round, read back into the draft shape so the same form shows it. */
export function fromAnswers(answers: InterviewAnswers): Draft {
  const drafted: Record<string, DraftAnswer> = {}
  for (const answer of answers.answers) {
    drafted[answer.decision_id] = {
      status: answer.status,
      values: answer.values ?? [],
      other: answer.other ?? '',
      text: answer.text ?? '',
      note: answer.note ?? '',
    }
  }
  return {
    answers: drafted,
    questions: answers.questions ?? [],
    general_note: answers.general_note ?? '',
  }
}

/** Picks an option: a radio replaces, a checkbox toggles. Either clears Other on a radio. */
export function pick(decision: Decision, answer: DraftAnswer, value: string): DraftAnswer {
  if (decision.input.type === 'multi') {
    const values = answer.values.includes(value)
      ? answer.values.filter((v) => v !== value)
      : [...answer.values, value]
    return { ...answer, status: 'answered', values }
  }
  return { ...answer, status: 'answered', values: [value], other: '' }
}

/** Types into Other: on a radio it replaces the picked option. */
export function typeOther(decision: Decision, answer: DraftAnswer, other: string): DraftAnswer {
  const values = decision.input.type === 'multi' || other.trim() === '' ? answer.values : []
  return { ...answer, status: 'answered', other, values }
}

export function waive(decision: Decision, answer: DraftAnswer, waived: boolean): DraftAnswer {
  if (waived) return { ...answer, status: 'waived' }
  return { ...answer, status: hasValue(decision, answer) ? 'answered' : 'skipped' }
}

/** Where the browser keeps a round's draft. Named for the app, keyed by the interview and the round. */
export const draftKey = (slug: string, round: number): string =>
  `vinta-ai-maestro-interview:${slug}:${round}`

/** A fresh id for a question the person asks. Time-based; uniqueness within one draft is all it needs. */
export const questionId = (): string => `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
