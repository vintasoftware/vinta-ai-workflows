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
import { ids as guardIds } from '../guard/guard.ts'
import { checkCommand, shellLineOf } from '../guard/match.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AdmissionControl, AdmissionOutcome, AdmitOptions } from '../admission/admission.ts'
import { systemClock, type Clock } from '../admission/clock.ts'
import { type PtyRegistry, takeovers } from '../daemon/pty.ts'
import type { NodeActivity } from '../daemon/schemas.ts'
import { computeHeights, computeWaves, findCycle, transitiveDependents } from '../graph.ts'
import { gitLines } from '../integration/git.ts'
import type { AgentSession, AgentTask, HarnessAdapter } from '../harness/adapter.ts'
import type {
  Assignee,
  ChoreStatus,
  GatePoolPhase,
  HumanAnswer,
  HumanQuestion,
  NodeStatus,
  OperatorDelivery,
  OperatorOp,
} from '../journal/events.ts'
import { type Actor, attributed, CoordinatorForbidden } from '../coordinator/actor.ts'
import type { Journal, NodeRow } from '../journal/journal.ts'
import {
  type AgentQuestionEvent,
  attribute,
  type Attribution,
  MONITOR_ROLE,
  OPERATOR_ROLE,
} from '../journal/transcript.ts'
import { ConflictFixerInterrupted, ConflictFixerRefused, ConflictFixerTimeout } from '../integration/fixer.ts'
import { GitCommandError } from '../integration/git.ts'
import {
  COMMIT_DECISIONS,
  type CommitDecision,
  type CommitFailure,
  IntegrationCommitError,
  IntegrationWorktreeBusyError,
  UnresolvedConflictError,
} from '../integration/integrator.ts'
import { errorFields, errorKind, nullLogger, type Logger } from '../log/index.ts'
import type { EffectExecutor, EffectInvocation, EffectOutcome } from '../pipeline/effects.ts'
import type { ContextValue, GuardContext } from '../pipeline/guard.ts'
import {
  createPipelineRun,
  PipelineStuckError,
  type PipelineRun,
  type StepResult,
} from '../pipeline/interpreter.ts'
import { amendRun, type AmendRunner } from '../amend/amend.ts'
import { LanePrepareError, LaneRecycleError, LaneSetupError } from '../lanes/pool.ts'
import { pipelineFor } from '../pipeline/standard.ts'
import { MAESTRO_NODE_ENV, MAESTRO_TURN_ENV, MAESTRO_URL_ENV } from '../resources/agent-leases.ts'
import { assignCrew, type CrewDecision, roster } from './crew.ts'
import { planSession, type SessionEntry, type SessionPlan } from './sessions.ts'
import {
  composeSpawnPrompt,
  PromptError,
  type ChorePrompt,
  type Reorientation,
} from '../prompts/index.ts'
import { choresFor } from '../chores.ts'
import {
  answerDecisions,
  appendDecision,
  decision,
  readRejections,
  type DecidedBy,
  type Decision,
} from '../decisions/index.ts'
import {
  AGENT_QUESTION_TEXT,
  decodeAnswers,
  encodeAnswers,
  formatAnswers,
  QuestionWatch,
  recommendedAnswers,
} from '../questions/agent-questions.ts'
import { killLiveGates } from '../gates/runner.ts'
import type { Lease, ResourcePools } from '../resources/pools.ts'
import {
  CHORE_TIMINGS,
  type ChoreTiming,
  type CrewMember,
  type Node,
  type Pipeline,
  type SideEffect,
  type Workflow,
} from '../types.ts'

/** The pool a node is dispatched into. Required of every workflow (§5.1). */
const LANE = 'lane'

/**
 * One agent turn's fixed facts, shared by its first session and by every
 * resume an agent question causes (`#drain`, `#agentQuestions`).
 */
interface Turn {
  readonly adapter: HarnessAdapter
  readonly cwd: string
  readonly plan: SessionPlan
  readonly role: unknown
  readonly by: Attribution
  readonly priority: AdmitOptions
  /** The task that resumes `resumeSessionId` with `prompt` as its whole message. */
  readonly task: (prompt: string, resumeSessionId: string) => AgentTask
  /**
   * The turn id the last task built carried, or null where the environment
   * carries none. Admission spawns the task it was just handed, so the session
   * a drain reads is always the last one built.
   */
  readonly turnId: () => string | null
}

/**
 * What a plan question means when nobody answers it, the `given`-th time it is
 * answered that way this attempt. A string is the answer every time; a list is
 * one answer per time, its last entry repeating. Anything else — absent, empty,
 * not a string — waits for a person.
 */
export function unattendedAnswerFor(declared: unknown, given: number): string | null {
  if (typeof declared === 'string') return declared
  if (!Array.isArray(declared) || declared.length === 0) return null
  const answer: unknown = declared[Math.min(given, declared.length - 1)]
  return typeof answer === 'string' ? answer : null
}

/** The answers `#offerRetry` understands. `retry with ` carries a member id. */
const RETRY = 'retry'
const STOP = 'stop'
/**
 * Identical setup failures in a row before the unattended retry is withheld:
 * the first is an attempt, the second is the proof it is deterministic.
 */
const REPEATED_SETUP_FAILURES = 2
/**
 * Turns in a row one harness ended without the agent doing anything before it
 * is treated as broken rather than unlucky. Right after one run moved its
 * desks to codex, "ended the turn without the agent doing anything" failed 20
 * attempts across 4 phases in about two minutes: each automatic retry bought
 * the same empty turn.
 */
const EMPTY_TURN_FAULT = 2

/** The three answers to a merge commit git refused, as the operator sees them. */
const COMMIT_NOW = 'commit'
const COMMIT_NO_VERIFY = 'commit --no-verify'
const ABORT_MERGE = 'abort merge'
const COMMIT_CHOICES = [COMMIT_NOW, COMMIT_NO_VERIFY, ABORT_MERGE] as const

/** The operator's words into the integrator's; anything unrecognised aborts. */
function commitDecisionOf(answer: HumanAnswer | undefined): CommitDecision {
  if (answer === COMMIT_NOW) return 'commit'
  if (answer === COMMIT_NO_VERIFY) return 'no-verify'
  if (typeof answer === 'string' && (COMMIT_DECISIONS as readonly string[]).includes(answer)) {
    return answer as CommitDecision
  }
  return 'abort'
}

/** The deferred question's affirmative: run the phase now. */
const DEFERRED_START = 'start'

/** The login question's affirmative: the operator has logged the harness in. */
const LOGGED_IN = 'logged in'
const RETRY_WITH = 'retry with '

/**
 * The most an unattended retry's wait grows to, as a multiple of `retryAfterMs`
 * — fifteen minutes becomes two hours. Long enough that a failure nothing is
 * fixing stops costing an attempt a quarter-hour; short enough that a run whose
 * cause went away overnight is moving again before morning.
 */
const UNATTENDED_BACKOFF_CAP = 8

/**
 * The least an agent's own question waits unattended when only `retryAfterMs`
 * set the pace. An observed run answered a design question after sixty
 * seconds, and an answer given that way added a database migration: a retry
 * costs an attempt, an agent's choice can cost a schema.
 */
export const AGENT_ANSWER_FLOOR_MS = 30 * 60_000

/**
 * How long an agent's question waits before it takes its recommended options:
 * the explicit `agentAnswerAfterMs`, else twice `retryAfterMs` and never less
 * than `AGENT_ANSWER_FLOOR_MS`, else never (a person answers).
 */
export function agentAnswerAfter(retryAfterMs: number | undefined, explicit: number | undefined): number | undefined {
  if (explicit !== undefined) return explicit > 0 ? explicit : undefined
  if (retryAfterMs === undefined || retryAfterMs <= 0) return undefined
  return Math.max(2 * retryAfterMs, AGENT_ANSWER_FLOOR_MS)
}

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
   * How long an unanswered **failure** question waits before answering itself
   * `retry`. Unset — the default — waits for a person indefinitely.
   *
   * A run in an observed fourteen-hour build spent **four hours and seven
   * minutes**, 29% of its whole wall clock, parked on "This phase failed. Try
   * it again?" while nobody was at the keyboard. The answer, when it came, was
   * `retry`, and it worked. Nothing about that wait bought anything.
   *
   * **Beyond the failure question, it answers only what the plan said it may.**
   * A plan-authored `await_human` gate is a question the plan wanted a person
   * to answer — "is this schema change safe to deploy" — and a timer that
   * answered those would be the orchestrator overruling the plan on the
   * operator's behalf. So a plan question is answered only when it declares
   * its own `unattended_answer` (`#armUnattendedAnswer`): the shipped
   * pipeline's two budget questions, `exhausted` and `unapproved`, take
   * `stop` (§16). The answer is the plan's; this window is only when it is given.
   *
   * **Deliberately unbounded.** It fires again on each new question, for as
   * long as nobody answers — because the failure it exists for is a run that
   * stops making progress overnight, and a capped version would stall at the
   * cap for the remaining seven hours. Setting the flag is the opt-in: it is
   * unset by default, and unset is exactly today's "wait for a person".
   *
   * The cost is real and worth stating where the flag is read rather than
   * buried in a guide: every unattended retry is a **full phase attempt** —
   * a fresh agent session, its gates, its review. A phase that is broken rather
   * than flaky will retry all night at the cost of one attempt per interval, so
   * the interval is the throttle, and a short one on an expensive plan is the
   * way to spend a lot of money on the same failure. It is the *base* throttle:
   * attempts that fail faster than it double it (`#armUnattendedRetry`). `retries` is untouched:
   * it still bounds the *automatic* attempts that happen before anyone is
   * asked, which is the budget for a failure nobody has seen yet.
   */
  readonly retryAfterMs?: number
  /**
   * The unattended wait on an agent's own question (`#agentQuestions`), which
   * is a design choice rather than a retry and so waits longer. Absent derives
   * it from `retryAfterMs` (`agentAnswerAfter`).
   */
  readonly agentAnswerAfterMs?: number
  /** Drives `retryAfterMs`. Injected in tests; the real one is `systemClock`. */
  readonly clock?: Clock
  /**
   * Returns a lane slot to a clean state before another node is given it —
   * `LanePool.recycle`, which resets what it can and re-provisions what it
   * cannot (§8). Absent for a host that injected its own executor: such a host
   * owns its lanes, and a slot it never provisioned is not the scheduler's to
   * reset.
   */
  readonly recycleLane?: (name: string) => Promise<void>
  /**
   * Provisions a worktree under `name` for a spare crew member (`#spare`).
   * Absent for a host that injected its own lanes: then nobody is taken on, and
   * a busy member is covered or waited for as before.
   */
  readonly addLane?: (name: string) => Promise<void>
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
   * Told when an agent session's stream has drained, with the turn id its
   * environment carried (`MAESTRO_TURN_ENV`). The daemon's lease and gate
   * brokers release what that session's commands still hold and refuse them
   * from then on: a command the agent backgrounded with `&` outlives the
   * session and would otherwise keep its place in a queue for nobody.
   */
  readonly onTurnEnded?: (nodeId: string, turnId: string) => void
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
  /**
   * How far the run coordinator reaches (`run --coordinator-authority`, §9.2).
   * `standard` — the default — answers only the questions a `--retry-after`
   * timer could, and its own holds. `full` answers any question the operator
   * is not holding, and may change what the plan builds (`coordinator/policy.ts`).
   */
  readonly coordinatorAuthority?: CoordinatorAuthority
  /**
   * Told when the run moves off a harness (`switchHarness`), so what spawns
   * outside the scheduler — the conflict fixer — moves with it.
   */
  readonly onHarnessSwitched?: (from: string, to: string, model: string) => void
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
  /**
   * Set when the run ended because the operator halted it (`halt`), not
   * because the DAG settled. The journal's `run_ended` carries the same word.
   */
  readonly halted?: HaltMode
}

/**
 * How an operator ends a run that has not finished.
 *
 * - `paused` drains: no new phase starts, every running one stops at its next
 *   step boundary, and nothing is killed. A resume picks it up.
 * - `cancelled` kills every live agent turn first, then drains the same way.
 *   It is final; a resume refuses it.
 * - `interrupted` is `cancelled`'s teardown with `paused`'s meaning: the
 *   process is ending on a signal, every live turn is killed so none is left
 *   an orphan still editing a worktree, and the run ends resumable.
 */
export type HaltMode = 'paused' | 'cancelled' | 'interrupted'

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
 * operator has at that point: was a gate red, did the review keep saying no,
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
 *   attempt, which in a phase that failed its review is the gate that let the
 *   review start. Printing "gate lint exited 0" beside a failure invites the
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
 * two counts. Nothing here has ever held a line of gate output, a diff, or an
 * agent's prose — `src/integration/git.ts`'s `GitCommandError` names a
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
      (gate.status === 'timed_out' ? `${named} timed out` : `${named} exited ${gate.exitCode}`) +
        (gate.stalled === true ? ' again on a tree the last fixer left unchanged' : ''),
    )
  }
  if (state.lastVerdict === 'fail') clauses.push('review verdict "fail"')
  // Not a rejection: the turn ended — or errored — before it stated one. One
  // run recorded 22 of these as `review verdict "fail"`; every one was a review
  // turn the harness ended while its reviewer was still working.
  if (state.lastVerdict === 'silent') clauses.push('the review turn stated no verdict')
  // Gate fixers only. A review's findings are fixed inside its own turn (§16),
  // and "0 fix rounds spent" beside a failed review read as findings nobody
  // had been handed.
  const budget = state.node.max_fix_rounds
  clauses.push(
    budget === undefined
      ? `${state.fixRounds} gate fix rounds spent`
      : `${state.fixRounds} of ${budget} gate fix rounds spent`,
  )

  return clauses.join('; ')
}

/** A red `run_gate` result the stall check can key on. */
interface RedGate {
  readonly gate: string
  readonly tree: string
  readonly cached: boolean
}

/**
 * The red gate in a `run_gate` outcome, or null for a green one — and for a
 * red one reported without its id or tree, which the stall check cannot key
 * and so leaves to the ordinary fix loop.
 */
function redGateOf(outcome: EffectOutcome): RedGate | null {
  const gate = outcome.facts?.gate
  if (!isFactRecord(gate)) return null
  const { id, tree, exit_code: exitCode, cached } = gate
  if (typeof exitCode !== 'number' || exitCode === 0) return null
  if (typeof id !== 'string' || typeof tree !== 'string') return null
  return { gate: id, tree, cached: cached === true }
}

function isFactRecord(value: unknown): value is Readonly<Record<string, ContextValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
 * The operator answered the login question with `stop` (§6.1). A failure, but
 * one a person chose, so nothing in `#recover` may second-guess it.
 */
class LoginDeclined extends SpawnFatal {}
/**
 * The same harness ended `EMPTY_TURN_FAULT` turns in a row without the agent
 * doing anything. Not the work's failure and not one a retry changes, so
 * `#recover` spends no automatic attempt on it and asks instead.
 */
class HarnessFault extends SpawnFatal {}

/**
 * A lane that could not be made clean for the next node.
 *
 * Its own type rather than a bare `Error` so `failureReason` can keep the
 * message: `recycleFailure` already reduced the cause to the pool's own bounded
 * words or an error kind by the time it is thrown. A plain `Error` would be
 * indistinguishable from something a dependency threw, and would be flattened
 * to `Error` — losing the lane name, the stage and the cause, which are the
 * whole point of the message.
 */
class LaneUnusable extends Error {}

/**
 * Unwinds a node the operator aborted (§9). It carries no message: the node is
 * already marked failed, with its reason, by the time this is thrown.
 */
class Aborted extends Error {}

/**
 * Unwinds a node because the run is being halted (`Scheduler.halt`). Thrown
 * only at a step boundary or before a step begins, so it never interrupts work
 * in progress — on a pause, that is the whole point of draining.
 */
class Halted extends Error {}

/**
 * Raised when the turn's harness ran out of quota *inside* the turn and the
 * run moved to its fallback (`defaults.harness_fallbacks`): the turn is spawned
 * again on the fallback, at the same step, instead of re-driving the attempt.
 */
class HarnessFellBack extends Error {}

/**
 * A reassignment this run cannot make — an unknown member, a busy one, a
 * harness with no adapter. Ids only, so the API may repeat it.
 */
export class ReassignRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReassignRefused'
  }
}

/** A `step --to` the node's pipeline cannot take. Ids only. */
export class StepRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepRefused'
  }
}

/** Who a phase goes to: a crew member, or a harness and a model (or a model alone). */
export interface ReassignTarget {
  readonly crew?: string
  readonly harness?: string
  readonly model?: string
}

/** `now` cuts the live turn; `after_turn` lets it finish. */
export type ReassignWhen = 'now' | 'after_turn'

/** See `SchedulerOptions.coordinatorAuthority`. */
export type CoordinatorAuthority = 'standard' | 'full'


/** One reassignment, as it waits for a boundary or is applied. */
interface Reassignment extends ReassignTarget {
  /** Absent when the run moved the phase itself (`cause`). */
  readonly actor?: Actor
  readonly cause?: 'harness_fallback' | 'amendment'
  readonly reason?: string
  /** Who held the phase, when the caller had to read it before something changed it. */
  readonly from?: Assignee
}

function describeTarget(target: ReassignTarget): string {
  if (target.crew !== undefined) return `crew ${target.crew}`
  if (target.harness === undefined) return `model ${target.model ?? ''}`
  return `${target.harness} ${target.model ?? ''}`.trim()
}

/** How much of the last report a handoff quotes. Enough to orient, not a transcript. */
const HANDOFF_REPORT_CHARS = 4_000

/** The last thing an agent said in this node's transcript, bounded; null when it said nothing. */
function lastReport(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; text?: unknown } | null
    if (entry?.type !== 'assistant_text' || typeof entry.text !== 'string') continue
    const text = entry.text.trim()
    if (text === '') continue
    return text.length <= HANDOFF_REPORT_CHARS ? text : `…${text.slice(text.length - HANDOFF_REPORT_CHARS)}`
  }
  return null
}

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
   * What was settled for this phase, oldest first (`src/decisions`): agents'
   * questions with their answers, the operator's notes, findings the review
   * rejected. Every later prompt carries them, whichever session it reaches —
   * a fresh reviewer, a session replaced after a stale token, a retry.
   *
   * Kept across attempts on purpose, unlike everything `#restartAttempt`
   * clears: a retry discards the branch, not what the operator decided about
   * the phase. Mirrored to `decisions.jsonl`, which `#seed` reads back.
   */
  decisions: Decision[]
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
  /**
   * The node's body — `#runNode`, or `#holdDeferred` — has not returned yet.
   * An aborted node is failed at once and its body unwinds a step later, so
   * this is what says whether a retry can start the node again now or has to
   * wait for the old body to leave (`retryQueued`).
   */
  bodyActive: boolean
  /** A retry arrived while an aborted body was still unwinding; it is applied as the body exits. */
  retryQueued: boolean
  /**
   * The operator asked for a fresh session (`freshSession`): the node's next
   * turn starts cold whatever its ledger would have continued, journalled
   * `operator_fresh`.
   */
  freshRequested: boolean
  /**
   * Set by `interrupt`: at the pipeline's next boundary the node is held — it
   * parks on the operator's hold question, keeping its lane, branch and work —
   * instead of stepping on. `pauseRequested`'s twin, for a turn that was cut
   * short rather than allowed to finish.
   */
  holdRequested: boolean
  /**
   * The hold cut a live turn short, so the state that turn belonged to is run
   * again when the node is released — by whoever holds the phase then. A hold
   * that landed between steps continues as a pause does.
   */
  holdCut: boolean
  /** `step --to`: the state the node enters when it is next released. */
  stepTo: string | null
  /**
   * A reassignment waiting for the node to reach a boundary (`reassign
   * --after-turn`, or `--now` on a turn still unwinding). Applied there, and the
   * node goes on without parking.
   */
  pendingReassign: Reassignment | null
  /**
   * Who works this phase now, when an operator or the coordinator moved it off
   * what the plan and the roster say (`reassign`). Read before the member and
   * the node in `#harnessOf` and `#modelFor`, and kept across attempts.
   */
  assignment: { readonly harness?: string; readonly model?: string } | null
  /**
   * The member whose worktree this node is in, when the phase was handed to a
   * different member mid-attempt. The lane stays where the work is, so that
   * member stays busy until the node lets the lane go.
   */
  desk: string | null
  /**
   * What the next turn is told about the work it is taking over: the previous
   * agent's last report, where the diff is and the red gate. Written by a
   * reassignment that could not keep the session, spent by the next spawn.
   * Prompt text only — never journalled.
   */
  handoff: string | null
  /** Who put the node on hold — `pause`, `interrupt`, or a hold on its question. */
  heldBy: Actor | null
  /**
   * Which of `#drive`'s two parks the node is asleep in: its own hold (a pause
   * or an interrupt, between steps) or a question its pipeline asked. Null for
   * every other park — an agent's question inside a turn, a failure, a deferred
   * start, a login — which `step` cannot move the pipeline out of.
   */
  parkKind: 'hold' | 'pipeline' | null
  /** Ends a capacity wait early: the node was reassigned off the harness it waits on. */
  nudge: (() => void) | null
  /** The effect the node is parked on, for the answer event that closes it. */
  parkedEffectId: string | null
  /**
   * What the question the node is about to park on means when nobody answers
   * it — the plan's `unattended_answer`, captured as the question is asked.
   * Null for a question that waits for a person however long that takes.
   */
  unattendedAnswer: string | null
  /** Sets the unattended timer going again, once it fired on a held node and stood down. */
  rearm: (() => void) | null
  /** The pipeline state this attempt is in, as last journalled (`node_step`). Null before its first. */
  step: string | null
  /**
   * Unattended answers given this attempt, by the effect that asked. A plan's
   * `unattended_answer` may be a list — its nth entry is the nth answer, and the
   * last one repeats — so a budget question can say "go on once, then stop".
   */
  unattendedGiven: Map<string, number>
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
    /** Red again on the tree a fixer round left unchanged (§13.4). */
    readonly stalled?: boolean
  } | null
  /**
   * The red gate the fix loop is answering — its id and the lane tree it was
   * red on — and whether a fixer turn has run since. What `#runGate` compares
   * the next red against to tell a fixer that changed the wrong thing from one
   * that changed nothing at all (§13.4).
   *
   * A tree hash rather than a commit, because the question is what the gate
   * read and the gate reads uncommitted work too; and a git object id, which
   * is not repository content (§11). Null after a green gate, at the start of
   * an attempt, and whenever the host reports a red gate without its tree.
   */
  lastRed: { readonly gate: string; readonly tree: string; fixedSince: boolean } | null
  /**
   * The last verdict the review chores stated this attempt (`pass` | `fail`),
   * or `silent` for a review that did not approve because its turn stated no
   * verdict at all — the guards read that as `fail`, the failure reason does not.
   *
   * A closed vocabulary, decided by `readVerdict` from the transcript and
   * handed here as a fact — so it carries none of the review's prose, which is
   * what §11 keeps in the transcript file.
   */
  lastVerdict: 'pass' | 'fail' | 'silent' | null
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
  /** Login questions asked, for a unique effect id per ask (§6.1). */
  loginAsks: number
  /** Questions agents on this node stopped to ask. Keeps their effect ids apart. */
  agentQuestions: number
  /**
   * Failure questions this node answered for itself because nobody did. Its own
   * counter rather than `autoRetries`: the two are spent in different places
   * and reading one for the other would let a node that had already used its
   * automatic budget retry unattended for ever.
   */
  unattended: number
  /**
   * Failure questions in a row whose attempt ended faster than `retryAfterMs`.
   * An attempt that fails in less time than the interval is being paced by the
   * timer rather than by the work, so each one doubles the next unattended
   * wait (see `#armUnattendedRetry`). Reset by an attempt that ran longer.
   */
  quickFailures: number
  /** `clock.now()` when this attempt got its lane: what `quickFailures` measures from. */
  attemptStartedAt: number
  /**
   * Whether this attempt has asked a harness for an agent — a spawn or a
   * chore turn reached the effect door. False until then, so a failure with
   * it still false happened in *setup*: the lane recycle, the branch cut, the
   * base merge. Reset per attempt.
   */
  agentRan: boolean
  /**
   * The setup failure the attempts before this one ended in, when they all
   * ended in the same one: the reason, and how many attempts in a row. A
   * setup failure that repeats verbatim is deterministic — a worktree that is
   * mid-merge, a hook that cannot import a module — and retrying it unattended
   * buys the same line again. Cleared by an attempt that got past setup.
   */
  setupFailure: { readonly reason: string; readonly count: number } | null
  /**
   * The harness whose turns on this node have ended empty, and how many in a
   * row — across attempts, since the attempt boundary is exactly what an
   * automatic retry crosses. Cleared by any turn the agent took part in.
   */
  emptyTurns: { readonly harness: string; readonly count: number } | null
  /** The attempt that just failed ended on a `HarnessFault`. Read once by `#recover`. */
  harnessFault: boolean
  /**
   * Reviews that did not approve this phase on its current desk, across
   * attempts. At `defaults.escalate_after_rejections` the phase moves up a
   * tier (`#countRejection`), and the count starts again on the new desk.
   */
  reviewRejections: number
  /** Questions the host asked through `askNode`. Keeps their effect ids apart. */
  hostAsks: number
  /**
   * A deferred node the operator has released (`node.deferred`). Until then
   * the node is not dispatched however ready its dependencies are; it parks on
   * the question instead, once.
   */
  released: boolean
  /**
   * Merged, pushed and past every step that can fail it — only `after_pr`
   * chores that cannot fail the phase are left. Its dependents may start: what
   * they build on is on the integration branch already. See `#chores`.
   */
  landed: boolean
  /** Whether the deferred question is being asked, so dispatch asks it once. */
  deferredAsked: boolean
  /**
   * Paused by the operator while parked on a question: no `--retry-after`
   * timer answers it, and only a person's answer releases it. See `pause`.
   */
  held: boolean
  /**
   * Whether the question this node is parked on is one the run coordinator
   * may answer: exactly the ones a `--retry-after` timer may answer on its
   * own, whether or not one is armed. Set where the timer is (or would be)
   * armed and cleared by every answer, so a question that arms nothing — a
   * deferred start, an operator's pause, a plan's human gate with no
   * `unattended_answer`, a harness login — stays a person's.
   */
  delegable: boolean
  laneLease: Lease | null
  /**
   * The roster member holding this node, or null when the workflow is
   * unstaffed. Claimed before the lane and released with it, because a member
   * owns the phase rather than a turn of it: the fixer and the review chore are
   * the implementer continuing its own session, so handing the node to someone
   * else mid-pipeline would hand it to an agent that has no session to
   * continue.
   */
  crew: {
    readonly member: string
    readonly tier: number
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
 * Why a node failed, in words safe to persist.
 *
 * The same rule `recycleFailure` follows, for the same reason. Two of the three
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
  // A subcommand, an exit status and the redacted tail of git's stderr —
  // the difference between "Error", "git commit exited 1", and a line that
  // says which hook refused the commit and why.
  if (error instanceof GitCommandError) return error.message
  // The integrator's own: branch names, node ids, paths, a kept ref, and the
  // git line above. Each one was reported as its bare class name before —
  // `UnresolvedConflictError`, with the pair of nodes and the contested paths
  // it had carefully composed dropped on the floor.
  if (
    error instanceof IntegrationCommitError ||
    error instanceof IntegrationWorktreeBusyError ||
    error instanceof UnresolvedConflictError ||
    error instanceof ConflictFixerRefused ||
    error instanceof ConflictFixerTimeout ||
    error instanceof ConflictFixerInterrupted
  ) {
    return error.message
  }
  // A merged tree a full gate failed on: a wave, or a phase's base. A wave, a
  // node id, a branch, a gate id, an exit code and a log path — and the one
  // failure where "which gate, and where is its log" is the whole answer.
  // By name, because the executor is the host's and the scheduler does not
  // import it.
  if (error instanceof Error && (error.name === 'WaveGateError' || error.name === 'BaseGateError')) {
    return error.message
  }
  const named = error as { name?: unknown; code?: unknown }
  const name = typeof named.name === 'string' ? named.name : 'Error'
  return typeof named.code === 'string' ? `${name}: ${named.code}` : name
}

/**
 * What went wrong recycling a lane, in words safe to print.
 *
 * The pool's own errors are kept whole: `LaneRecycleError` names its stage and
 * the cause the failing step gave — an exit code and a bounded stderr tail —
 * and the project's `reset_cmd`, `setup_cmd` or `prepare_cmd` failing on the
 * way through is the error `LaneSetupError` and `LanePrepareError` already
 * compose with the same bound. Twenty attempts of one observed run failed on
 * "could not be recycled (worktree)" with no cause anywhere, which is the gap
 * this closes.
 *
 * Anything else came from somewhere that did not choose its words for a log
 * and is reported by its *kind*: an error name and, where the runtime supplies
 * one, a `code` like `ENOENT` (§11).
 */
function recycleFailure(lane: string, error: unknown): string {
  if (error instanceof LaneRecycleError) return error.message
  if (error instanceof LaneSetupError || error instanceof LanePrepareError) {
    return `lane "${lane}" could not be recycled: ${error.message}`
  }
  const named = error as { name?: unknown; code?: unknown }
  const name = typeof named.name === 'string' ? named.name : 'Error'
  return `lane "${lane}" could not be recycled (${typeof named.code === 'string' ? `${name}: ${named.code}` : name})`
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
  /**
   * The host's side of §9's amend, for the amendments the scheduler makes
   * itself (`bindAmendRunner`). Unbound, only this scheduler adopts them.
   */
  #amendRunner: AmendRunner | null = null
  readonly #takeovers: PtyRegistry
  readonly #freeLanes: string[]
  /** Lane slots a node has already run in, and which therefore need recycling. */
  readonly #usedLanes = new Set<string>()
  /** Roster members currently holding a turn. Empty in an unstaffed workflow. */
  readonly #busyCrew = new Set<string>()
  /**
   * Harnesses the run moved off, and where to (`switchHarness`). Every turn
   * that would resolve to a key here runs on its value instead.
   */
  readonly #switches = new Map<string, { readonly harness: string; readonly model: string }>()
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
  /**
   * Members taken on beyond the roster (`defaults.max_spare_crew`), by id, with
   * the roster member each was taken on in the image of. Never planned for, so
   * never "needed" by a pending phase; they cover their tier like anyone else.
   */
  readonly #spares = new Map<string, CrewMember & { readonly of: string }>()
  /** Set when a spare's worktree could not be provisioned: nobody else is taken on. */
  #sparesBroken = false
  #waves = new Map<string, number>()
  /** Nodes parked on the login question, by harness id (§6.1). */
  readonly #loginWaiters = new Map<string, Set<NodeState>>()
  /** Critical-path priority per node, handed to admission (§6.1). */
  #heights = new Map<string, number>()
  #waiters: (() => void)[] = []
  #iterations = 0
  /** Set once `run()` has left its loop: there is nothing left to dispatch into. */
  #ended = false
  /** Whether `scheduler.awaiting_retry` was logged for the current wait. */
  #awaitingLogged = false
  /** Set once by `halt`. Read at every point a node could start new work. */
  #halt: HaltMode | null = null
  /** Resolves when `halt` is called, for the one wait no state change ends. */
  #halting: { promise: Promise<void>; resolve: () => void } = deferred()
  /**
   * Node bodies that have not returned yet. A halt is complete when this is
   * zero: every node has reached a boundary, released what it held and left.
   */
  #active = 0

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
    roster(workflow.crew).forEach((member, i) => {
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
   * The ledger a turn reads and writes.
   *
   * The member's, in a staffed workflow — which is what lets a session outlive
   * the phase. The node's own, otherwise, which is every workflow written
   * before rosters existed and keeps their behaviour identical.
   */
  #ledgerOf(state: NodeState): Map<string, SessionEntry> {
    const member = state.crew?.member
    return member === undefined ? state.sessions : this.#ledgerFor(member)
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
      decisions: [],
      sessions: new Map(),
      crew: null,
      lastMember: null,
      resumeSessionId: null,
      pauseRequested: false,
      aborted: false,
      bodyActive: false,
      retryQueued: false,
      freshRequested: false,
      holdRequested: false,
      holdCut: false,
      stepTo: null,
      pendingReassign: null,
      assignment: null,
      desk: null,
      handoff: null,
      heldBy: null,
      parkKind: null,
      nudge: null,
      parkedEffectId: null,
      unattendedAnswer: null,
      rearm: null,
      step: null,
      unattendedGiven: new Map(),
      fixRounds: 0,
      lastGate: null,
      lastRed: null,
      lastVerdict: null,
      lane: null,
      retryMember: null,
      retries: 0,
      autoRetries: 0,
      loginAsks: 0,
      agentQuestions: 0,
      unattended: 0,
      quickFailures: 0,
      attemptStartedAt: 0,
      agentRan: false,
      setupFailure: null,
      emptyTurns: null,
      harnessFault: false,
      reviewRejections: 0,
      hostAsks: 0,
      released: false,
      landed: false,
      deferredAsked: false,
      held: false,
      delegable: false,
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
   *   whichever turn spawned *last*. Staging it would hand a slot's session
   *   to a turn on another slot restarting the phase — the exact confusion §15.8 keeps
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
    // Unlike the session id above, a decision does not describe a worktree:
    // it is what the operator settled about the phase, and the re-driven
    // phase is the same phase.
    state.decisions = this.#options.journal.decisions(this.#options.runId, state.node.id)
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
   * The composition's `AmendRunner`, so an amendment the scheduler makes on its
   * own (`#countRejection`) reaches everything an operator's does: the
   * executor, the gate broker and the integrator learn it through the runner's
   * `adopt`, which ends by calling this scheduler's.
   */
  bindAmendRunner(runner: AmendRunner): void {
    this.#amendRunner = runner
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
      // Parked mid-phase: `amend` let through only who works it (and the gate
      // table), so the node takes the new definition and keeps its pipeline.
      if (state.status === 'awaiting_human') {
        this.#adoptAssignment(state, node)
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
    this.#heights = computeHeights(workflow.nodes)
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
      this.#ended = true
      return this.#report(unrunnable)
    }

    this.#waves = computeWaves(this.#workflow.nodes)
    this.#heights = computeHeights(this.#workflow.nodes)
    this.#log.info('scheduler.started', {
      nodes: this.#workflow.nodes.length,
      waves: this.#waves.size,
      staffed: this.#staffed,
    })

    let stop: RunStop | null = null
    while (true) {
      this.#iterations += 1
      this.#dispatchReady()
      if (this.#settled() && !this.#awaitingRetry()) break
      // After `#settled`, so a run whose last node finished in the same turn
      // the operator halted it ends as what it actually was.
      if (this.#halt !== null && this.#active === 0) break

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

    this.#ended = true
    // A run held open for an aborted node's retry and then halted ends as the
    // halt, not as `failed`: nothing settled it, the operator ended it.
    const halted = this.#settled() && !this.#holdsAborted() ? null : this.#halt
    const status =
      halted ?? (stop === null && this.#failures().length === 0 ? 'done' : 'failed')
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
    const report = this.#report(stop)
    return halted === null ? report : { ...report, halted }
  }

  /**
   * Ends the run before the DAG does, at the operator's word. Resolves at once;
   * `run()` resolves when the drain is complete, having journalled `run_ended`
   * with `mode` as its status.
   *
   * Draining rather than stopping, for both modes. A node is only ever unwound
   * at a step boundary or before a step begins, so the lane it leaves behind is
   * the lane a resume adopts — never one with half a gate run in it. What
   * `cancelled` adds is the kill: every live agent turn and every running gate
   * ends now, and the boundary arrives as soon as their effects return.
   *
   * Nodes unwound by a halt go back to `pending`, which is what `#seed` would
   * make of them on a resume anyway. A node parked on a question is woken and
   * unwound too: the question belongs to a process that is about to end.
   *
   * Idempotent, and a pause can be upgraded to a cancel; the reverse is ignored.
   */
  async halt(mode: HaltMode): Promise<void> {
    if (this.#halt === 'cancelled' || this.#halt === 'interrupted' || this.#halt === mode) return
    this.#halt = mode
    // What the drain will wait for, named. A pause that does not finish is
    // waiting on one of these, and `{ mode }` alone left the operator to guess
    // which — the case that prompted this was an agent turn queued in `with`.
    const active = this.activity()
    this.#log.info('scheduler.halt', {
      mode,
      active: active.length,
      nodes: active.map((entry) => `${entry.node}:${entry.doing}`).join(','),
    })
    this.#halting.resolve()
    for (const state of this.#states.values()) {
      const resume = state.resume
      if (resume !== null) {
        state.resume = null
        state.parkedEffectId = null
        resume({})
      }
    }
    if (mode !== 'paused') {
      const kills: Promise<void>[] = []
      for (const state of this.#states.values()) {
        const live = state.live
        if (live !== null) kills.push(live.session.kill().catch(() => {}))
      }
      killLiveGates()
      await Promise.all(kills)
    }
    this.#wake()
  }

  /**
   * Nodes an operator (or the coordinator) aborted that are still failed.
   *
   * An abort is somebody's decision about one attempt, not a verdict that the
   * run is over — the usual next step is `retry`, often with a fix in between.
   * A run whose last runnable node was aborted, with every other pending
   * phase depending on it, used to settle in that same turn and end `failed`,
   * and the `retry` sent a moment later was refused as `run has ended`.
   */
  #abortedFailures(): NodeState[] {
    return [...this.#states.values()].filter((state) => state.aborted && state.status === 'failed')
  }

  /**
   * Whether aborted nodes hold the run open. Not under `onFailure: stop`,
   * which is the operator saying a failure ends the run and nobody will be
   * there to retry it — an abort ends it like any other failure.
   */
  #holdsAborted(): boolean {
    return (this.#options.onFailure ?? 'retry') !== 'stop' && this.#abortedFailures().length > 0
  }

  /**
   * Whether a run with nothing left to run stays up anyway, for an aborted
   * node's retry. Held the way `--on-failure retry` holds a failure on its
   * question: no timer ends it — the abort was a person's, so nothing retries
   * it for them — and a `retry`, or a `pause` or `stop` of the run, does.
   */
  #awaitingRetry(): boolean {
    if (this.#halt !== null) return false
    if (!this.#holdsAborted()) {
      this.#awaitingLogged = false
      return false
    }
    if (!this.#awaitingLogged) {
      this.#awaitingLogged = true
      const nodes = this.#abortedFailures().map((state) => state.node.id)
      this.#log.info('scheduler.awaiting_retry', { nodes: nodes.join(',') })
    }
    return true
  }

  /**
   * The nodes whose bodies are still executing, and the step each is in: a
   * live agent turn, a gate holding its pools, a question, or anything else
   * between two of those. The drain a halt starts ends when this is empty.
   */
  activity(): NodeActivity[] {
    const active: NodeActivity[] = []
    for (const state of this.#states.values()) {
      if (state.status !== 'running' && state.status !== 'awaiting_human') continue
      if (state.live !== null) {
        active.push({ node: state.node.id, doing: 'agent_turn', harness: state.live.adapter.id })
      } else if (state.gateLease !== null) {
        active.push({ node: state.node.id, doing: 'gate' })
      } else if (state.resume !== null) {
        active.push({ node: state.node.id, doing: 'question' })
      } else {
        active.push({ node: state.node.id, doing: 'step' })
      }
    }
    return active
  }

  /** Where a node goes when a halt reaches it: everything back, and `pending`. */
  #unwindHalted(state: NodeState): void {
    state.held = false
    state.delegable = false
    this.#release(state)
    if (!this.#settledNode(state) && state.status !== 'pending') this.#setStatus(state, 'pending')
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
   * rather than ending the run, so the loop is usually still there; and a run
   * whose only failures left are aborted nodes is held open for exactly this
   * (`#awaitingRetry`). A run that has genuinely finished is re-run, not
   * retried.
   *
   * An aborted node is failed the moment it is aborted and its body unwinds a
   * step later. Retried in between, it is queued and started as that body
   * leaves, so the old attempt can never step on the new one.
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
    if (this.#ended) throw new Error(`run has ended; start it again instead`)
    if (state.bodyActive) {
      state.retryQueued = true
      return
    }
    this.#reopen(state)
  }

  /** `retry`'s work, once nothing of the failed attempt is still running. */
  #reopen(state: NodeState): void {
    const nodeId = state.node.id
    state.retryQueued = false
    state.aborted = false
    // A deferred phase aborted while it waited for its start asks again.
    if (!state.released) state.deferredAsked = false
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
  answer(nodeId: string, facts: GuardContext, actor: Actor = 'operator', reason?: string): void {
    const state = this.#states.get(nodeId)
    if (state === undefined || state.resume === null) {
      throw new Error(`node "${nodeId}" is not awaiting an answer`)
    }
    if (actor === 'coordinator') {
      const refusal = this.#coordinatorMayNotAnswer(state)
      if (refusal !== null) throw new CoordinatorForbidden(refusal)
    }
    this.#settleQuestion(state, facts, actor, reason)
  }

  /**
   * Why the coordinator may not answer what this node is parked on, or null.
   *
   * By default it stands in for a timer, never for a person: it answers what
   * `--retry-after` could, and a hold it put on the node itself. Under
   * `--coordinator-authority full` it answers any question — except one the
   * operator is holding, which stays the operator's whatever the setting.
   */
  #coordinatorMayNotAnswer(state: NodeState): string | null {
    if (state.held || state.parkKind === 'hold') {
      return state.heldBy === 'coordinator' ? null : 'the operator paused this node'
    }
    if (state.delegable) return null
    if (this.#options.coordinatorAuthority === 'full') return null
    return 'this question is the operator\u2019s to answer'
  }

  /** Closes the question a node is parked on, journalled as `actor`'s answer, and wakes it. */
  #settleQuestion(state: NodeState, facts: GuardContext, actor: Actor, reason?: string): void {
    const resume = state.resume
    if (resume === null) return
    state.resume = null
    state.held = false
    state.heldBy = null
    state.delegable = false
    const answer = facts.human?.['answer']
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'human_answered',
      payload: {
        effect_id: state.parkedEffectId ?? '',
        answer: answer === undefined ? null : answer,
        // Set only by `#armUnattendedRetry`. An operator's answer never carries
        // it, so its absence is what says a person decided.
        ...(facts.human?.['unattended'] === true ? { unattended: true as const } : {}),
        ...(actor === 'coordinator' ? { by: actor } : {}),
        ...(reason === undefined ? {} : { reason }),
      },
    })
    state.parkedEffectId = null
    resume(actor === 'coordinator' ? { ...facts, human: { ...facts.human, by: actor } } : facts)
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
  async addContext(nodeId: string, text: string, actor: Actor = 'operator', reason?: string): Promise<OperatorDelivery> {
    const state = this.#stateOf(nodeId)
    if (this.#settledNode(state)) return this.#operation(state, 'add_context', text, 'ignored', actor, reason)

    const said = attributed(text, actor)
    // Delivered once, to one session, so it is also kept: the session that
    // reads it is not the last one this phase will run.
    this.#decide(state, decision('context', actor, text))
    const live = state.live
    if (live !== null && live.adapter.capabilities.inject) {
      await live.session.send(said)
      return this.#operation(state, 'add_context', text, 'sent', actor, reason)
    }
    state.pending.push({ op: 'add_context', text: said })
    return this.#operation(state, 'add_context', text, 'queued', actor, reason)
  }

  /**
   * §9 — interrupt, then the new instruction. The instruction rides the same
   * queue as added context: an interrupted turn is over, so §9's other reading
   * of this verb — "resume with an amended prompt" — is the one that can
   * actually deliver it.
   */
  async redirect(
    nodeId: string,
    instruction: string,
    actor: Actor = 'operator',
    reason?: string,
  ): Promise<OperatorDelivery> {
    const state = this.#stateOf(nodeId)
    if (this.#settledNode(state)) {
      return this.#operation(state, 'redirect', instruction, 'ignored', actor, reason)
    }

    await this.#interruptLive(state)
    this.#decide(state, decision('context', actor, instruction))
    state.pending.push({ op: 'redirect', text: attributed(instruction, actor) })
    return this.#operation(state, 'redirect', instruction, 'queued', actor, reason)
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
   *
   * **A node already parked on a question is held.** It is not running, so
   * there is no turn to finish — but under `--retry-after` it is not idle
   * either: a timer will answer its question, and the answer starts work. An
   * operator paused one such phase to keep its unattended retry out of the
   * integration worktree during a manual repair; the pause was recorded as
   * `ignored`, the API said `ok`, the timer fired, and the retry checked out
   * a wave branch under the operator's test run. A held node keeps its
   * question and its lane, no timer answers it, and the next answer — which
   * can only be a person's — releases it.
   */
  async pause(nodeId: string, actor: Actor = 'operator', reason?: string): Promise<OperatorDelivery> {
    const state = this.#stateOf(nodeId)
    if (state.status === 'awaiting_human' && state.resume !== null) {
      this.#holdQuestion(state, actor)
      return this.#operation(state, 'pause', undefined, 'held', actor, reason)
    }
    if (state.status !== 'running') return this.#operation(state, 'pause', undefined, 'ignored', actor, reason)
    state.pauseRequested = true
    state.heldBy = actor
    return this.#operation(state, 'pause', undefined, 'sent', actor, reason)
  }

  /**
   * Holds the question a node is parked on: no timer answers it. The
   * coordinator cannot take a hold off a node the operator is holding.
   */
  #holdQuestion(state: NodeState, actor: Actor): void {
    if (actor === 'coordinator' && state.held && state.heldBy !== 'coordinator') {
      throw new CoordinatorForbidden('the operator paused this node')
    }
    state.held = true
    state.heldBy = actor
    this.#log.info('node.held', { node: state.node.id })
  }

  /**
   * §9 — kill the session, mark the node failed, block its dependents. The
   * node is failed here rather than when its own loop unwinds, so an operator
   * who aborts sees the containment immediately; the loop discovers the abort
   * at its next step and stops without failing the node a second time.
   */
  async abortNode(nodeId: string, actor: Actor = 'operator', reason?: string): Promise<OperatorDelivery> {
    const state = this.#stateOf(nodeId)
    if (this.#settledNode(state)) return this.#operation(state, 'abort', undefined, 'ignored', actor, reason)

    state.aborted = true
    this.#operation(state, 'abort', undefined, 'sent', actor, reason)

    const live = state.live
    state.live = null
    if (live !== null) await live.session.kill()

    const resume = state.resume
    state.resume = null
    state.parkedEffectId = null
    this.#fail(state, actor === 'coordinator' ? 'aborted by the run coordinator' : 'aborted by the operator')
    // The node's own loop unwinds a turn later, and the run can settle before
    // it does — so the resources go back here rather than there. `#release` is
    // idempotent, so the unwinding loop repeating it changes nothing.
    this.#release(state)
    // A parked node is asleep on a promise nobody else will settle; waking it
    // is how it reaches the abort check and stops stepping.
    if (resume !== null) resume({})
    return 'sent'
  }

  /**
   * Drops the node's agent session, so its next turn starts cold, with the
   * whole brief rather than a delta (§15). Journalled `operator_fresh` on that
   * turn's `node_session` row.
   *
   * The operator's way out of a session gone wrong — an agent replaying work
   * its last process was killed under, or carrying on with the phase before —
   * that does not cost the attempt. The only route used to be `abort`, which
   * throws the attempt away with the session.
   *
   * It does not interrupt a live turn: one cut short moves the pipeline on
   * with whatever the turn left. Pair it with `redirect` to end the turn now.
   * An answer to an agent's own question still goes to the session that asked
   * it; the turn after that is the cold one. A settled node has no next turn,
   * and a `retry` is cold anyway, so both are `ignored`.
   */
  /**
   * §9 — undo `pause`. It had no undo of its own: a phase paused between turns
   * was released only by answering the synthesized "The operator paused this
   * node. Resume it?", which nothing documented, and a held one only by
   * answering its question by hand — giving up the unattended answer the run
   * was relying on.
   *
   * A pause still waiting for its turn to end is withdrawn; a phase parked on
   * the pause is let go; a held phase gets its question's timer back, a full
   * interval from now if it had already stood down. Anything else is `ignored`.
   * The coordinator cannot resume what the operator paused (§9.2).
   */
  resume(nodeId: string, actor: Actor = 'operator', reason?: string): OperatorDelivery {
    const state = this.#stateOf(nodeId)
    // The coordinator lifts its own holds and nobody else's (§9.2).
    if (actor === 'coordinator' && state.heldBy !== 'coordinator') {
      throw new CoordinatorForbidden('the operator paused this node')
    }
    if (state.pauseRequested || state.holdRequested) {
      state.pauseRequested = false
      state.holdRequested = false
      state.heldBy = null
      return this.#operation(state, 'resume', undefined, 'delivered', actor, reason)
    }
    if (state.resume !== null && state.parkKind === 'hold') {
      const delivered = this.#operation(state, 'resume', undefined, 'delivered', actor, reason)
      this.#settleQuestion(state, { human: { answer: 'resume' } }, actor)
      return delivered
    }
    if (state.held) {
      state.held = false
      state.heldBy = null
      const rearm = state.rearm
      state.rearm = null
      rearm?.()
      this.#log.info('node.resumed', { node: state.node.id })
      return this.#operation(state, 'resume', undefined, 'delivered', actor, reason)
    }
    return this.#operation(state, 'resume', undefined, 'ignored', actor, reason)
  }

  freshSession(nodeId: string, actor: Actor = 'operator', reason?: string): OperatorDelivery {
    const state = this.#stateOf(nodeId)
    if (this.#settledNode(state)) return this.#operation(state, 'fresh', undefined, 'ignored', actor, reason)
    state.freshRequested = true
    // The takeover handoff too: it is a session id the next spawn would resume.
    state.resumeSessionId = null
    // Every slot, not only the one the next turn uses: a chore slot continued
    // later would carry the same context forward.
    this.#ledgerOf(state).clear()
    this.#log.info('node.fresh_session', { node: state.node.id })
    return this.#operation(state, 'fresh', undefined, 'queued', actor, reason)
  }

  // -------------------------------------------------------------------------
  // Taking a phase over: interrupt, reassign, step, switch-harness
  //
  // `pause` waits for the turn, `redirect` keeps the session, `abort` fails
  // the phase and `fresh` changes nothing until the next turn. None of them
  // moves a phase to somebody else and lets it carry on from where it was,
  // which is what an operator needs when a harness runs out of credits under
  // five phases at once. These do, and none of them fails anything.
  // -------------------------------------------------------------------------

  /**
   * Stops the node's turn now without failing it. The node is **held**: it
   * parks on a question at the turn's boundary, keeping its lane, its branch,
   * its commits and its uncommitted work, and nothing answers that question
   * but `resume` (or a `reassign` or `step`, which release it). The state the
   * cut turn belonged to runs again on release, so nothing is skipped.
   *
   * A node already parked on a question is held there, as `pause` does.
   */
  async interrupt(nodeId: string, actor: Actor = 'operator', reason?: string): Promise<OperatorDelivery> {
    const state = this.#stateOf(nodeId)
    if (state.status === 'awaiting_human' && state.resume !== null) {
      this.#holdQuestion(state, actor)
      return this.#operation(state, 'interrupt', undefined, 'held', actor, reason)
    }
    if (state.status !== 'running') return this.#operation(state, 'interrupt', undefined, 'ignored', actor, reason)
    state.holdRequested = true
    state.heldBy = actor
    await this.#cutTurn(state)
    return this.#operation(state, 'interrupt', undefined, 'sent', actor, reason)
  }

  /**
   * Interrupts the live turn, and remembers that the state it belonged to has
   * to run again. A harness that cannot be interrupted finishes its turn, and
   * the node goes on from there instead.
   */
  async #cutTurn(state: NodeState): Promise<void> {
    const live = state.live
    if (live === null || !live.adapter.capabilities.interrupt) return
    state.holdCut = true
    await live.session.interrupt()
  }

  /**
   * Hands the phase to another crew member, or another harness and model, and
   * lets it carry on at the same pipeline step: `interrupt`, `amend` and
   * `resume` in one call.
   *
   * `now` (the default) cuts the live turn and runs its state again under the
   * new assignment; `after_turn` lets it finish and changes who takes the next
   * one. A held node, or one parked on a question, takes the change at once —
   * and a hold is released. The same member on the same harness keeps its
   * session (a model change alone); anyone else starts fresh with a handoff:
   * the previous agent's last report, where the work is, and the red gate.
   * Kept across later attempts of the phase, and over what the plan says.
   */
  async reassign(
    nodeId: string,
    target: ReassignTarget,
    options: { readonly when?: ReassignWhen; readonly actor?: Actor; readonly reason?: string } = {},
  ): Promise<OperatorDelivery> {
    const state = this.#stateOf(nodeId)
    const actor = options.actor ?? 'operator'
    const text = describeTarget(target)
    if (this.#settledNode(state)) return this.#operation(state, 'reassign', text, 'ignored', actor, options.reason)
    this.#vetReassign(state, target, actor)
    const change: Reassignment = {
      ...target,
      actor,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    }
    // In a step, holding a lane: the change waits for the boundary.
    if (state.status === 'running' && state.resume === null && state.lane !== null) {
      state.pendingReassign = change
      if ((options.when ?? 'now') === 'after_turn') {
        return this.#operation(state, 'reassign', text, 'queued', actor, options.reason)
      }
      await this.#cutTurn(state)
      return this.#operation(state, 'reassign', text, 'sent', actor, options.reason)
    }
    this.#applyReassign(state, change)
    const delivered = this.#operation(state, 'reassign', text, 'delivered', actor, options.reason)
    // A hold is the operator's own question; the reassignment is its answer.
    if (state.resume !== null && state.parkKind === 'hold') {
      this.#settleQuestion(state, { human: { answer: 'resume' } }, actor, options.reason)
    }
    // Asleep on the old harness's capacity wait: there is nothing to wait for now.
    state.nudge?.()
    return delivered
  }

  /** Refuses a reassignment this run cannot make, before anything moves. */
  #vetReassign(state: NodeState, target: ReassignTarget, actor: Actor): void {
    if (actor === 'coordinator' && (state.held || state.parkKind === 'hold') && state.heldBy !== 'coordinator') {
      throw new CoordinatorForbidden('the operator paused this node')
    }
    const { crew, harness, model } = target
    if (crew === undefined && harness === undefined && model === undefined) {
      throw new ReassignRefused('name a crew member, or a harness and a model')
    }
    if (crew !== undefined) {
      if (harness !== undefined || model !== undefined) {
        throw new ReassignRefused('a crew member carries a harness and a model; name one or the other')
      }
      if (!this.#staffed) throw new ReassignRefused('this workflow has no crew')
      if (this.#roster()[crew] === undefined) throw new ReassignRefused(`unknown crew member "${crew}"`)
      const theirs = crew === state.crew?.member || crew === state.desk
      if (!theirs && this.#busyCrew.has(crew)) {
        throw new ReassignRefused(`crew member "${crew}" is working on another phase`)
      }
      return
    }
    if (harness !== undefined) {
      if (this.#options.adapters[harness] === undefined) {
        throw new ReassignRefused(`no adapter registered for harness "${harness}"`)
      }
      if (model === undefined) throw new ReassignRefused(`a move to harness "${harness}" needs a model`)
    }
  }

  /**
   * Makes the change, and says so: who held the phase, who holds it now, and
   * whether the session survives the move.
   *
   * A different member keeps working in the worktree the phase is in — the
   * work is there — so the member whose desk it is stays busy until the node
   * lets the lane go (`desk`).
   */
  #applyReassign(state: NodeState, change: Reassignment): void {
    const before = change.from ?? this.#who(state)
    if (change.crew !== undefined) {
      // Later attempts are claimed for them too.
      state.retryMember = change.crew
      state.assignment = null
      const current = state.crew
      if (current !== null && current.member !== change.crew) {
        const member = this.#roster()[change.crew] as CrewMember
        if (state.desk === null) state.desk = current.member
        else this.#busyCrew.delete(current.member)
        if (state.desk === change.crew) state.desk = null
        this.#busyCrew.add(change.crew)
        state.crew = {
          member: change.crew,
          tier: member.tier,
          model: member.model,
          harness: member.harness ?? null,
        }
      }
    } else {
      state.assignment = {
        ...(state.assignment ?? {}),
        ...(change.harness === undefined ? {} : { harness: change.harness }),
        ...(change.model === undefined ? {} : { model: change.model }),
      }
    }
    this.#recordReassign(state, before, change)
  }

  /** The tail of every change of hands: the handoff when the session cannot follow, and the record. */
  #recordReassign(state: NodeState, before: Assignee, change: Omit<Reassignment, 'from'>): void {
    const after = this.#who(state)
    const kept = before.member === after.member && before.harness === after.harness
    // Only a phase that has done something has anything to hand over.
    if (!kept && state.step !== null) state.handoff = this.#composeHandoff(state, before)
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_reassigned',
      payload: {
        from: before,
        to: after,
        session: kept ? 'kept' : 'fresh',
        ...(change.actor === 'coordinator' ? { by: change.actor } : {}),
        ...(change.cause === undefined ? {} : { cause: change.cause }),
        ...(change.reason === undefined ? {} : { reason: change.reason }),
      },
    })
    this.#log.info('node.reassigned', {
      node: state.node.id,
      harness: after.harness,
      model: after.model,
      ...(after.member === undefined ? {} : { member: after.member }),
    })
  }

  /**
   * An amendment reached a parked node: its harness, model or crew member may
   * have moved. The node takes the new definition, the member is swapped as
   * `reassign` swaps one, and a change of hands is recorded like any other.
   */
  #adoptAssignment(state: NodeState, node: Node): void {
    const before = this.#who(state)
    const crewMoved = node.crew !== state.node.crew
    state.node = node
    if (crewMoved && node.crew !== undefined && state.crew !== null && state.crew.member !== node.crew) {
      this.#applyReassign(state, { crew: node.crew, cause: 'amendment', from: before })
      return
    }
    const after = this.#who(state)
    if (after.harness !== before.harness || after.model !== before.model) {
      this.#recordReassign(state, before, { cause: 'amendment' })
    }
  }

  /**
   * What an amendment asks of the live run that it cannot give a parked node:
   * a crew member who is busy elsewhere, a harness it has no adapter for.
   * Located like every other amendment refusal.
   */
  vetAmendment(workflow: Workflow): readonly { readonly path: (string | number)[]; readonly message: string }[] {
    const issues: { path: (string | number)[]; message: string }[] = []
    workflow.nodes.forEach((node, index) => {
      const state = this.#states.get(node.id)
      if (state === undefined || state.status !== 'awaiting_human') return
      const crew = node.crew
      if (crew !== undefined && crew !== state.node.crew && crew !== state.crew?.member && crew !== state.desk) {
        if (this.#busyCrew.has(crew)) {
          issues.push({ path: ['nodes', index, 'crew'], message: `crew member "${crew}" is working on another phase` })
        }
      }
      const harness = node.harness
      if (harness !== undefined && harness !== state.node.harness && this.#options.adapters[harness] === undefined) {
        issues.push({ path: ['nodes', index, 'harness'], message: `no adapter registered for harness "${harness}"` })
      }
    })
    return issues
  }

  /** Who works this node now: its member, if any, and the harness and model its next turn runs on. */
  #who(state: NodeState): Assignee {
    const { harness, model } = this.#resolved(state)
    return { ...(state.crew === null ? {} : { member: state.crew.member }), harness, model }
  }

  /**
   * What a fresh agent taking the phase over is told, beside its brief: whose
   * work it continues, where that work is, what the last agent last said, and
   * the gate that was red. Prompt text, handed to the next spawn and to nothing
   * else — the transcript it quotes already holds the same words.
   */
  #composeHandoff(state: NodeState, before: Assignee): string {
    const who = before.member === undefined ? `${before.harness} (${before.model})` : `crew member "${before.member}" (${before.harness}, ${before.model})`
    const lines = [
      `You are taking this phase over from ${who}, which was stopped${state.step === null ? '' : ` in pipeline step "${state.step}"`}. ` +
        'Continue its work rather than starting again.',
      '',
      'The work so far is in this worktree: the commits on its branch, and whatever it left uncommitted. ' +
        'Read it before changing anything — `git status`, `git log --oneline`, and `git diff` against the branch’s base.',
    ]
    const report = lastReport(this.#options.journal.tailTranscript(this.#options.runId, state.node.id, 200))
    if (report !== null) lines.push('', 'The previous agent’s last report:', '', ...report.split('\n').map((line) => `> ${line}`))
    const gate = state.lastGate
    if (gate !== null && gate.id !== null && gate.exitCode !== 0) {
      lines.push(
        '',
        `Gate "${gate.id}" is red (exit ${gate.exitCode}). Its log: ` +
          this.#options.journal.gateLogPath(this.#options.runId, state.node.id, gate.id),
      )
    }
    return lines.join('\n')
  }

  /**
   * Moves the node's pipeline to `to` by hand, so a person — or the
   * coordinator, under `--coordinator-authority full` — who finished the work
   * in the lane can hand it straight to the gates. The gates still decide: a
   * final state is refused, so no phase is ever *declared* done this way.
   *
   * A held or paused node, or one parked on its pipeline's own question, is
   * released into `to`. A running one has its turn cut and goes there at the
   * boundary. Anything else — a failure question, an agent's question in the
   * middle of a turn — is `ignored`: there is no pipeline position to move.
   */
  async step(nodeId: string, to: string, actor: Actor = 'operator', reason?: string): Promise<OperatorDelivery> {
    const state = this.#stateOf(nodeId)
    if (actor === 'coordinator' && this.#options.coordinatorAuthority !== 'full') {
      throw new CoordinatorForbidden('moving a pipeline by hand needs --coordinator-authority full')
    }
    if (!state.pipeline.states.some((candidate) => candidate.id === to)) {
      throw new StepRefused(`node "${nodeId}"'s pipeline has no state "${to}"`)
    }
    if (state.pipeline.finalStateIds.includes(to)) {
      throw new StepRefused(`"${to}" is a final state; the gates decide when a phase is done`)
    }
    if (state.status === 'awaiting_human' && state.resume !== null && state.parkKind !== null) {
      if (actor === 'coordinator') {
        const refusal = this.#coordinatorMayNotAnswer(state)
        if (refusal !== null) throw new CoordinatorForbidden(refusal)
      }
      state.stepTo = to
      const delivered = this.#operation(state, 'step', to, 'delivered', actor, reason)
      this.#settleQuestion(state, { human: { answer: `step:${to}` } }, actor, reason)
      return delivered
    }
    if (state.status === 'running' && state.resume === null) {
      state.stepTo = to
      await this.#cutTurn(state)
      return this.#operation(state, 'step', to, 'sent', actor, reason)
    }
    return this.#operation(state, 'step', to, 'ignored', actor, reason)
  }

  #takeStep(state: NodeState): string | null {
    const to = state.stepTo
    state.stepTo = null
    return to
  }

  /**
   * Moves the run off a harness: every turn that would have run on `from`
   * runs on `to` with `model` instead, for the rest of the run. Phases in
   * flight on it are reassigned (`when`, as `reassign` takes it), and phases
   * yet to start take the switch when they do. Returns the phases it moved.
   *
   * What `defaults.harness_fallbacks` does by itself when a harness runs out
   * of quota, and what an operator does by hand when an account runs out of
   * credits — without pausing the run and resuming it.
   */
  async switchHarness(
    from: string,
    to: string,
    model: string,
    options: {
      readonly when?: ReassignWhen
      readonly actor?: Actor
      readonly reason?: string
      /** The state that found the harness out, which the caller moves itself. */
      readonly except?: string
      readonly cause?: 'harness_fallback'
    } = {},
  ): Promise<readonly string[]> {
    if (from === to) throw new ReassignRefused(`harness "${from}" cannot be switched to itself`)
    if (this.#options.adapters[to] === undefined) throw new ReassignRefused(`no adapter registered for harness "${to}"`)
    const actor = options.actor ?? 'operator'
    // Read before the switch: afterwards every one of them resolves to `to`.
    const moving = [...this.#states.values()].filter(
      (state) =>
        state.node.id !== options.except &&
        (state.status === 'running' || state.status === 'awaiting_human' || state.status === 'waiting_on_capacity') &&
        this.#resolved(state).harness === from,
    )
    // Who each one was, taken before the switch changes the answer.
    const was = new Map(moving.map((state) => [state, this.#who(state)]))
    this.#switches.set(from, { harness: to, model })
    this.#options.journal.append({
      runId: this.#options.runId,
      type: 'harness_switched',
      payload: {
        from,
        to,
        model,
        ...(actor === 'coordinator' ? { by: actor } : {}),
        ...(options.cause === undefined ? {} : { cause: options.cause }),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
    })
    this.#log.warn('scheduler.harness_switched', { from, to, model, nodes: moving.length })
    this.#options.onHarnessSwitched?.(from, to, model)
    for (const state of moving) {
      const change: Reassignment = {
        harness: to,
        model,
        from: was.get(state) as Assignee,
        ...(options.cause === undefined ? { actor } : { cause: options.cause }),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }
      // Holds stay as they are: a switch moves who works, not whether.
      if (state.status === 'running' && state.resume === null && state.lane !== null) {
        state.pendingReassign = change
        if ((options.when ?? 'now') === 'now') await this.#cutTurn(state)
        continue
      }
      this.#applyReassign(state, change)
      state.nudge?.()
    }
    return moving.map((state) => state.node.id)
  }

  /**
   * `defaults.harness_fallbacks`: the harness this turn asked for is parked on
   * a quota refusal, and the plan names another to move to. Switches the run
   * and moves this node at once; true when the turn should be spawned again.
   * A harness switches once — a fallback that runs out too parks as before.
   */
  async #fallBackHarness(state: NodeState, harness: string): Promise<boolean> {
    if (this.#switches.has(harness)) {
      // Another phase found it out first, and the switch caught this one
      // mid-spawn: its move is applied now, before the turn it is for.
      const pending = state.pendingReassign
      state.pendingReassign = null
      if (pending !== null) this.#applyReassign(state, pending)
      if (this.#resolved(state).harness === harness) return false
      this.#setStatus(state, 'running')
      return true
    }
    const fallbacks: Readonly<Record<string, { readonly harness: string; readonly model: string } | undefined>> =
      this.#workflow.defaults.harness_fallbacks
    const fallback = fallbacks[harness]
    if (fallback === undefined || this.#options.adapters[fallback.harness] === undefined) return false
    const reason = `${harness} is out of quota`
    const from = this.#who(state)
    await this.switchHarness(harness, fallback.harness, fallback.model, {
      cause: 'harness_fallback',
      when: 'after_turn',
      reason,
      except: state.node.id,
    })
    this.#applyReassign(state, { harness: fallback.harness, model: fallback.model, cause: 'harness_fallback', reason, from })
    // Admission wrote the wait; the node never took it.
    this.#setStatus(state, 'running')
    return true
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
    if (this.#halt !== null) return
    for (const id of this.#order) {
      const state = this.#states.get(id) as NodeState
      if (state.status !== 'pending') continue
      const ready = state.node.depends_on.every((dep) => {
        const upstream = this.#states.get(dep.node)
        return upstream?.status === 'done' || upstream?.landed === true
      })
      if (!ready) continue
      // A deferred phase (`node.deferred`) waits for a person, not for its
      // dependencies: the plan said when it may run and this is not the
      // scheduler's call. Asked once; the answer releases it into this same
      // loop or fails it.
      if (state.node.deferred !== undefined && !state.released) {
        if (!state.deferredAsked) {
          state.deferredAsked = true
          this.#active += 1
          state.bodyActive = true
          void this.#holdDeferred(state)
            .catch((error: unknown) => {
              this.#log.error('scheduler.node_threw', { node: state.node.id, ...errorFields(error) })
              this.#fail(state, `scheduler error: ${errorKind(error)}`)
            })
            .finally(() => {
              this.#active -= 1
              this.#bodyExited(state)
              this.#wake()
            })
        }
        continue
      }
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
      this.#active += 1
      state.bodyActive = true
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
      }).finally(() => {
        this.#active -= 1
        this.#bodyExited(state)
        // Only a halt waits on this count; waking otherwise would add a loop
        // turn every node exit, which the scheduler's own tests count.
        if (this.#halt !== null) this.#wake()
      })
    }
  }

  /** A node body returned. A retry that arrived while it was unwinding an abort starts now. */
  #bodyExited(state: NodeState): void {
    state.bodyActive = false
    if (!state.retryQueued) return
    state.retryQueued = false
    // Only a node still failed and a run still live: a halt or an answer may
    // have moved it on since the retry was queued.
    if (state.status === 'failed' && !this.#ended) this.#reopen(state)
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
      if (this.#halt !== null) return this.#unwindHalted(state)
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
        if (this.#halt !== null) return this.#unwindHalted(state)
      }

      // All-or-nothing, canonical order, one call: the lane and nothing else.
      // Gate pools are acquired later, while this lane is still held, which is
      // the §6 rule that an idle lane is just disk.
      state.laneLease = await this.#options.pools.acquire([LANE])
      // The wait above ends when another node lets a lane go, and under a halt
      // that is every node on its way out. Taking the lane on would start work.
      if (this.#halt !== null) {
        state.laneLease.release()
        state.laneLease = null
        return this.#unwindHalted(state)
      }
      // A staffed node goes to its member's desk; an unstaffed one takes
      // whatever the free list has, exactly as before.
      state.lane =
        state.crew === null ? (this.#freeLanes.pop() as string) : this.#laneFor(state.crew.member)
      this.#options.journal.acquireLease(LANE, state.node.id)
      this.#assign(state, { lane: state.lane })
      state.attemptStartedAt = (this.#options.clock ?? systemClock).now()

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
        if (error instanceof Halted) return this.#unwindHalted(state)

        // A conflict fixer the harness would not start, for a reason that
        // ends by itself (§6.1). The fixer spawns outside admission control —
        // it has no slot to wait in — so its refusal arrives here as an error,
        // and it is handed to admission after the fact exactly as a window
        // closing mid-turn is: the harness parks, this node joins the wait,
        // and nothing is retried against a plan limit on a timer. Observed as
        // a phase failing on `plan-limit-reached` and `--retry-after` trying
        // it again every window, for as long as the limit lasted.
        const refusal = error instanceof ConflictFixerRefused ? error.refusal : null
        const retry =
          refusal === null
            ? error
            : this.#capacityRetryFor(error as ConflictFixerRefused, state, refusal)

        if (retry instanceof CapacityRetry) {
          const error = retry
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
          // Raced, because a capacity window can be hours and nothing else
          // would end this wait for a halt — or for a reassignment off the
          // harness it is waiting on.
          const nudged = deferred()
          state.nudge = nudged.resolve
          await Promise.race([error.waitFor(), this.#halting.promise, nudged.promise])
          state.nudge = null
          if (state.aborted) return
          if (this.#halt !== null) return this.#unwindHalted(state)
          this.#setStatus(state, 'running')
          continue
        }
        const reason = failureReason(error)
        this.#recordAttemptFailure(state, reason, error)
        // The operator was asked and said stop: no retry policy overrides that.
        if (error instanceof LoginDeclined) {
          this.#fail(state, attempted(reason, state))
          return
        }
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
    while (!state.aborted && this.#halt === null) {
      // The operator's pick, when they made one, stands in for the plan's.
      // `assignCrew` still refuses a member who is not an implementer on the
      // roster and still substitutes when the pick is busy, so an answer
      // cannot put a phase somewhere the plan would not.
      const target = state.retryMember ?? state.node.crew

      // The member is finishing a phase whose dependents were let go early —
      // only its PR's chores are left (`landed`). That is a short wait for a
      // warm session, and neither a cover nor a spare is worth what a cold one
      // costs.
      if (target !== undefined && this.#finishing(target)) {
        await this.#changed()
        continue
      }

      const decision: CrewDecision = assignCrew({
        assigned: target,
        crew: this.#roster(),
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
        substitution: this.#workflow.defaults.substitution,
      })

      if (decision.kind === 'unstaffed') return

      // The plan's own member, or somebody no pending phase is planned for.
      if (decision.kind === 'assigned' && (decision.member === state.node.crew || !this.#needed(decision.member, state))) {
        this.#take(state, decision)
        return
      }

      // Nobody qualified is free, or the one who is — the operator's pick
      // included — is planned for a phase still to come. Borrowing them moves
      // the wait onto that phase; waiting keeps it here. Observed: a retry put
      // on the member the next phase on the critical path was planned for left
      // that phase idle for seventeen minutes. So a spare is taken on in the
      // target's image, with a worktree of its own, while the budget lasts.
      const spare = await this.#spare(state, target)
      if (spare !== null) {
        this.#take(state, spare)
        return
      }
      if (decision.kind === 'assigned') {
        this.#take(state, decision)
        return
      }

      // Every member at or above the floor is working. A member frees only when
      // a node settles, and that is a state change — so this waits on the same
      // signal the dispatch loop does rather than polling.
      await this.#changed()
    }
  }

  /** Claims the member `decision` names for this node, and journals who it is. */
  #take(state: NodeState, decision: Extract<CrewDecision, { kind: 'assigned' }>): void {
    this.#busyCrew.add(decision.member)
    state.crew = {
      member: decision.member,
      tier: decision.tier,
      model: decision.model,
      harness: decision.harness,
    }
    const planned = decision.insteadOf === null ? undefined : this.#roster()[decision.insteadOf]
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_crew',
      payload: {
        member: decision.member,
        tier: decision.tier,
        substitute: decision.substitute,
        ...(decision.insteadOf === null
          ? {}
          : {
              instead_of: decision.insteadOf,
              ...(planned === undefined ? {} : { planned_tier: planned.tier }),
            }),
        ...(decision.reason === null ? {} : { reason: decision.reason }),
      },
    })
  }

  /** The roster the plan declared, and the spares this run took on since. */
  #roster(): Readonly<Record<string, CrewMember>> {
    if (this.#spares.size === 0) return this.#workflow.crew
    return { ...this.#workflow.crew, ...Object.fromEntries(this.#spares) }
  }

  /** Whether a phase still to start is planned for `member` — this one aside. */
  #needed(member: string, except: NodeState): boolean {
    for (const state of this.#states.values()) {
      if (state === except) continue
      // Dispatched and still claiming is waiting for a member just as much as
      // pending is: `running` is set before the claim, not after it.
      const waiting = state.status === 'running' && state.crew === null
      if (state.status !== 'pending' && state.status !== 'blocked' && !waiting) continue
      if ((state.retryMember ?? state.node.crew) === member) return true
    }
    return false
  }

  /** `member` is busy, and only with a landed phase's PR chores. */
  #finishing(member: string): boolean {
    if (!this.#busyCrew.has(member)) return false
    for (const state of this.#states.values()) {
      if (state.crew?.member === member) return state.landed
    }
    return false
  }

  /**
   * A member for this node in `target`'s image — an idle spare taken on
   * earlier, else a new one with a worktree provisioned for it — or null when
   * the budget is spent, the host cannot add a lane, or provisioning failed.
   *
   * Claimed before the worktree exists, so a second node deciding at the same
   * time counts it against the budget and cannot take it. A provisioning that
   * fails stops spares for the rest of the run: the same disk or the same
   * database would refuse the next one, and the run still has its roster.
   */
  async #spare(
    state: NodeState,
    target: string | undefined,
  ): Promise<Extract<CrewDecision, { kind: 'assigned' }> | null> {
    if (target === undefined) return null
    const source = this.#roster()[target]
    if (source === undefined) return null
    const origin = this.#spares.get(target)?.of ?? target
    const decision = (id: string): Extract<CrewDecision, { kind: 'assigned' }> => ({
      kind: 'assigned',
      member: id,
      tier: source.tier,
      model: source.model,
      harness: source.harness ?? null,
      substitute: true,
      insteadOf: state.node.crew ?? target,
      reason: 'spare_crew',
    })

    for (const [id, spare] of this.#spares) {
      if (this.#busyCrew.has(id) || spare.of !== origin) continue
      return decision(id)
    }

    const addLane = this.#options.addLane
    if (addLane === undefined || this.#sparesBroken) return null
    if (this.#spares.size >= this.#workflow.defaults.max_spare_crew) return null

    const ordinal = this.#spares.size + 1
    const id = `${origin}-spare-${ordinal}`
    const lane = `${this.#options.runId}-crew-${roster(this.#workflow.crew).length + ordinal}-${id}`
    const { description: _description, ...image } = source
    this.#spares.set(id, { ...image, of: origin })
    this.#busyCrew.add(id)
    try {
      await addLane(lane)
    } catch (error) {
      this.#spares.delete(id)
      this.#busyCrew.delete(id)
      this.#sparesBroken = true
      this.#log.warn('crew.spare_failed', { node: state.node.id, member: id, ...errorFields(error) })
      this.#wake()
      return null
    }
    this.#laneOf.set(id, lane)
    // The member brings its own desk, so the lane pool gets the slot to put it
    // in. A pool left at the roster's size would queue the spare behind the
    // phases it was taken on to stop waiting for.
    if (this.#workflow.resources[LANE] !== undefined) this.#options.pools.grow(LANE)
    this.#log.info('crew.spare_taken', { node: state.node.id, member: id, of: origin, lane })
    return decision(id)
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

    for (const member of roster(this.#roster())) {
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
            maxFixRounds: state.node.max_fix_rounds ?? null,
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
   * The implementer's slots only: a slot no implementer opens is one a claim
   * never starts on, so counting it would make a member look warm for a phase
   * on the strength of a session the phase's first turn will never reach.
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
    // `state.decisions` is the one thing about an attempt deliberately left
    // here: the branch goes, what was decided about the phase does not.
    state.fixRounds = 0
    state.agentRan = false
    state.unattendedGiven.clear()
    // For the same reason the budget goes: the next attempt re-drives the
    // pipeline from its initial state, so the gate that was red and the verdict
    // that was `fail` belong to a run that no longer exists. Carried over, they
    // would describe attempt 1's gate in attempt 2's failure — the one kind of
    // wrong answer worse than no answer, because it reads as evidence.
    state.lastGate = null
    state.lastRed = null
    state.lastVerdict = null
    state.step = null
    // A new attempt starts its pipeline from the top: there is no cut turn to
    // run again and no position to move. A pending hold still applies.
    state.holdCut = false
    state.stepTo = null
    if (state.crew === null) state.sessions.clear()
    else this.#ledgerFor(state.crew.member).clear()
  }

  /** Gives the node's member back to the roster and wakes whoever is waiting. */
  #releaseCrew(state: NodeState): void {
    // The member whose worktree a reassigned phase was in goes back with it.
    if (state.desk !== null) {
      this.#busyCrew.delete(state.desk)
      state.desk = null
      this.#wake()
    }
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
      // The lane name, the stage and the cause. The stage is the difference
      // between a database that would not reset, a worktree that would not come
      // back to its base, and a slot that could not be torn down and rebuilt;
      // the cause is which step refused and what it said.
      throw new LaneUnusable(recycleFailure(lane, error))
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
        // `null`, not absent, for a node with no limit: the pipeline's guards
        // compare against it, and a missing fact makes every comparison false.
        node: { id: state.node.id, max_fix_rounds: state.node.max_fix_rounds ?? null },
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
      // A pause lets the pipeline keep moving until it reaches its next piece
      // of work, which the effect door then refuses: a step whose turn just
      // ended may be one transition from done, and stopping it here would
      // throw that away. A cancel stops now, because the turn it ends was
      // killed, and a transition reading a killed turn as a failure would
      // record one that never happened.
      if (this.#halt !== null && this.#halt !== 'paused' && result.kind !== 'final') throw new Halted()

      if (result.kind === 'suspended') {
        // The question itself was journalled when the effect ran; here the
        // node only records which pause it is asleep on.
        state.parkedEffectId = result.effectId
        const cancel = this.#armUnattendedAnswer(state)
        state.parkKind = 'pipeline'
        const facts = await this.#park(state).finally(() => {
          state.parkKind = null
        })
        cancel()
        // `step --to` answered the question by moving past it.
        const to = this.#takeStep(state)
        result =
          to === null
            ? await run.resume(this.#withPending(state, run, facts))
            : await run.enter(to, this.#withPending(state, run, { ...facts, fix_rounds: state.fixRounds }))
        continue
      }
      if (result.kind === 'final') {
        return {
          outcome: this.#outcomeOf(state, result.state),
          state: result.state,
          // The interpreter's own name for the edge that ended the run. An
          // author-chosen id, which is what §11 allows. In `standard-phase`
          // both exhausted doors now leave through `t-stop`, and the gate and
          // verdict clauses `settledReason` adds are what tell them apart.
          ...(result.via === undefined ? {} : { via: result.via }),
        }
      }
      // Named rather than bare, so the reason reaches the journal: this used to
      // be reported as the word "Error" and nothing else. See
      // `PipelineStuckError`.
      if (result.kind === 'stuck') throw new PipelineStuckError(result.state, result.reason)

      // §9's pause, taken between turns, and `interrupt`'s hold: the lane
      // stays, the gate pools are already back, and the node waits on the same
      // promise a human gate does. A reassignment or a `step` that was waiting
      // for this boundary is applied here instead, and the node goes on.
      if (state.pauseRequested || state.holdRequested || state.stepTo !== null || state.pendingReassign !== null) {
        const holding = state.holdRequested
        const cut = state.holdCut
        state.pauseRequested = false
        state.holdRequested = false
        state.holdCut = false
        const reassign = state.pendingReassign
        state.pendingReassign = null
        let facts: GuardContext = {}
        if (reassign !== null) this.#applyReassign(state, reassign)
        if (reassign === null && state.stepTo === null) {
          const effectId = `${holding ? 'operator-hold' : 'operator-pause'}:${state.node.id}`
          const by = state.heldBy === 'coordinator' ? 'The run coordinator' : 'The operator'
          this.#ask(state, effectId, {
            question: holding ? `${by} interrupted this node. Resume it?` : `${by} paused this node. Resume it?`,
            kind: 'confirm',
          })
          state.parkedEffectId = effectId
          // An interrupt holds the node — no timer answers it — and `amend`
          // and `reassign` may move it while it waits.
          if (holding) state.held = true
          state.parkKind = 'hold'
          facts = await this.#park(state).finally(() => {
            state.parkKind = null
          })
        }
        // A turn that was cut short is run again, by whoever holds the phase
        // now; anything else goes on as a pause does.
        const to = this.#takeStep(state) ?? (cut ? result.state : null)
        const next = this.#withPending(state, run, { ...facts, fix_rounds: state.fixRounds })
        result = to === null ? await run.send({ facts: next }) : await run.enter(to, next)
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
    const fault = state.harnessFault
    state.harnessFault = false
    if (policy === 'stop' || state.aborted) return false

    // A harness fault is not spent against the automatic budget: every attempt
    // it buys is another empty turn, and the budget is gone in seconds.
    if (policy === 'retry' && !fault && state.autoRetries < (this.#options.retries ?? 1)) {
      state.autoRetries += 1
      // Cold, for the reason a capacity retry is: the branch the last attempt
      // built is gone and its worktree will be recycled, so a resumed session
      // would hold a memory of files that are no longer there.
      this.#restartAttempt(state)
      this.#setStatus(state, 'running')
      return true
    }
    return await this.#offerRetry(state, fault)
  }

  /** Counts a drained turn towards `EMPTY_TURN_FAULT`, or clears the count. */
  #countEmptyTurn(state: NodeState, adapter: HarnessAdapter, empty: boolean): void {
    if (!empty) {
      state.emptyTurns = null
      return
    }
    const previous = state.emptyTurns
    state.emptyTurns = {
      harness: adapter.id,
      count: previous?.harness === adapter.id ? previous.count + 1 : 1,
    }
  }

  #throwIfHarnessFault(state: NodeState, adapter: HarnessAdapter): void {
    const count = state.emptyTurns?.count ?? 0
    if (count < EMPTY_TURN_FAULT) return
    state.harnessFault = true
    this.#log.warn('node.harness_fault', { node: state.node.id, harness: adapter.id, empty_turns: count })
    throw new HarnessFault(
      `${adapter.id} ended ${count} turns in a row without the agent doing anything — ` +
        'treated as a harness fault, so it is not retried automatically',
    )
  }

  async #offerRetry(state: NodeState, fault = false): Promise<boolean> {
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
      question:
        `This phase failed. Try it again?${await this.#uncommittedNote(state)}` +
        this.#repeatedSetupNote(state) +
        (fault ? this.#harnessFaultNote(state) : ''),
      kind: 'choice',
      choices: this.#retryChoices(state),
    })
    state.parkedEffectId = effectId

    // A setup failure that has now repeated verbatim is not going to pass on
    // the third timer either. The question still waits for a person; only the
    // self-answer is withheld. One observed run retried four such phases
    // between four and twenty-three times each, every one on the same line.
    const repeated = this.#repeatedSetupFailure(state)
    if (repeated) {
      this.#log.warn('node.unattended_retry_withheld', {
        node: state.node.id,
        setup_repeats: state.setupFailure?.count ?? 0,
      })
    }
    // Withheld from the timer, not from the coordinator: a setup failure that
    // repeats is exactly what it is woken to fix and then retry.
    state.delegable = true
    const cancel = repeated ? () => {} : this.#armUnattendedRetry(state, fault)
    const facts = await this.#park(state)
    cancel()
    if (state.aborted) return false

    const answer = facts.human?.['answer']
    const chosen = typeof answer === 'string' ? answer : answer === true ? RETRY : STOP
    if (chosen === STOP) return false

    const member = chosen.startsWith(RETRY_WITH) ? chosen.slice(RETRY_WITH.length) : null
    if (member !== null && this.#workflow.crew[member] !== undefined) state.retryMember = member
    this.#restartAttempt(state)
    return true
  }

  /** Whether the last attempts all died in setup on one and the same line. */
  #repeatedSetupFailure(state: NodeState): boolean {
    return (state.setupFailure?.count ?? 0) >= REPEATED_SETUP_FAILURES
  }

  /**
   * Why a harness fault asks rather than retrying, and what a person can do
   * about it: the harness, not the phase, is what is broken, so `retry with`
   * a member on another harness is the answer most likely to work.
   */
  #harnessFaultNote(state: NodeState): string {
    const harness = state.emptyTurns?.harness ?? 'the harness'
    const count = state.emptyTurns?.count ?? EMPTY_TURN_FAULT
    return (
      ` ${harness} ended ${count} turns in a row without the agent doing anything, which is the ` +
      'harness failing rather than the work, so no automatic attempt was spent on it. Check that ' +
      `${harness} runs and is logged in, or retry with a member on another harness.`
    )
  }

  /** The sentence that says why this question will not answer itself. */
  #repeatedSetupNote(state: NodeState): string {
    if (!this.#repeatedSetupFailure(state)) return ''
    const count = state.setupFailure?.count ?? 0
    return (
      ` It has failed during setup, before any agent ran, ${count} times in a row with the same ` +
      'error, so it will not be retried unattended: fix the cause, then retry.'
    )
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
                member.tier >= floor &&
                id !== assigned &&
                id !== state.lastMember,
            )
            .map(([id]) => `${RETRY_WITH}${id}`)
    return [RETRY, ...others, STOP]
  }

  /**
   * `admit`, with §6.1's login rule around it: an `unauthenticated` harness
   * parks this node on a question to the operator, in place, and the spawn is
   * attempted again only once they say the harness is logged in. Never an
   * automatic retry and never an unattended one — retrying cannot log a CLI in,
   * and whatever `onFailure` says is about failures, which this is not.
   *
   * In place, holding the lane, because a login can lapse mid-pipeline and the
   * lane is the implementer's work (§6.1's rule for a mid-pipeline refusal). A
   * node refused at dispatch holds an empty lane across the wait; on a
   * single-harness run nothing else could use it, since every spawn is refused.
   *
   * `build` is called per attempt so a retry carries whatever the operator
   * queued while the node waited.
   */
  async #admitLoggedIn(
    state: NodeState,
    adapter: HarnessAdapter,
    build: () => AgentTask,
    options: AdmitOptions,
  ): Promise<Exclude<AdmissionOutcome, { status: 'unauthenticated' }>> {
    const admission = this.#options.admission
    for (;;) {
      const outcome = await admission.admit(adapter, build(), options)
      if (outcome.status !== 'unauthenticated') return outcome
      if (!(await this.#awaitLogin(state, adapter.id))) throw new LoginDeclined(outcome.message)
    }
  }

  /**
   * Asks the operator to log `harness` in, and returns whether they did.
   *
   * Every node refused by the same harness asks, so each is answerable where
   * the operator finds it — but they are one question: the first `logged in`
   * answers all of them, because the login it reports is the harness's, not
   * the node's. `stop` answers only the node it was given for.
   */
  async #awaitLogin(state: NodeState, harness: string): Promise<boolean> {
    if (state.aborted) return false
    state.loginAsks += 1
    const effectId = `login:${state.node.id}:${state.loginAsks}`
    this.#ask(state, effectId, {
      // The harness id and nothing the vendor said (§11).
      question: `${harness} is not logged in. Log it in on this machine, then answer "${LOGGED_IN}" to continue.`,
      kind: 'choice',
      choices: [LOGGED_IN, STOP],
    })
    state.parkedEffectId = effectId

    const waiting = this.#loginWaiters.get(harness) ?? new Set<NodeState>()
    this.#loginWaiters.set(harness, waiting)
    waiting.add(state)
    let facts: GuardContext
    try {
      facts = await this.#park(state)
    } finally {
      waiting.delete(state)
    }

    if (facts.human?.['answer'] !== LOGGED_IN) return false
    this.#options.admission.loggedIn(harness)
    for (const other of [...waiting]) {
      if (other.resume !== null) this.answer(other.node.id, facts)
    }
    return true
  }

  /**
   * Parks a node on an unanswered question: `awaiting_human`, its lane still
   * held, waiting on the promise `answer` resolves. The one place a node
   * sleeps, so the one place an abort has to be able to wake it.
   */
  async #park(state: NodeState): Promise<GuardContext> {
    // Nobody will answer: the process asking is on its way out.
    if (this.#halt !== null) throw new Halted()
    this.#setStatus(state, 'awaiting_human')
    const facts = await new Promise<GuardContext>((resolve) => {
      state.resume = resolve
    })
    if (state.aborted) throw new Aborted()
    if (this.#halt !== null) throw new Halted()
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
    actor: Actor = 'operator',
    reason?: string,
  ): OperatorDelivery {
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_operation',
      payload: {
        op,
        delivery,
        ...(text === undefined ? {} : { text }),
        ...(actor === 'coordinator' ? { by: actor } : {}),
        ...(reason === undefined ? {} : { reason }),
      },
    })
    return delivery
  }

  /**
   * Keeps one of the phase's decisions, in memory and on disk, unless it is
   * already kept. Logged by kind only: the text is prose (§11).
   */
  #decide(state: NodeState, entry: Decision): void {
    if (!appendDecision(state.decisions, entry)) return
    this.#options.journal.appendDecision(this.#options.runId, state.node.id, entry)
    this.#log.info('node.decision', { node: state.node.id, kind: entry.kind, by: entry.by })
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
        // The one door every new piece of work goes through — an agent turn, a
        // gate, a chore, a question. Shut under a halt.
        if (this.#halt !== null) throw new Halted()
        const verb = invocation.effect.definitionId
        // The state's first effect is the moment it is entered; the
        // interpreter reports a state only once its effects are done, which
        // is too late to say what the node is doing now.
        const origin = invocation.origin
        if (origin.kind === 'onEnter' && origin.stateId !== state.step) {
          state.step = origin.stateId
          this.#options.journal.append({
            runId: this.#options.runId,
            nodeId: state.node.id,
            type: 'node_step',
            payload: { state: origin.stateId, attempt: state.retries + state.autoRetries + 1 },
          })
        }
        // Past setup: from here a failure is the phase's, not the machinery's.
        if (verb === 'spawn_agent' || verb === 'run_chore') state.agentRan = true
        if (verb === 'spawn_agent') return this.#observe(state, await this.#spawnTurn(state, invocation))
        if (verb === 'run_chore') return this.#observe(state, await this.#chores(state, invocation))
        if (verb === 'run_gate') {
          await this.#acquireGate(state, invocation)
          return this.#observe(state, await this.#runGate(state, invocation))
        }
        // The question is journalled before the host executor runs, because
        // the host executor is what raises the notification: the record of the
        // pause exists first, so a restart reads it instead of re-asking.
        if (verb === 'await_human') {
          this.#ask(state, invocation.effect.id, questionOf(invocation.effect.params))
          state.unattendedAnswer = unattendedAnswerFor(
            invocation.effect.params['unattended_answer'],
            state.unattendedGiven.get(invocation.effect.id) ?? 0,
          )
        }
        if (verb === 'grant_fix_rounds') {
          // §16.3. The counter is the scheduler's, so this is the one place it
          // moves other than a fixer finishing; the fact goes back with it so a
          // guard read in this same step sees the budget it was just given.
          this.#log.info('node.fix_rounds_granted', {
            node: state.node.id,
            spent: state.fixRounds,
            granted: state.node.max_fix_rounds ?? null,
          })
          state.fixRounds = 0
          await this.#options.executor.execute(invocation)
          return { facts: { fix_rounds: 0 } }
        }
        return this.#observe(state, await this.#options.executor.execute(invocation))
      },
    }
  }

  /**
   * `run_gate`, with the fix loop's stall check around it (§13.4).
   *
   * A gate red again on the very tree it was red on before a fixer turn means
   * the turn changed nothing the gate reads. Another fixer is the wrong answer
   * to that: observed as twenty in a row, each finding nothing to fix and
   * ending without a commit, while the cache replayed a typecheck failure
   * whose cause — stale ignored files in the lane — was already gone. The
   * cache keys on the tree, so a cause outside it can be removed without the
   * key noticing.
   *
   * So a stall gets one fresh run of the red gate before anything else. Green,
   * or red differently, and the loop carries on with the fresh answer. Red the
   * same way, and the fact goes out as `gate.stalled`, which `standard-phase`
   * routes to `exhausted` — the existing door to a person, with the existing
   * unattended answer — rather than to another fixer. A red that was already a
   * fresh run skips straight to that: asking the same tree the same question a
   * third time would learn nothing.
   *
   * Keyed on the gate *and* the tree. A fixer that moved the tree at all, by a
   * commit or an uncommitted edit, is a fixer that tried, and is never a stall.
   */
  async #runGate(state: NodeState, invocation: EffectInvocation): Promise<EffectOutcome> {
    const executor = this.#options.executor
    let outcome = await executor.execute(invocation)
    let red = redGateOf(outcome)
    const prior = state.lastRed
    state.lastRed = red === null ? null : { gate: red.gate, tree: red.tree, fixedSince: false }
    if (red === null || prior === null || !prior.fixedSince) return outcome
    if (prior.gate !== red.gate || prior.tree !== red.tree) return outcome

    if (red.cached) {
      outcome = await executor.execute({
        ...invocation,
        effect: { ...invocation.effect, params: { ...invocation.effect.params, no_cache: red.gate } },
      })
      const again = redGateOf(outcome)
      if (again === null || again.gate !== red.gate || again.tree !== red.tree) {
        this.#stalled(state, red, 'rerun_cleared')
        state.lastRed = again === null ? null : { gate: again.gate, tree: again.tree, fixedSince: false }
        return outcome
      }
      red = again
    }

    this.#stalled(state, red, 'escalated')
    const gate = outcome.facts?.gate
    return { ...outcome, facts: { ...outcome.facts, gate: { ...(isFactRecord(gate) ? gate : {}), stalled: true } } }
  }

  #stalled(state: NodeState, red: RedGate, outcome: 'rerun_cleared' | 'escalated'): void {
    this.#log.warn('node.gate_stalled', { node: state.node.id, gate: red.gate, outcome })
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'gate_stalled',
      payload: { gate: red.gate, tree: red.tree, outcome },
    })
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
        ...(gate?.['stalled'] === true ? { stalled: true } : {}),
      }
    }
    const verdict = outcome.facts?.review?.['verdict']
    if (verdict === 'pass' || verdict === 'fail') {
      state.lastVerdict = verdict === 'fail' && outcome.facts?.review?.['stated'] === false ? 'silent' : verdict
    }
    return outcome
  }

  /**
   * The node's chores at one point in the phase, one agent turn each, in
   * declaration order.
   *
   * Every one of them is an ordinary spawn — same admission control, same
   * session ledger, same transcript — so this composes `#spawnTurn` rather than
   * doing anything of its own. What it owns is the questions a chore raises
   * that a role in the pipeline does not: which chores this node runs, what
   * happens when one of them cannot, and — for a review chore — what it said.
   *
   * **A review chore is the phase's review (§16)**, so it is the one chore that
   * decides something. Its turn ends on a `VERDICT:` line, and this returns
   * `review.verdict`: `pass` once every review chore approved, `fail` at the
   * first that did not, without running the rest. A turn that broke is a review
   * nobody approved, so it reads as `fail` too, and the pipeline puts it to the
   * operator rather than failing an implemented phase over it. A node with no
   * review chore passes.
   *
   * **Any other chore that fails does not fail the phase**, unless it says to.
   * The default exists because of what the alternative costs: the phase is
   * written, reviewed and about to be gated, and throwing that away because a
   * comment pass timed out is a far worse trade than merging comments nobody
   * tidied.
   *
   * **A capacity refusal is the same answer, and this is the surprising half.**
   * Everywhere else a `CapacityRetry` re-drives the node from its initial state
   * — correct for a fixer, since the alternative is losing the fix — but here
   * it would re-implement an entire finished phase to get a polish turn in. So
   * an `on_failure: 'continue'` chore is skipped when the harness is full, and
   * only a chore the phase is declared incorrect without is worth the re-drive.
   * A review is never skipped: skipping it would merge a phase nobody reviewed.
   *
   * `Aborted` is never swallowed by either: the run is being torn down, and
   * there is nothing left for the next chore to run in.
   *
   * **An `after_pr` chore with no PR is skipped**, not failed. `open_pr` never
   * fails a phase — a missing `gh` leaves the work merged and says so — and a
   * chore about the PR has nothing to work on when there is none.
   */
  async #chores(state: NodeState, invocation: EffectInvocation): Promise<EffectOutcome> {
    const named = invocation.effect.params['chore']
    const declared = this.#workflow.chores[typeof named === 'string' ? named : '']
    const asked = invocation.effect.params['when']
    const when: ChoreTiming = CHORE_TIMINGS.find((timing) => timing === asked) ?? 'after_review'
    // A named chore is run whatever the node declared — that is what naming one
    // in the pipeline is for. Everything else takes the node's own list, at
    // this point in the phase.
    const chores =
      typeof named === 'string'
        ? declared === undefined
          ? []
          : [{ id: named, chore: declared }]
        : choresFor(this.#workflow, state.node, when)
    const prOpened = invocation.context.pr?.['opened'] === true
    let verdict: 'pass' | 'fail' = 'pass'
    // False when the review that did not approve stated nothing at all (§16.2).
    let stated = true

    // The `after_pr` chores run after the merge, the push and the PR — a review
    // canvas, a PR comment. They edit nothing anybody builds on, and when none
    // of them may fail the phase nothing after this point can either. Holding
    // the dependents for them put minutes of PR decoration on the critical
    // path of every phase: observed at up to four minutes a phase, for a step
    // that failed outright on most of them.
    if (when === 'after_pr' && chores.every((entry) => entry.chore.on_failure !== 'fail')) {
      state.landed = true
      this.#wake()
    }

    for (const entry of chores) {
      const startedAt = Date.now()
      if (entry.chore.when === 'after_pr' && !prOpened) {
        this.#choreResult(state, entry.id, 'skipped', startedAt)
        continue
      }
      const review = entry.chore.when === 'review'
      const spawn: EffectInvocation = {
        ...invocation,
        effect: {
          ...invocation.effect,
          // Distinct per chore, because the interpreter and the operator's
          // pause both key on it and three chores under one id are one.
          id: `${invocation.effect.id}:${entry.id}`,
          definitionId: 'spawn_agent',
          params: {
            role: 'chore',
            prompt_template: 'chore',
            session: entry.chore.session,
            ...(entry.chore.model === undefined ? {} : { model: entry.chore.model }),
            ...(review ? { verdict: true } : {}),
          },
        },
      }

      try {
        const outcome = await this.#spawnTurn(state, spawn, entry)
        if (review && outcome.facts?.review?.['verdict'] !== 'pass') {
          this.#choreResult(state, entry.id, 'failed', startedAt)
          verdict = 'fail'
          stated = outcome.facts?.review?.['stated'] !== false
          await this.#countRejection(state)
          break
        }
        this.#choreResult(state, entry.id, 'ran', startedAt)
      } catch (error) {
        if (error instanceof Aborted) throw error
        if (error instanceof CapacityRetry) {
          if (review || entry.chore.on_failure === 'fail') throw error
          this.#choreResult(state, entry.id, 'skipped', startedAt)
          continue
        }
        if (!review && entry.chore.on_failure === 'fail') throw error
        this.#choreResult(state, entry.id, 'failed', startedAt)
        if (review) {
          verdict = 'fail'
          stated = false
          await this.#countRejection(state)
          break
        }
      }
    }

    // Through the host seam on the way out, exactly as `run_gate` is: the
    // scheduler owns spawning and the catalog is the host's (§5.2), so a host
    // that wants to know its chores ran is told by the verb rather than by
    // inspecting the turns. Only the review states a fact; the others are not
    // something a guard branches on.
    const outcome = await this.#options.executor.execute(invocation)
    if (when !== 'review') return outcome
    return {
      facts: { ...outcome.facts, review: { ...outcome.facts?.review, verdict, ...(stated ? {} : { stated: false }) } },
    }
  }

  /**
   * One more review that did not approve, and the desk moves up a tier once
   * there have been `defaults.escalate_after_rejections` of them.
   *
   * One observed run left a Tier 1 phase on its desk through 16 rejections
   * over six hours, until the coordinator moved it with four amendments. The
   * rule is the one a person applied: the cheapest member of the next tier up
   * the roster takes the phase. It is an amendment — `author: scheduler`, with
   * the rule and the count as its `reason` — rather than a private override
   * like `retry with`, so it reads in the run's history like any other change
   * of desk, survives a resume in the snapshot, and reaches the host through
   * `bindAmendRunner` the way an operator's does. A crew change moves no base,
   * so it is never refused for the phase being in flight; the new desk takes
   * the phase at its next claim, which is its next attempt.
   *
   * Never throws: an amendment that cannot be made leaves the phase where it
   * was, and the review's own outcome is what the caller is reporting.
   */
  async #countRejection(state: NodeState): Promise<void> {
    state.reviewRejections += 1
    const limit = this.#workflow.defaults.escalate_after_rejections ?? 3
    if (limit === 0 || state.reviewRejections < limit) return
    const from = state.retryMember ?? state.node.crew
    const desk = from === undefined ? undefined : this.#workflow.crew[from]
    if (from === undefined || desk === undefined) return
    const next = roster(this.#workflow.crew).find((member) => member.tier > desk.tier)
    if (next === undefined) {
      if (state.reviewRejections === limit) {
        this.#log.info('node.escalation_unavailable', { node: state.node.id, member: from, tier: desk.tier })
      }
      return
    }

    const nodeId = state.node.id
    const rejections = state.reviewRejections
    const proposed: Workflow = {
      ...this.#workflow,
      nodes: this.#workflow.nodes.map((node) => (node.id === nodeId ? { ...node, crew: next.id } : node)),
    }
    try {
      const result = await amendRun({
        journal: this.#options.journal,
        runId: this.#options.runId,
        proposed,
        runner: this.#amendRunner ?? { adopt: (workflow) => this.adopt(workflow) },
        author: 'scheduler',
        targets: [`node:${nodeId}`],
        reason: `review did not approve ${rejections} times on ${from}; moved up to ${next.id}`,
        rule: {
          kind: 'review_rejections',
          node: nodeId,
          from,
          to: next.id,
          from_tier: desk.tier,
          to_tier: next.tier,
          rejections,
        },
      })
      if (!result.ok) {
        this.#log.warn('node.escalation_refused', { node: nodeId, code: result.code })
        return
      }
      // `adopt` replaces only unstarted nodes' definitions, and this one is
      // running: its next claim reads the desk from here.
      const amended = result.workflow.nodes.find((node) => node.id === nodeId)
      if (amended !== undefined) state.node = amended
      state.retryMember = null
      state.reviewRejections = 0
      this.#log.info('node.escalated', {
        node: nodeId,
        from,
        to: next.id,
        to_tier: next.tier,
        rejections,
        amendment: result.amendment,
      })
    } catch (error) {
      this.#log.warn('node.escalation_failed', { node: nodeId, ...errorFields(error) })
    }
  }

  #choreResult(state: NodeState, chore: string, status: ChoreStatus, startedAt: number): void {
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'chore_result',
      payload: { chore, status, duration_ms: Date.now() - startedAt },
    })
  }

  async #spawnTurn(
    state: NodeState,
    invocation: EffectInvocation,
    chore?: ChorePrompt,
  ): Promise<EffectOutcome> {
    const { params } = invocation.effect
    const { workflow, runId, journal } = this.#options
    const adapter = this.#adapter(this.#harnessOf(state, params['harness']))

    // §9's queue, on its way to the agent. Carried as its own field rather
    // than folded into the brief so the adapter can present it as the
    // operator's; nothing is cleared until a session is actually granted,
    // because a capacity retry that swallowed it would lose the steering for
    // good.
    const carried = state.pending.length
    // A reassignment's handoff first: it says whose work the rest is about.
    const handoff = state.handoff
    const owed = [
      ...(handoff === null ? [] : [handoff]),
      ...state.undelivered,
      ...state.pending.map((entry) => entry.text),
    ]

    // Every role runs in the node's own lane.
    const cwd = join(this.#options.laneRoot, state.lane as string)
    // The lane's own environment, for the process that is about to run the
    // project's commands in it.
    const laneEnv = this.#options.laneEnv?.(state.lane as string) ?? {}
    // The lease client attributes journal rows to the phase that asked. Only
    // add it where the host exposed a daemon URL; an injected/test host with no
    // lease route keeps the exact environment it supplied before this feature.
    //
    // And the session: a fresh turn id per task built, so a command left
    // running when its session ends can be told apart from the next session's.
    let turnId: string | null = null
    const envField = (): { readonly env?: Readonly<Record<string, string>> } => {
      if (laneEnv[MAESTRO_URL_ENV] === undefined) {
        return Object.keys(laneEnv).length === 0 ? {} : { env: laneEnv }
      }
      turnId = randomUUID()
      return { env: { ...laneEnv, [MAESTRO_NODE_ENV]: state.node.id, [MAESTRO_TURN_ENV]: turnId } }
    }

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
        // Whether a turn that waits can end and be woken, which decides how
        // every turn is told to wait on work it started.
        backgroundWork: adapter.capabilities.backgroundWork,
        harness: adapter.id,
        // The instruction this turn exists to carry out, on a chore turn and
        // nowhere else. Unlike everything above it, it is passed on a
        // continuation too: the session holds the phase, never the chore.
        ...(chore === undefined ? {} : { chore }),
        // Only on a cross-phase continuation. A same-phase one is a delta and
        // has nothing to be re-oriented about; a cold one has no memory to
        // correct.
        ...(plan.crossPhase && reorientation !== null ? { reorientation } : {}),
        // On every form, a delta included: a decision made in another session
        // — a reviewer's, a replaced one's — is not in this one.
        decisions: state.decisions,
      }),
      model: this.#modelFor(state, params),
      ...envField(),
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
    const reorientation = await this.#reorientation(state, plan)
    // The tallest node first when the harness is throttled; see `computeHeights`.
    const priority: AdmitOptions = {
      priority: this.#heights.get(state.node.id) ?? 0,
      fallbacks: this.#workflow.defaults.model_fallbacks,
    }
    let outcome = await this.#admitLoggedIn(state, adapter, () => build(plan), priority)
    // The harness is out of quota and the plan names one to move to: the turn
    // goes there now, at this step, rather than waiting out the window.
    if (outcome.status === 'retry' && outcome.kind === 'quota' && (await this.#fallBackHarness(state, adapter.id))) {
      return await this.#spawnTurn(state, invocation, chore)
    }

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
      outcome = await this.#admitLoggedIn(state, adapter, () => build(plan), priority)
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
    if (state.handoff === handoff) state.handoff = null

    // Journalled here rather than at the decision: this is the first moment a
    // turn is certain to happen. A capacity refusal unwinds and re-drives the
    // whole node, and a row written before `admit` would claim a turn that
    // never ran. A stale-session retry needs no second row either — the plan
    // that won is the one carrying `stale_session`, so one row per turn still
    // says what happened (§15).
    this.#session(state, plan)
    this.#remember(state, plan, adapter, outcome.session.id)

    // Every spawn on this node appends to the same file, whatever its role, so
    // without this the implementer's output, three fix rounds' and the review
    // loop's are one undifferentiated stream. Both facts are already here and
    // were simply not written down (`journal/transcript.ts`).
    const by: Attribution = {
      role: typeof params['role'] === 'string' ? params['role'] : 'agent',
      ...(plan.slot === null ? {} : { slot: plan.slot }),
      // Three chores on one slot are one stretch of transcript without it.
      ...(chore === undefined ? {} : { chore: chore.id }),
    }
    // Read once: a reassignment while the agent waits on an answer moves the
    // phase's next turn, not the session this one resumes.
    const turnModel = this.#modelFor(state, params)
    let turn: Turn = {
      adapter,
      cwd,
      plan,
      role: params['role'],
      by,
      priority,
      // An answer resumes the session it was asked in, with the answer as the
      // whole message: the session already holds the brief.
      task: (prompt, resumeSessionId) => ({
        nodeId: state.node.id,
        cwd,
        prompt,
        model: turnModel,
        ...envField(),
        resumeSessionId,
      }),
      turnId: () => turnId,
    }
    let watch = new QuestionWatch()
    let drained: { readonly sessionId: string; readonly empty: boolean }
    try {
      drained = await this.#drain(state, outcome, turn, watch)
    } catch (error) {
      // Out of quota partway through, and moved: the same step, on the fallback.
      if (error instanceof HarnessFellBack) return await this.#spawnTurn(state, invocation, chore)
      throw error
    }

    // A turn the model never took part in: the session started and ended with
    // no text and no tool call. Its prompt did not reach the agent, so nothing
    // the pipeline reads next — a commit, a verdict — can be about it.
    //
    // Observed on resumes. claude-code replays the notifications of background
    // work its previous process was killed under, and closes that replay with a
    // `result` before it reads the new prompt; read as the end, it is a turn
    // that cost nothing and did nothing. On a review turn that is a `fail` with
    // no reviewer behind it, sent to the operator as `unapproved`. On a
    // cross-phase continuation it is worse: the new phase's brief was in the
    // prompt that was never read, the ledger now files the session under the
    // new phase, and every later turn gets a delta — so the agent carries on
    // with the phase it last worked on, under the next one's name.
    //
    // Retried once, cold and with the whole brief, the way §15.4 retries a
    // session the vendor forgot: a fresh session has no replay to make and no
    // memory to be wrong about. A cold turn that is empty too is a harness that
    // is not working, and that is a failure of the turn, not of the work.
    //
    // **Two in a row is a harness fault**, whichever attempts they fell in:
    // `HarnessFault` skips the automatic retries and parks the phase on the
    // failure question, where `--retry-after` answers with its backoff.
    this.#countEmptyTurn(state, adapter, drained.empty)
    if (drained.empty) {
      this.#log.warn('node.empty_turn', {
        node: state.node.id,
        harness: adapter.id,
        resumed: plan.resumeSessionId !== null,
        in_a_row: state.emptyTurns?.count ?? 0,
      })
      this.#throwIfHarnessFault(state, adapter)
      if (plan.resumeSessionId === null) {
        throw new SpawnFatal(`${adapter.id} ended the turn without the agent doing anything`)
      }
      plan = {
        slot: plan.slot,
        resumeSessionId: null,
        continuation: false,
        crossPhase: false,
        reason: 'empty_turn',
        turns: 1,
      }
      const cold = await this.#admitLoggedIn(state, adapter, () => build(plan), priority)
      if (cold.status === 'retry') throw new CapacityRetry(cold.wait)
      if (cold.status !== 'admitted') throw new SpawnFatal(cold.message)
      this.#session(state, plan)
      this.#remember(state, plan, adapter, cold.session.id)
      turn = { ...turn, plan }
      watch = new QuestionWatch()
      drained = await this.#drain(state, cold, turn, watch)
      this.#countEmptyTurn(state, adapter, drained.empty)
      if (drained.empty) {
        this.#throwIfHarnessFault(state, adapter)
        throw new SpawnFatal(`${adapter.id} ended the turn without the agent doing anything, resumed and cold`)
      }
    }
    const last = await this.#agentQuestions(state, turn, watch, drained.sessionId)

    // The review's rejected findings, from its closing report. Kept so the
    // next reviewer — a fresh one, after a resume, a retry or an `unapproved`
    // continue — is handed them rather than raising them again (§16.4).
    if (chore?.chore.when === 'review') {
      for (const finding of readRejections(last.prose())) {
        this.#decide(state, decision('rejected', 'review', finding))
      }
    }

    // A fix round is a fixer turn, not a state called `fix`.
    if (params['role'] === 'fixer') {
      state.fixRounds += 1
      if (state.lastRed !== null) state.lastRed.fixedSince = true
    }

    return await this.#options.executor.execute(invocation)
  }

  /**
   * One granted session, drained into the transcript; returns the id its
   * next resume has to name.
   *
   * Shared by a turn's first session and every resume an agent question
   * causes, because both are the same thing to everything else in the node:
   * the registry an operation reaches, the takeover offer, the ledger, the
   * harness slot and the mid-turn refusal.
   */
  /**
   * The gate guard, after the fact, on a harness it cannot stop a call on
   * (`src/guard/`). claude-code's calls were already put to its hook before
   * they ran; codex has no per-call hook and opencode's is not wired, so all
   * this can do is say it happened — journalled against the node, ids only.
   */
  #detectBareGate(state: NodeState, harness: string, name: string, input: unknown): void {
    const line = shellLineOf(harness, name, input)
    if (line === null) return
    const hit = checkCommand(this.#workflow, line)
    if (hit === null) return
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'bare_gate_detected',
      payload: { ...guardIds(hit), harness },
    })
  }

  async #drain(
    state: NodeState,
    outcome: Extract<AdmissionOutcome, { status: 'admitted' }>,
    turn: Turn,
    watch: QuestionWatch,
  ): Promise<{ readonly sessionId: string; readonly empty: boolean }> {
    const { runId, journal, admission } = this.#options
    const { adapter, plan, by } = turn
    const turnId = turn.turnId()
    let sessionId = outcome.session.id
    // Whether the model took any part: a word, a thought or a tool call. A
    // usage row alone is not that — a replay closes with one, at zero.
    let worked = false
    // An interrupt ends a turn before the model may have said anything, and
    // that is the operator's doing (§9), not a turn that failed to happen.
    let interrupted = false

    // The registry: exactly as long-lived as the turn it points at, so a §9
    // operation can never reach a session whose stream has already ended.
    state.live = { session: outcome.session, adapter }
    const withdraw = this.#offer(state, outcome.session, adapter, turn.cwd, plan.slot)
    try {
      for await (const event of outcome.session.events) {
        journal.appendTranscript(runId, state.node.id, { ...event, by: attribute(event, by) })
        watch.observe(event)
        if (event.type === 'assistant_text' || event.type === 'thinking' || event.type === 'tool_use') worked = true
        if (event.type === 'usage' && event.output > 0) worked = true
        if (event.type === 'session_ended' && event.result === 'interrupted') interrupted = true
        if (event.type === 'tool_use') this.#detectBareGate(state, adapter.id, event.name, event.input)
        if (event.type === 'session_started') {
          sessionId = event.sessionId
          this.#assign(state, { session_id: event.sessionId })
          // The authoritative id. `AgentSession.id` is what the adapter knew
          // before the CLI spoke; a harness that mints its own on resume
          // reports it here, and the ledger must hold the one the *next*
          // resume has to name.
          this.#remember(state, plan, adapter, event.sessionId)
        }
      }
    } finally {
      withdraw()
      state.live = null
      // Frees the harness in-flight slot: the ceiling counts running agents.
      outcome.release()
      // What the session's commands still hold or wait for, released. The
      // adapter has cancelled the background work it tracked; this is for the
      // work it could not see.
      if (turnId !== null) this.#options.onTurnEnded?.(state.node.id, turnId)
    }
    if (state.aborted) throw new Aborted()

    // §6.1 for the window that closed *under* the turn rather than refusing it
    // (`TurnRefusal`). Read after the stream, because that is when it is known,
    // and after `Aborted`, because a run being torn down has nothing to wait
    // for.
    //
    // The same `CapacityRetry` a refused spawn raises, which means the same
    // full re-drive: the lane is recycled and §15's ledger cleared, because the
    // session this turn was using is gone and resuming from a memory of files
    // that a recycle removed is the one thing worse than redoing the work.
    // Nothing is destroyed by that — `recycle` sets aside whatever the turn
    // left uncommitted as a WIP ref first. What it costs is the turn, and the
    // alternative was the node.
    const closed = outcome.session.refusal
    if (closed !== undefined) {
      const parked = admission.refusedMidTurn(adapter.id, state.node.id, closed, {
        model: outcome.model,
        ...(turn.priority.fallbacks === undefined ? {} : { fallbacks: turn.priority.fallbacks }),
      })
      if (parked.status === 'retry') {
        // Parked — not a model the turn could fall back from — and the plan
        // names a harness to move to.
        if (
          closed.kind === 'quota' &&
          admission.wakeAt(adapter.id) !== undefined &&
          (await this.#fallBackHarness(state, adapter.id))
        ) {
          throw new HarnessFellBack()
        }
        throw new CapacityRetry(parked.wait)
      }
    }
    return { sessionId, empty: !worked && !interrupted && this.#halt === null }
  }

  /**
   * §9.1 for a question the *agent* asked (`src/questions`): park on it, and
   * resume the same session with the answer, for as long as the agent keeps
   * stopping to ask.
   *
   * The turn is not over while it does. The effect that spawned it returns
   * only once the agent ends a session without a question, so the pipeline's
   * guards read the work the answer led to — not a report that said "I need a
   * decision", which a review would rightly fail.
   *
   * The questions are agent prose, so they go into the transcript as an
   * `agent_question` entry, and the journal's row is the fixed sentence plus
   * the effect id the API uses to find that entry (§11). The answer is
   * journalled as option indices plus the operator's own words, and reaches
   * the agent as a `user_message` restating each question with its answer.
   *
   * An unattended run answers with the recommended options after
   * `retryAfterMs`, through the same `answer` path a click takes. A harness
   * that cannot resume has no way to deliver an answer, so its question is left
   * in the transcript and the turn ends as it would have.
   *
   * Returns the watch over the turn's last session, whose prose is the report
   * the turn closed on.
   */
  async #agentQuestions(
    state: NodeState,
    turn: Turn,
    first: QuestionWatch,
    firstSessionId: string,
  ): Promise<QuestionWatch> {
    const { runId, journal } = this.#options
    let watch = first
    let sessionId = firstSessionId
    for (;;) {
      const ask = watch.result()
      if (ask === null) return watch
      if (!turn.adapter.capabilities.resume) {
        this.#log.warn('node.agent_question_unanswerable', {
          node: state.node.id,
          harness: turn.adapter.id,
        })
        return watch
      }

      state.agentQuestions += 1
      const effectId = `agent-question:${state.node.id}:${state.agentQuestions}`
      const entry: AgentQuestionEvent = { type: 'agent_question', effectId, ...ask }
      journal.appendTranscript(runId, state.node.id, { ...entry, by: turn.by })
      this.#log.info('node.agent_question', {
        node: state.node.id,
        source: ask.source,
        questions: ask.questions.length,
      })
      this.#ask(state, effectId, { question: AGENT_QUESTION_TEXT, kind: 'agent' })
      state.parkedEffectId = effectId
      state.unattendedAnswer = encodeAnswers(recommendedAnswers(ask))

      const cancel = this.#armUnattendedAnswer(
        state,
        agentAnswerAfter(this.#options.retryAfterMs, this.#options.agentAnswerAfterMs),
      )
      let facts: GuardContext
      try {
        facts = await this.#park(state)
      } finally {
        cancel()
      }

      const answers = decodeAnswers(facts.human?.['answer'], ask)
      const unattended = facts.human?.['unattended'] === true
      const message = formatAnswers(ask, answers, { unattended })
      // The session that asked is the only one this message reaches. Every
      // later one — the next reviewer above all — gets it from here.
      const by: DecidedBy = unattended ? 'unattended' : facts.human?.['by'] === 'coordinator' ? 'coordinator' : 'operator'
      for (const entry of answerDecisions(ask, answers, by, effectId)) this.#decide(state, entry)
      // The adapter hands `prompt` to the CLI without echoing it, so the
      // answer is written here — under whoever gave it, like their steering.
      journal.appendTranscript(runId, state.node.id, {
        type: 'user_message',
        text: message,
        by: { role: facts.human?.['by'] === 'coordinator' ? MONITOR_ROLE : OPERATOR_ROLE },
      })

      const granted = await this.#admitAnswer(state, turn, message, sessionId)
      watch = new QuestionWatch()
      sessionId = (await this.#drain(state, granted, turn, watch)).sessionId
    }
  }

  /**
   * Admission for the session that carries an answer.
   *
   * A capacity wait is waited out here rather than thrown as `CapacityRetry`:
   * that would re-drive the node from its initial state and throw away the
   * session the question was asked in, and with it the work that led there.
   * The node keeps its lane across the wait, which §9.1 already lets a parked
   * node do. A session the vendor has forgotten cannot be answered at all, so
   * that fails the node, where `onFailure` decides what happens next.
   */
  async #admitAnswer(
    state: NodeState,
    turn: Turn,
    prompt: string,
    sessionId: string,
  ): Promise<Extract<AdmissionOutcome, { status: 'admitted' }>> {
    for (;;) {
      const outcome = await this.#admitLoggedIn(
        state,
        turn.adapter,
        () => turn.task(prompt, sessionId),
        turn.priority,
      )
      if (outcome.status === 'admitted') return outcome
      if (outcome.status !== 'retry') throw new SpawnFatal(outcome.message)
      await outcome.wait()
      if (state.aborted) throw new Aborted()
      if (this.#halt !== null) throw new Halted()
    }
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
  async #reorientation(state: NodeState, plan: SessionPlan): Promise<Reorientation | null> {
    if (!plan.crossPhase) return null
    const entry = this.#ledgerOf(state).get(plan.slot as string)
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
    const plan = this.#plannedSession(state, params, adapter)
    // The operator's `fresh`, on the first turn that would have had a session
    // to continue. Over the plan rather than inside `planSession`: the ledger
    // is already cleared, and what this adds is the reason, and the one case
    // the ledger cannot carry — a member's warm session a pending phase would
    // otherwise have been handed.
    if (!state.freshRequested || plan.slot === null) return plan
    state.freshRequested = false
    return { ...plan, resumeSessionId: null, continuation: false, crossPhase: false, reason: 'operator_fresh', turns: 1 }
  }

  #plannedSession(
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
      ledger: this.#ledgerOf(state),
      nodeId: state.node.id,
      maxTurns: this.#workflow.defaults.max_session_turns,
      poisoned: this.#poisoned.has(state.crew?.member ?? ''),
      fixRounds: state.fixRounds,
      maxFixRounds: state.node.max_fix_rounds ?? null,
      takeoverSessionId: state.resumeSessionId,
    })
  }

  /** Writes the turn into the slot. Idempotent: `turns` comes from the plan. */
  #remember(
    state: NodeState,
    plan: SessionPlan,
    adapter: HarnessAdapter,
    sessionId: string,
  ): void {
    const lane = state.lane
    if (plan.slot === null || lane === null) return
    this.#ledgerOf(state).set(plan.slot, {
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
        // session to whichever turn spawned next, on whatever slot it named.
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

  /**
   * The pools a `run_gate` needs: one named gate's, or every gate the node
   * declared — and every codegen step's, since the steps run first in the
   * same effect.
   */
  #gateNeeds(node: Node, named: unknown): string[] {
    const ids = typeof named === 'string' ? [named] : node.gates
    const needs = new Set<string>()
    for (const id of ids) {
      for (const resource of this.#workflow.gates[id]?.requires ?? []) needs.add(resource)
    }
    for (const step of Object.values(this.#workflow.codegen)) {
      for (const resource of step.requires) needs.add(resource)
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
  /**
   * The wait a refused fixer spawn joins, through the same `refusedMidTurn`
   * a window closing under a turn goes through. Returns the error unchanged
   * when admission answers anything but a retry, which it does not today —
   * every capacity kind parks — but which this must not assume.
   */
  #capacityRetryFor(
    refused: ConflictFixerRefused,
    state: NodeState,
    refusal: NonNullable<ConflictFixerRefused['refusal']>,
  ): unknown {
    this.#log.warn('node.fixer_refused', {
      node: state.node.id,
      harness: refused.harness,
      model: refused.model,
      kind: refused.kind,
    })
    const parked = this.#options.admission.refusedMidTurn(refused.harness, state.node.id, refusal, {
      model: refused.model,
      fallbacks: this.#workflow.defaults.model_fallbacks,
    })
    return parked.status === 'retry' ? new CapacityRetry(parked.wait) : refused
  }

  /**
   * Holds a deferred phase on its question until the operator answers.
   *
   * `start` releases it: back to `pending`, where the dispatch loop takes it
   * on the next pass. `stop` fails it, with the reason the plan gave, and
   * blocks what depends on it. A halt withdraws the question and leaves the
   * node `pending`, unreleased, so a resume asks again. Nothing answers this
   * unattended — a soak is the one wait no timer should end.
   */
  async #holdDeferred(state: NodeState): Promise<void> {
    const reason = state.node.deferred ?? ''
    const effectId = `deferred:${state.node.id}`
    this.#ask(state, effectId, {
      question: `Phase "${state.node.name}" is deferred: ${reason} Its dependencies are done. Start it now?`,
      kind: 'choice',
      choices: [DEFERRED_START, STOP],
    })
    state.parkedEffectId = effectId
    this.#log.info('node.deferred', { node: state.node.id })
    let facts: GuardContext
    try {
      facts = await this.#park(state)
    } catch (error) {
      if (error instanceof Halted || error instanceof Aborted) {
        state.deferredAsked = false
        if (!state.aborted) this.#setStatus(state, 'pending')
        return
      }
      throw error
    }
    if (facts.human?.['answer'] === DEFERRED_START) {
      state.released = true
      this.#log.info('node.deferred_released', { node: state.node.id })
      this.#setStatus(state, 'pending')
      return
    }
    this.#fail(state, `deferred phase not started: ${reason}`)
  }

  /**
   * Parks a running node on a question the *host* has to ask — today, what
   * to do about a merge commit git refused (`CommitFailure`) — and returns
   * the answer. The node must be in flight: the integrator asks from inside
   * the node's own `git_branch` or `git_merge` effect, which is the only time
   * the question has somebody to be about.
   *
   * The same park every other question uses, so the node reads
   * `awaiting_human`, the UI offers the choices, `answer` resumes it, a halt
   * withdraws it (the throw reaches the integrator, which cleans up after
   * itself), and `--retry-after` answers `unattendedAnswer` for an operator
   * who is not there — which for a refused commit is `abort`, the one answer
   * that leaves the shared worktree usable by everyone else.
   */
  async askNode(
    nodeId: string,
    question: HumanQuestion,
    unattendedAnswer: string | null = null,
  ): Promise<HumanAnswer | undefined> {
    const state = this.#stateOf(nodeId)
    if (state.status !== 'running' || state.resume !== null) {
      throw new Error(`node "${nodeId}" is ${state.status}; only a running node can be asked`)
    }
    state.hostAsks += 1
    const effectId = `host:${nodeId}:${state.hostAsks}`
    this.#ask(state, effectId, question)
    state.parkedEffectId = effectId
    state.unattendedAnswer = unattendedAnswer
    const cancel = this.#armUnattendedAnswer(state)
    try {
      const facts = await this.#park(state)
      return facts.human?.['answer']
    } finally {
      cancel()
    }
  }

  /**
   * What to do about a merge commit git refused, asked of the operator on the
   * node whose merge it is (`CommitFailure.forNode`). The integrator's
   * `onCommitFailure` seam, bound by the host.
   *
   * The reason is journalled as a `node_error` first, for the same reason
   * `#recordAttemptFailure` journals before `#recover` asks: the question
   * carries no git output (§11), so without the record the operator is
   * shown three buttons and nothing about why.
   */
  async decideCommit(failure: CommitFailure): Promise<CommitDecision> {
    const state = this.#stateOf(failure.forNode)
    this.#log.error('node.commit_refused', {
      node: state.node.id,
      incoming: failure.nodeId,
      branch: failure.branch,
      attempt: failure.attempt,
      ...errorFields(failure.error),
    })
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_error',
      payload: {
        reason: `merge of ${failure.incoming} into ${failure.branch}: ${failure.error.message}`,
        attempt: state.retries + state.autoRetries + 1,
      },
    })
    const answer = await this.askNode(
      failure.forNode,
      {
        question:
          `git refused to commit the ${failure.conflicted ? 'resolved ' : ''}merge of ${failure.incoming} ` +
          `into ${failure.branch} (git commit exited ${failure.error.exitCode ?? 'abnormally'}` +
          `${failure.attempt > 1 ? `, ${failure.attempt} times` : ''}). ` +
          (failure.conflicted
            ? 'The resolution passed the gates. '
            : 'The merge had no conflicts; a hook checking the merged code refused it. ') +
          'Commit it now, commit it past the hooks, or abort the merge?',
        kind: 'choice',
        choices: [...COMMIT_CHOICES],
      },
      ABORT_MERGE,
    )
    return commitDecisionOf(answer)
  }

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
    // A failure before any agent ran is the machinery's, and one that repeats
    // verbatim is deterministic: counted, so `#offerRetry` can stop retrying
    // it unattended. A failure after an agent ran clears the count — the
    // setup got through, whatever happened next.
    //
    // A red gate on the merged base is not the machinery's, though it happens
    // before any agent: it is a verdict on the dependencies' code, which a
    // flaky test can give once and a retry can take back. Counted as setup it
    // repeated verbatim — a cached verdict replayed seven times — and the
    // unattended retry was withheld from the one failure a retry could fix.
    const setup = !state.agentRan && !(error instanceof Error && error.name === 'BaseGateError')
    state.setupFailure = !setup
      ? null
      : state.setupFailure?.reason === reason
        ? { reason, count: state.setupFailure.count + 1 }
        : { reason, count: 1 }
    this.#log.error('node.attempt_failed', {
      node: state.node.id,
      attempt: state.retries + state.autoRetries + 1,
      reason,
      setup,
      ...(setup && state.setupFailure !== null ? { setup_repeats: state.setupFailure.count } : {}),
      ...(error === undefined ? {} : errorFields(error)),
    })
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_error',
      payload: { reason, attempt: state.retries + state.autoRetries + 1, ...(setup ? { setup: true as const } : {}) },
    })
  }

  /**
   * Starts the clock on a plan-authored question that said what it means when
   * nobody answers it (`unattended_answer`), and hands back the way to stop it.
   *
   * The same `--retry-after` window the failure question uses, because it is
   * the same operator decision — "do not wait for me longer than this" — and a
   * second knob for it would be one an operator sets and forgets the other of.
   * Unset, nothing is armed and the question waits for a person, which is what
   * every plan-authored question did before this existed. The plan, not the
   * orchestrator, is what supplies the answer, so this is still never the
   * scheduler overruling a plan on the operator's behalf.
   *
   * One shot and no backoff: the question is not retried, it is answered.
   */
  #armUnattendedAnswer(state: NodeState, after = this.#options.retryAfterMs): () => void {
    const answer = state.unattendedAnswer
    const effect = state.parkedEffectId
    state.unattendedAnswer = null
    state.delegable = answer !== null
    if (answer === null || after === undefined || after <= 0) return () => {}

    const clock = this.#options.clock ?? systemClock
    let cancel = (): void => {}
    const fire = (): void => {
      if (state.resume === null || state.aborted) return
      if (state.held) {
        this.#log.info('node.unattended_withheld', { node: state.node.id, reason: 'held' })
        // `resume` gives the timer back, a full interval from then.
        state.rearm = () => {
          cancel = clock.at(clock.now() + after, fire)
        }
        return
      }
      this.#log.info('node.unattended_answer', { node: state.node.id, after_ms: after })
      if (effect !== null) state.unattendedGiven.set(effect, (state.unattendedGiven.get(effect) ?? 0) + 1)
      this.answer(state.node.id, { human: { answer, unattended: true } })
    }
    cancel = clock.at(clock.now() + after, fire)
    return () => {
      state.rearm = null
      cancel()
    }
  }

  /**
   * Starts the clock on an unanswered failure question, and hands back the way
   * to stop it.
   *
   * Answered through `answer` rather than by resolving the park directly, so an
   * unattended retry takes the identical path an operator's click takes: the
   * question is cleared, `human_answered` is journalled, and everything
   * downstream — `#restartAttempt`, the lane recycle, the cold session — is the
   * same code. A second implementation of "the answer arrived" is how the two
   * drift apart.
   *
   * **The interval doubles while attempts fail faster than it.** An observed
   * phase retried ten times on a fifteen-minute timer against a failure that
   * killed each attempt within seconds: the timer was the only thing pacing it,
   * so every firing bought the same failure at the price of a cold lane. Each
   * quick failure in a row doubles the wait, up to `UNATTENDED_BACKOFF_CAP`
   * times the interval; one attempt that runs at least the interval long puts
   * it back. Still unbounded in count, for the reason `retryAfterMs` gives — a
   * capped version stalls for the rest of the night — only slower.
   *
   * The cancel is not optional. A question the operator *does* answer leaves a
   * timer that would otherwise fire against a node that has moved on, and
   * `answer` throws for a node that is not awaiting one — so the stray timer
   * would surface as an exception from a node nobody was looking at.
   */
  #armUnattendedRetry(state: NodeState, fault = false): () => void {
    state.delegable = true
    const after = this.#options.retryAfterMs
    if (after === undefined || after <= 0) return () => {}

    const clock = this.#options.clock ?? systemClock
    // A harness fault is quick by nature, however long the attempt took to
    // reach its empty turn: it backs off from the first question.
    const quick = fault || clock.now() - state.attemptStartedAt < after
    state.quickFailures = quick ? state.quickFailures + 1 : 0
    const factor = Math.min(2 ** Math.max(0, state.quickFailures - 1), UNATTENDED_BACKOFF_CAP)
    const wait = after * factor
    let cancel = (): void => {}
    const fire = (): void => {
      // Between the timer firing and this running, the operator may have
      // answered: `resume` is nulled by `answer`, and asking again here is
      // cheaper than reasoning about whether that can happen.
      if (state.resume === null || state.aborted) return
      if (state.held) {
        this.#log.info('node.unattended_withheld', { node: state.node.id, reason: 'held' })
        // `resume` gives the timer back, a full wait from then.
        state.rearm = () => {
          cancel = clock.at(clock.now() + wait, fire)
        }
        return
      }
      state.unattended += 1
      this.#log.info('node.unattended_retry', {
        node: state.node.id,
        after_ms: wait,
        unattended: state.unattended,
        quick_failures: state.quickFailures,
      })
      this.answer(state.node.id, { human: { answer: RETRY, unattended: true } })
    }
    cancel = clock.at(clock.now() + wait, fire)
    return () => {
      state.rearm = null
      cancel()
    }
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

  #harnessOf(state: NodeState, override?: unknown): string {
    if (typeof override === 'string') return override
    return this.#resolved(state).harness
  }

  /**
   * Which model this turn runs on.
   *
   * The effect's own override, then a reassignment, then the member holding
   * the node, then the node's model, then the default — and a harness the run
   * switched away from takes the switch's model with it.
   */
  #modelFor(state: NodeState, params: Readonly<Record<string, unknown>>): string {
    const override = params['model']
    if (typeof override === 'string') return override
    return this.#resolved(state).model
  }

  /**
   * The harness and model this node's turns run on, before any effect
   * overrides: a reassignment, the member, the node, the defaults, in that
   * order — then the run's harness switches, followed as a chain.
   */
  #resolved(state: NodeState): { readonly harness: string; readonly model: string } {
    const own = state.assignment
    let harness = own?.harness ?? state.crew?.harness ?? state.node.harness ?? this.#workflow.defaults.harness
    let model = String(own?.model ?? state.crew?.model ?? state.node.model ?? this.#workflow.defaults.model)
    const seen = new Set<string>()
    for (let next = this.#switches.get(harness); next !== undefined && !seen.has(harness); next = this.#switches.get(harness)) {
      seen.add(harness)
      harness = next.harness
      model = next.model
    }
    return { harness, model }
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
