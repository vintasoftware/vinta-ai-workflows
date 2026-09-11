/**
 * The `opencode` adapter: an HTTP server supervised once, driven per session.
 *
 * §7 puts this harness in a different shape from the other two. `claude-code`
 * and `codex` are one child process per agent turn; opencode is `opencode
 * serve` plus a session API, which means the unit this adapter supervises is a
 * **server**, and a turn is a session on it. That inversion is the whole file:
 * the process outlives every node that runs against it, so starting it is
 * conditional and stopping it is explicit.
 *
 * Five properties this file exists to guarantee.
 *
 * **The server is started once and reused.** A server is keyed by the lane
 * worktree it serves, because opencode resolves its project from the working
 * directory it was started in and lanes are different worktrees. Lanes are
 * provisioned once per run and reused across nodes (§8), so this is a small
 * fixed number of servers, not one per node. A configured `baseUrl` collapses
 * that to a single server the adapter never owns.
 *
 * **Shutdown leaves nothing behind.** A leaked server holds a port and outlives
 * the run. `close()` aborts the event stream, signals the process group and
 * *waits for the exit*, so a caller that awaits it can assert the port is free
 * rather than hope. `listServers()` exists so that assertion is possible at
 * all. A `process.on('exit')` sweep covers a daemon that forgets.
 *
 * **The binary and the address are configuration, never constants.** Option,
 * then `VINTA_FLOW_OPENCODE_BIN`, then `"opencode"`; and a port is taken from
 * the OS rather than assumed free, because 4096 belongs to whoever bound it
 * first and N lanes cannot all have it.
 *
 * **Unknown server events are ignored, never fatal.** opencode's bus vocabulary
 * is long and growing — LSP, PTY, TUI, file-watcher, VCS. Anything this file
 * has not been taught falls out of the mapping as zero events.
 *
 * **A refusal is classified, not thrown** (§6.1). An HTTP status is a first-
 * class capacity signal here: 429 is `rate_limit`, 401/403 is `fatal`, 5xx is
 * `transient`, and a `Retry-After` header is a stated reset time worth more
 * than any guessed backoff.
 *
 * Nothing here forwards prompt text, file contents or agent output into a
 * refusal message or an error event: those carry node ids, vendor status
 * tokens, error *names* and HTTP codes only. Response bodies are read solely to
 * match a classification pattern and are never quoted into what comes back.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import {
  type AgentEvent,
  type AgentSession,
  type AgentTask,
  HarnessCapabilityError,
  type HarnessAdapter,
  type HarnessCapabilities,
  type PreflightResult,
  type PtyHandle,
  type SpawnOutcome,
  type SpawnRefusal,
  type SpawnRefusalKind,
} from './adapter.ts'
import {
  EventQueue,
  type RefusalSignature,
  agentSpawn,
  asNumber,
  asRecord,
  asString,
  childEnv,
  classifier,
  operatorGuidance,
  probe as probeBin,
  signalGroup,
} from './shared.ts'
import { politeKillFirst } from '../platform/platform.ts'

/**
 * `inject` and `resume` are true because the session API gives both directly:
 * steering is a second prompt on a live session, and resuming is naming its id.
 *
 * `pty` is false — §7 marks it ➖. This adapter manages an HTTP server rather
 * than one supervised process per agent, so there is no pipe to hand a
 * terminal: an interactive `opencode` is a *different* client against the same
 * server, not a takeover of this session. `attachPty` is implemented anyway,
 * and rejects, because a false capability must be loud in the same way `send`
 * and `interrupt` are.
 *
 * `permissionControl` is false, and deliberately so. opencode's permission
 * policy lives in its config and agent definitions, not in anything this
 * adapter sets per spawn; declaring it true would be a promise this code does
 * not keep, and `HarnessCapabilities` exists precisely so the UI greys the
 * button instead of failing when it is pressed.
 */
const CAPABILITIES: HarnessCapabilities = {
  inject: true,
  interrupt: true,
  resume: true,
  pty: false,
  permissionControl: false,
}

/** Tool output can be a whole file. The transcript keeps it; an event carries a look. */
const SUMMARY_LIMIT = 2_000

const INSTALL_HINT =
  'npm install -g opencode-ai (or point VINTA_FLOW_OPENCODE_BIN at the binary)'

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

const summarize = (content: unknown): string => {
  const direct = asString(content)
  const rendered = direct ?? JSON.stringify(content ?? null)
  return rendered.length > SUMMARY_LIMIT ? `${rendered.slice(0, SUMMARY_LIMIT)}…` : rendered
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Server-sent events over a byte stream that splits wherever the OS felt like
 * splitting it. A record is `data:` lines terminated by a blank line; a chunk
 * boundary lands mid-record often enough that treating each read as a whole
 * record is the most common way a client like this corrupts a transcript.
 *
 * Comments (`:` keep-alives) and the fields this adapter does not use (`event`,
 * `id`, `retry`) are dropped rather than parsed.
 */
export class SseFrames {
  #partial = ''
  #data: string[] = []

  push(chunk: string): unknown[] {
    this.#partial += chunk
    const lines = this.#partial.split('\n')
    // The tail is whatever came after the last newline: a partial line, or ''.
    this.#partial = lines.pop() ?? ''
    const parsed: unknown[] = []
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.length === 0) {
        const payload = this.#data.join('\n')
        this.#data = []
        if (payload.length === 0) continue
        try {
          parsed.push(JSON.parse(payload))
        } catch {
          // Not a frame of ours.
        }
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('data:')) this.#data.push(line.slice(5).replace(/^ /, ''))
    }
    return parsed
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * `AgentTask.model` is one string; opencode wants a provider and a model. The
 * split is opencode's own `provider/model` spelling. Anything without a
 * provider is left to the server's configured default rather than guessed at,
 * because guessing a provider is how a run silently bills the wrong account.
 */
export function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const cut = model.indexOf('/')
  if (cut <= 0 || cut >= model.length - 1) return undefined
  return { providerID: model.slice(0, cut), modelID: model.slice(cut + 1) }
}

/**
 * One session's view of the server's bus.
 *
 * The event stream is **server-wide**: every live session on one server sees
 * every other session's events, so filtering by session id is a correctness
 * requirement, not an optimization. It happens here, in the one place that
 * knows the payload shapes, rather than in a demultiplexer that would have to
 * know them a second time.
 *
 * Mapping is stateful because opencode's parts are *cumulative*: a text part is
 * republished with its full text on every token, and a tool part is republished
 * at each status. Emitting an event per update would repeat the whole message
 * once per token, so this tracks what it has already emitted and yields only
 * what is new.
 */
export class OpencodeEventMapper {
  /** part id -> the full text already emitted for it. */
  readonly #text = new Map<string, string>()
  /** callID -> `tool_use` emitted. */
  readonly #started = new Set<string>()
  /** callID -> `tool_result` emitted. */
  readonly #settled = new Set<string>()
  /**
   * message id -> that message's totals, so an update cannot double-count.
   *
   * The cache figures are `undefined` rather than 0 where the message carried
   * none: opencode's `tokens.cache` is populated by the provider, so a model
   * behind a provider that reports nothing must aggregate as unknown and not
   * as a message that read nothing from cache (§15.6).
   */
  readonly #usage = new Map<
    string,
    {
      input: number
      output: number
      cost: number
      cacheRead: number | undefined
      cacheWrite: number | undefined
    }
  >()
  readonly #failed = new Set<string>()
  #errored = false

  constructor(private readonly sessionId: string) {}

  /** Zero or more normalized events. Zero is the right answer for anything unknown. */
  map(raw: unknown): AgentEvent[] {
    const frame = asRecord(raw)
    if (!frame) return []
    const properties = asRecord(frame['properties'])
    if (!properties) return []
    switch (frame['type']) {
      case 'message.part.updated': {
        const part = asRecord(properties['part'])
        if (!part || part['sessionID'] !== this.sessionId) return []
        return this.#mapPart(part)
      }
      case 'message.updated':
        return this.#mapMessage(properties)
      case 'permission.updated': {
        if (properties['sessionID'] !== this.sessionId) return []
        // `type` is the permission class (bash, edit, …). `title` is rendered
        // prose about what the agent wants to do, so it stays out of the field
        // the UI treats as a tool name.
        const tool = asString(properties['type'])
        return tool === undefined ? [] : [{ type: 'permission_request', tool, detail: properties['metadata'] }]
      }
      case 'session.error': {
        // `sessionID` is optional on this event. An unattributed error is not
        // claimed: attributing it would mark every concurrent lane on this
        // server as failed on the strength of a guess, and `session.idle` still
        // terminates the turn either way.
        if (properties['sessionID'] !== this.sessionId) return []
        this.#errored = true
        return [{ type: 'error', message: `opencode session error: ${this.#errorName(properties['error'])}` }]
      }
      case 'session.idle': {
        if (properties['sessionID'] !== this.sessionId) return []
        return [...this.#usageEvents(), { type: 'session_ended', result: this.#errored ? 'error' : 'ok' }]
      }
      default:
        // A bus event this version does not know is not an error.
        return []
    }
  }

  /**
   * The terminal usage event, cumulative across the turn's assistant messages.
   * §7: one per session, from the final frame — per-message figures are the
   * deltas that sum to it, so emitting both makes every consumer double-count.
   */
  #usageEvents(): AgentEvent[] {
    if (this.#usage.size === 0) return []
    let input = 0
    let output = 0
    let cost = 0
    // Left undefined until a message actually reports one, then summed from
    // there: a turn where no message carried cache figures reports none, while
    // a turn where one did reports the sum over those that did. Seeding these
    // at 0 would be the bug §15.6 names — an unreported harness aggregating as
    // a 0% cache hit rate.
    let cacheRead: number | undefined
    let cacheWrite: number | undefined
    for (const totals of this.#usage.values()) {
      input += totals.input
      output += totals.output
      cost += totals.cost
      if (totals.cacheRead !== undefined) cacheRead = (cacheRead ?? 0) + totals.cacheRead
      if (totals.cacheWrite !== undefined) cacheWrite = (cacheWrite ?? 0) + totals.cacheWrite
    }
    return [
      {
        type: 'usage',
        input,
        output,
        ...(cost > 0 ? { costUsd: cost } : {}),
        ...(cacheRead === undefined ? {} : { cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWrite }),
      },
    ]
  }

  #errorName(error: unknown): string {
    // The name is a fixed status token. `data` holds vendor prose and stays out.
    return asString(asRecord(error)?.['name']) ?? 'unknown'
  }

  #mapMessage(properties: Record<string, unknown>): AgentEvent[] {
    const info = asRecord(properties['info'])
    if (!info || info['sessionID'] !== this.sessionId || info['role'] !== 'assistant') return []
    const messageId = asString(info['id'])
    if (messageId === undefined) return []

    const tokens = asRecord(info['tokens'])
    if (tokens) {
      // `tokens.cache` is opencode's own nesting of the two counters; `input`
      // sits outside it and excludes them, so the three sum to the prompt.
      const cache = asRecord(tokens['cache'])
      const cacheRead = cache === undefined ? undefined : asNumber(cache['read'])
      const cacheWrite = cache === undefined ? undefined : asNumber(cache['write'])
      this.#usage.set(messageId, {
        input: asNumber(tokens['input']) ?? 0,
        output: asNumber(tokens['output']) ?? 0,
        cost: asNumber(info['cost']) ?? 0,
        cacheRead,
        cacheWrite,
      })
    }

    const error = asRecord(info['error'])
    if (!error || this.#failed.has(messageId)) return []
    this.#failed.add(messageId)
    this.#errored = true
    return [{ type: 'error', message: `opencode message error: ${this.#errorName(error)}` }]
  }

  /** Whatever this part gained since it was last seen. */
  #appended(id: string, text: string): string | undefined {
    const seen = this.#text.get(id) ?? ''
    if (text === seen) return undefined
    this.#text.set(id, text)
    // A rewritten part (rather than an extended one) is emitted whole: better a
    // repeat in the transcript than a silently dropped correction.
    const next = text.startsWith(seen) ? text.slice(seen.length) : text
    return next.length > 0 ? next : undefined
  }

  #mapPart(part: Record<string, unknown>): AgentEvent[] {
    const id = asString(part['id'])
    switch (part['type']) {
      case 'text': {
        // A synthetic part is the harness talking to itself, not the agent.
        if (id === undefined || part['synthetic'] === true) return []
        const text = asString(part['text'])
        const chunk = text === undefined ? undefined : this.#appended(id, text)
        return chunk === undefined ? [] : [{ type: 'assistant_text', text: chunk }]
      }
      case 'reasoning': {
        if (id === undefined) return []
        const text = asString(part['text'])
        const chunk = text === undefined ? undefined : this.#appended(id, text)
        return chunk === undefined ? [] : [{ type: 'thinking', text: chunk }]
      }
      case 'tool': {
        const callId = asString(part['callID'])
        const name = asString(part['tool'])
        const state = asRecord(part['state'])
        if (callId === undefined || name === undefined || state === undefined) return []
        const status = asString(state['status'])
        const events: AgentEvent[] = []
        // `pending` carries a partial input; announcing the call then would put
        // a half-parsed argument list in the transcript as if it were the call.
        if (status !== undefined && status !== 'pending' && !this.#started.has(callId)) {
          this.#started.add(callId)
          events.push({ type: 'tool_use', id: callId, name, input: state['input'] })
        }
        const done = status === 'completed' || status === 'error'
        if (done && !this.#settled.has(callId)) {
          this.#settled.add(callId)
          events.push({
            type: 'tool_result',
            id: callId,
            ok: status === 'completed',
            summary: summarize(status === 'completed' ? state['output'] : state['error']),
          })
        }
        return events
      }
      default:
        // file, patch, step-start, agent, snapshot, and whatever ships next.
        return []
    }
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
    // when the caller says the failing request carried the resumed id — which
    // here is one request and not the whole spawn: prompting a session the
    // server has pruned 404s, while the server failing to boot must stay a
    // server failure however the task was going to be resumed.
    //
    // A bare 404 is enough *under that guard*, because the URL it came back
    // from was the session's own. Without the guard it would be indefensible:
    // 404 is also what a wrong path or a version mismatch answers.
    kind: 'stale_session',
    reason: 'resume-session-unknown',
    pattern:
      /\b404\b|session[^\n]{0,40}\b(not ?found|not exist|no longer exists|expired|unknown|invalid)\b|unknown session/,
  },
  {
    kind: 'fatal',
    reason: 'binary-not-found',
    // `is not recognized` is cmd.exe's phrasing: on Windows every spawn goes
    // through it, so a missing binary arrives as its output rather than ENOENT.
    pattern: /enoent|command not found|no such file|is not recognized/,
  },
  {
    kind: 'fatal',
    reason: 'not-authenticated',
    pattern:
      /providerautherror|not (logged in|authenticated)|auth login|unauthorized|forbidden|\b40[13]\b|invalid api key|authentication_error|oauth token (has )?expired|credentials? (not found|expired|invalid)/,
  },
  {
    kind: 'quota',
    reason: 'usage-window-exhausted',
    pattern:
      /usage limit reached|usage limit will reset|quota (exceeded|exhausted)|credit balance|out of credits|insufficient_quota|payment required|\b402\b/,
  },
  {
    kind: 'concurrency',
    reason: 'account-concurrency-cap',
    pattern: /too many concurrent|concurrent (session|request|agent)|max(imum)? concurrent/,
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
      /overloaded|\b(500|502|503|504|529)\b|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|temporarily unavailable/,
  },
]

/**
 * `code` is an exit code when a process failed and an HTTP status when a
 * request did; both are non-identifying integers, which is the only reason
 * either is allowed into the message.
 */
const REFUSALS = classifier('opencode', SIGNATURES, (code) => `code ${code ?? 'none'}`)

/**
 * Classify what the server or the binary said on its way out. The default is
 * `fatal` (§7); see `classifier` for why an unrecognized failure must not
 * become a wait.
 */
export const classifySpawnFailure = REFUSALS.classify

const refuse = (kind: SpawnRefusalKind, reason: string, nodeId: string): SpawnRefusal => ({
  ok: false,
  kind,
  message: `opencode refused to spawn node ${nodeId}: ${reason}`,
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type HttpResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: number | null; readonly text: string }

/**
 * One request, with every failure mode collapsed into a value. `text` exists
 * only to be matched against `SIGNATURES`; nothing that comes out of it is ever
 * quoted into a message or an event.
 */
const request = async (url: string, init: RequestInit): Promise<HttpResult> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { ok: false, status: null, text: String(error) }
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after')
    const body = await response.text().catch(() => '')
    return {
      ok: false,
      status: response.status,
      text: `http ${response.status}${retryAfter === null ? '' : ` retry-after: ${retryAfter}`} ${body}`,
    }
  }
  const raw = await response.text().catch(() => '')
  if (raw.length === 0) return { ok: true, body: null }
  try {
    return { ok: true, body: JSON.parse(raw) }
  } catch {
    return { ok: true, body: null }
  }
}

const postJson = (url: string, payload: unknown): Promise<HttpResult> =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

interface HealthResult {
  readonly ok: boolean
  readonly status: number | null
  readonly version?: string
}

const health = async (baseUrl: string): Promise<HealthResult> => {
  const result = await request(`${baseUrl}/global/health`, { method: 'GET' })
  if (!result.ok) return { ok: false, status: result.status }
  const version = asString(asRecord(result.body)?.['version'])
  return { ok: true, status: 200, ...(version === undefined ? {} : { version }) }
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/**
 * A last-resort sweep. `close()` is the contract, but a daemon that exits
 * without calling it must still not leave a server holding a port; this covers
 * a normal exit, which is the case where an orphan would survive longest.
 */
const LIVE_SERVERS = new Set<ChildProcess>()
let sweepInstalled = false

const trackServer = (child: ChildProcess): void => {
  LIVE_SERVERS.add(child)
  child.once('close', () => LIVE_SERVERS.delete(child))
  if (sweepInstalled) return
  sweepInstalled = true
  process.once('exit', () => {
    for (const live of LIVE_SERVERS) signalGroup(live, 'SIGKILL')
  })
}

/**
 * The server must reach every provider through the credentials the user
 * configured in opencode itself, never through an API key inherited from this
 * process that would bill an account nobody chose for this run.
 */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  // Our own server must not demand a password we would then have to hold.
  'OPENCODE_SERVER_PASSWORD',
] as const

/** Ask the OS for a port rather than assuming opencode's default is free. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('no free port'))
      })
    })
  })

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

interface Subscriber {
  readonly event: (raw: unknown) => void
  /** The stream ended while this session was still live. */
  readonly lost: () => void
}

/**
 * One `opencode serve` process (or one address someone else owns) plus the
 * single event stream every session on it shares.
 */
class OpencodeServer {
  readonly #subscribers = new Set<Subscriber>()
  #stream: AbortController | null = null
  #stopped = false

  constructor(
    readonly baseUrl: string,
    /** null when the address was configured: an adapter never stops what it did not start. */
    readonly child: ChildProcess | null,
    private readonly onLost: () => void,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  /** Resolves once the stream is established, so a caller can prompt without racing it. */
  async listen(): Promise<void> {
    const controller = new AbortController()
    this.#stream = controller
    const response = await fetch(`${this.baseUrl}/event`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    })
    if (!response.ok || response.body === null) {
      controller.abort()
      throw new Error(`http ${response.status} opencode event stream`)
    }
    void this.#pump(response.body)
  }

  async #pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const frames = new SseFrames()
    const decoder = new TextDecoder()
    const reader = body.getReader()
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done === true) break
        for (const raw of frames.push(decoder.decode(step.value, { stream: true }))) {
          for (const subscriber of [...this.#subscribers]) subscriber.event(raw)
        }
      }
    } catch {
      // Aborted by `stop`, or the connection dropped. Both end the same way.
    }
    if (this.#stopped) return
    for (const subscriber of [...this.#subscribers]) subscriber.lost()
    this.onLost()
  }

  /**
   * Idempotent, and **awaits the exit**: the point of returning a promise is
   * that a caller can assert the port is free afterwards rather than hope.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    this.#stream?.abort()
    this.#stream = null
    this.#subscribers.clear()

    const child = this.child
    if (child === null) return
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = []
      const settle = (): void => {
        for (const timer of timers) clearTimeout(timer)
        resolve()
      }
      child.once('close', settle)

      if (politeKillFirst()) {
        signalGroup(child, 'SIGTERM')
        // A server mid-request may take its time; the port must be free when
        // this resolves, so politeness has a deadline.
        timers.push(setTimeout(() => signalGroup(child, 'SIGKILL'), 2_000))
      } else {
        // One blow, because a polite one would orphan the server rather than
        // end it — see `politeKillFirst`.
        signalGroup(child, 'SIGKILL')
      }

      // **`close` may never come, so waiting on it alone is a hang.** It needs
      // the process gone *and* its stdio ended, and anything that survives the
      // kill still holds the pipes it inherited. That is not hypothetical: on
      // Windows the child is `cmd.exe` and the server is beneath it, and a
      // daemon shutting down used to wait here for as long as the server lived.
      // Giving up is the honest outcome — the caller asked for the server to be
      // stopped, and it has been told to stop.
      timers.push(setTimeout(settle, 10_000))
      for (const timer of timers) timer.unref()
    })
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

class OpencodeSession implements AgentSession {
  readonly #queue = new EventQueue()
  readonly #mapper: OpencodeEventMapper
  #release: (() => void) | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  #taken = false
  #ended = false
  #stopping = false

  constructor(
    readonly id: string,
    private readonly server: OpencodeServer,
    private readonly interruptTimeoutMs: number,
  ) {
    this.#mapper = new OpencodeEventMapper(id)
    // First, and before anything can be ingested: the contract frames every
    // stream with this event.
    this.#queue.push({ type: 'session_started', sessionId: id })
  }

  /** Subscribed before the prompt is sent, so no event of this turn is missed. */
  attach(): void {
    this.#release = this.server.subscribe({
      event: (raw) => this.#ingest(raw),
      lost: () => this.#lost(),
    })
  }

  detach(): void {
    this.#release?.()
    this.#release = null
  }

  /**
   * Operator steering delivered with the opening prompt (§9), recorded in the
   * transcript as the operator's own message — the same place `send` puts it.
   * Only the record: the text itself rides the prompt request.
   */
  noteOperator(text: string): void {
    if (this.#ended) return
    this.#queue.push({ type: 'user_message', text })
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

  #url(suffix: string): string {
    return `${this.server.baseUrl}/session/${encodeURIComponent(this.id)}${suffix}`
  }

  #ingest(raw: unknown): void {
    if (this.#ended) return
    for (const event of this.#mapper.map(raw)) {
      if (event.type === 'session_ended') {
        this.#finish(this.#stopping ? 'interrupted' : event.result)
        return
      }
      this.#queue.push(event)
    }
  }

  #lost(): void {
    if (this.#ended) return
    if (!this.#stopping) {
      this.#queue.push({ type: 'error', message: 'opencode event stream ended before the turn completed' })
    }
    this.#finish(this.#stopping ? 'interrupted' : 'error')
  }

  #finish(result: 'ok' | 'error' | 'interrupted'): void {
    this.#ended = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#queue.push({ type: 'session_ended', result })
    this.#queue.close()
    this.detach()
  }

  async send(text: string): Promise<void> {
    if (this.#ended) return
    // Ahead of anything still in flight from the server: the operator is
    // reacting to what they just read, so the transcript shows it where they
    // sent it (§15).
    this.#queue.push({ type: 'user_message', text })
    const result = await postJson(this.#url('/prompt_async'), {
      parts: [{ type: 'text', text }],
    })
    if (!result.ok && !this.#ended) {
      // The status is a code, not prose. What the operator typed is already in
      // the transcript above; nothing about it goes into this message.
      this.#queue.push({
        type: 'error',
        message: `opencode rejected an injected message (code ${result.status ?? 'none'})`,
      })
    }
  }

  async interrupt(): Promise<void> {
    if (this.#ended) return
    this.#stopping = true
    // **Not awaited, deliberately.** `request()` carries no timeout, so a
    // server that has stopped answering would hold this promise — and with it
    // the operator's interrupt, and §9's takeover, which interrupts before it
    // attaches — open indefinitely. The thing an interrupt must never be is
    // slower than the thing it is interrupting.
    //
    // The cost is that resolving says the abort was *sent*, not delivered. A
    // test reading the server's side the instant the turn ends is therefore
    // asserting a race it can lose; `tests/harness-opencode.test.ts` waits.
    void postJson(this.#url('/abort'), {})
    // The scheduler is waiting on a terminal event; a server that never reports
    // idle must not hold a node open forever.
    this.#timer = setTimeout(() => this.#finish('interrupted'), this.interruptTimeoutMs)
    this.#timer.unref()
  }

  async kill(): Promise<void> {
    if (this.#ended) return
    this.#stopping = true
    void postJson(this.#url('/abort'), {})
    this.#finish('interrupted')
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpencodeAdapterOptions {
  /** Overrides `VINTA_FLOW_OPENCODE_BIN`, which overrides `"opencode"`. */
  readonly bin?: string
  /**
   * An already-running server. When set the adapter starts nothing and stops
   * nothing — it is somebody else's process.
   */
  readonly baseUrl?: string
  /** Bind address for servers this adapter starts. Loopback by default (§11). */
  readonly hostname?: string
  /** Fixed port instead of one taken from the OS. Only usable with one server. */
  readonly port?: number
  /** Where a server is started when no task names a lane — preflight's directory. */
  readonly cwd?: string
  readonly startTimeoutMs?: number
  readonly preflightTimeoutMs?: number
  readonly interruptTimeoutMs?: number
}

type BootFailure = { readonly failed: true; readonly refuse: (nodeId: string) => SpawnRefusal }

const bootFailure = (text: string, code: number | null): BootFailure => ({
  failed: true,
  refuse: (nodeId) => classifySpawnFailure(text, code, nodeId),
})

const bootRefusal = (kind: SpawnRefusalKind, reason: string): BootFailure => ({
  failed: true,
  refuse: (nodeId) => refuse(kind, reason, nodeId),
})

/** One key for every task when the address is configured: there is only one server. */
const EXTERNAL_KEY = ' external'

export class OpencodeAdapter implements HarnessAdapter {
  readonly id = 'opencode'
  readonly capabilities = CAPABILITIES
  readonly bin: string

  readonly #servers = new Map<string, OpencodeServer>()
  readonly #booting = new Map<string, Promise<OpencodeServer | BootFailure>>()
  #forced: SpawnRefusalKind | null = null

  constructor(private readonly options: OpencodeAdapterOptions = {}) {
    this.bin = options.bin ?? process.env['VINTA_FLOW_OPENCODE_BIN'] ?? 'opencode'
  }

  /**
   * Fault injection for the contract suite. A vendor cannot be asked for a rate
   * limit on demand, and an unexercised refusal path is one that first runs in
   * production at hour three of a run.
   */
  refuseNext(kind: SpawnRefusalKind): void {
    this.#forced = kind
  }

  /**
   * §9's take over, refused. `capabilities.pty` is false and this is the
   * mechanism that makes that a promise rather than a note: a caller must
   * never be able to mistake "this harness cannot do that" for "delivered".
   */
  async attachPty(_sessionId: string): Promise<PtyHandle> {
    throw new HarnessCapabilityError(this.id, 'pty')
  }

  /**
   * Every server this adapter currently owns or uses. Exists so "shutdown left
   * no orphan" is an assertion rather than an assumption.
   */
  listServers(): readonly { readonly baseUrl: string; readonly pid: number | undefined }[] {
    return [...this.#servers.values()].map((server) => ({ baseUrl: server.baseUrl, pid: server.pid }))
  }

  /** Stops every server this adapter started, and waits for each to be gone. */
  async close(): Promise<void> {
    const servers = [...this.#servers.values()]
    this.#servers.clear()
    this.#booting.clear()
    await Promise.all(servers.map((server) => server.stop()))
  }

  /**
   * Two questions, two mechanisms.
   *
   * "Installed" is `--version` on the binary — or, where the address was
   * configured, `/global/health` on it. "Authenticated" is `/config/providers`:
   * opencode reports which providers it has credentials for, and an empty list
   * is a machine nobody has logged in on.
   *
   * Neither branch reads a credential store or performs a login. The `hint` is
   * the command the *user* runs.
   */
  async preflight(): Promise<PreflightResult> {
    const external = this.options.baseUrl !== undefined
    let version: string | undefined

    if (!external) {
      const probe = await probeBin(
        this.bin,
        ['--version'],
        this.options.preflightTimeoutMs ?? 20_000,
        childEnv(STRIPPED_ENV),
      )
      if (!probe.spawned || probe.code !== 0) {
        return { installed: false, authenticated: false, hint: INSTALL_HINT }
      }
      const reported = probe.output.trim().split('\n')[0]?.trim()
      if (reported !== undefined && reported.length > 0) version = reported
    }

    const server = await this.#server(this.options.cwd ?? process.cwd())
    if (!(server instanceof OpencodeServer)) {
      return {
        // A binary that answers `--version` is installed even when its server
        // will not come up; a configured address that will not answer is not.
        installed: !external,
        authenticated: false,
        ...(version === undefined ? {} : { version }),
        hint: external ? `start an opencode server at ${this.options.baseUrl ?? ''}` : INSTALL_HINT,
      }
    }

    const reported = await health(server.baseUrl)
    const resolved = version ?? reported.version
    const providers = await request(`${server.baseUrl}/config/providers`, { method: 'GET' })
    const listed = providers.ok ? asRecord(providers.body)?.['providers'] : undefined
    const authenticated = Array.isArray(listed) && listed.length > 0

    return {
      installed: true,
      authenticated,
      ...(resolved === undefined ? {} : { version: resolved }),
      ...(authenticated ? {} : { hint: `${this.bin} auth login` }),
    }
  }

  async spawn(task: AgentTask): Promise<SpawnOutcome> {
    const forced = this.#forced
    this.#forced = null
    if (forced !== null) {
      return {
        ok: false,
        kind: forced,
        message: `opencode refused to spawn node ${task.nodeId}: ${forced} (injected)`,
      }
    }

    const server = await this.#server(task.cwd)
    if (!(server instanceof OpencodeServer)) return server.refuse(task.nodeId)

    let sessionId = task.resumeSessionId
    if (sessionId === undefined) {
      // The title is the node id and nothing else: it is stored, listed and
      // rendered, and the phase brief is not going into any of those.
      const created = await postJson(`${server.baseUrl}/session`, { title: `vinta-flow ${task.nodeId}` })
      if (!created.ok) return classifySpawnFailure(created.text, created.status, task.nodeId)
      sessionId = asString(asRecord(created.body)?.['id'])
      if (sessionId === undefined) return refuse('fatal', 'session-id-missing', task.nodeId)
    }

    const session = new OpencodeSession(sessionId, server, this.options.interruptTimeoutMs ?? 2_000)
    // Subscribed first: an event that arrives between the prompt landing and
    // the subscription being made is an event the transcript never gets.
    session.attach()
    // Queued operator steering (§9) is a second, labelled part of the same
    // request rather than a second round trip: one POST cannot land half of
    // an operator's correction. `inject` being true does not make this
    // redundant — a node resumed after a capacity wait had no live session
    // when the operator typed, so this spawn is its only delivery.
    if (task.operatorText !== undefined) session.noteOperator(task.operatorText)

    const model = parseModel(task.model)
    const prompt = await postJson(`${server.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      parts: [
        { type: 'text', text: task.prompt },
        ...(task.operatorText === undefined
          ? []
          : [{ type: 'text', text: operatorGuidance(task.operatorText) }]),
      ],
      ...(model === undefined ? {} : { model }),
    })
    if (!prompt.ok) {
      session.detach()
      // The only request in this spawn addressed to an id the caller handed
      // us, so the only one whose failure can mean the id is stale (§15.4).
      // A session this adapter just created cannot be stale, however the
      // request failed — hence the flag tracks the *resume*, not the URL.
      return classifySpawnFailure(prompt.text, prompt.status, task.nodeId, {
        resuming: task.resumeSessionId !== undefined,
      })
    }

    return { ok: true, session }
  }

  /**
   * One server per lane worktree, booted at most once however many spawns race.
   *
   * A failure comes back as a *function of the node id* rather than a finished
   * message: a boot shared by racing spawns must not stamp the id of whichever
   * node triggered it onto every other node's refusal.
   */
  async #server(cwd: string): Promise<OpencodeServer | BootFailure> {
    const key = this.options.baseUrl === undefined ? cwd : EXTERNAL_KEY
    const running = this.#servers.get(key)
    if (running !== undefined) return running

    const booting = this.#booting.get(key) ?? this.#boot(cwd, key)
    this.#booting.set(key, booting)
    try {
      return await booting
    } catch (error) {
      return bootFailure(String(error), null)
    } finally {
      this.#booting.delete(key)
    }
  }

  async #boot(cwd: string, key: string): Promise<OpencodeServer | BootFailure> {
    const configured = this.options.baseUrl
    if (configured !== undefined) {
      const baseUrl = configured.replace(/\/+$/, '')
      const probe = await health(baseUrl)
      if (!probe.ok) return bootFailure(`http ${probe.status ?? 'unreachable'} opencode server`, probe.status)
      const server = new OpencodeServer(baseUrl, null, () => this.#drop(key))
      try {
        await server.listen()
      } catch (error) {
        return bootFailure(String(error), null)
      }
      this.#servers.set(key, server)
      return server
    }

    let port: number
    try {
      port = this.options.port ?? (await freePort())
    } catch (error) {
      return bootFailure(String(error), null)
    }
    const hostname = this.options.hostname ?? '127.0.0.1'

    let child: ChildProcess
    try {
      // The platform decides how the binary is reached and whether the child
      // leads a group: on Windows `opencode` is a `.cmd` shim behind `cmd.exe`.
      const spec = agentSpawn(this.bin, ['serve', '--hostname', hostname, '--port', String(port)])
      child = spawnChild(spec.file, spec.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(STRIPPED_ENV),
        ...spec.options,
      })
    } catch (error) {
      return bootFailure(String(error), null)
    }
    trackServer(child)

    let diagnostics = ''
    let exited: number | null | undefined
    const collect = (chunk: string): void => {
      // Kept only long enough to classify a refusal; never emitted as an event.
      diagnostics = `${diagnostics}${chunk}`.slice(-8_000)
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => collect(String(error)))
    child.on('close', (code) => {
      exited = code
    })

    const baseUrl = `http://${hostname}:${port}`
    const server = new OpencodeServer(baseUrl, child, () => this.#drop(key))
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 30_000)

    for (;;) {
      if (exited !== undefined) return bootFailure(diagnostics, exited)
      if ((await health(baseUrl)).ok) break
      if (Date.now() >= deadline) {
        await server.stop()
        return bootRefusal('transient', 'server-start-timeout')
      }
      await delay(100)
    }

    try {
      await server.listen()
    } catch (error) {
      await server.stop()
      return bootFailure(String(error), null)
    }
    this.#servers.set(key, server)
    return server
  }

  /**
   * The event stream is the only way a session learns anything, so losing it
   * means the server is no longer usable even if the process is alive. Retiring
   * it — rather than reconnecting to it — is what keeps the next spawn from
   * booting a second server while the first one still holds a port.
   */
  #drop(key: string): void {
    const server = this.#servers.get(key)
    if (server === undefined) return
    this.#servers.delete(key)
    void server.stop()
  }
}
