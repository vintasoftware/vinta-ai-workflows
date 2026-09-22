/**
 * The machinery every harness adapter needs and none of them owns.
 *
 * `claude-code`, `codex` and `opencode` each grew their own copy of stream
 * framing, the push-to-pull event bridge, process-group signalling, the
 * `--version` probe, the credential-stripping env sanitizer, the value coercers
 * and the reset-time parser. Three independent copies is where a fix lands in
 * one adapter and not the other two, so they live here once.
 *
 * What deliberately does **not** live here is anything vendor-specific: each
 * adapter keeps its own refusal *signature table* and its own event mapping,
 * because those describe a particular CLI's output and belong next to the code
 * that knows that CLI. Only the matching machinery is shared.
 *
 * The rule this file exists to make cheap to keep: an adapter never imports
 * another adapter. Everything common flows through here.
 *
 * Nothing in this module puts prompt text, file contents or agent output into a
 * message field. Refusal messages carry node ids, fixed reason tokens and exit
 * codes only; vendor prose is read solely to be matched against a pattern.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import {
  commandInvocation,
  killTree,
  ownProcessGroup,
  type Platform,
  spawnOptionsFor,
} from '../platform/platform.ts'
import type {
  AgentEvent,
  AgentTask,
  CapacityKind,
  SpawnRefusal,
  SpawnRefusalKind,
  TurnRefusal,
} from './adapter.ts'

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Line-delimited JSON over a byte stream that splits wherever the OS felt like
 * splitting it. A chunk boundary lands mid-object often enough that treating
 * each `data` event as a whole line is the single most common way an adapter
 * corrupts a transcript.
 */
export class JsonLines {
  #partial = ''

  push(chunk: string): unknown[] {
    this.#partial += chunk
    const parts = this.#partial.split('\n')
    // The tail is whatever came after the last newline: a partial line, or ''.
    this.#partial = parts.pop() ?? ''
    const parsed: unknown[] = []
    for (const line of parts) {
      const text = line.trim()
      if (text.length === 0) continue
      try {
        parsed.push(JSON.parse(text))
      } catch {
        // Not a frame of ours — CLI banners and warnings share this pipe.
      }
    }
    return parsed
  }
}

// ---------------------------------------------------------------------------
// Operator steering
// ---------------------------------------------------------------------------

/**
 * How `AgentTask.operatorText` is presented to an agent that could not be
 * written to while it was running (§9).
 *
 * It is labelled rather than concatenated into the brief because the two have
 * different authors: an agent handed one undifferentiated blob cannot tell a
 * phase brief from a correction to it, and the correction is the part that is
 * supposed to win. Shared so all three adapters say the same thing — an
 * operator's steering must not mean different things per harness.
 *
 * This is task input on its way to the agent. It never reaches a log line, an
 * error message or a process argument; each adapter delivers it over the same
 * channel it sends the brief on, which for `codex` is stdin specifically so a
 * brief never lands in the process table.
 */
export const operatorGuidance = (text: string): string =>
  [
    'The operator added the following guidance for this node while it was not',
    'running. Treat it as a correction to the brief above: where the two',
    'conflict, this wins.',
    '',
    text,
  ].join('\n')

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

// ---------------------------------------------------------------------------
// Reported reset times
// ---------------------------------------------------------------------------

const SECONDS_RESET = /retry[- ]after(?:\s*[:=])?\s*(\d+)|retry (?:in|after) (\d+)\s*(?:s|sec|seconds)/
/** "try again in 2 hours 43 minutes" — codex's usual phrasing for a quota wait. */
const RELATIVE_RESET = /(?:try again|retry|resets?)\s+(?:in|after)\s+([0-9a-z ]{1,40})/
const RELATIVE_UNIT = /(\d+)\s*(hours?|minutes?|seconds?|hrs?|mins?|secs?|h|m|s)\b/g
const ISO_RESET = /(\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?)/
const EPOCH_RESET = /"?(?:resets?_?at|reset_time|x-ratelimit-reset)"?\s*[:=]\s*"?(\d{10,13})"?/
/**
 * A wall-clock reset, with the day when a day was named.
 *
 * One vendor sentence rendered five ways — "resets 3am", "resets at 3:30 pm",
 * "will reset at 15:00", "resets tomorrow at 2am", "resets on Monday at 12am"
 * — so everything but the hour is optional. Group 1 is the day word, 2 the
 * hour, 3 the minutes, 4 the meridiem.
 *
 * A date rather than a day ("resets Nov 3 at 9am") does not match, on purpose:
 * a month name with no year is a guess, and a reset nobody can resolve is
 * better left to the re-probe interval `AdmissionControl` caps a guessed
 * backoff at than turned into a wait that is wrong by a year.
 */
const CLOCK_RESET =
  /reset(?:s|ting)?(?:\s+(?:at|on))?\s+(?:(today|tomorrow|mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/

const WEEKDAY: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const UNIT_SECONDS: Record<string, number> = { h: 3_600, m: 60, s: 1 }

/** Sums a compound duration, so "2 hours 30 minutes" is one wait and not two. */
const relativeSeconds = (text: string): number => {
  let total = 0
  for (const [, amount, unit] of text.matchAll(RELATIVE_UNIT)) {
    if (amount === undefined || unit === undefined) continue
    total += Number(amount) * (UNIT_SECONDS[unit[0] ?? ''] ?? 0)
  }
  return total
}

/**
 * A reset time the vendor actually stated — a `Retry-After` header or seconds
 * count, relative phrasing, an epoch reset field, an ISO timestamp, or a
 * wall-clock hour. Guessing is the scheduler's job (exponential backoff with
 * jitter); this only reports what was said, and reports nothing when nothing
 * was said.
 *
 * Ordered most-explicit first: a stated delay is worth more than a timestamp
 * that happens to appear elsewhere in the same diagnostic (an HTTP failure is
 * matched against its status line *and* its body).
 */
export function parseRetryAfter(raw: string, now: Date = new Date()): Date | undefined {
  const text = raw.toLowerCase()

  const seconds = SECONDS_RESET.exec(text)
  const delay = seconds?.[1] ?? seconds?.[2]
  if (delay !== undefined) return new Date(now.getTime() + Number(delay) * 1_000)

  const relative = RELATIVE_RESET.exec(text)
  if (relative?.[1] !== undefined) {
    const total = relativeSeconds(relative[1])
    if (total > 0) return new Date(now.getTime() + total * 1_000)
  }

  const iso = ISO_RESET.exec(text)
  if (iso?.[1] !== undefined) {
    const at = new Date(iso[1].toUpperCase())
    if (!Number.isNaN(at.getTime())) return at
  }

  const epoch = EPOCH_RESET.exec(text)
  if (epoch?.[1] !== undefined) {
    const value = Number(epoch[1])
    const at = new Date(epoch[1].length >= 13 ? value : value * 1_000)
    if (!Number.isNaN(at.getTime())) return at
  }

  const clock = CLOCK_RESET.exec(text)
  if (clock !== null) return clockReset(clock, now)

  return undefined
}

/**
 * `CLOCK_RESET`'s match, resolved against `now` in the **local** zone.
 *
 * Local because local is the zone the vendor printed it in: the wording is
 * "resets at 4pm (America/Sao_Paulo)" — the operator's own zone, on the
 * operator's own machine, which is where this process is.
 *
 * An hour with neither minutes nor a meridiem is rejected rather than read as
 * 24-hour: "reset 3" is as likely to be part of a version, an error code or a
 * retry count, and everything this function returns becomes a wait.
 */
function clockReset(match: RegExpExecArray, now: Date): Date | undefined {
  const [, day, rawHour, rawMinute, meridiem] = match
  if (rawHour === undefined) return undefined
  if (meridiem === undefined && rawMinute === undefined) return undefined

  const hour = Number(rawHour)
  if (meridiem === undefined ? hour > 23 : hour < 1 || hour > 12) return undefined

  const at = new Date(now)
  at.setHours(
    meridiem === undefined ? hour : meridiem === 'pm' ? (hour % 12) + 12 : hour % 12,
    Number(rawMinute ?? 0),
    0,
    0,
  )

  if (day === 'tomorrow') {
    at.setDate(at.getDate() + 1)
    return at
  }

  const weekday = day === undefined || day === 'today' ? undefined : WEEKDAY[day]
  if (weekday !== undefined) {
    // The next occurrence of that weekday — today only while the hour is still
    // ahead. This is the weekly window's phrasing, and its reset is six days
    // out as often as it is one, which is the difference between one wait and
    // two thousand re-probes.
    const ahead = (weekday - at.getDay() + 7) % 7
    at.setDate(at.getDate() + (ahead === 0 && at.getTime() <= now.getTime() ? 7 : ahead))
    return at
  }

  // No day named: the next time that hour comes round, so "resets at 3pm" said
  // at 4pm is tomorrow's 3pm. A day the vendor *did* name is taken literally
  // even when it is already past — `AdmissionControl` clamps a reset in the
  // past to now, which costs one re-probe and is the right answer to a
  // sentence that contradicts itself.
  if (day === undefined && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at
}

// ---------------------------------------------------------------------------
// Refusal classification
// ---------------------------------------------------------------------------

/**
 * One row of an adapter's refusal table. The tables themselves stay in the
 * adapters: the patterns describe a particular vendor's wording, and a shared
 * table would be three vendors' vocabularies matching each other's output.
 */
export interface RefusalSignature {
  readonly kind: SpawnRefusalKind
  readonly reason: string
  readonly pattern: RegExp
}

/**
 * What the classifier needs to know about the spawn beyond what the vendor
 * said. Both fields are things the *caller* knows and the output cannot state.
 */
export interface RefusalContext {
  /** For resolving a reset time the vendor stated relative to now. */
  readonly now?: Date
  /**
   * Whether the task carried an `AgentTask.resumeSessionId` (§15.4).
   *
   * It gates the `stale_session` rows entirely: with no token there was nothing
   * to be stale, so a vendor saying "session not found" for some other reason
   * must fall through to the ordinary table rather than be reported as a
   * continuation the host should retry fresh. The caller passes it because only
   * the caller knows — and it must be the *token that failed*, not merely a
   * token that existed: opencode's server boot, for instance, can fail while a
   * task carries a session id that was never in play.
   */
  readonly resuming?: boolean
}

export interface RefusalClassifier {
  /** What the CLI or server said on its way out, as a refusal value. */
  classify(
    output: string,
    code: number | null,
    nodeId: string,
    context?: RefusalContext,
  ): SpawnRefusal
  /** The fixed label for whatever the vendor said, safe to put in a message field. */
  reasonFor(output: string): string
  /**
   * The same prose as a *capacity* signal, for a turn that had already started.
   *
   * `undefined` for anything that is not one — including `fatal` and
   * `stale_session`, which are the two kinds that are not waits: a turn that
   * died of a broken harness is a failed turn, and a forgotten session cannot
   * be forgotten by a session that is running. So this answers exactly one
   * question, "did the vendor's window close under this turn", and the caller
   * has nothing to re-derive from a kind it must not act on.
   */
  capacity(output: string, now?: Date): TurnRefusal | undefined
  /** Whether the named signature matches — how preflight recognizes a logged-out CLI. */
  matches(reason: string, output: string): boolean
}

/**
 * The classification context for a one-process-per-turn adapter, where every
 * failure on the way out belongs to the invocation that carried the token —
 * `--resume <id>` and `exec resume <id>` are arguments of the very process
 * whose diagnostics are being read, so there is no third state to distinguish.
 *
 * An adapter that talks to a long-lived server does *not* get to use this: a
 * boot failure there is not the session id being refused, and passing it as one
 * would turn "the server is down" into "retry with a fresh session" (§15.4).
 */
export const resumeContext = (task: AgentTask): RefusalContext => ({
  resuming: task.resumeSessionId !== undefined,
})

/** `exit 3` / `exit signal`. A process failed and its exit code is the code. */
const describeExit = (code: number | null): string => `exit ${code ?? 'signal'}`

/**
 * The ordered, first-match-wins classification the three adapters each
 * hand-rolled.
 *
 * The default is `fatal`. An unrecognized failure is by definition not a
 * recognized capacity signal, and calling it a wait converts a deterministic
 * misconfiguration into a run that stalls forever instead of reporting. Every
 * capacity condition a vendor produces announces itself in words, and those
 * words are the adapter's table.
 *
 * `describeCode` renders the trailing parenthetical. It is a parameter because
 * the code means different things per adapter — an exit code where a process
 * failed, an HTTP status where a request did — and the operator reads it.
 *
 * `stale_session` rows are the one kind this function reorders (§15.4). They
 * are hoisted ahead of the rest of the table and consulted only for a spawn
 * that carried a session id, because both halves of that are invariants no
 * adapter should be trusted to restate: a vendor announces a forgotten session
 * with wording that reads as transient ("session not found", a bare 404), so a
 * row sitting anywhere below `transient` would never win — and the same wording
 * from a spawn with no token to be stale must *not* win at all.
 */
export function classifier(
  harnessId: string,
  signatures: readonly RefusalSignature[],
  describeCode: (code: number | null) => string = describeExit,
): RefusalClassifier {
  const general = signatures.filter((signature) => signature.kind !== 'stale_session')
  const resumed = [
    ...signatures.filter((signature) => signature.kind === 'stale_session'),
    ...general,
  ]

  const find = (output: string, resuming: boolean): RefusalSignature | undefined =>
    (resuming ? resumed : general).find((signature) =>
      signature.pattern.test(output.toLowerCase()),
    )

  return {
    classify(output, code, nodeId, context = {}) {
      const now = context.now ?? new Date()
      const text = output.toLowerCase()
      const matched = find(text, context.resuming === true)
      const kind = matched?.kind ?? 'fatal'
      const reason = matched?.reason ?? 'unclassified'
      // Neither of these is a wait, so a reset time stated alongside one is
      // noise: `fatal` never runs again, and the answer to `stale_session` is
      // an immediate retry with a fresh session (§15.4) — a delay would buy
      // nothing, since a forgotten session does not come back.
      const waiting = kind !== 'fatal' && kind !== 'stale_session'
      const retryAfter = waiting ? parseRetryAfter(text, now) : undefined
      return {
        ok: false,
        kind,
        // Identifiers and vendor-independent labels only.
        message: `${harnessId} refused to spawn node ${nodeId}: ${reason} (${describeCode(code)})`,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      }
    },
    // Labels prose from a turn that already started, which by definition is not
    // a spawn refusing a session id — so the stale rows stay out of it.
    reasonFor: (output) => find(output, false)?.reason ?? 'unclassified',
    capacity(output, now) {
      // Same table, same first-match order, and the stale rows excluded for the
      // same reason `reasonFor` excludes them.
      const matched = find(output.toLowerCase(), false)
      if (matched === undefined) return undefined
      if (matched.kind === 'fatal' || matched.kind === 'stale_session') return undefined
      const retryAfter = parseRetryAfter(output.toLowerCase(), now ?? new Date())
      return {
        kind: matched.kind as CapacityKind,
        reason: matched.reason,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      }
    },
    matches: (reason, output) => {
      const signature = signatures.find((entry) => entry.reason === reason)
      return signature?.pattern.test(output.toLowerCase()) ?? false
    },
  }
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/**
 * The bridge from push to pull: a harness delivers events from a stdout handler
 * or an HTTP stream, while `AgentSession.events` is an `AsyncIterable` someone
 * pulls from. Single-consumer, which is the session contract — replay is the
 * journal's job.
 */
export class EventQueue {
  #items: AgentEvent[] = []
  #wake: (() => void) | null = null
  #closed = false

  push(event: AgentEvent): void {
    if (this.#closed) return
    this.#items.push(event)
    this.#signal()
  }

  close(): void {
    this.#closed = true
    this.#signal()
  }

  #signal(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  async *iterate(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.#items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }
}

/**
 * A harness runs tools, which are processes of their own and which inherit the
 * pipes this adapter is reading. Signalling the *tree* rather than the pid is
 * what keeps a killed node from leaving those children running behind it — and
 * holding the pipe open, so the stream never ends either.
 *
 * How a tree is reached is the platform's business, not this module's:
 * `killTree` signals the process group on POSIX and runs `taskkill /T` on
 * Windows. Falls back to the direct child when that fails, and stays silent
 * when the child is already reaped: killing a dead session is not an error.
 */
export const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.pid !== undefined && killTree(child.pid, signal)) return
  try {
    child.kill(signal)
  } catch {
    // Already reaped.
  }
}

/**
 * The spawn options every adapter shares for a long-lived agent process: its
 * own process group where the platform has them, and the quoting Windows needs
 * to reach a `.cmd` shim at all. Paired with `commandInvocation` below.
 */
export const agentSpawn = (
  bin: string,
  args: readonly string[],
  platform?: Platform,
): { file: string; args: string[]; options: { detached: boolean; windowsVerbatimArguments?: true } } => {
  const invocation = commandInvocation(bin, args, platform)
  return {
    file: invocation.file,
    args: [...invocation.args],
    options: { detached: ownProcessGroup(platform), ...spawnOptionsFor(invocation) },
  }
}

/**
 * The subscription constraint (§2), enforced at the process boundary: a child
 * must not be handed provider credentials that would let it bill an API account
 * instead of using the seat the user already logged into. Which keys those are
 * is the adapter's business, so the caller names them.
 */
export const childEnv = (
  strip: readonly string[],
  overlay: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...overlay }
  // After the overlay, not before. The overlay is a lane's own configuration
  // and has no business reinstating a key this list exists to remove — and a
  // strip that ran first would let it, silently, for every lane at once.
  for (const key of strip) delete env[key]
  return env
}

export interface ProbeResult {
  readonly spawned: boolean
  readonly output: string
  readonly code: number | null
}

/**
 * Run a binary with stdin closed and collect what it says. Costs no model turn,
 * which is what makes it usable for `--version` and for login checks.
 */
export const probe = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    let child: ChildProcess
    try {
      const invocation = commandInvocation(bin, args)
      child = spawnChild(invocation.file, [...invocation.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        ...spawnOptionsFor(invocation),
      })
    } catch (error) {
      resolve({ spawned: false, output: String(error), code: null })
      return
    }

    let output = ''
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ spawned: true, output, code: null })
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', (error) => finish({ spawned: false, output: String(error), code: null }))
    child.on('close', (code) => finish({ spawned: true, output, code }))
    child.stdin?.end()
  })
