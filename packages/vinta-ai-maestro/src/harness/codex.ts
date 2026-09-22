/**
 * The `codex` adapter: the Codex CLI supervised as a child process.
 *
 * §7 fixes the invocation — `codex exec --json`. That mode emits a JSONL event
 * stream on stdout and reads its instructions from stdin *once*, to EOF. There
 * is no channel back into a turn that has started, which is the whole reason
 * this is the harness whose `inject` capability is false: steering a codex node
 * is interrupt-then-resume-with-an-amended-prompt, and §9 puts that queue in
 * the caller, where the resume happens. `send` therefore rejects loudly rather
 * than restarting a session behind the scheduler's back — a silent no-op would
 * leave an operator watching for an effect that can never arrive.
 *
 * What closes that loop is `AgentTask.operatorText`: the queue the caller kept
 * comes back on the next spawn or resume, and this adapter delivers it over
 * stdin alongside the brief — the only moment it can, and the only channel
 * that keeps it out of the process table.
 *
 * The three properties `claude-code.ts` exists to guarantee hold here too, for
 * the same reasons, and this file follows its shape deliberately.
 *
 * **The binary is configuration, never a constant.** Option, then
 * `VINTA_AI_MAESTRO_CODEX_BIN`, then `"codex"`.
 *
 * **Unknown output is ignored, never fatal.** Codex's `item` vocabulary
 * (`agent_message`, `reasoning`, `command_execution`, `file_change`,
 * `mcp_tool_call`, `web_search`, `todo_list`, `error`) grows with the CLI; an
 * event or item type this file has never seen must fall out of the mapping as
 * zero events rather than end a run.
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
 * `HarnessAdapter` and never imports another adapter; what all three need in
 * common is imported from one place they all sit beside instead.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
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
  type TurnRefusal,
} from './adapter.ts'
import {
  type AgentPermission,
  codexArgs,
  codexResumeArgs,
  DEFAULT_PERMISSION,
} from './permissions.ts'
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
  resumeContext,
  signalGroup,
} from './shared.ts'

/** §7's invocation. `-` makes codex read the prompt from stdin (see `spawn`). */
const BASE_ARGS = ['exec', '--json'] as const

/**
 * `inject` is false and that is structural, not a gap: `codex exec` consumes
 * stdin to EOF before the turn starts. `permissionControl` is true because
 * codex takes a non-interactive sandbox and approval policy on the command
 * line — which this adapter now actually passes (`permissions.ts`). It did not
 * before, and the comment claiming otherwise was the only thing standing where
 * the flags should have been.
 *
 * **`autoCompact` is true and this adapter passes nothing to make it so**,
 * which is the one capability here that is not backed by a flag. codex compacts
 * on its own and ships no way to stop it: no CLI flag, no environment variable,
 * and the only related config key — `model_auto_compact_token_limit`, the one
 * spelling of it `--strict-config` accepts — sets the *threshold*, not a
 * switch. Its own system prompt tells the model the conversation is summarized
 * automatically when it runs out of context.
 *
 * So there is nothing to pass and nothing to sanitize, and the temptation to
 * pass the threshold anyway is the mistake to avoid: a constant written here
 * would not track the context window of whichever model the workflow named, and
 * would move compaction to the wrong point on every other one. The vendor's
 * default is `null`, which means the model's own limit — better information
 * than this repository has.
 */
const CAPABILITIES: HarnessCapabilities = {
  inject: false,
  interrupt: true,
  resume: true,
  pty: true,
  permissionControl: true,
  autoCompact: true,
}

/** Command output can be a whole file. The transcript keeps it; an event carries a look. */
const SUMMARY_LIMIT = 2_000

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const summarize = (content: unknown): string => {
  const rendered = asString(content) ?? JSON.stringify(content ?? null)
  return rendered.length > SUMMARY_LIMIT ? `${rendered.slice(0, SUMMARY_LIMIT)}…` : rendered
}

/**
 * Item types that are a tool call rather than a message. Everything else —
 * `todo_list` today, whatever ships next — has no home in the normalized union
 * and is dropped.
 */
const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search'])

/** The vendor's own item type is the tool name; MCP calls name the tool they called. */
const toolName = (item: Record<string, unknown>, kind: string): string => {
  if (kind !== 'mcp_tool_call') return kind
  const server = asString(item['server'])
  const tool = asString(item['tool'])
  return server !== undefined && tool !== undefined ? `${server}.${tool}` : kind
}

/** Whichever field this item kind puts its outcome in. */
const toolSummary = (item: Record<string, unknown>): string => {
  for (const field of ['aggregated_output', 'result', 'changes', 'query']) {
    const value = item[field]
    if (value !== undefined && value !== null) return summarize(value)
  }
  return ''
}

const toolOk = (item: Record<string, unknown>): boolean => {
  const exit = asNumber(item['exit_code'])
  return item['status'] !== 'failed' && (exit === undefined || exit === 0)
}

/**
 * `item.started` opens a tool call, `item.completed` closes it. `item.updated`
 * is progress on a call already announced, so it maps to nothing: emitting it
 * would put several `tool_use` events under one id.
 */
const mapItem = (raw: unknown, phase: 'started' | 'updated' | 'completed'): AgentEvent[] => {
  const item = asRecord(raw)
  const kind = asString(item?.['type'])
  const id = asString(item?.['id'])
  if (item === undefined || kind === undefined || id === undefined) return []
  if (phase === 'updated') return []

  if (TOOL_ITEMS.has(kind)) {
    return phase === 'started'
      ? [{ type: 'tool_use', id, name: toolName(item, kind), input: item }]
      : [{ type: 'tool_result', id, ok: toolOk(item), summary: toolSummary(item) }]
  }
  if (phase === 'started') return []

  switch (kind) {
    case 'agent_message': {
      const text = asString(item['text'])
      return text !== undefined && text.length > 0 ? [{ type: 'assistant_text', text }] : []
    }
    case 'reasoning': {
      const text = asString(item['text'])
      return text !== undefined && text.length > 0 ? [{ type: 'thinking', text }] : []
    }
    case 'error':
      return [failureEvent(asString(item['message']) ?? '')]
    default:
      // An item type this version does not know is not an error.
      return []
  }
}

const mapUsage = (raw: unknown): AgentEvent[] => {
  const usage = asRecord(raw)
  if (usage === undefined) return []
  const cacheRead = asNumber(usage['cached_input_tokens'])
  const cacheWrite = asNumber(usage['cache_write_input_tokens'])
  // **`input_tokens` here is inclusive of the cached prefix**, which is the one
  // trap in this mapping (§15.6). Codex passes through the OpenAI Responses
  // shape, where `input_tokens` is the whole prompt and `cached_input_tokens`
  // names the part of it that was served from cache; Anthropic reports the
  // opposite — `input_tokens` is the fresh remainder and the cache counts sit
  // beside it. Carried through unchanged, one harness's `input` would mean
  // "prompt" and another's "prompt minus cache", and both a cross-harness sum
  // and any cache-hit share computed from it would be quietly wrong.
  //
  // So the cached part is subtracted here and `input` means the same thing in
  // every adapter: the fresh prefix, with `cacheRead`/`cacheWrite` beside it
  // and the three summing to the whole prompt. The subtraction is floored
  // because a vendor is not owed arithmetic consistency; the alternative is a
  // negative token count in a run total.
  const reported = asNumber(usage['input_tokens']) ?? 0
  const fresh = Math.max(0, reported - (cacheRead ?? 0) - (cacheWrite ?? 0))
  // Codex reports tokens only; it prices nothing, so `costUsd` is omitted
  // rather than guessed from a rate that varies by plan. A cache field it did
  // not send stays absent for the same reason a missing cost does: unknown is
  // not zero, and §15.6 has to be able to tell them apart.
  return [
    {
      type: 'usage',
      input: fresh,
      output: asNumber(usage['output_tokens']) ?? 0,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    },
  ]
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
 * One parsed CLI frame to zero or more normalized events. Zero is the correct
 * answer for anything unrecognized, at every level: the frame type, an item
 * type, a frame missing the fields its type promises.
 */
export function mapCliEvent(raw: unknown): AgentEvent[] {
  const value = asRecord(raw)
  if (!value) return []
  switch (value['type']) {
    case 'thread.started': {
      const sessionId = asString(value['thread_id'])
      return sessionId === undefined ? [] : [{ type: 'session_started', sessionId }]
    }
    case 'item.started':
      return mapItem(value['item'], 'started')
    case 'item.updated':
      return mapItem(value['item'], 'updated')
    case 'item.completed':
      return mapItem(value['item'], 'completed')
    case 'turn.completed':
      // One invocation of `codex exec` is one turn, so its terminal frame is
      // the session's terminal frame.
      return [...mapUsage(value['usage']), { type: 'session_ended', result: 'ok' }]
    case 'turn.failed':
      return [
        ...mapUsage(value['usage']),
        failureEvent(asString(asRecord(value['error'])?.['message']) ?? ''),
        { type: 'session_ended', result: 'error' },
      ]
    case 'error':
      // A stream-level error. Whether the turn recovers is codex's business;
      // the session settles on `turn.failed` or on the process exiting.
      return [failureEvent(asString(value['message']) ?? '')]
    default:
      return []
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
    // when the task carried a `resumeSessionId` — `exec resume <id>` is the
    // only invocation that can be refused for one. Codex calls the thing three
    // names depending on which layer answers (thread on the wire, session in
    // the CLI, rollout on disk), so all three are listed rather than trusting
    // whichever one the current release happens to print.
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
    kind: 'fatal',
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
      /usage limit|quota (exceeded|exhausted)|credit balance|out of credits|insufficient_quota|plan limit/,
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
      /overloaded|\b(500|502|503|504|529)\b|econnreset|econnrefused|etimedout|enotfound|socket hang up|stream (disconnected|closed)|fetch failed|network error|temporarily unavailable/,
  },
]

const REFUSALS = classifier('codex', SIGNATURES)

/** The fixed label for whatever the vendor said, safe to put in a message field. */
const reasonFor = (output: string): string => REFUSALS.reasonFor(output)

/**
 * Classify what the CLI said on its way out. The default is `fatal`; see
 * `classifier` for why an unrecognized failure must not become a wait.
 */
export const classifySpawnFailure = REFUSALS.classify

/**
 * A capacity refusal announced by a frame of a turn that had already started,
 * or nothing.
 *
 * Its own function rather than part of `mapCliEvent` for the reason
 * `failureEvent` exists: codex states a failure as prose, frequently a whole
 * upstream JSON body, and only the classifier's fixed token may reach an event.
 * So the prose is read here, matched, and dropped — what comes back is a kind,
 * a token and a reset time.
 *
 * Every frame that carries failure prose is read, not only the terminal one: a
 * window can close on a `turn.failed`, on a stream-level `error`, or on an
 * error item inside the turn, and codex uses all three.
 */
export function turnRefusal(raw: unknown, now?: Date): TurnRefusal | undefined {
  const value = asRecord(raw)
  if (!value) return undefined
  const prose =
    value['type'] === 'turn.failed'
      ? asString(asRecord(value['error'])?.['message'])
      : value['type'] === 'error'
        ? asString(value['message'])
        : asRecord(value['item'])?.['type'] === 'error'
          ? asString(asRecord(value['item'])?.['message'])
          : undefined
  return prose === undefined ? undefined : REFUSALS.capacity(prose, now)
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

class CodexSession implements AgentSession {
  readonly #queue: EventQueue
  readonly #child: ChildProcess
  #taken = false
  #ended = false
  #stopping = false
  #refusal: TurnRefusal | undefined

  constructor(
    readonly id: string,
    child: ChildProcess,
    queue: EventQueue,
  ) {
    this.#child = child
    this.#queue = queue
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

  /**
   * The vendor's window closed under this turn (§6.1, `TurnRefusal`).
   *
   * Recorded for the caller and announced in the stream as one fixed token:
   * without the stream line, the transcript of a turn that stopped for a
   * window shows an unexplained error and a run that then waits for hours.
   * First one wins — a limit announced twice is one closed window, and the
   * first report is the one whose reset time was stated.
   */
  noteRefusal(refusal: TurnRefusal): void {
    if (this.#ended || this.#refusal !== undefined) return
    this.#refusal = refusal
    this.#queue.push({ type: 'error', message: `codex refused mid-turn: ${refusal.reason}` })
  }

  /** One mapped event from the CLI. Terminal events close the stream exactly once. */
  ingest(event: AgentEvent): void {
    if (this.#ended) return
    if (event.type === 'session_ended') {
      this.#finish(this.#stopping ? 'interrupted' : event.result)
      return
    }
    this.#queue.push(event)
  }

  /** The child died without a terminal turn frame. */
  settleOnExit(): void {
    if (this.#ended) return
    if (!this.#stopping) {
      this.#queue.push({ type: 'error', message: 'codex exited before its turn completed' })
    }
    this.#finish(this.#stopping ? 'interrupted' : 'error')
  }

  #finish(result: 'ok' | 'error' | 'interrupted'): void {
    this.#ended = true
    this.#queue.push({ type: 'session_ended', result })
    this.#queue.close()
    signalGroup(this.#child, 'SIGKILL')
  }

  /**
   * `codex exec` consumed its stdin before the turn began, so there is nothing
   * to write to. Rejecting is the contract: the caller queues the text and
   * delivers it on the next resume (§9), and a silent drop would be a steering
   * message the operator can never find in the transcript.
   */
  async send(_text: string): Promise<void> {
    throw new HarnessCapabilityError('codex', 'inject')
  }

  async interrupt(): Promise<void> {
    if (this.#ended) return
    this.#stopping = true
    signalGroup(this.#child, 'SIGINT')
    // A turn deep in a tool call may not take SIGINT. The scheduler is waiting
    // on a terminal event, so there is a deadline on being polite.
    setTimeout(() => signalGroup(this.#child, 'SIGKILL'), 2_000).unref()
  }

  async kill(): Promise<void> {
    if (this.#ended) return
    this.#stopping = true
    signalGroup(this.#child, 'SIGKILL')
  }
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
  /** How long a spawn may go without a thread frame before it is a `transient` refusal. */
  readonly startTimeoutMs?: number
  readonly preflightTimeoutMs?: number
}

const INSTALL_HINT =
  'npm install -g @openai/codex (or point VINTA_AI_MAESTRO_CODEX_BIN at the binary)'

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
   * Two questions, two mechanisms, because the answers need different fixes.
   *
   * "Installed" is `--version`: a missing binary, or an alias that is not a
   * binary at all, fails to spawn. "Authenticated" is `codex login status`,
   * which reports on the CLI's own credential store without touching it and
   * without spending a model turn. Only an explicit auth signature flips
   * `authenticated` to false, so an unfamiliar startup diagnostic — or a CLI
   * old enough not to have the subcommand — cannot lock a working machine out
   * of a run.
   *
   * Neither branch reads a credential store or performs a login. The `hint` is
   * the command the *user* runs.
   */
  async preflight(): Promise<PreflightResult> {
    const timeout = this.options.preflightTimeoutMs ?? 20_000
    const version = await probe(this.bin, ['--version'], timeout, childEnv(STRIPPED_ENV))
    if (!version.spawned || version.code !== 0) {
      return { installed: false, authenticated: false, hint: INSTALL_HINT }
    }
    const reported = version.output.trim().split('\n')[0]?.trim()

    const login = await probe(this.bin, ['login', 'status'], timeout, childEnv(STRIPPED_ENV))
    const authenticated = !isAuthFailure(login.output)
    return {
      installed: true,
      authenticated,
      ...(reported === undefined || reported.length === 0 ? {} : { version: reported }),
      ...(authenticated ? {} : { hint: `${this.bin} login` }),
    }
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
      const spec = agentSpawn(this.bin, this.#argsFor(task))
      child = spawnChild(spec.file, spec.args, {
        cwd: task.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(STRIPPED_ENV, task.env),
        ...spec.options,
      })
    } catch (error) {
      return classifySpawnFailure(String(error), null, task.nodeId, resumeContext(task))
    }

    // A closed pipe is how a refused spawn presents; it must not become an
    // unhandled 'error' on the way to being classified.
    child.stdin?.on('error', () => {})
    // The prompt goes over stdin rather than argv: a phase brief is long enough
    // to be worth keeping out of the process table and out of `ARG_MAX`. Codex
    // reads it to EOF before the turn starts, which is the mechanical reason
    // `inject` is false.
    //
    // Queued operator steering (§9) rides the same pipe, for the same reason
    // and one more: this spawn is the *only* moment codex can be told
    // anything, so `--` on the command line would be both the wrong channel
    // and a leak of what the operator typed into the process table.
    child.stdin?.end(
      task.operatorText === undefined
        ? task.prompt
        : `${task.prompt}\n\n${operatorGuidance(task.operatorText)}`,
    )

    return await this.#awaitStart(child, task)
  }

  /**
   * §9's take over. `codex resume <id>` without `--json` is the interactive
   * reading of the same session `exec --json` was driving headlessly — which
   * is the point: one session, two front ends, never at the same time. The
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

  #argsFor(task: AgentTask): string[] {
    // An empty model defers to the CLI's own configured default. Codex model
    // slugs are account- and plan-gated, so there is no universally valid one
    // to substitute, and inventing a wrong slug fails the turn outright.
    const model = task.model.length === 0 ? [] : ['--model', task.model]
    // The sandbox and approval policy the capability claims this adapter
    // passes. Both subcommands take them, and a resumed turn needs them as much
    // as a fresh one — the policy is the operator's for the run, not the turn's.
    const permission = this.options.permission ?? DEFAULT_PERMISSION
    return task.resumeSessionId === undefined
      ? [...BASE_ARGS, ...codexArgs(permission), ...model, '-']
      : [
          'exec',
          'resume',
          '--json',
          ...codexResumeArgs(permission),
          ...model,
          task.resumeSessionId,
          '-',
        ]
  }

  #awaitStart(child: ChildProcess, task: AgentTask): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      const queue = new EventQueue()
      const lines = new JsonLines()
      let session: CodexSession | undefined
      let diagnostics = ''
      let settled = false

      const settle = (outcome: SpawnOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        signalGroup(child, 'SIGKILL')
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
          // Before the frame is mapped, because mapping it can end the session:
          // `ingest` sees this frame's `session_ended` and closes the queue,
          // after which `noteRefusal` is a no-op.
          const refused = turnRefusal(frame)
          if (refused !== undefined) session?.noteRefusal(refused)
          for (const event of mapCliEvent(frame)) {
            if (event.type === 'session_started') {
              if (session !== undefined) continue
              session = new CodexSession(event.sessionId, child, queue)
              queue.push(event)
              // The operator's words in the record of the run they steered
              // (§5.3, §15). `send` cannot put them there on this harness, so
              // the spawn that actually delivered them does.
              if (task.operatorText !== undefined) {
                queue.push({ type: 'user_message', text: task.operatorText })
              }
              settle({ ok: true, session })
              continue
            }
            session?.ingest(event)
          }
        }
      })

      child.stderr?.on('data', (chunk: string) => {
        // Kept only long enough to classify a refusal; never emitted as an event.
        diagnostics = `${diagnostics}${chunk}`.slice(-8_000)
      })

      child.on('error', (error) => {
        if (session !== undefined) return session.settleOnExit()
        settle(classifySpawnFailure(String(error), null, task.nodeId, resumeContext(task)))
      })

      child.on('close', (code) => {
        if (session !== undefined) {
          // The other shape of the same event: the window is printed to stderr
          // and the process exits without a terminal frame, so `diagnostics`
          // is the only place that sentence exists.
          const refused = REFUSALS.capacity(diagnostics)
          if (refused !== undefined) session.noteRefusal(refused)
          return session.settleOnExit()
        }
        settle(classifySpawnFailure(diagnostics, code, task.nodeId, resumeContext(task)))
      })
    })
  }
}

const isAuthFailure = (output: string): boolean => REFUSALS.matches('not-authenticated', output)
