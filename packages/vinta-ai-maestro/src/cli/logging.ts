/**
 * Turning three flags into a logger, in one place both commands use.
 *
 * `serve` and `run` both host a daemon and both need the same thing, and the
 * failure this unit exists to prevent is precisely the kind that would come
 * from the two of them disagreeing about where the file goes — a crash logged
 * to a directory nobody looks in is a crash nobody can read.
 *
 * The flags are validated here and not parsed here: `parseArgs` lives in the
 * commands, which already own their usage text, and this takes the strings it
 * produced.
 */
import {
  LEVELS,
  createFileSink,
  createLogger,
  formatRecord,
  isLevel,
  logDirFor,
  redactValue,
  setErrorDetail,
  type CrashDetail,
  type FileSink,
  type LogLevel,
  type LogRecord,
  type Logger,
} from '../log/index.ts'
import { storeFor } from './paths.ts'
import type { Io } from './io.ts'

export interface LogValues {
  readonly 'log-level'?: string | undefined
  readonly 'log-stderr'?: boolean | undefined
  readonly 'log-detail'?: string | undefined
}

export interface LogSetup {
  readonly logger: Logger
  readonly sink: FileSink
  readonly detail: CrashDetail
  /** The file, for the line `serve` prints beside the URL. */
  readonly path: string
}

/** `null` on a bad flag; the message names the flag and its accepted values. */
export function toLogSetup(values: LogValues, repoPath: string, io: Io, token?: string): LogSetup | null {
  const requested = values['log-level']
  if (requested !== undefined && !isLevel(requested)) {
    io.err(`vinta-ai-maestro: --log-level must be one of ${LEVELS.join(', ')}`)
    return null
  }
  const detail = values['log-detail']
  if (detail !== undefined && detail !== 'kind' && detail !== 'message') {
    io.err('vinta-ai-maestro: --log-detail must be one of kind, message')
    return null
  }

  // Before the first record is written, which is the only ordering that makes
  // this a control rather than a hope: from here on a field holding the token
  // — a URL somebody logged, a header somebody passed through — comes back
  // `<redacted>` instead of being the access to the run (§11).
  if (token !== undefined) redactValue(token)

  // Process-wide, and set here because this is the only place that knows what
  // the operator asked for. Every call site that records an error reads it
  // through `errorFields` rather than being handed a setting it has no other
  // use for.
  setErrorDetail((detail ?? 'message') as CrashDetail)

  const level: LogLevel = requested ?? 'info'
  const sink = createFileSink({
    dir: logDirFor(storeFor(repoPath)),
    // stderr gets the human rendering, not the JSON: somebody watching a
    // terminal is reading, and the file is what a machine reads.
    ...(values['log-stderr'] === true
      ? { mirror: (record: LogRecord) => io.err(formatRecord(record)) }
      : {}),
  })

  return {
    logger: createLogger({ sink, level }),
    sink,
    detail: (detail ?? 'message') as CrashDetail,
    path: sink.path,
  }
}

/**
 * What to say on the way out when the log could not be written.
 *
 * The one thing a logger cannot report about itself. A full disk or a
 * read-only checkout makes every `write` a no-op — deliberately, so
 * instrumentation cannot take down a run — and the resulting empty file is
 * indistinguishable from a daemon that had nothing to say. This is the
 * distinction, and it goes to stderr because stderr is the channel that still
 * works.
 */
export function reportLogFailures(sink: FileSink, io: Io): void {
  if (sink.failures === 0) return
  io.err(
    `vinta-ai-maestro: ${sink.failures} log record(s) could not be written to ${sink.path}. ` +
      'The daemon ran normally; its log is incomplete.',
  )
}
