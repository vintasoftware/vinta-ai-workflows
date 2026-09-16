/**
 * `vinta-ai-maestro gate <gate-id>` — a declared gate, run by the daemon.
 *
 * `with` was the first half of this. It gave an agent's inner loop a route into
 * the scheduler's pools, and it works, but only for an agent that remembers to
 * use it: the command is still the agent's to type, still invisible to
 * `GateCache`, and the four gate runs a phase makes before the `gate` node ever
 * sees one were four full test suites against a tree that had not moved.
 *
 * This verb is the other half. The agent names a gate rather than a command,
 * and everything else happens on the daemon's side — which is what makes the
 * three properties true rather than requested:
 *
 * - **The result is cached.** Keyed on `(gate id, lane tree hash)`, the same
 *   key and the same database the `gate` node reads. The reviewer running
 *   `unit` after the implementer ran it on the same tree is a lookup, and so is
 *   the authoritative run afterwards.
 * - **The lease is not skippable.** The daemon acquires the gate's pools around
 *   the run. There is no spelling of this command that takes the machine
 *   without queueing for it.
 * - **The command is not improvisable.** A gate id resolves to the workflow's
 *   declared `cmd`, so "I ran the unit gate" in a report means the command the
 *   gate node will run, not a scoped approximation of it.
 *
 * Waiting is client-side for `with`'s reason, in a milder form: a gate holds
 * its pools and then runs a test suite, so a response can be many minutes away
 * and no timeout on this side could tell slow from broken. There is nothing to
 * poll here — the daemon answers once, when the gate is done — so this simply
 * does not impose a deadline of its own.
 *
 * And the refusals carry `with`'s rule for `with`'s reason. Told only that
 * something failed, agents ran the command themselves; a refusal that offers no
 * alternative reads as permission to improvise one. Every line out of here ends
 * on what not to do about it.
 */
import { AgentGateResultSchema } from '../daemon/schemas.ts'
import {
  MAESTRO_NODE_ENV,
  MAESTRO_RUN_ENV,
  MAESTRO_TOKEN_ENV,
  MAESTRO_URL_ENV,
} from '../resources/agent-leases.ts'
import { FAILED, USAGE, type Io } from './io.ts'

export const GATE_USAGE = `usage: vinta-ai-maestro gate <gate-id>

  Runs one of this plan's declared gates against your lane and exits with the
  gate's own exit code. The daemon runs it: it holds the gate's resources for
  the duration, so nothing else can be forgotten, and it caches the result
  against your lane's contents, so running the same gate again on an unchanged
  tree costs nothing.

  <gate-id> is a gate the plan declares — your instructions list them by id.
  The command behind the id is the plan's; you cannot pass one, and you should
  not run one by hand instead.

  Waiting is normal: the gate queues for its resources and then runs. Let it.

  If it refuses, that is the answer to the gate, not permission to run the
  command yourself. Report it.`

export interface GateDeps {
  readonly fetch?: typeof fetch
}

export async function gateCommand(
  argv: readonly string[],
  io: Io,
  deps: GateDeps = {},
): Promise<number> {
  const [gateId, ...rest] = argv
  if (gateId === undefined || gateId.trim() === '' || rest.length > 0) {
    io.err(GATE_USAGE)
    return USAGE
  }

  const url = process.env[MAESTRO_URL_ENV]
  const token = process.env[MAESTRO_TOKEN_ENV]
  const runId = process.env[MAESTRO_RUN_ENV]
  const holderNode = process.env[MAESTRO_NODE_ENV]
  if (url === undefined || token === undefined || runId === undefined || holderNode === undefined) {
    io.err('vinta-ai-maestro: no live run is available for this command')
    return FAILED
  }

  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(
      `${url}/api/runs/${encodeURIComponent(runId)}/gates`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ gate: gateId, holderNode }),
      },
    )
  } catch {
    io.err(`vinta-ai-maestro: could not reach the daemon to run "${gateId}". ${DO_NOT_WORK_AROUND}`)
    return FAILED
  }

  if (!response.ok) {
    io.err(`vinta-ai-maestro: ${await refusal(response, gateId)} ${DO_NOT_WORK_AROUND}`)
    return FAILED
  }

  const parsed = AgentGateResultSchema.safeParse(await response.json())
  if (!parsed.success) {
    io.err(`vinta-ai-maestro: the daemon returned an unreadable gate result. ${DO_NOT_WORK_AROUND}`)
    return FAILED
  }

  // Identifiers and a path (§11). The gate's output is in the log file and is
  // repository content verbatim, so it is pointed at rather than echoed —
  // which is also the more useful thing, since the agent can read the file and
  // a truncated tail on stdout would have to be trusted to contain the failure.
  const { status, exitCode, cached, logRef } = parsed.data
  io.err(
    `vinta-ai-maestro: gate ${gateId} ${status}` +
      ` (exit ${exitCode})${cached ? ', from cache — your lane is unchanged since it last ran' : ''}.`,
  )
  io.err(`vinta-ai-maestro: its output is at ${logRef}`)
  return exitCode
}

/**
 * The line every refusal ends on — `with.ts`'s, for the same observed reason.
 *
 * An agent refused a lease ran the command unleased, because the error named no
 * alternative. A gate is the same shape of mistake with a worse outcome: the
 * agent runs some command it believes is the gate, it is not the gate, and the
 * report says a gate passed that nothing ran.
 */
const DO_NOT_WORK_AROUND =
  'Do not run the gate command yourself instead. Report this — a gate you ran ' +
  'by hand is not the gate, and it takes the machine without queueing for it.'

/** What a refusal means, in terms of the thing the reader can change. */
async function refusal(response: Response, gateId: string): Promise<string> {
  let code = ''
  try {
    const body: unknown = await response.json()
    const named = (body as { error?: unknown } | null)?.error
    if (typeof named === 'string') code = named
  } catch {
    // A body that will not parse tells us nothing the status does not.
  }

  switch (code) {
    case 'unknown_gate':
      return `this plan declares no gate called "${gateId}" — the ones it does are listed in your instructions.`
    case 'invalid_holder':
      return 'this turn is not attributed to a phase of the running plan.'
    case 'no_lane':
      return 'this phase has no lane assigned, so there is nothing to run the gate against.'
    case 'gate_needs_lane':
      return `gate "${gateId}" requires the lane resource your own phase is holding, so it cannot be run from inside this turn — the gate node runs it after your turn ends.`
    case 'run_not_live':
      return 'the run is no longer live, so it can run nothing.'
    case 'gates_unavailable':
      return 'this run was started by a host that cannot run gates on your behalf.'
    case 'unauthorized':
      return 'the daemon rejected this turn’s token.'
    default:
      return `the gate could not be run (${response.status}).`
  }
}
