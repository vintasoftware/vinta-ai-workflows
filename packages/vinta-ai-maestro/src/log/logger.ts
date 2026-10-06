/**
 * The logger the daemon holds, and the two sinks behind it.
 *
 * ### It writes synchronously, on purpose
 *
 * `appendFileSync`, per record, like the journal's transcript writes. A
 * buffered logger loses whatever was in the buffer when the process dies, and
 * the records in that buffer are — every single time — the ones describing why
 * it died. A log that is fast right up until the moment it matters is not a
 * log. The cost is a write syscall per record on a daemon that produces a few
 * per second, which is not a cost.
 *
 * ### Absent is not an error
 *
 * `nullLogger()` is a real implementation that discards, and every consumer
 * takes `logger?: Logger` and falls back to it. That keeps the logger from
 * becoming a required dependency threaded through constructors that have no
 * other reason to know about it — a test composing a scheduler does not have
 * to build a log directory to do so.
 *
 * ### A failed write is swallowed
 *
 * Deliberately, and this is the one place in this package where swallowing is
 * right. A full disk or a read-only checkout must not take down a run whose
 * agents are mid-turn; the logger is instrumentation, and instrumentation that
 * can fail its host is a liability. The failure is not silent to the operator,
 * though — `sink.failures` counts it, and `serve` reports a non-zero count on
 * shutdown, so "the log is empty" and "the log could not be written" are
 * distinguishable without the log itself being the thing that has to say so.
 */
import { appendFileSync } from 'node:fs'
import {
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  activeGeneration,
  activePath,
  ensureDir,
  rotate,
  sizeOf,
} from './files.ts'
import { atLeast, encodeRecord, sanitize, type Fields, type LogLevel, type LogRecord } from './record.ts'

/** What a record is addressed to. Both are identifiers (§11). */
export interface LogContext {
  readonly runId?: string
  readonly nodeId?: string
}

export interface Logger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void
  info(event: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void
  error(event: string, fields?: Readonly<Record<string, unknown>>): void
  /**
   * A logger that stamps `runId`/`nodeId` on everything it writes.
   *
   * The reason the context is not just two more fields: the UI filters on
   * them, and a filter is only as good as the discipline of whoever remembered
   * to pass the field. A child makes remembering structural — the scheduler
   * builds one per node and every record from that node carries it, including
   * the ones written by code that has never heard of a run.
   */
  child(context: LogContext): Logger
  /** Whether a level would be written. Lets a caller skip building fields. */
  enabled(level: LogLevel): boolean
}

/** Where records go. A file in production; an array in tests. */
export interface Sink {
  write(record: LogRecord): void
  /** Writes this sink could not complete. Non-zero means the log is incomplete. */
  readonly failures: number
}

export interface LoggerOptions {
  readonly sink: Sink
  /** Records below this are not built and not written. Defaults to `info`. */
  readonly level?: LogLevel
  readonly context?: LogContext
  /** Injected in tests so a record's `ts` is not the wall clock. */
  readonly now?: () => number
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info'
  const now = options.now ?? Date.now
  // Per process, and shared by every child: two records written in the same
  // millisecond are ordered by this and by nothing else.
  const counter = { next: 0 }
  return build(options.sink, level, options.context ?? {}, now, counter)
}

function build(
  sink: Sink,
  level: LogLevel,
  context: LogContext,
  now: () => number,
  counter: { next: number },
): Logger {
  const write = (recordLevel: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>): void => {
    if (!atLeast(recordLevel, level)) return
    counter.next += 1
    sink.write({
      ts: now(),
      seq: counter.next,
      pid: process.pid,
      level: recordLevel,
      event,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(context.nodeId === undefined ? {} : { nodeId: context.nodeId }),
      fields: sanitize(fields),
    })
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    enabled: (candidate) => atLeast(candidate, level),
    child: (next) =>
      build(
        sink,
        level,
        {
          ...(next.runId ?? context.runId ? { runId: next.runId ?? context.runId } : {}),
          ...(next.nodeId ?? context.nodeId ? { nodeId: next.nodeId ?? context.nodeId } : {}),
        } as LogContext,
        now,
        counter,
      ),
  }
}

/** Discards everything. The default wherever a logger is optional. */
export function nullLogger(): Logger {
  const self: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    enabled: () => false,
    child: () => self,
  }
  return self
}

export interface FileSinkOptions {
  readonly dir: string
  /** Rotate once the active file would pass this. Defaults to 8 MiB. */
  readonly maxBytes?: number
  /** Rotated files kept. Defaults to five. */
  readonly keep?: number
  /** Also hand each record here — `serve`'s stderr mirror, when asked for. */
  readonly mirror?: (record: LogRecord) => void
}

export interface FileSink extends Sink {
  /** The file being appended to right now. Moves when the sink rotates. */
  readonly path: string
  /** Bytes in the active file, as this sink last counted them. */
  readonly bytes: number
  /**
   * The generation this sink is writing into (`files.ts`). Worth having on the
   * record because it is what makes a reader's `reset` explicable after the
   * fact: "the file you were reading rotated at 14:02" is a different problem
   * from "the file you were reading was pruned".
   */
  readonly generation: number
}

/**
 * Appends NDJSON to `<dir>/daemon.ndjson`, rotating by size.
 *
 * The size is tracked in memory and seeded from the file, rather than
 * `stat`-ed per write. A second daemon appending to the same file makes that
 * count an underestimate, which delays a rotation and never skips one — the
 * next `stat`, at the next open, corrects it. Paying a `stat` per record to
 * tighten a rotation threshold would be the wrong trade in the one code path
 * that runs on every single record.
 */
export function createFileSink(options: FileSinkOptions): FileSink {
  const { dir } = options
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = options.keep ?? DEFAULT_KEEP

  let failures = 0
  try {
    ensureDir(dir)
  } catch {
    // The same rule as a failed write, applied to the moment before the first
    // one: a read-only checkout, or a file sitting where the directory should
    // be, must not stop a daemon from starting. Every `write` below then fails
    // the same way and `failures` is what says so.
    failures += 1
  }
  // Read once here rather than per write; see the note above.
  let bytes = sizeOf(activePath(dir))
  let generation = activeGeneration(dir)

  return {
    get path() {
      return activePath(dir)
    },
    get bytes() {
      return bytes
    },
    get generation() {
      return generation
    },
    get failures() {
      return failures
    },
    write(record) {
      const line = encodeRecord(record)
      const size = Buffer.byteLength(line)
      try {
        if (bytes > 0 && bytes + size > maxBytes) {
          generation = rotate(dir, keep)
          bytes = 0
        }
        appendFileSync(activePath(dir), line)
        bytes += size
      } catch {
        // See the module note: instrumentation never fails its host.
        failures += 1
      }
      // After the file, so a mirror that throws cannot cost the durable copy.
      if (options.mirror !== undefined) {
        try {
          options.mirror(record)
        } catch {
          failures += 1
        }
      }
    },
  }
}

/** Keeps records in memory. For tests, and for nothing else. */
export function createMemorySink(): Sink & { readonly records: readonly LogRecord[] } {
  const records: LogRecord[] = []
  return {
    records,
    failures: 0,
    write: (record) => {
      records.push(record)
    },
  }
}

/**
 * One record as a line for a terminal: the level, the event, the context, and
 * the fields as `key=value`.
 *
 * Not the file format — that is `encodeRecord`, and it stays JSON so the file
 * is machine-readable. This is the mirror `serve --log-level` prints to
 * stderr for somebody watching the daemon in a terminal, where the JSON would
 * be a wall.
 */
export function formatRecord(record: LogRecord): string {
  const where = [record.runId, record.nodeId].filter((part) => part !== undefined).join('/')
  const fields = Object.entries(record.fields)
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
    .join(' ')
  return [
    record.level.toUpperCase().padEnd(5),
    record.event,
    where.length === 0 ? '' : `[${where}]`,
    fields,
  ]
    .filter((part) => part.length > 0)
    .join(' ')
}

export type { Fields }
