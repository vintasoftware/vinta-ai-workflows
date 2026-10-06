/**
 * Who is acting on a live run, and the one refusal that depends on it.
 *
 * The run coordinator reaches the run through the same API an operator does,
 * with a token of its own (`daemon/server.ts`), so every operation it makes is
 * attributed to it in the journal and every limit on it is enforced where the
 * operation lands rather than in its brief.
 */
import type { Actor } from '../journal/events.ts'

export type { Actor }

/** The coordinator tried something only a person may do. Carries a fixed sentence, never agent prose. */
export class CoordinatorForbidden extends Error {
  constructor(readonly reason: string) {
    super(`not the run coordinator's to do: ${reason}`)
    this.name = 'CoordinatorForbidden'
  }
}

/**
 * Steering text as the agent receives it. The coordinator's words are labelled
 * as its own: an implementer told "stop rerunning the suite" should know a
 * colleague said it, not the person who owns the run.
 */
export function attributed(text: string, actor: Actor): string {
  return actor === 'coordinator' ? `From the run coordinator: ${text}` : text
}
