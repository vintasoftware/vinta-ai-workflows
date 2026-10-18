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
 *   the authoritative run afterwards. `--no-cache` runs it anyway and keeps
 *   the new result, for a cause the tree hash cannot see (an ignored file).
 * - **The lease is not skippable.** The daemon acquires the gate's pools around
 *   the run. There is no spelling of this command that takes the machine
 *   without queueing for it.
 * - **The command is not improvisable.** A gate id resolves to the workflow's
 *   declared `cmd`, so "I ran the unit gate" in a report means the command the
 *   gate node will run, not a scoped approximation of it.
 *
 * ## Waiting, which this got wrong once
 *
 * This used to be one awaited `fetch`, on the reasoning that a gate is slow for
 * reasons the client cannot shorten and so the client should simply wait. The
 * reasoning was right and the code did not implement it: Node's `fetch` stops
 * waiting for a response header after five minutes, and this imposed that
 * deadline while its own comment claimed it imposed none.
 *
 * A gate that acquires a capacity-1 semaphore and then runs a test suite is
 * routinely slower than five minutes, so the failure was not rare — it was
 * every run of the slowest gate, on every phase. What the agent read was that
 * the daemon could not be reached, about a gate that was running fine and
 * would cache a green result minutes later. Told a transport lie about work in
 * progress, agents wrote polling loops around a command documented as needing
 * none, and spent turns watching a clock.
 *
 * So the wait is a loop here, as it already is in `with` for the same reason
 * discovered the same way. The daemon answers `202` for "still running" and
 * this asks again.
 *
 * ## Being killed is the ordinary ending
 *
 * An agent harness caps how long one command may run, and a gate may exceed
 * any such cap — the plan's own `timeout_s` for a suite is routinely larger
 * than the harness's whole budget for a command. So this loop expects to be
 * killed partway, and the design point is what happens next: the daemon keeps
 * the gate running, keyed by the phase and the gate id, and the agent's
 * re-invocation attaches to it. Re-running the command is therefore the
 * *correct* move rather than a wasteful one, which matters because it is the
 * move an agent makes anyway.
 *
 * And the refusals carry `with`'s rule for `with`'s reason. Told only that
 * something failed, agents ran the command themselves; a refusal that offers no
 * alternative reads as permission to improvise one. Every line out of here ends
 * on what not to do about it.
 */
import { AgentGateResultSchema, AgentGateWaitingSchema } from '../daemon/schemas.ts'
import {
  MAESTRO_NODE_ENV,
  MAESTRO_RUN_ENV,
  MAESTRO_TOKEN_ENV,
  MAESTRO_TURN_ENV,
  MAESTRO_URL_ENV,
} from '../resources/agent-leases.ts'
import { CODEGEN_GATE_PREFIX } from '../types.ts'
import { endingRefusal, heldBy, readRefusal } from './holders.ts'
import { FAILED, USAGE, type Io } from './io.ts'

export const GATE_USAGE = `usage: vinta-ai-maestro gate <gate-id> [--full] [--no-cache]

  Runs one of this plan's declared gates against your lane and exits with the
  gate's own exit code. The daemon runs it: it holds the gate's resources for
  the duration, so nothing else can be forgotten, and it caches the result
  against your lane's contents, so running the same gate again on an unchanged
  tree costs nothing.

  <gate-id> is a gate the plan declares — your instructions list them by id.
  The command behind the id is the plan's; you cannot pass one, and you should
  not run one by hand instead.

  Waiting is normal: the gate queues for its resources and then runs. Let it.
  If your shell cuts this command short, run it again — the gate keeps running
  on the daemon and the second call attaches to it rather than starting it
  over. Do not build a wait of your own around it, and do not run it inside
  \`vinta-ai-maestro with\`: it takes its own leases.

  If it refuses, that is the answer to the gate, not permission to run the
  command yourself. Report it.

  --full       Run the gate's whole command rather than the form narrowed to
               the files your phase changed. The phase's last gate run, after
               the review approves, is a full one; when it fails, check your
               fix this way.
  --no-cache   Run the gate even though your lane's tracked contents have not
               changed, and keep that result instead of the cached one. For
               when what you fixed is something the cache cannot see: an
               ignored file, a tool's own cache directory, an installed
               dependency, the lane's database.`

export interface GateDeps {
  readonly fetch?: typeof fetch
  /**
   * How the wait pauses between asks. Injected so a test of the *loop* does not
   * pay for the politeness — `with.ts` takes the same for the same reason.
   */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Between asks, once the daemon has said "still running". */
const RETRY_MS = 500

/** How often a long wait says so out loud. */
const NOTICE_MS = 120_000

/** Consecutive transport failures tolerated before the wait gives up. */
const TRANSPORT_ATTEMPTS = 10

export async function gateCommand(
  argv: readonly string[],
  io: Io,
  deps: GateDeps = {},
): Promise<number> {
  // One flag, in either position, so a hand-rolled split beats `parseArgs`:
  // anything else that starts with `-` is still a usage error, as is a second
  // gate id.
  const noCache = argv.includes('--no-cache')
  const full = argv.includes('--full')
  const [gateId, ...rest] = argv.filter((arg) => arg !== '--no-cache' && arg !== '--full')
  if (gateId === undefined || gateId.trim() === '' || gateId.startsWith('-') || rest.length > 0) {
    io.err(GATE_USAGE)
    return USAGE
  }
  return await requestGate(gateId, { noCache, full }, io, deps)
}

export const CODEGEN_USAGE = `usage: vinta-ai-maestro codegen [<step-id>] [--no-cache]

  Runs this plan's codegen steps — or one, with the steps it comes after —
  against your lane: the commands that write its generated files (an API
  schema, the client generated from it, a route tree). The daemon runs them,
  holding whatever resources they need, and exits with the first failing
  step's exit code — \`0\` when every step passed or had nothing to do.

  The files they write are left in your working tree; commit them with your
  work. They are not to be edited by hand: change their sources and run this
  again. The orchestrator also runs every step after your turn, before the
  gates, and commits what they change.

  --no-cache   Run a step even though its inputs and outputs match a run
               it has already recorded.`

/**
 * `vinta-ai-maestro codegen [<step>]` — the plan's codegen steps, run by the
 * daemon in this turn's lane. The gate verb's transport, wait loop and
 * refusals, under the `codegen:` gate id the broker answers for steps.
 */
export async function codegenCommand(
  argv: readonly string[],
  io: Io,
  deps: GateDeps = {},
): Promise<number> {
  const noCache = argv.includes('--no-cache')
  const [stepId, ...rest] = argv.filter((arg) => arg !== '--no-cache')
  if ((stepId !== undefined && (stepId.trim() === '' || stepId.startsWith('-'))) || rest.length > 0) {
    io.err(CODEGEN_USAGE)
    return USAGE
  }
  return await requestGate(`${CODEGEN_GATE_PREFIX}${stepId ?? ''}`, { noCache, full: false }, io, deps)
}

async function requestGate(
  gateId: string,
  flags: { readonly noCache: boolean; readonly full: boolean },
  io: Io,
  deps: GateDeps,
): Promise<number> {
  const { noCache, full } = flags
  const url = process.env[MAESTRO_URL_ENV]
  const token = process.env[MAESTRO_TOKEN_ENV]
  const runId = process.env[MAESTRO_RUN_ENV]
  const holderNode = process.env[MAESTRO_NODE_ENV]
  if (url === undefined || token === undefined || runId === undefined || holderNode === undefined) {
    io.err('vinta-ai-maestro: no live run is available for this command')
    return FAILED
  }

  const request = deps.fetch ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const endpoint = `${url}/api/runs/${encodeURIComponent(runId)}/gates`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const turn = process.env[MAESTRO_TURN_ENV]
  // Sent on every hop, though only the hop that starts the run reads it: a
  // re-invocation after a kill attaches to the run already going, which is
  // the fresh one this asked for.
  const body = JSON.stringify({
    gate: gateId,
    holderNode,
    ...(noCache ? { noCache: true } : {}),
    ...(full ? { full: true } : {}),
    ...(turn === undefined ? {} : { turn }),
  })

  let transportFailures = 0
  let announcedAt: number | null = null
  let announced = ''

  for (;;) {
    let response: Response
    try {
      response = await request(endpoint, { method: 'POST', headers, body })
      transportFailures = 0
    } catch {
      // A daemon that is restarting is worth waiting through; one that is gone
      // is not, and an unbounded retry against it would hang the whole turn.
      transportFailures += 1
      if (transportFailures >= TRANSPORT_ATTEMPTS) {
        io.err(
          `vinta-ai-maestro: could not reach the daemon to run "${gateId}". ${DO_NOT_WORK_AROUND}`,
        )
        return FAILED
      }
      await sleep(RETRY_MS)
      continue
    }

    // Still running. Checked before `ok`, because `202` is the one 2xx that is
    // not an answer — and treating it as one would read an empty result as a
    // gate that passed.
    if (response.status === 202) {
      // Said once, again when what it is waiting on changes, and otherwise
      // only occasionally: a transcript should show a turn waiting rather than
      // a turn that stopped saying anything. "Running" used to be printed for
      // a gate that was only queued, which sent a reader looking at a slow
      // suite instead of at whatever held its pool. The second line is also
      // where an agent reads that being cut off here costs it nothing.
      const line = waitingLine(gateId, holderNode, await response.json().catch(() => null))
      if (announcedAt === null) {
        io.err(`vinta-ai-maestro: ${line}`)
        io.err(
          'vinta-ai-maestro: if this command is cut short, run it again — the gate keeps ' +
            'its place and the next call attaches to it.',
        )
        announced = line
        announcedAt = Date.now()
      } else if (line !== announced) {
        io.err(`vinta-ai-maestro: ${line}`)
        announced = line
        announcedAt = Date.now()
      } else if (Date.now() - announcedAt >= NOTICE_MS) {
        io.err(`vinta-ai-maestro: still waiting for gate ${gateId}.`)
        announcedAt = Date.now()
      }
      await sleep(RETRY_MS)
      continue
    }

    if (!response.ok) {
      io.err(`vinta-ai-maestro: ${await refusal(response, gateId)} ${DO_NOT_WORK_AROUND}`)
      return FAILED
    }

    const parsed = AgentGateResultSchema.safeParse(await response.json())
    if (!parsed.success) {
      io.err(
        `vinta-ai-maestro: the daemon returned an unreadable gate result. ${DO_NOT_WORK_AROUND}`,
      )
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
    // The one case a cached answer can be wrong, said where it is read. A red
    // replayed after the agent removed its cause — a stale type-checker cache,
    // an ignored build directory — sent twenty fixers in a row to find nothing
    // to fix, because nothing in the lane's tracked contents had moved.
    if (cached && exitCode !== 0) {
      io.err(
        `vinta-ai-maestro: if what you changed is not tracked by git (an ignored file, a cache ` +
          `directory, an installed dependency), run "${rerunLine(gateId)} --no-cache".`,
      )
    }
    io.err(`vinta-ai-maestro: its output is at ${logRef}`)
    return exitCode
  }
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

/** The command that asks for this gate again: `gate <id>`, or `codegen [<step>]`. */
function rerunLine(gateId: string): string {
  if (!gateId.startsWith(CODEGEN_GATE_PREFIX)) return `vinta-ai-maestro gate ${gateId}`
  const step = gateId.slice(CODEGEN_GATE_PREFIX.length)
  return step === '' ? 'vinta-ai-maestro codegen' : `vinta-ai-maestro codegen ${step}`
}

/** What a `202` says the gate is doing: queued behind someone, or running. */
function waitingLine(gateId: string, self: string, body: unknown): string {
  const parsed = AgentGateWaitingSchema.safeParse(body)
  // A daemon that predates the state only answers `202` once the gate is
  // its own, so "running" is the old sentence and the honest default.
  if (!parsed.success || parsed.data.state !== 'queued') {
    return `gate ${gateId} is running. Waiting for it.`
  }
  const holders = parsed.data.holders
  if (holders === undefined) return `gate ${gateId} is queued for its resources. Waiting for them.`
  const resources = [...new Set(holders.map((holder) => holder.resource))]
  const held =
    resources.length === 0
      ? 'its resources are free, but others queued for them first.'
      : resources
          .map((resource) =>
            heldBy(
              resource,
              holders.filter((holder) => holder.resource === resource),
              self,
            ),
          )
          .join(' ')
  return `gate ${gateId} is queued, not running yet: ${held}`
}

/** What a refusal means, in terms of the thing the reader can change. */
async function refusal(response: Response, gateId: string): Promise<string> {
  const { code, holders } = await readRefusal(response)
  const ending = endingRefusal(code)
  if (ending !== null) return ending

  if (code.startsWith('holds_required:')) {
    const resource = code.slice('holds_required:'.length)
    const pids = holders.flatMap((holder) => (holder.pid === undefined ? [] : [holder.pid]))
    const by = pids.length === 0 ? '' : ` (pid ${pids.join(', ')})`
    return `your phase already holds "${resource}" through \`vinta-ai-maestro with\`${by}, and gate "${gateId}" needs it. A gate takes its own leases: run \`vinta-ai-maestro gate ${gateId}\` on its own, not inside \`with\`, and let any \`with\` you started on "${resource}" finish first.`
  }
  if (code.startsWith('earlier_gate_red:')) {
    const red = code.slice('earlier_gate_red:'.length)
    return `gate "${red}" is red on this tree and comes before "${gateId}". Fix it and run "${red}" again first — "${gateId}" would run against a tree that already failed. If its cause was outside git's view, run "${red}" with --no-cache.`
  }
  switch (code) {
    case 'unknown_gate':
      return gateId.startsWith(CODEGEN_GATE_PREFIX)
        ? gateId === CODEGEN_GATE_PREFIX
          ? 'this plan declares no codegen steps.'
          : `this plan declares no codegen step called "${gateId.slice(CODEGEN_GATE_PREFIX.length)}" — run \`vinta-ai-maestro codegen\` for all of them.`
        : `this plan declares no gate called "${gateId}" — the ones it does are listed in your instructions.`
    case 'invalid_holder':
      return 'this turn is not attributed to a phase of the running plan.'
    case 'no_lane':
      return 'this phase has no lane assigned, so there is nothing to run the gate against.'
    case 'gate_needs_lane':
      return `gate "${gateId}" requires the lane resource your own phase is holding, so it cannot be run from inside this turn — the gate node runs it after your turn ends.`
    case 'judge_gate':
      return `gate "${gateId}" is judged by a classifier, which the gate node asks once your turn ends — there is nothing to run from inside it.`
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
