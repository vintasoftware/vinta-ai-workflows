/**
 * The CLI's two seams: where output goes, and how a destructive action is
 * confirmed.
 *
 * Both are injected rather than reached for, which is what lets the test suite
 * invoke the command functions directly instead of shelling out to a built
 * binary — and, more importantly, what makes §11's rule about the token
 * *assertable*: every line the CLI emits passes through `out` or `err`, so a
 * test can hold the complete transcript of a `serve` and check that the token
 * appears in exactly one line of it.
 *
 * `out` is the deliverable — a doctor report, a projection, the daemon URL.
 * `err` is everything else: warnings, validation issues, refusals. The
 * distinction is not cosmetic; it is what makes `vinta-ai-maestro simulate … > out`
 * a usable thing to do.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'

import { formatIssues, parseWorkflow } from '../validate.ts'
import type { Workflow } from '../types.ts'

export interface Io {
  /** The command's deliverable. stdout. */
  out(line: string): void
  /** Warnings, validation issues, refusals. stderr. Never carries a token. */
  err(line: string): void
  /** Yes/no confirmation for a destructive action. */
  confirm(question: string): Promise<boolean>
}

/** Exit codes. `USAGE` is separated from `FAILED` so a script can tell them apart. */
export const OK = 0
export const FAILED = 1
export const USAGE = 2

export function processIo(): Io {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    confirm: async (question) => {
      // The prompt goes to stderr so that piping stdout to a file does not
      // swallow the question the operator is being asked.
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
      } finally {
        rl.close()
      }
    },
  }
}

/**
 * Reads and validates a workflow file, or reports why it could not.
 *
 * Every failure here is the operator's to fix, so every failure is a located
 * message rather than a stack trace: `nodes[2].depends_on[0].node: unknown node
 * "p9"` says where to look, and `Error: ...` at frame 14 of a zod internal does
 * not. Nothing from the file's *contents* reaches the output — only the path
 * that failed and the reason — because a workflow lives in the repository and
 * §11 keeps repository contents out of messages.
 */
export async function loadWorkflow(path: string, io: Io): Promise<Workflow | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    io.err(`vinta-ai-maestro: cannot read workflow file: ${path}`)
    return null
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    // The parser's message quotes the offending source line, which is file
    // content. The path and the fact of the failure are enough.
    io.err(`vinta-ai-maestro: ${path} is not valid JSON`)
    return null
  }

  const result = parseWorkflow(json)
  if (result.ok) return result.workflow

  const count = result.issues.length
  io.err(`vinta-ai-maestro: ${path} is not a valid workflow (${count} issue${count === 1 ? '' : 's'})`)
  for (const line of formatIssues(result.issues).split('\n')) io.err(`  ${line}`)
  return null
}
