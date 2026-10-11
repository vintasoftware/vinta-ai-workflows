/**
 * The `codex` adapter: `codex app-server` supervised as a child process and
 * driven over its stdio JSON-RPC protocol, one server per session.
 *
 * §7 used to fix the invocation as `codex exec --json`, and that mode cannot
 * hold a session open: it shuts down on its first `turn.completed`, and
 * whatever the agent left running in the background — a test suite started
 * with `exec_command`, a sub-agent it spawned — dies with it. The app server is
 * the same agent with the lifetime left to the client: a thread outlives its
 * turns, background work outlives the turn that started it, and a turn can be
 * started or steered whenever the client chooses. That is the whole reason for
 * the move, and it is what `backgroundWork` and `inject` rest on.
 *
 * **Nothing wakes the agent but this adapter.** The server keeps a backgrounded
 * command running and a sub-agent working after the turn ends, and reports
 * when each finishes, but it never starts a turn for the parent on its own. So
 * this file does what an interactive client does: it notices the report, and
 * starts a short turn saying what finished (`CodexSession`).
 *
 * The protocol is labelled experimental, and the methods this file needs to
 * see background work (`thread/backgroundTerminals/*`) are behind its
 * `experimentalApi` opt-in. Every field name below was read off the schema the
 * 0.147.0 binary generates (`codex app-server generate-ts --experimental`), and
 * `preflight` refuses an older one rather than letting it fail mid-run.
 *
 * Three properties hold here for the reasons they hold in `claude-code.ts`:
 *
 * **The binary is configuration, never a constant.** Option, then
 * `VINTA_AI_MAESTRO_CODEX_BIN`, then `"codex"`.
 *
 * **Unknown output is ignored, never fatal.** The notification and item
 * vocabularies grow with the CLI; a method or item type this file has never
 * seen falls out of the mapping as zero events. A server *request* this file
 * does not know is answered with an error rather than left hanging, because an
 * unanswered request stalls the turn that asked it.
 *
 * **A refusal is classified, not thrown** (§6.1), with a vendor-reported reset
 * time preferred over any guess.
 *
 * Nothing here forwards prompt text, file contents or agent output into a
 * refusal message or an `error` event. Codex states its failures as prose
 * (often a whole upstream JSON body), so failure prose is run through the same
 * ordered signature table the refusals use and only the resulting fixed reason
 * token is emitted. The prose itself lives in the transcript's own events.
 *
 * The framing, queue, process-signalling and classification machinery lives in
 * `shared.ts`. An adapter is a self-contained implementation of
 * `HarnessAdapter` and never imports another adapter.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import {
  type AgentEvent,
  type AgentSession,
  type AgentTask,
  type HarnessAdapter,
  type HarnessCapabilities,
  type PreflightResult,
  type PtyAttach,
  type PtyHandle,
  type SpawnOutcome,
  type SpawnRefusal,
  type SpawnRefusalKind,
  type TurnRefusal,
} from './adapter.ts'
import { type AgentPermission, codexThreadPolicy, DEFAULT_PERMISSION } from './permissions.ts'
import { openPty } from './pty.ts'
import {
  EventQueue,
  JsonLines,
  type RefusalSignature,
  agentSpawn,
  asNumber,
  asRecord,
  asString,
  childEnv,
  classifier,
  operatorGuidance,
  probe,
  signalGroup,
} from './shared.ts'

/** §7's invocation. Everything else — the prompt above all — goes over the protocol. */
const BASE_ARGS = ['app-server'] as const

/**
 * The oldest release this file was run against. The protocol is experimental
 * and its background-terminal methods appeared late, so an older binary is
 * reported by `preflight` instead of failing a node an hour into a run.
 */
const MIN_VERSION: readonly [number, number, number] = [0, 147, 0]

/**
 * `inject` is true because a running turn can be steered (`turn/steer`) and a
 * held one continued (`turn/start`) — the app server takes input whenever the
 * client sends it. `permissionControl` is true because the thread is started
 * with an explicit sandbox, approval policy and reviewer (`permissions.ts`),
 * and every approval request that still reaches this client is answered.
 *
 * **`autoCompact` is true and this adapter passes nothing to make it so**,
 * which is the one capability here that is not backed by a parameter. codex
 * compacts on its own and ships no way to stop it: no flag, no environment
 * variable, and the only related config key — `model_auto_compact_token_limit`
 * — sets the *threshold*, not a switch. A constant passed here would not track
 * the context window of whichever model the workflow named; the vendor's
 * default is the model's own limit, which is better information than this
 * repository has.
 *
 * `backgroundWork` is true because the server keeps background work running
 * across turns and this adapter wakes the agent when it reports.
 */
const CAPABILITIES: HarnessCapabilities = {
  inject: true,
  interrupt: true,
  resume: true,
  pty: true,
  permissionControl: true,
  autoCompact: true,
  backgroundWork: true,
}

/**
 * How long a session held open for background work may go without hearing
 * from the server before it ends anyway. Long enough for a full test suite or
 * a reviewer's pass; short enough that a dev server the agent forgot does not
 * hold a lane for the rest of the run.
 */
const BACKGROUND_IDLE_MS = 30 * 60_000

/**
 * Reports that land this close together go to the agent in one wake turn. A
 * gate run and the reviewer it was racing often finish within a second of each
 * other, and two back-to-back wake turns cost twice the prompt for one answer.
 */
const WAKE_DEBOUNCE_MS = 1_000

/** The most a cleanup request may delay a kill. Past it the process group goes anyway. */
const CLEANUP_MS = 2_000

/**
 * How long a command the server no longer lists may take to report its exit.
 * The listing drops a process the moment it exits, while the completion is
 * sent only once its output has drained, so for a moment it is in neither.
 */
const EXIT_GRACE_MS = 3_000

/** Command output can be a whole file. The transcript keeps it; an event carries a look. */
const SUMMARY_LIMIT = 2_000

/** A command line quoted back to the agent in a wake message is clipped to this. */
const COMMAND_LIMIT = 200

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const summarize = (content: unknown): string => {
  const rendered = asString(content) ?? JSON.stringify(content ?? null)
  return rendered.length > SUMMARY_LIMIT ? `${rendered.slice(0, SUMMARY_LIMIT)}…` : rendered
}

/**
 * Item types that are a tool call, under the names the rest of the package
 * already knows them by. The transcript view and the gate guard were written
 * against `command_execution` and `file_change`; the protocol now spells them
 * in camelCase, and renaming them here keeps one vocabulary downstream.
 */
const TOOL_ITEMS: Readonly<Record<string, string>> = {
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  dynamicToolCall: 'dynamic_tool_call',
  webSearch: 'web_search',
  collabAgentToolCall: 'collab_agent',
}

/** The multi-agent tools, by the names the model calls them. */
const COLLAB_TOOLS: Readonly<Record<string, string>> = {
  spawnAgent: 'spawn_agent',
  sendInput: 'send_input',
  resumeAgent: 'resume_agent',
  wait: 'wait',
  closeAgent: 'close_agent',
}

/** MCP and dynamic calls name the tool they called; the rest are their item type. */
const toolName = (item: Record<string, unknown>, kind: string, fallback: string): string => {
  const tool = asString(item['tool'])
  if (kind === 'mcpToolCall') {
    const server = asString(item['server'])
    return server !== undefined && tool !== undefined ? `${server}.${tool}` : fallback
  }
  if (kind === 'dynamicToolCall') {
    const namespace = asString(item['namespace'])
    return tool === undefined ? fallback : namespace === undefined ? tool : `${namespace}.${tool}`
  }
  if (kind === 'collabAgentToolCall') return (tool === undefined ? undefined : COLLAB_TOOLS[tool]) ?? fallback
  return fallback
}

/** Whichever field this item kind puts its outcome in. */
const toolSummary = (item: Record<string, unknown>): string => {
  for (const field of ['aggregatedOutput', 'result', 'error', 'changes', 'contentItems', 'query']) {
    const value = item[field]
    if (value !== undefined && value !== null) return summarize(value)
  }
  return ''
}

const toolOk = (item: Record<string, unknown>): boolean => {
  const exit = asNumber(item['exitCode'])
  return (
    item['status'] !== 'failed' &&
    item['status'] !== 'declined' &&
    item['success'] !== false &&
    (exit === undefined || exit === 0)
  )
}

const joined = (value: unknown): string =>
  Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string').join('\n\n') : ''

/**
 * `item/started` opens a tool call, `item/completed` closes it. Everything
 * else is read on completion, when its text is whole — the deltas in between
 * are for a UI that renders typing, and summing them here would emit the same
 * message twice.
 */
const mapItem = (raw: unknown, phase: 'started' | 'completed'): AgentEvent[] => {
  const item = asRecord(raw)
  const kind = asString(item?.['type'])
  const id = asString(item?.['id'])
  if (item === undefined || kind === undefined || id === undefined) return []

  const tool = TOOL_ITEMS[kind]
  if (tool !== undefined) {
    return phase === 'started'
      ? [{ type: 'tool_use', id, name: toolName(item, kind, tool), input: item }]
      : [{ type: 'tool_result', id, ok: toolOk(item), summary: toolSummary(item) }]
  }
  if (phase === 'started') return []

  switch (kind) {
    case 'agentMessage': {
      const text = asString(item['text'])
      return text !== undefined && text.length > 0 ? [{ type: 'assistant_text', text }] : []
    }
    case 'reasoning': {
      // The summary is what the vendor chose to show; the raw content is
      // present only where the model exposes it. Either is the agent's own
      // reasoning and both are transcript material.
      const text = joined(item['summary']) || joined(item['content'])
      return text.length > 0 ? [{ type: 'thinking', text }] : []
    }
    case 'contextCompaction':
      // No counts: the item says only that it happened. Absent is unknown,
      // never a compaction that freed nothing.
      return [{ type: 'context_compacted', trigger: 'auto' }]
    default:
      // `userMessage` is the prompt this adapter sent, already in the record;
      // `plan`, `imageView`, `hookPrompt` and whatever ships next have no home
      // in the normalized union.
      return []
  }
}

/**
 * The words a failure is classified by. `codexErrorInfo` is the server's own
 * structured reading of the failure — `usageLimitExceeded`, an HTTP status —
 * and goes in beside the prose, because a structured token is worth more to a
 * pattern table than a sentence that changes between releases.
 */
const failureProse = (raw: unknown): string => {
  const error = asRecord(raw)
  if (error === undefined) return ''
  const info = error['codexErrorInfo']
  const infoRecord = asRecord(info)
  const infoWords =
    typeof info === 'string'
      ? info
      : infoRecord === undefined
        ? ''
        : Object.entries(infoRecord)
            .map(([key, value]) => `${key} ${asNumber(asRecord(value)?.['httpStatusCode']) ?? ''}`)
            .join(' ')
  return [asString(error['message']), asString(error['additionalDetails']), infoWords]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' ')
}

/**
 * Codex states a failure as prose — frequently a whole upstream JSON body. The
 * classifier's reason token is the vendor-independent label for it, and is the
 * only part that may reach a message field.
 */
const failureEvent = (prose: string): AgentEvent => ({
  type: 'error',
  message: `codex: ${reasonFor(prose)}`,
})

/**
 * One server notification to zero or more normalized events: items, and the
 * failures announced outside them. Turn boundaries, usage and the session's
 * lifetime are not here — they are facts about the session as a whole, and
 * `CodexSession` derives them from state no single notification carries.
 *
 * An `error` that the server will retry is not a failure yet: it is a
 * reconnect in progress, sent once per attempt, and the turn either recovers
 * or ends with one that is not retried.
 */
export function mapNotification(raw: unknown): AgentEvent[] {
  const value = asRecord(raw)
  const method = asString(value?.['method'])
  const params = asRecord(value?.['params'])
  if (method === undefined || params === undefined) return []
  switch (method) {
    case 'item/started':
      return mapItem(params['item'], 'started')
    case 'item/completed':
      return mapItem(params['item'], 'completed')
    case 'error':
      return params['willRetry'] === true ? [] : [failureEvent(failureProse(params['error']))]
    default:
      return []
  }
}

/** The four counters of a `TokenUsageBreakdown` this file reads. */
export interface TokenTotals {
  readonly input: number
  readonly cached: number
  readonly cacheWrite: number
  readonly output: number
}

const readTotals = (raw: unknown): TokenTotals | undefined => {
  const total = asRecord(raw)
  const input = asNumber(total?.['inputTokens'])
  const output = asNumber(total?.['outputTokens'])
  if (total === undefined || input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cached: asNumber(total['cachedInputTokens']) ?? 0,
    cacheWrite: asNumber(total['cacheWriteInputTokens']) ?? 0,
  }
}

/**
 * The usage between two readings of the thread's running total.
 *
 * **The total, never `last`.** `thread/tokenUsage/updated` is sent after every
 * model response and again whenever the server recomputes its estimate or
 * hears new rate limits, with `last` restated each time, so summing `last`
 * counts one response several times. The total only moves when a response is
 * paid for, which makes the difference between two readings exact.
 *
 * A counter that went *down* means the server reset the total (it does when a
 * context window is declared full), and the new reading is then all new usage.
 *
 * **`input` is the fresh remainder**, as in every adapter (§15.6): codex
 * passes through the OpenAI shape, where `inputTokens` is the whole prompt and
 * the cached part sits inside it. Subtracted here, floored at zero because a
 * vendor is not owed arithmetic consistency, so `input + cacheRead +
 * cacheWrite` is the whole prompt everywhere. Codex prices nothing, so
 * `costUsd` is omitted rather than guessed.
 */
export function usageBetween(before: TokenTotals | undefined, after: TokenTotals): AgentEvent {
  const reset =
    before === undefined ||
    after.input < before.input ||
    after.output < before.output ||
    after.cached < before.cached ||
    after.cacheWrite < before.cacheWrite
  const base = reset ? { input: 0, output: 0, cached: 0, cacheWrite: 0 } : before
  const prompt = after.input - base.input
  const cacheRead = after.cached - base.cached
  const cacheWrite = after.cacheWrite - base.cacheWrite
  return {
    type: 'usage',
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output: after.output - base.output,
    cacheRead,
    cacheWrite,
  }
}

// ---------------------------------------------------------------------------
// Refusal classification
// ---------------------------------------------------------------------------

/**
 * Ordered: the first match wins, so the more specific signature comes first.
 * The patterns are this vendor's wording and stay here; only the first-match
 * machinery is shared (`classifier`).
 */
const SIGNATURES: readonly RefusalSignature[] = [
  {
    // §15.4. `classifier` hoists this row above the rest and only consults it
    // when the task carried a `resumeSessionId` and the failure is the reply
    // to `thread/resume` — the one request that names the id. The server says
    // "no rollout found for thread id …"; codex calls the thing three names
    // depending on which layer answers, so all three are listed.
    kind: 'stale_session',
    reason: 'resume-session-unknown',
    pattern:
      /no (thread|session|rollout) found|(thread|session|rollout)[^\n]{0,40}\b(not ?found|not exist|no longer exists|expired|unknown|invalid)\b|could not (find|resume|load)[^\n]{0,40}(thread|session|rollout)/,
  },
  {
    kind: 'fatal',
    reason: 'binary-not-found',
    // `is not recognized` is cmd.exe's phrasing: on Windows every spawn goes
    // through it, so a missing binary arrives as its output rather than ENOENT.
    pattern: /enoent|command not found|no such file|is not recognized/,
  },
  {
    // A server that cannot drive the protocol this file speaks: too old to
    // have `app-server` at all, or missing a method. `preflight` reports the
    // same thing before a run; this is the run that skipped it.
    kind: 'fatal',
    reason: 'app-server-unsupported',
    pattern: /unrecognized subcommand|method not found|unknown variant .{0,40}(method|request)/,
  },
  {
    kind: 'unauthenticated',
    reason: 'not-authenticated',
    pattern:
      /not logged in|codex login|logged out|unauthorized|\b401\b|invalid api key|authentication_error|oauth token (has )?expired|credentials? (not found|expired|invalid)/,
  },
  {
    // Codex refuses to run outside a git repository it was not told to trust.
    // Deterministic misconfiguration, so fatal: waiting cannot fix it.
    kind: 'fatal',
    reason: 'untrusted-directory',
    pattern: /not inside a trusted directory|skip-git-repo-check/,
  },
  {
    kind: 'quota',
    reason: 'usage-window-exhausted',
    pattern:
      /usage limit|usagelimitexceeded|quota (exceeded|exhausted)|credit balance|out of credits|insufficient_quota|plan limit/,
  },
  {
    kind: 'concurrency',
    reason: 'account-concurrency-cap',
    pattern: /too many concurrent|concurrent (session|request|turn|agent)|max(imum)? concurrent/,
  },
  {
    kind: 'rate_limit',
    reason: 'rate-limited',
    pattern: /rate[ _-]?limit|too many requests|\b429\b/,
  },
  {
    kind: 'transient',
    reason: 'upstream-unavailable',
    pattern:
      /overloaded|internalservererror|\b(500|502|503|504|529)\b|econnreset|econnrefused|etimedout|enotfound|socket hang up|stream (disconnected|closed)|fetch failed|network error|temporarily unavailable/,
  },
]

const REFUSALS = classifier('codex', SIGNATURES)

/**
 * The same table, for a refusal the server sent as a JSON-RPC error rather
 * than an exit: the parenthetical is then the error code, and calling it an
 * exit status would send whoever reads it looking for a crash.
 */
const RPC_REFUSALS = classifier('codex', SIGNATURES, (code) =>
  code === null ? 'no reply' : `json-rpc ${code}`,
)

/** The fixed label for whatever the vendor said, safe to put in a message field. */
const reasonFor = (output: string): string => REFUSALS.reasonFor(output)

/**
 * Classify what the server said on its way out. The default is `fatal`; see
 * `classifier` for why an unrecognized failure must not become a wait.
 */
export const classifySpawnFailure = REFUSALS.classify

/**
 * A capacity refusal announced by a notification of a turn that had already
 * started, or nothing.
 *
 * Its own function rather than part of `mapNotification` for the reason
 * `failureEvent` exists: only the classifier's fixed token may reach an event.
 * So the prose is read here, matched, and dropped — what comes back is a kind,
 * a token and a reset time.
 *
 * Both carriers are read: a window can close on an `error` notification the
 * server will not retry, or only on the failed turn that follows it.
 */
export function turnRefusal(raw: unknown, now?: Date): TurnRefusal | undefined {
  const value = asRecord(raw)
  const params = asRecord(value?.['params'])
  if (params === undefined) return undefined
  let prose: string | undefined
  if (value?.['method'] === 'error' && params['willRetry'] !== true) {
    prose = failureProse(params['error'])
  } else if (value?.['method'] === 'turn/completed') {
    const turn = asRecord(params['turn'])
    if (turn?.['status'] === 'failed') prose = failureProse(turn['error'])
  }
  return prose === undefined || prose.length === 0 ? undefined : REFUSALS.capacity(prose, now)
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type RpcReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: number | null; readonly message: string }

const CLOSED: RpcReply = { ok: false, code: null, message: 'connection closed' }

/**
 * The client half of the server's JSON-RPC: requests out with numeric ids,
 * replies matched back, and a connection that answers every outstanding
 * request with a failure when it closes — a reply that can never arrive must
 * not leave a caller waiting on it.
 */
class Rpc {
  #next = 0
  #closed = false
  readonly #pending = new Map<number, (reply: RpcReply) => void>()

  constructor(private readonly child: ChildProcess) {}

  request(method: string, params: unknown): Promise<RpcReply> {
    if (this.#closed) return Promise.resolve(CLOSED)
    const id = this.#next++
    return new Promise((resolve) => {
      this.#pending.set(id, resolve)
      this.#write({ id, method, params })
    })
  }

  notify(method: string): void {
    this.#write({ method })
  }

  respond(id: unknown, result: unknown): void {
    this.#write({ id, result })
  }

  refuse(id: unknown, code: number, message: string): void {
    this.#write({ id, error: { code, message } })
  }

  /** A reply frame, matched to its request. */
  settle(frame: Record<string, unknown>): void {
    const id = asNumber(frame['id'])
    const resolve = id === undefined ? undefined : this.#pending.get(id)
    if (id === undefined || resolve === undefined) return
    this.#pending.delete(id)
    const error = asRecord(frame['error'])
    resolve(
      error === undefined
        ? { ok: true, result: frame['result'] }
        : { ok: false, code: asNumber(error['code']) ?? null, message: asString(error['message']) ?? '' },
    )
  }

  close(): void {
    this.#closed = true
    for (const resolve of this.#pending.values()) resolve(CLOSED)
    this.#pending.clear()
  }

  #write(message: unknown): void {
    if (this.#closed) return
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The pipe closed under us; `close` will settle whatever was waiting.
    }
  }
}

/** One await, bounded. A server that stopped answering must not hold a cleanup open. */
const bounded = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref()
    void work.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })

const textInput = (text: string): Record<string, unknown> => ({
  type: 'text',
  text,
  text_elements: [],
})

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** A command the agent started with a process id — one that can outlive its call. */
interface BackgroundCommand {
  readonly processId: string
  command: string
  /**
   * The model was handed a session id rather than a result: a new model
   * response began, or the turn ended, while the command still ran. Only such
   * a command can finish without the agent reading it.
   */
  backgrounded: boolean
  /** The agent wrote to or polled it while it ran (`terminalInteraction`). */
  polled: boolean
  exited: boolean
  exitCode: number | null
  /** It exited while no turn was running, so the agent cannot have read it. */
  exitedBetweenTurns: boolean
  reported: boolean
  /** When the listing first left it out while its completion had not arrived. */
  missingSince?: number
}

/** A sub-agent thread on this server. Every non-parent thread is one. */
interface SubAgent {
  running: boolean
  /** Finished since the parent last had a chance to read its result. */
  unseen: boolean
}

type Result = 'ok' | 'error' | 'interrupted'

/**
 * One app-server thread driven headlessly, across as many turns as its
 * background work needs (`backgroundWork`).
 *
 * **A turn end is not the session end.** On `turn/completed` the session asks
 * what is still pending: commands the server is still running for this thread
 * (`thread/backgroundTerminals/list`, cross-checked against the command items
 * it has seen), and sub-agents still working (`thread/status/changed` on their
 * threads). It ends on the first turn end that leaves none of that — and holds
 * otherwise, bounded by silence (`backgroundIdleMs`), the way
 * `ClaudeCodeSession` does.
 *
 * **Waking is this session's job.** When held work reports — a command's
 * `item/completed`, which carries the *old* turn's id; a sub-agent's turn
 * ending — the session waits a moment for more to land (`WAKE_DEBOUNCE_MS`)
 * and starts one turn naming what finished, by identifier only: the agent
 * fetches the output itself (`write_stdin`), and a sub-agent's reply is already
 * in its history. Work that reports during that turn goes to the next one, and
 * what is pending is recomputed after every turn.
 *
 * **One more thing is pending: a result the agent never saw.** A command that
 * was backgrounded and exited before the turn ended, without the agent polling
 * it, holds an output nobody read. Ending the session there drops it as surely
 * as killing it would have, so it is reported like one that exited later.
 * Whether the agent read it is inferred, not observed: a poll that finds the
 * process already gone is not announced by the server, so a command whose
 * single poll caught its exit is reported once more than it needed to be. The
 * wake message is worded to be harmless then.
 *
 * Interrupt and kill leave nothing running: background terminals are cleaned
 * on every thread before the process group is killed, because the server runs
 * each command in a terminal of its own, outside that group.
 */
class CodexSession implements AgentSession {
  readonly #queue: EventQueue
  readonly #child: ChildProcess
  readonly #rpc: Rpc
  readonly #idleMs: number

  #threadId: string | undefined
  /** Notifications that arrived before the thread id they are sorted by. */
  readonly #early: Record<string, unknown>[] = []
  #taken = false
  #ended = false
  #stopping = false
  #refusal: TurnRefusal | undefined
  #teardown: Promise<void> | undefined

  /** The turn running now, or undefined between turns. */
  #turnId: string | undefined
  readonly #finishedTurns = new Set<string>()
  /** A `turn/start` is in flight, and settles when its reply is read. */
  #starting = false
  #started: Promise<void> | undefined
  /** A turn end is being checked against the server's own listing. */
  #checking = false
  /** A `send` is in flight; the session may not end under it. */
  #sending = 0
  /** A turn of ours has started, so a token total seen now is new usage. */
  #turnSeen = false
  /** An error the server will not retry was reported during this turn. */
  #turnErrored = false

  readonly #commands = new Map<string, BackgroundCommand>()
  readonly #subAgents = new Map<string, SubAgent>()
  /** Operator text waiting for a turn to carry it. */
  readonly #pendingInput: string[] = []

  /** What the last turn reported, while the session is held open past it. */
  #held: 'ok' | undefined
  #idle: ReturnType<typeof setTimeout> | undefined
  #wake: ReturnType<typeof setTimeout> | undefined
  #recheck: ReturnType<typeof setTimeout> | undefined

  #totals: TokenTotals | undefined
  #reportedTotals: TokenTotals | undefined

  constructor(child: ChildProcess, rpc: Rpc, queue: EventQueue, idleMs: number) {
    this.#child = child
    this.#rpc = rpc
    this.#queue = queue
    this.#idleMs = idleMs
  }

  get id(): string {
    return this.#threadId ?? ''
  }

  get events(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => {
        // A second reader gets a finished stream, never a share of the events.
        if (this.#taken) return { next: async () => ({ done: true as const, value: undefined }) }
        this.#taken = true
        return this.#queue.iterate()
      },
    }
  }

  get refusal(): TurnRefusal | undefined {
    return this.#refusal
  }

  /** The thread exists; everything that waited for its id is sorted now. */
  bind(threadId: string): void {
    this.#threadId = threadId
    for (const message of this.#early.splice(0)) this.notification(message)
  }

  /** The turn `turn/start` opened, unless it already ended. */
  adopt(turnId: string | undefined): void {
    if (turnId === undefined || this.#finishedTurns.has(turnId) || this.#turnId !== undefined) return
    this.#turnId = turnId
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  notification(message: Record<string, unknown>): void {
    if (this.#ended) return
    if (this.#threadId === undefined) {
      this.#early.push(message)
      return
    }
    const method = asString(message['method']) ?? ''
    const params = asRecord(message['params']) ?? {}
    const thread = asString(params['threadId']) ?? asString(asRecord(params['thread'])?.['id'])
    if (thread !== undefined && thread !== this.#threadId) {
      this.#subAgent(thread, method, params)
    } else {
      this.#parent(method, params, message)
    }
    this.#touch(method)
  }

  /**
   * A request the server is waiting on. Every one is answered, at once and
   * the same way every time: nobody is at this session to answer, and a
   * request left open stalls the turn behind it. Approvals are declined, and
   * announced as `permission_request` so the transcript says what was asked.
   * Under `auto` and `full` none should arrive at all — `auto` routes them to
   * codex's own reviewer, `full` never asks.
   */
  request(message: Record<string, unknown>): void {
    const id = message['id']
    const method = asString(message['method']) ?? ''
    const params = asRecord(message['params']) ?? {}
    const ask = (tool: string, detail: Record<string, unknown>): void => {
      if (!this.#ended) this.#queue.push({ type: 'permission_request', tool, detail })
    }
    switch (method) {
      case 'item/commandExecution/requestApproval':
        ask('command_execution', pick(params, ['itemId', 'command', 'cwd', 'reason']))
        return this.#rpc.respond(id, { decision: 'decline' })
      case 'item/fileChange/requestApproval':
        ask('file_change', pick(params, ['itemId', 'reason', 'grantRoot']))
        return this.#rpc.respond(id, { decision: 'decline' })
      case 'item/permissions/requestApproval':
        ask('permissions', pick(params, ['itemId', 'reason', 'permissions']))
        // A grant of nothing, which is how this request is declined.
        return this.#rpc.respond(id, { permissions: {}, scope: 'turn' })
      case 'execCommandApproval':
      case 'applyPatchApproval':
        // The protocol's first version of the two above, still in its schema.
        ask(method === 'execCommandApproval' ? 'command_execution' : 'file_change', {})
        return this.#rpc.respond(id, { decision: { denied: { rejection: 'no one is attending this session' } } })
      case 'mcpServer/elicitation/request':
        ask('mcp_elicitation', pick(params, ['serverName']))
        return this.#rpc.respond(id, { action: 'decline', content: null, _meta: null })
      case 'item/tool/requestUserInput':
        // A question for a person, with nobody to put it to. No answers is an
        // answer; the agent carries on with what it has.
        return this.#rpc.respond(id, { answers: {} })
      case 'item/tool/call':
        // This client registers no dynamic tools, so no call is one of ours.
        return this.#rpc.respond(id, { contentItems: [], success: false })
      case 'currentTime/read':
        return this.#rpc.respond(id, { currentTimeAt: Math.floor(Date.now() / 1_000) })
      default:
        // Credentials and attestations among them: this client holds neither,
        // and a request it cannot answer is refused rather than ignored.
        return this.#rpc.refuse(id, -32601, 'not supported by this client')
    }
  }

  #parent(method: string, params: Record<string, unknown>, message: Record<string, unknown>): void {
    // Read before mapping: the failure that maps to an `error` event is the
    // same one that may be a closed window.
    const refused = turnRefusal(message)
    if (refused !== undefined) this.#noteRefusal(refused)

    switch (method) {
      case 'turn/started': {
        const turnId = asString(asRecord(params['turn'])?.['id'])
        if (turnId !== undefined && !this.#finishedTurns.has(turnId)) this.#turnId = turnId
        this.#turnSeen = true
        this.#turnErrored = false
        // A turn is bounded by the scheduler, not by this session's silence.
        this.#held = undefined
        this.#disarmIdle()
        break
      }
      case 'turn/completed':
        this.#turnEnded(asRecord(params['turn']) ?? {})
        return
      case 'thread/tokenUsage/updated': {
        const totals = readTotals(asRecord(params['tokenUsage'])?.['total'])
        if (totals === undefined) break
        // Before a turn of ours, a total is the history a resumed thread
        // already paid for, replayed on attach. It is the baseline, not usage.
        if (!this.#turnSeen) this.#reportedTotals = totals
        this.#totals = totals
        break
      }
      case 'item/started':
        this.#itemStarted(asRecord(params['item']) ?? {})
        break
      case 'item/completed':
        this.#itemCompleted(asRecord(params['item']) ?? {})
        break
      case 'item/commandExecution/terminalInteraction': {
        const command = this.#commandFor(asString(params['processId']))
        if (command !== undefined) {
          command.backgrounded = true
          command.polled = true
        }
        break
      }
      case 'error':
        if (params['willRetry'] !== true) this.#turnErrored = true
        break
      default:
        break
    }
    for (const event of mapNotification(message)) this.#queue.push(event)
  }

  #itemStarted(item: Record<string, unknown>): void {
    const kind = asString(item['type'])
    if (kind === 'reasoning' || kind === 'agentMessage') {
      // A model response has begun, which only happens once every tool call
      // of the last one has returned — so a command still running now was
      // handed back as a session id, and a sub-agent result already injected
      // into the history is in front of the model.
      for (const command of this.#commands.values()) if (!command.exited) command.backgrounded = true
      for (const agent of this.#subAgents.values()) if (!agent.running) agent.unseen = false
      return
    }
    if (kind !== 'commandExecution') return
    const processId = asString(item['processId'])
    if (processId === undefined || this.#commands.has(processId)) return
    this.#commands.set(processId, {
      processId,
      command: asString(item['command']) ?? '',
      backgrounded: false,
      polled: false,
      exited: false,
      exitCode: null,
      exitedBetweenTurns: false,
      reported: false,
    })
  }

  #itemCompleted(item: Record<string, unknown>): void {
    const kind = asString(item['type'])
    if (kind === 'commandExecution') {
      // Matched by process id, never by turn: a backgrounded command reports
      // under the turn that started it, however many turns ago that was.
      const command = this.#commandFor(asString(item['processId']))
      if (command === undefined || command.exited) return
      command.exited = true
      command.exitCode = asNumber(item['exitCode']) ?? null
      command.exitedBetweenTurns = this.#turnId === undefined && !this.#starting
      if (this.#reportable(command)) this.#evaluate()
      return
    }
    if (kind !== 'collabAgentToolCall' || item['status'] === 'failed') return
    const tool = asString(item['tool'])
    const receivers = Array.isArray(item['receiverThreadIds']) ? item['receiverThreadIds'] : []
    const states = asRecord(item['agentsStates']) ?? {}
    for (const receiver of receivers) {
      if (typeof receiver !== 'string') continue
      const agent = this.#agent(receiver)
      if (tool === 'wait') {
        // The agent waited on it and has its result.
        agent.unseen = false
      } else if (tool === 'closeAgent') {
        this.#subAgents.delete(receiver)
      } else {
        // A spawn or a message: the agent is about to work, even if its own
        // status has not said so yet. `pendingInit` is a spawn not yet running.
        const status = asString(asRecord(states[receiver])?.['status'])
        if (status === 'pendingInit' || status === 'running') agent.running = true
      }
    }
  }

  #subAgent(thread: string, method: string, params: Record<string, unknown>): void {
    const agent = this.#agent(thread)
    const stop = (): void => {
      // A transition, not a state: the idle that precedes a sub-agent's first
      // turn is not it finishing.
      if (!agent.running) return
      agent.running = false
      agent.unseen = true
      this.#evaluate()
    }
    switch (method) {
      case 'turn/started':
        agent.running = true
        return
      case 'turn/completed':
        return stop()
      case 'thread/status/changed': {
        const status = asString(asRecord(params['status'])?.['type'])
        if (status === 'active') agent.running = true
        else if (status !== undefined) stop()
        return
      }
      case 'thread/closed':
        this.#subAgents.delete(thread)
        this.#evaluate()
        return
      default:
        return
    }
  }

  #agent(thread: string): SubAgent {
    let agent = this.#subAgents.get(thread)
    if (agent === undefined) {
      agent = { running: false, unseen: false }
      this.#subAgents.set(thread, agent)
    }
    return agent
  }

  #commandFor(processId: string | undefined): BackgroundCommand | undefined {
    return processId === undefined ? undefined : this.#commands.get(processId)
  }

  // -------------------------------------------------------------------------
  // Turn boundaries
  // -------------------------------------------------------------------------

  #turnEnded(turn: Record<string, unknown>): void {
    const turnId = asString(turn['id'])
    if (turnId !== undefined) this.#finishedTurns.add(turnId)
    this.#turnId = undefined
    this.#emitUsage()

    const status = asString(turn['status'])
    if (status === 'failed') {
      // The `error` notification usually said this already; one line per
      // failure is the record, not two.
      if (!this.#turnErrored) this.#queue.push(failureEvent(failureProse(turn['error'])))
      // A turn that went wrong ends the session whatever is still running:
      // the work it left belongs to a turn nobody will read as done.
      return void this.#finish('error')
    }
    if (this.#stopping || status === 'interrupted') return void this.#finish('interrupted')
    if (this.#turnErrored) return void this.#finish('error')

    // Whatever outlived the turn was handed back to the model as a session id.
    for (const command of this.#commands.values()) if (!command.exited) command.backgrounded = true
    void this.#checkPending()
  }

  /**
   * The server's own list of what is still running, read once per turn end.
   * It adds anything the item stream did not show; it never removes, because
   * it drops a process the moment it exits, before that exit is reported.
   */
  async #checkPending(): Promise<void> {
    const threadId = this.#threadId
    if (threadId === undefined) return
    this.#checking = true
    const reply = await bounded(
      this.#rpc.request('thread/backgroundTerminals/list', { threadId }),
      CLEANUP_MS,
      CLOSED,
    )
    this.#checking = false
    if (this.#ended) return
    const listed = new Set<string>()
    const data = reply.ok ? asRecord(reply.result)?.['data'] : undefined
    for (const entry of Array.isArray(data) ? data : []) {
      const record = asRecord(entry)
      const processId = asString(record?.['processId'])
      if (processId === undefined) continue
      listed.add(processId)
      const known = this.#commands.get(processId)
      const command = asString(record?.['command'])
      if (known !== undefined) {
        // The listing names the command as the agent wrote it, without the
        // login-shell wrapper the item carries.
        if (command !== undefined) known.command = command
        continue
      }
      this.#commands.set(processId, {
        processId,
        command: command ?? '',
        backgrounded: true,
        polled: false,
        exited: false,
        exitCode: null,
        exitedBetweenTurns: false,
        reported: false,
      })
    }
    // A server too old to list (or one that failed to) leaves the item stream
    // as the only account, which is still a complete one.
    if (reply.ok) {
      const now = Date.now()
      for (const command of this.#commands.values()) {
        if (!command.exited && !listed.has(command.processId)) command.missingSince ??= now
      }
    }
    this.#evaluate()
  }

  #reportable(command: BackgroundCommand): boolean {
    return (
      command.exited &&
      command.backgrounded &&
      !command.reported &&
      (command.exitedBetweenTurns || !command.polled)
    )
  }

  /**
   * What to do now that no turn is running: wake the agent, hold, or end.
   * Called after every turn end and every report; a no-op while a turn runs,
   * one is starting, or a turn end is still being checked.
   */
  #evaluate(): void {
    if (this.#ended || this.#stopping) return
    if (this.#turnId !== undefined || this.#starting || this.#checking || this.#sending > 0) return

    if (this.#pendingInput.length > 0) {
      // The operator is waiting on this; a report can ride along.
      return void this.#startWake()
    }

    const now = Date.now()
    let overdue = Number.POSITIVE_INFINITY
    let running = 0
    for (const command of this.#commands.values()) {
      if (command.exited) continue
      if (command.missingSince !== undefined && now - command.missingSince >= EXIT_GRACE_MS) {
        // Gone from the listing and never reported. Nothing will report it.
        command.exited = true
        command.reported = true
        continue
      }
      running += 1
      if (command.missingSince !== undefined) {
        overdue = Math.min(overdue, command.missingSince + EXIT_GRACE_MS - now)
      }
    }
    for (const agent of this.#subAgents.values()) if (agent.running) running += 1

    const reports = this.#reports()
    if (reports.commands.length > 0 || reports.agents.length > 0) {
      this.#hold()
      this.#armWake()
      return
    }
    if (running === 0) return void this.#finish('ok')
    this.#hold()
    if (overdue !== Number.POSITIVE_INFINITY) {
      if (this.#recheck !== undefined) clearTimeout(this.#recheck)
      this.#recheck = setTimeout(() => {
        this.#recheck = undefined
        this.#evaluate()
      }, Math.max(0, overdue))
      this.#recheck.unref()
    }
  }

  #reports(): { commands: BackgroundCommand[]; agents: string[] } {
    return {
      commands: [...this.#commands.values()].filter((command) => this.#reportable(command)),
      agents: [...this.#subAgents.entries()]
        .filter(([, agent]) => !agent.running && agent.unseen)
        .map(([thread]) => thread),
    }
  }

  #hold(): void {
    if (this.#held !== undefined) return
    this.#held = 'ok'
    this.#armIdle()
  }

  #armWake(): void {
    if (this.#wake !== undefined) clearTimeout(this.#wake)
    this.#wake = setTimeout(() => {
      this.#wake = undefined
      this.#startWake()
    }, WAKE_DEBOUNCE_MS)
    this.#wake.unref()
  }

  /**
   * One turn carrying everything that is waiting for one: operator text, and
   * the reports. The reports are marked as delivered here, so whatever lands
   * while this turn runs is the next turn's news rather than this one's.
   */
  #startWake(): void {
    if (this.#ended || this.#stopping || this.#turnId !== undefined || this.#starting) return
    if (this.#wake !== undefined) {
      clearTimeout(this.#wake)
      this.#wake = undefined
    }
    const reports = this.#reports()
    const inputs = this.#pendingInput.splice(0)
    if (reports.commands.length > 0 || reports.agents.length > 0) {
      for (const command of reports.commands) command.reported = true
      for (const thread of reports.agents) {
        const agent = this.#subAgents.get(thread)
        if (agent !== undefined) agent.unseen = false
      }
      const text = wakeMessage(reports.commands, reports.agents)
      // Why the agent woke, in the record of the run it woke in.
      this.#queue.push({ type: 'user_message', text })
      inputs.push(text)
    }
    if (inputs.length === 0) return void this.#evaluate()
    void this.#startTurn(inputs)
  }

  #startTurn(texts: readonly string[]): Promise<void> {
    this.#started = this.#openTurn(texts).finally(() => {
      this.#started = undefined
    })
    return this.#started
  }

  async #openTurn(texts: readonly string[]): Promise<void> {
    const threadId = this.#threadId
    if (threadId === undefined) return
    this.#starting = true
    this.#disarmIdle()
    const reply = await this.#rpc.request('turn/start', { threadId, input: texts.map(textInput) })
    this.#starting = false
    if (this.#ended) return
    if (!reply.ok) {
      const refused = REFUSALS.capacity(reply.message)
      if (refused !== undefined) this.#noteRefusal(refused)
      else this.#queue.push(failureEvent(reply.message))
      return void this.#finish('error')
    }
    this.adopt(asString(asRecord(asRecord(reply.result)?.['turn'])?.['id']))
    // It may already have ended: its notifications can be read before this
    // reply's continuation runs.
    if (this.#turnId === undefined) this.#evaluate()
  }

  // -------------------------------------------------------------------------
  // Silence, usage, the end
  // -------------------------------------------------------------------------

  /**
   * A lifecycle notification while held is the server still working; output
   * from a process is not. A dev server logging forever must not hold a lane
   * forever, so only items, turns and status changes reset the silence.
   */
  #touch(method: string): void {
    if (this.#idle === undefined) return
    if (
      method === 'item/started' ||
      method === 'item/completed' ||
      method === 'turn/started' ||
      method === 'turn/completed' ||
      method === 'thread/status/changed'
    ) {
      this.#armIdle()
    }
  }

  /**
   * Silence while held open: the background work never reported. What is
   * left is cleaned up and the session ends the way its last turn did, which
   * is what it would have done before it waited.
   */
  #armIdle(): void {
    this.#disarmIdle()
    this.#idle = setTimeout(() => {
      this.#idle = undefined
      void this.#finish(this.#held ?? 'ok')
    }, this.#idleMs)
    this.#idle.unref()
  }

  #disarmIdle(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    this.#idle = undefined
  }

  /** One `usage` per turn, carrying only what that turn added (§7). */
  #emitUsage(): void {
    const totals = this.#totals
    if (totals === undefined || totals === this.#reportedTotals) return
    this.#queue.push(usageBetween(this.#reportedTotals, totals))
    this.#reportedTotals = totals
  }

  /**
   * The vendor's window closed under this turn (§6.1, `TurnRefusal`).
   *
   * Recorded for the caller and announced in the stream as one fixed token:
   * without the stream line, the transcript of a turn that stopped for a
   * window shows an unexplained error and a run that then waits for hours.
   * First one wins — a limit announced twice is one closed window, and the
   * first report is the one whose reset time was stated.
   */
  #noteRefusal(refusal: TurnRefusal): void {
    if (this.#ended || this.#refusal !== undefined) return
    this.#refusal = refusal
    this.#queue.push({ type: 'error', message: `codex refused mid-turn: ${refusal.reason}` })
  }

  /** The server died. A held session ends the way its last turn did. */
  settleOnExit(diagnostics: string): void {
    this.#rpc.close()
    if (this.#ended) return
    const refused = REFUSALS.capacity(diagnostics)
    if (refused !== undefined) this.#noteRefusal(refused)
    const between = this.#turnId === undefined && !this.#starting
    if (this.#held !== undefined && between && !this.#stopping) return void this.#finish(this.#held)
    if (!this.#stopping) {
      this.#queue.push({ type: 'error', message: 'codex exited before its turn completed' })
    }
    void this.#finish(this.#stopping ? 'interrupted' : 'error')
  }

  /**
   * The stream closes now; the cleanup runs after. The caller is settling a
   * node on `session_ended` and has no reason to wait on a kill — `kill` does,
   * because "nothing left running" is its promise.
   */
  #finish(result: Result): Promise<void> {
    if (this.#teardown !== undefined) return this.#teardown
    this.#ended = true
    this.#disarmIdle()
    for (const timer of [this.#wake, this.#recheck]) if (timer !== undefined) clearTimeout(timer)
    this.#emitUsage()
    this.#queue.push({ type: 'session_ended', result })
    this.#queue.close()
    this.#teardown = this.#cleanUp()
    return this.#teardown
  }

  /**
   * Background terminals first, on every thread, then the process group. The
   * server starts each command in a terminal session of its own, so killing
   * the group alone would leave a backgrounded test suite running with no one
   * left to read it.
   */
  async #cleanUp(): Promise<void> {
    const threads = [this.#threadId, ...this.#subAgents.keys()].filter(
      (thread): thread is string => thread !== undefined,
    )
    await bounded(
      Promise.all(
        threads.map((threadId) => this.#rpc.request('thread/backgroundTerminals/clean', { threadId })),
      ),
      CLEANUP_MS,
      [],
    )
    this.#rpc.close()
    this.#child.stdin?.end()
    signalGroup(this.#child, 'SIGKILL')
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Into the running turn when there is one (`turn/steer`); otherwise it opens
   * the next turn, which is how a held session is continued by hand. A turn
   * that refuses steering — it ended between reading its id and steering it,
   * or it is a kind that cannot be steered — gets the text at its end instead.
   */
  async send(text: string): Promise<void> {
    if (this.#ended) return
    // Ahead of anything still in flight: the operator is reacting to what they
    // just read, so the transcript shows it where they sent it.
    this.#queue.push({ type: 'user_message', text })
    this.#sending += 1
    try {
      // A wake turn being opened is a turn: steer it once it has an id.
      if (this.#started !== undefined) await this.#started
      const turnId = this.#turnId
      const threadId = this.#threadId
      if (turnId !== undefined && threadId !== undefined) {
        const reply = await this.#rpc.request('turn/steer', {
          threadId,
          input: [textInput(text)],
          expectedTurnId: turnId,
        })
        if (reply.ok) return
      }
      if (!this.#ended) this.#pendingInput.push(text)
    } finally {
      this.#sending -= 1
      this.#evaluate()
    }
  }

  async interrupt(): Promise<void> {
    if (this.#ended) return
    this.#stopping = true
    const turnId = this.#turnId
    const threadId = this.#threadId
    if (turnId === undefined || threadId === undefined) return void (await this.#finish('interrupted'))
    void this.#rpc.request('turn/interrupt', { threadId, turnId })
    // A turn deep in a tool call may take a while to stop. The scheduler is
    // waiting on a terminal event, so there is a deadline on being polite.
    setTimeout(() => void this.#finish('interrupted'), CLEANUP_MS).unref()
  }

  async kill(): Promise<void> {
    if (this.#teardown !== undefined) return this.#teardown
    this.#stopping = true
    return this.#finish('interrupted')
  }
}

const pick = (record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const picked: Record<string, unknown> = {}
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) picked[key] = record[key]
  return picked
}

const oneLine = (command: string): string => {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > COMMAND_LIMIT ? `${flat.slice(0, COMMAND_LIMIT)}…` : flat
}

/**
 * What the agent is told when it is woken. Identifiers only — a command line
 * the agent itself wrote, a session id, an exit code, a thread id — never
 * output: the output is the agent's to fetch, through the tool that reads it,
 * so it lands in the transcript the ordinary way and nowhere else.
 */
export function wakeMessage(
  commands: readonly Pick<BackgroundCommand, 'command' | 'processId' | 'exitCode'>[],
  agents: readonly string[],
): string {
  const lines = ['Background work you started has reported since your last turn ended:']
  for (const command of commands) {
    const exit = command.exitCode === null ? 'exited' : `exited with code ${command.exitCode}`
    lines.push(
      `- Background command \`${oneLine(command.command)}\` (session ${command.processId}) ${exit}; call write_stdin with session_id ${command.processId} for its output, unless you already have it.`,
    )
  }
  for (const thread of agents) {
    lines.push(`- Sub-agent ${thread} finished; its reply is in your history.`)
  }
  lines.push('Continue your task from here.')
  return lines.join('\n')
}

/**
 * A child must reach OpenAI through the seat the user logged into, never
 * through an API key that would bill an account nobody chose for this run.
 */
const STRIPPED_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CodexAdapterOptions {
  /** Overrides `VINTA_AI_MAESTRO_CODEX_BIN`, which overrides `"codex"`. */
  readonly bin?: string
  /** How much the agent may do unasked. The operator's choice (`permissions.ts`). */
  readonly permission?: AgentPermission
  /** How long a spawn may take to have a running turn before it is a `transient` refusal. */
  readonly startTimeoutMs?: number
  /**
   * How long a session held open for background work may go without a
   * lifecycle notification before it ends anyway (`CodexSession`). Thirty
   * minutes by default.
   */
  readonly backgroundIdleMs?: number
  readonly preflightTimeoutMs?: number
}

const INSTALL_HINT =
  'npm install -g @openai/codex (or point VINTA_AI_MAESTRO_CODEX_BIN at the binary)'

const UPGRADE_HINT = `npm install -g @openai/codex@latest (vinta-ai-maestro drives \`codex app-server\`, which needs codex-cli ${MIN_VERSION.join('.')} or later)`

const CLIENT_INFO = { name: 'vinta-ai-maestro', title: null, version: '0' }

/** `codex-cli 0.147.0` → `[0, 147, 0]`, or undefined for anything else. */
const parseVersion = (reported: string): readonly [number, number, number] | undefined => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(reported)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

const olderThan = (version: readonly number[], floor: readonly number[]): boolean => {
  for (let index = 0; index < floor.length; index += 1) {
    const have = version[index] ?? 0
    const want = floor[index] ?? 0
    if (have !== want) return have < want
  }
  return false
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex'
  readonly capabilities = CAPABILITIES
  readonly bin: string

  #forced: SpawnRefusalKind | null = null

  constructor(private readonly options: CodexAdapterOptions = {}) {
    this.bin = options.bin ?? process.env['VINTA_AI_MAESTRO_CODEX_BIN'] ?? 'codex'
  }

  /**
   * Fault injection for the contract suite. A vendor cannot be asked for a
   * rate limit on demand, and an unexercised refusal path is one that first
   * runs in production at hour three of a run.
   */
  refuseNext(kind: SpawnRefusalKind): void {
    this.#forced = kind
  }

  /**
   * Three questions, answered in the order an operator fixes them.
   *
   * "Installed" is `--version`: a missing binary, or an alias that is not a
   * binary at all, fails to spawn. "Authenticated" is `codex login status`,
   * which reports on the CLI's own credential store without touching it and
   * without spending a model turn. Only an explicit auth signature flips
   * `authenticated` to false, so an unfamiliar diagnostic cannot lock a
   * working machine out of a run.
   *
   * "Able to run this adapter" is the version floor: the app-server protocol
   * is experimental, and a release older than the one this file was written
   * against may lack the methods it needs. That is reported as not installed —
   * the fix is the same command — but only after the login question, so a
   * machine with both problems is told about the one a person must solve. A
   * version this file cannot parse is not held against it.
   *
   * None of these reads a credential store or performs a login. Every `hint`
   * is a command the *user* runs.
   */
  async preflight(): Promise<PreflightResult> {
    const timeout = this.options.preflightTimeoutMs ?? 20_000
    const version = await probe(this.bin, ['--version'], timeout, childEnv(STRIPPED_ENV))
    if (!version.spawned || version.code !== 0) {
      return { installed: false, authenticated: false, hint: INSTALL_HINT }
    }
    const reported = version.output.trim().split('\n')[0]?.trim()
    const stated = reported === undefined || reported.length === 0 ? {} : { version: reported }

    const login = await probe(this.bin, ['login', 'status'], timeout, childEnv(STRIPPED_ENV))
    if (isAuthFailure(login.output)) {
      return { installed: true, authenticated: false, ...stated, hint: `${this.bin} login` }
    }
    const parsed = reported === undefined ? undefined : parseVersion(reported)
    if (parsed !== undefined && olderThan(parsed, MIN_VERSION)) {
      return { installed: false, authenticated: true, ...stated, hint: UPGRADE_HINT }
    }
    return { installed: true, authenticated: true, ...stated }
  }

  async spawn(task: AgentTask): Promise<SpawnOutcome> {
    const forced = this.#forced
    this.#forced = null
    if (forced !== null) {
      return {
        ok: false,
        kind: forced,
        message: `codex refused to spawn node ${task.nodeId}: ${forced} (injected)`,
      }
    }

    let child: ChildProcess
    try {
      // The platform decides how the binary is reached and whether the child
      // leads a group: on Windows `codex` is a `.cmd` shim behind `cmd.exe`.
      const spec = agentSpawn(this.bin, BASE_ARGS)
      child = spawnChild(spec.file, spec.args, {
        cwd: task.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(STRIPPED_ENV, task.env),
        ...spec.options,
      })
    } catch (error) {
      return classifySpawnFailure(String(error), null, task.nodeId)
    }
    // A closed pipe is how a refused spawn presents; it must not become an
    // unhandled 'error' on the way to being classified.
    child.stdin?.on('error', () => {})
    return await this.#start(child, task)
  }

  /**
   * §9's take over. `codex resume <id>` is the interactive reading of the same
   * thread the app server was driving — which is why the thread is started
   * non-ephemeral: one session, two front ends, never at the same time. The
   * caller interrupts before this and resumes from `handle.sessionId` after.
   */
  async attachPty(sessionId: string, attach: PtyAttach): Promise<PtyHandle> {
    return openPty({
      sessionId,
      file: this.bin,
      args: ['resume', sessionId],
      env: childEnv(STRIPPED_ENV, attach.env),
      attach,
    })
  }

  /**
   * Handshake, thread, first turn — and only then a session. Each step's
   * failure is the server refusing the spawn, so it is classified as one; a
   * session is handed out once there is a turn for it to report on.
   *
   * The resume flag is passed for exactly one failure, the reply to
   * `thread/resume` — the only request that names the id. A server that died
   * on startup, or refused the handshake, did not forget a session (§15.4).
   */
  #start(child: ChildProcess, task: AgentTask): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      const queue = new EventQueue()
      const lines = new JsonLines()
      const rpc = new Rpc(child)
      const session = new CodexSession(
        child,
        rpc,
        queue,
        this.options.backgroundIdleMs ?? BACKGROUND_IDLE_MS,
      )
      let diagnostics = ''
      let settled = false

      const settle = (outcome: SpawnOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!outcome.ok) {
          rpc.close()
          signalGroup(child, 'SIGKILL')
        }
        resolve(outcome)
      }
      // A process that died is described by its exit; a request the server
      // answered with an error, by that error's code.
      const exited = (output: string, code: number | null): void =>
        settle(classifySpawnFailure(output, code, task.nodeId))
      const refused = (reply: { readonly message: string; readonly code: number | null }, resuming = false): void =>
        settle(RPC_REFUSALS.classify(reply.message, reply.code, task.nodeId, { resuming }))

      const timer = setTimeout(() => {
        settle({
          ok: false,
          kind: 'transient',
          message: `codex refused to spawn node ${task.nodeId}: no session within start timeout`,
        })
      }, this.options.startTimeoutMs ?? 120_000)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')

      child.stdout?.on('data', (chunk: string) => {
        for (const frame of lines.push(chunk)) {
          const message = asRecord(frame)
          if (message === undefined) continue
          const isRequest = typeof message['method'] === 'string'
          if (!isRequest) rpc.settle(message)
          else if ('id' in message) session.request(message)
          else session.notification(message)
        }
      })

      child.stderr?.on('data', (chunk: string) => {
        // Kept only long enough to classify a refusal; never emitted as an event.
        diagnostics = `${diagnostics}${chunk}`.slice(-8_000)
      })

      child.on('error', (error) => {
        if (settled) return session.settleOnExit(String(error))
        exited(String(error), null)
      })

      child.on('close', (code) => {
        if (settled) return session.settleOnExit(diagnostics)
        rpc.close()
        exited(diagnostics, code)
      })

      void (async () => {
        const init = await rpc.request('initialize', {
          clientInfo: CLIENT_INFO,
          // The background-terminal methods live behind this.
          capabilities: { experimentalApi: true },
        })
        if (settled) return
        if (!init.ok) return refused(init)
        rpc.notify('initialized')

        // A logged-out server starts a thread and a turn happily and then
        // spends a minute retrying 401s before failing it. Asked first, the
        // same fact is a refusal the operator can act on (§6.1).
        const account = await rpc.request('account/read', {})
        if (settled) return
        if (account.ok) {
          const result = asRecord(account.result)
          if (result?.['account'] === null && result['requiresOpenaiAuth'] === true) {
            return settle(notLoggedIn(task.nodeId))
          }
        }

        const permission = this.options.permission ?? DEFAULT_PERMISSION
        // An empty model defers to the CLI's own configured default. Codex
        // model slugs are account- and plan-gated, so there is no universally
        // valid one to substitute.
        const params = {
          ...(task.model.length === 0 ? {} : { model: task.model }),
          cwd: task.cwd,
          // The policy is the operator's for the run, not the turn's, so a
          // resumed thread is given it again rather than trusted to keep it.
          ...codexThreadPolicy(permission),
        }
        const resuming = task.resumeSessionId !== undefined
        const opened = resuming
          ? await rpc.request('thread/resume', { threadId: task.resumeSessionId, ...params })
          : await rpc.request('thread/start', { ...params, ephemeral: false })
        if (settled) return
        if (!opened.ok) return refused(opened, resuming)
        const threadId = asString(asRecord(asRecord(opened.result)?.['thread'])?.['id'])
        if (threadId === undefined) return refused({ message: 'no thread in reply', code: null })

        queue.push({ type: 'session_started', sessionId: threadId })
        // The operator's words in the record of the run they steered (§5.3,
        // §15) — the same place `send` puts them.
        if (task.operatorText !== undefined) {
          queue.push({ type: 'user_message', text: task.operatorText })
        }
        session.bind(threadId)

        // The prompt goes over the protocol, never argv: a phase brief is long
        // enough to be worth keeping out of the process table and `ARG_MAX`.
        // Queued operator steering (§9) rides the same turn as a second input,
        // labelled as the operator's rather than folded into the brief.
        const input = [textInput(task.prompt)]
        if (task.operatorText !== undefined) input.push(textInput(operatorGuidance(task.operatorText)))
        const turn = await rpc.request('turn/start', { threadId, input })
        if (settled) return
        if (!turn.ok) return refused(turn)
        session.adopt(asString(asRecord(asRecord(turn.result)?.['turn'])?.['id']))
        settle({ ok: true, session })
      })()
    })
  }
}

const notLoggedIn = (nodeId: string): SpawnRefusal => ({
  ok: false,
  kind: 'unauthenticated',
  message: `codex refused to spawn node ${nodeId}: not-authenticated (account)`,
})

const isAuthFailure = (output: string): boolean => REFUSALS.matches('not-authenticated', output)
