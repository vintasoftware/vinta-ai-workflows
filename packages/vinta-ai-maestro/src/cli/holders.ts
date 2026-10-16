/**
 * What `with` and `gate` say while they wait, and when the daemon refuses
 * them because the run or the session is ending.
 *
 * Shared because the two verbs wait on the same pools and are refused for the
 * same reasons, and an agent that reads one sentence from `with` and a
 * different one from `gate` about the same situation has two things to
 * reconcile instead of one thing to do.
 */
import { z } from 'zod'
import { ResourceHolderSchema, type ResourceHolder } from '../daemon/schemas.ts'

/**
 * Who a wait is queued behind, as one sentence.
 *
 * `holders` is undefined from a daemon that predates naming them, and the old
 * sentence is kept for it. An empty list means nobody holds the pool: the wait
 * is behind other waiters that queued first.
 */
export function heldBy(
  resource: string,
  holders: readonly ResourceHolder[] | undefined,
  self: string,
): string {
  if (holders === undefined) return `"${resource}" is held by another lane.`
  if (holders.length === 0) return `"${resource}" is free, but others queued for it first.`
  const own = holders.some((holder) => holder.node === self)
  const named = holders.map((holder) => describe(holder, self)).join('; ')
  return own
    ? `"${resource}" is held by ${named}. That is a command of yours still running, often one ` +
        'you backgrounded: this is granted when it exits. If it is waiting on this one, stop it.'
    : `"${resource}" is held by ${named}.`
}

function describe(holder: ResourceHolder, self: string): string {
  const who =
    holder.node === self
      ? 'your own phase'
      : `phase ${holder.node}${holder.lane === null ? '' : ` (lane ${holder.lane})`}`
  switch (holder.via) {
    case 'with':
      return `${who} through \`with\`${holder.pid === undefined ? '' : ` (pid ${holder.pid})`}`
    case 'gate':
      return `${who} running gate "${holder.gate ?? '?'}"`
    case 'gate_step':
      return `${who} at its gate step`
  }
}

/**
 * The refusals that are about the run or the session rather than the
 * request, worded as what the agent should do next. Null for any other code.
 *
 * A pause waits for every running phase to reach the end of the step it is
 * in, and an agent turn blocked here is not at the end of anything. So the
 * daemon answers the wait instead, and this is the turn's cue to end.
 */
export function endingRefusal(code: string): string | null {
  switch (code) {
    case 'run_pausing':
      return (
        'the run is pausing, so nothing new is granted. End your turn now and report ' +
        'where you got to: your phase resumes when the run does, and this can be run again then.'
      )
    case 'run_stopping':
      return 'the run is stopping, so nothing new is granted. End your turn now.'
    case 'turn_ended':
      return (
        'the agent session this command was started from has ended, so nothing is waiting ' +
        'for its result. Commands left running after their session ends are not served.'
      )
    case 'holder_not_running':
      return 'this phase is not running, so there is no turn to serve.'
    default:
      return null
  }
}

const ErrorBodySchema = z.looseObject({
  error: z.string().optional(),
  holders: z.array(ResourceHolderSchema).optional(),
})

/** A refusal's code and, where it named them, the holders. Empty on an unreadable body. */
export async function readRefusal(
  response: Response,
): Promise<{ readonly code: string; readonly holders: readonly ResourceHolder[] }> {
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json())
    if (!parsed.success) return { code: '', holders: [] }
    return { code: parsed.data.error ?? '', holders: parsed.data.holders ?? [] }
  } catch {
    // A body that will not parse tells us nothing the status does not.
    return { code: '', holders: [] }
  }
}
