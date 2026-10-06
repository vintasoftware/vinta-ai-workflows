/**
 * The git surface this unit needs, and nothing more.
 *
 * `run` throws on a non-zero exit, `tryRun` returns the exit code instead —
 * which is the whole distinction that matters here, because a conflicted
 * `merge` exits 1 and is an expected outcome rather than an error.
 *
 * No stdout from these calls ever reaches an error message or a structured
 * field. Git prints repository content — diffs, conflict hunks, commit bodies —
 * on stdout, and §11 puts that in exactly one place, which is not here. The
 * tail of *stderr* is a different thing and is carried: see `GitCommandError`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactText } from '../log/index.ts'

const exec = promisify(execFile)

/**
 * How much of git's stderr an error keeps. The tail rather than the head,
 * because a hook that fails prints its traceback last; bounded, because a
 * hook that prints a file prints it to stderr too.
 */
export const GIT_STDERR_LIMIT = 600

/**
 * A git command that exited non-zero, named by its subcommand and code, with
 * the tail of what git said on stderr.
 *
 * The subcommand and the exit status are what §11 allows outright. The stderr
 * tail used to be dropped, on the argument that stderr is where diff hunks and
 * file bodies are — and the argument was wrong about which failures this
 * package actually has. Git's stderr on a non-zero exit is its diagnostic:
 * "you need to resolve your current index first", "pathspec 'x' did not match",
 * or the pre-commit hook's own last lines. Without it one observed run failed
 * four phases up to twenty-three times each on `git checkout exited 1`, and
 * the one fact that explained all of them — the integration worktree was
 * mid-merge — took a person reading `.git/` by hand to find.
 *
 * So the tail is kept, under the same rules a log record's `message` has:
 * registered secrets replaced, the length capped (`redactText`), and the
 * amount bounded further by `GIT_STDERR_LIMIT` so a hook that echoes a file
 * cannot put the file in the journal.
 *
 * It exists because the alternative was worse than terse. An `execFile`
 * rejection carries `name: 'Error'` and a *numeric* `code`, and the scheduler's
 * `failureReason` reports an unrecognised error as its name plus a **string**
 * `code` — so every non-zero git exit in the run, which is the most common real
 * failure this package has, was persisted as the single word "Error".
 */
export class GitCommandError extends Error {
  /** The redacted stderr tail, '' when git said nothing. */
  readonly detail: string

  constructor(
    /** The subcommand, e.g. `commit`. Never the full argument list — paths and refs live there. */
    readonly subcommand: string,
    readonly exitCode: number | null,
    stderr = '',
  ) {
    const detail = stderrTail(stderr)
    super(
      `git ${subcommand} exited ${exitCode ?? 'abnormally'}` +
        (detail === '' ? '' : `: ${detail}`),
    )
    this.name = 'GitCommandError'
    this.detail = detail
  }
}

/** The last `GIT_STDERR_LIMIT` characters of a stderr capture, redacted. */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim()
  const tail = trimmed.length <= GIT_STDERR_LIMIT ? trimmed : `…${trimmed.slice(-GIT_STDERR_LIMIT)}`
  return redactText(tail)
}

/**
 * `execFile`'s default `maxBuffer` is 1 MiB, which a `git diff` of a real
 * phase clears routinely. Callers that read a patch say how much they can hold.
 */
export interface GitOptions {
  readonly maxBuffer?: number
}

export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  try {
    const { stdout } = await exec('git', [...args], {
      cwd,
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    })
    return stdout
  } catch (error) {
    // A spawn failure — git missing from PATH — keeps its own `ENOENT`, which
    // `failureReason` already reports and which means something different from
    // any exit status: nothing ran.
    const { code, stderr } = error as { code?: unknown; stderr?: unknown }
    if (typeof code !== 'number') throw error
    throw new GitCommandError(args[0] ?? 'git', code, typeof stderr === 'string' ? stderr : '')
  }
}

/** True when the command exited 0. Used where failure is a real answer. */
export async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}

/** Newline-delimited output as a list, blank lines dropped. */
export async function gitLines(cwd: string, args: readonly string[]): Promise<string[]> {
  const out = await git(cwd, args)
  return out.split('\n').filter((line) => line.length > 0)
}
