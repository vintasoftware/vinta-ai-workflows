/**
 * The project's own configuration, as maestro reads it: `.vinta-ai-workflows.yaml`
 * at the repository root.
 *
 * That file is the project's single source of truth for everything the
 * bootstrap captured, and most of it is not maestro's business. Two parts are:
 *
 * - **`commands`** — the project's test, lint and build lines, which
 *   `implement-plan` already runs. A typed gate inherits its command from here
 *   (`resolve.ts`), so the line a skill runs and the line a maestro run gates
 *   on are the same line unless somebody deliberately makes them differ.
 * - **`maestro`** — that deliberate difference, plus what every plan in this
 *   project would otherwise repeat: per-type gate defaults, resource pools,
 *   chores, run defaults and the `project` block a lane is provisioned from.
 *   Its shape is a subset of the workflow document's own, so a value means the
 *   same thing in either place and the only question is which one wins.
 *
 * Validated here and merged as written. The values that are merged are the raw
 * ones, not zod's output: a default zod would fill in is a default the plan
 * did not say and the project did not say, and merging it would make it
 * outrank nothing while looking like a decision somebody made.
 *
 * Every message produced here names the file and a location. None quotes the
 * file: it lives in the repository, and §11 keeps repository content out of
 * messages.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, YAMLParseError } from 'yaml'
import { z } from 'zod'

import { git, gitOk } from '../integration/git.ts'
import {
  ChoreSchema,
  DefaultsSchema,
  GATE_TYPES,
  GateTuningSchema,
  ProjectSchema,
  ResourceSchema,
} from '../types.ts'
import type { ValidationIssue } from '../validate.ts'

export const PROJECT_CONFIG_FILE = '.vinta-ai-workflows.yaml'

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case')
  .min(1)

const OptionalCommand = z.string().min(1).optional()

/** What a typed gate inherits. Every field optional: each one is a fallback. */
export const GateTypeDefaultsSchema = z.strictObject({
  cmd: OptionalCommand,
  scoped_cmd: OptionalCommand,
  requires: z.array(Id).optional(),
  timeout_s: z.number().int().min(1).optional(),
  tuning: GateTuningSchema.optional(),
})

export const MaestroConfigSchema = z
  .strictObject({
    defaults: DefaultsSchema.partial().optional(),
    gates: z.partialRecord(z.enum(GATE_TYPES), GateTypeDefaultsSchema).optional(),
    resources: z.record(Id, ResourceSchema).optional(),
    chores: z.record(Id, ChoreSchema).optional(),
    project: ProjectSchema.partial().optional(),
  })
  .describe('What every maestro run in this project starts from, before its plan is laid over it.')

/**
 * The slice of `.vinta-ai-workflows.yaml` maestro reads. Loose everywhere but
 * `maestro`, because the rest of the file is validated by its own schema and
 * belongs to the skills.
 */
export const ProjectConfigSchema = z.looseObject({
  project: z.looseObject({ default_branch: z.string().min(1).optional() }).optional(),
  commands: z
    .looseObject({
      lint: OptionalCommand,
      lint_scoped: OptionalCommand,
      build: OptionalCommand,
      test_unit: OptionalCommand,
      test_unit_scoped: OptionalCommand,
      e2e: OptionalCommand,
    })
    .optional(),
  maestro: MaestroConfigSchema.optional(),
})

export type ProjectConfig = z.input<typeof ProjectConfigSchema>
export type MaestroConfig = z.input<typeof MaestroConfigSchema>

export type ProjectConfigResult =
  | { readonly ok: true; readonly config: ProjectConfig | null }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

/**
 * Parses the file's text. `null` text is a project with no configuration file,
 * which is a valid project: every plan then carries everything itself.
 */
export function parseProjectConfig(text: string | null): ProjectConfigResult {
  if (text === null) return { ok: true, config: null }

  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    // The parser's own message quotes the offending line. Its position does not.
    const line = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: `${PROJECT_CONFIG_FILE} is not valid YAML${line === undefined ? '' : ` (line ${line})`}`,
        },
      ],
    }
  }

  // An empty file parses to null. It configures nothing, which is not an error.
  if (raw === null || raw === undefined) return { ok: true, config: null }

  const shape = ProjectConfigSchema.safeParse(raw)
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map((issue) => ({
        path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
        message: issue.message,
      })),
    }
  }
  return { ok: true, config: raw as ProjectConfig }
}

/** The file in the working tree at `repoPath`. */
export async function loadProjectConfig(repoPath: string): Promise<ProjectConfigResult> {
  let text: string | null
  try {
    text = await readFile(join(repoPath, PROJECT_CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, issues: [{ path: [], message: `cannot read ${PROJECT_CONFIG_FILE}` }] }
    }
    text = null
  }
  return parseProjectConfig(text)
}

/**
 * The file as committed at `ref` — which is how a run reads it once it has
 * started: off its plan branch, so that an edit somebody makes on `main`, or an
 * uncommitted one in the checkout, never reaches a run it was not meant for.
 */
export async function loadProjectConfigAt(repoPath: string, ref: string): Promise<ProjectConfigResult> {
  return parseProjectConfig(await readFileAt(repoPath, ref, PROJECT_CONFIG_FILE))
}

/**
 * One file's content at a ref, or `null` when the ref does not have it.
 *
 * `cat-file -e` first, so that "not there" is told apart from "git failed":
 * the first is a normal answer, and the second must not be mistaken for a
 * project with no configuration and silently change what a run resolves to.
 */
export async function readFileAt(repoPath: string, ref: string, path: string): Promise<string | null> {
  const spec = `${ref}:${path.split('\\').join('/')}`
  if (!(await gitOk(repoPath, ['cat-file', '-e', spec]))) return null
  return await git(repoPath, ['show', spec], { maxBuffer: 16 * 1024 * 1024 })
}
