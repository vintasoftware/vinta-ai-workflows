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

import { loadProjectConfig, PROJECT_CONFIG_FILE, type ProjectConfig } from '../config/project-config.ts'
import { resolveWorkflow } from '../config/resolve.ts'
import { formatIssues, type ValidationIssue } from '../validate.ts'
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

/** A plan as loaded: what runs, and the two layers it was resolved from. */
export interface LoadedPlan {
  readonly workflow: Workflow
  /** The workflow file's own JSON, unparsed. */
  readonly authored: unknown
  /** `.vinta-ai-workflows.yaml` as written, or null when the project has none. */
  readonly config: ProjectConfig | null
}

/**
 * Reads a workflow file, layers it over the project's configuration and
 * validates the result — or reports why it could not.
 *
 * Every failure here is the operator's to fix, so every failure is a located
 * message rather than a stack trace: `nodes[2].depends_on[0].node: unknown node
 * "p9"` says where to look, and `Error: ...` at frame 14 of a zod internal does
 * not. Nothing from the file's *contents* reaches the output — only the path
 * that failed and the reason — because a workflow lives in the repository and
 * §11 keeps repository contents out of messages.
 *
 * `repoPath` is where `.vinta-ai-workflows.yaml` is read from. A plan is never
 * validated without it: a gate that says only `"type": "test"` is complete in a
 * project that configures its tests and incomplete in one that does not.
 */
export async function loadPlan(path: string, io: Io, repoPath: string): Promise<LoadedPlan | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    io.err(`vinta-ai-maestro: cannot read workflow file: ${path}`)
    return null
  }

  let authored: unknown
  try {
    authored = JSON.parse(raw)
  } catch {
    // The parser's message quotes the offending source line, which is file
    // content. The path and the fact of the failure are enough.
    io.err(`vinta-ai-maestro: ${path} is not valid JSON`)
    return null
  }

  const config = await loadProjectConfig(repoPath)
  if (!config.ok) {
    report(io, PROJECT_CONFIG_FILE, 'configuration', config.issues)
    return null
  }

  const result = resolveWorkflow(authored, config.config)
  if (!result.ok) {
    report(io, path, 'workflow', result.issues)
    return null
  }
  return { workflow: result.workflow, authored, config: config.config }
}

/** `loadPlan`, for the callers that only run what it resolves to. */
export async function loadWorkflow(path: string, io: Io, repoPath: string): Promise<Workflow | null> {
  return (await loadPlan(path, io, repoPath))?.workflow ?? null
}

function report(io: Io, path: string, what: string, issues: readonly ValidationIssue[]): void {
  const count = issues.length
  io.err(`vinta-ai-maestro: ${path} is not a valid ${what} (${count} issue${count === 1 ? '' : 's'})`)
  for (const line of formatIssues(issues).split('\n')) io.err(`  ${line}`)
}
