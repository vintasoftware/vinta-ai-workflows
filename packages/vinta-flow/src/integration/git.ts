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

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec('git', [...args], { cwd })
  return stdout
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
