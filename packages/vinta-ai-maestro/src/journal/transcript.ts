/**
 * What a line of `transcript.jsonl` is, beyond the harness event inside it.
 *
 * A phase's transcript already held every agent that worked on it — the
 * scheduler appends to `state.node.id` for every spawn, whatever the role — so
 * an implementer's output, the reviewer's, and three fix rounds' all landed in
 * one file, in order, indistinguishable. Reading it back, the one question you
 * could not answer was *who said this*, which is the question a transcript of
 * four agents is mostly for.
 *
 * The role was in scope at the append and simply not written down. So each line
 * carries an `Attribution` now, and the two things that were missing from the
 * file entirely — gate runs — are entries in it.
 *
 * Two constraints shaped the shape.
 *
 * - **Sibling keys, not an envelope.** `{ ...event, by }` rather than
 *   `{ event, by }`, because a transcript is append-only and years of lines
 *   already exist without it. Every reader — the API, the monitor's digest
 *   scan, the browser — keeps working on the old lines and gets more from the
 *   new ones. An envelope would have made every line before this commit
 *   unreadable, which for a record of what happened is not a migration, it is
 *   a deletion.
 * - **Identifiers only (§11).** A role, a slot, a gate id, an exit code. The
 *   gate's *output* is not here: it is in `gateLogPath`'s file, which the node
 *   endpoint already serves, and copying it into the transcript would put a
 *   second copy of the repository's test output in a second place.
 */
import type { AgentEvent } from '../harness/adapter.ts'

/**
 * Who produced a line.
 *
 * `role` is deliberately a plain string rather than the `AGENT_ROLES` union.
 * The pipeline is data (`types.ts`), a workflow may name a role this build has
 * never heard of, and a transcript written by a newer daemon must stay readable
 * by an older browser. The two roles here that are not agent roles at all —
 * `gate` and `monitor` — are the same argument from the other direction.
 */
export interface Attribution {
  readonly role: string
  /** The session slot the turn ran on (§15). Absent where a turn has none. */
  readonly slot?: string
}

/**
 * A gate run, as the transcript records it.
 *
 * Not an `AgentEvent` and deliberately not smuggled in as one. The tempting
 * cheap version is a `tool_use` named `gate:unit`, which would need no new kind
 * anywhere — and would be a lie in the record about what ran, in the one file
 * whose whole job is to say what ran.
 */
export interface GateRunEvent {
  readonly type: 'gate_run'
  readonly gate: string
  readonly exitCode: number
  /** The runner's own token: `passed`, `failed`, `timeout`. */
  readonly status: string
  /** A cached verdict did not run anything, and the row should not imply it did. */
  readonly cached: boolean
}

/** One line of `transcript.jsonl`. */
export type TranscriptEntry = (AgentEvent | GateRunEvent) & { readonly by?: Attribution }

/** The roles the daemon itself writes, for the ones no workflow declares. */
export const GATE_ROLE = 'gate'
export const MONITOR_ROLE = 'monitor'

/**
 * The operator, and the one attribution that is not the turn's.
 *
 * §7: the operator's own steering is never attributed to the agent. That is
 * easy to get wrong here, because steering does not arrive out of band — the
 * adapter injects it and *echoes it back* as a `user_message` on the session's
 * own event stream, so it reaches the append inside the same loop as everything
 * the model said, and stamping the loop's role would file the operator's words
 * under the implementer that received them.
 */
export const OPERATOR_ROLE = 'operator'

/** Whether an entry is the operator's rather than the turn it arrived in. */
export function attribute(event: { readonly type: string }, turn: Attribution): Attribution {
  return event.type === 'user_message' ? { role: OPERATOR_ROLE } : turn
}
