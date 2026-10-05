/**
 * `vinta-ai-maestro validate <workflow.json>` — is this plan runnable as written?
 *
 * The check `plan-feature` runs on the workflow it just wrote, so that a typo
 * is fixed while the plan is still open rather than an hour into a run. It is
 * the same load a run does — the document layered over the project's
 * `.vinta-ai-workflows.yaml`, then the shape and graph checks — plus what only
 * a run used to find: that the filename is the id, and that `plan_ref`, every
 * `prompt_ref` and every `plan_context_refs` anchor names a heading that
 * exists. It spawns nothing and writes nothing.
 *
 * `--json` is for the agent: one object on stdout, the same issue paths the
 * text form prints, and the exit code either way — `0` valid, `1` not, `2` a
 * bad command line.
 */
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { formatPath } from '../daemon/schemas.ts'
import { inspectWorkflow, WORKFLOW_FILE_SUFFIX, type PlanIssue } from '../review/index.ts'
import { formatIssues } from '../validate.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'

export const VALIDATE_USAGE = `usage: vinta-ai-maestro validate <workflow.json> [--repo <dir>] [--json]

  Checks a workflow the way a run would load it, and the references a run
  would resolve, without running anything:

  - the document's shape, its graph (cycles, unknown nodes, undeclared pools,
    crew staffing), layered over the project's .vinta-ai-workflows.yaml;
  - that the file is named <id>${WORKFLOW_FILE_SUFFIX};
  - that plan_ref names a file in the repository, and that every prompt_ref,
    plan_context_refs and chore prompt_ref anchor matches a heading.

  --repo <dir>   The project the workflow belongs to. Defaults to the current
                 directory.
  --json         Print one JSON object on stdout instead of text:
                 {"ok", "path", "id", "phases", "waves", "issues": [
                   {"source", "path", "message"}]}

  Exits 0 when the workflow is valid and 1 when it is not.`

export async function validateCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
  } catch {
    io.err(VALIDATE_USAGE)
    return USAGE
  }
  const path = parsed.positionals[0]
  if (path === undefined || parsed.positionals.length > 1) {
    io.err(VALIDATE_USAGE)
    return USAGE
  }

  const repoDir = resolve(parsed.values.repo ?? process.cwd())
  const file = resolve(path)
  const name = basename(file)
  const id = name.endsWith(WORKFLOW_FILE_SUFFIX) ? name.slice(0, -WORKFLOW_FILE_SUFFIX.length) : null
  const json = parsed.values.json === true

  const issues: PlanIssue[] = []
  if (id === null) {
    issues.push({
      path: [],
      message: `the file is not named <id>${WORKFLOW_FILE_SUFFIX}`,
      source: 'workflow',
    })
  }

  const inspected = await inspectWorkflow(repoDir, file, id ?? name)
  if (!inspected.ok) {
    const message = inspected.reason === 'missing' ? 'cannot read workflow file' : 'is not valid JSON'
    if (json) {
      io.out(
        JSON.stringify({
          ok: false,
          path,
          id,
          phases: null,
          waves: null,
          issues: [{ source: 'workflow', path: '', message }],
        }),
      )
    } else {
      io.err(`vinta-ai-maestro: ${path}: ${message}`)
    }
    return FAILED
  }

  // The filename check above is the only one that is about the name rather
  // than the content, and `inspectWorkflow` already compares the id with it
  // whenever the name has the right suffix.
  issues.push(...inspected.issues)
  const workflow = inspected.workflow
  const phases = workflow?.nodes.length ?? null
  const waves = Object.keys(inspected.waves).length === 0 ? null : Math.max(...Object.values(inspected.waves))
  const ok = issues.length === 0

  if (json) {
    io.out(
      JSON.stringify({
        ok,
        path,
        id: workflow?.id ?? id,
        phases,
        waves,
        issues: issues.map((issue) => ({
          source: issue.source,
          path: formatPath(issue.path),
          message: issue.message,
        })),
      }),
    )
    return ok ? OK : FAILED
  }

  if (ok) {
    io.out(`${path}: valid — ${phases} phase${phases === 1 ? '' : 's'} in ${waves} wave${waves === 1 ? '' : 's'}`)
    return OK
  }
  const count = issues.length
  io.err(`vinta-ai-maestro: ${path} is not valid (${count} issue${count === 1 ? '' : 's'})`)
  for (const issue of issues) {
    const [line] = formatIssues([issue]).split('\n')
    io.err(`  ${line} [${issue.source}]`)
  }
  return FAILED
}
