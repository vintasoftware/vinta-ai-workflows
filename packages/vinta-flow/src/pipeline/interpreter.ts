/**
 * The pipeline interpreter — one node's journey through one state machine.
 *
 * The machine is **externally driven**, not self-propelled. `send` is called
 * when something happened in the world (an agent finished, a gate exited, the
 * clock advanced) and the interpreter answers with where that leaves the run.
 * The alternative — a loop that keeps re-evaluating guards hoping one turns
 * true — is exactly the spinning §5.2 warns about, and it makes "stuck" an
 * unobservable condition. Here it is a return value.
 *
 * Guards are compiled at construction, so a typo in a plan is a load-time error
 * with an offset rather than a mid-run surprise three phases deep.
 *
 * `fix_rounds` is host state, not interpreter state. The interpreter cannot
 * know which state means "fix" — that is the plan author's vocabulary, and a
 * state machine that special-cased an id would stop being general. The host
 * supplies the counter through `send({ facts })`, the same channel every other
 * fact arrives on.
 */
import type { Pipeline } from '../types.ts'
import {
  type EffectExecutor,
  type EffectInvocation,
  type EffectOrigin,
} from './effects.ts'
import { type Guard, GuardError, type GuardContext, evaluateGuard, parseGuard } from './guard.ts'

// `types.ts` exports the pipeline but not its members; naming them here keeps
// the interpreter readable without touching the schema module.
type StateNode = Pipeline['states'][number]
type Transition = Pipeline['transitions'][number]

export type PipelineStatus = 'idle' | 'ready' | 'awaiting_human' | 'final' | 'stuck'

/** What the host observed. A bare `{}` means "carry on, nothing new to report". */
export interface PipelineEvent {
  /** Matches transitions whose `trigger` equals it. Untriggered ones match anything. */
  readonly trigger?: string
  /** Merged into the guard context, root key by root key, before guards run. */
  readonly facts?: GuardContext
}

export type StepResult =
  /** Settled in a non-final state; the next `send` decides what happens. */
  | { readonly kind: 'entered'; readonly state: string; readonly via?: string }
  | { readonly kind: 'final'; readonly state: string; readonly via?: string }
  /** An `await_human` effect parked the run. Call `resume` with the answer. */
  | { readonly kind: 'suspended'; readonly state: string; readonly effectId: string }
  /** The run cannot progress. `reason` says why, in author-supplied ids only. */
  | { readonly kind: 'stuck'; readonly state: string; readonly reason: string }

export interface PipelineRunOptions {
  readonly pipeline: Pipeline
  readonly executor: EffectExecutor
  /** Seed facts — typically `node.*` and `run.*`. */
  readonly context?: GuardContext
  /** Which initial state to enter. Defaults to the first declared one. */
  readonly initialStateId?: string
}

/** A queued unit of work. Arrival is queued so a suspend mid-flight is resumable. */
type Step =
  | { readonly kind: 'effect'; readonly invocation: EffectInvocation }
  | { readonly kind: 'arrive'; readonly stateId: string }

export class PipelineRun {
  readonly #executor: EffectExecutor
  readonly #states: ReadonlyMap<string, StateNode>
  readonly #outgoing: ReadonlyMap<string, readonly Transition[]>
  readonly #guards: ReadonlyMap<string, Guard>
  readonly #finals: ReadonlySet<string>
  readonly #initialStateId: string

  #context: GuardContext
  #state: string
  #status: PipelineStatus = 'idle'
  #queue: Step[] = []
  #via: string | undefined

  constructor(options: PipelineRunOptions) {
    const { pipeline, executor } = options
    this.#executor = executor
    this.#context = options.context ?? {}

    this.#states = new Map(pipeline.states.map((state) => [state.id, state]))
    this.#finals = new Set(pipeline.finalStateIds)

    const outgoing = new Map<string, Transition[]>()
    const guards = new Map<string, Guard>()
    for (const transition of pipeline.transitions) {
      for (const end of [transition.from, transition.to]) {
        if (!this.#states.has(end)) {
          throw new Error(`transition "${transition.id}" references unknown state "${end}"`)
        }
      }
      const list = outgoing.get(transition.from)
      if (list === undefined) outgoing.set(transition.from, [transition])
      else list.push(transition)

      if (transition.guard !== undefined) {
        try {
          guards.set(transition.id, parseGuard(transition.guard))
        } catch (error) {
          // Re-raise with the transition id so the plan author knows which edge
          // to fix. Transition ids are author-supplied, never repository content.
          if (!(error instanceof GuardError)) throw error
          throw new GuardError(
            `transition "${transition.id}": ${error.message.split(' (at offset')[0] as string}`,
            error.expression,
            error.offset,
          )
        }
      }
    }
    this.#outgoing = outgoing
    this.#guards = guards

    for (const finalId of pipeline.finalStateIds) {
      if (!this.#states.has(finalId)) throw new Error(`unknown final state "${finalId}"`)
    }

    const initial = options.initialStateId ?? (pipeline.initialStateIds[0] as string)
    if (!this.#states.has(initial)) throw new Error(`unknown initial state "${initial}"`)
    this.#initialStateId = initial
    this.#state = initial
  }

  get state(): string {
    return this.#state
  }

  get status(): PipelineStatus {
    return this.#status
  }

  /** A snapshot. Facts only ever enter through `send` / `resume`. */
  get context(): GuardContext {
    return this.#context
  }

  /** Enters the initial state and runs its `onEnter` effects. */
  async start(): Promise<StepResult> {
    if (this.#status !== 'idle') throw new Error('pipeline already started')
    this.#status = 'ready'
    this.#queue = [
      { kind: 'arrive', stateId: this.#initialStateId },
      ...this.#enterSteps(this.#initialStateId),
    ]
    return await this.#drain()
  }

  /**
   * Delivers an event: merges its facts, then takes the one transition that
   * matches. If none does, the run is reported stuck rather than re-asked.
   */
  async send(event: PipelineEvent): Promise<StepResult> {
    if (this.#status !== 'ready') {
      throw new Error(`cannot send while status is "${this.#status}"`)
    }
    this.#merge(event.facts)

    const transition = this.#select(event.trigger)
    if (transition === undefined) {
      return this.#stick(
        `no transition out of "${this.#state}" matched` +
          (event.trigger === undefined ? '' : ` trigger "${event.trigger}"`),
      )
    }

    this.#via = transition.id
    this.#queue = [
      ...this.#effectSteps(this.#stateOf(transition.from).onLeave, {
        kind: 'onLeave',
        stateId: transition.from,
      }),
      ...this.#effectSteps(transition.effects, {
        kind: 'transition',
        transitionId: transition.id,
      }),
      { kind: 'arrive', stateId: transition.to },
      ...this.#enterSteps(transition.to),
    ]
    return await this.#drain()
  }

  /** Supplies an `await_human` answer and continues where the run parked. */
  async resume(facts: GuardContext): Promise<StepResult> {
    if (this.#status !== 'awaiting_human') {
      throw new Error(`cannot resume while status is "${this.#status}"`)
    }
    this.#merge(facts)
    this.#status = 'ready'
    return await this.#drain()
  }

  // -------------------------------------------------------------------------

  #stateOf(id: string): StateNode {
    return this.#states.get(id) as StateNode
  }

  #enterSteps(stateId: string): Step[] {
    return this.#effectSteps(this.#stateOf(stateId).onEnter, { kind: 'onEnter', stateId })
  }

  #effectSteps(effects: StateNode['onEnter'], origin: EffectOrigin): Step[] {
    // `context` is filled in at execution time, not here: an effect earlier in
    // the queue may add the fact a later one needs to see.
    return effects
      .filter((effect) => effect.enabled)
      .map((effect) => ({
        kind: 'effect' as const,
        invocation: { effect, origin, context: this.#context },
      }))
  }

  #merge(facts: GuardContext | undefined): void {
    // Root-key replacement, not a deep merge: `{ gate: { exit_code: 0 } }` is a
    // whole new gate result, and half-overwriting the previous one would leave
    // a guard reading a field from a run that already ended.
    if (facts !== undefined) this.#context = { ...this.#context, ...facts }
  }

  /**
   * Deterministic transition choice. Candidates are the outgoing transitions
   * whose trigger matches and whose guard passes; among them the **most
   * specific** wins — a declared `trigger` beats none, then a declared `guard`
   * beats none — and declaration order breaks any remaining tie. Specificity
   * first, because a catch-all edge drawn last in the editor should not
   * silently outrank the conditional edges it was drawn to backstop.
   */
  #select(trigger: string | undefined): Transition | undefined {
    const candidates = (this.#outgoing.get(this.#state) ?? []).filter((transition) => {
      if (transition.trigger !== undefined && transition.trigger !== trigger) return false
      const guard = this.#guards.get(transition.id)
      return guard === undefined || evaluateGuard(guard, this.#context)
    })
    if (candidates.length <= 1) return candidates[0]

    const rank = (t: Transition): number =>
      (t.trigger === undefined ? 2 : 0) + (t.guard === undefined ? 1 : 0)
    // Array#sort is stable, so equal ranks keep declaration order.
    return [...candidates].sort((a, b) => rank(a) - rank(b))[0]
  }

  #stick(reason: string): StepResult {
    this.#status = 'stuck'
    return { kind: 'stuck', state: this.#state, reason }
  }

  async #drain(): Promise<StepResult> {
    while (this.#queue.length > 0) {
      const step = this.#queue.shift() as Step

      if (step.kind === 'arrive') {
        this.#state = step.stateId
        continue
      }

      const invocation: EffectInvocation = { ...step.invocation, context: this.#context }
      const outcome = await this.#executor.execute(invocation)
      this.#merge(outcome.facts)

      // `await_human` is the one catalog verb the interpreter must understand:
      // suspension is a property of the verb (§5.2), not a convention an
      // executor implementation could forget to honour. The queue keeps the
      // rest of the work, so `resume` picks up exactly where this left off.
      if (invocation.effect.definitionId === 'await_human') {
        this.#status = 'awaiting_human'
        return { kind: 'suspended', state: this.#state, effectId: invocation.effect.id }
      }
    }

    const via = this.#via
    this.#via = undefined

    if (this.#finals.has(this.#state)) {
      this.#status = 'final'
      return via === undefined
        ? { kind: 'final', state: this.#state }
        : { kind: 'final', state: this.#state, via }
    }

    // A non-final state with no way out cannot be rescued by any future event.
    // That is knowable now, so say so now rather than on the next `send`.
    if ((this.#outgoing.get(this.#state) ?? []).length === 0) {
      return this.#stick(`state "${this.#state}" is not final and has no outgoing transitions`)
    }

    this.#status = 'ready'
    return via === undefined
      ? { kind: 'entered', state: this.#state }
      : { kind: 'entered', state: this.#state, via }
  }
}

/** Convenience constructor, matching the shape the rest of the package uses. */
export function createPipelineRun(options: PipelineRunOptions): PipelineRun {
  return new PipelineRun(options)
}
