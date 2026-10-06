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
    /**
     * This lane's slice of each shared service — its redis index, its vhost,
     * its bucket prefix. Recorded for the same reason a forked database is:
     * teardown reverses it from this file, and a slice that exists only in a
     * running daemon's memory is one nobody can clean up afterwards.
     */
    services: z
      .array(
        z.looseObject({
          id: z.string(),
          namespace: z.string(),
          connection_url_var: z.string(),
          reset_cmd: z.string().nullable(),
        }),
      )
      .default([]),
    compose: z.looseObject({
      project_name: z.string(),
      /** Absolute. Null where the project has no compose file. */
      override_path: z.string().nullable().default(null),
      /** What `COMPOSE_FILE` names first — relative, and the lane's own copy. */
      base_compose_file: z.string().nullable().default(null),
      /**
       * Volumes this lane forked off a shared one. **This is the teardown
       * manifest**: each name is a `docker volume rm` target, and a volume that
       * is not listed here is one somebody else is still using.
       */
      forked_volumes: z
        .array(z.looseObject({ key: z.string(), name: z.string(), reason: z.string() }))
        .default([]),
      /** Services whose fixed host port publishing the override dropped. */
      ports_stripped_from: z.array(z.string()).default([]),
      /** Host ports this lane was granted, by service and container port. */
      published_ports: z
        .array(
          z.looseObject({
            service: z.string(),
            target: z.number(),
            published: z.number(),
            env_var: z.string(),
          }),
        )
        .default([]),
    }),
  }),
})

export type WorktreeSummary = z.infer<typeof WorktreeSummarySchema>
/**
 * What a *writer* has to supply, which is less than what a reader gets back:
 * the compose block's fields carry defaults, so a caller that has nothing to
 * say about ports or volumes says nothing rather than spelling out five empty
 * fields. The schema fills them in on the way to disk.
 */
export type WorktreeSummaryInput = z.input<typeof WorktreeSummarySchema>

const summaryPath = (summaryDir: string, name: string): string => join(summaryDir, `${name}.yaml`)

export async function readSummary(summaryDir: string, name: string): Promise<WorktreeSummary> {
  return WorktreeSummarySchema.parse(parse(await readFile(summaryPath(summaryDir, name), 'utf8')))
}

export async function writeSummary(
  summaryDir: string,
  summary: WorktreeSummaryInput,
): Promise<void> {
  // Parsed on the way out, not merely stringified. The file is the contract a
  // recycle and a teardown are both decided from, so it is written complete —
  // every default materialized — rather than as whatever the caller happened
  // to hold.
  const complete = WorktreeSummarySchema.parse(summary)
  await mkdir(summaryDir, { recursive: true })
  await writeFile(summaryPath(summaryDir, complete.name), stringify(complete), 'utf8')
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
