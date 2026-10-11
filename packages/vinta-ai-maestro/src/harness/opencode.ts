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
 * then `VINTA_AI_MAESTRO_OPENCODE_BIN`, then `"opencode"`; and a port is taken from
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
  type TurnRefusal,
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
import { OPENCODE_COMPACTION_ENV } from './compaction.ts'
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
 *
 * `autoCompact` is true on a narrower reading than the one that made
 * `permissionControl` false, and the difference is worth being explicit about.
 * opencode compacts by default — the server decides it, so a headless run gets
 * it exactly as a TUI one does — and the server's environment is the one thing
 * here this adapter *does* own, so `OPENCODE_DISABLE_AUTOCOMPACT` is stripped
 * from it. What the adapter still cannot reach is `compaction.auto: false` in a
 * project's own `opencode.json`, which is the same config boundary that decided
 * `permissionControl`, and which `OPENCODE_CONFIG_CAVEAT` records rather than
 * papers over.
 *
 * `backgroundWork` is per instance, and the same boundary decides it. A server
 * this adapter starts gets `BACKGROUND_ENV`, so the `task` tool there can run a
 * sub-agent in the background and wake the parent when it is done. A configured
 * `baseUrl` is somebody else's process with somebody else's environment, and a
 * true there would be a promise resting on a variable this code never set.
 */
const CAPABILITIES: Omit<HarnessCapabilities, 'backgroundWork'> = {
  inject: true,
  interrupt: true,
  resume: true,
  pty: false,
  permissionControl: false,
  autoCompact: true,
}

/**
 * opencode's background sub-agents are behind an experimental switch, and the
 * server reads it from its own environment. Set to `true` explicitly rather
 * than relying on the umbrella `OPENCODE_EXPERIMENTAL`: the specific variable
 * wins over the umbrella in either direction, so an inherited `=false` would
 * otherwise turn the feature off for every lane the server hosts, and the
 * prompts would still be telling the agents it is there.
 */
const BACKGROUND_ENV = { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true' } as const

/**
 * How long a session held open for background work may go without a frame
 * before it is ended anyway. Long enough for a sub-agent reviewing a large
 * change; one at work publishes its parts well inside it.
 */
const BACKGROUND_IDLE_MS = 30 * 60_000

/**
 * The text of the synthetic user message opencode injects into the parent when
 * a background task finishes: `<task id="<child session>" state="…">`. A task
 * that was cancelled injects nothing, which is why a child's `session.deleted`
 * is the other way out of the pending set.
 */
const BACKGROUND_RESULT = /^<task id="([^"]+)" state="(?:completed|error)">/

/**
 * Parts held for a message whose role has not been announced yet. opencode
 * publishes a message before its parts, so this is a guard rather than a path;
 * the cap keeps a misbehaving server from growing it without end.
 */
const UNROUTED_LIMIT = 200

/** Tool output can be a whole file. The transcript keeps it; an event carries a look. */
const SUMMARY_LIMIT = 2_000

const INSTALL_HINT =
  'npm install -g opencode-ai (or point VINTA_AI_MAESTRO_OPENCODE_BIN at the binary)'

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
 *
 * **A part is routed by the role of its message.** opencode publishes the
 * user's own prompt as `message.part.updated` too, so a text part is not the
 * agent speaking until its message is known to be the assistant's. Mapped
 * blindly, the prompt was echoed as `assistant_text` — and a review prompt
 * carries the literal line `VERDICT: pass`, which the verdict reader would take
 * as an approval the agent never gave. A part whose message has not been
 * announced yet waits for it.
 *
 * **`session_ended` here is the end of a turn.** Whether it ends the session is
 * `OpencodeSession`'s call, made from what this mapper tracks alongside: the
 * background tasks still running, and whether the prompt was answered.
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
  readonly #usage = new Map<string, UsageTotals>()
  /** message id -> the totals already reported in an earlier turn's `usage`. */
  readonly #reported = new Map<string, UsageTotals>()
  /** Messages whose totals moved since the last `usage` was emitted. */
  readonly #dirty = new Set<string>()
  readonly #failed = new Set<string>()
  /** message id -> role, from `message.updated`. */
  readonly #roles = new Map<string, 'user' | 'assistant'>()
  /** message id -> parts that arrived before their message was announced. */
  readonly #unrouted = new Map<string, Record<string, unknown>[]>()
  #unroutedCount = 0
  /** Child session ids of background tasks that have not reported. */
  readonly #pending = new Set<string>()
  /** Task calls that already registered a child, so a republished part cannot register it twice. */
  readonly #registered = new Set<string>()
  #sawBackground = false
  #assistantMessages = 0
  #activity = 0
  #refusal: TurnRefusal | undefined
  #errored = false

  constructor(private readonly sessionId: string) {}

  /** Background tasks this session started that have not reported back. */
  get pendingBackground(): number {
    return this.#pending.size
  }

  /** A background task was started at some point in this session. */
  get sawBackground(): boolean {
    return this.#sawBackground
  }

  /** Assistant messages seen on this session. Zero means the prompt has not been answered. */
  get assistantMessages(): number {
    return this.#assistantMessages
  }

  /** Bumped each time this session reports itself busy: a turn is running. */
  get activity(): number {
    return this.#activity
  }

  /**
   * The frame is about this session or about a background task it is waiting
   * on. The latter is the work making progress, which is what a held session's
   * silence bound is measuring.
   */
  concerns(raw: unknown): boolean {
    const properties = asRecord(asRecord(raw)?.['properties'])
    if (!properties) return false
    const id =
      asString(properties['sessionID']) ??
      asString(asRecord(properties['part'])?.['sessionID']) ??
      asString(asRecord(properties['info'])?.['sessionID'])
    return id !== undefined && (id === this.sessionId || this.#pending.has(id))
  }

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
        return this.#routePart(part)
      }
      case 'message.updated':
        return this.#mapMessage(properties)
      // `permission.updated` is what older servers publish and `permission.asked`
      // what 1.19 does; the payloads differ only in where the class is. Both
      // stay, because which server answers is not this adapter's choice.
      case 'permission.updated': {
        if (properties['sessionID'] !== this.sessionId) return []
        // `type` is the permission class (bash, edit, …). `title` is rendered
        // prose about what the agent wants to do, so it stays out of the field
        // the UI treats as a tool name.
        const tool = asString(properties['type'])
        return tool === undefined ? [] : [{ type: 'permission_request', tool, detail: properties['metadata'] }]
      }
      case 'permission.asked': {
        if (properties['sessionID'] !== this.sessionId) return []
        const tool = asString(properties['permission'])
        return tool === undefined ? [] : [{ type: 'permission_request', tool, detail: properties['metadata'] }]
      }
      case 'session.status': {
        if (properties['sessionID'] !== this.sessionId) return []
        const status = asString(asRecord(properties['status'])?.['type'])
        if (status === 'busy' || status === 'retry') this.#activity += 1
        return []
      }
      case 'session.deleted': {
        // A cancelled task injects nothing; its child going away is the only
        // word that it is not coming back.
        const id = asString(properties['sessionID']) ?? asString(asRecord(properties['info'])?.['id'])
        if (id !== undefined) this.#pending.delete(id)
        return []
      }
      case 'session.compacted': {
        // Filtered by session id like everything else on this bus, and for the
        // sharper reason: the server is shared by every lane on this worktree,
        // so an unfiltered compaction would mark some *other* lane's session as
        // having forgotten its brief.
        if (properties['sessionID'] !== this.sessionId) return []
        // The payload is `{ sessionID }` and nothing else — no token counts and
        // no trigger — so both optional fields are left off rather than
        // invented, and the trigger is `auto` because this server compacts for
        // exactly one reason. A human asking is `POST /session/:id/summarize`,
        // which this adapter never calls.
        return [{ type: 'context_compacted', trigger: 'auto' }]
      }
      case 'session.error': {
        // `sessionID` is optional on this event. An unattributed error is not
        // claimed: attributing it would mark every concurrent lane on this
        // server as failed on the strength of a guess, and `session.idle` still
        // terminates the turn either way.
        if (properties['sessionID'] !== this.sessionId) return []
        this.#errored = true
        // §6.1: the server's window can close under a running turn, and that is
        // a wait rather than a failed phase. Read from `data`, which is where
        // the sentence is — matched against the table and dropped, never
        // carried, exactly as `#errorName` refuses to carry it.
        const refused = REFUSALS.capacity(this.#errorProse(properties['error']))
        if (refused !== undefined) this.#noteRefusal(refused)
        return [{ type: 'error', message: `opencode session error: ${this.#errorName(properties['error'])}` }]
      }
      case 'session.idle': {
        // A child's idle never gets here: it carries the child's id. That
        // matters, because a background child goes idle *before* the server
        // injects its result into this session.
        if (properties['sessionID'] !== this.sessionId) return []
        return [...this.#usageEvents(), { type: 'session_ended', result: this.#errored ? 'error' : 'ok' }]
      }
      default:
        // A bus event this version does not know is not an error.
        return []
    }
  }

  /**
   * What this turn added to the session's usage. §7: one per turn, from its
   * terminal frame — per-message figures are the deltas that sum to it, so
   * emitting both makes every consumer double-count. A session held open for
   * background work has several turns, so each event carries only what moved
   * since the last one: a message counted in an earlier turn and republished
   * since is counted for its difference, never again whole.
   */
  #usageEvents(): AgentEvent[] {
    if (this.#dirty.size === 0) return []
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
    for (const id of this.#dirty) {
      const totals = this.#usage.get(id)
      if (totals === undefined) continue
      const before = this.#reported.get(id)
      input += totals.input - (before?.input ?? 0)
      output += totals.output - (before?.output ?? 0)
      cost += totals.cost - (before?.cost ?? 0)
      if (totals.cacheRead !== undefined) {
        cacheRead = (cacheRead ?? 0) + totals.cacheRead - (before?.cacheRead ?? 0)
      }
      if (totals.cacheWrite !== undefined) {
        cacheWrite = (cacheWrite ?? 0) + totals.cacheWrite - (before?.cacheWrite ?? 0)
      }
      this.#reported.set(id, totals)
    }
    this.#dirty.clear()
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

  /**
   * The vendor prose inside an error, for pattern matching only.
   *
   * `#errorName` keeps `data` out of every event and log line, and that rule
   * stands: what comes back here is read against the refusal table and then
   * dropped. `name` is included because the server states some conditions in
   * the token alone.
   *
   * `JSON.stringify` rather than a walk of known fields: `data` has no fixed
   * shape, the sentence appears under `message` in some releases and deeper in
   * others, and a missed match here is a node that fails instead of waiting.
   */
  #errorProse(error: unknown): string {
    const record = asRecord(error)
    if (record === undefined) return ''
    try {
      return `${asString(record['name']) ?? ''} ${JSON.stringify(record['data'] ?? '')}`
    } catch {
      // A cyclic or unserializable payload is no reason to lose the token.
      return asString(record['name']) ?? ''
    }
  }

  get refusal(): TurnRefusal | undefined {
    return this.#refusal
  }

  /**
   * The server's window closed under this turn (§6.1, `TurnRefusal`).
   *
   * Recorded for the caller; the `error` event this sits beside already says
   * something happened, so nothing extra is pushed into the stream. First one
   * wins — a limit announced twice is one closed window, and the first report
   * is the one whose reset time was stated.
   */
  #noteRefusal(refusal: TurnRefusal): void {
    this.#refusal ??= refusal
  }

  #mapMessage(properties: Record<string, unknown>): AgentEvent[] {
    const info = asRecord(properties['info'])
    if (!info || info['sessionID'] !== this.sessionId) return []
    const messageId = asString(info['id'])
    const role = info['role']
    if (messageId === undefined || (role !== 'assistant' && role !== 'user')) return []

    const events: AgentEvent[] = []
    if (!this.#roles.has(messageId)) {
      this.#roles.set(messageId, role)
      if (role === 'assistant') this.#assistantMessages += 1
      const waiting = this.#unrouted.get(messageId)
      if (waiting !== undefined) {
        this.#unrouted.delete(messageId)
        this.#unroutedCount -= waiting.length
        for (const part of waiting) events.push(...this.#mapPart(part, role))
      }
    }
    if (role !== 'assistant') return events

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
      this.#dirty.add(messageId)
    }

    const error = asRecord(info['error'])
    if (!error || this.#failed.has(messageId)) return events
    this.#failed.add(messageId)
    this.#errored = true
    events.push({ type: 'error', message: `opencode message error: ${this.#errorName(error)}` })
    return events
  }

  /**
   * A part whose message has not been announced is held, not guessed at: a
   * user's prompt read as the agent's words is worse than a line arriving a
   * frame late. A part with no message id cannot be routed at all and is
   * dropped — every part opencode publishes carries one.
   */
  #routePart(part: Record<string, unknown>): AgentEvent[] {
    const messageId = asString(part['messageID'])
    if (messageId === undefined) return []
    const role = this.#roles.get(messageId)
    if (role !== undefined) return this.#mapPart(part, role)
    if (this.#unroutedCount >= UNROUTED_LIMIT) return []
    const waiting = this.#unrouted.get(messageId) ?? []
    waiting.push(part)
    this.#unrouted.set(messageId, waiting)
    this.#unroutedCount += 1
    return []
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

  /**
   * A `task` call that runs, or was moved, into the background. The metadata
   * names the child session, and the call registers it once: opencode
   * republishes a tool part at every status and again when it prunes old
   * output, and a finished child must not come back as pending from a repeat.
   * A new call naming the same child — resuming a sub-agent that had finished
   * — is new work and registers again.
   */
  #trackBackground(callId: string, name: string, state: Record<string, unknown>): void {
    if (name !== 'task' || this.#registered.has(callId)) return
    const metadata = asRecord(state['metadata'])
    if (metadata?.['background'] !== true) return
    const child = asString(metadata['sessionId'])
    if (child === undefined) return
    this.#registered.add(callId)
    this.#pending.add(child)
    this.#sawBackground = true
  }

  #mapPart(part: Record<string, unknown>, role: 'user' | 'assistant'): AgentEvent[] {
    const id = asString(part['id'])
    if (role === 'user') {
      // Never the agent's words. The one thing a user message says that this
      // adapter needs is the server reporting a background task done.
      if (part['type'] === 'text' && part['synthetic'] === true) {
        const reported = BACKGROUND_RESULT.exec(asString(part['text']) ?? '')
        if (reported?.[1] !== undefined) this.#pending.delete(reported[1])
      }
      return []
    }
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
        // A pruned part is an old result republished with its output dropped:
        // nothing new happened, and on a resumed session it is a call from an
        // earlier spawn this mapper never announced.
        if (asRecord(state['time'])?.['compacted'] !== undefined) return []
        this.#trackBackground(callId, name, state)
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

interface UsageTotals {
  readonly input: number
  readonly output: number
  readonly cost: number
  readonly cacheRead: number | undefined
  readonly cacheWrite: number | undefined
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
    kind: 'unauthenticated',
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
 *
 * The compaction switch at the end is not about credentials and is here because
 * the mechanism is the same one. It is stripped from the *server's* environment
 * rather than a session's, which is the level that matters: the server is what
 * decides a session has overflowed, so one inherited variable would disable
 * compaction for every lane that server is hosting at once (`compaction.ts`).
 */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  // Our own server must not demand a password we would then have to hold.
  'OPENCODE_SERVER_PASSWORD',
  ...OPENCODE_COMPACTION_ENV,
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

interface SessionOptions {
  readonly interruptTimeoutMs: number
  readonly backgroundIdleMs: number
  /** What the prompt named, so a re-prompt runs on the same model. */
  readonly model: { readonly providerID: string; readonly modelID: string } | undefined
}

/**
 * One opencode session, which may span several turns (`backgroundWork`).
 *
 * **`session.idle` ends a turn, not necessarily the session.** An agent that
 * starts a sub-agent with `task` in the background gets the call back at once
 * and usually ends its turn; the server keeps the sub-agent running and, when
 * it finishes, injects its result into this session as a synthetic user
 * message and starts the next turn by itself. Ending on the first idle left
 * that turn unread — and on a server the adapter does not tear down with the
 * session, it still ran, against a lane worktree the next node was using.
 *
 * So the session ends on the first idle that leaves no background task pending,
 * and only once the prompt has been answered. A task stops being pending when
 * its result is injected, or when its child session is deleted; never when the
 * child goes idle, which happens *before* the injection.
 *
 * **The server can lose the wake-up.** The injection is a prompt, and a prompt
 * that lands while this session's loop is finishing joins that run instead of
 * starting one: the session goes idle with the result unanswered. So an idle
 * that ends a session which had background work — or one whose prompt was never
 * answered — first reads the session's last message. If it is a user message,
 * the session is prompted again with no parts, which opencode keeps out of the
 * model's context, so the run that follows answers the message that was
 * missed. Once per answer: a re-prompt that draws no reply ends the session.
 *
 * A session held open is bounded by silence, not by length
 * (`backgroundIdleMs`): a sub-agent that never reports must not hold a lane
 * forever. On expiry the session is aborted on the server, which cancels its
 * background tasks, and ends the way its last turn did. A failed turn ends the
 * session at once, and its leftover tasks are cancelled the same way.
 *
 * None of this depends on `capabilities.backgroundWork`. A configured server
 * may have background tasks enabled without this adapter saying so, and a task
 * nobody is waiting for is exactly the thing that must not run unobserved.
 */
class OpencodeSession implements AgentSession {
  readonly #queue = new EventQueue()
  readonly #mapper: OpencodeEventMapper
  #release: (() => void) | null = null
  /** The interrupt's deadline. */
  #timer: ReturnType<typeof setTimeout> | undefined
  /** The silence bound while the session is held open. */
  #idle: ReturnType<typeof setTimeout> | undefined
  #taken = false
  #ended = false
  #stopping = false
  #aborted = false
  /** What the last turn reported, while the session is held open past it. */
  #held: 'ok' | 'error' | undefined
  /** Assistant messages seen when the session was last re-prompted. */
  #rewokeAt: number | undefined
  /** Which idle's decision is current; an older one in flight is dropped. */
  #decision = 0

  constructor(
    readonly id: string,
    private readonly server: OpencodeServer,
    private readonly options: SessionOptions,
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

  /**
   * §6.1's mid-turn window (`TurnRefusal`), held by the mapper because the
   * mapper is what reads the server's errors. Delegated rather than copied, so
   * there is one answer and not two that can disagree.
   */
  get refusal(): TurnRefusal | undefined {
    return this.#mapper.refusal
  }

  #url(suffix: string): string {
    return `${this.server.baseUrl}/session/${encodeURIComponent(this.id)}${suffix}`
  }

  #ingest(raw: unknown): void {
    if (this.#ended) return
    const activity = this.#mapper.activity
    const events = this.#mapper.map(raw)
    if (this.#held !== undefined) {
      if (this.#mapper.activity !== activity) {
        // A new turn has started; it is bounded the way every turn is, by the
        // scheduler, not by this session's silence timer.
        this.#held = undefined
        this.#disarmIdle()
      } else if (this.#mapper.concerns(raw)) {
        this.#armIdle()
      }
    }
    for (const event of events) {
      if (event.type === 'session_ended') {
        this.#turnEnded(event.result)
        return
      }
      this.#queue.push(event)
    }
  }

  #turnEnded(result: 'ok' | 'error' | 'interrupted'): void {
    if (this.#stopping) return this.#finish('interrupted')
    // A turn that went wrong ends the session whatever is still running: the
    // work it left behind belongs to a turn nobody is going to read as done.
    if (result !== 'ok') return this.#finish(result)
    this.#held = result
    this.#armIdle()
    if (this.#mapper.pendingBackground > 0) return
    if (this.#mapper.sawBackground || this.#mapper.assistantMessages === 0) {
      void this.#settle()
      return
    }
    this.#finish(result)
  }

  /** The lost-wake-up guard: end, unless the session went idle on an unanswered message. */
  async #settle(): Promise<void> {
    const decision = ++this.#decision
    const activity = this.#mapper.activity
    const unanswered = await this.#lastIsUnanswered()
    // A new turn or a newer idle since the request went out has the say.
    if (this.#ended || decision !== this.#decision || this.#mapper.activity !== activity) return
    const result = this.#held ?? 'ok'
    const answeredSince = this.#rewokeAt === undefined || this.#mapper.assistantMessages > this.#rewokeAt
    if (unanswered && answeredSince) {
      this.#rewokeAt = this.#mapper.assistantMessages
      const model = this.options.model
      const sent = await postJson(this.#url('/prompt_async'), { parts: [], ...(model === undefined ? {} : { model }) })
      // Held, and bounded by silence, until the turn it starts ends.
      if (sent.ok || decision !== this.#decision) return
    }
    this.#finish(result)
  }

  /**
   * `GET /session/:id/message?limit=1` answers with the newest message. Any
   * failure reads as answered: this is a guard against a server bug, and a
   * guard that cannot see must not hold the session on a guess.
   */
  async #lastIsUnanswered(): Promise<boolean> {
    const listed = await request(this.#url('/message?limit=1'), { method: 'GET' })
    if (!listed.ok || !Array.isArray(listed.body)) return false
    const last = asRecord(listed.body.at(-1))
    return asRecord(last?.['info'])?.['role'] === 'user'
  }

  #lost(): void {
    if (this.#ended) return
    // The last turn did finish; what the stream took with it is the work the
    // session was waiting on, which `#finish` cancels.
    if (this.#held !== undefined && !this.#stopping) return this.#finish(this.#held)
    if (!this.#stopping) {
      this.#queue.push({ type: 'error', message: 'opencode event stream ended before the turn completed' })
    }
    this.#finish(this.#stopping ? 'interrupted' : 'error')
  }

  /**
   * Silence while held open: the background work never reported. The session
   * ends the way its last turn did, which is what it would have done before it
   * waited — a review that was waiting on its reviewer still has no verdict.
   */
  #armIdle(): void {
    this.#disarmIdle()
    this.#idle = setTimeout(() => {
      if (!this.#ended) {
        this.#abort()
        this.#finish(this.#held ?? 'ok')
      }
    }, this.options.backgroundIdleMs)
    this.#idle.unref()
  }

  #disarmIdle(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    this.#idle = undefined
  }

  /**
   * Aborting a session also cancels its background tasks, recursively, on the
   * server. Sent once, and never awaited — see `interrupt`.
   */
  #abort(): void {
    if (this.#aborted) return
    this.#aborted = true
    void postJson(this.#url('/abort'), {})
  }

  #finish(result: 'ok' | 'error' | 'interrupted'): void {
    if (this.#ended) return
    this.#ended = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#disarmIdle()
    // Unlike a CLI's child process, the server outlives this session: a task
    // still pending would finish, wake the session and run a turn nobody reads.
    if (this.#mapper.pendingBackground > 0) this.#abort()
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
    this.#abort()
    // The scheduler is waiting on a terminal event; a server that never reports
    // idle must not hold a node open forever.
    this.#timer = setTimeout(() => this.#finish('interrupted'), this.options.interruptTimeoutMs)
    this.#timer.unref()
  }

  async kill(): Promise<void> {
    if (this.#ended) return
    this.#stopping = true
    this.#abort()
    this.#finish('interrupted')
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpencodeAdapterOptions {
  /** Overrides `VINTA_AI_MAESTRO_OPENCODE_BIN`, which overrides `"opencode"`. */
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
  /**
   * How long a session held open for background work may go without a frame
   * before it ends anyway (`OpencodeSession`). Thirty minutes by default.
   */
  readonly backgroundIdleMs?: number
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
  readonly capabilities: HarnessCapabilities
  readonly bin: string

  readonly #servers = new Map<string, OpencodeServer>()
  readonly #booting = new Map<string, Promise<OpencodeServer | BootFailure>>()
  #forced: SpawnRefusalKind | null = null

  constructor(private readonly options: OpencodeAdapterOptions = {}) {
    this.bin = options.bin ?? process.env['VINTA_AI_MAESTRO_OPENCODE_BIN'] ?? 'opencode'
    this.capabilities = { ...CAPABILITIES, backgroundWork: options.baseUrl === undefined }
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

    const server = await this.#server(task.cwd, task.env)
    if (!(server instanceof OpencodeServer)) return server.refuse(task.nodeId)

    let sessionId = task.resumeSessionId
    if (sessionId === undefined) {
      // The title is the node id and nothing else: it is stored, listed and
      // rendered, and the phase brief is not going into any of those.
      const created = await postJson(`${server.baseUrl}/session`, { title: `vinta-ai-maestro ${task.nodeId}` })
      if (!created.ok) return classifySpawnFailure(created.text, created.status, task.nodeId)
      sessionId = asString(asRecord(created.body)?.['id'])
      if (sessionId === undefined) return refuse('fatal', 'session-id-missing', task.nodeId)
    }

    const model = parseModel(task.model)
    const session = new OpencodeSession(sessionId, server, {
      interruptTimeoutMs: this.options.interruptTimeoutMs ?? 2_000,
      backgroundIdleMs: this.options.backgroundIdleMs ?? BACKGROUND_IDLE_MS,
      model,
    })
    // Subscribed first: an event that arrives between the prompt landing and
    // the subscription being made is an event the transcript never gets.
    session.attach()
    // Queued operator steering (§9) is a second, labelled part of the same
    // request rather than a second round trip: one POST cannot land half of
    // an operator's correction. `inject` being true does not make this
    // redundant — a node resumed after a capacity wait had no live session
    // when the operator typed, so this spawn is its only delivery.
    if (task.operatorText !== undefined) session.noteOperator(task.operatorText)

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
  /**
   * The server for one lane, booted once and cached by its directory.
   *
   * Which is also where the lane's environment has to be applied: this adapter
   * does not spawn a process per turn, so there is no later point at which a
   * turn could be given an environment. One directory is one lane is one
   * environment, so the cache and the env agree by construction.
   */
  async #server(
    cwd: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<OpencodeServer | BootFailure> {
    const key = this.options.baseUrl === undefined ? cwd : EXTERNAL_KEY
    const running = this.#servers.get(key)
    if (running !== undefined) return running

    const booting = this.#booting.get(key) ?? this.#boot(cwd, key, env)
    this.#booting.set(key, booting)
    try {
      return await booting
    } catch (error) {
      return bootFailure(String(error), null)
    } finally {
      this.#booting.delete(key)
    }
  }

  async #boot(
    cwd: string,
    key: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<OpencodeServer | BootFailure> {
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
        // Applied last, over the lane's own overlay too: the prompts are told
        // what `capabilities` says, and this is what makes it true.
        env: { ...childEnv(STRIPPED_ENV, env), ...BACKGROUND_ENV },
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
