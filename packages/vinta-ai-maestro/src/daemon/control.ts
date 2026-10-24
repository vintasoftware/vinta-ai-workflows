/**
 * The ports the daemon drives, and nothing more.
 *
 * The API is a thin skin over units that already exist: the journal answers
 * every read, and the five §9 operations are forwarded to whoever is running
 * the run. That forwarding is declared here as a narrow interface rather than
 * as a dependency on `Scheduler`, for two reasons:
 *
 * - **The host, not `Scheduler`, is the contract.** `Scheduler` now implements
 *   add-context, redirect, pause and abort on top of the session registry it
 *   keeps, and `runControl` forwards to whatever of them the object it is
 *   handed actually has. A host that supplies fewer — an out-of-tree runner,
 *   or a test double — still gets a `RunControl`, and the verbs behind the
 *   mechanism it lacks refuse rather than quietly succeeding.
 * - **It is what makes the acceptance test honest.** A test that asserts "the
 *   operation reached the scheduler" against a real agent run is asserting
 *   about a model's mood. Against this port it asserts about a call.
 *
 * `PoolView` and `CapacityView` are the read-only slices of `ResourcePools`
 * and `AdmissionControl` the snapshot needs. Both are structural, so the real
 * objects satisfy them with no adapter and a stub satisfies them with three
 * methods.
 */
import type { GateGuardPort } from '../guard/guard.ts'
import type { AmendRunner } from '../amend/amend.ts'
import type { Actor, NodeStatus, OperatorDelivery } from '../journal/events.ts'
import type { GuardContext } from '../pipeline/guard.ts'
import type { HumanQuestion, NodeActivity } from './schemas.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import type { ConflictFixer } from '../integration/fixer.ts'
import type { CoordinatorAuthority, ReassignTarget, ReassignWhen } from '../scheduler/index.ts'
import type { ExecPort } from '../coordinator/exec.ts'
import type { BranchPort } from '../landing/live.ts'
import type {
  AgentGateHopOptions,
  AgentGateResult,
  AgentGateRunning,
  AgentGateWaiting,
} from '../resources/agent-gates.ts'
import type {
  AgentLeaseCaller,
  AgentLeaseGrant,
  AgentLeaseHeld,
  AgentLeaseHop,
} from '../resources/agent-leases.ts'

/**
 * What an operation did, where the host can say: the scheduler's operations
 * answer with the delivery they journalled, so the API can report `ignored`
 * instead of an `ok` that did nothing.
 */
export type Operated = void | OperatorDelivery | Promise<void | OperatorDelivery>

/**
 * The five operations of §9, plus the two reads `Scheduler` already exposes.
 *
 * Every acting verb takes the actor and the caller's reason — the reason is
 * journalled with the operation, and the coordinator is refused without one
 * (`api.ts`), so every decision it makes unattended can be listed with why.
 */
export interface RunControl {
  /** Live node statuses. The journal projection is authoritative; this is the peek. */
  readonly statuses: Readonly<Record<string, NodeStatus>>
  /** §9.1 — the answer enters the guard context as `human.answer` and resumes the node. */
  answer(nodeId: string, facts: GuardContext, actor?: Actor, reason?: string): void | Promise<void>
  /** §9 — `session.send(text)`, or queued for the next resume. */
  addContext(nodeId: string, text: string, actor?: Actor, reason?: string): Operated
  /** §9 — interrupt, then send the new instruction. */
  redirect(nodeId: string, instruction: string, actor?: Actor, reason?: string): Operated
  /**
   * §9 — finish the current turn, then `await_human`; on a node already
   * parked on a question, hold it there (`held`).
   */
  pause(nodeId: string, actor?: Actor, reason?: string): Operated
  /** §9 — undo `pause`: withdraw it, release the parked phase, or give a held one its timer back. */
  resume?(nodeId: string, actor?: Actor, reason?: string): Operated
  /**
   * §9 — kill the session, mark failed, block dependents. A run left with
   * nothing to run stays up for the node's `retry` (§9).
   */
  abortNode(nodeId: string, actor?: Actor, reason?: string): Operated
  /**
   * Drop the node's agent session: its next turn starts cold, with the whole
   * brief (§15). Optional, like `retry`, and refused rather than faked by a
   * host that does not keep sessions.
   */
  freshSession?(nodeId: string, actor?: Actor, reason?: string): Operated
  /** Stop the turn now without failing the phase: it is held, keeping its lane and its work. */
  interrupt?(nodeId: string, actor?: Actor, reason?: string): Operated
  /** Hand the phase to a crew member, or a harness and model, at the step it is at. */
  reassign?(
    nodeId: string,
    target: ReassignTarget,
    options?: { readonly when?: ReassignWhen; readonly actor?: Actor; readonly reason?: string },
  ): Operated
  /** Move the phase's pipeline to `to` by hand. Never into a final state. */
  step?(nodeId: string, to: string, actor?: Actor, reason?: string): Operated
  /** Move the whole run off a harness. Resolves with the phases it moved. */
  switchHarness?(
    from: string,
    to: string,
    model: string,
    options?: { readonly when?: ReassignWhen; readonly actor?: Actor; readonly reason?: string },
  ): Promise<readonly string[]>
  /**
   * Run a failed node again, and unblock what its failure blocked.
   *
   * Not one of §9's five: those steer a node that is running, and this one
   * reaches a node that has stopped. Optional, like `question`, so a host that
   * schedules its own work is not obliged to implement it — and refuses
   * honestly rather than pretending to have retried.
   */
  retry?(nodeId: string): void | Promise<void>
  /**
   * The question a node is parked on (§9.1). Optional, and rarely needed: the
   * journal projects the pending question out of the `human_question` event,
   * which is what the API serves and what survives a restart. This is the
   * escape hatch for a host that parks a node without journalling the pause.
   */
  question?(nodeId: string): HumanQuestion | undefined
}

/** The read slice of `ResourcePools` the run snapshot needs. */
export interface PoolView {
  capacity(name: string): number
  held(name: string): number
  /** Holders enqueued and not yet granted, across every pool. */
  readonly waiting: number
}

/** The read slice of `AdmissionControl` the run snapshot needs (§6.1). */
export interface CapacityView {
  ceiling(harness: string): number
  inFlight(harness: string): number
  /** Epoch ms the harness may be tried again, or `undefined` when it is not parked. */
  wakeAt(harness: string): number | undefined
  /**
   * Whether this run loaded an adapter for the harness. A node row can name a
   * harness the run never loaded — one amended away from, or one a resume
   * dropped — and asking the three methods above about it throws. Optional so
   * a stub that knows every harness need not say so.
   */
  has?(harness: string): boolean
}

/** Renewable leases exposed to an agent through the daemon API. */
export interface AgentLeasePort {
  /**
   * `signal` leaves the queue without taking anything — how the endpoint
   * answers a waiting client on a short cycle instead of holding one request
   * open for the length of the wait. An implementation that ignores it still
   * works; it just makes its callers wait longer for "not yet".
   */
  acquire(
    resources: readonly string[],
    holderNode: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgentLeaseGrant>
  /**
   * One instalment of a client's wait, resumable through `waitToken`. This is
   * what the endpoint uses: answering on a short cycle is only safe if the
   * queue position survives the gap between two answers.
   */
  hop(
    resources: readonly string[],
    holderNode: string,
    options: AgentLeaseCaller & { readonly waitToken?: string; readonly withinMs: number },
  ): Promise<AgentLeaseHop>
  renew(leaseId: string): AgentLeaseGrant | null
  release(leaseId: string): void
  /** Every lease granted and not yet released: who a waiter is queued behind. */
  held(): readonly AgentLeaseHeld[]
}

/**
 * Declared gates, run for an agent that asks for one by id.
 *
 * Narrow on purpose, and narrower than `AgentLeasePort`: there is one verb and
 * it takes no command. That *is* the contract — the daemon resolves the id to
 * the gate's declared `cmd`, so what an agent can reach through here is the
 * command the authoritative `gate` node will run and nothing else.
 */
export interface AgentGatePort {
  /**
   * One hop of a wait, not the whole of it — see `AgentGateBroker.hop`. The
   * route cannot hold a request for the length of a test suite, so the client
   * asks again and this answers "still running" until it can answer with a
   * result.
   */
  hop(
    gateId: string,
    holderNode: string,
    options: AgentGateHopOptions,
  ): Promise<AgentGateWaiting | AgentGateResult>
  /**
   * The gates agents asked for that hold their pools now. Optional: a host
   * without it names fewer holders to a waiter, and nothing else changes.
   */
  running?(): readonly AgentGateRunning[]
}

/** See `DaemonRun.gateCache`. Returns how many entries went. */
export interface GateCachePort {
  invalidate(gateId: string, treeHash?: string): number
  /**
   * Makes the gate's next run in the integration worktree start from fresh
   * state (`integration/fresh.ts`). False when the gate has no `fresh_cmd` to
   * run. Absent on a host with no integration worktree.
   */
  forgetDatabases?(gateId: string): boolean
}

/**
 * Why a run could not be started, as a code the route maps to a status.
 *
 * A closed set rather than a message, because the caller is a UI that has to
 * decide what to *do*: an `unknown_workflow` is a stale list to refresh, an
 * `environment` is a machine to fix, a `run_active` is a tab to switch to.
 */
export type RunStartRefusal =
  | 'unknown_workflow'
  | 'invalid_workflow'
  | 'unknown_run'
  /** Every node settled. There is nothing to resume; run the plan again. */
  | 'run_finished'
  /** This daemon is already driving it — two schedulers on one run is a race. */
  | 'run_active'
  /** §13.5's preflight refused. This environment cannot run this workflow. */
  | 'environment'
  /** The lane pool refused: disk, a failing `setup_cmd`, a missing env file. */
  | 'provision'

export type RunStartRequest =
  | { readonly kind: 'workflow'; readonly workflowId: string }
  | { readonly kind: 'resume'; readonly runId: string }

export type RunStartOutcome =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly code: RunStartRefusal; readonly message: string }

/**
 * Starting a run on the daemon that is serving it (§10's `POST /api/runs`).
 *
 * The port exists so that the API stays a skin: composing a run means lanes, a
 * preflight, a scheduler and a harness, none of which belong behind an HTTP
 * handler. `src/cli/serve.ts` supplies the real one.
 *
 * **Absent means refused, not ignored.** A daemon started against a checkout it
 * cannot run — no harness, no lanes — still serves every read in this API, and
 * answering a start request with anything other than "this host does not do
 * that" would leave the caller waiting for a run nobody is driving.
 *
 * Its `start` resolves as soon as the run is *registered*, never when the run
 * finishes. That is the entire point of the endpoint: the request that submits
 * a run returns in the time it takes to provision lanes, and the run then
 * outlives it by hours.
 */
export interface RunStartPort {
  start(request: RunStartRequest): Promise<RunStartOutcome>
}

/** One run the daemon serves. Registered when the run starts. */
export interface DaemonRun {
  readonly runId: string
  readonly control: RunControl
  readonly pools: PoolView
  readonly admission: CapacityView
  /** Absent on read-only/test hosts that do not offer agent-held leases. */
  readonly agentLeases?: AgentLeasePort
  /**
   * Absent on a host with no lanes or no gate cache to run a gate against —
   * the endpoint then refuses rather than running the command somewhere it
   * guessed.
   */
  readonly agentGates?: AgentGatePort
  /**
   * §9's amend path, when this host can drive it: the live statuses the gate
   * reads, the integration worktree a `done` node is rebased in, and the hand
   * -off that lets unstarted nodes take a new definition. Optional, because a
   * host with no integration worktree can still serve a run — `src/amend/`
   * refuses an amendment that would need one rather than half-applying it.
   */
  readonly amend?: AmendRunner
  /**
   * §17.6's judge, for a run started with `--permission judged`. Absent
   * otherwise, and the endpoint then refuses — which a judged hook reads as a
   * denial, never as permission.
   */
  readonly permissionJudge?: PermissionJudgePort
  /**
   * The gate guard's daemon side (`src/guard/`): whether a Bash line an agent
   * is about to run is a gate or a pooled command run bare. Absent on a host
   * with no gates to guard, and the endpoint then allows everything — the hook
   * fails open, so an absent guard is no guard rather than a blocked agent.
   */
  readonly gateGuard?: GateGuardPort
  /**
   * Ends the run before its DAG does — `pause` drains it to a resumable stop,
   * `stop` kills its live turns and cancels it. Resolves once the request is
   * taken, not once the run has ended: the host process exits when it has.
   * Absent on a host that cannot end a run early, and then both refuse.
   *
   * May answer with the nodes the drain is still waiting on, which the CLI
   * prints: a pause that seems to hang is one waiting on a step, and the
   * operator should be told which.
   */
  readonly halt?: (mode: 'paused' | 'cancelled') => Promise<readonly NodeActivity[] | void>
  /** `vinta-ai-maestro exec`: a command run by hand in a lane or the integration worktree. */
  readonly exec?: ExecPort
  /**
   * `propagate` and `sync-base` on this run, made here holding the integration
   * worktree's queue (`landing/live.ts`). Absent on a host with no
   * integration worktree, and both endpoints then refuse.
   */
  readonly branches?: BranchPort
  /**
   * `run --coordinator-authority`: how far the coordinator's token reaches on
   * this run. Absent is `standard`.
   */
  readonly coordinatorAuthority?: CoordinatorAuthority
  /** The conflict fixer's round, by hand. Absent on a host with no fixer. */
  readonly fixer?: FixerControl
  /**
   * §13.4's cache, as far as an operator or the coordinator may reach it:
   * forgetting a verdict. Absent on a host with no cache, and the endpoint
   * then refuses. An agent never reaches it — its way past a stale entry is
   * `gate <id> --no-cache`, which replaces the entry for its own lane only.
   */
  readonly gateCache?: GateCachePort
}

/** What the daemon asks on a judged session's behalf. The input never leaves the call. */
export interface PermissionJudgePort {
  judge(request: {
    readonly holderNode: string
    readonly tool: string
    readonly input: unknown
    readonly cwd: string
  }): Promise<{ readonly allow: boolean; readonly reason: string }>
}

/** Raised by `runControl` for a §9 verb the host did not supply. */
export class UnsupportedOperation extends Error {}

/**
 * Hands on the conflict fixer's round (`fixer interrupt` / `fixer reassign`):
 * the integration counterpart of `interrupt` and `reassign`, for a fix round
 * that is going nowhere on an agent that cannot see why.
 */
export interface FixerControl {
  /** Ends the running round as a round spent; false when none was running. */
  interrupt(): Promise<boolean>
  /**
   * Every later round goes to this harness and model; with `now`, the running
   * round ends so the next one starts on them. Throws `UnknownHarness`.
   */
  reassign(harness: string, model: string, now: boolean): Promise<boolean>
  /** The running round's harness and model, or null. */
  running(): { readonly harness: string; readonly model: string } | null
}

/** A harness this run has no adapter for. The message is ids only. */
export class UnknownHarness extends Error {}

export function fixerControl(
  fixer: ConflictFixer,
  adapters: Readonly<Record<string, HarnessAdapter>>,
): FixerControl {
  return {
    interrupt: async () => (await fixer.endRound?.()) ?? false,
    reassign: async (harness, model, now) => {
      const adapter = adapters[harness]
      if (adapter === undefined) throw new UnknownHarness(`no adapter registered for harness "${harness}"`)
      if (fixer.reassign === undefined) throw new UnsupportedOperation('fixer reassign')
      fixer.reassign({ adapter, model })
      return now ? ((await fixer.endRound?.()) ?? false) : false
    },
    running: () => fixer.running?.() ?? null,
  }
}

/**
 * Builds a `RunControl` from what `Scheduler` actually implements, letting the
 * host supply the rest. The unsupplied verbs refuse rather than silently
 * succeeding: an operator who pressed Abort and got a 200 back would believe
 * the node was killed.
 */
export function runControl(
  scheduler: Pick<RunControl, 'answer' | 'statuses'> &
    Partial<Omit<RunControl, 'answer' | 'statuses'>>,
  operations: Partial<Omit<RunControl, 'answer' | 'statuses'>> = {},
): RunControl {
  const unsupported = (verb: string) => (): never => {
    throw new UnsupportedOperation(verb)
  }
  // Destructured off the prototype, so every forward re-binds `this` to the
  // scheduler: these are class methods reaching private state.
  const { addContext, redirect, pause, resume, abortNode, question, retry, freshSession, interrupt, reassign, step, switchHarness } =
    scheduler
  const own =
    operations.question ??
    (question === undefined ? undefined : (nodeId: string) => question.call(scheduler, nodeId))

  return {
    get statuses() {
      return scheduler.statuses
    },
    answer: (nodeId, facts, actor, reason) => scheduler.answer(nodeId, facts, actor, reason),
    addContext:
      operations.addContext ??
      (addContext === undefined
        ? unsupported('add_context')
        : (nodeId, text, actor, reason) => addContext.call(scheduler, nodeId, text, actor, reason)),
    redirect:
      operations.redirect ??
      (redirect === undefined
        ? unsupported('redirect')
        : (nodeId, instruction, actor, reason) => redirect.call(scheduler, nodeId, instruction, actor, reason)),
    pause:
      operations.pause ??
      (pause === undefined
        ? unsupported('pause')
        : (nodeId, actor, reason) => pause.call(scheduler, nodeId, actor, reason)),
    abortNode:
      operations.abortNode ??
      (abortNode === undefined
        ? unsupported('abort')
        : (nodeId, actor, reason) => abortNode.call(scheduler, nodeId, actor, reason)),
    ...(own === undefined ? {} : { question: own }),
    // Optional all the way through: a host without it answers "unsupported"
    // rather than accepting a retry it will not perform.
    ...(operations.retry !== undefined
      ? { retry: operations.retry }
      : retry === undefined
        ? {}
        : { retry: (nodeId: string) => retry.call(scheduler, nodeId) }),
    ...(operations.resume !== undefined
      ? { resume: operations.resume }
      : resume === undefined
        ? {}
        : { resume: (nodeId: string, actor?: Actor, reason?: string) => resume.call(scheduler, nodeId, actor, reason) }),
    ...(operations.freshSession !== undefined
      ? { freshSession: operations.freshSession }
      : freshSession === undefined
        ? {}
        : {
            freshSession: (nodeId: string, actor?: Actor, reason?: string) =>
              freshSession.call(scheduler, nodeId, actor, reason),
          }),
    // The phase-control verbs: optional like `retry`, refused by a host
    // without them rather than faked.
    ...(operations.interrupt !== undefined
      ? { interrupt: operations.interrupt }
      : interrupt === undefined
        ? {}
        : {
            interrupt: (nodeId: string, actor?: Actor, reason?: string) =>
              interrupt.call(scheduler, nodeId, actor, reason),
          }),
    ...(operations.reassign !== undefined
      ? { reassign: operations.reassign }
      : reassign === undefined
        ? {}
        : {
            reassign: (nodeId: string, target: ReassignTarget, options?: Parameters<NonNullable<RunControl['reassign']>>[2]) =>
              reassign.call(scheduler, nodeId, target, options),
          }),
    ...(operations.step !== undefined
      ? { step: operations.step }
      : step === undefined
        ? {}
        : { step: (nodeId: string, to: string, actor?: Actor, reason?: string) => step.call(scheduler, nodeId, to, actor, reason) }),
    ...(operations.switchHarness !== undefined
      ? { switchHarness: operations.switchHarness }
      : switchHarness === undefined
        ? {}
        : {
            switchHarness: (
              from: string,
              to: string,
              model: string,
              options?: Parameters<NonNullable<RunControl['switchHarness']>>[3],
            ) => switchHarness.call(scheduler, from, to, model, options),
          }),
  }
}
