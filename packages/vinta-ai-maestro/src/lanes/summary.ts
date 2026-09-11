/**
 * The worktree summary at `.vinta-ai-workflows/worktrees/<name>.yaml` — the
 * contract between `vinta-ai-maestro` and `prepare-worktree`.
 *
 * The skill's rule is that no fork decision lives only in conversation memory,
 * and the daemon holds itself to it: whether a lane can be reset or must be
 * re-provisioned is decided by re-reading this file, never by trusting the
 * in-memory pool. That is what lets a lane provisioned by the skill and a lane
 * provisioned by the daemon be handled by the same code, and what lets either
 * survive a daemon restart.
 *
 * Only the fields the daemon reads or writes are modelled. Everything else the
 * skill records — sandbox tier, compose volume forks, env strategy — is passed
 * through untouched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'

const ForkedDatabaseSchema = z.looseObject({
  engine: z.string(),
  strategy: z.enum(['fork', 'share', 'stub']),
  forked_name: z.string().nullable(),
  connection_url_var: z.string(),
  /** Null when the engine or setup has no safe reset — see `resetPlan`. */
  reset_cmd: z.string().nullable(),
})

export const WorktreeSummarySchema = z.looseObject({
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  base_ref: z.string(),
  created_at: z.string(),
  state: z.looseObject({
    dev_db: ForkedDatabaseSchema.nullable().default(null),
    test_db: ForkedDatabaseSchema.nullable().default(null),
    compose: z.looseObject({ project_name: z.string() }),
  }),
})

export type WorktreeSummary = z.infer<typeof WorktreeSummarySchema>

const summaryPath = (summaryDir: string, name: string): string => join(summaryDir, `${name}.yaml`)

export async function readSummary(summaryDir: string, name: string): Promise<WorktreeSummary> {
  return WorktreeSummarySchema.parse(parse(await readFile(summaryPath(summaryDir, name), 'utf8')))
}

export async function writeSummary(summaryDir: string, summary: WorktreeSummary): Promise<void> {
  await mkdir(summaryDir, { recursive: true })
  await writeFile(summaryPath(summaryDir, summary.name), stringify(summary), 'utf8')
}

/**
 * Whether this worktree can be handed to another phase, and what it takes.
 *
 * A single forked database without a `reset_cmd` makes the whole lane
 * single-use: reusing it across a migration boundary would run the next phase
 * against the previous one's schema.
 */
export function resetPlan(
  summary: WorktreeSummary,
): { reusable: true; commands: readonly string[] } | { reusable: false } {
  const commands: string[] = []
  for (const db of [summary.state.dev_db, summary.state.test_db]) {
    if (db === null || db.strategy !== 'fork') continue
    if (db.reset_cmd === null) return { reusable: false }
    commands.push(db.reset_cmd)
  }
  return { reusable: true, commands }
}
