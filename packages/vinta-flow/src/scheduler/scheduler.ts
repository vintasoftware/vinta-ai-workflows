/**
 * The scheduler: continuous DAG dispatch over lanes, pools and pipelines (§6).
 *
 * It composes units that already exist and adds exactly one thing — *when*
 * work starts and stops. Graph shape comes from `graph.ts`, capacity from
 * `ResourcePools`, vendor backpressure from `AdmissionControl`, per-node
 * control flow from `PipelineRun`, and every side effect from the injected
 * `EffectExecutor`. Nothing about git, prompts or agent semantics lives here.
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
import { join } from 'node:path'
import type { AdmissionControl } from '../admission/admission.ts'
import { computeWaves, findCycle, transitiveDependents } from '../graph.ts'
import type { AgentSession, AgentTask, HarnessAdapter } from '../harness/adapter.ts'
import type {
  HumanQuestion,
  NodeStatus,
  OperatorDelivery,
  OperatorOp,
} from '../journal/events.ts'
import type { Journal } from '../journal/journal.ts'
import type { EffectExecutor, EffectInvocation, EffectOutcome } from '../pipeline/effects.ts'
import type { GuardContext } from '../pipeline/guard.ts'
import { createPipelineRun, type PipelineRun, type StepResult } from '../pipeline/interpreter.ts'
import { pipelineFor } from '../pipeline/standard.ts'
import type { Lease, ResourcePools } from '../resources/pools.ts'
import type { Node, Pipeline, Workflow } from '../types.ts'

/** The pool a node is dispatched into. Required of every workflow (§5.1). */
const LANE = 'lane'

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

/** A refusal that is backpressure: unwinds the attempt so the lane is freed first. */
class CapacityRetry extends Error {
  constructor(readonly waitFor: () => Promise<void>) {
    super('capacity')
  }
}

/** `fatal` only — a broken harness, which is the one refusal that fails a node. */
class SpawnFatal extends Error {}

/**
 * Unwinds a node the operator aborted (§9). It carries no message: the node is
 * already marked failed, with its reason, by the time this is thrown.
 */
class Aborted extends Error {}

interface NodeState {
  readonly node: Node
  readonly pipeline: Pipeline
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
  /** Set by `pause`; honoured after the current turn, never inside it. */
  pauseRequested: boolean
  /** Set by `abortNode`. Every step checks it, so a killed node stops stepping. */
  aborted: boolean
  /** The effect the node is parked on, for the answer event that closes it. */
  parkedEffectId: string | null
  /** Fixer runs taken so far. The `fix_rounds` fact the interpreter reads. */
  fixRounds: number
  lane: string | null
  laneLease: Lease | null
  /** Held for one pipeline step, and released at an `await_human` suspension. */
  gateLease: Lease | null
  gateHeld: readonly string[]
  /** Resolves when the operator answers. Set only while `awaiting_human`. */
  resume: ((facts: GuardContext) => void) | null
  failure: string | null
}

export class Scheduler {
  readonly #options: SchedulerOptions
  readonly #states = new Map<string, NodeState>()
  readonly #order: string[]
  readonly #freeLanes: string[]
  #waves = new Map<string, number>()
  #waiters: (() => void)[] = []
  #iterations = 0

  constructor(options: SchedulerOptions) {
    this.#options = options
    const { workflow } = options

    for (const node of workflow.nodes) {
      const pipelineId = node.pipeline ?? workflow.defaults.pipeline
      const pipeline = pipelineFor(workflow, pipelineId)
      if (pipeline === undefined) {
        throw new Error(`node "${node.id}": unknown pipeline "${pipelineId}"`)
      }
      this.#states.set(node.id, {
        node,
        pipeline,
        status: 'pending',
        live: null,
        pending: [],
        pauseRequested: false,
        aborted: false,
        parkedEffectId: null,
        fixRounds: 0,
        lane: null,
        laneLease: null,
        gateLease: null,
        gateHeld: [],
        resume: null,
        failure: null,
      })
    }
    this.#order = workflow.nodes.map((node) => node.id)

    // One name per lane slot, matching `LanePool`'s own naming so a real pool
    // hands back the same worktrees. The pool guarantees at most this many
    // holders, so the free list can never run dry.
    this.#freeLanes = Array.from(
      { length: options.pools.capacity(LANE) },
      (_, i) => `${options.runId}-lane-${i + 1}`,
    )
  }

  /**
   * Runs the DAG to completion. Resolves when every node has settled, or when
   * the run stopped on something no amount of waiting can fix.
   */
  async run(): Promise<RunReport> {
    const unrunnable = this.#precheck()
    if (unrunnable) return this.#report(unrunnable)

    this.#waves = computeWaves(this.#options.workflow.nodes)

    let stop: RunStop | null = null
    while (true) {
      this.#iterations += 1
      this.#dispatchReady()
      if (this.#settled()) break

      const deadlocked = this.#deadlock()
      if (deadlocked) {
        stop = deadlocked
        break
      }
      await this.#changed()
    }

    this.#options.journal.append({
      runId: this.#options.runId,
      type: 'run_ended',
      payload: { status: stop === null && this.#failures().length === 0 ? 'done' : 'failed' },
    })
    return this.#report(stop)
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

    const live = state.live
    if (live !== null && live.adapter.capabilities.interrupt) await live.session.interrupt()
    state.pending.push({ op: 'redirect', text: instruction })
    this.#operation(state, 'redirect', instruction, 'queued')
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
      // Synchronously, before the first await inside `#runNode`, so the loop
      // never sees a dispatched node as idle.
      this.#setStatus(state, 'running')
      void this.#runNode(state)
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
      [...this.#states.values()].map((state) => this.#harnessOf(state.node)),
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
      // All-or-nothing, canonical order, one call: the lane and nothing else.
      // Gate pools are acquired later, while this lane is still held, which is
      // the §6 rule that an idle lane is just disk.
      state.laneLease = await this.#options.pools.acquire([LANE])
      state.lane = this.#freeLanes.pop() as string
      this.#options.journal.acquireLease(LANE, state.node.id)
      this.#assign(state, { lane: state.lane })

      try {
        const settled = await this.#drive(state)
        this.#release(state)
        if (settled.outcome === 'done') this.#setStatus(state, 'done')
        else this.#fail(state, `pipeline ended in state "${settled.state}"`)
        return
      } catch (error) {
        // Everything the node holds goes back before it waits — §6.1's rule,
        // and the reason `admit` hands back a wait rather than performing one.
        this.#release(state)

        // Already failed, already contained: unwinding is all that is left.
        if (error instanceof Aborted) return

        if (error instanceof CapacityRetry) {
          this.#setStatus(state, 'waiting_on_capacity')
          await error.waitFor()
          if (state.aborted) return
          this.#setStatus(state, 'running')
          continue
        }
        this.#fail(state, error instanceof Error ? error.message : 'node failed')
        return
      }
    }
  }

  /**
   * Drives one node's pipeline from `start` to a final state, parking it on
   * `await_human` and feeding `fix_rounds` back in on every step.
   */
  async #drive(state: NodeState): Promise<{ outcome: 'done' | 'failed'; state: string }> {
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
        return { outcome: this.#outcomeOf(state, result.state), state: result.state }
      }
      if (result.kind === 'stuck') throw new Error(result.reason)

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
   */
  #withPending(state: NodeState, run: PipelineRun, facts: GuardContext): GuardContext {
    if (state.pending.length === 0) return facts
    const queued = state.pending.splice(0)
    for (const entry of queued) this.#operation(state, entry.op, entry.text, 'delivered')
    const text = queued.map((entry) => entry.text).join('\n')
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
        if (verb === 'spawn_agent') return await this.#spawn(state, invocation)
        if (verb === 'run_gate') await this.#acquireGate(state, invocation)
        // The question is journalled before the host executor runs, because
        // the host executor is what raises the notification: the record of the
        // pause exists first, so a restart reads it instead of re-asking.
        if (verb === 'await_human') {
          this.#ask(state, invocation.effect.id, questionOf(invocation.effect.params))
        }
        return await this.#options.executor.execute(invocation)
      },
    }
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
    const { workflow, runId, journal, admission } = this.#options
    const adapter = this.#adapter(this.#harnessOf(state.node, params['harness']))

    const task: AgentTask = {
      nodeId: state.node.id,
      cwd: join(this.#options.laneRoot, state.lane as string),
      // A *reference* to the phase brief, never composed prompt text: prompt
      // composition is its own unit, and this field is task input the moment
      // one exists.
      prompt: state.node.prompt_ref,
      model: String(params['model'] ?? state.node.model ?? workflow.defaults.model),
    }

    const outcome = await admission.admit(adapter, task)
    if (outcome.status === 'failed') throw new SpawnFatal(outcome.message)
    if (outcome.status === 'retry') throw new CapacityRetry(outcome.wait)

    // The registry: exactly as long-lived as the turn it points at, so a §9
    // operation can never reach a session whose stream has already ended.
    state.live = { session: outcome.session, adapter }
    try {
      for await (const event of outcome.session.events) {
        journal.appendTranscript(runId, state.node.id, event)
        if (event.type === 'session_started') {
          this.#assign(state, { session_id: event.sessionId })
        }
      }
    } finally {
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
   * The gate's pools, acquired while the node still holds its lane. One call,
   * so the set is taken whole and in the pool's canonical order.
   */
  async #acquireGate(state: NodeState, invocation: EffectInvocation): Promise<void> {
    if (state.gateLease !== null) return
    const needs = this.#gateNeeds(state.node, invocation.effect.params['gate'])
    if (needs.length === 0) return

    state.gateLease = await this.#options.pools.acquire(needs)
    state.gateHeld = needs
    for (const resource of needs) this.#options.journal.acquireLease(resource, state.node.id)
  }

  /** The pools a `run_gate` needs: one named gate's, or every gate the node declared. */
  #gateNeeds(node: Node, named: unknown): string[] {
    const ids = typeof named === 'string' ? [named] : node.gates
    const needs = new Set<string>()
    for (const id of ids) {
      for (const resource of this.#options.workflow.gates[id]?.requires ?? []) needs.add(resource)
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
    for (const resource of state.gateHeld) {
      this.#options.journal.releaseLease(resource, state.node.id)
    }
    state.gateHeld = []
  }

  #release(state: NodeState): void {
    this.#releaseGate(state)
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
    this.#setStatus(state, 'failed')
    for (const id of transitiveDependents(this.#options.workflow.nodes, state.node.id)) {
      const dependent = this.#states.get(id)
      // Only nodes that have not started: one already in flight finishes.
      if (dependent?.status === 'pending') this.#setStatus(dependent, 'blocked')
    }
  }

  #setStatus(state: NodeState, status: NodeStatus): void {
    state.status = status
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId: state.node.id,
      type: 'node_status',
      payload: { status },
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

  #harnessOf(node: Node, override?: unknown): string {
    if (typeof override === 'string') return override
    return node.harness ?? this.#options.workflow.defaults.harness
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
