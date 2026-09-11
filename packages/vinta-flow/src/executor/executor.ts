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
 * | `spawn_agent` (`role: reviewer`) | `review.verdict` — `'pass'` \| `'fail'` | `t-review-pass` / `t-review-fail` |
 * | `spawn_agent` (any other role) | none | — |
 * | `run_gate` | `gate.id`, `gate.exit_code`, `gate.status`, `gate.cached`, `gate.log_ref` | `t-gate-pass` / `t-gate-fail` |
 * | `git_branch` | none | — |
 * | `git_merge` | none | — |
 * | `git_push` | none | — |
 * | `open_pr` | none | — |
 * | `write_tracking` | none | — |
 * | `await_human` | none — the *answer* arrives as `human.answer`, from the scheduler | any guard on `human.*` |
 * | `notify` | none | — |
 *
 * `fix_rounds` is the scheduler's, fed in on every step; nothing here writes it.
 *
 * **Where `review.verdict` comes from.** The scheduler owns the `spawn_agent`
 * body: it admits the turn, drains the session into the transcript, and *then*
 * calls this executor with the same invocation. The turn's meaning is left
 * deliberately unanswered there — "what did the reviewer decide" is not a
 * scheduling question — and the drained stream is already durable, so the
 * verdict is read back out of the transcript the scheduler just wrote
 * (`Journal.tailTranscript`). No scheduler change is needed for this, and none
 * was made. The reviewer states its verdict in its own last words as
 * `VERDICT: pass` or `VERDICT: fail` — read by `readVerdict`, which
 * `src/prompts` also uses to *ask* for it, so the protocol has one definition
 * rather than a prompt and a parser free to drift apart. A turn that errored,
 * or one that stated nothing, takes `defaultVerdict` — `'fail'`, because a
 * merge on a reviewer's silence is the one failure mode a review step exists
 * to prevent. The
 * transcript text is matched and discarded: it never reaches a fact, a log
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
import { join } from 'node:path'
import { laneTreeHash, type GateCache } from '../gates/cache.ts'
import { executeGate, type GateResult, type RunGateOptions } from '../gates/runner.ts'
import { computeWaves } from '../graph.ts'
import { git, gitLines, gitOk } from '../integration/git.ts'
import type { Integrator } from '../integration/integrator.ts'
import type { Journal, NodeRow } from '../journal/journal.ts'
import type { EffectExecutor, EffectInvocation, EffectOutcome } from '../pipeline/effects.ts'
import type { ContextValue } from '../pipeline/guard.ts'
import { readVerdict } from '../prompts/index.ts'
import type { Node, Workflow } from '../types.ts'
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
  /** The scheduler's `laneRoot`: the fallback for a lane the host did not describe. */
  readonly laneRoot: string
  /** Provisioned lanes by name. A lane not listed falls back to `laneRoot/<name>` and no env. */
  readonly lanes?: readonly ExecutorLane[]
  /** §13.4's gate result cache. Omitted means every gate runs. */
  readonly cache?: GateCache
  /** `--no-cache`: run the gate anyway, and refresh the entry with the result. */
  readonly noCache?: boolean
  /** Verdict for a reviewer turn that stated none. Conservative by default. */
  readonly defaultVerdict?: 'pass' | 'fail'
  /** Injected in tests, and on a platform with no notification channel. */
  readonly notifier?: Notifier
}

/**
 * The exit code a timed-out gate reports. `GateResult.exitCode` is null there —
 * the gate never got to say anything — and a guard reading `gate.exit_code`
 * needs a number that is not zero. 124 is `timeout(1)`'s.
 */
const TIMEOUT_EXIT = 124

/** How many transcript entries back to look for the reviewer's verdict. */
const TRANSCRIPT_WINDOW = 50

export class RunEffectExecutor implements EffectExecutor {
  readonly #options: RunExecutorOptions
  readonly #nodes: ReadonlyMap<string, Node>
  readonly #waves: ReadonlyMap<string, number>
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

  constructor(options: RunExecutorOptions) {
    this.#options = options
    this.#nodes = new Map(options.workflow.nodes.map((node) => [node.id, node]))
    this.#waves = computeWaves(options.workflow.nodes)
    this.#lanes = new Map((options.lanes ?? []).map((lane) => [lane.name, lane]))
    this.#notifier = options.notifier ?? createOsNotifier()
  }

  async execute(invocation: EffectInvocation): Promise<EffectOutcome> {
    const nodeId = String(invocation.context.node?.['id'] ?? '')
    const params = invocation.effect.params

    switch (invocation.effect.definitionId) {
      case 'spawn_agent':
        return this.#reviewed(nodeId, params)
      case 'run_gate':
        return await this.#runGate(nodeId, params)
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
    }
  }

  // -------------------------------------------------------------------------
  // spawn_agent — the scheduler ran the turn; this reads what it meant
  // -------------------------------------------------------------------------

  #reviewed(nodeId: string, params: Readonly<Record<string, unknown>>): EffectOutcome {
    if (params['role'] !== 'reviewer') return {}
    return { facts: { review: { verdict: this.#verdict(nodeId) } } }
  }

  /**
   * The last verdict the reviewer stated in the turn that just ended. Read
   * backwards from the tail so an earlier round's verdict can never be picked
   * up, and stopped at the previous `session_ended` for the same reason.
   */
  #verdict(nodeId: string): 'pass' | 'fail' {
    const fallback = this.#options.defaultVerdict ?? 'fail'
    const entries = this.#options.journal.tailTranscript(
      this.#options.runId,
      nodeId,
      TRANSCRIPT_WINDOW,
    )

    let sawEnd = false
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as { type?: string; text?: string; result?: string } | null
      if (entry === null || typeof entry !== 'object') continue
      if (entry.type === 'session_ended') {
        // The turn this effect is reporting on is the last one. A second
        // `session_ended` means we have walked into the previous round.
        if (sawEnd) break
        sawEnd = true
        if (entry.result !== 'ok') return fallback
        continue
      }
      if (entry.type === 'error') return fallback
      if (entry.type !== 'assistant_text' || typeof entry.text !== 'string') continue
      // `src/prompts` owns the marker: the reviewer prompt asks for exactly what
      // this reads, so the protocol cannot drift out of one of the two places.
      // The verdict only — the transcript text itself goes no further.
      const stated = readVerdict(entry.text)
      if (stated !== undefined) return stated
    }
    return fallback
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
      const gate = this.#options.workflow.gates[gateId]
      if (gate === undefined) continue

      const { result, cached } = await this.#gate(gateId, lane, {
        gateId,
        gate,
        cwd: lane.path,
        env: lane.env,
        logPath: this.#options.journal.gateLogPath(this.#options.runId, nodeId, gateId),
      })
      const exitCode = result.status === 'passed' ? 0 : (result.exitCode ?? TIMEOUT_EXIT)
      // The result reaches the journal; the output does not. §13.6's
      // missing-dependency finding needs to know that *this* gate failed and
      // later passed, which is a fact about ids and an exit code — the lines
      // the gate printed stay in `log_ref`'s file, and nothing here reads them.
      this.#options.journal.append({
        runId: this.#options.runId,
        nodeId,
        type: 'gate_result',
        payload: { gate: gateId, exit_code: exitCode, status: result.status },
      })
      last = {
        id: gateId,
        exit_code: exitCode,
        status: result.status,
        cached,
        log_ref: result.logPath,
      }
      // Declaration order, and the first red gate is the answer: running the
      // rest costs the most contended pool in the system to learn nothing.
      if (exitCode !== 0) break
    }
    return { facts: { gate: last } }
  }

  /**
   * The cache composed around `executeGate` rather than around `runGate` — see
   * the module comment. A hit never reaches the runner at all, which is the
   * point: the scheduler already holds the pools, but a real run's cost is the
   * gate command, not the lease.
   */
  async #gate(
    gateId: string,
    lane: ExecutorLane,
    options: Omit<RunGateOptions, 'pools'>,
  ): Promise<{ readonly result: GateResult; readonly cached: boolean }> {
    const cache = this.#options.cache
    if (cache === undefined) return { result: await executeGate(options), cached: false }

    const treeHash = laneTreeHash(lane.path)
    if (this.#options.noCache !== true) {
      const hit = cache.lookup(gateId, treeHash)
      if (hit !== undefined) return { result: hit, cached: true }
    }
    const result = await executeGate(options)
    cache.store(treeHash, result)
    return { result, cached: false }
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

    if (typeof from === 'string') await git(lane.path, ['checkout', '-B', branch, from])
    else await this.#integration(() => integrator.startNode(nodeId, lane.path))

    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId,
      type: 'node_assigned',
      payload: {
        branch,
        base_branch: typeof from === 'string' ? from : integrator.base(nodeId).branch,
      },
    })
    return {}
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
    if (wave === undefined || !this.#lastOfWave(nodeId, wave)) return {}
    await this.#integration(() => this.#options.integrator.mergeWave(wave))
    return {}
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
   */
  #lastOfWave(nodeId: string, wave: number): boolean {
    const arrived = this.#arrived.get(wave) ?? new Set<string>()
    arrived.add(nodeId)
    this.#arrived.set(wave, arrived)
    const size = this.#options.workflow.nodes.filter(
      (node) => this.#waves.get(node.id) === wave,
    ).length
    return arrived.size >= size
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
    await this.#options.integrator.openPr(nodeId, { draft: params['draft'] === true })
    return {}
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
        relPath: trackingPath(this.#options.workflow, `phase-${nodeId}.md`),
        body: renderPhase(this.#phaseFacts(nodeId)),
        message: `tracking: phase ${nodeId}`,
      })
      return {}
    }

    // The conductor's two files, both in the integration worktree.
    const { workflow, runId, integrator, integrationPath } = this.#options
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
      harness: node?.harness ?? this.#options.workflow.defaults.harness,
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
    return (
      this.#lanes.get(name) ?? { name, path: join(this.#options.laneRoot, name), env: {} }
    )
  }

  /** Serializes work in the single integration worktree. */
  async #integration<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#integrationTurn.then(work, work)
    // Swallowed on the chain only: the caller still sees the rejection.
    this.#integrationTurn = turn.catch(() => undefined)
    return await turn
  }
}

/** Convenience constructor, matching the shape the rest of the package uses. */
export function createRunExecutor(options: RunExecutorOptions): RunEffectExecutor {
  return new RunEffectExecutor(options)
}
