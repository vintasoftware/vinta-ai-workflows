/**
 * The invariants every harness adapter must satisfy, as a suite any adapter's
 * test file runs against itself.
 *
 * The scheduler, the pipeline interpreter and the UI are written against
 * `HarnessAdapter`, not against `claude-code`. That only holds if the three
 * real adapters agree on the behavior the type cannot express: that a stream
 * terminates exactly once, that `kill` twice is not an error, that a refusal
 * is returned rather than thrown, that a declared capability is a promise the
 * adapter keeps. Left to each adapter's own test file, those would be three
 * different readings of §7 — which is the bug this suite exists to prevent.
 *
 * **It lives in `src/` rather than `tests/helpers/`** because adapters live in
 * `src/harness/` and this is part of the contract they implement, not part of
 * this package's test suite: an out-of-tree adapter should be able to import
 * it. It takes vitest's `describe`/`it`/`expect` as arguments so that shipping
 * it does not drag a devDependency into the runtime graph, and so the three
 * functions are the only coupling to a test framework at all.
 */
import {
  type AgentEvent,
  type AgentSession,
  type AgentTask,
  HarnessCapabilityError,
  type HarnessAdapter,
  type SpawnRefusalKind,
} from './adapter.ts'

/** The slice of vitest this suite uses. Narrow on purpose — it is the whole coupling. */
export interface ContractRunner {
  readonly describe: (name: string, fn: () => void) => void
  /**
   * `timeoutMs` is the outer per-test budget, and is optional so a runner that
   * has no such notion still satisfies this type. vitest's `it` takes it as its
   * third argument, which is why passing vitest's `it` directly is enough: the
   * suite's own deadlines then fire before the framework's default does, and a
   * hang is reported as the await that hung rather than as a generic timeout.
   */
  readonly it: (name: string, fn: () => Promise<void>, timeoutMs?: number) => void
  readonly expect: (actual: unknown) => {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
  }
}

/**
 * What an adapter must provide to be tested. A fresh one is built per test, so
 * no assertion can be contaminated by a session another one left running.
 */
export interface AdapterContractFixture {
  readonly adapter: HarnessAdapter
  /**
   * A task the adapter can actually run, long enough to emit at least two
   * events before it ends — the interrupt assertion needs a stream that is
   * still going when the interrupt lands.
   */
  readonly task: AgentTask
  /**
   * Make the next `spawn` refuse with this kind. Real adapters implement it
   * with a fault-injection seam: a vendor cannot be asked for a rate limit on
   * demand, and an untested refusal path is one that first runs in production
   * at hour three of a run.
   */
  forceRefusal(kind: SpawnRefusalKind): void
  /**
   * A task carrying a `resumeSessionId` the vendor does not have — an id it
   * never issued, or one it has since pruned (§15.4).
   *
   * Optional, and skipped when absent, because not every fixture can produce
   * one: a double that resumes whatever id it is handed has no forgotten
   * sessions to offer. Where a fixture *can*, this is the assertion that makes
   * session reuse survivable — the classification is a per-vendor pattern
   * table, and a table nothing exercises is a table that matches nothing.
   */
  readonly staleResumeTask?: AgentTask
  dispose?(): Promise<void>
  /**
   * How long any single await in this suite may take before it is called a
   * hang. Optional: the default suits a mock and a fast local CLI, and an
   * adapter whose live turn is a network round trip raises it for itself rather
   * than making every other adapter pay for the slowest one.
   */
  readonly hangMs?: number
}

/** Per-await deadline when a fixture does not raise it. */
const DEFAULT_HANG_MS = 5_000

/**
 * The outer per-test budget. Every await in this suite is already bounded by
 * `within`, so this is only a backstop — but it has to sit above any fixture's
 * own deadline, because a framework default firing first (vitest's is five
 * seconds) replaces "the event stream did not settle" with a generic timeout
 * that names nothing.
 */
const TEST_TIMEOUT_MS = 120_000

/** One await, deadlined. Fails loudly instead of hanging the suite. */
type Within = <T>(what: string, work: Promise<T>) => Promise<T>

const deadlined =
  (hangMs: number): Within =>
  async <T>(what: string, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`contract: ${what} did not settle`)), hangMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

const drain = async (iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for (;;) {
    const step = await iterator.next()
    if (step.done === true) return seen
    seen.push(step.value)
  }
}

const iterate = (session: AgentSession): AsyncIterator<AgentEvent> =>
  session.events[Symbol.asyncIterator]()

/**
 * The session id a takeover is handed. It is a *literal* here on purpose: §9
 * makes the id the handoff token, so the assertion worth making is that the
 * exact string given to `attachPty` comes back on the handle — an adapter that
 * minted its own would silently start a second session and lose the run.
 */
const PTY_SESSION = 'contract-pty-session'

/** `kill(pid, 0)` signals nothing and answers one question: is that pid still there. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function runAdapterContract(
  name: string,
  runner: ContractRunner,
  makeFixture: () => AdapterContractFixture | Promise<AdapterContractFixture>,
): void {
  const { describe, expect } = runner

  const test = (
    title: string,
    body: (fixture: AdapterContractFixture, within: Within) => Promise<void>,
  ): void => {
    runner.it(
      title,
      async () => {
        const fixture = await makeFixture()
        try {
          await body(fixture, deadlined(fixture.hangMs ?? DEFAULT_HANG_MS))
        } finally {
          await fixture.dispose?.()
        }
      },
      TEST_TIMEOUT_MS,
    )
  }

  const start = async (fixture: AdapterContractFixture, within: Within): Promise<AgentSession> => {
    const outcome = await within('spawn', fixture.adapter.spawn(fixture.task))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('contract: spawn refused where it was expected to succeed')
    return outcome.session
  }

  describe(`harness adapter contract: ${name}`, () => {
    test('preflight reports installation and login without throwing', async (fixture, within) => {
      const result = await within('preflight', fixture.adapter.preflight())
      expect(typeof result.installed).toBe('boolean')
      expect(typeof result.authenticated).toBe('boolean')
    })

    test('the stream is framed by exactly one start and one end', async (fixture, within) => {
      const session = await start(fixture, within)
      const events = await within('event stream', drain(iterate(session)))

      const opening = events[0]
      expect(events.length > 1).toBe(true)
      expect(opening?.type).toBe('session_started')
      expect(opening?.type === 'session_started' ? opening.sessionId : undefined).toBe(session.id)
      // Terminal means terminal: the scheduler settles a node on this event,
      // so anything after it is a fact arriving for a node already reported.
      expect(events.filter((e) => e.type === 'session_started').length).toBe(1)
      expect(events.filter((e) => e.type === 'session_ended').length).toBe(1)
      expect(events[events.length - 1]?.type).toBe('session_ended')
    })

    test('interrupt ends the session promptly and says so in the terminal event', async (fixture, within) => {
      const session = await start(fixture, within)
      const iterator = iterate(session)
      await within('first event', iterator.next())

      if (!fixture.adapter.capabilities.interrupt) {
        let rejected: unknown
        await within(
          'interrupt rejection',
          session.interrupt().catch((error: unknown) => {
            rejected = error
          }),
        )
        expect(rejected instanceof HarnessCapabilityError).toBe(true)
        await within('kill', session.kill())
        await within('event stream', drain(iterator))
        return
      }

      await within('interrupt', session.interrupt())
      const rest = await within('event stream after interrupt', drain(iterator))
      const last = rest[rest.length - 1]
      expect(last?.type).toBe('session_ended')
      expect(last?.type === 'session_ended' ? last.result : undefined).toBe('interrupted')
    })

    test('kill is idempotent', async (fixture, within) => {
      const session = await start(fixture, within)
      await within('first kill', session.kill())
      await within('second kill', session.kill())
      const events = await within('event stream', drain(iterate(session)))
      expect(events.filter((e) => e.type === 'session_ended').length).toBe(1)
    })

    test('declared inject capability matches what send actually does', async (fixture, within) => {
      const session = await start(fixture, within)
      const text = 'also update the changelog'

      if (!fixture.adapter.capabilities.inject) {
        // A false capability must be loud. Silently dropping the message would
        // leave the operator watching for an effect that can never arrive.
        let rejected: unknown
        await within(
          'send rejection',
          session.send(text).catch((error: unknown) => {
            rejected = error
          }),
        )
        expect(rejected instanceof HarnessCapabilityError).toBe(true)
        await within('kill', session.kill())
        await within('event stream', drain(iterate(session)))
        return
      }

      const iterator = iterate(session)
      await within('first event', iterator.next())
      await within('send', session.send(text))
      const rest = await within('event stream after send', drain(iterator))
      // Observable in the transcript, which is this stream (§5.3, §15).
      expect(rest.some((e) => e.type === 'user_message' && e.text === text)).toBe(true)
    })

    test('operator text on the task reaches the agent whatever inject says', async (fixture, within) => {
      // The hole this closes: §9 says steering a harness that cannot inject is
      // "queued and delivered on the next resume", and a queue that stops at
      // the scheduler is steering the agent never hears. `inject` is about
      // writing into a turn already running; this is delivered at the start of
      // one, so *every* adapter owes it — including the two that can inject,
      // whose nodes can still be resumed after a capacity wait with text
      // queued from while they were down.
      //
      // Asserted through the transcript because that is the one observable
      // every harness shares: an HTTP body, a stdin pipe and a JSON line are
      // three different channels, and §5.3 makes this stream the record of
      // what the agent was actually told.
      const text = 'the operator says: keep the migration reversible'
      const outcome = await within(
        'spawn',
        fixture.adapter.spawn({ ...fixture.task, operatorText: text }),
      )
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error('contract: spawn refused where it was expected to succeed')

      const events = await within('event stream', drain(iterate(outcome.session)))
      expect(events.some((e) => e.type === 'user_message' && e.text === text)).toBe(true)
    })

    test('declared pty capability matches what attachPty does', async (fixture, within) => {
      // §9's fifth operation, held to the same rule as the other four: a
      // capability is a promise, and the operation behind a false one refuses
      // loudly rather than resolving with nothing.
      const { adapter } = fixture
      const attachPty = adapter.attachPty?.bind(adapter)
      expect(typeof attachPty).toBe('function')
      if (attachPty === undefined) return

      const attach = { cwd: fixture.task.cwd, cols: 80, rows: 24 }

      if (!adapter.capabilities.pty) {
        let rejected: unknown
        await within(
          'attachPty rejection',
          attachPty(PTY_SESSION, attach).then(
            () => {},
            (error: unknown) => {
              rejected = error
            },
          ),
        )
        expect(rejected instanceof HarnessCapabilityError).toBe(true)
        return
      }

      const handle = await within('attachPty', attachPty(PTY_SESSION, attach))
      try {
        // The handoff token, unchanged. Everything else about takeover is
        // recoverable; a session id the adapter invented is not.
        expect(handle.sessionId).toBe(PTY_SESSION)
        expect(handle.pid > 0).toBe(true)
        // Neither may throw, and neither is asserted on: what a terminal does
        // with a resize or a keystroke belongs to the program inside it.
        // Deliberately *not* asserted: nothing here reads the bytes (§11).
        handle.resize(100, 30)
        handle.write('\n')
      } finally {
        await within('detach', handle.detach())
      }
      // `detach` resolves only once the child is reaped, so this is a fact and
      // not a race — and "takeover leaves no orphan" is checkable rather than
      // hoped for.
      expect(alive(handle.pid)).toBe(false)
    })

    test('a session the vendor has forgotten is stale, not fatal', async (fixture, within) => {
      // §15.4's whole point, and the reason it is here rather than only in each
      // adapter's own file: the host answers `stale_session` with one retry on
      // a fresh session, and answers `fatal` by failing the node. An adapter
      // that reads a forgotten token as either of the kinds around it turns the
      // ordinary case of session reuse — a token that aged out — into a dead
      // run, and it does so identically for every vendor, so the invariant
      // belongs where all of them are held to it.
      const stale = fixture.staleResumeTask
      if (stale === undefined) return
      expect(fixture.adapter.capabilities.resume).toBe(true)

      const outcome = await within('spawn with a stale session', fixture.adapter.spawn(stale))
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.kind).toBe('stale_session')

      // And the same vendor wording with no token to be stale is *not* it:
      // there was nothing to expire, so whatever went wrong went wrong for
      // another reason and must keep its own classification.
      const { resumeSessionId: _dropped, ...fresh } = stale
      const cold = await within('spawn with no session', fixture.adapter.spawn(fresh))
      expect(cold.ok === false && cold.kind === 'stale_session').toBe(false)
      if (cold.ok) await within('kill', cold.session.kill())
    })

    for (const kind of [
      'rate_limit',
      'concurrency',
      'quota',
      'transient',
      'stale_session',
      'fatal',
    ] as const) {
      test(`spawn returns a ${kind} refusal instead of throwing`, async (fixture, within) => {
        fixture.forceRefusal(kind)
        const outcome = await within('spawn', fixture.adapter.spawn(fixture.task))
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.kind).toBe(kind)
        expect(typeof outcome.message === 'string' && outcome.message.length > 0).toBe(true)
        expect(outcome.retryAfter === undefined || outcome.retryAfter instanceof Date).toBe(true)
      })
    }

    test('a second consumer of events terminates instead of hanging', async (fixture, within) => {
      const session = await start(fixture, within)
      const first = iterate(session)
      await within('first event', first.next())

      // Mid-stream a second reader gets a finished stream, not a deadlock and
      // not a share of the events: two consumers splitting one stream is worse
      // than a hang, because the transcript silently loses whatever the second
      // one took.
      const stolen = await within('concurrent second iteration', drain(iterate(session)))
      expect(stolen.length).toBe(0)

      const rest = await within('first iteration', drain(first))
      expect(rest[rest.length - 1]?.type).toBe('session_ended')
      // And after completion, which is the shape a late-attaching UI takes.
      await within('iteration after completion', drain(iterate(session)))
    })
  })
}
