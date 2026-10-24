/**
 * The first failure in a gate's log, for the operator's own terminal.
 *
 * A red base or wave gate used to be reported with a diagnosis — "a
 * regression between" the phases — that one observed run found wrong three
 * times out of three: a stale test database, a container a killed gate left
 * running, a cross-phase break a fixer had already fixed elsewhere. What
 * settles it is the failure itself, and finding it meant opening a log of tens
 * of thousands of lines. So the errors now name the log and the command that
 * prints this, and nothing more.
 *
 * Read locally, by `logs --failures`, and printed to whoever ran it — never put
 * into an error, an event or a notification: it is the suite's output, which
 * is repository content (§11).
 *
 * Patterns cover the usual runners: pytest's summary and `E` lines, Jest and
 * Vitest's `FAIL` / `●` / `×`, Go's `--- FAIL`, RSpec, `tsc`, mypy and the
 * generic `error:` line a compiler or linter prints. A log that matches none of
 * them answers null, and the caller says so.
 */

/** Where a failing test is named. */
const TEST_LINE: readonly RegExp[] = [
  /^(FAILED|ERROR) \S+/, // pytest short summary
  /^_{3,} (\S.*\S) _{3,}$/, // pytest failure header
  /^\s*(FAIL|×|✕|●) \S/, // jest, vitest
  /^--- FAIL: \S+/, // go test
  /^rspec \.\/\S+:\d+/, // rspec rerun line
]

/** The line that says what went wrong. */
const CAUSE_LINE: readonly RegExp[] = [
  /^E\s{2,}\S/, // pytest
  /\b\w*(Error|Exception)\b[:(]/,
  /\berror TS\d+:/, // tsc
  /:\d+(:\d+)?: error:/, // mypy, gcc
  /^\s*(expected|Expected|AssertionError|assert )/,
  /\b(FAIL|failed)\b/,
]

export interface FirstFailure {
  /** The line naming the failing test, or null when the log names none. */
  readonly test: string | null
  /** The first line after it, or anywhere, that says what went wrong. */
  readonly cause: string | null
  /** 1-based line numbers, so the operator can open the log there. */
  readonly testLine: number | null
  readonly causeLine: number | null
}

export function firstFailure(log: string): FirstFailure | null {
  const lines = log.split(/\r?\n/)
  const testAt = lines.findIndex((line) => TEST_LINE.some((pattern) => pattern.test(line)))
  const from = testAt === -1 ? 0 : testAt + 1
  let causeAt = lines.findIndex((line, index) => index >= from && CAUSE_LINE.some((pattern) => pattern.test(line)))
  if (causeAt === -1 && testAt !== -1) causeAt = lines.findIndex((line) => CAUSE_LINE.slice(0, -1).some((pattern) => pattern.test(line)))
  if (testAt === -1 && causeAt === -1) return null
  return {
    test: testAt === -1 ? null : (lines[testAt] as string).trim(),
    cause: causeAt === -1 ? null : (lines[causeAt] as string).trim(),
    testLine: testAt === -1 ? null : testAt + 1,
    causeLine: causeAt === -1 ? null : causeAt + 1,
  }
}
