/**
 * `vinta-flow doctor <workflow.json>` — §13.5.
 *
 * The command is thin on purpose: `runDoctor` already runs every check and
 * already decides the verdict, and the exit code it computes exists precisely
 * so that something can exit with it. This is that something. A doctor whose
 * result had to be read by a human would not be usable in `&&` before a run.
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { formatDoctorReport, runDoctor, type DoctorOptions } from '../doctor/index.ts'
import { laneRootFor } from './paths.ts'
import { FAILED, OK, USAGE, loadWorkflow, type Io } from './io.ts'

export const DOCTOR_USAGE = `usage: vinta-flow doctor <workflow.json> [--repo <dir>]

  --repo <dir>   The project checkout the lanes will be worktrees of.
                 Defaults to the current directory.`

/**
 * Overrides merged into the assembled options — the injected binaries and disk
 * estimate `runDoctor` already takes. Present so a test can describe a broken
 * machine rather than break the one it is running on; there is no flag for it,
 * because a doctor that reads its answers from the command line is not one.
 */
export type DoctorOverrides = Partial<Omit<DoctorOptions, 'workflow'>>

export async function doctorCommand(
  argv: readonly string[],
  io: Io,
  overrides: DoctorOverrides = {},
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' } },
      allowPositionals: true,
    })
  } catch {
    io.err(DOCTOR_USAGE)
    return USAGE
  }

  const path = parsed.positionals[0]
  if (path === undefined || parsed.positionals.length > 1) {
    io.err(DOCTOR_USAGE)
    return USAGE
  }

  const workflow = await loadWorkflow(path, io)
  if (workflow === null) return FAILED

  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const report = await runDoctor({
    workflow,
    repoPath,
    poolRoot: laneRootFor(repoPath),
    ...overrides,
  })

  io.out(formatDoctorReport(report))
  return report.exitCode === 0 ? OK : FAILED
}
