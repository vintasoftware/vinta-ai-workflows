/**
 * Whether a turn that ended on an error ended on the *infrastructure's* error.
 *
 * A vendor that refuses a turn in words the adapter recognises is a refusal
 * (`TurnRefusal`), parked once per harness by admission control. What this
 * catches is the rest: a turn whose stream ended on `API Error: Can't reach the
 * API server (ENOTFOUND)`, an expired OAuth token, a gateway's 503 — said in
 * an error line or the agent's last words rather than in a frame the adapter
 * classifies. One observed run spent three hours of a network outage charging
 * each of those to the phase that happened to be running: failed turns, failed
 * attempts, and a phase parked as "failed during setup 6 times in a row" for a
 * DNS server that was down. None of it was the phase's.
 *
 * So the scheduler reads a turn's error text through this before it counts
 * anything. `network` is an outage: the harness parks with backoff, every
 * phase on it waits in place, and nothing is charged. `auth` is a login that
 * lapsed: the harness holds it until the operator says it is logged in again.
 *
 * Patterns run on lowercased text, and only the token comes back: the prose is
 * vendor output and is not carried (§11).
 */

export type OutageCause = 'network' | 'auth'

/** Checked first: a 401 inside a gateway error page is still a login problem. */
const AUTH: readonly RegExp[] = [
  /oauth (?:access )?token (?:has )?expired/,
  /\b401\b/,
  /invalid (?:api[ _-]?key|bearer token|x-api-key)/,
  /authentication[_ ]error/,
  /please run \/login/,
  /not logged in/,
]

const NETWORK: readonly RegExp[] = [
  /\benotfound\b/,
  /\beai_again\b/,
  /\beconnrefused\b/,
  /\beconnreset\b/,
  /\betimedout\b/,
  /\benetunreach\b/,
  /can'?t reach the api/,
  /unable to connect to (?:the )?api/,
  /fetch failed/,
  /network error/,
  /socket hang up/,
  /upstream-unavailable/,
  /\boverloaded\b/,
  /api error:? (?:5\d\d|529)\b/,
  /\b(?:500|502|503|504|529)\b[^\n]{0,40}(?:internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)/,
]

/** What kind of infrastructure failure `text` reports, or null when it reports none. */
export function infrastructureCause(text: string): OutageCause | null {
  if (text === '') return null
  const lower = text.toLowerCase()
  if (AUTH.some((pattern) => pattern.test(lower))) return 'auth'
  if (NETWORK.some((pattern) => pattern.test(lower))) return 'network'
  return null
}

/**
 * The part of a turn's output worth reading for it: error lines, and assistant
 * text that is the CLI's own `API Error:` report rather than the agent's prose.
 * An agent writing about a 401 in the code it is fixing must not park a run.
 */
export function isInfrastructureLine(event: { readonly type: string; readonly text?: string; readonly message?: string }): string | null {
  if (event.type === 'error' && typeof event.message === 'string') return event.message
  if (event.type === 'assistant_text' && typeof event.text === 'string' && /^\s*api error\b/i.test(event.text)) {
    return event.text
  }
  return null
}
