/**
 * What a daemon log record is allowed to contain.
 *
 * This file is the whole §11 story for the log, and it is a mechanism rather
 * than a convention. The journal gets to be careful by construction — its
 * payloads are a closed union, every field of which was written on purpose. A
 * log is the opposite shape: it is called from anywhere, by whoever is
 * debugging something that week, usually in a hurry and usually next to an
 * error object. "Please do not log repository contents" is not a control; it
 * is a hope, and every system that has leaked a customer's source into a log
 * file had that hope written down somewhere.
 *
 * So three rules are enforced here instead of asked for:
 *
 * - **Scalars only.** `Field` admits a string, a finite number, a boolean or
 *   null, and nothing else. An object is *dropped*, never stringified —
 *   stringifying is precisely how a diff, a file read or an HTTP body becomes
 *   a log line, and a caller who really means to log one of its fields can
 *   name that field.
 * - **Short.** Values are capped at `MAX_FIELD_CHARS`. Identifiers are short
 *   by nature — a run id, a node id, a status, an exit code, a path — and
 *   repository content is not. The cap does not make a leak impossible, but it
 *   bounds one to a single truncated line, and it makes a field that wants to
 *   be long obvious to whoever wrote it.
 * - **Never the secret.** Field *names* that are secrets by their name are
 *   redacted, and so is any value that contains a secret registered with
 *   `redactValue` — which `serve` uses for the daemon token, the one string in
 *   this process that is access rather than information (§11).
 *
 * The rules above are about fields a caller *composes*. An error is the one
 * thing callers hand over whole, and it gets its own treatment in
 * `errorFields` below: its kind always, and its message by default, with the
 * message as the single allowlisted prose field — capped longer than an
 * identifier, redacted like everything else, and narrowable to the kind alone
 * by an operator who wants that. The reasoning for that default, including why
 * it is not the conservative-looking one, is on `errorDetail`.
 */

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LEVELS)[number]

/** Ordering, for `--log-level` and the UI's filter. Higher is louder. */
const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

export function atLeast(level: LogLevel, threshold: LogLevel): boolean {
  return RANK[level] >= RANK[threshold]
}

export function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

/**
 * The only value shapes a field may hold. Deliberately not `unknown`: see the
 * module note — this type is the first of the three controls.
 */
export type Field = string | number | boolean | null

export type Fields = Readonly<Record<string, Field>>

/**
 * Long enough for a path or a sanitized failure reason, short enough that a
 * line which wanted to be a file is visibly cut off instead of quietly stored.
 */
export const MAX_FIELD_CHARS = 200

/**
 * The cap for the one field that is deliberately prose.
 *
 * `message` carries an error's own words, which is the single most useful
 * string in a failure record and the reason `detail` defaults to including it
 * (see `errorDetail` below). Two hundred characters is the wrong cap for it —
 * a compiler's complaint or a git diagnostic is routinely longer than that,
 * and cutting one at the second clause removes exactly the part that said what
 * went wrong. Two thousand is still a bound, so a message that wanted to be a
 * file is still cut off.
 */
export const MAX_MESSAGE_CHARS = 2000

/**
 * Fields that are prose by design and get the longer cap.
 *
 * Deliberately an explicit allowlist of one rather than a length argument on
 * `sanitize`. Every other field in this system is an identifier, and a caller
 * who wants a long value has to be writing into a key this file has agreed is
 * allowed to hold one.
 */
const LONG_FIELDS = new Set(['message'])

/** Field names that are the secret, whatever the value turns out to be. */
const SECRET_KEYS = new Set([
  'token',
  'authorization',
  'auth',
  'secret',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'api_key',
  'apikey',
  'cookie',
])

/**
 * Keys are identifiers too. A key from outside — a header name, a query
 * parameter — would otherwise be a second, unexamined channel into the file.
 */
const KEY = /^[a-z][a-z0-9_]{0,39}$/

export const REDACTED = '<redacted>'

/**
 * One record, as written and as read back.
 *
 * `seq` is per-process and monotonic within it. It is not a cursor — the file
 * is, and `log/read.ts` owns that — but it is what tells two records written
 * in the same millisecond apart, which matters exactly when a burst of them is
 * the thing being read.
 */
export interface LogRecord {
  readonly ts: number
  readonly seq: number
  readonly pid: number
  readonly level: LogLevel
  /** A dotted identifier from the writer's own vocabulary: `daemon.listening`. */
  readonly event: string
  readonly runId?: string
  readonly nodeId?: string
  readonly fields: Fields
}

/**
 * Values that must never appear in a record, registered by whoever holds one.
 *
 * Process-global because the thing being protected is: there is one daemon
 * token per process and it reaches modules that have no business knowing they
 * are near a logger. A `Set` of exact strings rather than a pattern, because a
 * pattern that tried to recognise "a token" would either miss this one or
 * redact half the run ids.
 */
const secrets = new Set<string>()

/**
 * Registers a string as a secret for the life of the process. Values holding
 * it — not just equalling it, so a URL carrying it is caught too — are
 * replaced wholesale.
 *
 * Short strings are ignored: registering a two-character secret would redact
 * most of the log, and nothing that short is one.
 */
export function redactValue(value: string): void {
  if (value.length >= 8) secrets.add(value)
}

/** Only for tests, which must not leak a registration into the next one. */
export function clearRedactions(): void {
  secrets.clear()
}

/**
 * Applies all three rules. Unknown keys and unknown value shapes are dropped
 * rather than coerced, and the count of what was dropped is not reported —
 * a caller logging an object has a bug in their call site, not a fact to
 * record.
 */
export function sanitize(fields: Readonly<Record<string, unknown>> | undefined): Fields {
  if (fields === undefined) return {}
  const out: Record<string, Field> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!KEY.test(key)) continue
    if (SECRET_KEYS.has(key)) {
      out[key] = REDACTED
      continue
    }
    const clean = scalar(value, key)
    if (clean !== undefined) out[key] = clean
  }
  return out
}

function scalar(value: unknown, key: string): Field | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  return text(value, LONG_FIELDS.has(key) ? MAX_MESSAGE_CHARS : MAX_FIELD_CHARS)
}

function text(value: string, cap: number): string {
  // Redaction is checked before the cap, so a secret cannot survive by sitting
  // past the truncation point of a long field.
  for (const secret of secrets) {
    if (value.includes(secret)) return REDACTED
  }
  return value.length <= cap ? value : `${value.slice(0, cap)}…`
}

/**
 * An error, reduced to what is safe to keep: its name, and the runtime's code
 * where there is one.
 *
 * Not its message. The scheduler's `failureReason` makes one exception — for
 * this package's own error classes, which are built from identifiers — and
 * this makes none, because a logger is reached from call sites that have not
 * established what they are holding. A caller who knows their error is
 * identifiers can log the field it wants by name.
 */
export function errorKind(error: unknown): string {
  if (error === undefined) return 'undefined'
  if (error === null) return 'null'
  const named = error as { name?: unknown; code?: unknown }
  const name = typeof named.name === 'string' && named.name.length > 0 ? named.name : 'Error'
  return typeof named.code === 'string' ? `${name}: ${named.code}` : name
}

/** How much of an error is recorded, process-wide. See `errorDetail`. */
export type ErrorDetail = 'kind' | 'message'

/**
 * Whether an error's own words are recorded beside its kind.
 *
 * **`message` is the default**, and the reasoning is worth writing down
 * because it went the other way first.
 *
 * The objection to recording a message is real: it is composed by whoever
 * threw it, so a git diagnostic, a gate's output or a line of a source file
 * can end up in it. What that objection missed is where this file lives.
 * `.vinta-ai-maestro/runs/` already holds every agent transcript and every
 * gate log **verbatim** (§5.3), in the same gitignored store, under the same
 * `purge`. An error message is a rounding error against a directory that is
 * already a copy of the repository — so excluding it bought no protection
 * worth having and cost the one string that most often explains a failure.
 *
 * §11's "structured log fields carry opaque identifiers" still governs
 * everything else here, and it is still enforced by `sanitize`: `message` is
 * the single allowlisted prose field, it is capped, and a registered secret in
 * it is redacted like anywhere else.
 *
 * `kind` remains available for a checkout where even that is too much — a
 * client engagement with a stricter data-handling obligation than this
 * package's own store implies. It is a flag, not the default, because the
 * default should fit the ordinary case.
 *
 * Process-global and set once at boot, like `redactValue` and for the same
 * reason: the call sites that record an error are all over the package and
 * have no business being told about an operator's logging preference.
 */
let detail: ErrorDetail = 'message'

export function setErrorDetail(next: ErrorDetail): void {
  detail = next
}

export function errorDetail(): ErrorDetail {
  return detail
}

/**
 * An error as log fields: always its kind, and its message unless the operator
 * narrowed that.
 *
 * Spread into a call rather than returning a string, so every site records the
 * same two keys under the same two names — `error` and `message` — and the
 * UI's filter can rely on that.
 */
export function errorFields(error: unknown, override?: ErrorDetail): Fields {
  const kind = errorKind(error)
  if ((override ?? detail) === 'kind') return { error: kind }
  const message = (error as { message?: unknown })?.message
  return typeof message === 'string' && message.length > 0
    ? { error: kind, message }
    : { error: kind }
}

/** One NDJSON line, terminator included. The file format, in one place. */
export function encodeRecord(record: LogRecord): string {
  return `${JSON.stringify({
    ts: record.ts,
    seq: record.seq,
    pid: record.pid,
    level: record.level,
    event: record.event,
    ...(record.runId === undefined ? {} : { run: record.runId }),
    ...(record.nodeId === undefined ? {} : { node: record.nodeId }),
    ...(Object.keys(record.fields).length === 0 ? {} : { fields: record.fields }),
  })}\n`
}

/**
 * One line back, or `null` for a line this reader cannot trust.
 *
 * `null` rather than a throw, and rather than a partial record: a log file is
 * appended to by more than one process and can be truncated by a machine that
 * lost power mid-write, so a torn last line is an ordinary thing to find and
 * not a reason to fail the read that was going to explain the outage.
 */
export function decodeRecord(line: string): LogRecord | null {
  if (line.length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (!isLevel(row['level'])) return null
  if (typeof row['event'] !== 'string') return null
  if (typeof row['ts'] !== 'number' || typeof row['seq'] !== 'number') return null
  if (typeof row['pid'] !== 'number') return null
  return {
    ts: row['ts'],
    seq: row['seq'],
    pid: row['pid'],
    level: row['level'],
    event: row['event'],
    ...(typeof row['run'] === 'string' ? { runId: row['run'] } : {}),
    ...(typeof row['node'] === 'string' ? { nodeId: row['node'] } : {}),
    // Re-sanitized on the way in as well as on the way out. The file is
    // appended to by other processes and edited by nobody, but "nobody" is an
    // assumption about a file sitting in a checkout, and this is one call.
    fields: sanitize(
      typeof row['fields'] === 'object' && row['fields'] !== null
        ? (row['fields'] as Record<string, unknown>)
        : undefined,
    ),
  }
}
