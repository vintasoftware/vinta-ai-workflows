/**
 * The last thing this process does: say why it is going.
 *
 * ### The failure this exists for
 *
 * A run is hours of agent turns and a real amount of money. The scheduler
 * dispatches each node as a floating promise — `void this.#runNode(state)` —
 * and while `#runNode` catches broadly around the work, the code *around* that
 * catch does not: a throw from `#fail`, `#release` or a journal write escapes
 * into a promise nobody is holding. Node's answer to that is to terminate the
 * process, which is the correct answer and a completely silent one. The
 * operator sees a plan that was running and then was not, with no transcript
 * entry, no journal row and no line anywhere saying what happened — because
 * the thing that would have said it is the thing that died.
 *
 * Every handler here exists to convert that into a record on disk before the
 * process goes.
 *
 * ### It does not keep the process alive
 *
 * An `uncaughtException` handler that swallows and continues is worse than no
 * handler. The exception unwound an unknown number of frames on its way out;
 * whatever invariant the code between them was maintaining is now half
 * maintained, and a scheduler running on a heap in that state will make
 * decisions about worktrees and git branches. So this logs, gives the host one
 * synchronous chance to make its runs resumable (`onFatal` — `serve` writes
 * `run_ended` for everything in flight), and exits. Same for
 * `unhandledRejection`, which Node already terminates on: the behaviour is
 * unchanged, and the only difference is that now there is a reason on disk.
 *
 * ### What a crash record holds
 *
 * The error's kind, its **message**, its stack frames, and the ids of every
 * run that was in flight. Frames are source locations — a path, a function
 * name, a line number — and they are what turns "a TypeError" into a place to
 * look; the message is what turns it into a reason.
 *
 * `--log-detail kind` drops the message, for a checkout whose data-handling
 * obligation is stricter than this package's own store implies. It is not the
 * default: see `errorDetail` in `record.ts` for why the conservative-looking
 * choice was the wrong one here.
 */
import { errorFields, type ErrorDetail, type Fields } from './record.ts'
import type { Logger } from './logger.ts'

/** How much of an error is recorded. `record.ts` owns the meaning and the default. */
export type CrashDetail = ErrorDetail

/** Stack frames kept. Enough to name the path in; not enough to be a file. */
const FRAMES = 8

export interface CrashOptions {
  readonly logger: Logger
  /**
   * Overrides the process-wide setting (`setErrorDetail`) for these handlers
   * only. Absent means "whatever the operator chose", which is what `serve`
   * and `run` both rely on; supplying one is for tests.
   */
  readonly detail?: CrashDetail
  /**
   * The host's one chance to leave durable state behind, called after the
   * record is written and before the exit.
   *
   * It must be synchronous and it must not throw: there is no second handler
   * behind this one. `serve` uses it to journal `run_ended` for every run it
   * was driving, which is what makes a crashed daemon's runs resumable rather
   * than permanently `running`.
   */
  readonly onFatal?: (event: FatalEvent) => void
  /** Runs in flight, named in the record. A crash's blast radius, on the record. */
  readonly inFlight?: () => readonly string[]
  /** Injected in tests, which must not exit the runner. */
  readonly exit?: (code: number) => void
  /** Injected in tests. Defaults to the real process. */
  readonly target?: CrashTarget
}

export type FatalEvent = 'uncaught_exception' | 'unhandled_rejection'

/** The slice of `process` this needs, so a test can hand it an emitter. */
export interface CrashTarget {
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
}

/**
 * Installs the handlers. Returns the function that removes them again —
 * required, not a nicety: a test that left these on would catch the next
 * test's rejections, and `serve` removes them so a clean shutdown does not
 * leave a listener on a process trying to exit.
 */
export function installCrashHandlers(options: CrashOptions): () => void {
  const target = options.target ?? (process as unknown as CrashTarget)
  const exit = options.exit ?? ((code: number) => process.exit(code))

  const fatal = (event: FatalEvent, error: unknown): void => {
    // Wrapped, because a logger that throws here would replace the crash
    // report with a crash inside the crash report.
    try {
      options.logger.error(`daemon.${event}`, {
        ...errorFields(error, options.detail),
        ...runs(options.inFlight),
        ...stackFields(error),
      })
    } catch {
      // Nothing left to report it to.
    }
    try {
      options.onFatal?.(event)
    } catch {
      // The host's teardown failed too. The record above is already durable,
      // which is the part that had to survive.
    }
    exit(1)
  }

  const onException = (error: unknown): void => fatal('uncaught_exception', error)
  const onRejection = (reason: unknown): void => fatal('unhandled_rejection', reason)

  /**
   * Process warnings are not crashes, and one of them is the reliable early
   * sign of the bug that becomes one: `MaxListenersExceededWarning` is what a
   * long run leaking a listener per node looks like an hour before it matters.
   * Recorded at `warn`, by name — the warning's own message is prose from
   * whoever emitted it and gets the same treatment as an error's.
   */
  const onWarning = (warning: { name?: string; code?: string }): void => {
    try {
      options.logger.warn('daemon.process_warning', {
        warning: typeof warning.name === 'string' ? warning.name : 'Warning',
        ...(typeof warning.code === 'string' ? { code: warning.code } : {}),
      })
    } catch {
      // As above.
    }
  }

  target.on('uncaughtException', onException as (...args: never[]) => void)
  target.on('unhandledRejection', onRejection as (...args: never[]) => void)
  target.on('warning', onWarning as (...args: never[]) => void)

  return () => {
    target.off('uncaughtException', onException as (...args: never[]) => void)
    target.off('unhandledRejection', onRejection as (...args: never[]) => void)
    target.off('warning', onWarning as (...args: never[]) => void)
  }
}

function runs(inFlight: (() => readonly string[]) | undefined): Fields {
  if (inFlight === undefined) return {}
  let ids: readonly string[]
  try {
    ids = inFlight()
  } catch {
    return {}
  }
  // Run ids are identifiers and short; the field cap truncates a pathological
  // number of them rather than this inventing a second limit.
  return ids.length === 0 ? { runs: 0 } : { runs: ids.length, run_ids: ids.join(',') }
}

/**
 * The frames, numbered.
 *
 * Numbered scalar fields rather than one joined string because `Field` admits
 * scalars only (`record.ts`) and a joined stack would be cut off by the field
 * cap at the second frame — which is the least useful place to cut a stack.
 *
 * Exported because a crash is not the only failure whose *location* is the
 * whole question: a lane pool that throws leaves the operator a one-line
 * refusal by design, and then the frames are the only record of where it came
 * from.
 */
export function stackFields(error: unknown): Fields {
  const out: Record<string, string> = {}
  for (const [index, frame] of frames(error).entries()) out[`stack_${index}`] = frame
  return out
}

/**
 * `error.stack` reduced to its `at …` lines.
 *
 * The first line of a V8 stack is `Name: message`, and dropping it is what
 * keeps `--log-detail kind` meaning something — a stack carrying its own
 * header would smuggle the message back into the one mode that excludes it.
 * On the default path it is simply a duplicate of the `message` field.
 */
function frames(error: unknown): readonly string[] {
  const stack = (error as { stack?: unknown })?.stack
  if (typeof stack !== 'string') return []
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, FRAMES)
}
