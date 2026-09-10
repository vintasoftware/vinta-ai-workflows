/**
 * The harness adapter boundary: what the daemon needs from a coding-agent CLI,
 * and nothing more.
 *
 * Three decisions from §7 and §6.1 shape everything here.
 *
 * The no-API-keys constraint makes an adapter a process supervisor over a CLI
 * the user already logged into. `preflight` therefore *reports* on that login
 * rather than performing one: nothing in this module or any implementation of
 * it may read a credential store, prompt for a secret, or carry a token.
 *
 * Capabilities differ enough between harnesses that pretending uniformity
 * means failing at the moment a user clicks a button. So an adapter declares
 * what it can do, the UI greys out the rest, and the operations behind a
 * false capability reject with `HarnessCapabilityError` — a caller must never
 * be able to mistake "this harness cannot do that" for "delivered".
 *
 * `spawn` returns refusals as values. A vendor declining to start a session is
 * backpressure, not failure (§6.1): it is routine when N agents share one
 * seat, and it must return the node to the ready set instead of failing it.
 * A thrown exception cannot carry that distinction without every caller
 * re-deriving it from a message string, so only `fatal` means broken.
 *
 * Nothing here puts prompt text, file contents or agent output into an error
 * message or a structured field. That content exists in exactly one place —
 * the transcript files under the run directory (§5.3).
 */

/**
 * Everything an adapter needs to start one agent turn. `prompt` is the phase
 * brief itself; it is task input, never something to log or embed in an error.
 */
export interface AgentTask {
  /** Opaque node identifier, safe to log. */
  readonly nodeId: string
  /** Absolute path to the lane worktree the agent runs in. */
  readonly cwd: string
  readonly prompt: string
  readonly model: string
  /**
   * Steering the operator typed while this node had nowhere live to put it —
   * a harness whose `inject` is false, or a node that was down on a capacity
   * wait — waiting to be delivered at this spawn (§9).
   *
   * Deliberately **not** folded into `prompt`. The two have different authors,
   * and an adapter has to be able to present this one *as the operator's*
   * ("the operator added the following guidance") rather than concatenating it
   * into a brief and leaving the agent to guess who said what. Every adapter
   * delivers it, whatever its `inject` capability says: `inject` describes
   * whether a *running turn* can be written to, and this is delivered at the
   * start of one.
   *
   * Task input, exactly like `prompt`: it is legitimately handed to the agent
   * and journalled as transcript payload, and it never goes into a log line,
   * an error message, a refusal message, or a process argument.
   */
  readonly operatorText?: string
  /** Continue a prior session. Only meaningful where `capabilities.resume`. */
  readonly resumeSessionId?: string
}

export interface HarnessCapabilities {
  /** Deliver a message into a running turn. */
  readonly inject: boolean
  readonly interrupt: boolean
  /** Continue a prior session by id. */
  readonly resume: boolean
  /** Interactive takeover. */
  readonly pty: boolean
  /** Non-interactive tool permission policy. */
  readonly permissionControl: boolean
}

export interface PreflightResult {
  readonly installed: boolean
  readonly authenticated: boolean
  readonly version?: string
  /** The exact command the *user* runs to fix it. Never run by the daemon. */
  readonly hint?: string
}

/**
 * The normalized event stream. Every harness's native output folds into this
 * union, which is what the transcript stores and what the UI renders.
 *
 * `user_message` is an addition to the union as written in §7. §15 requires an
 * injected message to appear in the transcript, and the transcript is exactly
 * this stream — without a variant for it, a steering message the operator
 * typed would be invisible in the record of the run it changed.
 */
export type AgentEvent =
  | { readonly type: 'session_started'; readonly sessionId: string }
  | { readonly type: 'user_message'; readonly text: string }
  | { readonly type: 'assistant_text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'tool_use'; readonly name: string; readonly input: unknown; readonly id: string }
  | { readonly type: 'tool_result'; readonly id: string; readonly ok: boolean; readonly summary: string }
  | { readonly type: 'permission_request'; readonly tool: string; readonly detail: unknown }
  | { readonly type: 'usage'; readonly input: number; readonly output: number; readonly costUsd?: number }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'session_ended'; readonly result: 'ok' | 'error' | 'interrupted' }

/**
 * A live agent turn.
 *
 * `events` is **single-consumer**: it yields to the first iterator taken, and
 * any later iterator terminates immediately rather than blocking on a stream
 * that will never speak to it again. Replay is the journal's job — transcripts
 * are files precisely because buffering megabytes of agent output in memory to
 * serve a second reader is the thing §5.3 exists to avoid.
 */
export interface AgentSession {
  readonly id: string
  readonly events: AsyncIterable<AgentEvent>
  /**
   * Deliver a message into the running turn. Rejects with
   * `HarnessCapabilityError` where `capabilities.inject` is false — the caller
   * queues the text and delivers it on the next resume (§9), because the
   * queue belongs where the resume happens, not inside a session that is
   * about to end.
   */
  send(text: string): Promise<void>
  /** Rejects with `HarnessCapabilityError` where `capabilities.interrupt` is false. */
  interrupt(): Promise<void>
  /** Idempotent: killing an already-dead session resolves and changes nothing. */
  kill(): Promise<void>
}

/**
 * Why a spawn was refused. Every kind but `fatal` is a wait, not a failure:
 * the node releases its resources and returns to pending (§6.1).
 */
export type SpawnRefusalKind = 'rate_limit' | 'concurrency' | 'quota' | 'transient' | 'fatal'

export interface SpawnRefusal {
  readonly ok: false
  readonly kind: SpawnRefusalKind
  /** A reset time the harness actually reported. Preferred over guessed backoff. */
  readonly retryAfter?: Date
  /** Operator-facing, identifiers only — never prompt text or repository content. */
  readonly message: string
}

export type SpawnOutcome = { readonly ok: true; readonly session: AgentSession } | SpawnRefusal

export interface HarnessAdapter {
  /**
   * Registry key, and the key admission control keeps one in-flight ceiling
   * under. Deliberately a plain string rather than `HarnessId`: that enum is
   * the user-facing contract for what a workflow may *request*, while this is
   * an internal registry key. Conflating them forces test and out-of-tree
   * adapters to impersonate a real vendor and contend for its ceiling.
   */
  readonly id: string
  readonly capabilities: HarnessCapabilities
  /** Reports whether the CLI is installed and logged in. Never authenticates. */
  preflight(): Promise<PreflightResult>
  /** Never throws on capacity — see §6.1. */
  spawn(task: AgentTask): Promise<SpawnOutcome>
  // `attachPty` (§7) arrives with step 17, which is what defines PtyHandle.
  // `capabilities.pty` is declared now so the UI can grey the button today.
}

/** Thrown when a caller invokes an operation the adapter declared it lacks. */
export class HarnessCapabilityError extends Error {
  constructor(
    readonly harness: string,
    readonly capability: keyof HarnessCapabilities,
  ) {
    super(`harness ${harness} does not support ${capability}`)
    this.name = 'HarnessCapabilityError'
  }
}
