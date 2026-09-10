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
import type { AgentEvent, SpawnRefusal, SpawnRefusalKind } from './adapter.ts'

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
const HOUR_RESET = /reset(?:s|ting)?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/

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

  const hour = HOUR_RESET.exec(text)
  if (hour?.[1] !== undefined && hour[3] !== undefined) {
    const base = Number(hour[1]) % 12
    const at = new Date(now)
    at.setHours(hour[3] === 'pm' ? base + 12 : base, Number(hour[2] ?? 0), 0, 0)
    // "resets at 3pm" said at 4pm means tomorrow's 3pm.
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
    return at
  }

  return undefined
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

export interface RefusalClassifier {
  /** What the CLI or server said on its way out, as a refusal value. */
  classify(output: string, code: number | null, nodeId: string, now?: Date): SpawnRefusal
  /** The fixed label for whatever the vendor said, safe to put in a message field. */
  reasonFor(output: string): string
  /** Whether the named signature matches — how preflight recognizes a logged-out CLI. */
  matches(reason: string, output: string): boolean
}

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
 */
export function classifier(
  harnessId: string,
  signatures: readonly RefusalSignature[],
  describeCode: (code: number | null) => string = describeExit,
): RefusalClassifier {
  const find = (output: string): RefusalSignature | undefined =>
    signatures.find((signature) => signature.pattern.test(output.toLowerCase()))

  return {
    classify(output, code, nodeId, now = new Date()) {
      const text = output.toLowerCase()
      const matched = find(text)
      const kind = matched?.kind ?? 'fatal'
      const reason = matched?.reason ?? 'unclassified'
      // `fatal` is not a wait, so a reset time stated alongside one is noise.
      const retryAfter = kind === 'fatal' ? undefined : parseRetryAfter(text, now)
      return {
        ok: false,
        kind,
        // Identifiers and vendor-independent labels only.
        message: `${harnessId} refused to spawn node ${nodeId}: ${reason} (${describeCode(code)})`,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      }
    },
    reasonFor: (output) => find(output)?.reason ?? 'unclassified',
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
export const childEnv = (strip: readonly string[]): NodeJS.ProcessEnv => {
  const env = { ...process.env }
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
