/**
 * The settings a run takes that are not *which* run, parsed in one place.
 *
 * `run` takes them for the run it starts; `ui` takes them for every run started
 * from the browser and passes them on to each job it launches. One parser is
 * what keeps the two from disagreeing about what a valid setting is — a UI
 * more permissive than the command line would be a second, quieter way to
 * start a run `run` would have refused.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { z } from 'zod'

import {
  AGENT_PERMISSIONS,
  DEFAULT_PERMISSION,
  isAgentPermission,
  type AgentPermission,
} from '../harness/permissions.ts'
import {
  HarnessProfileError,
  loadHarnessProfiles,
  type HarnessProfile,
} from '../harness/profiles.ts'
import { liveJob } from '../job/job.ts'
import type { Journal } from '../journal/journal.ts'
import { loadSystemOne, SystemOneConfigError, type SystemOne } from '../system-one/config.ts'
import type { Io } from './io.ts'
import type { LogValues } from './logging.ts'
import { runsRootFor } from './paths.ts'
import type { Bind } from './serve.ts'

/**
 * `--system-one`, loaded and checked against `--permission`. Shared by `serve`
 * and `run` so the two cannot disagree about what a usable config is.
 *
 * `undefined` is "not configured", `null` a usage error already reported.
 * `judged` without a permission judge is refused here, at the command line,
 * rather than at the first spawn of the first phase.
 */
export function toSystemOne(
  path: string | undefined,
  permission: AgentPermission,
  io: Io,
): SystemOne | undefined | null {
  let systemOne: SystemOne | undefined
  if (path !== undefined) {
    try {
      systemOne = loadSystemOne(path)
    } catch (error) {
      io.err(`vinta-ai-maestro: --system-one: ${error instanceof SystemOneConfigError ? error.message : 'could not be loaded'}`)
      return null
    }
  }
  if (permission === 'judged' && systemOne?.judges.permission === undefined) {
    io.err(
      'vinta-ai-maestro: --permission judged needs --system-one with a `judges.permission` block — ' +
        'without one nothing would judge the calls it lets through',
    )
    return null
  }
  return systemOne
}

/**
 * `--retry-after`, in milliseconds. `null` is a refusal the caller reports.
 *
 * Accepts a bare number of minutes or an explicit unit — `15`, `15m`, `90s`,
 * `2h` — because the flag is written by a person choosing how long they are
 * willing to be away, and every one of those spellings is what somebody
 * reaches for. Minutes is the bare unit for the same reason: nobody sets this
 * to fifteen seconds, and reading `--retry-after 15` as a quarter of a minute
 * would be a surprise that costs an overnight run.
 */
export function toRetryAfterMs(raw: string | undefined, io: Io, flag = '--retry-after'): number | null | undefined {
  if (raw === undefined) return undefined
  const match = /^(\d+)(s|m|h)?$/.exec(raw.trim())
  if (match === null) {
    io.err(`vinta-ai-maestro: ${flag} must be a whole number of minutes, or 30s / 15m / 2h`)
    return null
  }
  const value = Number(match[1])
  const unit = match[2] ?? 'm'
  const ms = value * (unit === 's' ? 1_000 : unit === 'h' ? 3_600_000 : 60_000)
  // Zero is meaningful and is *off*, not "immediately": an unattended retry
  // with no delay would spend a phase attempt the instant the question appears,
  // which is the automatic budget's job and not this one's.
  if (ms === 0) return undefined
  return ms
}

/**
 * Every setting a run takes that is not *which* run. Parsed once, here, and
 * shared with `ui`, which starts runs with the settings it was given.
 */
export interface RunPolicy {
  readonly permission: AgentPermission
  readonly systemOnePath?: string
  readonly systemOne?: SystemOne
  readonly onFailure?: 'stop' | 'retry' | 'ask'
  readonly retries?: number
  readonly retryAfter?: string
  readonly retryAfterMs?: number
  /** `--agent-answer-after`: the unattended wait on an agent's own question. */
  readonly agentAnswerAfter?: string
  readonly agentAnswerAfterMs?: number
  readonly intervene: boolean
  /** `--harness-profile`, resolved from the operator's profiles file. */
  readonly harnessProfiles: readonly HarnessProfile[]
  /**
   * The flags this policy was parsed from, exactly as given. A launched job
   * is handed these and not the defaults filled in around them, so the job's
   * own merge with the run's stored policy (`withStoredPolicy`) can tell an
   * operator's choice from a value nobody chose.
   */
  readonly given: PolicyValues
}

/** The flag values `toRunPolicy` reads, as `parseArgs` produced them. */
export interface PolicyValues {
  readonly permission?: string | undefined
  readonly 'system-one'?: string | undefined
  readonly 'on-failure'?: string | undefined
  readonly retries?: string | undefined
  readonly 'retry-after'?: string | undefined
  readonly 'agent-answer-after'?: string | undefined
  readonly 'no-intervene'?: boolean | undefined
  readonly 'no-coordinator'?: boolean | undefined
  readonly 'harness-profile'?: readonly string[] | undefined
}

/** `null` on a bad flag, already reported; the message names the flag. */
export function toRunPolicy(values: PolicyValues, io: Io): RunPolicy | null {
  // Rejected here rather than passed through: an unrecognised value must not
  // quietly become the default, because the default is the permissive end of
  // the range and the typo most worth catching is `--permission ful`.
  const requested = values.permission
  if (requested !== undefined && !isAgentPermission(requested)) {
    io.err(`vinta-ai-maestro: --permission must be one of ${AGENT_PERMISSIONS.join(', ')}`)
    return null
  }
  const permission = requested ?? DEFAULT_PERMISSION

  const systemOnePath = values['system-one'] === undefined ? undefined : resolve(values['system-one'])
  const systemOne = toSystemOne(systemOnePath, permission, io)
  if (systemOne === null) return null

  // Rejected rather than defaulted, for the reason `--permission` is: a typo
  // that quietly became `stop` would look like the flag worked, and the
  // operator would find out by watching a failed run end without asking them.
  const onFailure = values['on-failure']
  if (
    onFailure !== undefined &&
    onFailure !== 'stop' &&
    onFailure !== 'retry' &&
    onFailure !== 'ask'
  ) {
    io.err('vinta-ai-maestro: --on-failure must be one of stop, retry, ask')
    return null
  }

  const retryAfterMs = toRetryAfterMs(values['retry-after'], io)
  if (retryAfterMs === null) return null
  const agentAnswerAfterMs = toRetryAfterMs(values['agent-answer-after'], io, '--agent-answer-after')
  if (agentAnswerAfterMs === null) return null

  // A budget, so it is bounded and finite. Zero is meaningful — it is `ask`
  // spelled through this flag — and anything unparseable is a typo worth
  // catching rather than a silent fallback to the default.
  const rawRetries = values.retries
  const retries = rawRetries === undefined ? undefined : Number(rawRetries)
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > 5)) {
    io.err('vinta-ai-maestro: --retries must be a whole number from 0 to 5')
    return null
  }

  let harnessProfiles: readonly HarnessProfile[]
  try {
    harnessProfiles = loadHarnessProfiles(values['harness-profile'] ?? [])
  } catch (error) {
    io.err(`vinta-ai-maestro: --harness-profile: ${error instanceof HarnessProfileError ? error.message : 'could not be loaded'}`)
    return null
  }

  return {
    permission,
    ...(systemOnePath === undefined ? {} : { systemOnePath }),
    ...(systemOne === undefined ? {} : { systemOne }),
    ...(onFailure === undefined ? {} : { onFailure }),
    ...(retries === undefined ? {} : { retries }),
    ...(values['retry-after'] === undefined ? {} : { retryAfter: values['retry-after'] }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(values['agent-answer-after'] === undefined ? {} : { agentAnswerAfter: values['agent-answer-after'] }),
    ...(agentAnswerAfterMs === undefined ? {} : { agentAnswerAfterMs }),
    // `--no-intervene` is the flag's name from before the monitor became the
    // coordinator, and still works.
    intervene: values['no-intervene'] !== true && values['no-coordinator'] !== true,
    harnessProfiles,
    given: {
      ...values,
      // Absolute, so a job started from another directory reads the same file.
      ...(systemOnePath === undefined ? {} : { 'system-one': systemOnePath }),
    },
  }
}

// ---------------------------------------------------------------------------
// The run's own policy, remembered for its resume
// ---------------------------------------------------------------------------

/**
 * What a run was last started or resumed with: the policy flags, the job's
 * `--host`, and the harness profiles by name. Flag-shaped, because what it is
 * for is standing in for flags an operator did not retype.
 *
 * Every `--resume` used to need `--permission`, `--system-one`,
 * `--on-failure`, `--retries`, `--retry-after` and `--host` restated — one
 * observed run recovered them from `ps` output — and a resume that forgot one
 * quietly ran under the default, which for `--permission` is the wrong end of
 * the range to be surprised at. Profile *values* are not stored: they are the
 * operator's, and a resume reads them again from the profiles file.
 */
const StoredPolicySchema = z.object({
  permission: z.string().optional(),
  'system-one': z.string().optional(),
  'on-failure': z.string().optional(),
  retries: z.string().optional(),
  'retry-after': z.string().optional(),
  'agent-answer-after': z.string().optional(),
  'no-coordinator': z.boolean().optional(),
  host: z.string().optional(),
  'harness-profile': z.array(z.string()).optional(),
})

export type StoredPolicy = z.infer<typeof StoredPolicySchema>

export const policyPathFor = (repoPath: string, runId: string): string =>
  join(runsRootFor(repoPath), runId, 'policy.json')

/** Records what this job runs under, for the next `--resume` of the run. */
export function writeStoredPolicy(repoPath: string, runId: string, policy: RunPolicy, bind: Bind): void {
  const stored: StoredPolicy = {
    permission: policy.permission,
    ...(policy.systemOnePath === undefined ? {} : { 'system-one': policy.systemOnePath }),
    ...(policy.onFailure === undefined ? {} : { 'on-failure': policy.onFailure }),
    ...(policy.retries === undefined ? {} : { retries: String(policy.retries) }),
    ...(policy.retryAfter === undefined ? {} : { 'retry-after': policy.retryAfter }),
    ...(policy.agentAnswerAfter === undefined ? {} : { 'agent-answer-after': policy.agentAnswerAfter }),
    ...(policy.intervene ? {} : { 'no-coordinator': true }),
    ...(bind.host === undefined ? {} : { host: bind.host }),
    ...(policy.harnessProfiles.length === 0
      ? {}
      : { 'harness-profile': policy.harnessProfiles.map((profile) => profile.name) }),
  }
  const path = policyPathFor(repoPath, runId)
  mkdirSync(join(runsRootFor(repoPath), runId), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/** The run's stored policy, or `null` for a run from before it was kept, or one that will not parse. */
export function readStoredPolicy(repoPath: string, runId: string): StoredPolicy | null {
  try {
    const parsed = StoredPolicySchema.safeParse(JSON.parse(readFileSync(policyPathFor(repoPath, runId), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The flags a resume runs with: the stored ones, with every flag given on
 * this command line over them. `reused` names the stored flags that took
 * effect, so the command can say what it did not need to be told.
 */
export function withStoredPolicy<V extends PolicyValues & { readonly host?: string | undefined }>(
  values: V,
  stored: StoredPolicy | null,
): { readonly values: V; readonly reused: readonly string[] } {
  if (stored === null) return { values, reused: [] }
  const given = values as Record<string, unknown>
  const reused = Object.keys(stored).filter((key) => given[key] === undefined)
  // `--no-intervene` is `--no-coordinator`'s old name; either given wins.
  const kept = reused.filter((key) => !(key === 'no-coordinator' && given['no-intervene'] !== undefined))
  const merged = { ...values } as Record<string, unknown>
  for (const key of kept) merged[key] = stored[key as keyof StoredPolicy]
  return { values: merged as V, reused: kept }
}

/** Which run a job hosts: a document to start, or a run id to pick up. */
export type JobTarget =
  | { readonly kind: 'workflow'; readonly path: string; readonly runId: string }
  | { readonly kind: 'resume'; readonly runId: string }

/**
 * The argument list a detached job is started with — `run --foreground`, with
 * every setting spelled out and every path absolute, so the job does not
 * depend on the directory it was launched from.
 *
 * `--log-stderr` always: the job's stderr is its log file, and the human
 * rendering of the daemon's records there is what `logs` shows.
 */
export function jobArgs(
  target: JobTarget,
  bind: Bind,
  policy: RunPolicy,
  log: LogValues,
): string[] {
  const args = ['run']
  if (target.kind === 'workflow') args.push(resolve(target.path), '--run-id', target.runId)
  else args.push('--resume', target.runId)
  args.push('--foreground', '--repo', bind.repoPath)
  // Only when given: a resumed job fills what was not from the run's stored
  // policy, and a default spelled out here would read there as a choice.
  if (policy.given.permission !== undefined) args.push('--permission', policy.permission)
  if (bind.host !== undefined) args.push('--host', bind.host)
  if (bind.port !== undefined) args.push('--port', String(bind.port))
  if (policy.systemOnePath !== undefined) args.push('--system-one', policy.systemOnePath)
  if (policy.onFailure !== undefined) args.push('--on-failure', policy.onFailure)
  if (policy.retries !== undefined) args.push('--retries', String(policy.retries))
  if (policy.retryAfter !== undefined) args.push('--retry-after', policy.retryAfter)
  if (policy.agentAnswerAfter !== undefined) args.push('--agent-answer-after', policy.agentAnswerAfter)
  if (!policy.intervene) args.push('--no-coordinator')
  for (const profile of policy.harnessProfiles) args.push('--harness-profile', profile.name)
  if (log['log-level'] !== undefined) args.push('--log-level', log['log-level'])
  if (log['log-detail'] !== undefined) args.push('--log-detail', log['log-detail'])
  args.push('--log-stderr')
  return args
}

/**
 * Why a run cannot be resumed, or `null` when it can. Shared with `ui`, so
 * the UI's Resume button and `run --resume` refuse the same runs.
 */
export function resumeRefusal(
  journal: Journal,
  repoPath: string,
  runId: string,
  self?: number,
): { readonly code: 'unknown_run' | 'run_finished' | 'run_active'; readonly message: string } | null {
  const row = journal.runs().find((candidate) => candidate.id === runId)
  if (row === undefined) {
    return { code: 'unknown_run', message: `vinta-ai-maestro: no run "${runId}" in ${repoPath}` }
  }
  if (row.status === 'done') {
    // Refused rather than started, because there is nothing to resume: every
    // node settled and a resume would do nothing but write a second
    // `run_ended` over a finished history. Re-running the plan is a different
    // request with a different answer.
    return {
      code: 'run_finished',
      message: `vinta-ai-maestro: run "${runId}" already finished. Run the plan again instead.`,
    }
  }
  if (row.status === 'cancelled') {
    // `stop` is the operator saying this run is over. A resume that ignored
    // it would make `stop` a pause with a worse name.
    return {
      code: 'run_finished',
      message: `vinta-ai-maestro: run "${runId}" was stopped and cannot be resumed. Run the plan again instead.`,
    }
  }
  // Two schedulers on one run fight over every node. `self` is the job that
  // is checking — its own record is not a rival.
  const job = liveJob(repoPath, runId)
  if (job !== null && job.pid !== self) {
    return {
      code: 'run_active',
      message: `vinta-ai-maestro: run "${runId}" is already running (pid ${job.pid}).`,
    }
  }
  return null
}
