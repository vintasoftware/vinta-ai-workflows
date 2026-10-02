/**
 * The operator's System One configuration (§17.3): which classifier, how to
 * reach it, and which built-in judges consult it.
 *
 * **A file the operator passes, never a field in the workflow.** It names an
 * endpoint and a key, decides whether repository content may leave the
 * machine, and — through the permission judge — how much of the machine an
 * agent may use. `permissions.ts` gives the rule this follows: a committed
 * document may say which model writes a phase, and may not say what a
 * stranger's machine sends where or lets an agent do. What a workflow *may*
 * declare is a judge gate (`types.ts`), which runs only when a run was started
 * with a classifier configured here.
 *
 * **Adapters are a registry, not a switch.** Each entry owns the schema of its
 * own `adapter` block and builds itself from it, so a new classifier is one
 * registration rather than an edit to every place that reads the config.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { SystemOneAdapter } from './adapter.ts'
import { CommandSystemOneAdapter } from './command.ts'
import { HttpSystemOneAdapter } from './http.ts'

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name')
const TimeoutMs = z.number().int().min(100).max(120_000).optional()

export interface SystemOneAdapterFactory<C = unknown> {
  readonly schema: z.ZodType<C>
  create(config: C, env: Readonly<Record<string, string | undefined>>): SystemOneAdapter
  /**
   * Environment variables holding this adapter's secrets. Removed from the
   * daemon's own environment once the adapter has read them — see
   * `createSystemOne`.
   */
  secretEnv?(config: C): readonly string[]
}

const HttpConfig = z.strictObject({
  type: z.literal('http'),
  url: z.url(),
  api_key_env: EnvName.optional().describe('Environment variable holding the bearer token.'),
  timeout_ms: TimeoutMs,
})

const CommandConfig = z.strictObject({
  type: z.literal('command'),
  argv: z.tuple([z.string().min(1)], z.string()).describe('Program and arguments. No shell.'),
  timeout_ms: TimeoutMs,
})

const registry = new Map<string, SystemOneAdapterFactory<never>>()

/**
 * Adds a classifier type. Out-of-tree hosts register theirs before loading a
 * config that names it; the two shipped here are registered on import.
 */
export function registerSystemOneAdapter<C>(type: string, factory: SystemOneAdapterFactory<C>): void {
  registry.set(type, factory as unknown as SystemOneAdapterFactory<never>)
}

registerSystemOneAdapter('http', {
  schema: HttpConfig,
  create: (config, env) =>
    new HttpSystemOneAdapter({
      url: config.url,
      env,
      ...(config.api_key_env === undefined ? {} : { apiKeyEnv: config.api_key_env }),
      ...(config.timeout_ms === undefined ? {} : { timeoutMs: config.timeout_ms }),
    }),
  secretEnv: (config) => (config.api_key_env === undefined ? [] : [config.api_key_env]),
})

registerSystemOneAdapter('command', {
  schema: CommandConfig,
  create: (config) =>
    new CommandSystemOneAdapter({
      argv: config.argv as [string, ...string[]],
      ...(config.timeout_ms === undefined ? {} : { timeoutMs: config.timeout_ms }),
    }),
})

const Probability = z.number().min(0).max(1)

export const PermissionJudgeSchema = z.strictObject({
  tools: z
    .array(z.string().min(1))
    .min(1)
    .default(['Bash'])
    .describe('Tool names whose every call is judged. Everything else runs unasked.'),
  allow_above: Probability.default(0.9).describe(
    'A call runs only when the classifier puts at least this much weight on `safe`. ' +
      'Anything less — including no answer at all — is denied.',
  ),
  question: z
    .string()
    .min(1)
    .optional()
    .describe('Replaces the shipped question. Must still be answerable with `safe` / `unsafe`.'),
})

export const GateTriageSchema = z.strictObject({
  rerun_above: Probability.default(0.8).describe(
    'A red command gate is rerun, instead of going to a fixer, when the classifier puts at ' +
      'least this much weight on `flaky` plus `environment`.',
  ),
  max_reruns: z.number().int().min(1).max(3).default(1),
  max_input_bytes: z
    .number()
    .int()
    .min(1024)
    .default(32 * 1024)
    .describe('How much of the end of the gate log is sent. The end is where a runner says why.'),
})

export const SystemOneConfigSchema = z.strictObject({
  adapter: z.looseObject({ type: z.string().min(1) }),
  probe: z
    .boolean()
    .default(true)
    .describe(
      'Whether the preflight asks the classifier one synthetic question before a run starts. ' +
        'It is what catches a wrong key or URL at minute zero rather than at the first gate; ' +
        'false keeps the preflight offline.',
    ),
  judges: z
    .strictObject({
      permission: PermissionJudgeSchema.optional().describe(
        'Judges agent tool calls under `--permission judged`. Required by that mode.',
      ),
      gate_triage: GateTriageSchema.optional().describe(
        'Sorts a red command gate into real / flaky / environment / pre-existing.',
      ),
    })
    .default({}),
})

export type PermissionJudgeConfig = z.infer<typeof PermissionJudgeSchema>
export type GateTriageConfig = z.infer<typeof GateTriageSchema>
export type SystemOneConfig = z.infer<typeof SystemOneConfigSchema>

/** What a run is handed: the classifier, and which built-in judges consult it. */
export interface SystemOne {
  readonly adapter: SystemOneAdapter
  readonly judges: SystemOneConfig['judges']
  /** Ask `PROBE_QUESTION` at preflight. Absent means yes. */
  readonly probe?: boolean
}

export class SystemOneConfigError extends Error {}

/** Builds the classifier a validated config names. */
export function createSystemOne(
  config: SystemOneConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SystemOne {
  const factory = registry.get(config.adapter.type)
  if (factory === undefined) {
    throw new SystemOneConfigError(
      `unknown System One adapter "${config.adapter.type}" — known: ${[...registry.keys()].join(', ')}`,
    )
  }
  const parsed = factory.schema.safeParse(config.adapter)
  if (!parsed.success) {
    throw new SystemOneConfigError(`adapter: ${z.prettifyError(parsed.error)}`)
  }
  const adapter = factory.create(parsed.data, env)
  // Every agent, gate and hook this daemon starts inherits its environment, and
  // an agent under `full` or `judged` can read its own. The adapter holds the
  // key from here on; nothing else in the process needs it, so nothing else
  // gets it.
  if (env === process.env) {
    for (const name of factory.secretEnv?.(parsed.data) ?? []) delete process.env[name]
  }
  return { adapter, judges: config.judges, probe: config.probe }
}

/**
 * Reads and builds the file `--system-one` names. Errors name the file and the
 * field; the file's contents are the operator's own and are not secret, but a
 * key pasted into it by mistake would be, so no value is quoted.
 */
export function loadSystemOne(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SystemOne {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new SystemOneConfigError(`${path} is not a readable JSON file`)
  }
  const parsed = SystemOneConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new SystemOneConfigError(`${path}: ${z.prettifyError(parsed.error)}`)
  }
  return createSystemOne(parsed.data, env)
}
