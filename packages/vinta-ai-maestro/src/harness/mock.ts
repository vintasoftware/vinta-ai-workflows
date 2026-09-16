/**
 * A scripted adapter: deterministic agent behavior for every step that needs
 * an agent but not a model.
 *
 * Steps 7 through 10 — admission control, the pipeline interpreter, the
 * scheduler — are about *orchestration*, and testing them against a real
 * harness would pay model turns to observe scheduling decisions that have
 * nothing to do with what the agent said. So this adapter plays back a fixed
 * script and lets the caller program the spawn outcomes it needs to exercise.
 *
 * The stream is **pull-driven**: an event is produced when the consumer asks
 * for one, never on a timer. That is what makes "interrupt mid-stream"
 * reproducible rather than a race — the consumer reads two events, interrupts,
 * and the next read observes the interrupt, identically on every machine.
 *
 * It impersonates a real harness id rather than inventing one, because the
 * things it exists to test key their behavior off that id: admission control
 * keeps one in-flight ceiling per harness, and a mock under its own id would
 * exercise a ceiling nothing else contends for.
 */
import {
  type AgentEvent,
  type AgentSession,
  type AgentTask,
  HarnessCapabilityError,
  type HarnessAdapter,
  type HarnessCapabilities,
  type PreflightResult,
  type PtyAttach,
  type PtyHandle,
  type SpawnOutcome,
  type SpawnRefusalKind,
} from './adapter.ts'
import { openPty } from './pty.ts'

/** The body of a run. `session_started` and `session_ended` are framed by the adapter. */
export type ScriptedEvent = Exclude<AgentEvent, { type: 'session_started' | 'session_ended' }>

export interface MockScript {
  readonly events: readonly ScriptedEvent[]
  /** How the run ends when it is left alone. An interrupt or kill overrides it. */
  readonly result: 'ok' | 'error'
}

export interface MockAdapterOptions {
  readonly id?: string
  readonly capabilities?: Partial<HarnessCapabilities>
  readonly script?: MockScript
  readonly preflight?: PreflightResult
  /**
   * Consumed one per `spawn`. A kind refuses with it; `'ok'` spawns a session.
   * Once exhausted every further spawn succeeds — a plan describes the opening
   * moves, not the whole run.
   */
  readonly spawns?: readonly (SpawnRefusalKind | 'ok')[]
  /** Attached to refusals, as a harness-reported reset time would be. */
  readonly retryAfter?: Date
  /**
   * Session ids this harness has forgotten (§15.4). Resuming one of them is
   * refused as `stale_session`; every other id still resumes, because a mock
   * that only honoured ids it had itself issued could not play the ordinary
   * case of a caller handing back an id from a previous run.
   *
   * It is a list rather than a flag so a test can drive the case the rule is
   * actually about: the *same* adapter refusing one token and accepting the
   * next, which is what a retry with a fresh session looks like from here.
   */
  readonly staleSessions?: readonly string[]
}

const DEFAULT_CAPABILITIES: HarnessCapabilities = {
  inject: true,
  interrupt: true,
  resume: true,
  pty: true,
  permissionControl: true,
  /**
   * False, where every other capability here is true — because a scripted
   * double does not compact anything, and because a suite in which all three
   * shipped adapters say `true` would never once exercise a caller's handling
   * of `false`. The honest value and the useful one are the same value.
   */
  autoCompact: false,
}

/** Long enough that a consumer can interrupt after the first event and still truncate the rest. */
export const DEFAULT_SCRIPT: MockScript = {
  events: [
    { type: 'assistant_text', text: 'reading the phase brief' },
    { type: 'tool_use', name: 'Read', input: { path: 'src/widget.ts' }, id: 'tool-1' },
    { type: 'tool_result', id: 'tool-1', ok: true, summary: '42 lines' },
    { type: 'assistant_text', text: 'done' },
    { type: 'usage', input: 1200, output: 340 },
  ],
  result: 'ok',
}

/**
 * A continued turn, as §15 makes the normal one: most of the prompt was already
 * in the session and came back off the vendor's cache instead of being rebuilt,
 * so `input` is small and `cacheRead` is most of the prefix.
 *
 * It exists so accounting can be driven end to end without a vendor. The two
 * counters are optional on the event for a reason (§15.6) — `DEFAULT_SCRIPT`
 * deliberately reports neither, which is what a harness that does not report
 * them looks like, and an aggregate has to keep the two runs distinguishable
 * rather than calling the silent one a 0% hit rate.
 */
export const CACHED_SCRIPT: MockScript = {
  events: [
    { type: 'assistant_text', text: 'continuing from where this session left off' },
    { type: 'usage', input: 300, output: 120, cacheRead: 11_400, cacheWrite: 900 },
  ],
  result: 'ok',
}

/** A run that fails on its own, for exercising the failure branch of a pipeline. */
export const ERRORING_SCRIPT: MockScript = {
  events: [
    { type: 'assistant_text', text: 'starting' },
    { type: 'error', message: 'the agent gave up' },
  ],
  result: 'error',
}

class MockSession implements AgentSession {
  #remaining: ScriptedEvent[]
  #injected: AgentEvent[] = []
  #state: 'running' | 'stopped' | 'ended' = 'running'
  #iteratorTaken = false

  constructor(
    readonly id: string,
    private readonly harness: string,
    private readonly capabilities: HarnessCapabilities,
    private readonly script: MockScript,
  ) {
    this.#remaining = [...script.events]
  }

  get events(): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: () => this.#iterate() }
  }

  async *#iterate(): AsyncGenerator<AgentEvent> {
    // A second consumer gets an empty, terminated stream rather than a hang.
    if (this.#iteratorTaken) return
    this.#iteratorTaken = true

    yield { type: 'session_started', sessionId: this.id }
    while (this.#state === 'running') {
      // Injected messages jump the queue: an operator steering an agent is
      // reacting to what they just read, so the transcript must show the
      // message where they sent it.
      const injected = this.#injected.shift()
      if (injected) {
        yield injected
        continue
      }
      const next = this.#remaining.shift()
      if (!next) break
      yield next
    }
    const result = this.#state === 'stopped' ? 'interrupted' : this.script.result
    this.#state = 'ended'
    yield { type: 'session_ended', result }
  }

  /**
   * Operator text carried on the task (§9), delivered at the start of the turn
   * whatever `inject` says — that capability is about writing into a turn
   * already running, and this is the moment before one.
   */
  deliverOperatorText(text: string): void {
    this.#injected.push({ type: 'user_message', text })
  }

  async send(text: string): Promise<void> {
    if (!this.capabilities.inject) throw new HarnessCapabilityError(this.harness, 'inject')
    this.#injected.push({ type: 'user_message', text })
  }

  async interrupt(): Promise<void> {
    if (!this.capabilities.interrupt) throw new HarnessCapabilityError(this.harness, 'interrupt')
    if (this.#state === 'running') this.#state = 'stopped'
  }

  async kill(): Promise<void> {
    if (this.#state === 'running') this.#state = 'stopped'
  }
}

export class MockAdapter implements HarnessAdapter {
  readonly id: string
  readonly capabilities: HarnessCapabilities
  /** Every task this adapter was asked to spawn, for asserting scheduler behavior. */
  readonly spawned: AgentTask[] = []

  #plan: (SpawnRefusalKind | 'ok')[]
  readonly #stale: ReadonlySet<string>
  #forced: SpawnRefusalKind | null = null
  #sessions = 0

  constructor(private readonly options: MockAdapterOptions = {}) {
    this.id = options.id ?? 'mock'
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities }
    this.#plan = [...(options.spawns ?? [])]
    this.#stale = new Set(options.staleSessions ?? [])
  }

  /** Refuse the next spawn with this kind, whatever the plan says. */
  refuseNext(kind: SpawnRefusalKind): void {
    this.#forced = kind
  }

  async preflight(): Promise<PreflightResult> {
    return this.options.preflight ?? { installed: true, authenticated: true, version: 'mock' }
  }

  async spawn(task: AgentTask): Promise<SpawnOutcome> {
    const planned = this.#forced ?? this.#plan.shift() ?? 'ok'
    this.#forced = null
    if (planned !== 'ok') {
      // Identifiers only: the refusal reason is about the vendor and the node,
      // never about what the node was going to ask the agent to do.
      const refusal = {
        ok: false as const,
        kind: planned,
        message: `${this.id} refused to spawn node ${task.nodeId}: ${planned}`,
      }
      return this.options.retryAfter ? { ...refusal, retryAfter: this.options.retryAfter } : refusal
    }
    // §15.4, and only where a token was actually carried: with none there is
    // nothing to be stale. Refused before `spawned` is appended to, because a
    // refusal is not work — admission control must not count it as such.
    if (task.resumeSessionId !== undefined && this.#stale.has(task.resumeSessionId)) {
      return {
        ok: false,
        kind: 'stale_session',
        message: `${this.id} refused to spawn node ${task.nodeId}: resume-session-unknown`,
      }
    }
    this.spawned.push(task)
    this.#sessions += 1
    const id = task.resumeSessionId ?? `${this.id}-session-${this.#sessions}`
    const session = new MockSession(
      id,
      this.id,
      this.capabilities,
      this.options.script ?? DEFAULT_SCRIPT,
    )
    if (task.operatorText !== undefined) session.deliverOperatorText(task.operatorText)
    return { ok: true, session }
  }

  /**
   * A real terminal running the platform's most trivial interactive program.
   * A *scripted* pty would be a fake of the one thing about takeover that is
   * worth testing — that a process is spawned, driven and reaped — so this one
   * is real and the program is boring instead.
   *
   * **It has to stay alive, and that is what made `/bin/cat` wrong on
   * Windows.** There is no such file there, so the terminal exited the instant
   * it was opened; node-pty then ran its *deferred* resize — ConPTY cannot be
   * resized before it is ready, so the call is queued rather than made — and
   * threw `Cannot resize a pty that has already exited` from a callback no
   * caller is on. Vitest reported that as an unhandled error and failed a run
   * in which every test had passed. The fix is a program that survives being
   * attached to, not a catch around a throw that arrives from somewhere else.
   */
  async attachPty(sessionId: string, attach: PtyAttach): Promise<PtyHandle> {
    if (!this.capabilities.pty) throw new HarnessCapabilityError(this.id, 'pty')
    return openPty({
      sessionId,
      // `cat` echoes stdin and waits; `cmd.exe` with no arguments is the
      // nearest Windows equivalent that simply sits there reading. Neither
      // test asserts on the bytes (§11), so all that is asked of either is
      // that it stay running until it is detached.
      ...(process.platform === 'win32'
        ? { file: process.env['ComSpec'] ?? 'cmd.exe', args: [] }
        : { file: '/bin/cat', args: [] }),
      env: process.env,
      attach,
    })
  }
}
