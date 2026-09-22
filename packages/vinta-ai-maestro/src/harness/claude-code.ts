/**
 * The `claude-code` adapter: the Claude Code CLI supervised as a child process.
 *
 * §7 fixes the invocation — `-p --output-format stream-json --input-format
 * stream-json --verbose`. That is the only mode that is both machine-parseable
 * *and* writable while a turn is running, which is why this is the one harness
 * whose `inject` capability is true: steering is a JSON line on stdin, not an
 * interrupt-and-resume dance.
 *
 * Three properties this file exists to guarantee.
 *
 * **The binary is configuration, never a constant.** `claude` is frequently a
 * shell alias or a wrapper rather than something on `PATH`; hardcoding it makes
 * the adapter unusable on exactly the machines it is meant to run on. Option,
 * then `VINTA_AI_MAESTRO_CLAUDE_BIN`, then `"claude"`.
 *
 * **Unknown output is ignored, never fatal.** The CLI's stream-json vocabulary
 * grows. A variant this file has never seen must fall out of the mapping as
 * zero events; a run must not die because the vendor shipped a new event type
 * on a Tuesday.
 *
 * **A refusal is classified, not thrown** (§6.1). Rate limits, per-account
 * concurrency caps and exhausted usage windows are `rate_limit`/`concurrency`/
 * `quota` — waits, which return the node to the ready set. `fatal` is reserved
 * for broken: no binary, no login. Where the vendor states a reset time it is
 * used verbatim as `retryAfter`, because a guessed backoff either wastes an
 * hour or hammers a closed window.
 *
 * Nothing here forwards prompt text, file contents or agent output into a
 * refusal message or an error event. Those carry node ids, vendor status
 * tokens and exit codes only; the content lives in the transcript stream.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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
  type SpawnRefusalKind,
  type TurnRefusal,
} from './adapter.ts'
import {
  CLAUDE_CODE_COMPACTION_ENV,
  CLAUDE_CODE_COMPACTION_SETTINGS,
} from './compaction.ts'
import { type AgentPermission, claudeCodeArgs, DEFAULT_PERMISSION } from './permissions.ts'
import { addDirArgs, writeDenyRules, type ReadGrant } from './read-access.ts'
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

/** §7's invocation, in one place so preflight probes the same path a run takes. */
const BASE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
] as const

const CAPABILITIES: HarnessCapabilities = {
  inject: true,
  interrupt: true,
  resume: true,
  pty: true,
  permissionControl: true,
  autoCompact: true,
}

/** Tool results can be whole files. The transcript keeps them; an event carries a look. */
const SUMMARY_LIMIT = 2_000

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const summarize = (content: unknown): string => {
  const direct = asString(content)
  const text =
    direct ??
    (Array.isArray(content)
      ? content
          .map((block) => asString(asRecord(block)?.['text']) ?? '')
          .filter((part) => part.length > 0)
          .join('\n')
      : '')
  const rendered = text.length > 0 ? text : JSON.stringify(content ?? null)
  return rendered.length > SUMMARY_LIMIT ? `${rendered.slice(0, SUMMARY_LIMIT)}…` : rendered
}

const mapAssistant = (value: Record<string, unknown>): AgentEvent[] => {
  const content = asRecord(value['message'])?.['content']
  if (!Array.isArray(content)) return []
  const events: AgentEvent[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block) continue
    switch (block['type']) {
      case 'text': {
        const text = asString(block['text'])
        if (text !== undefined && text.length > 0) events.push({ type: 'assistant_text', text })
        break
      }
      case 'thinking': {
        const text = asString(block['thinking'])
        if (text !== undefined && text.length > 0) events.push({ type: 'thinking', text })
        break
      }
      case 'tool_use': {
        const id = asString(block['id'])
        const name = asString(block['name'])
        if (id !== undefined && name !== undefined) {
          events.push({ type: 'tool_use', id, name, input: block['input'] })
        }
        break
      }
      default:
        // A block type this version does not know is not an error.
        break
    }
  }
  return events
}

/**
 * The CLI reports tool results as a synthetic `user` turn. Text on a `user`
 * event is the prompt or an injected steer, both of which this adapter already
 * emitted itself — mapping it again would double every steering message in the
 * transcript.
 */
const mapUser = (value: Record<string, unknown>): AgentEvent[] => {
  const content = asRecord(value['message'])?.['content']
  if (!Array.isArray(content)) return []
  const events: AgentEvent[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block || block['type'] !== 'tool_result') continue
    const id = asString(block['tool_use_id'])
    if (id === undefined) continue
    events.push({
      type: 'tool_result',
      id,
      ok: block['is_error'] !== true,
      summary: summarize(block['content']),
    })
  }
  return events
}

const mapResult = (value: Record<string, unknown>): AgentEvent[] => {
  const events: AgentEvent[] = []
  const usage = asRecord(value['usage'])
  if (usage) {
    // Only the terminal event carries usage. Per-message usage is a delta and
    // this total is the sum of them; emitting both makes every consumer that
    // adds up `usage` events report double.
    const cost = asNumber(value['total_cost_usd'])
    // The cache counters sit in the same object as the two token counts and
    // were previously read past (§15.6). `input_tokens` here is the *fresh*
    // prefix only — Anthropic reports cached prompt tokens under these two
    // fields instead, not inside it — so the three add up to the whole prompt
    // and none of them double-counts another.
    //
    // A field the CLI did not send stays absent rather than becoming 0: a
    // session that reported no cache figures is unknown, and §15.6 needs that
    // distinct from a session that genuinely read nothing from cache.
    const cacheRead = asNumber(usage['cache_read_input_tokens'])
    const cacheWrite = asNumber(usage['cache_creation_input_tokens'])
    events.push({
      type: 'usage',
      input: asNumber(usage['input_tokens']) ?? 0,
      output: asNumber(usage['output_tokens']) ?? 0,
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    })
  }
  const subtype = asString(value['subtype'])
  const failed = value['is_error'] === true || (subtype !== undefined && subtype !== 'success')
  if (failed) {
    // The vendor's `result` string is agent output; the subtype is a fixed
    // status token. Only the token is safe to put in an error field.
    //
    // `is_error: true` beside `subtype: "success"` is how the CLI reports a
    // turn it ended itself — a plan limit, for one: the subtype says the loop
    // finished, the flag says the turn did not. Printing the subtype alone
    // wrote `claude-code result: success` into the record as a failure reason,
    // 189 times in one observed run, which reads as nothing having gone wrong.
    const status = subtype === undefined || subtype === 'success' ? 'is_error' : subtype
    events.push({ type: 'error', message: `claude-code result: ${status}` })
  }
  events.push({ type: 'session_ended', result: failed ? 'error' : 'ok' })
  return events
}

/**
 * The refusal that never asks: `{"type":"system","subtype":"permission_denied",
 * "tool_name":"Read","decision_reason_type":"workingDir", …}`.
 *
 * The CLI emits this instead of a `can_use_tool` control request whenever the
 * answer is already decided — a path outside the working directory, a mode that
 * forbids the tool. Nothing can be replied to, so the only thing to do with it
 * is say it happened.
 *
 * Both the token and the sentence are carried. The token alone was the first
 * version, and `reason: "other"` turned out to be exactly as useful as no event
 * at all — the sentence beside it ("the following parts require approval:
 * command -v ruff, …") is the whole diagnosis. The CLI puts that text in
 * `decision_reason` for some refusals and in `message` for others, so both are
 * read and the first present one wins.
 */
const mapPermissionDenied = (value: Record<string, unknown>): AgentEvent[] => {
  const tool = asString(value['tool_name'])
  if (tool === undefined) return []
  const detail = asString(value['decision_reason']) ?? asString(value['message'])
  return [
    {
      type: 'permission_denied',
      tool,
      reason: asString(value['decision_reason_type']) ?? 'denied',
      ...(detail === undefined || detail === '' ? {} : { detail: detail.slice(0, DETAIL_LIMIT) }),
    },
  ]
}

/** A refusal explains itself in a sentence; anything longer is not one. */
const DETAIL_LIMIT = 500

/**
 * The CLI's own verdict on the turn it just finished.
 *
 * `{"type":"system","subtype":"post_turn_summary","status_category":"blocked",
 * "needs_action":"Please grant access…"}` — the frame that says the agent
 * stopped without doing what it was asked and wants a person. It is emitted
 * *before* a `result` frame that then reports `is_error: false`, which is how a
 * phase came to succeed having written nothing.
 *
 * Only `blocked` is acted on. The other categories are the ordinary ones and
 * the set is the vendor's to grow, so anything unrecognised means nothing here.
 *
 * `needs_action` and `status_detail` are the agent's own words and are dropped
 * (§11); the fixed sentence below is this adapter's, and says the one thing the
 * category actually establishes.
 */
const mapTurnSummary = (value: Record<string, unknown>): AgentEvent[] =>
  value['status_category'] === 'blocked'
    ? [{ type: 'error', message: 'claude-code: the turn ended blocked' }]
    : []

/**
 * The moment the session's memory got thinner:
 * `{"type":"system","subtype":"compact_boundary","compact_metadata":
 * {"trigger":"auto","pre_tokens":183000,"post_tokens":24000}}`.
 *
 * The CLI emits this itself, which is the only reason this adapter can report
 * compaction at all — the turn carries on across the boundary with no other
 * outward sign, and the next assistant frame looks exactly like any other.
 *
 * `trigger` is narrowed to the two values the union admits rather than passed
 * through: it is the vendor's field and the vendor may grow it, and an unknown
 * value read as `auto` would claim the window filled when it may have been a
 * person at a takeover terminal. Anything unrecognised means this frame is not
 * one we can describe, so it produces no event — the same rule every other
 * mapper here follows, for the same reason.
 *
 * The token counts are carried and the summary is not. The counts are the half
 * that says how much was lost; the summary is agent prose about the repository
 * and stays in the transcript's text events (§11).
 */
const mapCompactBoundary = (value: Record<string, unknown>): AgentEvent[] => {
  const metadata = asRecord(value['compact_metadata']) ?? {}
  const trigger = asString(metadata['trigger'])
  if (trigger !== 'auto' && trigger !== 'manual') return []
  const preTokens = asNumber(metadata['pre_tokens'])
  const postTokens = asNumber(metadata['post_tokens'])
  return [
    {
      type: 'context_compacted',
      trigger,
      ...(preTokens === undefined ? {} : { preTokens }),
      ...(postTokens === undefined ? {} : { postTokens }),
    },
  ]
}

const mapControlRequest = (value: Record<string, unknown>): AgentEvent[] => {
  const request = asRecord(value['request'])
  if (!request || request['subtype'] !== 'can_use_tool') return []
  const tool = asString(request['tool_name'])
  return tool === undefined ? [] : [{ type: 'permission_request', tool, detail: request['input'] }]
}

/**
 * One parsed CLI frame to zero or more normalized events. Zero is the correct
 * answer for anything unrecognized, at every level: the frame type, a content
 * block type, a frame missing the fields its type promises.
 */
export function mapCliEvent(raw: unknown): AgentEvent[] {
  const value = asRecord(raw)
  if (!value) return []
  switch (value['type']) {
    case 'system': {
      if (value['subtype'] === 'permission_denied') return mapPermissionDenied(value)
      if (value['subtype'] === 'post_turn_summary') return mapTurnSummary(value)
      if (value['subtype'] === 'compact_boundary') return mapCompactBoundary(value)
      const sessionId = asString(value['session_id'])
      return value['subtype'] === 'init' && sessionId !== undefined
        ? [{ type: 'session_started', sessionId }]
        : []
    }
    case 'assistant':
      return mapAssistant(value)
    case 'user':
      return mapUser(value)
    case 'result':
      return mapResult(value)
    case 'control_request':
      return mapControlRequest(value)
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
    // when the task carried a `resumeSessionId`, which is what keeps "no
    // conversation found" from being read as a stale token on a spawn that
    // never offered one. The CLI's own wording for `--resume <unknown id>` is
    // "No conversation found with session ID: …"; the alternatives cover the
    // phrasings it has used for an expired or unreadable transcript.
    kind: 'stale_session',
    reason: 'resume-session-unknown',
    pattern:
      /no (conversation|session) found|(session|conversation)[^\n]{0,40}\b(not ?found|not exist|no longer exists|expired|unknown|invalid)\b|could not (find|resume|load)[^\n]{0,40}(session|conversation)/,
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
      /\/login|not logged in|log ?in to|logged out|unauthorized|authentication_error|invalid api key|oauth token (has )?expired|credentials? (not found|expired|invalid)/,
  },
  {
    kind: 'quota',
    reason: 'usage-window-exhausted',
    pattern:
      /usage limit reached|usage limit will reset|quota (exceeded|exhausted)|credit balance|out of credits|insufficient_quota/,
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
    // The plan's own windows, which the row above does not describe and which
    // this CLI announces in its own words: "You've hit your session limit",
    // "Session limit reached · resets 3am", "5-hour limit reached",
    // "You've reached your weekly limit". None of those say "usage limit", so
    // every one of them fell past this whole table to the default — `fatal`,
    // which fails the node and blocks its subtree for a window that ends by
    // itself in a few hours. It is the same condition as
    // `usage-window-exhausted` and gets the same kind; the reason token is
    // separate so the log says which wording was seen.
    //
    // **Below `concurrency` and `rate_limit`, not above.** "concurrent session
    // limit reached" is a concurrency signal that this pattern would otherwise
    // swallow, and the two are not interchangeable: a concurrency refusal
    // halves the AIMD ceiling and a quota refusal must not, because a plan
    // window says nothing about how many agents may run at once.
    //
    // "approaching" is deliberately not matched. A warning that a limit is
    // near is not a refusal, and reading it as one would park a harness that
    // is still working.
    kind: 'quota',
    reason: 'plan-limit-reached',
    pattern:
      /(?:you|we)(?:'ve| have)? (?:hit|reached|used up) [^\n]{0,40}\blimit\b|\b(?:session|weekly|monthly|daily|\d+[- ]hour) limit\b[^\n]{0,24}?\b(?:reached|exceeded|resets?)\b|\byour limit (?:will )?resets?\b/,
  },
  {
    kind: 'transient',
    reason: 'upstream-unavailable',
    pattern:
      /overloaded|\b(500|502|503|504|529)\b|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|temporarily unavailable/,
  },
]

const REFUSALS = classifier('claude-code', SIGNATURES)

/**
 * Classify what the CLI said on its way out. The default is `fatal`; see
 * `classifier` for why an unrecognized failure must not become a wait.
 */
export const classifySpawnFailure = REFUSALS.classify

/**
 * A capacity refusal announced by the terminal `result` frame of a turn that
 * had already started, or nothing.
 *
 * Its own function because `mapResult` cannot answer it: that mapping carries
 * the *subtype* and deliberately drops the `result` string, since the string
 * is agent output (§11) — and the sentence about the window is in the string.
 * So the prose is read here, matched against the table, and thrown away; what
 * comes back is a kind, a fixed token and a reset time.
 *
 * The subtype is matched alongside it: a window that closes mid-turn is
 * reported by some releases as prose and by others only as the subtype, and
 * neither is worth missing.
 */
export function turnRefusal(raw: unknown, now?: Date): TurnRefusal | undefined {
  const value = asRecord(raw)
  if (!value || value['type'] !== 'result') return undefined
  const subtype = asString(value['subtype'])
  const failed = value['is_error'] === true || (subtype !== undefined && subtype !== 'success')
  if (!failed) return undefined
  const prose = [asString(value['result']), asString(value['error']), subtype]
    .filter((part): part is string => part !== undefined)
    .join(' ')
  return REFUSALS.capacity(prose, now)
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

class ClaudeCodeSession implements AgentSession {
  readonly #queue: EventQueue
  readonly #child: ChildProcess
  #taken = false
  #ended = false
  #stopping = false
  /** An error was reported during this turn. See `ingest`. */
  #errored = false
  #refusal: TurnRefusal | undefined

  constructor(readonly id: string, child: ChildProcess, queue: EventQueue) {
    this.#child = child
    this.#queue = queue
  }

  get refusal(): TurnRefusal | undefined {
    return this.#refusal
  }

  /**
   * The vendor's window closed under this turn (§6.1, `TurnRefusal`).
   *
   * Recorded for the caller *and* announced in the stream, as one fixed token.
   * Without the stream line the transcript of a turn that stopped for a window
   * shows an unexplained error and a run that then quietly waits for hours —
   * the same unreadable record a bare "could not provision the lane pool" left
   * behind, and the same fix: the token, never the prose.
   *
   * First one wins. A limit announced twice is one closed window, and the
   * earlier report is the one whose reset time was stated.
   */
  noteRefusal(refusal: TurnRefusal): void {
    if (this.#ended || this.#refusal !== undefined) return
    this.#refusal = refusal
    this.#errored = true
    this.#queue.push({ type: 'error', message: `claude-code refused mid-turn: ${refusal.reason}` })
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
   * One mapped event from the CLI. Terminal events close the stream exactly
   * once.
   *
   * **A session that reported an error did not end ok**, whatever the final
   * frame claims. The CLI announces a turn that ended blocked and then reports
   * `is_error: false` on the way out, because from its side nothing went wrong
   * — it was asked something it could not do and said so. From this side that
   * is a turn that produced nothing, and calling it a success is what let a
   * phase pass having written no code and fail two steps later under another
   * name.
   *
   * The rule is deliberately about `error` in general rather than about the
   * blocked summary in particular: every error here is one this adapter chose
   * to raise, and there is no error it raises that should leave a turn looking
   * clean.
   */
  ingest(event: AgentEvent): void {
    if (this.#ended) return
    if (event.type === 'error') this.#errored = true
    if (event.type === 'session_ended') {
      const reported = this.#errored && event.result === 'ok' ? 'error' : event.result
      this.#finish(this.#stopping ? 'interrupted' : reported)
      return
    }
    this.#queue.push(event)
  }

  /** The child died without a `result` frame. */
  settleOnExit(): void {
    if (this.#ended) return
    if (!this.#stopping) {
      this.#queue.push({ type: 'error', message: 'claude-code exited before its turn completed' })
    }
    this.#finish(this.#stopping ? 'interrupted' : 'error')
  }

  #finish(result: 'ok' | 'error' | 'interrupted'): void {
    this.#ended = true
    this.#queue.push({ type: 'session_ended', result })
    this.#queue.close()
    this.#child.stdin?.end()
    signalGroup(this.#child, 'SIGKILL')
  }

  async send(text: string): Promise<void> {
    if (this.#ended) return
    // Ahead of anything still in flight from the CLI: the operator is reacting
    // to what they just read, so the transcript shows it where they sent it.
    this.#queue.push({ type: 'user_message', text })
    writeMessage(this.#child, text)
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
 * The policy this spawn runs under: what it may read beyond its lane, what it
 * may not write, and whether it may run a shell command at all.
 *
 * **`Bash` is allowed under `auto`, and that is the whole of what makes `auto`
 * mean what it says.** `--permission-mode acceptEdits` accepts file *edits* and
 * nothing else: a shell command still goes to a permission prompt, and in `-p`
 * there is nobody to answer one. A run of eight phases died of this — the
 * agents wrote their code and were then refused `ruff`, `pytest`, `git add` and
 * `docker compose`, 69 denials between two lanes, every gate failing on work
 * that was never allowed to be checked. An orchestrator that stops to ask
 * before each command is not unattended, and a lane exists precisely so that
 * nobody has to be asked.
 *
 * What that costs is worth stating plainly: **`Bash` was never confined to the
 * lane** — the deny list below covers the file-editing tools, and a shell
 * redirection walks through it. Allowing it is allowing commands on this
 * machine. `auto` already promised that in words ("works unattended inside its
 * lane"); this is the first version where the words are true.
 *
 * `ask` deliberately does not allow it: that mode is for a human at the
 * browser, and its whole purpose is the prompt.
 *
 * `full` still gets no permission *rules* — it means "no checks" and is
 * documented as being for a box sandboxed by something else, so writing rules
 * the mode is chosen to ignore would make the flag look safer than it is. It
 * does now get a settings file, carrying nothing but the compaction assertion.
 * That is not a loophole in the paragraph above: `autoCompactEnabled` grants
 * the agent nothing and forbids it nothing, and a run told to skip every check
 * is still a run that must not die of a full context window.
 *
 * Which is why the early return for the "nothing to say" case is gone. There is
 * no such case any more — every spawn has at least one thing to put in the file
 * (`compaction.ts`), so every spawn writes one.
 *
 * The deny list is computed per spawn because it is per lane: it names the
 * *other* children at every level between a root and this agent's working
 * directory, which is the only shape the vendor's rules can express
 * (`read-access.ts`).
 */
function readAccessArgs(
  permission: AgentPermission,
  roots: readonly string[],
  lane: string,
  settingsDir: string,
): readonly string[] {
  const grant: ReadGrant = { roots, lane }
  const dirs = roots.length === 0 ? [] : addDirArgs(grant)

  // `auto` is the only mode that allows the shell, and the allowance lives in
  // this file rather than in the grant — see the paragraph above.
  const allow = permission === 'auto' ? ['Bash'] : []
  const deny =
    permission === 'full' || roots.length === 0
      ? []
      : writeDenyRules(grant, (dir) => {
          try {
            return readdirSync(dir)
          } catch {
            // A directory that cannot be listed contributes no rules, which is
            // the safe direction only because the corridor is what it would
            // have named: an unlistable level leaves its siblings writable,
            // never the lane unwritable.
            return []
          }
        })
  // Written to a file rather than passed as JSON, and this is forced rather
  // than tidy. On Windows every spawn goes through `cmd.exe`, where a `"`
  // cannot survive a quoted region: `platform.ts` refuses an argument
  // containing one instead of escaping it, so the whole spawn fails before the
  // binary is reached. A JSON object is nothing but quotes.
  const settings = writeSettings(settingsDir, lane, allow, deny)
  // Fail *closed*. Without the policy the grant is a write grant, so a
  // directory that cannot be written to costs the read access rather than the
  // guard — the one direction in which this may silently do less. It costs the
  // shell allowance too, which fails the phase loudly rather than quietly
  // widening what it may touch.
  //
  // `full` is the exception, and was before this: it has no guard to lose, so
  // an unwritable settings directory costs it only the compaction assertion and
  // there is no reason to take its read access away as well.
  //
  // What that assertion's loss actually costs is worth stating, because it is
  // less than it looks: compaction is the vendor's default and the environment
  // has already been sanitized by the time this runs. What falls away is only
  // the override of a `settings.json` that had turned compaction off — a
  // machine-specific hole, not the feature.
  if (settings === null) return permission === 'full' ? dirs : []
  return [...dirs, '--settings', settings]
}

/**
 * The policy file for one lane, or null when it cannot be written.
 *
 * Named for the lane and rewritten on each spawn: the deny list is computed
 * from what is on disk *now*, and a stale file would describe a repository that
 * has moved on. One file per lane rather than per spawn so a killed session
 * leaves nothing to collect — the next spawn in that lane overwrites it, and
 * `purge` removes the directory with the rest of the store.
 */
function writeSettings(
  dir: string,
  lane: string,
  allow: readonly string[],
  deny: readonly string[],
): string | null {
  const name = `${lane.split(/[/\\]/).filter(Boolean).pop() ?? 'lane'}.settings.json`
  const path = join(dir, name)
  const permissions = {
    ...(allow.length === 0 ? {} : { allow: [...allow] }),
    ...(deny.length === 0 ? {} : { deny: [...deny] }),
  }
  // The compaction assertion sits beside the permissions rather than inside
  // them because it is not one: it grants nothing and denies nothing. It is
  // here at all because this file is the only thing the adapter layers on top
  // of the user's own settings, and their `autoCompactEnabled: false` is the
  // one way a machine can turn compaction off that stripping the environment
  // does not reach (`compaction.ts`).
  const content = { ...CLAUDE_CODE_COMPACTION_SETTINGS, permissions }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
    return path
  } catch {
    return null
  }
}

const writeMessage = (child: ChildProcess, text: string): void => {
  const line = `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`
  child.stdin?.write(line)
}

/**
 * What must not reach a child, for two unrelated reasons.
 *
 * The API keys are about *whose account pays*: a child must reach Anthropic
 * through the seat the user logged into, never through a key that would bill an
 * account nobody chose for this run.
 *
 * The compaction switches are about *whether the phase survives its own
 * length*, and they are here rather than in a second list because the mechanism
 * is identical and `childEnv` takes one array. A daemon that inherits
 * `DISABLE_AUTO_COMPACT` from whatever shell started it hands that variable to
 * every agent in every lane, and the phase that dies of a full window reports
 * nothing an operator could trace back to it (`compaction.ts`).
 */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  ...CLAUDE_CODE_COMPACTION_ENV,
] as const

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ClaudeCodeAdapterOptions {
  /** Overrides `VINTA_AI_MAESTRO_CLAUDE_BIN`, which overrides `"claude"`. */
  readonly bin?: string
  /**
   * How much the agent may do unasked. The operator's choice, passed at
   * invocation — never read from the workflow document (`permissions.ts`).
   */
  readonly permission?: AgentPermission
  /**
   * Directories the agent may *read* beyond its lane, as absolute paths.
   *
   * Normally the repository root: a lane is a worktree cut from a branch, so
   * anything the operator has not committed — a plan written this morning, a
   * spec that never leaves their checkout — is present where they are and
   * missing where the agent is, and reaching for it is refused before the
   * model sees a byte.
   *
   * Granting a directory to `claude` grants writing in it too, so the grant is
   * paired with a deny list that keeps the lane as the only writable place
   * under it (`read-access.ts`). Empty means the working directory is the
   * whole world, which is what it was before this existed.
   */
  readonly readRoots?: readonly string[]
  /**
   * Where the per-lane settings file is written, when `readRoots` is set.
   *
   * A directory rather than a flag, because the policy cannot travel as one:
   * on Windows every spawn goes through `cmd.exe`, and a `"` cannot survive a
   * quoted region — `platform.ts` refuses such an argument outright rather than
   * escaping it cleverly. A JSON object is nothing but quotes. A path has none.
   *
   * Defaults to the OS temp directory. Hosts that have a store pass it there,
   * where `purge` can reach it.
   */
  readonly settingsDir?: string
  /** How long a spawn may go without an init frame before it is a `transient` refusal. */
  readonly startTimeoutMs?: number
  readonly preflightTimeoutMs?: number
}

const INSTALL_HINT =
  'npm install -g @anthropic-ai/claude-code (or point VINTA_AI_MAESTRO_CLAUDE_BIN at the binary)'

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = 'claude-code'
  readonly capabilities = CAPABILITIES
  readonly bin: string

  #forced: SpawnRefusalKind | null = null

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {
    this.bin = options.bin ?? process.env['VINTA_AI_MAESTRO_CLAUDE_BIN'] ?? 'claude'
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
   * binary at all, fails to spawn. "Authenticated" is the real invocation with
   * stdin closed immediately — the CLI reaches the point where it would need
   * credentials and exits, with no message sent and therefore no model turn
   * spent. Only an explicit auth signature flips `authenticated` to false, so
   * an unfamiliar startup diagnostic cannot lock a working machine out of a run.
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

    const session = await probe(this.bin, BASE_ARGS, timeout, childEnv(STRIPPED_ENV))
    const authenticated = !isAuthFailure(session.output)
    return {
      installed: true,
      authenticated,
      ...(reported === undefined || reported.length === 0 ? {} : { version: reported }),
      ...(authenticated ? {} : { hint: `${this.bin} /login` }),
    }
  }

  async spawn(task: AgentTask): Promise<SpawnOutcome> {
    const permission = this.options.permission ?? DEFAULT_PERMISSION
    const forced = this.#forced
    this.#forced = null
    if (forced !== null) {
      return {
        ok: false,
        kind: forced,
        message: `claude-code refused to spawn node ${task.nodeId}: ${forced} (injected)`,
      }
    }

    const args = [
      ...BASE_ARGS,
      // Without this the CLI runs in its default mode and asks before every
      // write. In `-p` there is nobody to ask: the request surfaces as a
      // `permission_request` event, the transcript renders it, and no answer is
      // ever sent — so the agent reports a blocked working directory and the
      // phase fails having written nothing.
      ...claudeCodeArgs(permission),
      ...readAccessArgs(
        permission,
        this.options.readRoots ?? [],
        task.cwd,
        this.options.settingsDir ?? tmpdir(),
      ),
      '--model',
      task.model,
      ...(task.resumeSessionId === undefined ? [] : ['--resume', task.resumeSessionId]),
    ]

    let child: ChildProcess
    try {
      // The platform decides how the binary is reached and whether the child
      // leads a group: on Windows `claude` is a `.cmd` shim behind `cmd.exe`.
      const spec = agentSpawn(this.bin, args)
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
    // The prompt goes in before the init frame is waited for: whether the CLI
    // announces itself before or after its first message is not this adapter's
    // business, and waiting on one to send the other would deadlock if it is
    // the latter.
    writeMessage(child, task.prompt)
    // Steering that queued up while this node had no live session (§9). It is
    // a second message rather than an addition to the brief, and it goes over
    // stdin like the brief does — never argv. `inject` being true does not
    // make this redundant: a node resumed after a capacity wait was not
    // running when the operator typed, so a resume is the only delivery it has.
    if (task.operatorText !== undefined) {
      writeMessage(child, operatorGuidance(task.operatorText))
    }

    return await this.#awaitStart(child, task)
  }

  /**
   * §9's take over. The *same* session the headless turn was running is
   * reopened interactively — no `-p`, no `--output-format`, because those are
   * exactly what makes it machine-parseable and unusable by a human. The
   * caller interrupted the headless turn before calling this and resumes from
   * `handle.sessionId` after the operator detaches; this adapter's only job is
   * that the id it is handed is the id the CLI is given.
   */
  async attachPty(sessionId: string, attach: PtyAttach): Promise<PtyHandle> {
    return openPty({
      sessionId,
      file: this.bin,
      args: ['--resume', sessionId],
      env: childEnv(STRIPPED_ENV, attach.env),
      attach,
    })
  }

  #awaitStart(child: ChildProcess, task: AgentTask): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      const queue = new EventQueue()
      const lines = new JsonLines()
      let session: ClaudeCodeSession | undefined
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
          message: `claude-code refused to spawn node ${task.nodeId}: no session within start timeout`,
        })
      }, this.options.startTimeoutMs ?? 120_000)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')

      child.stdout?.on('data', (chunk: string) => {
        for (const frame of lines.push(chunk)) {
          // Before the frame is mapped, because mapping it ends the session:
          // `ingest` sees the `session_ended` this same frame produces and
          // closes the queue, after which `noteRefusal` is a no-op.
          const refused = turnRefusal(frame)
          if (refused !== undefined) session?.noteRefusal(refused)
          for (const event of mapCliEvent(frame)) {
            if (event.type === 'session_started') {
              if (session !== undefined) continue
              session = new ClaudeCodeSession(event.sessionId, child, queue)
              queue.push(event)
              // The operator's words in the record of the run they steered
              // (§5.3, §15) — the same place `send` puts them. Pushed here
              // rather than at the write above because the queue only becomes
              // a stream anyone can read once the session exists.
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
          // The other shape of the same event: the CLI prints the window to
          // stderr and exits without a terminal frame. `diagnostics` is the
          // only place that sentence exists, and a turn that ends this way is
          // otherwise indistinguishable from a crash.
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
