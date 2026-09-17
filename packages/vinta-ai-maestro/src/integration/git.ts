/**
 * The git surface this unit needs, and nothing more.
 *
 * `run` throws on a non-zero exit, `tryRun` returns the exit code instead —
 * which is the whole distinction that matters here, because a conflicted
 * `merge` exits 1 and is an expected outcome rather than an error.
 *
 * No stdout from these calls ever reaches an error message or a structured
 * field. Git prints repository content — diffs, conflict hunks, commit bodies —
 * and §11 puts that in exactly one place, which is not here.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * A git command that exited non-zero, named by its subcommand and code.
 *
 * Both halves are what §11 allows and nothing more: `git commit` and `1` are a
 * command name and an exit status, not repository content. Git's own stderr is
 * deliberately dropped — it is where the diff hunks and file bodies are.
 *
 * It exists because the alternative was worse than terse. An `execFile`
 * rejection carries `name: 'Error'` and a *numeric* `code`, and the scheduler's
 * `failureReason` reports an unrecognised error as its name plus a **string**
 * `code` — so every non-zero git exit in the run, which is the most common real
 * failure this package has, was persisted as the single word "Error". A phase
 * that died on `git commit` exiting 1 said exactly as much as one that died on
 * a missing binary.
 */
export class GitCommandError extends Error {
  constructor(
    /** The subcommand, e.g. `commit`. Never the full argument list — paths and refs live there. */
    readonly subcommand: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${subcommand} exited ${exitCode ?? 'abnormally'}`)
    this.name = 'GitCommandError'
  }
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', [...args], { cwd })
    return stdout
  } catch (error) {
    // A spawn failure — git missing from PATH — keeps its own `ENOENT`, which
    // `failureReason` already reports and which means something different from
    // any exit status: nothing ran.
    const code = (error as { code?: unknown }).code
    if (typeof code !== 'number') throw error
    throw new GitCommandError(args[0] ?? 'git', code)
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
