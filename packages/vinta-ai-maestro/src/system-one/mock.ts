/**
 * A scripted System One classifier, for tests and for `simulate`.
 *
 * Answers come from a function of the question, so a test can say "anything
 * asked about a gate log is flaky" without caring about call order. Every
 * question is recorded, which is how a test asserts what was — and was not —
 * sent to a classifier.
 */
import {
  normalizeScores,
  questionProblem,
  type SystemOneAdapter,
  type SystemOneOutcome,
  type SystemOnePreflight,
  type SystemOneQuestion,
  type SystemOneRefusalKind,
} from './adapter.ts'

export type MockAnswer =
  | Readonly<Record<string, number>>
  | { readonly refuse: SystemOneRefusalKind }

export class MockSystemOneAdapter implements SystemOneAdapter {
  readonly id: string
  readonly asked: SystemOneQuestion[] = []
  readonly #answer: (question: SystemOneQuestion) => MockAnswer
  readonly #ready: boolean

  constructor(
    answer: (question: SystemOneQuestion) => MockAnswer,
    options: { readonly id?: string; readonly ready?: boolean } = {},
  ) {
    this.#answer = answer
    this.id = options.id ?? 'mock'
    this.#ready = options.ready ?? true
  }

  async preflight(): Promise<SystemOnePreflight> {
    return this.#ready ? { ready: true } : { ready: false, hint: 'mock not ready' }
  }

  async classify(question: SystemOneQuestion): Promise<SystemOneOutcome> {
    this.asked.push(question)
    const problem = questionProblem(question)
    if (problem !== null) return { ok: false, kind: 'invalid', message: problem }
    const answer = this.#answer(question)
    if ('refuse' in answer && typeof answer.refuse === 'string') {
      return { ok: false, kind: answer.refuse as SystemOneRefusalKind, message: `mock refused: ${answer.refuse}` }
    }
    const normalized = normalizeScores(question.labels, { scores: answer })
    if (!normalized.ok) return { ok: false, kind: 'invalid', message: normalized.message }
    return { ok: true, scores: normalized.scores, latencyMs: 0 }
  }
}
