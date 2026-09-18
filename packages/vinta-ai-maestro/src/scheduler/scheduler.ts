/**
 * The scheduler: continuous DAG dispatch over lanes, pools and pipelines (§6).
 *
 * It composes units that already exist and adds exactly one thing — *when*
 * work starts and stops. Graph shape comes from `graph.ts`, capacity from
 * `ResourcePools`, vendor backpressure from `AdmissionControl`, per-node
 * control flow from `PipelineRun`, every side effect from the injected
 * `EffectExecutor`, and what an agent is told from `src/prompts` — selected by
 * the effect's own `prompt_template`. Nothing about git, prompt wording or
 * agent semantics lives here.
 *
 * The rules from §6 that this file exists to enforce:
 *
 * - **A node's start gate is its own dependency set**, not its wave. Waves are
 *   the durable spine — resume anchor, merge target, reporting unit — and they
 *   are reported, never waited on.
 * - **All-or-nothing acquisition in canonical order.** Every acquisition is one
 *   `pools.acquire` call; the pool normalizes the order and grants the whole
 *   set or none of it. The only two acquisition moments a node has are its lane
 *   at dispatch and its gate pools when a gate runs — in that order, for every
 *   node, which is what makes the wait-for graph acyclic.
 * - **A node holds its lane while queued for a gate.** An idle lane is just
 *   disk, and `capacity(lane) > capacity(test-suite)` is the healthy shape.
 *   All three edges of that acquisition — requested, granted, released — are
 *   journalled as `gate_pool`, because "is gate capacity the constraint, or
 *   lane count" (§13.3) is answerable only from the wait and the occupancy,
 *   and `leases` keeps neither past the release.
 * - **Never hold a resource across `await_human`.** A suspended node keeps its
 *   lane — the human is being asked about the work in that lane — and its gate
 *   pools go back immediately.
 * - **Spawn refused ⇒ release everything, then wait.** A refusal unwinds the
 *   node's attempt through `CapacityRetry`, which releases the lane *before*
 *   the wait. Holding a lane while blocked on a shared quota is how every lane
 *   ends up held by a node that cannot start.
 * - **Failure containment.** A failed node blocks its transitive dependents;
 *   in-flight nodes finish rather than being killed.
 * - **Deadlock detection that excludes capacity waits.** A cycle and a resource
 *   requirement no pool can meet are static facts, so they are found before the
 *   run starts. What remains at runtime — nothing live, something pending — is
 *   checked against the harness wake times (§6.1) and is only a deadlock when
 *   no harness is parked.
 *
 * The §9 operations live here for the same reason: they are *when* work stops
 * and starts, told to the run from outside. Each one needs the live
 * `AgentSession` the spawn is holding, so the scheduler keeps a one-slot
 * registry per node that opens when admission grants a session and closes when
 * its stream ends. What each operation did is journalled — the operator's own
 * steering text included, as event payload and never as a log field.
 *
 * §9's fifth operation, take over, is that same slot seen from outside: while
 * it is open the node is offered to the daemon's PTY registry, and the offer is
 * withdrawn with it. That is the whole reason an operator's terminal can never
 * reach a session that has already ended or a lane the node has handed on.
 *
 * A run that is *picked up* rather than started enters through the same door:
 * `resumeFrom` seeds the node states from the journal's own rows in the
 * constructor, and nothing past it knows the difference — the loop, the
 * precheck and the deadlock detector all see an ordinary graph that happens to
 * have some nodes already `done`. Only `done` survives a kill (`#seed`).
 *
 * **Never spinning is structural, not a timer.** The loop waits on a promise
 * that only a state change resolves; a capacity wait is one harness timer owned
 * by admission control. There is no poll interval anywhere in this file.
 *
 * Two host conventions the interpreter deliberately cannot own (§5.2), read
 * from data rather than from author-chosen state ids:
 *
 * - a final state's `data.outcome === 'failed'` means the node failed;
 * - a fix round is a `spawn_agent` whose `role` is `fixer`, which is what this
 *   file counts into the `fix_rounds` fact the interpreter reads.
 *
 * Identifiers only in every journalled field and every error message. Agent
 * output goes to the transcript file, which is where §5.3 puts it.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AdmissionControl } from '../admission/admission.ts'
import { type PtyRegistry, takeovers } from '../daemon/pty.ts'
import { computeWaves, findCycle, transitiveDependents } from '../graph.ts'
import { gitLines } from '../integration/git.ts'
import type { AgentSession, AgentTask, HarnessAdapter } from '../harness/adapter.ts'
import type {
  GatePoolPhase,
  HumanQuestion,
  NodeStatus,
  OperatorDelivery,
  OperatorOp,
} from '../journal/events.ts'
import type { Journal, NodeRow } from '../journal/journal.ts'
import { attribute, type Attribution } from '../journal/transcript.ts'
import { GitCommandError } from '../integration/git.ts'
import { errorFields, errorKind, nullLogger, type Logger } from '../log/index.ts'
import type { EffectExecutor, EffectInvocation, EffectOutcome } from '../pipeline/effects.ts'
import type { GuardContext } from '../pipeline/guard.ts'
import {
  createPipelineRun,
  PipelineStuckError,
  type PipelineRun,
  type StepResult,
} from '../pipeline/interpreter.ts'
import { LaneRecycleError } from '../lanes/pool.ts'
import { pipelineFor } from '../pipeline/standard.ts'
import { MAESTRO_NODE_ENV, MAESTRO_URL_ENV } from '../resources/agent-leases.ts'
import {
  assignCrew,
  assignReviewer,
  type CrewDecision,
  implementers,
  laneHolders,
  type ReviewDecision,
} from './crew.ts'
import { planSession, type SessionEntry, type SessionPlan } from './sessions.ts'
import { composeSpawnPrompt, PromptError, type Reorientation } from '../prompts/index.ts'
import type { Lease, ResourcePools } from '../resources/pools.ts'
import type { Node, Pipeline, SideEffect, Workflow } from '../types.ts'

/** The pool a node is dispatched into. Required of every workflow (§5.1). */
const LANE = 'lane'

/** The answers `#offerRetry` understands. `retry with ` carries a member id. */
const RETRY = 'retry'
const STOP = 'stop'
const RETRY_WITH = 'retry with '

export interface SchedulerOptions {
  /** The frozen snapshot the run executes. Its `run_started` is already journalled. */
  readonly workflow: Workflow
  readonly runId: string
  readonly journal: Journal
  readonly pools: ResourcePools
  readonly admission: AdmissionControl
  /** By `adapter.id`, which is what a node's `harness` resolves to. */
  readonly adapters: Readonly<Record<string, HarnessAdapter>>
  /** Every effect body. The scheduler owns resources and admission, not verbs. */
  readonly executor: EffectExecutor
  /** Where lane worktrees live — `LanePool`'s `poolRoot`. */
  readonly laneRoot: string
  /**
   * The journal's node rows for this run — `journal.nodes(runId)` — when the
   * run is being **picked up** rather than started.
   *
   * A process that was killed (terminal closed, machine rebooted) leaves the
   * journal complete and nothing else: its sessions, its leases and its
   * pipeline positions died with it. So what this restores is the one fact that
   * outlives the process — which phases finished — and every node that had not
   * finished starts its pipeline again from the beginning, in whatever lane it
   * is next given. `#seed` is where that reading is spelled out.
   *
   * The rows are passed in rather than read here so the constructor stays free
   * of I/O, and because whoever decided to resume has already read them: the
   * decision *is* that read.
   *
   * Absent for a fresh run, which seeds every node `pending` — what every run
   * did before this existed.
   */
  readonly resumeFrom?: readonly NodeRow[]
  /**
   * One lane slot's environment, by slot name — `LanePool`'s `Lane.env`.
   *
   * Everything that makes a lane isolated is in here: its compose project, the
   * override that strips the ports its siblings also publish, its forked
   * connection strings. It reached gates from the start and did not reach
   * agents, which made the isolation true of the cheap half of a run and false
   * of the half that actually boots containers.
   *
   * Absent for a host that owns its own lanes, and then a task carries no
   * environment and a child inherits the daemon's — which is exactly the old
   * behaviour, for a host that never had a `Lane` to ask about.
   */
  readonly laneEnv?: (laneName: string) => Readonly<Record<string, string>>
  /**
   * What a node's failure does.
   *
   * `retry` is the default: up to `retries` cold re-attempts, and then the
   * operator is asked. The failures this system actually produces are
   * overwhelmingly environmental — a permission wall, a stale session, a gate
   * whose service was not up — and those recover on a second attempt for the
   * price of one phase. A deterministic failure fails again identically, which
   * is why the budget is small and why the ask comes after it rather than
   * instead of it.
   *
   * `ask` skips the automatic attempts and parks immediately. `stop` is the
   * old behaviour — fail, block the dependents, finish — and is the right
   * choice for CI, because everything else eventually *waits*, and nobody is
   * watching there.
   */
  readonly onFailure?: 'stop' | 'retry' | 'ask'
  /**
   * How many automatic attempts a failed node gets under `retry`.
   *
   * One, because the second attempt is where the value is: it catches
   * everything transient, and a third rarely converts a failure a second did
   * not. Raising it multiplies the cost of a phase that is simply broken.
   */
  readonly retries?: number
  /**
   * Returns a lane slot to a clean state before another node is given it —
   * `LanePool.recycle`, which resets what it can and re-provisions what it
   * cannot (§8). Absent for a host that injected its own executor: such a host
   * owns its lanes, and a slot it never provisioned is not the scheduler's to
   * reset.
   */
  readonly recycleLane?: (name: string) => Promise<void>
  /**
   * What changed under a member's worktree since its session last looked.
   *
   * An implementer keeps one directory for the whole run, so continuing its
   * session across a phase is safe exactly as far as the agent knows which
   * files moved while it was away. This is the seam that answers that.
   *
   * Absent for a host that injected its own executor: such a host owns its
   * lanes and may have no git to ask. Without it a staffed run still works, and
   * a continuation carries no file list — which `#reorientation` reports as
   * unknown rather than as an untouched tree.
   */
  readonly laneDelta?: (lane: string, sinceRef: string) => Promise<readonly string[]>
  /**
   * Where §9's takeover targets are offered — the same registry the daemon's
   * PTY channel consults. Injectable so a test owns its own; the process-wide
   * one by default, which is the instance `EventStream` also defaults to, so
   * production wiring is a composition rather than a flag.
   */
  readonly takeovers?: PtyRegistry
  /**
   * The daemon's own log. Absent in tests, and then nothing is written.
   *
   * It records the loop's *decisions*, which the journal deliberately does
   * not. The journal holds what a run did — a node's statuses, its crew, its
   * gates — because those are facts about the run and are folded into the
   * projections the UI reads. Why the loop chose to do it is not a fact about
   * the run; it is a fact about this process, and the two questions an
   * operator asks — "why has nothing started for six minutes" and "what was
   * the scheduler doing when it died" — are not answerable from either the
   * projections or a transcript.
   */
  readonly logger?: Logger
}

/** Why a run stopped short. Node, pool and harness ids only. */
export type RunStop =
  | { readonly kind: 'cycle'; readonly cycle: readonly string[] }
  | { readonly kind: 'unsatisfiable'; readonly nodeId: string; readonly resource: string }
  | { readonly kind: 'deadlock'; readonly pending: readonly string[] }

export interface RunReport {
  /** `completed` means every node settled, not that every node passed. */
  readonly status: 'completed' | 'stopped'
  readonly stop?: RunStop
  readonly statuses: Readonly<Record<string, NodeStatus>>
  /** The durable spine, for reporting and for the merge target. */
  readonly waves: Readonly<Record<string, number>>
  /** Why each failed node failed. Identifiers only. */
  readonly failures: Readonly<Record<string, string>>
  /** Loop turns taken. Bounded by state changes — a spin would show up here. */
  readonly iterations: number
}

/**
 * The failure reason, with the attempts behind it.
 *
 * A phase that failed once and a phase that failed twice are different news,
 * and without this the second is invisible: the retry leaves no event of its
 * own, only a second session and a second transcript, which nobody reads to
 * find out how hard the scheduler tried.
 */
function attempted(reason: string, state: NodeState): string {
  return state.autoRetries === 0 ? reason : `${reason} (after ${state.autoRetries + 1} attempts)`
}

/** Where a node's pipeline stopped, and by which edge. `via` is absent on a start-state final. */
interface Settled {
  readonly outcome: 'done' | 'failed'
  readonly state: string
  readonly via?: string
}

/**
 * Why a pipeline that settled badly settled badly, in identifiers.
 *
 * **What this replaces.** The whole reason used to be `pipeline ended in state
 * "failed"` — the name of a state, and nothing else. A real 14-hour run wrote
 * that same sentence three times, and it answered none of the questions an
 * operator has at that point: was a gate red, did the reviewer keep saying no,
 * was the fix budget spent. The event this fills in was itself added to close
 * the same complaint one level out — a failed attempt used to leave no record
 * at all — so leaving it saying only *that* a phase failed would have moved
 * the hole rather than closed it.
 *
 * The clauses are the facts the scheduler is holding at that moment and no
 * more. Each is omitted when it is absent, and two are omitted when they are
 * *stale* rather than absent, which is the distinction that matters:
 *
 * - **A green gate is not reported.** `lastGate` is the last gate that ran this
 *   attempt, which in a phase that failed its review is a gate from two rounds
 *   ago that passed. Printing "gate lint exited 0" beside a failure invites the
 *   reading that the gate had anything to do with it.
 * - **A gate that timed out says so** rather than "exited 124". 124 is the
 *   runner's own convention (`TIMEOUT_EXIT`) and nothing tells an operator
 *   that; a gate that ran out of time and one that failed in two seconds send
 *   them to different places.
 * - **A `pass` verdict is not reported**, for the same reason: the review that
 *   passed is not the one that ended the phase.
 * - **The fix budget is always reported when the node has one**, red or not,
 *   because `0 of 2` and `2 of 2` are different phases. The first died before
 *   any fixer ran; the second spent everything it had. Those were the two
 *   failures that read identically, and separating them is most of the point.
 *
 * §11: a gate id, an exit code, a transition id, a state id, a verdict word and
 * two counts. Nothing here has ever held a line of gate output, a diff, or a
 * reviewer's prose — `src/integration/git.ts`'s `GitCommandError` names a
 * command and a status by the same rule.
 */
function settledReason(settled: Settled, state: NodeState): string {
  const clauses: string[] = [`pipeline ended in state "${settled.state}"`]
  if (settled.via !== undefined) clauses[0] += ` via "${settled.via}"`

  const gate = state.lastGate
  if (gate !== null && gate.exitCode !== 0) {
    // Unnamed only where the host reported a result without an id; the phrase
    // stays readable rather than growing a `gate "null"`.
    const named = gate.id === null ? 'gate' : `gate "${gate.id}"`
    clauses.push(
      gate.status === 'timed_out' ? `${named} timed out` : `${named} exited ${gate.exitCode}`,
    )
  }
  if (state.lastVerdict === 'fail') clauses.push('review verdict "fail"')
  clauses.push(`${state.fixRounds} of ${state.node.max_fix_rounds} fix rounds spent`)

  return clauses.join('; ')
}

/** A refusal that is backpressure: unwinds the attempt so the lane is freed first. */
class CapacityRetry extends Error {
  constructor(readonly waitFor: () => Promise<void>) {
    super('capacity')
  }
}

/** `fatal` only — a broken harness, which is the one refusal that fails a node. */
class SpawnFatal extends Error {}

/**
 * A lane that could not be made clean for the next node.
 *
 * Its own type rather than a bare `Error` so `failureReason` can keep the
 * message: `recycleStage` already reduced the cause to a stage or an error
 * kind, so this text is identifiers by the time it is thrown. A plain `Error`
 * would be indistinguishable from something a dependency threw, and would be
 * flattened to `Error` — losing the lane name and the stage, which are the
 * whole point of the message.
 */
class LaneUnusable extends Error {}

/**
 * Unwinds a node the operator aborted (§9). It carries no message: the node is
 * already marked failed, with its reason, by the time this is thrown.
 */
class Aborted extends Error {}

interface NodeState {
  /** Replaced by `adopt` while the node is unstarted — §9's amend path. */
  node: Node
  pipeline: Pipeline
  status: NodeStatus
  /**
   * The live agent turn, for the four §9 operations that need one. Set the
   * moment admission grants a session and cleared when its stream ends, so
   * "is this node steerable right now" is one null check rather than a guess
   * from its status.
   */
  live: { readonly session: AgentSession; readonly adapter: HarnessAdapter } | null
  /**
   * Operator text that had nowhere to go — no live session, or a harness that
   * cannot inject — waiting for the node's next resume (§9). The queue lives
   * here because the resume does, and each entry remembers which operation
   * put it there so the delivery is journalled as what it is.
   */
  pending: { readonly op: OperatorOp; readonly text: string }[]
  /**
   * Operator text a resume already drained into the guard context but that no
   * agent has been handed yet. Two consumers, two clocks: the guard context is
   * read at the resume, and the agent is only reachable at the next spawn. A
   * node parked on a human gate hits the first well before the second, so
   * dropping the text at the resume is exactly the hole that made `codex`
   * steering inert.
   */
  undelivered: string[]
  /**
   * §15's session ledger: slot name to the session that slot last ran.
   *
   * Per node, never shared. Two nodes running the same phase pipeline both
   * have a `main` slot and they are unrelated — the slot is vocabulary chosen
   * by the pipeline author, and what makes one concrete is the node it belongs
   * to.
   */
  sessions: Map<string, SessionEntry>
  /**
   * The session id the node's **next** spawn continues from — §9's handoff
   * token, set when an operator detaches from a takeover.
   *
   * This is the **slot-less** path only. A takeover of a turn that named a slot
   * writes back into the ledger instead (§15.8), because the id belongs to the
   * slot that turn was running under: staging it here would hand an operator's
   * fixer session to whichever role happened to spawn next. What is left here
   * serves pipelines that opted out of slots entirely, where there is no slot
   * to write to and the next spawn is the only possible destination.
   */
  resumeSessionId: string | null
  /** Set by `pause`; honoured after the current turn, never inside it. */
  pauseRequested: boolean
  /** Set by `abortNode`. Every step checks it, so a killed node stops stepping. */
  aborted: boolean
  /** The effect the node is parked on, for the answer event that closes it. */
  parkedEffectId: string | null
  /** Fixer runs taken so far. The `fix_rounds` fact the interpreter reads. */
  fixRounds: number
  /**
   * The last gate this attempt ran — the three fields of `run_gate`'s facts
   * that §11 lets out of the lane, and none of the fourth.
   *
   * Kept because the guard context does not survive the pipeline: `#drive`
   * drops the `PipelineRun` on the way out, and by the time a failure is being
   * written down the only thing left is the name of the state it stopped in.
   * A red gate is the commonest way a phase ends, and it was the one fact an
   * operator needed and could not get from anything but the gate log — which
   * they have to know *which* gate to open before they can read.
   *
   * `id` is null when the host reported a gate result without naming one — the
   * vacuous pass a node that declared no gates gets. Nulled rather than left at
   * the previous gate, because a stale name is worse than no name.
   *
   * Never `log_ref`, which is a path into the lane, and never anything the gate
   * printed. An id, a number, and one of `GateStatus`'s three fixed words.
   */
  lastGate: {
    readonly id: string | null
    readonly exitCode: number
    readonly status: string | null
  } | null
  /**
   * The last verdict a reviewer stated this attempt (`pass` | `fail`).
   *
   * A closed vocabulary of two words, decided by `readVerdict` from the
   * transcript and handed here as a fact — so it carries none of the reviewer's
   * prose, which is what §11 keeps in the transcript file.
   */
  lastVerdict: 'pass' | 'fail' | null
  lane: string | null
  /**
   * A member the operator picked for the next attempt, in place of the one the
   * plan assigned. Consumed by the next claim and then kept, so a second
   * failure offers the choice again from where the node actually is.
   */
  retryMember: string | null
  /** How many times the operator has been offered this node. Keeps effect ids apart. */
  retries: number
  /** Automatic attempts already spent on this node, under `onFailure: retry`. */
  autoRetries: number
  laneLease: Lease | null
  /**
   * The roster member holding this node, or null when the workflow is
   * unstaffed. Claimed before the lane and released with it, because a member
   * owns the phase rather than a turn of it: the fixer answering a review
   * finding is the implementer continuing its own session, so handing the node
   * to someone else mid-pipeline would hand it to an agent that has no session
   * to continue.
   */
  crew: {
    readonly member: string
    readonly tier: number
    readonly model: string
    readonly harness: string | null
  } | null
  /**
   * The reviewer holding this node's review turn, or null between turns.
   *
   * Shorter-lived than `crew` on purpose. An implementer owns the phase from
   * its first turn to its last, because the fixer answering a finding *is* the
   * implementer continuing. A reviewer owns one turn: it reads a diff, returns
   * a verdict and goes back to the roster, so a plan with one reviewer and
   * three implementers is a queue at the review step rather than a deadlock.
   */
  reviewer: {
    readonly member: string
    readonly model: string
    readonly harness: string | null
  } | null
  /**
   * The implementer that held this node, kept after `crew` is cleared.
   *
   * Needed because a failure unwinds in the order resources-then-verdict:
   * `#release` runs first — correctly, since §6.1 says a node gives everything
   * back before it waits — and `#fail` therefore has no member left to name.
   * Without this the poisoned set was never written and a member carried a
   * failed phase's context into its next one.
   */
  lastMember: string | null
  /** Held for one pipeline step, and released at an `await_human` suspension. */
  gateLease: Lease | null
  gateHeld: readonly string[]
  /** Resolves when the operator answers. Set only while `awaiting_human`. */
  resume: ((facts: GuardContext) => void) | null
  failure: string | null
}

/**
 * What went wrong recycling a lane, in words safe to print.
 *
 * `LaneRecycleError` already classifies itself into one of three stages, and
 * that is the useful answer. Anything else reaching here came from the pool's
 * own machinery rather than from a project's reset commands — a summary that
 * would not read, a git call that refused — and is reported by its *kind*:
 * an error name and, where the runtime supplies one, a `code` like `ENOENT`.
 *
 * Not its message (§11). A thrown message can carry a git diagnostic or the
 * output of something a project chose to run, and neither belongs on a stream
 * that is otherwise identifiers.
 */
/**
 * Why a node failed, in words safe to persist.
 *
 * The same rule `recycleStage` follows, for the same reason. Two of the three
 * failure paths pass a literal this module wrote; the third passes whatever was
 * thrown, and "whatever was thrown" is not a closed vocabulary. A `PromptError`
 * is identifiers by construction — node id, reference, lane directory — and a
 * `SpawnFatal` names a harness; both are worth keeping verbatim, because they
 * are the ones an operator can act on. Anything else is reported by its *kind*:
 * an error name and, where the runtime supplies one, a `code` like `ENOENT`.
 *
 * The alternative — persisting `error.message` whatever it is — is how a
 * dependency's exception text ends up in a durable, API-served log. A gate's
 * output, a git diagnostic and a file's contents have all been somebody's
 * error message.
 */
function failureReason(error: unknown): string {
  if (
    error instanceof PromptError ||
    error instanceof SpawnFatal ||
    error instanceof LaneUnusable ||
    // The interpreter composed this one out of a state id and a trigger id.
    error instanceof PipelineStuckError
  ) {
    return String(error.message)
  }
  // A subcommand and an exit status, which is the same kind of thing every
  // other branch here returns — and the difference between "Error" and
  // "git commit exited 1" for the failures this package actually hits.
  if (error instanceof GitCommandError) return error.message
  const named = error as { name?: unknown; code?: unknown }
  const name = typeof named.name === 'string' ? named.name : 'Error'
  return typeof named.code === 'string' ? `${name}: ${named.code}` : name
}

function recycleStage(error: unknown): string {
  if (error instanceof LaneRecycleError) return error.stage
  const named = error as { name?: unknown; code?: unknown }
  const name = typeof named.name === 'string' ? named.name : 'Error'
  return typeof named.code === 'string' ? `${name}: ${named.code}` : name
}

export class Scheduler {
  readonly #options: SchedulerOptions
  /** Stamped with this run's id, so every record the loop writes is addressed. */
  readonly #log: Logger
  readonly #states = new Map<string, NodeState>()
  readonly #order: string[]
  /**
   * The run's workflow. Starts as the frozen snapshot and is replaced only by
   * `adopt` (§9's amend path), which is why it is a field rather than a read
   * through `#options`.
   */
  #workflow: Workflow
  readonly #takeovers: PtyRegistry
  readonly #freeLanes: string[]
  /** Lane slots a node has already run in, and which therefore need recycling. */
  readonly #usedLanes = new Set<string>()
  /** Roster members currently holding a turn. Empty in an unstaffed workflow. */
  readonly #busyCrew = new Set<string>()
  /** Whether this workflow declared a roster at all. Fixed for the run. */
  readonly #staffed: boolean
  /**
   * Each member's own worktree, for the whole run.
   *
   * This is what makes a session outlive a phase. A member that lands in a
   * different directory each time has a context describing paths it is no
   * longer standing in — §15.2's `lane_changed`, and the reason cross-phase
   * reuse was impossible rather than merely risky. Pinning the directory turns
   * that into a much smaller question: which *files* changed under it, which
   * git can answer exactly (`#reorientation`).
   */
  readonly #laneOf = new Map<string, string>()
  /**
   * Session ledgers, per member rather than per node.
   *
   * The node-scoped map they replace was cleared at the top of every attempt,
   * which is correct when lanes are anonymous and wrong once they are not: it
   * is what threw away the context a member had built up by the end of a phase.
   * Keyed by member, a ledger survives the phase and is invalidated
   * deliberately — by a failure, a turn ceiling, or a capacity retry.
   */
  readonly #memberSessions = new Map<string, Map<string, SessionEntry>>()
  /** Members whose last phase failed: their next turn starts cold (§15.2). */
  readonly #poisoned = new Set<string>()
  #waves = new Map<string, number>()
  #waiters: (() => void)[] = []
  #iterations = 0

  constructor(options: SchedulerOptions) {
    this.#options = options
    this.#log = (options.logger ?? nullLogger()).child({ runId: options.runId })
    const { workflow } = options
    this.#workflow = workflow
    this.#takeovers = options.takeovers ?? takeovers
    this.#staffed = Object.keys(workflow.crew).length > 0

    const resumed =
      options.resumeFrom === undefined
        ? null
        : new Map(options.resumeFrom.map((row) => [row.node_id, row]))
    for (const node of workflow.nodes) {
      const state = this.#fresh(node)
      this.#states.set(node.id, state)
      // A row the resume has no entry for is a node the journal never
      // registered — the workflow gained it since — and there is nothing untrue
      // in the projection to correct, so it stays `pending` silently, exactly
      // as a fresh run's node does.
      if (resumed !== null) this.#seed(state, resumed.get(node.id))
    }
    this.#order = workflow.nodes.map((node) => node.id)

    // One name per lane slot, matching `LanePool`'s own naming so a real pool
    // hands back the same worktrees. The pool guarantees at most this many
    // holders, so the free list can never run dry.
    this.#freeLanes = Array.from(
      { length: options.pools.capacity(LANE) },
      (_, i) => `${options.runId}-lane-${i + 1}`,
    )

    // One desk per member, named off the roster rather than the free list. The
    // names still match `LanePool`'s own scheme so a real pool hands back the
    // same worktrees; what changes is that the mapping is fixed for the run
    // instead of being whatever the free list had on top.
    laneHolders(workflow.crew).forEach((member, i) => {
      this.#laneOf.set(member.id, `${options.runId}-crew-${i + 1}-${member.id}`)
    })
  }

  /** The member's own worktree. Only meaningful in a staffed workflow. */
  #laneFor(member: string): string {
    const lane = this.#laneOf.get(member)
    if (lane === undefined) throw new Error(`crew member "${member}" has no lane`)
    return lane
  }

  /**
   * Who is taking this turn: the node's reviewer on a review, its implementer
   * otherwise. Null in an unstaffed workflow.
   *
   * The distinction is not cosmetic. A reviewer's session belongs to the
   * reviewer, and filing it under the implementer would hand the next phase's
   * reviewer a session another agent opened — the precise confusion the two
   * roles exist to prevent, reintroduced one layer down.
   */
  #actorOf(state: NodeState, role: unknown): string | null {
    if (role === 'reviewer' && state.reviewer !== null) return state.reviewer.member
    return state.crew?.member ?? null
  }

  /**
   * The ledger a turn reads and writes.
   *
   * Its actor's, in a staffed workflow — which is what lets a session outlive
   * the phase. The node's own, otherwise, which is every workflow written
   * before rosters existed and keeps their behaviour identical.
   */
  #ledgerOf(state: NodeState, role?: unknown): Map<string, SessionEntry> {
    const actor = this.#actorOf(state, role)
    return actor === null ? state.sessions : this.#ledgerFor(actor)
  }

  /** The member's ledger, created on first use. */
  #ledgerFor(member: string): Map<string, SessionEntry> {
    const existing = this.#memberSessions.get(member)
    if (existing !== undefined) return existing
    const fresh = new Map<string, SessionEntry>()
    this.#memberSessions.set(member, fresh)
    return fresh
  }

  /** A node's state as it starts: pending, holding nothing, steering nothing. */
  #fresh(node: Node): NodeState {
    const pipelineId = node.pipeline ?? this.#workflow.defaults.pipeline
    const pipeline = pipelineFor(this.#workflow, pipelineId)
    if (pipeline === undefined) {
      throw new Error(`node "${node.id}": unknown pipeline "${pipelineId}"`)
    }
    return {
      node,
      pipeline,
      status: 'pending',
      live: null,
      pending: [],
      undelivered: [],
      sessions: new Map(),
      crew: null,
      reviewer: null,
      lastMember: null,
      resumeSessionId: null,
      pauseRequested: false,
      aborted: false,
      parkedEffectId: null,
      fixRounds: 0,
      lastGate: null,
      lastVerdict: null,
      lane: null,
      retryMember: null,
      retries: 0,
      autoRetries: 0,
      laneLease: null,
      gateLease: null,
      gateHeld: [],
      resume: null,
      failure: null,
    }
  }

  /**
   * What a killed process left behind, applied to a node that is otherwise
   * `#fresh`.
   *
   * Only one field of the row is load-bearing, because only one of them
   * describes something that outlived the process: `done`. A node the journal
   * calls `running` has no session, no lease and no pipeline position behind it
   * — whatever was holding those is gone — so the only honest reading of every
   * status but `done` is `pending`, and the phase runs again from the start of
   * its pipeline. Nothing here tries to restore a live session or a lane: see
   * `resumeFrom` for why, and the `session_id` paragraph below for the one that
   * looks restorable and is not.
   *
   * **A `done` node is seeded silently; every other status is journalled.** Its
   * transition to `done` is already in the log, and appending a second one
   * would put a duplicate in the history the post-mortem and the node view
   * fold — a phase that ran once reading as a phase that finished twice. The
   * rest are journalled because the projection is currently *claiming*
   * something no process is backing, and that correction is the news: the row
   * saying `running` is what an operator is looking at while nothing runs.
   * `pending` is in that set too. It is already pending, so the row is a
   * duplicate in the narrow sense — but it costs one event, it marks where the
   * new host picked the run up, and the alternative is deciding case by case
   * which of five untrue statuses deserve the correction, which is how one of
   * them gets missed.
   *
   * **`session_id` is deliberately not carried into `resumeSessionId`**, even
   * though the worktree is usually still on disk and the agent could in
   * principle carry on. Three reasons, any one of them enough:
   *
   * - The column is COALESCE-updated by every `node_assigned`, so it holds
   *   whichever role spawned *last*. Staging it would hand a reviewer's session
   *   to the implementer restarting the phase — the exact confusion §15.8 keeps
   *   ids filed per slot to prevent. The row cannot say which slot it belongs
   *   to, because the projection was never keyed that way.
   * - It arrives naked. `SessionEntry` carries the harness, the lane, the turn
   *   count and the node that wrote it, and every §15.2 refusal is a comparison
   *   against one of those; a bare id is a continuation that no rule can
   *   decline. `#reorientation` is the one that matters most here — a resumed
   *   session would be told nothing about what moved underneath it during the
   *   outage, which is the single thing a session is reliably wrong about, and
   *   an outage is exactly when things moved.
   * - The phase re-drives from its pipeline's initial state regardless, so the
   *   session would be handed the full brief for work it believes it has
   *   already done. That is the same pairing `#spawnTurn` calls worse than not
   *   reusing at all, and the same reason `#restartAttempt` starts every other
   *   re-attempt cold.
   *
   * The cost of getting this wrong is not a wasted spawn: it is an agent
   * confidently describing work it cannot see.
   */
  #seed(state: NodeState, row: NodeRow | undefined): void {
    if (row === undefined) return
    if (row.status === 'done') {
      state.status = 'done'
      return
    }
    // The two statuses that are already true need no correction, and writing
    // one anyway is not free: a resume of a wide graph would put a `pending`
    // row against every phase it has not reached yet, which is a transition
    // that did not happen in a log whose whole value is that it only records
    // ones that did. `run_resumed` is what marks where the new host picked the
    // run up, so nothing is lost by staying quiet here.
    if (row.status === 'pending') return
    this.#setStatus(state, 'pending')
  }

  /**
   * §9's amend, reaching the live run: the nodes that have **not started** take
   * the new definitions, and nothing else is touched.
   *
   * The gate that decides *whether* an amendment is allowed lives in
   * `src/amend/`, which refuses while any affected node is in flight and
   * rebases the `done` ones before calling this. All that is left here is the
   * one thing only the scheduler can do — swap the definitions it is holding
   * for nodes it has not dispatched, and register the nodes the run gained.
   *
   * A node at any other status keeps the definition it started with, on
   * purpose: its pipeline run already captured it, and a node that has settled
   * has a branch that is the record of that definition.
   */
  /**
   * Roster members currently holding a node.
   *
   * Exposed for the same reason the pools expose `held`: a member left claimed
   * after a run ends is not a leak any counter notices — it surfaces much later
   * as a phase waiting forever on an agent nobody is using.
   */
  busyCrew(): string[] {
    return [...this.#busyCrew].sort()
  }

  adopt(workflow: Workflow): void {
    this.#workflow = workflow
    const declared = new Set(workflow.nodes.map((node) => node.id))

    for (const node of workflow.nodes) {
      const state = this.#states.get(node.id)
      if (state === undefined) {
        this.#states.set(node.id, this.#fresh(node))
        this.#order.push(node.id)
        continue
      }
      if (state.status !== 'pending' && state.status !== 'blocked') continue
      const replacement = this.#fresh(node)
      state.node = replacement.node
      state.pipeline = replacement.pipeline
    }

    // A node the amendment removed is dropped only when it never started; the
    // amend path refuses to remove one that did, so this can only ever drop an
    // unstarted node. Leaving it would dispatch a node the workflow no longer
    // declares.
    for (const [id, state] of [...this.#states]) {
      if (declared.has(id)) continue
      if (state.status !== 'pending' && state.status !== 'blocked') continue
      this.#states.delete(id)
      this.#order.splice(this.#order.indexOf(id), 1)
    }

    this.#waves = computeWaves(workflow.nodes)
    // The loop is asleep on `#changed()`; a new node may be dispatchable now.
    this.#wake()
  }

  /**
   * Runs the DAG to completion. Resolves when every node has settled, or when
   * the run stopped on something no amount of waiting can fix.
   */
  async run(): Promise<RunReport> {
    const unrunnable = this.#precheck()
    if (unrunnable) {
      // A run that stops here never starts a node, so it never writes a
      // transcript and its post-mortem has nothing to describe. The reason has
      // to be recorded at the moment it is known or it is not recorded at all.
      this.#log.error('scheduler.unrunnable', { stop: unrunnable.kind })
      return this.#report(unrunnable)
    }

    this.#waves = computeWaves(this.#workflow.nodes)
    this.#log.info('scheduler.started', {
      nodes: this.#workflow.nodes.length,
      waves: this.#waves.size,
      staffed: this.#staffed,
    })

    let stop: RunStop | null = null
    while (true) {
      this.#iterations += 1
      this.#dispatchReady()
      if (this.#settled()) break

      const deadlocked = this.#deadlock()
      if (deadlocked) {
        // §6's "never spin" rule, as a record. This is the failure that looks
        // like nothing at all from outside — the DAG simply stops, with every
        // node in a legitimate-looking state — so the pending set is named
        // here rather than left to be inferred from a snapshot.
        const pending = deadlocked.kind === 'deadlock' ? deadlocked.pending : []
        this.#log.error('scheduler.deadlock', {
          pending: pending.length,
          nodes: pending.join(','),
        })
        stop = deadlocked
        break
      }
      await this.#changed()
    }

    const status = stop === null && this.#failures().length === 0 ? 'done' : 'failed'
    this.#options.journal.append({
      runId: this.#options.runId,
      type: 'run_ended',
      payload: { status },
    })
    this.#log.info('scheduler.ended', {
      status,
      failures: this.#failures().length,
      iterations: this.#iterations,
    })
    return this.#report(stop)
  }

  /**
   * Runs a failed node again, at the operator's word.
   *
   * The §9 verbs steer a node that is *running*; this one reaches a node that
   * has stopped, which is why it is separate. It returns the node to the ready
   * set and releases the dependents its failure blocked — the whole subtree
   * comes back, because a phase that failed for an environmental reason blocked
   * work that was never broken.
   *
   * It needs the run to still be in flight: `run()` returns once every node has
   * settled, and after that there is no loop left to dispatch into. With
   * `onFailure: retry` — the default — a failing node parks on a question
   * rather than ending the run, so the loop is usually still there. A run that
   * has genuinely finished is re-run, not retried.
   *
   * Cold, like every other retry here: the context that failed is the thing
   * being retried away from.
   */
  retry(nodeId: string): void {
    const state = this.#states.get(nodeId)
    if (state === undefined) throw new Error(`unknown node "${nodeId}"`)
    if (state.status !== 'failed') {
      throw new Error(`node "${nodeId}" is ${state.status}, not failed`)
    }
    if (this.#settled()) throw new Error(`run has ended; start it again instead`)

    state.failure = null
    state.autoRetries = 0
    this.#restartAttempt(state)
    // A member poisoned by this node's failure is trusted again for it: the
    // retry is cold anyway, so there is no failed context left to inherit.
    const member = state.crew?.member ?? state.lastMember
    if (member !== null) this.#poisoned.delete(member)
    this.#setStatus(state, 'pending')

    // Everything this failure blocked is unblocked. Only what *this* node
    // blocked: a dependent blocked by some other failure stays where it is.
    for (const id of transitiveDependents(this.#workflow.nodes, nodeId)) {
      const dependent = this.#states.get(id)
      if (dependent?.status === 'blocked' && dependent.failure === null) {
        this.#setStatus(dependent, 'pending')
      }
    }
    this.#wake()
  }

  /**
   * Answers the `await_human` question a node is suspended on, resuming it
   * where it parked. The facts land in the guard context — `human.answer` is
   * what §5.2's guards read.
   */
  answer(nodeId: string, facts: GuardContext): void {
    const state = this.#states.get(nodeId)
    const resume = state?.resume
    if (state === undefined || resume === undefined || resume === null) {
      throw new Error(`node "${nodeId}" is not awaiting an answer`)
    }
    state.resume = null
    const answer = facts.human?.['answer']
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'human_answered',
      payload: {
        effect_id: state.parkedEffectId ?? '',
        answer: answer === undefined ? null : answer,
      },
    })
    state.parkedEffectId = null
    resume(facts)
  }

  // -------------------------------------------------------------------------
  // The four remaining operations of §9
  //
  // Each one is journalled, whatever it managed to do, and each one is defined
  // on a node that is not running: an operator clicking a button on a node
  // that finished half a second ago must get a recorded no-op, not a rejected
  // promise nobody is waiting on.
  // -------------------------------------------------------------------------

  /**
   * §9 — `session.send(text)` where the harness can inject, and otherwise a
   * queue drained into the node's next resume. The refusal a harness without
   * `inject` would raise is not the operator's to see, so it is never asked.
   */
  async addContext(nodeId: string, text: string): Promise<void> {
    const state = this.#stateOf(nodeId)
    if (this.#settledNode(state)) return this.#operation(state, 'add_context', text, 'ignored')

    const live = state.live
    if (live !== null && live.adapter.capabilities.inject) {
      await live.session.send(text)
      this.#operation(state, 'add_context', text, 'sent')
      return
    }
    state.pending.push({ op: 'add_context', text })
    this.#operation(state, 'add_context', text, 'queued')
  }

  /**
   * §9 — interrupt, then the new instruction. The instruction rides the same
   * queue as added context: an interrupted turn is over, so §9's other reading
   * of this verb — "resume with an amended prompt" — is the one that can
   * actually deliver it.
   */
  async redirect(nodeId: string, instruction: string): Promise<void> {
    const state = this.#stateOf(nodeId)
    if (this.#settledNode(state)) {
      return this.#operation(state, 'redirect', instruction, 'ignored')
    }

    await this.#interruptLive(state)
    state.pending.push({ op: 'redirect', text: instruction })
    this.#operation(state, 'redirect', instruction, 'queued')
  }

  /**
   * Stops the turn a node has live, where its harness can be stopped. Shared
   * by `redirect` and by the takeover's interrupt so there is one answer to
   * "what does stopping this turn mean", and one place a harness that cannot
   * be interrupted is tolerated rather than refused.
   */
  async #interruptLive(state: NodeState): Promise<void> {
    const live = state.live
    if (live !== null && live.adapter.capabilities.interrupt) await live.session.interrupt()
  }

  /**
   * §9 — finish the current turn, then `await_human`. The flag is read between
   * steps, never inside one: killing a turn to pause it is what abort is for.
   */
  async pause(nodeId: string): Promise<void> {
    const state = this.#stateOf(nodeId)
    if (state.status !== 'running') return this.#operation(state, 'pause', undefined, 'ignored')
    state.pauseRequested = true
    this.#operation(state, 'pause', undefined, 'sent')
  }

  /**
   * §9 — kill the session, mark the node failed, block its dependents. The
   * node is failed here rather than when its own loop unwinds, so an operator
   * who aborts sees the containment immediately; the loop discovers the abort
   * at its next step and stops without failing the node a second time.
   */
  async abortNode(nodeId: string): Promise<void> {
    const state = this.#stateOf(nodeId)
    if (this.#settledNode(state)) return this.#operation(state, 'abort', undefined, 'ignored')

    state.aborted = true
    this.#operation(state, 'abort', undefined, 'sent')

    const live = state.live
    state.live = null
    if (live !== null) await live.session.kill()

    const resume = state.resume
    state.resume = null
    state.parkedEffectId = null
    this.#fail(state, 'aborted by the operator')
    // The node's own loop unwinds a turn later, and the run can settle before
    // it does — so the resources go back here rather than there. `#release` is
    // idempotent, so the unwinding loop repeating it changes nothing.
    this.#release(state)
    // A parked node is asleep on a promise nobody else will settle; waking it
    // is how it reaches the abort check and stops stepping.
    if (resume !== null) resume({})
  }

  /** Node statuses as of now. A projection of the same facts the journal holds. */
  get statuses(): Readonly<Record<string, NodeStatus>> {
    return Object.fromEntries([...this.#states].map(([id, state]) => [id, state.status]))
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  /**
   * Starts every node whose own dependencies are green — the wave it belongs
   * to is not consulted. Declaration order breaks ties, so a plan reads the
   * way it runs.
   */
  #dispatchReady(): void {
    for (const id of this.#order) {
      const state = this.#states.get(id) as NodeState
      if (state.status !== 'pending') continue
      const ready = state.node.depends_on.every(
        (dep) => this.#states.get(dep.node)?.status === 'done',
      )
      if (!ready) continue
      this.#log.info('scheduler.dispatch', {
        node: state.node.id,
        wave: this.#waves.get(state.node.id) ?? -1,
        harness: this.#harnessOf(state),
      })
      // Synchronously, before the first await inside `#runNode`, so the loop
      // never sees a dispatched node as idle.
      this.#setStatus(state, 'running')
      // -----------------------------------------------------------------
      // The catch that keeps one node's bug from being the run's obituary.
      //
      // `#runNode` catches broadly *around the work*; what it does not catch
      // is itself. A throw from `#release`, `#fail`, `#setStatus` or a journal
      // write escapes into this promise, which nobody holds — and an
      // unhandled rejection terminates the process. That is hours of agent
      // turns and a real amount of money ending with no journal row, no
      // transcript entry and nothing on disk saying why, because the thing
      // that would have said it is the thing that died.
      //
      // So it is contained instead, by the rule §6 already states for
      // failures: this node fails, its transitive dependents are blocked, and
      // everything independent of it keeps going. The record is written first,
      // because `#fail` is one of the things that might have thrown.
      // -----------------------------------------------------------------
      void this.#runNode(state).catch((error: unknown) => {
        this.#log.error('scheduler.node_threw', {
          node: state.node.id,
          ...errorFields(error),
        })
        try {
          this.#fail(state, `scheduler error: ${errorKind(error)}`)
        } catch (second: unknown) {
          // Containment failed too. Nothing here can fix the run, and the
          // process-level handler in `log/crash.ts` is what catches whatever
          // comes next — but this line is why it will be explicable.
          this.#log.error('scheduler.containment_failed', {
            node: state.node.id,
            ...errorFields(second),
          })
        }
      })
    }
  }

  #settled(): boolean {
    return [...this.#states.values()].every(
      (state) => state.status === 'done' || state.status === 'failed' || state.status === 'blocked',
    )
  }

  /**
   * §6's rule, with §6.1's exclusion. Nothing live and something pending is
   * only a deadlock when no harness is parked: a run entirely inside a quota
   * window reaches exactly this shape and is merely waiting.
   */
  #deadlock(): RunStop | null {
    const live = this.#with('running').length + this.#with('awaiting_human').length
    if (live > 0) return null
    // A parked node is held by admission control's timer, not by a poll.
    if (this.#with('waiting_on_capacity').length > 0) return null
    if (this.#parkedHarnesses().length > 0) return null

    const pending = this.#with('pending')
    return pending.length === 0 ? null : { kind: 'deadlock', pending: pending.map((s) => s.node.id) }
  }

  /** Harnesses admission control says may not be tried yet (§6.1). */
  #parkedHarnesses(): string[] {
    const harnesses = new Set(
      [...this.#states.values()].map((state) => this.#harnessOf(state)),
    )
    return [...harnesses].filter((id) => this.#options.admission.wakeAt(id) !== undefined)
  }

  /** Resolves on the next state change. The only thing the loop ever waits on. */
  #changed(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  #wake(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) resolve()
  }

  // -------------------------------------------------------------------------
  // One node
  // -------------------------------------------------------------------------

  async #runNode(state: NodeState): Promise<void> {
    while (true) {
      // Staffing before capacity, deliberately. A lane is disk; who is holding
      // it is what the phase costs and whether it is any good. A free lane with
      // nobody qualified to take the phase is an idle lane — cheaper than the
      // same phase run by an agent the plan judged too low a tier for it.
      // Guarded rather than awaited unconditionally: an unstaffed workflow must
      // reach `acquire` in the same turn it always did. An extra microtask here
      // is not a behaviour change but it *is* a schedule change, and the
      // scheduler's own tests time their assertions against that schedule.
      if (this.#staffed) {
        await this.#claimCrew(state)
        // Belt and braces. `abortNode` releases what the node holds itself, and
        // nothing awaits between the claim above and this check, so today the
        // member is already back. It is written anyway because the failure it
        // guards is silent: a member left claimed is not a lease any counter
        // notices, and the symptom is a later phase waiting forever on an agent
        // nobody is using. `expectDrained` holds every scheduler test to it.
        if (state.aborted) {
          this.#releaseCrew(state)
          return
        }
      }

      // All-or-nothing, canonical order, one call: the lane and nothing else.
      // Gate pools are acquired later, while this lane is still held, which is
      // the §6 rule that an idle lane is just disk.
      state.laneLease = await this.#options.pools.acquire([LANE])
      // A staffed node goes to its member's desk; an unstaffed one takes
      // whatever the free list has, exactly as before.
      state.lane =
        state.crew === null ? (this.#freeLanes.pop() as string) : this.#laneFor(state.crew.member)
      this.#options.journal.acquireLease(LANE, state.node.id)
      this.#assign(state, { lane: state.lane })

      try {
        await this.#prepareLane(state)
        const settled = await this.#drive(state)
        this.#release(state)
        if (settled.outcome === 'done') {
          // A member that finishes cleanly is trusted again. Otherwise one bad
          // phase would force every later phase they take to start cold, long
          // after the context that failed was thrown away.
          if (state.lastMember !== null) this.#poisoned.delete(state.lastMember)
          this.#setStatus(state, 'done')
        }
        else {
          const reason = settledReason(settled, state)
          this.#recordAttemptFailure(state, reason)
          if (await this.#recover(state)) continue
          this.#fail(state, attempted(reason, state))
        }
        return
      } catch (error) {
        // Everything the node holds goes back before it waits — §6.1's rule,
        // and the reason `admit` hands back a wait rather than performing one.
        this.#release(state)

        // Already failed, already contained: unwinding is all that is left.
        if (error instanceof Aborted) return

        if (error instanceof CapacityRetry) {
          // §15's ledger does not survive a *re-attempt*. A capacity refusal
          // re-drives this pipeline from its initial state, so the branch the
          // last attempt built is gone and `#prepareLane` will recycle the
          // worktree under it. Whatever the session remembers writing is no
          // longer on disk, and resuming would hand an agent a memory of files
          // it created and a tree without them.
          //
          // Here rather than at the top of the loop, which is where it used to
          // be. That was equivalent while ledgers were per node — the first
          // pass had nothing to clear — and became a bug the moment they were
          // per member: it wiped everything the member had built up the instant
          // they started their second phase, which is the one thing this was
          // all for.
          this.#restartAttempt(state)
          this.#setStatus(state, 'waiting_on_capacity')
          await error.waitFor()
          if (state.aborted) return
          this.#setStatus(state, 'running')
          continue
        }
        const reason = failureReason(error)
        this.#recordAttemptFailure(state, reason, error)
        if (await this.#recover(state)) continue
        this.#fail(state, attempted(reason, state))
        return
      }
    }
  }

  /**
   * Takes a roster member for this node, waiting if every qualified one is busy.
   *
   * The wait cannot deadlock, and the reason is worth stating because it is the
   * whole safety argument: `assignCrew`'s floor is the *assigned* member's own
   * tier, and `validate.ts` refuses a node naming a member who is not on the
   * roster. So a node that waits is always waiting on somebody who is holding
   * another node — never on a qualification nobody has. A run cannot arrive at
   * "everyone is idle and this phase is unstaffable".
   *
   * An unstaffed workflow returns immediately and holds nothing, which is every
   * workflow written before rosters existed.
   */
  async #claimCrew(state: NodeState): Promise<void> {
    while (!state.aborted) {
      const decision: CrewDecision = assignCrew({
        // The operator's pick, when they made one, stands in for the plan's.
        // `assignCrew` still refuses a member who is not an implementer on the
        // roster and still substitutes when the pick is busy, so an answer
        // cannot put a phase somewhere the plan would not.
        assigned: state.retryMember ?? state.node.crew,
        crew: this.#workflow.crew,
        busy: this.#busyCrew,
        // Recomputed every pass, not hoisted: this loop only goes round again
        // because somebody settled, and settling is exactly what writes a
        // ledger and clears a poisoning. A warm set from before the wait would
        // describe a roster that no longer exists.
        //
        // Withheld entirely when the operator named the member. `retryMember`
        // is an answer to a question we asked them, and promoting away from it
        // to save a cold start would quietly overrule the person who was shown
        // the menu — a saving nobody asked for, spent against an explicit
        // instruction.
        ...(state.retryMember === null ? { warm: this.#warmCrew(state) } : {}),
      })

      if (decision.kind === 'unstaffed') return

      if (decision.kind === 'assigned') {
        this.#busyCrew.add(decision.member)
        state.crew = {
          member: decision.member,
          tier: decision.tier,
          model: decision.model,
          harness: decision.harness,
        }
        this.#options.journal.append({
          runId: this.#options.runId,
          nodeId: state.node.id,
          type: 'node_crew',
          payload: {
            member: decision.member,
            tier: decision.tier,
            substitute: decision.substitute,
            ...(decision.insteadOf === null ? {} : { instead_of: decision.insteadOf }),
            ...(decision.reason === null ? {} : { reason: decision.reason }),
          },
        })
        return
      }

      // Every member at or above the floor is working. A member frees only when
      // a node settles, and that is a state change — so this waits on the same
      // signal the dispatch loop does rather than polling.
      await this.#changed()
    }
  }

  /**
   * Which free members would *resume* a session if they took this node, rather
   * than open one.
   *
   * `assignCrew` spends real money on this answer — a warm member takes a phase
   * ahead of a cheaper cold one, which means a dearer model for the whole phase
   * — so the one thing it must not be is optimistic. "Has run before" would be
   * optimistic: a member can hold a ledger entry that §15.2 will refuse on the
   * next turn for four separate reasons, and a promotion bought on a refusal
   * pays the higher tier's rate *and* cold-starts anyway. Strictly worse than
   * doing nothing, and invisible — the phase completes.
   *
   * So this does not re-implement the rules; it runs them. `planSession` is
   * called with the inputs the spawn will genuinely present, and `continuation`
   * is the answer. The two can therefore not drift: a rule added to §15.2
   * tightens this in the same commit, with no second list to remember.
   *
   * The inputs a claim can know, and why each is the real one:
   *
   * - **lane** — `#laneFor`, the member's own worktree, fixed for the run. This
   *   is the whole reason the optimization exists at all: an anonymous lane
   *   made `lane_changed` fire on nearly every cross-phase turn, and a pinned
   *   one makes the answer usually yes.
   * - **harness** — resolved exactly as `#harnessOf` will for an implementer
   *   turn: the member's own override, then the node's, then the default. A
   *   member on `codex` is cold for a node pinned to `claude-code`, and
   *   `harness_changed` is what says so.
   * - **ledger, poisoned, maxTurns** — the live ones, so `turn_ceiling` and a
   *   member whose last phase failed both read as cold here.
   * - **slot** — the ones this node's own pipeline declares for an implementer
   *   turn. A member warm on `review` is not warm for a phase that will spawn
   *   `main`, and the ledger is keyed by slot, so guessing would be wrong in
   *   the expensive direction.
   *
   * `fixRounds: 0` because a claim starts an attempt; `takeoverSessionId: null`
   * because §9's handoff belongs to a node, not to a member the claim is still
   * choosing between.
   */
  #warmCrew(state: NodeState): ReadonlySet<string> {
    const warm = new Set<string>()
    if (!this.#staffed) return warm

    const slots = this.#implementerSlots(state.pipeline)
    if (slots.length === 0) return warm

    for (const member of implementers(this.#workflow.crew)) {
      // A busy member is not a candidate, warm or not, and asking costs a
      // `planSession` per slot for an answer nobody reads.
      if (this.#busyCrew.has(member.id)) continue
      const ledger = this.#memberSessions.get(member.id)
      // Read, never created. `#ledgerFor` would file an empty map for every
      // member the scheduler ever *considered*, which is a different set from
      // the members who ever ran — and that map is what `#restartAttempt` and
      // the reuse rollup read as "this member has history".
      if (ledger === undefined || ledger.size === 0) continue

      const harnessId = member.harness ?? state.node.harness ?? this.#workflow.defaults.harness
      const adapter = this.#options.adapters[harnessId]
      // No adapter registered is a spawn-time failure (`#adapter` throws), and
      // a staffing decision is not the place to raise it. Cold is the safe
      // reading: it changes nothing about how the node then fails.
      if (adapter === undefined) continue

      const resumable = slots.some(
        (slot) =>
          planSession({
            declaredSlot: slot,
            role: 'implementer',
            canResume: adapter.capabilities.resume,
            harnessId: adapter.id,
            lane: this.#laneFor(member.id),
            ledger,
            nodeId: state.node.id,
            maxTurns: this.#workflow.defaults.max_session_turns,
            poisoned: this.#poisoned.has(member.id),
            fixRounds: 0,
            maxFixRounds: state.node.max_fix_rounds,
            takeoverSessionId: null,
          }).continuation,
      )
      if (resumable) warm.add(member.id)
    }

    return warm
  }

  /**
   * The slots this pipeline names on an implementer spawn.
   *
   * Roles, not just slot names: `main` is shared by `implement` and `fix` in
   * the standard pipeline while `review` belongs to the reviewer, and a
   * reviewer's session is filed under the reviewer's own ledger. Counting it
   * here would make a member look warm for a phase on the strength of a session
   * that this claim will never reach.
   *
   * A pipeline that names no slot has opted out of §15 entirely, so nobody is
   * ever warm for it and the staffing question never arises.
   */
  #implementerSlots(pipeline: Pipeline): readonly string[] {
    const slots = new Set<string>()
    const scan = (effects: readonly SideEffect[]): void => {
      for (const effect of effects) {
        if (!effect.enabled || effect.definitionId !== 'spawn_agent') continue
        if (effect.params['role'] !== 'implementer') continue
        const slot = effect.params['session']
        if (typeof slot === 'string' && slot.length > 0) slots.add(slot)
      }
    }
    for (const node of pipeline.states) {
      scan(node.onEnter)
      scan(node.onLeave)
    }
    for (const transition of pipeline.transitions) scan(transition.effects)
    return [...slots]
  }

  /**
   * Takes a reviewer for one review turn, waiting if every qualified one is
   * busy.
   *
   * Unlike the implementer claim this happens *inside* the turn, because a
   * reviewer owns a turn rather than a phase — it reads a diff, returns a
   * verdict and goes back. Holding one for the whole node would make a plan
   * with one reviewer and three implementers run three phases strictly in
   * series.
   *
   * The wait cannot deadlock: reviewers never take phases, so a node waiting
   * for one is waiting on another node's review — a turn already running — and
   * never on a phase that might itself be blocked behind this one.
   */
  async #claimReviewer(state: NodeState): Promise<void> {
    if (!this.#staffed || state.crew === null) return

    while (!state.aborted) {
      const decision: ReviewDecision = assignReviewer({
        crew: this.#workflow.crew,
        authorTier: state.crew.tier,
        author: state.crew.member,
        busy: this.#busyCrew,
      })

      // No reviewer staffed. The turn runs on the node's own model, which is
      // what every workflow did before rosters existed.
      if (decision.kind === 'unstaffed') return

      if (decision.kind === 'assigned') {
        this.#busyCrew.add(decision.member)
        state.reviewer = {
          member: decision.member,
          model: decision.model,
          harness: decision.harness,
        }
        this.#options.journal.append({
          runId: this.#options.runId,
          nodeId: state.node.id,
          type: 'node_crew',
          payload: { member: decision.member, tier: decision.tier, substitute: false, role: 'reviewer' },
        })
        return
      }

      await this.#changed()
    }
  }

  /** Throws away this node's actor sessions, so its next attempt starts cold. */
  /**
   * Everything a fresh attempt at this node must not inherit.
   *
   * Every caller is about to re-drive the node from its pipeline's initial
   * state — a capacity refusal, an automatic retry, the operator's answer, the
   * `retry` verb — which makes this the one place that knows an attempt is
   * starting over.
   *
   * **The fix budget is per attempt, and it used to be per node.** `fixRounds`
   * was set to 0 when the node was created and never again, so a phase that
   * spent its whole budget on attempt 1 began attempt 2 already exhausted: one
   * review, one fix, and the exhaustion transition fired again. Observed with
   * `max_fix_rounds: 4` — the retry got a single fix round before it was asked
   * about, forty seconds of work standing in for four rounds of it. A retry
   * that inherits the reason the last attempt ran out is not a retry.
   *
   * The session ledger goes for the reason it always did: the branch the last
   * attempt built is gone and its worktree will be recycled, so a resumed
   * session would hold a memory of files that are no longer there.
   */
  #restartAttempt(state: NodeState): void {
    state.fixRounds = 0
    // For the same reason the budget goes: the next attempt re-drives the
    // pipeline from its initial state, so the gate that was red and the verdict
    // that was `fail` belong to a run that no longer exists. Carried over, they
    // would describe attempt 1's gate in attempt 2's failure — the one kind of
    // wrong answer worse than no answer, because it reads as evidence.
    state.lastGate = null
    state.lastVerdict = null
    if (state.crew === null) state.sessions.clear()
    else this.#ledgerFor(state.crew.member).clear()
  }

  /** Gives the reviewer back after its turn. */
  #releaseReviewer(state: NodeState): void {
    if (state.reviewer === null) return
    this.#busyCrew.delete(state.reviewer.member)
    state.reviewer = null
    this.#wake()
  }

  /** Gives the node's member back to the roster and wakes whoever is waiting. */
  #releaseCrew(state: NodeState): void {
    if (state.crew === null) return
    this.#busyCrew.delete(state.crew.member)
    state.lastMember = state.crew.member
    state.crew = null
    this.#wake()
  }

  /**
   * Hands this node a clean lane (§8).
   *
   * A plan almost always has more phases than lanes, so a slot serves several
   * of them in turn, and the phase that had it last left its branch, its
   * working tree and its databases behind. `recycleLane` resets what can be
   * reset and re-provisions what cannot — the decision is the pool's, taken
   * from the summary on disk.
   *
   * **Here, and not at the release.** A lane is recycled as it is handed to the
   * next node, because the lane the *last* phase to use it released is never
   * handed on again — and §8 keeps that worktree, that branch and those
   * databases exactly as the phase left them, as the evidence a human reads.
   * Recycling at the release would erase the last phase's lane in every run.
   *
   * A recycle that fails fails *this* node rather than letting it run in the
   * previous phase's worktree. The lane goes back on the free list still dirty,
   * so the next node to take it fails the same way: a dirty lane is never
   * silently reused.
   */
  async #prepareLane(state: NodeState): Promise<void> {
    const lane = state.lane as string
    if (!this.#usedLanes.has(lane)) {
      this.#usedLanes.add(lane)
      return
    }
    const recycle = this.#options.recycleLane
    if (recycle === undefined) return
    try {
      await recycle(lane)
    } catch (error) {
      // The lane name and the stage — and nothing the recycle commands printed
      // (§11). The stage is one of three fixed words, and it is the difference
      // between a database that would not reset, a worktree that would not come
      // back to its base, and a slot that could not be torn down and rebuilt.
      // Without it "could not be recycled" sends an operator to read three
      // different pieces of machinery.
      throw new LaneUnusable(`lane "${lane}" could not be recycled (${recycleStage(error)})`)
    }
  }

  /**
   * Drives one node's pipeline from `start` to a final state, parking it on
   * `await_human` and feeding `fix_rounds` back in on every step.
   */
  async #drive(state: NodeState): Promise<Settled> {
    const { workflow, runId } = this.#options
    const run = createPipelineRun({
      pipeline: state.pipeline,
      executor: this.#effects(state),
      context: {
        node: { id: state.node.id, max_fix_rounds: state.node.max_fix_rounds },
        run: { id: runId, base_branch: workflow.base_branch },
        fix_rounds: state.fixRounds,
      },
    })

    let result: StepResult = await run.start()
    while (true) {
      // Gate pools live for one step. A step that ends in a suspension gives
      // them back at the suspension, which is §6's "never across await_human"
      // — and which an operator pause below reaches by the same path.
      this.#releaseGate(state)
      if (state.aborted) throw new Aborted()

      if (result.kind === 'suspended') {
        // The question itself was journalled when the effect ran; here the
        // node only records which pause it is asleep on.
        state.parkedEffectId = result.effectId
        const facts = await this.#park(state)
        result = await run.resume(this.#withPending(state, run, facts))
        continue
      }
      if (result.kind === 'final') {
        return {
          outcome: this.#outcomeOf(state, result.state),
          state: result.state,
          // The interpreter's own name for the edge that ended the run. An
          // author-chosen id, which is what §11 allows and what tells
          // `t-gate-exhausted` from `t-review-exhausted` — two ways a
          // `standard-phase` node reaches `failed` that read identically
          // from the state id alone.
          ...(result.via === undefined ? {} : { via: result.via }),
        }
      }
      // Named rather than bare, so the reason reaches the journal: this used to
      // be reported as the word "Error" and nothing else. See
      // `PipelineStuckError`.
      if (result.kind === 'stuck') throw new PipelineStuckError(result.state, result.reason)

      // §9's pause, taken between turns: the lane stays, the gate pools are
      // already back, and the node waits on the same promise a human gate does.
      if (state.pauseRequested) {
        state.pauseRequested = false
        const effectId = `operator-pause:${state.node.id}`
        this.#ask(state, effectId, {
          question: 'The operator paused this node. Resume it?',
          kind: 'confirm',
        })
        state.parkedEffectId = effectId
        const facts = await this.#park(state)
        result = await run.send({
          facts: this.#withPending(state, run, { ...facts, fix_rounds: state.fixRounds }),
        })
        continue
      }

      result = await run.send({
        facts: this.#withPending(state, run, { fix_rounds: state.fixRounds }),
      })
    }
  }

  /**
   * Offers the operator the node's failure, and returns whether to try again.
   *
   * Reached only under `onFailure: 'ask'`; otherwise a failure fails, which is
   * what every run did before this existed.
   *
   * Everything the node held is already back — both call sites release before
   * they get here — so a node waiting on this answer costs a question and
   * nothing else. That is the §6.1 rule and it matters more here than anywhere:
   * the wait is unbounded, and a lane held across it would be a lane no other
   * phase can have for as long as the operator is at lunch.
   *
   * The retry starts **cold**. The context that failed is the thing being
   * retried away from, and §15's ledger does not survive a re-attempt anyway:
   * the branch the last attempt built is gone and the worktree under it will be
   * recycled, so a resumed session would hold a memory of files it wrote and a
   * tree without them — the same reasoning a capacity retry already follows.
   */
  /**
   * What to do about a failure, before it becomes one.
   *
   * Automatic attempts first and the operator afterwards, which is the order
   * the failures justify: the transient ones are gone by the second attempt and
   * never needed a person, and the ones that survive it are exactly the ones
   * worth a person's judgement. Returning true re-drives the node.
   */
  async #recover(state: NodeState): Promise<boolean> {
    const policy = this.#options.onFailure ?? 'retry'
    if (policy === 'stop' || state.aborted) return false

    if (policy === 'retry' && state.autoRetries < (this.#options.retries ?? 1)) {
      state.autoRetries += 1
      // Cold, for the reason a capacity retry is: the branch the last attempt
      // built is gone and its worktree will be recycled, so a resumed session
      // would hold a memory of files that are no longer there.
      this.#restartAttempt(state)
      this.#setStatus(state, 'running')
      return true
    }
    return await this.#offerRetry(state)
  }

  async #offerRetry(state: NodeState): Promise<boolean> {
    if (state.aborted) return false

    state.retries += 1
    const effectId = `retry:${state.node.id}:${state.retries}`
    this.#ask(state, effectId, {
      // The reason is journalled as `node_error` before `#recover` is consulted
      // — see `#recordAttemptFailure`; repeating it in the question would put a
      // failure message in a notification body (§11).
      //
      // This used to say the reason was "already journalled by `#setStatus`",
      // which was the one path that never runs when this question is asked:
      // `#setStatus(…, 'failed', reason)` is `#fail`'s, and reaching here means
      // `#recover` decided not to fail. The comment asserted an invariant the
      // control flow did not provide, and the reason was lost for every phase
      // that parked on this question.
      //
      // What the count *does* add is the one consequence the operator cannot
      // see: a retry hands the node its lane again, and a lane handed on is
      // recycled — `git clean` on a reusable one, a full re-provision on one
      // whose database cannot be reset. Committed work survives that (the
      // branch is a ref, and a retry resumes it); uncommitted work does not.
      // A number is not repository content, and it is the difference between
      // an informed "retry" and a surprised one.
      question: `This phase failed. Try it again?${await this.#uncommittedNote(state)}`,
      kind: 'choice',
      choices: this.#retryChoices(state),
    })
    state.parkedEffectId = effectId

    const facts = await this.#park(state)
    if (state.aborted) return false

    const answer = facts.human?.['answer']
    const chosen = typeof answer === 'string' ? answer : answer === true ? RETRY : STOP
    if (chosen === STOP) return false

    const member = chosen.startsWith(RETRY_WITH) ? chosen.slice(RETRY_WITH.length) : null
    if (member !== null && this.#workflow.crew[member] !== undefined) state.retryMember = member
    this.#restartAttempt(state)
    return true
  }

  /**
   * How much of this lane the retry will throw away, as a count.
   *
   * Only the count. The *paths* are repository content and would put a file
   * list into a notification body (§11); the number is a fact about the lane
   * and is what makes the choice an informed one. Silent on any failure —
   * there is no lane, git will not answer, the host owns its own lanes — since
   * a question that cannot be annotated is still a question worth asking.
   */
  async #uncommittedNote(state: NodeState): Promise<string> {
    if (state.lane === null) return ''
    try {
      const dirty = await gitLines(join(this.#options.laneRoot, state.lane), [
        'status',
        '--porcelain',
      ])
      if (dirty.length === 0) return ''
      const files = dirty.length === 1 ? '1 uncommitted file' : `${dirty.length} uncommitted files`
      return ` Its commits are kept; ${files} in the lane will be discarded.`
    } catch {
      return ''
    }
  }

  /**
   * `retry`, `stop`, and one entry per other member who could take this phase.
   *
   * The alternatives are read off the roster rather than offered as a list of
   * models, because a staffed run has no free-floating models in it: a phase is
   * taken by a *member*, and the tier floor that decides who may take it is the
   * assigned member's own. Offering a model would be offering something the
   * plan cannot express and the scheduler would have to invent a holder for.
   *
   * **The member left out is the one that just ran, not the one the plan
   * named.** A substitution makes those different — `assignCrew` hands the
   * phase to a free peer when the named member is busy — and the menu used to
   * exclude only the named one. A phase declared `mid` and substituted to
   * `senior` therefore offered "retry with senior" as its escalation: the agent
   * that had just failed, presented as the alternative to itself. One of three
   * choices did nothing an operator could tell apart from plain `retry`.
   *
   * `assigned` still sets the *floor*, deliberately. Re-pointing it at the
   * substitute would look like the same fix and quietly raise the bar for the
   * retry — `assignCrew` derives its own floor from this same value — so only
   * the exclusion widens.
   */
  #retryChoices(state: NodeState): readonly string[] {
    const assigned = state.retryMember ?? state.node.crew
    const floor = assigned === undefined ? undefined : this.#workflow.crew[assigned]?.tier
    const others =
      floor === undefined
        ? []
        : Object.entries(this.#workflow.crew)
            .filter(
              ([id, member]) =>
                member.role === 'implementer' &&
                member.tier >= floor &&
                id !== assigned &&
                id !== state.lastMember,
            )
            .map(([id]) => `${RETRY_WITH}${id}`)
    return [RETRY, ...others, STOP]
  }

  /**
   * Parks a node on an unanswered question: `awaiting_human`, its lane still
   * held, waiting on the promise `answer` resolves. The one place a node
   * sleeps, so the one place an abort has to be able to wake it.
   */
  async #park(state: NodeState): Promise<GuardContext> {
    this.#setStatus(state, 'awaiting_human')
    const facts = await new Promise<GuardContext>((resolve) => {
      state.resume = resolve
    })
    if (state.aborted) throw new Aborted()
    this.#setStatus(state, 'running')
    return facts
  }

  /**
   * Drains the operator's queue into the facts the node resumes with (§9).
   * A harness that cannot inject has no port for this text mid-turn, so the
   * guard context is where it lands: a plan can branch on it, and the effect
   * that composes the next prompt reads it from the same place it reads every
   * other fact.
   *
   * The guard context is not the *agent*, though, so the drained text is also
   * staged for the node's next spawn, which is where `AgentTask.operatorText`
   * carries it to the CLI.
   */
  #withPending(state: NodeState, run: PipelineRun, facts: GuardContext): GuardContext {
    if (state.pending.length === 0) return facts
    const queued = state.pending.splice(0)
    for (const entry of queued) this.#operation(state, entry.op, entry.text, 'delivered')
    const text = queued.map((entry) => entry.text).join('\n')
    state.undelivered.push(text)
    return { ...facts, human: { ...run.context.human, ...facts.human, pending_context: text } }
  }

  /** Journals §9.1's question. The pause *is* this event — see `events.ts`. */
  #ask(state: NodeState, effectId: string, question: HumanQuestion): void {
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'human_question',
      payload: { ...question, effect_id: effectId },
    })
  }

  /** One §9 operation, recorded. `text` is payload, never a log field. */
  #operation(
    state: NodeState,
    op: OperatorOp,
    text: string | undefined,
    delivery: OperatorDelivery,
  ): void {
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_operation',
      payload: { op, delivery, ...(text === undefined ? {} : { text }) },
    })
  }

  #stateOf(nodeId: string): NodeState {
    const state = this.#states.get(nodeId)
    if (state === undefined) throw new Error(`unknown node "${nodeId}"`)
    return state
  }

  /** Done, failed or blocked: there is nothing left in flight to steer. */
  #settledNode(state: NodeState): boolean {
    return state.status === 'done' || state.status === 'failed' || state.status === 'blocked'
  }

  /** A final state means failure only when its host `data` says so. */
  #outcomeOf(state: NodeState, stateId: string): 'done' | 'failed' {
    const final = state.pipeline.states.find((candidate) => candidate.id === stateId)
    return final?.data?.['outcome'] === 'failed' ? 'failed' : 'done'
  }

  /**
   * The executor the interpreter sees: the host's, wrapped with the two things
   * that are scheduling rather than verb semantics — admission control on a
   * spawn, and the gate's resource pools around a gate.
   */
  #effects(state: NodeState): EffectExecutor {
    return {
      execute: async (invocation: EffectInvocation): Promise<EffectOutcome> => {
        if (state.aborted) throw new Aborted()
        const verb = invocation.effect.definitionId
        if (verb === 'spawn_agent') return this.#observe(state, await this.#spawn(state, invocation))
        if (verb === 'run_gate') await this.#acquireGate(state, invocation)
        // The question is journalled before the host executor runs, because
        // the host executor is what raises the notification: the record of the
        // pause exists first, so a restart reads it instead of re-asking.
        if (verb === 'await_human') {
          this.#ask(state, invocation.effect.id, questionOf(invocation.effect.params))
        }
        return this.#observe(state, await this.#options.executor.execute(invocation))
      },
    }
  }

  /**
   * Keeps the two facts a failure has to be able to name, and passes the
   * outcome straight through.
   *
   * A tap rather than a step: the interpreter merges these facts into the guard
   * context, the guards branch on them, and then the pipeline settles and the
   * context goes out of scope with the `PipelineRun`. The scheduler is the only
   * thing that outlives both, so this is the only place the gate that was red
   * and the verdict that was `fail` can be caught on their way past.
   *
   * Read defensively for the same reason `questionOf` is: §5.2 keeps facts as
   * host data, and a host that returns a gate without an id — a node that
   * declared no gates passes the gate state vacuously — must not make a phase
   * fail with `gate "undefined"` written against it.
   */
  #observe(state: NodeState, outcome: EffectOutcome): EffectOutcome {
    const gate = outcome.facts?.gate
    const exitCode = gate?.['exit_code']
    if (typeof exitCode === 'number') {
      const id = gate?.['id']
      const status = gate?.['status']
      state.lastGate = {
        id: typeof id === 'string' ? id : null,
        exitCode,
        status: typeof status === 'string' ? status : null,
      }
    }
    const verdict = outcome.facts?.review?.['verdict']
    if (verdict === 'pass' || verdict === 'fail') state.lastVerdict = verdict
    return outcome
  }

  /**
   * Admission control, then the session, then the host's reading of it.
   *
   * The scheduler drains the session into the transcript because someone must —
   * an unread stream never ends — and because the transcript is the one place
   * §5.3 puts agent output. The host executor is left with the question the
   * scheduler cannot answer: what the turn *meant*, as facts.
   */
  async #spawn(state: NodeState, invocation: EffectInvocation): Promise<EffectOutcome> {
    const { params } = invocation.effect
    if (params['role'] === 'reviewer') {
      // Claimed here rather than with the lane: a reviewer owns a turn, not a
      // phase, and is released the moment the verdict is in. `#release` frees
      // it too, so an abort or a capacity refusal mid-review does not strand
      // the one reviewer on the plan.
      await this.#claimReviewer(state)
      if (state.aborted) throw new Aborted()
      try {
        return await this.#spawnTurn(state, invocation)
      } finally {
        this.#releaseReviewer(state)
      }
    }
    return await this.#spawnTurn(state, invocation)
  }

  async #spawnTurn(state: NodeState, invocation: EffectInvocation): Promise<EffectOutcome> {
    const { params } = invocation.effect
    const { workflow, runId, journal, admission } = this.#options
    const adapter = this.#adapter(this.#harnessOf(state, params['harness'], params['role']))

    // §9's queue, on its way to the agent. Carried as its own field rather
    // than folded into the brief so the adapter can present it as the
    // operator's; nothing is cleared until a session is actually granted,
    // because a capacity retry that swallowed it would lose the steering for
    // good.
    const carried = state.pending.length
    const owed = [...state.undelivered, ...state.pending.map((entry) => entry.text)]

    // Every role runs in the node's own lane, the reviewer included. A review
    // reads the **working tree**, uncommitted changes and all, because the
    // point of reviewing here is to fix before the commit rather than to record
    // the mistake and then a correction on top of it.
    const cwd = join(this.#options.laneRoot, state.lane as string)
    // The lane's own environment, for the process that is about to run the
    // project's commands in it.
    const laneEnv = this.#options.laneEnv?.(state.lane as string) ?? {}
    // The lease client attributes journal rows to the phase that asked. Only
    // add it where the host exposed a daemon URL; an injected/test host with no
    // lease route keeps the exact environment it supplied before this feature.
    const env =
      laneEnv[MAESTRO_URL_ENV] === undefined
        ? laneEnv
        : { ...laneEnv, [MAESTRO_NODE_ENV]: state.node.id }

    // §15's decision, taken before the task is built because the prompt
    // depends on it: a continued session is handed a delta, and a cold one the
    // whole brief. Getting that pairing wrong in either direction is worse
    // than not reusing at all — a delta into a session that does not exist
    // asks an agent to fix findings it has never seen, and a full brief into
    // one that does asks it to implement what it already implemented.
    const build = (plan: SessionPlan): AgentTask => ({
      nodeId: state.node.id,
      cwd,
      // Composed by `src/prompts`, selected by the effect's `prompt_template`.
      // This is task input: the brief and its dependency context are what the
      // agent is *for*, and they go nowhere else — a composition that fails
      // throws naming the node and the reference, never the brief.
      prompt: composeSpawnPrompt({
        template: params['prompt_template'],
        workflow,
        node: state.node,
        runId,
        journal,
        // A lane with no worktree on disk is a projection, not a run: nothing
        // will be spawned and there is no checkout to resolve a brief from.
        // A dispatched node in a real run always has one.
        workspace: existsSync(cwd) ? cwd : null,
        facts: invocation.context,
        continuation: plan.continuation,
        // Only on a cross-phase continuation. A same-phase one is a delta and
        // has nothing to be re-oriented about; a cold one has no memory to
        // correct.
        ...(plan.crossPhase && reorientation !== null ? { reorientation } : {}),
      }),
      model: this.#modelFor(state, params),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(owed.length === 0 ? {} : { operatorText: owed.join('\n') }),
      // The handoff token: either the slot's session (§15) or, for a pipeline
      // that named no slot, the id an operator's takeover left behind (§9).
      // Kept across a capacity retry, exactly like the operator's queue is,
      // and spent only once a session is actually granted.
      ...(plan.resumeSessionId === null ? {} : { resumeSessionId: plan.resumeSessionId }),
    })

    let plan = this.#sessionPlan(state, params, adapter)
    // Computed once, before the first `build`, because a capacity retry rebuilds
    // the task and re-running a git command per attempt would be wasted work.
    const reorientation = await this.#reorientation(state, plan, params['role'])
    let outcome = await admission.admit(adapter, build(plan))

    // §15.4: the vendor has forgotten the session this task asked to continue.
    // Exactly one retry, cold and with the full prompt — the harness is
    // healthy and nothing was parked, so this proceeds immediately rather than
    // returning the node to the ready set.
    //
    // `failed` is here for the same reason, as a safety net rather than a
    // classification. `stale_session` is recognised from vendor wording, and
    // that wording was inferred rather than observed against a real expired
    // session (§15.4). A pattern that misses turns a routine stale token into a
    // dead node *and* a blocked subtree, which is far too much to lose to a
    // string. So a spawn that carried a token and came back broken is retried
    // once without one: a genuinely broken harness fails again identically, one
    // spawn later, while a misread refusal recovers. A cold task is never
    // retried — with no token there is nothing a retry would change.
    if (plan.resumeSessionId !== null && (outcome.status === 'stale_session' || outcome.status === 'failed')) {
      plan = {
        slot: plan.slot,
        resumeSessionId: null,
        continuation: false,
        crossPhase: false,
        reason: 'stale_session',
        turns: 1,
      }
      outcome = await admission.admit(adapter, build(plan))
    }

    if (outcome.status === 'failed') throw new SpawnFatal(outcome.message)
    if (outcome.status === 'retry') throw new CapacityRetry(outcome.wait)
    // A second stale-session refusal on a task that carried no token at all.
    // The adapter is contradicting its own contract (`adapter.ts`), and the
    // one thing not to do is retry again: that is an unbounded loop against a
    // vendor. Fail the node instead, with the adapter's status token.
    if (outcome.status === 'stale_session') throw new SpawnFatal(outcome.message)

    // The task reached the harness, so the queue is spent. Only the entries
    // that were on it when the task was built: anything the operator typed
    // during the spawn itself is not in this turn and stays queued for the next.
    for (const entry of state.pending.splice(0, carried)) {
      this.#operation(state, entry.op, entry.text, 'delivered')
    }
    state.undelivered = []
    state.resumeSessionId = null

    // Journalled here rather than at the decision: this is the first moment a
    // turn is certain to happen. A capacity refusal unwinds and re-drives the
    // whole node, and a row written before `admit` would claim a turn that
    // never ran. A stale-session retry needs no second row either — the plan
    // that won is the one carrying `stale_session`, so one row per turn still
    // says what happened (§15).
    this.#session(state, plan)
    this.#remember(state, plan, adapter, outcome.session.id, params['role'])

    // The registry: exactly as long-lived as the turn it points at, so a §9
    // operation can never reach a session whose stream has already ended.
    state.live = { session: outcome.session, adapter }
    const withdraw = this.#offer(state, outcome.session, adapter, cwd, plan.slot)
    // Every spawn on this node appends to the same file, whatever its role, so
    // without this the implementer's output, the reviewer's and three fix
    // rounds' are one undifferentiated stream. Both facts are already here and
    // were simply not written down (`journal/transcript.ts`).
    const by: Attribution = {
      role: typeof params['role'] === 'string' ? params['role'] : 'agent',
      ...(plan.slot === null ? {} : { slot: plan.slot }),
    }
    try {
      for await (const event of outcome.session.events) {
        journal.appendTranscript(runId, state.node.id, { ...event, by: attribute(event, by) })
        if (event.type === 'session_started') {
          this.#assign(state, { session_id: event.sessionId })
          // The authoritative id. `AgentSession.id` is what the adapter knew
          // before the CLI spoke; a harness that mints its own on resume
          // reports it here, and the ledger must hold the one the *next*
          // resume has to name.
          this.#remember(state, plan, adapter, event.sessionId, params['role'])
        }
      }
    } finally {
      withdraw()
      state.live = null
      // Frees the harness in-flight slot: the ceiling counts running agents.
      outcome.release()
    }
    if (state.aborted) throw new Aborted()

    // A fix round is a fixer turn, not a state called `fix`.
    if (params['role'] === 'fixer') state.fixRounds += 1

    return await this.#options.executor.execute(invocation)
  }

  /**
   * What changed under a member's worktree since its session last looked.
   *
   * The answer that makes a cross-phase continuation safe. Everything else
   * about keeping an agent alive is an optimisation; this is the correctness
   * half, because the one thing a resumed session is reliably wrong about is
   * the contents of files that moved while it was away.
   *
   * `laneDelta` is a seam and may be absent — a host that injected its own
   * executor owns its lanes and may have no git to ask. Absent yields a null
   * file list, which the prompt renders as "treat every file's contents as
   * stale" rather than as "nothing changed". A missing answer is not an empty
   * one, and the difference decides whether an agent re-reads before editing.
   */
  async #reorientation(
    state: NodeState,
    plan: SessionPlan,
    role: unknown,
  ): Promise<Reorientation | null> {
    if (!plan.crossPhase) return null
    const entry = this.#ledgerOf(state, role).get(plan.slot as string)
    if (entry === undefined) return null

    const priorNodeId = entry.nodeId
    const priorWorkPresent = state.node.depends_on.some((dep) => dep.node === priorNodeId)

    let changedFiles: readonly string[] | null = null
    const delta = this.#options.laneDelta
    if (delta !== undefined && state.lane !== null) {
      try {
        changedFiles = await delta(state.lane, priorNodeId)
      } catch {
        // A delta that cannot be computed is reported as unknown, never as
        // empty. Failing the node over it would be worse: the turn is
        // recoverable, and the prompt has a correct thing to say about not
        // knowing.
        changedFiles = null
      }
    }

    return { priorNodeId, priorWorkPresent, changedFiles }
  }

  /**
   * §15.1's decision. The scheduler's only job here is to gather the inputs;
   * the rules themselves are `sessions.ts`, where each one can be checked on
   * its own rather than through whichever schedule a run happens to produce.
   */
  #sessionPlan(
    state: NodeState,
    params: Readonly<Record<string, unknown>>,
    adapter: HarnessAdapter,
  ): SessionPlan {
    return planSession({
      declaredSlot: params['session'],
      role: params['role'],
      canResume: adapter.capabilities.resume,
      harnessId: adapter.id,
      lane: state.lane,
      ledger: this.#ledgerOf(state, params['role']),
      nodeId: state.node.id,
      maxTurns: this.#workflow.defaults.max_session_turns,
      poisoned: this.#poisoned.has(this.#actorOf(state, params['role']) ?? ''),
      fixRounds: state.fixRounds,
      maxFixRounds: state.node.max_fix_rounds,
      takeoverSessionId: state.resumeSessionId,
    })
  }

  /** Writes the turn into the slot. Idempotent: `turns` comes from the plan. */
  #remember(
    state: NodeState,
    plan: SessionPlan,
    adapter: HarnessAdapter,
    sessionId: string,
    role: unknown,
  ): void {
    const lane = state.lane
    if (plan.slot === null || lane === null) return
    this.#ledgerOf(state, role).set(plan.slot, {
      harnessId: adapter.id,
      sessionId,
      lane,
      nodeId: state.node.id,
      turns: plan.turns,
    })
  }

  /** §15's per-turn row. A slot name, a disposition and a closed-set reason. */
  #session(state: NodeState, plan: SessionPlan): void {
    if (plan.slot === null && plan.reason === 'no_slot') return
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_session',
      // A slot-less continuation is §9's takeover handoff. It is still a reuse
      // and still worth a row; `slot` names the operation rather than a slot
      // that does not exist.
      payload: {
        slot: plan.slot ?? 'takeover',
        disposition: plan.continuation ? 'reused' : 'fresh',
        ...(plan.resumeSessionId === null ? {} : { session_id: plan.resumeSessionId }),
        ...(plan.reason === null ? {} : { reason: plan.reason }),
      },
    })
  }

  /**
   * §9's fifth operation, given something to point at: this node, for exactly
   * as long as this turn.
   *
   * **The lifetime is the `live` slot's, and deliberately so.** A takeover
   * target is a session id, a lane and a way to stop and restart the node; an
   * offer that outlived its session would name an id nothing is running and a
   * lane the node may have handed on, which is precisely what the registry
   * exists to make impossible ("nothing is reachable by default"). So it is
   * made where `live` opens and withdrawn in the same `finally` that closes
   * it — however the turn ended, including an abort or a thrown drain.
   *
   * A harness that cannot open a terminal is never offered. The channel checks
   * `pty` too, but offering what cannot be honoured would put a target in the
   * registry whose only possible answer is a refusal.
   *
   * Neither half of the round trip is implemented here: the interrupt is the
   * scheduler's own `pause` — §9's "finish the turn, then park", which is what
   * keeps the lane the operator is about to be dropped into — plus the same
   * session interrupt `redirect` uses, and the resume is the id staged for the
   * node's next spawn.
   */
  #offer(
    state: NodeState,
    session: AgentSession,
    adapter: HarnessAdapter,
    cwd: string,
    slot: string | null,
  ): () => void {
    if (!adapter.capabilities.pty || adapter.attachPty === undefined) return () => {}
    // Captured now, not read at the resume: the lane is what makes the id
    // usable, and both are facts about *this* turn.
    const lane = state.lane
    return this.#takeovers.offer(this.#options.runId, state.node.id, {
      adapter,
      sessionId: session.id,
      // The lane worktree this turn is running in — never the repository.
      cwd,
      // And its environment, so an operator typing in that worktree reaches the
      // same compose project, ports and database the agent was reaching.
      ...(lane === null ? {} : { env: this.#options.laneEnv?.(lane) ?? {} }),
      interrupt: async () => {
        // The node parks after this turn instead of stepping on: the operator
        // is about to be typing in that lane, and §6's "a paused node keeps
        // its lane" is what makes the terminal's cwd still theirs.
        await this.pause(state.node.id)
        await this.#interruptLive(state)
      },
      resume: async (sessionId: string) => {
        // §15.8: the id belongs to the slot this turn was running under.
        // Staging it on the node instead would hand an operator's fixer
        // session to whichever role spawned next — a reviewer continuing the
        // session it is supposed to be reviewing.
        if (slot === null || lane === null) state.resumeSessionId = sessionId
        else {
          state.sessions.set(slot, {
            harnessId: adapter.id,
            sessionId,
            lane,
            nodeId: state.node.id,
            // The operator's turn is this slot's turn, not an extra one: they
            // took over the session that was already running, so the ceiling
            // must not advance for a turn nobody spent a spawn on.
            turns: state.sessions.get(slot)?.turns ?? 1,
          })
        }
        // The pause the interrupt asked for is over. Either the turn has not
        // ended yet and the request is simply dropped, or the node is parked
        // on it and this is the answer that lets it go. Nothing between those
        // two: `#drive` clears the flag and parks without an await in between.
        state.pauseRequested = false
        if (state.resume !== null) this.answer(state.node.id, {})
      },
    })
  }

  /**
   * The gate's pools, acquired while the node still holds its lane. One call,
   * so the set is taken whole and in the pool's canonical order.
   */
  async #acquireGate(state: NodeState, invocation: EffectInvocation): Promise<void> {
    if (state.gateLease !== null) return
    const needs = this.#gateNeeds(state.node, invocation.effect.params['gate'])
    if (needs.length === 0) return

    // Both edges are journalled, and the request goes in *before* the await:
    // the wait is the fact §13.3 wants, and an event written after the grant
    // could only report a queue time it had already lost.
    this.#gatePool(state, 'requested', needs)
    state.gateLease = await this.#options.pools.acquire(needs)
    state.gateHeld = needs
    this.#gatePool(state, 'granted', needs)
    for (const resource of needs) this.#options.journal.acquireLease(resource, state.node.id)
  }

  /** The pools a `run_gate` needs: one named gate's, or every gate the node declared. */
  #gateNeeds(node: Node, named: unknown): string[] {
    const ids = typeof named === 'string' ? [named] : node.gates
    const needs = new Set<string>()
    for (const id of ids) {
      for (const resource of this.#workflow.gates[id]?.requires ?? []) needs.add(resource)
    }
    return [...needs]
  }

  // -------------------------------------------------------------------------
  // Resources, status, reporting
  // -------------------------------------------------------------------------

  #releaseGate(state: NodeState): void {
    if (state.gateLease === null) return
    state.gateLease.release()
    state.gateLease = null
    this.#gatePool(state, 'released', state.gateHeld)
    for (const resource of state.gateHeld) {
      this.#options.journal.releaseLease(resource, state.node.id)
    }
    state.gateHeld = []
  }

  /** One edge of a gate-pool acquisition. Pool ids and a phase — nothing else. */
  #gatePool(state: NodeState, phase: GatePoolPhase, resources: readonly string[]): void {
    if (resources.length === 0) return
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'gate_pool',
      payload: { phase, resources: [...resources] },
    })
  }

  #release(state: NodeState): void {
    this.#releaseGate(state)
    this.#releaseReviewer(state)
    // Before the early return below: a node can hold a member and no lane —
    // it is claimed first, and a capacity refusal unwinds from in between.
    this.#releaseCrew(state)
    if (state.laneLease === null) return
    state.laneLease.release()
    state.laneLease = null
    this.#freeLanes.push(state.lane as string)
    state.lane = null
    this.#options.journal.releaseLease(LANE, state.node.id)
  }

  /** Failure containment: exactly the transitive dependents, and nothing else. */
  #fail(state: NodeState, reason: string): void {
    state.failure = reason
    this.#setStatus(state, 'failed', reason)
    // The member's context is the context that just failed. Carrying it into
    // their next phase carries whatever wrong turn it took with it, and a wrong
    // conclusion is more expensive to inherit than a repository is to re-read.
    const member = state.crew?.member ?? state.lastMember
    if (member !== null) this.#poisoned.add(member)
    const blockedBy = `blocked by ${state.node.id}`
    for (const id of transitiveDependents(this.#workflow.nodes, state.node.id)) {
      const dependent = this.#states.get(id)
      // Only nodes that have not started: one already in flight finishes.
      if (dependent?.status === 'pending') this.#setStatus(dependent, 'blocked', blockedBy)
    }
  }

  /**
   * Why this *attempt* failed, recorded before anything decides what to do
   * about it.
   *
   * **The gap this closes.** A failure's reason was computed at the two sites
   * above and then handed to `#fail` — which journals it through `#setStatus`.
   * But `#fail` is reached only when `#recover` returns false, and under the
   * default `onFailure: retry` it usually does not: the node is auto-retried,
   * or parked on "This phase failed. Try it again?". Both paths dropped the
   * reason on the floor. `#offerRetry` even carried a comment asserting the
   * opposite — "the reason is already journalled by `#setStatus`" — which was
   * true only on the path that does not go through it.
   *
   * The cost was not theoretical. A phase that failed three times in
   * provisioning, before any agent ran, left a journal containing a status, a
   * lane, and a question offering a retry — and nowhere at all saying what went
   * wrong. The only copy of the reason was a line of stderr in a terminal that
   * had since scrolled away, and the only offered action was to try the same
   * thing again.
   *
   * Journalled rather than only logged, and both rather than either: the log
   * is where the detail belongs and the journal is what the UI reads, what the
   * post-mortem folds, and what survives being copied off the machine. An
   * attempt is not a status transition — the node is about to be `running`
   * again — so it is its own event rather than a `node_status` the projections
   * would have to learn to un-apply.
   *
   * §11 holds: `reason` is `failureReason`'s output, which is a kind and a
   * classification, never a command's output. The full error goes to the log,
   * where `--log-detail kind` is the switch for a checkout that cannot keep
   * even that.
   */
  #recordAttemptFailure(state: NodeState, reason: string, error?: unknown): void {
    this.#log.error('node.attempt_failed', {
      node: state.node.id,
      attempt: state.retries + state.autoRetries + 1,
      reason,
      ...(error === undefined ? {} : errorFields(error)),
    })
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_error',
      payload: { reason, attempt: state.retries + state.autoRetries + 1 },
    })
  }

  #setStatus(state: NodeState, status: NodeStatus, reason?: string): void {
    // Every node transition, in one line each, beside the daemon's own records
    // and on the same clock. The journal has these too and the UI projects
    // them — what it cannot do is interleave them with the HTTP refusal, the
    // spawn that was throttled and the exception thirty seconds earlier, which
    // is the sequence somebody reading a failure is actually trying to
    // reconstruct.
    this.#log[status === 'failed' ? 'warn' : 'info']('scheduler.node_status', {
      node: state.node.id,
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(state.lane === null ? {} : { lane: state.lane }),
    })
    state.status = status
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_status',
      // Only on a failure, and only when there is one: a `reason` on a `done`
      // row would be a field readers have to learn to ignore.
      payload: { status, ...(reason === undefined ? {} : { reason }) },
    })
    this.#wake()
  }

  #assign(state: NodeState, payload: { readonly lane?: string; readonly session_id?: string }): void {
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_assigned',
      payload,
    })
  }

  /**
   * The two unrunnable shapes, both of them static: a cycle, and a requirement
   * naming a pool that does not exist. Found before anything is dispatched, so
   * the runtime detector only ever has to answer "is this a capacity wait?".
   */
  #precheck(): RunStop | null {
    const { workflow } = this.#options
    const cycle = findCycle(workflow.nodes)
    if (cycle) return { kind: 'cycle', cycle }

    for (const node of workflow.nodes) {
      for (const resource of [LANE, ...this.#gateNeeds(node, undefined)]) {
        if (workflow.resources[resource] === undefined) {
          return { kind: 'unsatisfiable', nodeId: node.id, resource }
        }
      }
    }
    return null
  }

  #harnessOf(state: NodeState, override?: unknown, role?: unknown): string {
    if (typeof override === 'string') return override
    // A reviewer is its own member and may be staffed on another vendor.
    if (role === 'reviewer' && state.reviewer?.harness != null) return state.reviewer.harness
    return state.crew?.harness ?? state.node.harness ?? this.#workflow.defaults.harness
  }

  /**
   * Which model this turn runs on.
   *
   * In an unstaffed workflow this is what it always was: the effect's own
   * override, then the node's, then the default. A roster inserts one thing
   * between them — the member holding the node — and one rule that a per-node
   * model could never express.
   *
   * **A review runs on the reviewer that claimed it**, and reviewers are their
   * own members. An earlier version resolved a reviewer *model* one tier above
   * the author without claiming anybody — which read well and was wrong twice
   * over: a phase substituted up to the top tier had nobody above it and fell
   * back to being reviewed at its own tier, and a tier says nothing about *who*
   * once members are durable agents rather than borrowed model ids.
   *
   * With no reviewer on the roster there is nobody to claim, and the review
   * runs on the node's own model — which is what every workflow did before
   * rosters existed.
   */
  #modelFor(state: NodeState, params: Readonly<Record<string, unknown>>): string {
    const override = params['model']
    if (typeof override === 'string') return override

    if (params['role'] === 'reviewer' && state.reviewer !== null) return state.reviewer.model

    const crew = state.crew
    if (crew !== null) return crew.model

    return String(state.node.model ?? this.#workflow.defaults.model)
  }

  #adapter(id: string): HarnessAdapter {
    const adapter = this.#options.adapters[id]
    if (adapter === undefined) throw new SpawnFatal(`no adapter registered for harness "${id}"`)
    return adapter
  }

  #with(status: NodeStatus): NodeState[] {
    return [...this.#states.values()].filter((state) => state.status === status)
  }

  #failures(): NodeState[] {
    return [...this.#states.values()].filter((state) => state.status === 'failed')
  }

  #report(stop: RunStop | null): RunReport {
    const failures: Record<string, string> = {}
    for (const state of this.#failures()) {
      failures[state.node.id] = state.failure ?? 'node failed'
    }
    return {
      status: stop === null ? 'completed' : 'stopped',
      ...(stop === null ? {} : { stop }),
      statuses: this.statuses,
      waves: Object.fromEntries(this.#waves),
      failures,
      iterations: this.#iterations,
    }
  }
}

/**
 * §9.1's question, read out of the effect's params (§5.2 keeps params as data,
 * so this reads them defensively rather than trusting a schema that does not
 * exist). `reason` is the older one-line form and still reads as the question.
 */
function questionOf(params: Readonly<Record<string, unknown>>): HumanQuestion {
  const kind = params['kind']
  const choices = params['choices']
  const context = questionContext(params['context'])
  const question =
    typeof params['question'] === 'string'
      ? params['question']
      : typeof params['reason'] === 'string'
        ? params['reason']
        : 'This node is waiting for the operator.'

  return {
    question,
    kind: kind === 'choice' || kind === 'text' ? kind : 'confirm',
    ...(Array.isArray(choices)
      ? { choices: choices.filter((choice): choice is string => typeof choice === 'string') }
      : {}),
    ...(context === undefined ? {} : { context }),
  }
}

/** References the node view renders beside the question — never content. */
function questionContext(value: unknown): HumanQuestion['context'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const context: { diffRef?: string; gateLogRef?: string; transcriptCursor?: number } = {}
  if (typeof raw['diffRef'] === 'string') context.diffRef = raw['diffRef']
  if (typeof raw['gateLogRef'] === 'string') context.gateLogRef = raw['gateLogRef']
  if (Number.isInteger(raw['transcriptCursor'])) {
    context.transcriptCursor = raw['transcriptCursor'] as number
  }
  return Object.keys(context).length === 0 ? undefined : context
}

/** Convenience constructor, matching the shape the rest of the package uses. */
export function createScheduler(options: SchedulerOptions): Scheduler {
  return new Scheduler(options)
}
