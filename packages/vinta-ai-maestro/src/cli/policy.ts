/**
 * The settings a run takes that are not *which* run, parsed in one place.
 *
 * `run` takes them for the run it starts; `ui` takes them for every run started
 * from the browser and passes them on to each job it launches. One parser is
 * what keeps the two from disagreeing about what a valid setting is — a UI
 * more permissive than the command line would be a second, quieter way to
 * start a run `run` would have refused.
 */
import { resolve } from 'node:path'

import {
  AGENT_PERMISSIONS,
  DEFAULT_PERMISSION,
  isAgentPermission,
  type AgentPermission,
} from '../harness/permissions.ts'
import { liveJob } from '../job/job.ts'
import type { Journal } from '../journal/journal.ts'
import { loadSystemOne, SystemOneConfigError, type SystemOne } from '../system-one/config.ts'
import type { Io } from './io.ts'
import type { LogValues } from './logging.ts'
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
export function toRetryAfterMs(raw: string | undefined, io: Io): number | null | undefined {
  if (raw === undefined) return undefined
  const match = /^(\d+)(s|m|h)?$/.exec(raw.trim())
  if (match === null) {
    io.err('vinta-ai-maestro: --retry-after must be a whole number of minutes, or 30s / 15m / 2h')
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
  readonly intervene: boolean
}

/** The flag values `toRunPolicy` reads, as `parseArgs` produced them. */
export interface PolicyValues {
  readonly permission?: string | undefined
  readonly 'system-one'?: string | undefined
  readonly 'on-failure'?: string | undefined
  readonly retries?: string | undefined
  readonly 'retry-after'?: string | undefined
  readonly 'no-intervene'?: boolean | undefined
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

  // A budget, so it is bounded and finite. Zero is meaningful — it is `ask`
  // spelled through this flag — and anything unparseable is a typo worth
  // catching rather than a silent fallback to the default.
  const rawRetries = values.retries
  const retries = rawRetries === undefined ? undefined : Number(rawRetries)
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > 5)) {
    io.err('vinta-ai-maestro: --retries must be a whole number from 0 to 5')
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
    intervene: values['no-intervene'] !== true,
  }
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
  args.push('--foreground', '--repo', bind.repoPath, '--permission', policy.permission)
  if (bind.host !== undefined) args.push('--host', bind.host)
  if (bind.port !== undefined) args.push('--port', String(bind.port))
  if (policy.systemOnePath !== undefined) args.push('--system-one', policy.systemOnePath)
  if (policy.onFailure !== undefined) args.push('--on-failure', policy.onFailure)
  if (policy.retries !== undefined) args.push('--retries', String(policy.retries))
  if (policy.retryAfter !== undefined) args.push('--retry-after', policy.retryAfter)
  if (!policy.intervene) args.push('--no-intervene')
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
