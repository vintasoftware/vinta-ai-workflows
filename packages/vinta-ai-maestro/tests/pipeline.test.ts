/**
 * The pipeline unit, driven wherever possible by the *real* `standard-phase`
 * machine from the golden workflow — a hand-written pipeline in a test would
 * prove the interpreter handles the pipeline the test author imagined.
 *
 * Two behaviours have no expression in that fixture (it declares no
 * `await_human` and no dead-end state), so those get purpose-built pipelines,
 * parsed through `PipelineSchema` so they are real pipelines and not just
 * object literals shaped like one.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { PipelineSchema, WorkflowSchema, type Pipeline } from '../src/types.ts'
import {
  GuardError,
  createPipelineRun,
  createRecordingExecutor,
  evaluateGuardExpression,
  type EffectOutcome,
  type GuardContext,
  type RecordedEffect,
} from '../src/pipeline/index.ts'

const fixturePath = new URL('./fixtures/golden-workflow.json', import.meta.url)
const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')))
const standardPhase = workflow.pipelines['standard-phase'] as Pipeline

/** p1's context: `max_fix_rounds` defaults to 2, which is what the guards read. */
const p1Context: GuardContext = {
  node: { max_fix_rounds: 2 },
  run: { id: 'run-1' },
  fix_rounds: 0,
}

function verbs(calls: readonly RecordedEffect[]): string[] {
  return calls.map((call) => call.definitionId)
}

function run(outcomes: Record<string, EffectOutcome | readonly EffectOutcome[]> = {}) {
  const executor = createRecordingExecutor(outcomes)
  return { executor, pipeline: createPipelineRun({ pipeline: standardPhase, executor, context: p1Context }) }
}

// ---------------------------------------------------------------------------
// 1–4: the four paths through standard-phase
// ---------------------------------------------------------------------------

describe('standard-phase', () => {
  it('runs the happy path implement → review → gate → integrate → done', async () => {
    const { executor, pipeline } = run()

    expect(await pipeline.start()).toEqual({ kind: 'entered', state: 'implement' })
    expect(await pipeline.send({})).toMatchObject({ state: 'review', via: 't-implemented' })
    expect(await pipeline.send({ facts: { review: { verdict: 'pass' } } })).toMatchObject({
      state: 'gate',
      via: 't-review-pass',
    })
    expect(await pipeline.send({ facts: { gate: { exit_code: 0 } } })).toMatchObject({
      state: 'integrate',
      via: 't-gate-pass',
    })
    expect(await pipeline.send({})).toEqual({
      kind: 'final',
      state: 'done',
      via: 't-integrated',
    })

    expect(pipeline.status).toBe('final')
    // The fixture declares exactly two effects on this path: the reviewer spawn
    // on `t-implemented` and the merge on entering `integrate`.
    expect(verbs(executor.calls)).toEqual(['spawn_agent', 'git_merge'])
    expect(executor.calls.map((call) => call.origin)).toEqual([
      { kind: 'transition', transitionId: 't-implemented' },
      { kind: 'onEnter', stateId: 'integrate' },
    ])
  })

  it('loops review(fail) → fix → review(pass) → … → done', async () => {
    const { executor, pipeline } = run()

    await pipeline.start()
    await pipeline.send({})
    expect(await pipeline.send({ facts: { review: { verdict: 'fail' } } })).toMatchObject({
      state: 'fix',
      via: 't-review-fail',
    })
    // The host owns the counter; entering fix a first time makes it 1 of 2.
    expect(await pipeline.send({ facts: { fix_rounds: 1 } })).toMatchObject({
      state: 'review',
      via: 't-fix-retry',
    })
    await pipeline.send({ facts: { review: { verdict: 'pass' } } })
    await pipeline.send({ facts: { gate: { exit_code: 0 } } })
    expect(await pipeline.send({})).toMatchObject({ kind: 'final', state: 'done' })

    // The reviewer is spawned once per entry into review.
    expect(verbs(executor.calls)).toEqual(['spawn_agent', 'git_merge'])
  })

  it('routes a non-zero gate through fix and back', async () => {
    const { pipeline } = run()

    await pipeline.start()
    await pipeline.send({})
    await pipeline.send({ facts: { review: { verdict: 'pass' } } })
    expect(await pipeline.send({ facts: { gate: { exit_code: 1 } } })).toMatchObject({
      state: 'fix',
      via: 't-gate-fail',
    })
    await pipeline.send({ facts: { fix_rounds: 1 } })
    expect(pipeline.state).toBe('review')
    await pipeline.send({ facts: { review: { verdict: 'pass' } } })
    await pipeline.send({ facts: { gate: { exit_code: 0 } } })
    expect(await pipeline.send({})).toMatchObject({ kind: 'final', state: 'done' })
  })

  it('ends in failed once fix rounds are exhausted', async () => {
    const { pipeline } = run()

    await pipeline.start()
    await pipeline.send({})
    await pipeline.send({ facts: { review: { verdict: 'fail' } } })
    expect(pipeline.state).toBe('fix')

    // `fix_rounds >= node.max_fix_rounds` is what ends it.
    expect(await pipeline.send({ facts: { fix_rounds: 2 } })).toEqual({
      kind: 'final',
      state: 'failed',
      via: 't-fix-exhausted',
    })
    expect(pipeline.status).toBe('final')
  })

  it('respects a node overriding max_fix_rounds', async () => {
    const p4 = workflow.nodes.find((node) => node.id === 'p4')
    expect(p4?.max_fix_rounds).toBe(3)

    const executor = createRecordingExecutor()
    const pipeline = createPipelineRun({
      pipeline: standardPhase,
      executor,
      context: { node: { max_fix_rounds: 3 }, fix_rounds: 2 },
    })
    await pipeline.start()
    await pipeline.send({})
    await pipeline.send({ facts: { review: { verdict: 'fail' } } })
    // 2 < 3, so p4 still gets another round where p1 would have failed.
    expect(await pipeline.send({})).toMatchObject({ state: 'review', via: 't-fix-retry' })
  })
})

// ---------------------------------------------------------------------------
// 5: await_human
// ---------------------------------------------------------------------------

const askPipeline = PipelineSchema.parse({
  states: [
    {
      id: 'ask',
      name: 'Ask',
      position: { x: 0, y: 0 },
      onEnter: [
        { id: 'e-ask', definitionId: 'await_human', params: { reason: 'merge-conflict' } },
        { id: 'e-after', definitionId: 'notify', params: { channel: 'os', text: 'answered' } },
      ],
    },
    { id: 'shipped', name: 'Shipped', position: { x: 200, y: 0 } },
    { id: 'held', name: 'Held', position: { x: 200, y: 120 } },
  ],
  transitions: [
    { id: 't-ship', from: 'ask', to: 'shipped', guard: "human.answer == 'ship'" },
    { id: 't-hold', from: 'ask', to: 'held', guard: "human.answer == 'hold'" },
  ],
  initialStateIds: ['ask'],
  finalStateIds: ['shipped', 'held'],
})

describe('await_human', () => {
  it('suspends, then the answer selects the transition', async () => {
    const executor = createRecordingExecutor()
    const pipeline = createPipelineRun({ pipeline: askPipeline, executor })

    expect(await pipeline.start()).toEqual({
      kind: 'suspended',
      state: 'ask',
      effectId: 'e-ask',
    })
    expect(pipeline.status).toBe('awaiting_human')
    // Effects queued behind the question wait for the answer.
    expect(verbs(executor.calls)).toEqual(['await_human'])

    expect(await pipeline.resume({ human: { answer: 'ship' } })).toEqual({
      kind: 'entered',
      state: 'ask',
    })
    expect(verbs(executor.calls)).toEqual(['await_human', 'notify'])
    expect(pipeline.context.human).toEqual({ answer: 'ship' })

    expect(await pipeline.send({})).toEqual({ kind: 'final', state: 'shipped', via: 't-ship' })
  })

  it('takes the other branch for the other answer', async () => {
    const pipeline = createPipelineRun({ pipeline: askPipeline, executor: createRecordingExecutor() })
    await pipeline.start()
    await pipeline.resume({ human: { answer: 'hold' } })
    expect(await pipeline.send({})).toMatchObject({ kind: 'final', state: 'held' })
  })

  it('refuses a send while suspended and a resume while running', async () => {
    const pipeline = createPipelineRun({ pipeline: askPipeline, executor: createRecordingExecutor() })
    await pipeline.start()
    await expect(pipeline.send({})).rejects.toThrow(/awaiting_human/)
    await pipeline.resume({ human: { answer: 'ship' } })
    await expect(pipeline.resume({})).rejects.toThrow(/cannot resume/)
  })
})

// ---------------------------------------------------------------------------
// 6: the guard evaluator
// ---------------------------------------------------------------------------

describe('guard evaluator', () => {
  const context: GuardContext = {
    review: { verdict: 'pass', blocking: 0 },
    gate: { exit_code: 0 },
    human: { answer: 'ship' },
    node: { max_fix_rounds: 2, harness: 'claude-code' },
    run: { id: 'run-1', dry: false },
    fix_rounds: 1,
  }
  const check = (expression: string): boolean => evaluateGuardExpression(expression, context)

  it('evaluates every operator', () => {
    expect(check("review.verdict == 'pass'")).toBe(true)
    expect(check("review.verdict == 'fail'")).toBe(false)
    expect(check("review.verdict != 'fail'")).toBe(true)
    expect(check('gate.exit_code == 0')).toBe(true)
    expect(check('gate.exit_code != 0')).toBe(false)
    expect(check('fix_rounds < node.max_fix_rounds')).toBe(true)
    expect(check('fix_rounds >= node.max_fix_rounds')).toBe(false)
    expect(check('fix_rounds <= 1')).toBe(true)
    expect(check('fix_rounds > 0')).toBe(true)
    expect(check('run.dry == false')).toBe(true)
    expect(check('review.blocking == null')).toBe(false)
  })

  it('evaluates every context path', () => {
    expect(check("human.answer == 'ship'")).toBe(true)
    expect(check("node.harness == 'claude-code'")).toBe(true)
    expect(check("run.id == 'run-1'")).toBe(true)
  })

  it('combines with && || ! and parentheses', () => {
    expect(check("review.verdict == 'pass' && gate.exit_code == 0")).toBe(true)
    expect(check("review.verdict == 'fail' || gate.exit_code == 0")).toBe(true)
    expect(check("review.verdict == 'fail' && gate.exit_code == 0")).toBe(false)
    expect(check("!review.verdict == 'fail'")).toBe(true)
    expect(check("(review.verdict == 'fail' || fix_rounds > 0) && gate.exit_code == 0")).toBe(true)
    expect(check('!(fix_rounds > 0)')).toBe(false)
  })

  it('treats a missing fact as "no transition", for == and != alike', () => {
    expect(evaluateGuardExpression("review.verdict == 'pass'", {})).toBe(false)
    expect(evaluateGuardExpression("review.verdict != 'pass'", {})).toBe(false)
    expect(evaluateGuardExpression('gate.exit_code != 0', {})).toBe(false)
    expect(evaluateGuardExpression('gate.missing == 0', context)).toBe(false)
  })

  // --- host access -------------------------------------------------------

  it('cannot reach host scope', () => {
    for (const attempt of [
      'process.exit(1)',
      "constructor.constructor('return process')()",
      'globalThis',
      "require('node:fs')",
      'this.constructor',
      'import.meta',
    ]) {
      expect(() => check(attempt), attempt).toThrow(GuardError)
    }
    // The guard strings above are inert data: nothing ran.
    expect(process.exitCode).toBeUndefined()
  })

  it('cannot walk a prototype chain', () => {
    // `node` exists and is allowlisted, so this is the interesting case: the
    // lookup is own-property only, so `constructor` resolves to nothing rather
    // than to `Function`.
    expect(check('node.constructor == 0')).toBe(false)
    expect(check("node.constructor.constructor == 'x'")).toBe(false)
    expect(check("node.__proto__ == 'x'")).toBe(false)
  })

  it('cannot read a global the host defined', () => {
    const canary = '__vintaAiMaestroGuardCanary'
    ;(globalThis as Record<string, unknown>)[canary] = 'leaked'
    try {
      expect(() => check(`${canary} == 'leaked'`)).toThrow(/unknown guard context root/)
    } finally {
      delete (globalThis as Record<string, unknown>)[canary]
    }
  })

  // --- located errors ----------------------------------------------------

  it('reports an unparseable guard with a location, never a default', () => {
    const cases: readonly [string, number][] = [
      ['review.verdict ==', 17],
      ['review.verdict @ 1', 15],
      ["review.verdict == 'pass", 18],
      ["(review.verdict == 'pass'", 25],
      ["review.verdict == 'pass' &&", 27],
    ]
    for (const [expression, offset] of cases) {
      let thrown: unknown
      try {
        check(expression)
      } catch (error) {
        thrown = error
      }
      expect(thrown, expression).toBeInstanceOf(GuardError)
      const error = thrown as GuardError
      expect(error.expression).toBe(expression)
      expect(error.offset, expression).toBe(offset)
      expect(error.message).toContain('at offset')
    }
  })

  it('rejects a guard that is not a boolean, and a comparison that is not numeric', () => {
    expect(() => check('run.id')).toThrow(/must evaluate to a boolean/)
    expect(() => check("review.verdict < 'x'")).toThrow(/needs numbers on both sides/)
    expect(() => check("review.verdict && gate.exit_code == 0")).toThrow(/expected a boolean/)
  })

  it('rejects a bad guard when the run is constructed, not mid-flight', () => {
    const broken = PipelineSchema.parse({
      states: [
        { id: 'a', name: 'A', position: { x: 0, y: 0 } },
        { id: 'b', name: 'B', position: { x: 1, y: 0 } },
      ],
      transitions: [{ id: 't-bad', from: 'a', to: 'b', guard: 'process.exit(1)' }],
      initialStateIds: ['a'],
      finalStateIds: ['b'],
    })
    expect(() =>
      createPipelineRun({ pipeline: broken, executor: createRecordingExecutor() }),
    ).toThrow(/transition "t-bad": unknown guard context root "process"/)
  })
})

// ---------------------------------------------------------------------------
// 7: stuck detection
// ---------------------------------------------------------------------------

describe('stuck detection', () => {
  it('reports being stuck when no transition matches', async () => {
    const { pipeline } = run()
    await pipeline.start()
    await pipeline.send({})
    expect(pipeline.state).toBe('review')

    // Both guards out of `review` read `review.verdict`, and nothing has set it.
    const result = await pipeline.send({})
    expect(result).toEqual({
      kind: 'stuck',
      state: 'review',
      reason: 'no transition out of "review" matched',
    })
    expect(pipeline.status).toBe('stuck')
    // And it stays reported rather than being re-asked into a loop.
    await expect(pipeline.send({})).rejects.toThrow(/status is "stuck"/)
  })

  it('names the trigger when one was delivered', async () => {
    const { pipeline } = run()
    await pipeline.start()
    await pipeline.send({})
    expect(await pipeline.send({ trigger: 'reviewed' })).toMatchObject({
      reason: 'no transition out of "review" matched trigger "reviewed"',
    })
  })

  it('reports a non-final dead-end state on arrival', async () => {
    const deadEnd = PipelineSchema.parse({
      states: [
        { id: 'start', name: 'Start', position: { x: 0, y: 0 } },
        { id: 'nowhere', name: 'Nowhere', position: { x: 1, y: 0 } },
      ],
      transitions: [{ id: 't-go', from: 'start', to: 'nowhere' }],
      initialStateIds: ['start'],
      finalStateIds: [],
    })
    const pipeline = createPipelineRun({ pipeline: deadEnd, executor: createRecordingExecutor() })
    await pipeline.start()
    expect(await pipeline.send({})).toEqual({
      kind: 'stuck',
      state: 'nowhere',
      reason: 'state "nowhere" is not final and has no outgoing transitions',
    })
  })
})

// ---------------------------------------------------------------------------
// 8: params and the passthrough blob
// ---------------------------------------------------------------------------

describe('effect invocation', () => {
  it('passes the declared params through verbatim', async () => {
    const { executor, pipeline } = run()
    await pipeline.start()
    await pipeline.send({})
    await pipeline.send({ facts: { review: { verdict: 'pass' } } })
    await pipeline.send({ facts: { gate: { exit_code: 0 } } })

    expect(executor.calls.map((call) => call.params)).toEqual([
      { role: 'reviewer' },
      { strategy: '--no-ff' },
    ])
    expect(executor.calls.map((call) => call.effectId)).toEqual(['e-review', 'merge'])
  })

  it('shows the executor the context as of the invocation', async () => {
    const seen: GuardContext[] = []
    const executor = {
      async execute(invocation: { context: GuardContext }): Promise<EffectOutcome> {
        seen.push(invocation.context)
        return {}
      },
    }
    const pipeline = createPipelineRun({ pipeline: standardPhase, executor, context: p1Context })
    await pipeline.start()
    await pipeline.send({})
    await pipeline.send({ facts: { review: { verdict: 'pass' } } })
    await pipeline.send({ facts: { gate: { exit_code: 0 } } })

    expect(seen[0]?.review).toBeUndefined()
    expect(seen[1]?.gate).toEqual({ exit_code: 0 })
  })

  it('merges facts an effect reports before the next guard runs', async () => {
    // A reviewer effect that reports its own verdict — the executor is where a
    // real harness result would come from.
    const { executor, pipeline } = run({ 'e-review': { facts: { review: { verdict: 'pass' } } } })
    await pipeline.start()
    await pipeline.send({})
    expect(pipeline.context.review).toEqual({ verdict: 'pass' })
    // No extra facts needed now: the effect already supplied them.
    expect(await pipeline.send({})).toMatchObject({ state: 'gate', via: 't-review-pass' })
    expect(verbs(executor.calls)).toEqual(['spawn_agent'])
  })

  it('never interprets a data passthrough blob', async () => {
    // Same pipeline, with hostile-looking `data` on a state, a transition and
    // an effect. `data` is host-owned passthrough: it must not add effects, and
    // it must not be mistaken for a guard.
    const withData = PipelineSchema.parse({
      ...JSON.parse(JSON.stringify(standardPhase)),
      states: JSON.parse(JSON.stringify(standardPhase.states)).map((state: { id: string }) =>
        state.id === 'integrate'
          ? {
              ...state,
              data: {
                onEnter: [{ id: 'ghost', definitionId: 'git_push', params: {} }],
                guard: 'process.exit(1)',
              },
            }
          : state,
      ),
      transitions: JSON.parse(JSON.stringify(standardPhase.transitions)).map(
        (transition: { id: string }) =>
          transition.id === 't-review-pass'
            ? { ...transition, data: { guard: "review.verdict == 'nope'", effects: ['open_pr'] } }
            : transition,
      ),
    })

    const executor = createRecordingExecutor()
    const pipeline = createPipelineRun({ pipeline: withData, executor, context: p1Context })
    await pipeline.start()
    await pipeline.send({})
    await pipeline.send({ facts: { review: { verdict: 'pass' } } })
    await pipeline.send({ facts: { gate: { exit_code: 0 } } })
    expect(await pipeline.send({})).toMatchObject({ kind: 'final', state: 'done' })

    // Identical to the happy path: the blob changed nothing.
    expect(verbs(executor.calls)).toEqual(['spawn_agent', 'git_merge'])
  })

  it('skips a disabled effect', async () => {
    const disabled = PipelineSchema.parse({
      states: [
        {
          id: 'a',
          name: 'A',
          position: { x: 0, y: 0 },
          onEnter: [
            { id: 'off', definitionId: 'notify', params: {}, enabled: false },
            { id: 'on', definitionId: 'notify', params: {} },
          ],
        },
      ],
      transitions: [],
      initialStateIds: ['a'],
      finalStateIds: ['a'],
    })
    const executor = createRecordingExecutor()
    await createPipelineRun({ pipeline: disabled, executor }).start()
    expect(executor.calls.map((call) => call.effectId)).toEqual(['on'])
  })
})

// ---------------------------------------------------------------------------
// Transition selection
// ---------------------------------------------------------------------------

describe('transition selection', () => {
  const ambiguous = PipelineSchema.parse({
    states: [
      { id: 'a', name: 'A', position: { x: 0, y: 0 } },
      { id: 'catch-all', name: 'Catch all', position: { x: 1, y: 0 } },
      { id: 'guarded', name: 'Guarded', position: { x: 2, y: 0 } },
      { id: 'triggered', name: 'Triggered', position: { x: 3, y: 0 } },
      { id: 'first', name: 'First', position: { x: 4, y: 0 } },
    ],
    transitions: [
      { id: 't-catch-all', from: 'a', to: 'catch-all' },
      { id: 't-guarded', from: 'a', to: 'guarded', guard: 'fix_rounds == 0' },
      { id: 't-guarded-2', from: 'a', to: 'first', guard: 'fix_rounds == 0' },
      { id: 't-triggered', from: 'a', to: 'triggered', trigger: 'go' },
    ],
    initialStateIds: ['a'],
    finalStateIds: ['catch-all', 'guarded', 'triggered', 'first'],
  })

  const start = async (event: { trigger?: string }) => {
    const pipeline = createPipelineRun({
      pipeline: ambiguous,
      executor: createRecordingExecutor(),
      context: { fix_rounds: 0 },
    })
    await pipeline.start()
    return await pipeline.send(event)
  }

  it('prefers a triggered transition over an untriggered one', async () => {
    expect(await start({ trigger: 'go' })).toMatchObject({ state: 'triggered' })
  })

  it('prefers a guarded transition over a catch-all', async () => {
    expect(await start({})).toMatchObject({ state: 'guarded' })
  })

  it('breaks a remaining tie by declaration order', async () => {
    // `t-guarded` and `t-guarded-2` are equally specific and both pass; the one
    // declared first wins, on every run.
    for (let i = 0; i < 5; i += 1) {
      expect(await start({})).toMatchObject({ via: 't-guarded' })
    }
  })

  it('does not match a triggered transition on an untriggered event', async () => {
    const pipeline = createPipelineRun({
      pipeline: PipelineSchema.parse({
        states: [
          { id: 'a', name: 'A', position: { x: 0, y: 0 } },
          { id: 'b', name: 'B', position: { x: 1, y: 0 } },
        ],
        transitions: [{ id: 't', from: 'a', to: 'b', trigger: 'go' }],
        initialStateIds: ['a'],
        finalStateIds: ['b'],
      }),
      executor: createRecordingExecutor(),
    })
    await pipeline.start()
    expect(await pipeline.send({})).toMatchObject({ kind: 'stuck' })
  })
})

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('construction', () => {
  it('rejects a transition naming a state that does not exist', () => {
    const broken = PipelineSchema.parse({
      states: [{ id: 'a', name: 'A', position: { x: 0, y: 0 } }],
      transitions: [{ id: 't', from: 'a', to: 'ghost' }],
      initialStateIds: ['a'],
      finalStateIds: [],
    })
    expect(() => createPipelineRun({ pipeline: broken, executor: createRecordingExecutor() })).toThrow(
      /unknown state "ghost"/,
    )
  })

  it('refuses to start twice', async () => {
    const { pipeline } = run()
    await pipeline.start()
    await expect(pipeline.start()).rejects.toThrow(/already started/)
  })
})
