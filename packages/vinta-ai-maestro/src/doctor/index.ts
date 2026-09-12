/**
 * `vinta-ai-maestro doctor` — §13.5.
 *
 * The argument for this command is its design brief: nearly every failure this
 * system can have at minute zero is in one list, and discovering them one at a
 * time across a half-started run is the worst way to learn them. So the doctor
 * runs *every* check even after one fails, and reports the whole list at once.
 *
 * Three rules shape what a check may say.
 *
 * **A check reports; it never repairs.** Authentication in particular is the
 * user's to perform (§2, §7): nothing here runs a login flow, reads a
 * credential store, or prompts for a secret. It delegates to each adapter's
 * `preflight()` and prints the command *the user* runs.
 *
 * **fail means a run cannot start; warn means it will start degraded.** A lane
 * whose forked database has no `reset_cmd` is the canonical warn — the run is
 * fine, the lane is simply single-use and gets re-provisioned instead of reset
 * (§8). Collapsing the two would either block runs that work or hide the
 * degradation until wave 2.
 *
 * **A check line carries opaque identifiers and paths only** (§11) — harness
 * ids, lane names, byte counts. No repository contents, no command output, no
 * credential, ever. Probe stdout is used for a verdict and then dropped rather
 * than quoted into a message.
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { HarnessAdapter } from '../harness/adapter.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import { CodexAdapter } from '../harness/codex.ts'
import { OpencodeAdapter } from '../harness/opencode.ts'
import { measureBytes, probePoolDisk } from '../lanes/disk.ts'
import type { ProjectSpec } from '../lanes/pool.ts'
import { readSummary, resetPlan } from '../lanes/summary.ts'
import { commandInvocation, spawnOptionsFor } from '../platform/platform.ts'
import type { Workflow } from '../types.ts'

const run = promisify(execFile)

export type HarnessId = Workflow['defaults']['harness']

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  /** Stable, opaque check identifier — safe to log and to assert on. */
  readonly id: string
  /** One scannable line. Identifiers and paths only. */
  readonly label: string
  readonly status: CheckStatus
  /** The exact command the *user* runs. Present on warn and fail only. */
  readonly remedy?: string
}

export interface DoctorReport {
  readonly checks: readonly CheckResult[]
  readonly ok: boolean
  readonly exitCode: 0 | 1
}

/** Binary paths, so a machine's PATH is never what decides a check's answer. */
export interface DoctorBins {
  readonly git?: string
  readonly docker?: string
  readonly harness?: Partial<Record<HarnessId, string>>
}

export interface DoctorOptions {
  readonly workflow: Workflow
  /** The main checkout the lanes will be worktrees of. */
  readonly repoPath: string
  /** Directory the lane worktrees will be created under. */
  readonly poolRoot: string
  /** Defaults to `<repoPath>/.vinta-ai-workflows/worktrees`. */
  readonly summaryDir?: string
  /** Overrides the measured per-lane disk estimate. */
  readonly perLaneBytes?: number
  /** Present when the project's databases are known; decides whether compose is needed. */
  readonly project?: ProjectSpec
  readonly bins?: DoctorBins
}

const PROBE_TIMEOUT_MS = 10_000

/** `git worktree remove` — what `LanePool.recycle` needs — landed in 2.17. */
const MIN_GIT = [2, 17, 0] as const

const INSTALL_GIT = 'install git 2.17 or newer (macOS: brew install git)'
const INSTALL_COMPOSE = 'install Docker Desktop, or the docker compose plugin'

interface ProbeOutcome {
  readonly ok: boolean
  /** Used for a verdict and then dropped. Never quoted into a check line. */
  readonly output: string
}

async function probeCommand(
  bin: string,
  args: readonly string[],
  cwd?: string,
): Promise<ProbeOutcome> {
  try {
    // The same seam a run uses, so the doctor probes the path a run takes: on
    // Windows a CLI installed by npm is a `.cmd` shim, unreachable without it.
    const invocation = commandInvocation(bin, args)
    const { stdout } = await run(invocation.file, [...invocation.args], {
      ...(cwd === undefined ? {} : { cwd }),
      timeout: PROBE_TIMEOUT_MS,
      ...spawnOptionsFor(invocation),
    })
    return { ok: true, output: stdout }
  } catch {
    return { ok: false, output: '' }
  }
}

/**
 * An adapter's `hint` is a fixed command string by contract, but it is the one
 * field here sourced from another module, so it is clamped to a single short
 * line before it reaches the report.
 */
const asRemedy = (hint: string | undefined, fallback: string): string => {
  const first = hint?.split('\n')[0]?.trim()
  return first === undefined || first.length === 0 ? fallback : first.slice(0, 200)
}

const pass = (id: string, label: string): CheckResult => ({ id, label, status: 'pass' })

const flag = (
  id: string,
  label: string,
  status: 'warn' | 'fail',
  remedy: string,
): CheckResult => ({ id, label, status, remedy })

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** Every harness this workflow could dispatch to: the default plus every override. */
export function referencedHarnesses(workflow: Workflow): readonly HarnessId[] {
  const ids = new Set<HarnessId>([workflow.defaults.harness])
  for (const node of workflow.nodes) if (node.harness) ids.add(node.harness)
  return [...ids]
}

const adapterFor = (id: HarnessId, bin: string | undefined): HarnessAdapter => {
  const options = bin === undefined ? {} : { bin }
  switch (id) {
    case 'claude-code':
      return new ClaudeCodeAdapter(options)
    case 'codex':
      return new CodexAdapter(options)
    case 'opencode':
      return new OpencodeAdapter(options)
  }
}

async function checkHarness(id: HarnessId, bin: string | undefined): Promise<CheckResult> {
  const check = `harness:${id}`
  let result
  try {
    result = await adapterFor(id, bin).preflight()
  } catch {
    // A preflight that throws is indistinguishable from a broken install for
    // the purpose of starting a run, and the run must not start either way.
    return flag(check, `harness ${id}: preflight failed`, 'fail', `install or reinstall ${id}`)
  }

  if (!result.installed) {
    return flag(
      check,
      `harness ${id}: not installed`,
      'fail',
      asRemedy(result.hint, `install the ${id} CLI`),
    )
  }
  if (!result.authenticated) {
    // §7: preflight is a hard gate. The daemon never logs in on the user's behalf.
    return flag(
      check,
      `harness ${id}: installed but not authenticated`,
      'fail',
      asRemedy(result.hint, `log in to ${id}`),
    )
  }
  const version = result.version === undefined ? '' : ` (${result.version})`
  return pass(check, `harness ${id}: installed and authenticated${version}`)
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const parseGitVersion = (output: string): readonly [number, number, number] | null => {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

const atLeast = (
  found: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean => {
  for (let i = 0; i < 3; i += 1) {
    const a = found[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

async function checkGit(bin: string): Promise<CheckResult> {
  const probe = await probeCommand(bin, ['--version'])
  if (!probe.ok) return flag('git:present', 'git: not found', 'fail', INSTALL_GIT)

  const found = parseGitVersion(probe.output)
  if (found === null) return flag('git:present', 'git: version unreadable', 'fail', INSTALL_GIT)
  if (!atLeast(found, MIN_GIT)) {
    return flag(
      'git:present',
      `git: ${found.join('.')} is older than ${MIN_GIT.join('.')}`,
      'fail',
      INSTALL_GIT,
    )
  }
  return pass('git:present', `git: ${found.join('.')}`)
}

/**
 * Worktrees are asked about rather than assumed: a checkout can be a valid
 * repository and still refuse `git worktree` (a linked worktree of a worktree,
 * a repo whose `.git` is a file pointing somewhere gone, a wrapper on PATH
 * that is not really git). A pool of lanes is nothing but worktrees, so this
 * is the difference between failing now and failing at lane 1.
 */
async function checkWorktrees(bin: string, repoPath: string): Promise<CheckResult> {
  const probe = await probeCommand(bin, ['worktree', 'list', '--porcelain'], repoPath)
  return probe.ok
    ? pass('git:worktrees', 'git worktrees: usable')
    : flag(
        'git:worktrees',
        'git worktrees: unusable in this checkout',
        'fail',
        `run: git -C ${repoPath} worktree list`,
      )
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

/**
 * Compose is only a requirement when a database is *delivered* by it. A project
 * with an external or file-delivered database must never fail this check for a
 * tool it will not invoke.
 */
export const needsCompose = (project: ProjectSpec | undefined): boolean =>
  project !== undefined &&
  [project.databases.dev, project.databases.test].some((db) => db?.delivery === 'compose')

async function checkCompose(bin: string, required: boolean): Promise<CheckResult> {
  if (!required) return pass('compose', 'docker compose: not required by this project')
  const probe = await probeCommand(bin, ['compose', 'version'])
  return probe.ok
    ? pass('compose', 'docker compose: available')
    : flag('compose', 'docker compose: unavailable', 'fail', INSTALL_COMPOSE)
}

// ---------------------------------------------------------------------------
// disk
// ---------------------------------------------------------------------------

const size = (bytes: number): string =>
  bytes < 1024 ** 3
    ? `${Math.round(bytes / 1024 ** 2)} MiB`
    : `${(bytes / 1024 ** 3).toFixed(1)} GiB`

/** §8: the probe runs against `lanes + 1` — the integration worktree costs the same. */
async function checkDisk(options: DoctorOptions, laneCount: number): Promise<CheckResult> {
  const perLane = options.perLaneBytes ?? (await measureBytes(options.repoPath))
  const probe = await probePoolDisk(options.poolRoot, perLane, laneCount + 1)
  const need = `${laneCount} lanes + 1 integration worktree needs ${size(probe.requiredBytes)}`
  if (probe.fits) return pass('disk', `disk: ${need}, ${size(probe.availableBytes)} free`)
  return flag(
    'disk',
    `disk: ${need}, only ${size(probe.availableBytes)} free`,
    'fail',
    `free ${size(probe.requiredBytes - probe.availableBytes)} on the volume holding ${options.poolRoot}, ` +
      'or lower resources.lane.capacity in the workflow',
  )
}

// ---------------------------------------------------------------------------
// lane summaries
// ---------------------------------------------------------------------------

/**
 * Every already-provisioned lane, read back from the summary on disk — the
 * contract file, never the in-memory pool (see `summary.ts`).
 */
async function checkLaneSummaries(summaryDir: string): Promise<readonly CheckResult[]> {
  let entries: string[]
  try {
    entries = await readdir(summaryDir)
  } catch {
    return [pass('lanes', 'lane summaries: none yet — lanes will be provisioned fresh')]
  }

  const names = entries.filter((entry) => entry.endsWith('.yaml')).map((e) => e.slice(0, -5)).sort()
  if (names.length === 0) {
    return [pass('lanes', 'lane summaries: none yet — lanes will be provisioned fresh')]
  }

  return await Promise.all(names.map((name) => checkLaneSummary(summaryDir, name)))
}

/**
 * A schema failure as `field: complaint` pairs, or null when the file did not
 * parse at all.
 *
 * **Paths and messages only, never the value that failed** (§11). A field path
 * is the schema's own vocabulary and a message is its own text — neither can
 * carry repository content, which the received value very much can: a summary
 * holds database names, connection variables and filesystem paths.
 */
function schemaComplaints(error: unknown): string | null {
  const issues = (error as { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] })
    .issues
  if (!Array.isArray(issues) || issues.length === 0) return null

  return issues
    .slice(0, 5)
    .map((issue) => `${(issue.path ?? []).map(String).join('.') || '(root)'}: ${issue.message ?? 'invalid'}`)
    .join('; ')
}

async function checkLaneSummary(summaryDir: string, name: string): Promise<CheckResult> {
  const check = `lane:${name}`
  let summary
  try {
    summary = await readSummary(summaryDir, name)
  } catch (error) {
    // "unreadable" was true and useless. A summary fails to read for two very
    // different reasons — the file is gone or malformed, or it parses and one
    // field is wrong — and only the second is repairable. Naming the fields
    // turns a lane you would have thrown away into one you can fix, which
    // matters because throwing it away takes its forked databases with it.
    const detail = schemaComplaints(error)
    return flag(
      check,
      detail === null
        ? `lane ${name}: summary unreadable`
        : `lane ${name}: summary does not match the schema — ${detail}`,
      'warn',
      detail === null
        ? `delete ${summaryDir}/${name}.yaml and re-provision the lane`
        : `fix those fields in ${summaryDir}/${name}.yaml, or delete it and re-provision the lane`,
    )
  }

  // A single forked database without a reset makes the whole lane single-use.
  return resetPlan(summary).reusable
    ? pass(check, `lane ${name}: reusable — every forked database has a reset_cmd`)
    : flag(
        check,
        `lane ${name}: single-use — a forked database has no reset_cmd, ` +
          'so it will be re-provisioned between phases rather than reset',
        'warn',
        `record a reset_cmd for the forked database in ${summaryDir}/${name}.yaml, ` +
          'or accept the re-provisioning cost',
      )
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Runs every check and reports all of them. Checks are independent, so they run
 * concurrently and a failure never short-circuits the ones after it — reporting
 * the whole list at once is the entire point of the command.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { workflow, repoPath } = options
  const gitBin = options.bins?.git ?? 'git'
  const dockerBin = options.bins?.docker ?? 'docker'
  const summaryDir = options.summaryDir ?? `${repoPath}/.vinta-ai-workflows/worktrees`
  const laneCount = workflow.resources['lane']?.capacity ?? 1

  const [harnesses, git, worktrees, compose, disk, lanes] = await Promise.all([
    Promise.all(
      referencedHarnesses(workflow).map((id) =>
        checkHarness(id, options.bins?.harness?.[id]),
      ),
    ),
    checkGit(gitBin),
    checkWorktrees(gitBin, repoPath),
    checkCompose(dockerBin, needsCompose(options.project)),
    checkDisk(options, laneCount),
    checkLaneSummaries(summaryDir),
  ])

  const checks = [...harnesses, git, worktrees, compose, disk, ...lanes]
  const ok = !checks.some((check) => check.status === 'fail')
  return { checks, ok, exitCode: ok ? 0 : 1 }
}

export { formatDoctorReport } from './report.ts'
