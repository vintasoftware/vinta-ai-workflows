/**
 * The judges: every place the daemon turns a System One answer into a
 * decision (§17.4–§17.6).
 *
 * Each one is a question, a label set, a threshold and — the part that matters
 * most — what an *unanswered* question means. They differ on that last point
 * deliberately:
 *
 * | judge | unanswered means | why |
 * |---|---|---|
 * | judge gate | the gate's `on_unavailable` (`pass` by default) | the plan's author decides whether the check is advisory |
 * | gate triage | no triage — the ordinary fix path | a missing hint must cost nothing |
 * | permission | deny | an unjudged command is an unchecked one |
 *
 * **Identifiers out, content in.** A judge sends repository content to the
 * classifier and journals labels, scores and latencies. The gate log is the
 * one place a judge writes prose — the question and the answer — because it is
 * where the fixer reads why a gate went red, and it is already a file of
 * repository content (§5.3).
 */
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { laneTreeHash } from '../gates/cache.ts'
import type { GateResult } from '../gates/runner.ts'
import { git, gitLines } from '../integration/git.ts'
import type { Judge } from '../types.ts'
import { mass, type SystemOneAdapter, type SystemOneScores } from './adapter.ts'
import type { GateTriageConfig, PermissionJudgeConfig } from './config.ts'

/** How a judge's question was settled, as journalled. */
export type JudgeOutcome = 'answered' | 'unavailable' | 'invalid' | 'oversized' | 'unconfigured'

/** One judgement, in the identifiers-only shape the journal carries. */
export interface Judgement {
  readonly outcome: JudgeOutcome
  /** The decision the judge took, in its own vocabulary (`passed`, `rerun`, `allow`, …). */
  readonly decision: string
  /** The label the classifier weighted most. Absent when nothing answered. */
  readonly top?: string
  /** The combined score the threshold was compared against. */
  readonly score?: number
  readonly latencyMs?: number
}

function top(scores: SystemOneScores): string | undefined {
  let best: string | undefined
  let bestScore = -1
  for (const [label, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = label
      bestScore = score
    }
  }
  return best
}

function formatScores(scores: SystemOneScores): string {
  return Object.entries(scores)
    .map(([label, score]) => `${label} ${score.toFixed(2)}`)
    .join(', ')
}

// ---------------------------------------------------------------------------
// Judge gates (§17.4)
// ---------------------------------------------------------------------------

/**
 * The lane's diff against the phase's base: the tree as it stands — staged,
 * unstaged and untracked work included, through the same temporary-index tree
 * the gate cache keys on — against the merge base with `base`.
 *
 * `null` when the diff would not fit, which the caller turns into `oversized`
 * rather than sending a prefix: a classifier judging the first 200 KiB of a
 * diff is judging whichever files sort first.
 */
export async function laneDiff(lanePath: string, base: string, maxBytes: number): Promise<string | null> {
  const tree = laneTreeHash(lanePath)
  const merged = await gitLines(lanePath, ['merge-base', base, 'HEAD']).catch(() => [])
  const from = merged[0] ?? base
  let diff: string
  try {
    diff = await git(lanePath, ['diff', '--no-color', '--no-ext-diff', from, tree], {
      maxBuffer: maxBytes + 1024 * 1024,
    })
  } catch {
    return null
  }
  return Buffer.byteLength(diff, 'utf8') > maxBytes ? null : diff
}

/**
 * The cache key component for a judge gate — what `cmd` is for a command gate.
 *
 * The resolved question and the adapter are in it, so an amendment to the
 * question or a different classifier is a miss rather than last week's verdict.
 */
export function judgeCacheKey(judge: Judge, question: string, adapterId: string): string {
  const spec = JSON.stringify({ ...judge, question, question_ref: undefined, adapter: adapterId })
  return `judge:${createHash('sha256').update(spec).digest('hex')}`
}

export interface RunJudgeGateOptions {
  readonly gateId: string
  readonly judge: Judge
  /** Resolved from `question` or `question_ref` by the caller, which owns the lane. */
  readonly question: string
  readonly lanePath: string
  /** The phase's base branch, which the diff is taken against. */
  readonly base: string
  readonly logPath: string
  /** Absent when the run was started without `--system-one`. */
  readonly adapter: SystemOneAdapter | undefined
}

export interface JudgeGateRun {
  readonly result: GateResult
  readonly judgement: Judgement
}

/**
 * Asks the judge gate's question of the lane's diff and reports it as a gate.
 *
 * Exit 0 or 1, never anything else, so the shipped pipeline's
 * `gate.exit_code` guards need no new vocabulary. The log carries the question
 * and the answer: that is what the fixer reads when this gate is the red one,
 * and "the classifier answered yes, 0.83, to *does this diff log request
 * bodies*" is the finding.
 */
export async function runJudgeGate(options: RunJudgeGateOptions): Promise<JudgeGateRun> {
  const started = Date.now()
  const { judge } = options
  const finish = (failed: boolean, judgement: Judgement, lines: readonly string[]): JudgeGateRun => {
    writeLog(options.logPath, [
      `judge gate ${options.gateId}`,
      '',
      `question: ${options.question}`,
      `labels: ${judge.labels.join(', ')}`,
      `fails on: ${judge.fail_on.join(' + ')} at ${judge.threshold.toFixed(2)} or more`,
      ...lines,
      '',
      failed
        ? 'FAILED. The classifier only reads the diff: change the diff so the honest answer to the question above changes. Do not try to reword it around the question.'
        : 'passed.',
    ])
    return {
      result: {
        gateId: options.gateId,
        status: failed ? 'failed' : 'passed',
        exitCode: failed ? 1 : 0,
        durationMs: Date.now() - started,
        logPath: options.logPath,
      },
      judgement,
    }
  }
  const unanswered = (outcome: JudgeOutcome, why: string): JudgeGateRun => {
    const failed = judge.on_unavailable === 'fail'
    return finish(failed, { outcome, decision: failed ? 'failed' : 'passed' }, [
      `answer: none — ${why}`,
      `on_unavailable: ${judge.on_unavailable}`,
    ])
  }

  if (options.adapter === undefined) {
    return unanswered('unconfigured', 'this run was started without a System One classifier (--system-one)')
  }
  const input = await laneDiff(options.lanePath, options.base, judge.max_input_bytes)
  if (input === null) {
    return unanswered('oversized', `the diff is larger than max_input_bytes (${judge.max_input_bytes})`)
  }

  const outcome = await options.adapter.classify({
    question: options.question,
    labels: judge.labels,
    input,
  })
  if (!outcome.ok) return unanswered(outcome.kind, outcome.message)

  const score = mass(outcome.scores, judge.fail_on)
  const failed = score >= judge.threshold
  const best = top(outcome.scores)
  return finish(
    failed,
    {
      outcome: 'answered',
      decision: failed ? 'failed' : 'passed',
      score,
      latencyMs: outcome.latencyMs,
      ...(best === undefined ? {} : { top: best }),
    },
    [`answer: ${formatScores(outcome.scores)}`, `score: ${score.toFixed(2)}`],
  )
}

function writeLog(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Gate triage (§17.5)
// ---------------------------------------------------------------------------

export const TRIAGE_LABELS = ['real', 'flaky', 'environment', 'pre_existing'] as const
export type TriageLabel = (typeof TRIAGE_LABELS)[number]

/** The labels a rerun is worth trying for. A real failure, or one the base already had, will not move. */
const RERUNNABLE: readonly TriageLabel[] = ['flaky', 'environment']

export const TRIAGE_QUESTION =
  'This is the end of the output of a CI-style check that just failed in a disposable git ' +
  'worktree. Classify why it failed. "real": the code under test is wrong (an assertion, a ' +
  'type error, a lint violation in changed code). "flaky": a nondeterministic failure that ' +
  'would likely pass on a rerun (a timing-dependent test, a race, a random seed). ' +
  '"environment": the machine or a service failed, not the code (a port in use, a database ' +
  'or container not ready, a network error, out of disk or memory, a lock held). ' +
  '"pre_existing": the failure is in code this change did not touch and would fail on the ' +
  'base branch too.'

export interface TriageOptions {
  readonly config: GateTriageConfig
  readonly adapter: SystemOneAdapter
  readonly logPath: string
}

export interface Triage {
  readonly judgement: Judgement
  /** The label the classifier weighted most, for `gate.triage`. */
  readonly label?: TriageLabel
  /** Whether the failure is worth one more run before a fixer is spent on it. */
  readonly rerun: boolean
}

/**
 * Sorts a red command gate. Only ever *adds* a rerun: an unanswered question,
 * or an answer below the threshold, leaves the ordinary path — the fixer —
 * exactly as it was.
 */
export async function triageGateFailure(options: TriageOptions): Promise<Triage> {
  const input = tail(options.logPath, options.config.max_input_bytes)
  if (input === null || input.trim() === '') {
    return { judgement: { outcome: 'invalid', decision: 'fix' }, rerun: false }
  }
  const outcome = await options.adapter.classify({
    question: TRIAGE_QUESTION,
    labels: TRIAGE_LABELS,
    input,
  })
  if (!outcome.ok) return { judgement: { outcome: outcome.kind, decision: 'fix' }, rerun: false }

  const score = mass(outcome.scores, RERUNNABLE)
  const rerun = score >= options.config.rerun_above
  const label = top(outcome.scores) as TriageLabel | undefined
  return {
    judgement: {
      outcome: 'answered',
      decision: rerun ? 'rerun' : 'fix',
      score,
      latencyMs: outcome.latencyMs,
      ...(label === undefined ? {} : { top: label }),
    },
    ...(label === undefined ? {} : { label }),
    rerun,
  }
}

/** The last `maxBytes` of a file, or null when it cannot be read. */
function tail(path: string, maxBytes: number): string | null {
  try {
    const size = statSync(path).size
    if (size <= maxBytes) return readFileSync(path, 'utf8')
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      readSync(fd, buffer, 0, maxBytes, size - maxBytes)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Permission judge (§17.6)
// ---------------------------------------------------------------------------

export const PERMISSION_LABELS = ['safe', 'unsafe'] as const

export const PERMISSION_QUESTION =
  'An autonomous coding agent wants to run this tool call inside a disposable git worktree ' +
  'of the project, on a developer machine that also holds other repositories and ' +
  'credentials. "safe": it only reads, builds, tests, lints, formats, or edits files inside ' +
  'that worktree, or runs the project\'s own development tooling there. "unsafe": it could ' +
  'reach outside the worktree or do lasting harm — writing or deleting outside it, pushing ' +
  'or force-pushing, changing git config or remotes, reading credentials or secrets, sending ' +
  'data to an external host, installing software system-wide, killing unrelated processes, ' +
  'or changing system settings.'

export interface PermissionRequest {
  readonly tool: string
  /** The call's input as the harness reported it — a command line for `Bash`. */
  readonly input: unknown
  /** The lane the agent is standing in. Sent so "outside the worktree" has a referent. */
  readonly cwd: string
}

export interface PermissionDecision {
  readonly allow: boolean
  /** What the agent is told. Never quotes the input back. */
  readonly reason: string
  readonly judgement: Judgement
}

/**
 * Whether one tool call may run. **Fails closed**: no answer, an invalid
 * answer, or an answer short of `allow_above` on `safe` is a denial, and the
 * agent is told to find a narrower way to do the same thing rather than to
 * try the same call again.
 */
export async function judgePermission(
  request: PermissionRequest,
  config: PermissionJudgeConfig,
  adapter: SystemOneAdapter,
): Promise<PermissionDecision> {
  if (!config.tools.includes(request.tool)) {
    return { allow: true, reason: 'not a judged tool', judgement: { outcome: 'answered', decision: 'allow' } }
  }
  const input = `cwd: ${request.cwd}\ntool: ${request.tool}\n${renderToolInput(request.input)}`
  const outcome = await adapter.classify({
    question: config.question ?? PERMISSION_QUESTION,
    labels: PERMISSION_LABELS,
    input,
  })
  if (!outcome.ok) {
    return {
      allow: false,
      reason:
        'the safety classifier could not judge this call, so it was denied. Retry once; if it ' +
        'is denied again, do the same work with a narrower command inside your worktree.',
      judgement: { outcome: outcome.kind, decision: 'deny' },
    }
  }
  const score = mass(outcome.scores, ['safe'])
  const allow = score >= config.allow_above
  const best = top(outcome.scores)
  return {
    allow,
    reason: allow
      ? 'judged safe'
      : 'the safety classifier judged this call unsafe for an unattended run. Do not retry it ' +
        'or a reworded equivalent; stay inside your worktree, and if the phase genuinely needs ' +
        'it, say so in your final report.',
    judgement: {
      outcome: 'answered',
      decision: allow ? 'allow' : 'deny',
      score,
      latencyMs: outcome.latencyMs,
      ...(best === undefined ? {} : { top: best }),
    },
  }
}

function renderToolInput(input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const command = (input as Record<string, unknown>)['command']
    if (typeof command === 'string') return `command: ${command}`
  }
  try {
    return `input: ${JSON.stringify(input)}`
  } catch {
    return 'input: (unserializable)'
  }
}

