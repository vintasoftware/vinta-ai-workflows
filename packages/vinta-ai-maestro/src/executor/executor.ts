/**
 * The production `EffectExecutor`: the bodies of §5.2's catalog, composed out
 * of the units that already implement them.
 *
 * The scheduler owns *when* work happens — dispatch, lanes, admission, gate
 * pools, `fix_rounds`, and the park on `await_human`. It owns two verb bodies
 * outright (`spawn_agent`'s session, and the pools around `run_gate`) and
 * delegates every other body here. So this module composes rather than
 * implements: `executeGate` + `GateCache` for gates, `Integrator` and
 * `openPullRequest` for git and PRs, `Journal` for paths and records, and
 * `Notifier` for the OS channel. Anything here that reads like new logic is a
 * bug — the piece almost certainly exists already.
 *
 * ## The fact contract
 *
 * `EffectOutcome.facts` is merged into the guard context **by root key**, and
 * `GuardContext`'s roots are closed (§5.2: `review`, `gate`, `human`, `node`,
 * `run`, `fix_rounds`). That closure *is* the contract: a verb either produces
 * one of those roots or it produces nothing, and the guards the shipped
 * `standard-phase` reads resolve exactly because of what is listed below.
 *
 * | verb | facts | who reads it |
 * |---|---|---|
 * | `spawn_agent` (`verdict: true`) | `review.verdict` — `'pass'` \| `'fail'` | the scheduler's `run_chore`, which states it for `t-review-pass` / `t-review-fail` |
 * | `spawn_agent` (otherwise) | none | — |
 * | `run_gate` | `gate.id`, `gate.exit_code`, `gate.status`, `gate.cached`, `gate.log_ref` | `t-gate-pass` / `t-gate-fail`, `t-verify-*` |
 * | `git_branch` | none | — |
 * | `git_merge` | none | — |
 * | `git_push` | none | — |
 * | `open_pr` | none | — |
 * | `write_tracking` | none | — |
 * | `await_human` | none — the *answer* arrives as `human.answer`, from the scheduler | any guard on `human.*` |
 * | `notify` | none | — |
 * | `grant_fix_rounds` | none — the scheduler resets `fix_rounds` itself | — |
 *
 * `fix_rounds` is the scheduler's, fed in on every step; nothing here writes it.
 *
 * **Where `review.verdict` comes from.** The scheduler owns the `spawn_agent`
 * body: it admits the turn, drains the session into the transcript, and *then*
 * calls this executor with the same invocation. The turn's meaning is left
 * deliberately unanswered there — "what did the review decide" is not a
 * scheduling question — and the drained stream is already durable, so the
 * verdict is read back out of the transcript the scheduler just wrote
 * (`Journal.tailTranscript`). A review chore states its verdict in its own
 * last words as `VERDICT: pass` or `VERDICT: fail` — read by `readVerdict`,
 * which `src/prompts` also uses to *ask* for it, so the protocol has one
 * definition rather than a prompt and a parser free to drift apart. A turn
 * that errored, or one that stated nothing, takes `defaultVerdict` — `'fail'`,
 * because a merge on a review's silence is the one failure mode a review step
 * exists to prevent. The transcript text is matched and discarded: it never reaches a fact, a log
 * field, an error message or a notification.
 *
 * **How caching composes without double-acquiring.** `runGateCached` wraps
 * `runGate`, and `runGate`'s first act is to acquire the gate's pools — which
 * the scheduler is already holding for the whole `run_gate` effect, so calling
 * it here would self-deadlock the moment any of those pools has capacity 1.
 * The cache is not in `runGate` though, it is *in front of* it, and its two
 * halves are public: `laneTreeHash` + `GateCache.lookup` before, `GateCache
 * .store` after. So the same composition is rebuilt around `executeGate`, the
 * entry point that takes no `pools` precisely so this mistake is unwritable.
 * A hit still skips the run entirely, which is where the value was.
 *
 * **`run_gate` journals its verdict.** One `gate_result` per gate that ran —
 * gate id, exit code, status — because a gate result that reaches only the
 * guard context dies with the step, and §13.6 has to be able to say that this
 * gate failed, something landed, and then it passed. The gate's *output* is
 * not in it and cannot be: the payload has no field it would fit in.
 *
 * **Identifiers only, everywhere.** Gate output goes to the gate log, agent
 * output to the transcript, diffs and hunks stay in the worktree. Nothing in
 * this file puts any of them into a fact, an error, a tracking record or a
 * notification body.
 */
import { laneTreeHash, type GateCache } from '../gates/cache.ts'
import { phaseGate } from '../gates/scope.ts'
import { executeGate, TIMEOUT_EXIT, type GateResult, type RunGateOptions } from '../gates/runner.ts'
import { computeWaves } from '../graph.ts'
import { git, gitLines, gitOk } from '../integration/git.ts'
import type { Integrator } from '../integration/integrator.ts'
import { prNumberOf } from '../integration/pr.ts'
import type { Journal, NodeRow } from '../journal/journal.ts'
import { GATE_ROLE } from '../journal/transcript.ts'
import type { EffectExecutor, EffectInvocation, EffectOutcome } from '../pipeline/effects.ts'
import type { ContextValue } from '../pipeline/guard.ts'
import { readVerdict, resolveBrief } from '../prompts/index.ts'
import { isJudgeGate, type CommandGate, type JudgeGate, type Node, type Workflow } from '../types.ts'
import type { SystemOneJudge } from '../journal/events.ts'
import type { SystemOne } from '../system-one/config.ts'
import {
  judgeCacheKey,
  runJudgeGate,
  triageGateFailure,
  type Judgement,
} from '../system-one/judges.ts'
import {
  composePlanPrBody,
  composePrBody,
  readPrContext,
  type PlanPrStep,
  type PrText,
} from '../integration/pr-body.ts'
import type { PrResult } from '../integration/pr.ts'
import { createOsNotifier, notifyReason, type Notifier } from './notify.ts'
import {
  renderPhase,
  renderRun,
  renderWave,
  trackingPath,
  writeTrackingFile,
  type PhaseFacts,
  type TrackingScope,
} from './tracking.ts'

/** A provisioned lane, as `LanePool.Lane` already provides it. */
export interface ExecutorLane {
  readonly name: string
  readonly path: string
  /** Gates and agents in this lane run with this applied (forked database urls, …). */
  readonly env: Readonly<Record<string, string>>
}

export interface RunExecutorOptions {
  /** The frozen snapshot the run executes. */
  readonly workflow: Workflow
  readonly runId: string
  readonly journal: Journal
  /** Branch topology, wave merges and PRs. Built by the host, which owns the fixer. */
  readonly integrator: Integrator
  /** The dedicated integration worktree — the same one the `Integrator` was given. */
  readonly integrationPath: string
  /**
   * The scheduler's `laneRoot`. Kept for symmetry with the rest of the wiring;
   * it is no longer a fallback for a lane the host did not describe, because
   * guessing a path with an empty environment turned out to cost more than the
   * refusal does — see `#lane`.
   */
  readonly laneRoot: string
  /** Provisioned lanes by name. A node assigned one that is not here is refused. */
  readonly lanes?: readonly ExecutorLane[]
  /** §13.4's gate result cache. Omitted means every gate runs. */
  readonly cache?: GateCache
  /** `--no-cache`: run the gate anyway, and refresh the entry with the result. */
  readonly noCache?: boolean
  /** Verdict for a review turn that stated none. Conservative by default. */
  readonly defaultVerdict?: 'pass' | 'fail'
  /** Injected in tests, and on a platform with no notification channel. */
  readonly notifier?: Notifier
  /**
   * The operator's classifier (§17). Absent when the run was started without
   * `--system-one`: judge gates then answer as unavailable, and no built-in
   * judge runs.
   */
  readonly systemOne?: SystemOne
  /**
   * The integration worktree's environment, agent overlay included — what the
   * wave gate runs with, for the reason the conflict fixer gets it: without it
   * a suite resolves to the main checkout's database and compose project.
   */
  readonly integrationEnv?: Readonly<Record<string, string>>
}

/**
 * A wave merged cleanly and the full form of a gate its phases only ran
 * narrowed failed on the result. Ids and an exit code (§11); the gate's log is
 * where its output is.
 */
export class WaveGateError extends Error {
  constructor(
    readonly wave: number,
    readonly gateId: string,
    readonly exitCode: number,
    readonly logPath: string,
  ) {
    super(
      `wave ${wave} merged, but gate "${gateId}" failed on the merged tree (exit ${exitCode}) — ` +
        'the phases each passed it narrowed to their own changes, so this is a regression ' +
        `between them. Log: ${logPath}`,
    )
    this.name = 'WaveGateError'
  }
}

/**
 * Where a wave gate's log is filed: the integration worktree's own pseudo-node,
 * the one the conflict loop's `verify` already logs under, so a wave's full
 * suite never overwrites a phase's log for the same gate id.
 */
const WAVE_GATE_NODE = '_integration'

/** How many transcript entries back to look for the verdict. */
const TRANSCRIPT_WINDOW = 50

export class RunEffectExecutor implements EffectExecutor {
  readonly #options: RunExecutorOptions
  /**
   * The run's definition as it stands *now*, not as it was wired.
   *
   * A field rather than `#options.workflow`, because §9's amend replaces a
   * live run's workflow and this is the object that reads the part an
   * amendment is most often about. `#runGate` looks the gate's command up
   * here, per gate run; an executor holding the snapshot it was constructed
   * with would keep running the old command after the run's own definition,
   * its journal and its scheduler had all moved on — the amendment would
   * appear to land everywhere except the one place it does anything.
   */
  #workflow: Workflow
  #nodes: ReadonlyMap<string, Node>
  #waves: ReadonlyMap<string, number>
  readonly #lanes: ReadonlyMap<string, ExecutorLane>
  readonly #notifier: Notifier
  /** Which nodes of each wave have reached their `git_merge`. See `#lastOfWave`. */
  readonly #arrived = new Map<number, Set<string>>()
  /**
   * One integration worktree, one queue. Every merge and every conductor-owned
   * tracking write happens in the same checkout, and two nodes finishing at
   * once would otherwise interleave a `checkout -B` with someone else's merge.
   * `LanePool` serializes its `worktree add` calls for the same reason.
   */
  #integrationTurn: Promise<unknown> = Promise.resolve()
  /**
   * Set when a node's `git_merge` built the final wave, and spent by that
   * node's `open_pr`, which opens the plan PR after its own. See `#merge`.
   */
  #planPrDue: { readonly wave: number; readonly by: string } | null = null

  constructor(options: RunExecutorOptions) {
    this.#options = options
    this.#workflow = options.workflow
    this.#nodes = new Map(options.workflow.nodes.map((node) => [node.id, node]))
    this.#waves = computeWaves(options.workflow.nodes)
    this.#lanes = new Map((options.lanes ?? []).map((lane) => [lane.name, lane]))
    this.#notifier = options.notifier ?? createOsNotifier()
  }

  /**
   * Take an amended workflow (§9). The scheduler's `adopt` has the same name
   * and the same contract, and both are called by the one `AmendRunner` the
   * host builds — because an amendment that reaches only one of them is worse
   * than one that reaches neither.
   *
   * Everything derived from the workflow is rebuilt, not patched: the node map
   * so a node the amendment *added* is dispatchable here as well as in the
   * scheduler, and the wave index because adding a node moves the waves under
   * the `git_merge` that counts a wave's members.
   *
   * Nothing in flight is disturbed. The queued integration turn is a promise
   * chain and is untouched; the next gate run, the next merge and the next
   * tracking write read the new definition, which is exactly the "safe point"
   * `src/amend/` already refuses to violate for the kinds that need one.
   */
  adopt(workflow: Workflow): void {
    this.#workflow = workflow
    this.#nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
    this.#waves = computeWaves(workflow.nodes)
  }

  async execute(invocation: EffectInvocation): Promise<EffectOutcome> {
    const nodeId = String(invocation.context.node?.['id'] ?? '')
    const params = invocation.effect.params

    switch (invocation.effect.definitionId) {
      case 'spawn_agent':
        return params['verdict'] === true ? { facts: { review: { verdict: this.#verdict(nodeId) } } } : {}
      case 'run_gate':
        return await this.#runGate(nodeId, params)
      case 'run_chore':
        // The turns are already run: the scheduler owns spawning, exactly as it
        // does for `spawn_agent`, and reaches here on the way out. What a chore
        // did is in the diff, the transcript and its `chore_result` row; the
        // one fact a chore states, a review's verdict, came back from its turn.
        return {}
      case 'git_branch':
        return await this.#branch(nodeId, params)
      case 'git_merge':
        return await this.#merge(nodeId, params)
      case 'git_push':
        return await this.#push(nodeId)
      case 'open_pr':
        return await this.#openPr(nodeId, params)
      case 'write_tracking':
        return await this.#writeTracking(nodeId, params)
      case 'await_human':
        // The question is already journalled — the scheduler writes it before
        // calling here, so the pause outlives a restart whatever this does.
        // §9.1's OS channel is what remains, and the browser channel is the
        // UI's, off the same journalled question.
        return await this.#notify(nodeId, 'waiting for the operator')
      case 'notify':
        return await this.#notify(nodeId, params['text'])
      case 'grant_fix_rounds':
        // The scheduler owns the counter and has already moved it; there is no
        // body left for the host to run.
        return {}
    }
  }

  // -------------------------------------------------------------------------
  // spawn_agent — the scheduler ran the turn; this reads what it meant
  // -------------------------------------------------------------------------

  /**
   * The last verdict the review stated in the turn that just ended. A turn
   * that errored, or stated nothing, takes the fail-closed default.
   */
  #verdict(nodeId: string): 'pass' | 'fail' {
    const fallback = this.#options.defaultVerdict ?? 'fail'
    const turn = this.#lastTurn(nodeId)
    if (!turn.ok) return fallback
    for (const text of turn.texts) {
      // `src/prompts` owns the marker: the review prompt asks for exactly what
      // this reads, so the protocol cannot drift out of one of the two places.
      // The verdict only — the transcript text itself goes no further.
      const stated = readVerdict(text)
      if (stated !== undefined) return stated
    }
    return fallback
  }

  /**
   * The assistant text of the turn that just ended, newest first, and whether
   * that turn ended cleanly. Read backwards from the tail and stopped at the
   * previous `session_ended`, so an earlier round's words can never be read as
   * this one's.
   */
  #lastTurn(nodeId: string): { readonly ok: boolean; readonly texts: readonly string[] } {
    const entries = this.#options.journal.tailTranscript(
      this.#options.runId,
      nodeId,
      TRANSCRIPT_WINDOW,
    )

    const texts: string[] = []
    let sawEnd = false
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as { type?: string; text?: string; result?: string } | null
      if (entry === null || typeof entry !== 'object') continue
      if (entry.type === 'session_ended') {
        // The turn this effect is reporting on is the last one. A second
        // `session_ended` means we have walked into the previous round.
        if (sawEnd) break
        sawEnd = true
        if (entry.result !== 'ok') return { ok: false, texts }
        continue
      }
      if (entry.type === 'error') return { ok: false, texts }
      if (entry.type === 'assistant_text' && typeof entry.text === 'string') texts.push(entry.text)
    }
    return { ok: true, texts }
  }

  // -------------------------------------------------------------------------
  // run_gate — `executeGate`, in the node's lane, with the cache in front
  // -------------------------------------------------------------------------

  async #runGate(
    nodeId: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<EffectOutcome> {
    const named = params['gate']
    const gateIds = typeof named === 'string' ? [named] : (this.#node(nodeId)?.gates ?? [])
    // A node that declared no gates passes the gate state vacuously (§5.2).
    if (gateIds.length === 0) return { facts: { gate: { exit_code: 0, status: 'passed' } } }

    const lane = this.#lane(nodeId)
    let last: Record<string, ContextValue> = { exit_code: 0, status: 'passed' }
    for (const gateId of gateIds) {
      const gate = this.#workflow.gates[gateId]
      if (gate === undefined) continue
      const logPath = this.#options.journal.gateLogPath(this.#options.runId, nodeId, gateId)

      let { result, cached } = isJudgeGate(gate)
        ? await this.#judgeGate(nodeId, gateId, gate, lane, logPath)
        : await this.#commandGate(nodeId, gateId, gate, lane, logPath)
      let exitCode = this.#recordGate(nodeId, gateId, result, cached)

      // §17.5: a red command gate the classifier calls flaky or environmental
      // is run again before a fixer is spent on it. Only a fresh failure: a
      // cached one is a verdict this tree already earned, reruns included.
      let triage: string | undefined
      const triageConfig = this.#options.systemOne?.judges.gate_triage
      const adapter = this.#options.systemOne?.adapter
      if (
        !isJudgeGate(gate) &&
        result.status === 'failed' &&
        !cached &&
        triageConfig !== undefined &&
        adapter !== undefined
      ) {
        for (let rerun = 0; rerun < triageConfig.max_reruns; rerun += 1) {
          const sorted = await triageGateFailure({ config: triageConfig, adapter, logPath: result.logPath })
          this.#judged(nodeId, 'gate_triage', gateId, sorted.judgement)
          triage = sorted.label ?? triage
          if (!sorted.rerun) break
          ;({ result, cached } = await this.#commandGate(nodeId, gateId, gate, lane, logPath, true))
          exitCode = this.#recordGate(nodeId, gateId, result, cached)
          if (result.status !== 'failed') break
        }
      }

      last = {
        id: gateId,
        exit_code: exitCode,
        status: result.status,
        cached,
        log_ref: result.logPath,
        ...(triage === undefined ? {} : { triage }),
      }
      // Declaration order, and the first red gate is the answer: running the
      // rest costs the most contended pool in the system to learn nothing.
      if (exitCode !== 0) break
    }
    return { facts: { gate: last } }
  }

  /** A command gate, in the node's lane, with the cache in front. */
  async #commandGate(
    nodeId: string,
    gateId: string,
    gate: CommandGate,
    lane: ExecutorLane,
    logPath: string,
    rerun = false,
  ): Promise<{ readonly result: GateResult; readonly cached: boolean }> {
    // The line that runs: the gate's scoped form when the run gates phases
    // narrowed and the gate has one, its full `cmd` otherwise. Resolved per run
    // of the gate, because the files the lane changed move with every fix.
    const node = this.#node(nodeId)
    const effective = await phaseGate(gate, this.#workflow.defaults.gate_scope, {
      lanePath: lane.path,
      base: this.#row(nodeId)?.base_branch ?? this.#options.integrator.base(nodeId).branch,
      touches: node?.touches ?? [],
    })
    return await this.#gate(
      gateId,
      lane,
      {
        gateId,
        gate: effective,
        cwd: lane.path,
        env: lane.env,
        logPath,
        // At the spawn, not here: the scheduler already holds this gate's
        // pools, but the cache sits in between and a hit must not announce a
        // start it never made.
        onStart: () => {
          this.#options.journal.append({
            runId: this.#options.runId,
            nodeId,
            type: 'gate_started',
            payload: { gate: gateId },
          })
        },
      },
      rerun,
    )
  }

  /**
   * The cache composed around `executeGate` rather than around `runGate` — see
   * the module comment. A hit never reaches the runner at all, which is the
   * point: the scheduler already holds the pools, but a real run's cost is the
   * gate command, not the lease.
   *
   * `rerun` skips the lookup — a triage rerun (§17.5) exists to ask the same
   * tree again, and the cache would answer with the failure it is doubting —
   * and still stores, so the rerun's verdict is the one the next lookup gets.
   */
  async #gate(
    gateId: string,
    lane: ExecutorLane,
    options: Omit<RunGateOptions, 'pools'>,
    rerun = false,
  ): Promise<{ readonly result: GateResult; readonly cached: boolean }> {
    const cache = this.#options.cache
    if (cache === undefined) return { result: await executeGate(options), cached: false }

    const treeHash = laneTreeHash(lane.path)
    if (this.#options.noCache !== true && !rerun) {
      const hit = cache.lookup(gateId, treeHash, options.gate.cmd)
      if (hit !== undefined) return { result: hit, cached: true }
    }
    const result = await executeGate(options)
    cache.store(treeHash, options.gate.cmd, result)
    return { result, cached: false }
  }

  /**
   * A judge gate (§17.4): the lane's diff, asked of the operator's classifier.
   *
   * Cached on the same key shape as a command gate, with the resolved question
   * and the adapter standing in for the command. Only an *answered* question is
   * stored: an unavailable classifier is a fact about the network, not about
   * the tree, and caching it would make one outage that tree's verdict.
   */
  async #judgeGate(
    nodeId: string,
    gateId: string,
    gate: JudgeGate,
    lane: ExecutorLane,
    logPath: string,
  ): Promise<{ readonly result: GateResult; readonly cached: boolean }> {
    const { judge } = gate
    const question =
      judge.question ??
      resolveBrief(lane.path, nodeId, judge.question_ref as string, `gates.${gateId}.judge.question_ref`)
    const adapter = this.#options.systemOne?.adapter
    const cache = this.#options.cache
    const key = judgeCacheKey(judge, question, adapter?.id ?? 'none')
    const treeHash = cache === undefined ? undefined : laneTreeHash(lane.path)

    if (cache !== undefined && treeHash !== undefined && this.#options.noCache !== true) {
      const hit = cache.lookup(gateId, treeHash, key)
      if (hit !== undefined) return { result: hit, cached: true }
    }

    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId,
      type: 'gate_started',
      payload: { gate: gateId },
    })
    const ran = await runJudgeGate({
      gateId,
      judge,
      question,
      lanePath: lane.path,
      base: this.#row(nodeId)?.base_branch ?? this.#options.integrator.base(nodeId).branch,
      logPath,
      adapter,
    })
    this.#judged(nodeId, 'gate', gateId, ran.judgement)
    if (cache !== undefined && treeHash !== undefined && ran.judgement.outcome === 'answered') {
      cache.store(treeHash, key, ran.result)
    }
    return { result: ran.result, cached: false }
  }

  /**
   * Journals one gate's verdict and returns the exit code a guard reads.
   *
   * The result reaches the journal; the output does not. §13.6's
   * missing-dependency finding needs to know that *this* gate failed and later
   * passed, which is a fact about ids and an exit code — the lines the gate
   * printed stay in `log_ref`'s file, and nothing here reads them. The duration
   * rides along for the same reason and is the same kind of fact: a number the
   * runner measured, about the gate and not about what it printed. A cached hit
   * reports the duration of the run that filled the cache, which is what makes
   * a cheap hit distinguishable from a cheap gate.
   */
  #recordGate(nodeId: string, gateId: string, result: GateResult, cached: boolean): number {
    const exitCode = result.status === 'passed' ? 0 : (result.exitCode ?? TIMEOUT_EXIT)
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId,
      type: 'gate_result',
      payload: {
        gate: gateId,
        exit_code: exitCode,
        status: result.status,
        duration_ms: result.durationMs,
        cached,
        ...(result.timeout === undefined
          ? {}
          : {
              timeout: {
                quiet_ms: result.timeout.quietMs,
                output_bytes: result.timeout.outputBytes,
                ...(result.timeout.load1m === undefined ? {} : { load_1m: result.timeout.load1m }),
                cpus: result.timeout.cpus,
              },
            }),
      },
    })
    // And again in the node's transcript, which is where somebody reading
    // what happened to this phase actually looks. The gates were the one
    // thing missing from it: four agents' output in order, and no sign of
    // the thing that judged them. Identifiers and an exit code only — the
    // gate's output stays in `logPath`'s file, which the node endpoint
    // already serves (§11).
    this.#options.journal.appendTranscript(this.#options.runId, nodeId, {
      type: 'gate_run',
      gate: gateId,
      exitCode,
      status: result.status,
      cached,
      by: { role: GATE_ROLE },
    })
    return exitCode
  }

  /** One `system_one_judged` row. Labels, scores and ids — never what was judged. */
  #judged(nodeId: string, judge: SystemOneJudge, subject: string, judgement: Judgement): void {
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId,
      type: 'system_one_judged',
      payload: {
        judge,
        subject,
        adapter: this.#options.systemOne?.adapter.id ?? null,
        outcome: judgement.outcome,
        decision: judgement.decision,
        ...(judgement.top === undefined ? {} : { top: judgement.top }),
        ...(judgement.score === undefined ? {} : { score: judgement.score }),
        ...(judgement.latencyMs === undefined ? {} : { latency_ms: judgement.latencyMs }),
      },
    })
  }

  // -------------------------------------------------------------------------
  // git_* and open_pr — the `Integrator`'s, on the node's derived base
  // -------------------------------------------------------------------------

  /**
   * The phase branch, cut at the dependency-derived base. `startNode` builds
   * the `integ-<id>` branch first where the node has several dependencies, so
   * `from` is only ever needed to override the topology rule deliberately.
   */
  async #branch(nodeId: string, params: Readonly<Record<string, unknown>>): Promise<EffectOutcome> {
    const { integrator } = this.#options
    const lane = this.#lane(nodeId)
    const branch = integrator.nodeBranch(nodeId)
    const from = params['from']

    // Whether this node has already been branched **in this run** — which is
    // the question, and which only the journal can answer. A phase branch's
    // name carries the plan id and not the run id, so an identically-named ref
    // left behind by an unrelated earlier run must still be cut fresh; a ref
    // this run assigned is the previous attempt, and resetting it is how a
    // retry used to erase the work it was meant to recover.
    const resume = this.#row(nodeId)?.branch === branch
    // Read before anything moves it. Computed after the checkout it would be
    // the *new* head, which is the one fact already recorded.
    const previousHead = await this.#head(lane.path, branch)

    if (typeof from === 'string') {
      await git(lane.path, resume ? ['checkout', branch] : ['checkout', '-B', branch, from])
    } else {
      await this.#integration(() => integrator.startNode(nodeId, lane.path, resume))
    }

    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId,
      type: 'node_assigned',
      payload: {
        branch,
        base_branch: typeof from === 'string' ? from : integrator.base(nodeId).branch,
        // What the branch pointed at when this attempt took it over. Null on a
        // first attempt. It is the one fact that makes a reset — this one or a
        // hand-rolled one — visible in the journal rather than only in a reflog
        // somebody has to know to read.
        previous_head: previousHead,
      },
    })
    return {}
  }

  /** The branch's tip, or null where it does not exist yet. */
  async #head(lanePath: string, branch: string): Promise<string | null> {
    const lines = await gitLines(lanePath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]).catch(() => [])
    return lines[0] ?? null
  }

  /**
   * A named branch is merged straight into whatever the integration worktree
   * has checked out. With no `branch` this is the node's own phase branch, and
   * the merge that matters for it is its **wave** merge — §6's "on done: … maybe
   * build wave branch". So the wave branch is built by whichever node in the
   * wave finishes last, and every earlier one is a no-op: `mergeWave` merges
   * the whole wave in plan order, and a wave built twice would merge branches
   * that are not ready yet.
   */
  async #merge(nodeId: string, params: Readonly<Record<string, unknown>>): Promise<EffectOutcome> {
    const named = params['branch']
    if (typeof named === 'string') {
      await this.#integration(async () => {
        await git(this.#options.integrationPath, ['merge', '--no-ff', '--no-edit', named])
      })
      return {}
    }

    const wave = this.#waves.get(nodeId)
    if (wave === undefined) return {}
    // Both answers from one reading of the plan, taken synchronously: whether
    // the wave is complete, and which branches make it up. The merge itself is
    // queued behind the integration worktree and an amendment can land before
    // it runs, so deriving the membership later would let the wave that was
    // declared complete and the wave that is merged be different sets.
    const members = this.#waveMembers(wave)
    if (!this.#lastOfWave(nodeId, members)) return {}
    // Read with the membership, for the same reason: the plan this node counted
    // its wave against is the plan whose last wave this is or is not.
    const final = wave === this.#finalWave()
    await this.#integration(async () => {
      const result = await this.#options.integrator.mergeWave(wave, members)
      await this.#waveGates(nodeId, wave, members)
      // Pushed, because the plan PR is opened from the last one and a PR needs
      // a head the forge has seen. The rest are pushed for the same reason the
      // skills always pushed them: they are what a person resuming or landing
      // the plan by hand starts from.
      await this.#pushFrom(this.#options.integrationPath, result.branch)
    })
    // Opened by this node's own `open_pr`, not here. `git_merge` runs before
    // `open_pr` in the phase pipeline, so a plan PR opened now would be written
    // before the last phase's PR exists and could not list it.
    if (final) this.#planPrDue = { wave, by: nodeId }
    return {}
  }

  /**
   * The full form of every gate this wave's phases ran narrowed, once, on the
   * merged tree in the integration worktree.
   *
   * Only those gates. A gate with no `scoped_cmd` already ran in full on every
   * phase, and running it again here would be a second full suite per wave
   * bought to answer a question that was already answered for each phase —
   * the cross-phase case it would add is real, and is what `gate_scope: full`
   * plus this wave gate are not trying to be. What *was* skipped is the full
   * suite itself, and this is where it is paid back.
   *
   * Without the scheduler's pools, for `verify`'s reason: the node running this
   * is inside its own `integrate` step and may still hold the pool a suite
   * would ask for. Not cached either: a merge produces a tree no lane has had.
   *
   * Red fails the merge, and with it the node that built the wave — the wave
   * branch is left as it is for whoever picks it up.
   */
  async #waveGates(nodeId: string, wave: number, members: readonly string[]): Promise<void> {
    if (this.#workflow.defaults.gate_scope !== 'scoped') return
    const ids = [...new Set(members.flatMap((member) => this.#node(member)?.gates ?? []))]
    for (const gateId of ids) {
      const gate = this.#workflow.gates[gateId]
      if (gate === undefined || isJudgeGate(gate) || gate.scoped_cmd === undefined) continue
      const logPath = this.#options.journal.gateLogPath(
        this.#options.runId,
        WAVE_GATE_NODE,
        `wave-${wave}-${gateId}`,
      )
      const result = await executeGate({
        gateId,
        gate,
        cwd: this.#options.integrationPath,
        env: this.#options.integrationEnv ?? {},
        logPath,
      })
      const exitCode = result.status === 'passed' ? 0 : (result.exitCode ?? TIMEOUT_EXIT)
      this.#options.journal.append({
        runId: this.#options.runId,
        nodeId,
        type: 'wave_gate_result',
        payload: {
          wave,
          gate: gateId,
          exit_code: exitCode,
          status: result.status,
          duration_ms: result.durationMs,
        },
      })
      if (exitCode !== 0) throw new WaveGateError(wave, gateId, exitCode, logPath)
    }
  }

  /** The highest wave in the plan as it stands — the branch carrying every phase. */
  #finalWave(): number {
    let last = 0
    for (const wave of this.#waves.values()) last = Math.max(last, wave)
    return last
  }

  /** The wave's phases, in plan order — the tie-break every merge order uses. */
  #waveMembers(wave: number): string[] {
    return this.#workflow.nodes
      .filter((node) => this.#waves.get(node.id) === wave)
      .map((node) => node.id)
  }

  /**
   * Records that this node reached its merge, and answers whether it is the
   * last of its wave to do so.
   *
   * Counted here rather than read out of the node statuses, because a node
   * asking this question is inside its own `integrate` step and is therefore
   * still `running` — and so is every sibling that got here first, since none
   * of them is `done` until its own pipeline reaches a final state. Two nodes
   * of one wave finishing together would each see the other unfinished and
   * neither would build the wave branch. The count is taken synchronously,
   * before any await, so the two cannot interleave.
   *
   * `members` is handed in rather than derived, so that the set this counts
   * against is exactly the set the merge will merge. A node an amendment adds
   * to this wave between the two readings would otherwise raise the bar here
   * and never be merged, and one it removes would lower the bar and then be
   * merged from a branch that was never cut.
   */
  #lastOfWave(nodeId: string, members: readonly string[]): boolean {
    const wave = this.#waves.get(nodeId) as number
    const arrived = this.#arrived.get(wave) ?? new Set<string>()
    arrived.add(nodeId)
    this.#arrived.set(wave, arrived)
    // Counted against the same list the merge will use, rather than against a
    // size read separately: an amendment between the two readings would make
    // the wave "complete" at a count that no longer matches what is merged.
    return members.every((member) => arrived.has(member))
  }

  /**
   * Pushes the phase branch. A repository with no remote — every test repo,
   * and plenty of real ones — is a documented no-op, and a rejected push is
   * reported rather than thrown: hours of completed work must not be undone by
   * the reporting step, which is exactly why `openPullRequest` never throws.
   */
  async #push(nodeId: string): Promise<EffectOutcome> {
    const lane = this.#lane(nodeId)
    const remotes = await gitLines(lane.path, ['remote'])
    const remote = remotes[0]
    if (remote === undefined) return {}
    await gitOk(lane.path, [
      'push',
      '--set-upstream',
      remote,
      this.#options.integrator.nodeBranch(nodeId),
    ])
    return {}
  }

  /** One PR per node, on that node's own base. Never throws — see `pr.ts`. */
  async #openPr(nodeId: string, params: Readonly<Record<string, unknown>>): Promise<EffectOutcome> {
    const { integrator, journal, runId } = this.#options
    const base = integrator.base(nodeId)

    // **A base nothing pushed is a PR nobody can open.** `git_push` pushes the
    // node's own branch and only that, so a phase based on an `integ-<id>`
    // branch — which is every phase with more than one dependency — asked the
    // forge to open against a ref it had never seen. `gh` refused, the refusal
    // was swallowed (see below), and the phase completed with no pull request
    // and nothing anywhere saying so. Exactly one node in the run that
    // surfaced this had two dependencies, and it was exactly the one with no PR.
    //
    // Only the integration branch: a `base_branch` is the operator's own and a
    // single-dependency base is another phase's branch, which that phase
    // pushed when it integrated — before this one could start, because it is a
    // dependency.
    if (base.kind === 'integration') {
      await this.#pushBranch(nodeId, base.branch)
      // **And the integration branch gets a PR of its own.** It used to be
      // pushed only so this phase's PR had something to target, and then
      // nothing targeted *it*: every PR stacked above it had no path to
      // `base_branch`, and landing the plan meant redoing the merges by hand.
      // Opened before the phase PR so the forge lists them in merge order.
      const integration = await integrator.openIntegrationPr(nodeId, {
        draft: params['draft'] === true,
      })
      if (integration !== null) this.#recordPr(nodeId, 'integration', integration)
    }

    const result = await integrator.openPr(nodeId, {
      draft: params['draft'] === true,
      text: this.#prText(nodeId),
    })

    // **Recorded rather than discarded.** `openPullRequest` never throws by
    // design — reporting a finished run is not the work the run did, and a
    // missing `gh` must not turn hours of completed phases into a failure — but
    // the result was then dropped on the floor, which turned "never fails" into
    // "never tells you". A PR that did not open is now as visible as one that
    // did, and the body's provenance with it: an operator reading a thin PR
    // should be able to see it was composed rather than written.
    this.#recordPr(nodeId, 'phase', result)

    if (this.#planPrDue?.by === nodeId) {
      const { wave } = this.#planPrDue
      this.#planPrDue = null
      const plan = await integrator.openPlanPr(wave, {
        draft: params['draft'] === true,
        text: this.#planPrText(wave),
      })
      if (plan !== null) {
        journal.append({ runId, type: 'run_pr', payload: prPayload(plan) })
      }
    }

    // Stated as facts as well, for what follows in the same state: an
    // `after_pr` chore is handed the phase PR it is about, and is skipped when
    // there is none. The URL is the forge's own, not repository content.
    const number = result.url === undefined ? undefined : prNumberOf(result.url)
    return {
      facts: {
        pr: {
          opened: result.opened,
          ...(result.url === undefined ? {} : { url: result.url }),
          ...(number === undefined ? {} : { number }),
        },
      },
    }
  }

  #recordPr(nodeId: string, kind: 'phase' | 'integration', result: PrResult): void {
    const { journal, runId } = this.#options
    journal.append({ runId, nodeId, type: 'node_pr', payload: { kind, ...prPayload(result) } })
  }

  /**
   * The plan PR's body: every PR the plan needs, in an order that merges.
   *
   * Walked from the graph rather than from the journal, so a phase whose PR
   * did not open is still listed — as a gap somebody has to fill, which is the
   * point of listing it. The journal only supplies the URLs.
   */
  #planPrText(wave: number): PrText {
    const { integrator, journal, runId } = this.#options
    const urls = new Map<string, string>()
    for (const event of journal.events(runId)) {
      if (event.type !== 'node_pr' || event.payload.url === undefined) continue
      urls.set(`${event.payload.kind ?? 'phase'}:${event.nodeId}`, event.payload.url)
    }

    const ordered = [...this.#workflow.nodes].sort(
      (a, b) => (this.#waves.get(a.id) ?? 0) - (this.#waves.get(b.id) ?? 0),
    )
    const steps: PlanPrStep[] = []
    for (const node of ordered) {
      const base = integrator.base(node.id)
      if (base.kind === 'integration') {
        const url = urls.get(`integration:${node.id}`)
        steps.push({
          kind: 'integration',
          nodeId: node.id,
          head: base.branch,
          base: this.#workflow.base_branch,
          ...(url === undefined ? {} : { url }),
        })
      }
      const url = urls.get(`phase:${node.id}`)
      steps.push({
        kind: 'phase',
        nodeId: node.id,
        head: integrator.nodeBranch(node.id),
        base: base.branch,
        ...(url === undefined ? {} : { url }),
      })
    }

    return composePlanPrBody({
      planId: this.#workflow.id,
      baseBranch: this.#workflow.base_branch,
      head: integrator.waveBranch(wave),
      steps,
    })
  }

  /** Pushes one branch to the lane's remote. Silent where there is no remote. */
  async #pushBranch(nodeId: string, branch: string): Promise<void> {
    await this.#pushFrom(this.#lane(nodeId).path, branch)
  }

  /** Pushes one branch from a checkout. Silent where there is no remote. */
  async #pushFrom(cwd: string, branch: string): Promise<void> {
    const remotes = await gitLines(cwd, ['remote'])
    const remote = remotes[0]
    if (remote === undefined) return
    await gitOk(cwd, ['push', remote, branch])
  }

  /**
   * What this phase's pull request says: the agent's own context file when
   * there is one, else a body composed from the run's record.
   *
   * Read from the lane rather than the integration worktree, because the lane
   * is where the phase worked and where an agent writing about its own change
   * would have put the file.
   */
  #prText(nodeId: string): PrText {
    const node = this.#nodes.get(nodeId)
    const planId = this.#options.workflow.id
    const written = readPrContext(this.#lane(nodeId).path, planId, nodeId)
    if (written !== null) return written
    if (node === undefined) throw new Error(`unknown node "${nodeId}"`)

    const events = this.#options.journal.events(this.#options.runId)

    // Last result per gate, in the order the node declared them: an early red
    // that a later round fixed is history, and the PR is about what landed.
    const finals = new Map<string, number>()
    for (const event of events) {
      if (event.type === 'gate_result' && event.nodeId === nodeId) {
        finals.set(event.payload.gate, event.payload.exit_code)
      }
    }
    // Counted in one pass rather than three filters, because `filter` does not
    // narrow the payload union for the `map` that follows it.
    let attempts = 1
    const conflicts: { paths: readonly string[]; rounds: number }[] = []
    for (const event of events) {
      if (event.type === 'node_error' && event.nodeId === nodeId) attempts += 1
      if (event.type === 'node_conflict' && event.nodeId === nodeId) {
        conflicts.push({ paths: event.payload.paths, rounds: event.payload.rounds })
      }
    }

    return composePrBody({
      nodeId,
      name: node.name,
      promptRef: node.prompt_ref,
      branch: this.#options.integrator.nodeBranch(nodeId),
      base: this.#options.integrator.base(nodeId).branch,
      dependsOn: node.depends_on.map((dep) => dep.node),
      gates: node.gates
        .filter((gate) => finals.has(gate))
        .map((gate) => ({ gate, exitCode: finals.get(gate) as number })),
      // One more than the failures recorded: an attempt that never failed
      // journals no `node_error`, so a clean phase counts 1.
      attempts,
      conflicts,
      touches: node.touches,
    })
  }

  // -------------------------------------------------------------------------
  // write_tracking
  // -------------------------------------------------------------------------

  async #writeTracking(
    nodeId: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<EffectOutcome> {
    const raw = params['scope']
    const scope: TrackingScope = raw === 'run' || raw === 'wave' ? raw : 'phase'
    if (scope === 'phase') {
      // The lane's own file, on the phase branch — so it travels with the merge.
      await writeTrackingFile({
        cwd: this.#lane(nodeId).path,
        // `trackingPath`, never `join`: every one of these is a *git* path, and
        // `node:path`'s join puts a backslash in it on Windows (see
        // `tracking.ts`). The file was written and then never committed.
        relPath: trackingPath(this.#workflow, `phase-${nodeId}.md`),
        body: renderPhase(this.#phaseFacts(nodeId)),
        message: `tracking: phase ${nodeId}`,
      })
      return {}
    }

    // The conductor's two files, both in the integration worktree.
    const { runId, integrator, integrationPath } = this.#options
    const workflow = this.#workflow
    if (scope === 'run') {
      await this.#integration(() =>
        writeTrackingFile({
          cwd: integrationPath,
          relPath: trackingPath(workflow, 'run.md'),
          body: renderRun({
            runId,
            workflowId: workflow.id,
            baseBranch: workflow.base_branch,
            phases: workflow.nodes.map((node) => this.#phaseFacts(node.id)),
          }),
          message: `tracking: run ${runId}`,
        }),
      )
      return {}
    }

    const wave = this.#waves.get(nodeId) ?? 1
    await this.#integration(() =>
      writeTrackingFile({
        cwd: integrationPath,
        relPath: trackingPath(workflow, 'waves', `wave-${wave}.md`),
        body: renderWave({
          wave,
          branch: integrator.waveBranch(wave),
          merged: integrator
            .nodesAt(wave)
            .map((id) => ({ nodeId: id, branch: integrator.nodeBranch(id) })),
          conflicts: [],
        }),
        message: `tracking: wave ${wave}`,
      }),
    )
    return {}
  }

  #phaseFacts(nodeId: string): PhaseFacts {
    const node = this.#node(nodeId)
    const row = this.#row(nodeId)
    return {
      nodeId,
      wave: this.#waves.get(nodeId) ?? row?.wave ?? 1,
      status: row?.status ?? 'running',
      harness: node?.harness ?? this.#workflow.defaults.harness,
      lane: row?.lane ?? null,
      branch: this.#options.integrator.nodeBranch(nodeId),
      base: this.#options.integrator.base(nodeId).branch,
      dependsOn: node?.depends_on.map((dep) => dep.node) ?? [],
      gates: node?.gates ?? [],
    }
  }

  // -------------------------------------------------------------------------
  // notify
  // -------------------------------------------------------------------------

  /** Identifier plus a reason from a fixed vocabulary. Nothing else — see `notify.ts`. */
  async #notify(nodeId: string, text: unknown): Promise<EffectOutcome> {
    await this.#notifier.notify({
      scope: nodeId === '' ? 'run' : 'node',
      id: nodeId === '' ? this.#options.runId : nodeId,
      reason: notifyReason(text),
    })
    return {}
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  #node(nodeId: string): Node | undefined {
    return this.#nodes.get(nodeId)
  }

  #row(nodeId: string): NodeRow | undefined {
    return this.#options.journal
      .nodes(this.#options.runId)
      .find((row) => row.node_id === nodeId)
  }

  /**
   * The lane the scheduler assigned, read back from the projection it wrote
   * (`node_assigned`). The scheduler does not put the lane in the guard
   * context — a lane path is not a fact a plan may branch on — and the journal
   * is the record it does keep.
   */
  #lane(nodeId: string): ExecutorLane {
    const name = this.#row(nodeId)?.lane
    if (name === null || name === undefined) {
      throw new Error(`node "${nodeId}" has no lane assigned`)
    }
    const known = this.#lanes.get(name)
    if (known === undefined) {
      // It used to fall back to `{ name, path: join(laneRoot, name), env: {} }`
      // — the right directory with **no environment**, which is this area's
      // recurring bug in miniature: a gate running against the wrong compose
      // project and no forked connection string, with nothing anywhere saying
      // a lane was missing. A guessed path is not worth what a silent empty
      // environment costs, so it is a refusal now.
      throw new Error(`node "${nodeId}" is in lane "${name}", which this executor was not given`)
    }
    return known
  }

  /** Serializes work in the single integration worktree. */
  async #integration<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#integrationTurn.then(work, work)
    // Swallowed on the chain only: the caller still sees the rejection.
    this.#integrationTurn = turn.catch(() => undefined)
    return await turn
  }

  /**
   * The integration worktree's queue, for the one other thing that writes in
   * it: §9's rebase.
   *
   * There is one integration worktree and two writers. This executor merges
   * waves and prepares `integ-` bases in it; `amend/rebase.ts` moves `done`
   * branches in it while an amendment is being applied. Both run `checkout -B`,
   * and until now nothing sequenced them — an amendment is accepted whenever
   * the nodes it *blocks* are idle, which says nothing about whether some other
   * wave's merge is in flight in the same directory.
   *
   * Exposed rather than given a second queue of its own, because two queues
   * over one worktree serialize nothing.
   */
  async integration<T>(work: () => Promise<T>): Promise<T> {
    return await this.#integration(work)
  }
}

/** Convenience constructor, matching the shape the rest of the package uses. */
export function createRunExecutor(options: RunExecutorOptions): RunEffectExecutor {
  return new RunEffectExecutor(options)
}

/** A PR result as the journal keeps it: no `message`, which quotes `gh`. */
function prPayload(result: PrResult): {
  opened: boolean
  base: string
  head: string
  url?: string
  reason?: 'unavailable' | 'failed'
} {
  return {
    opened: result.opened,
    base: result.base,
    head: result.head,
    ...(result.url === undefined ? {} : { url: result.url }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  }
}
