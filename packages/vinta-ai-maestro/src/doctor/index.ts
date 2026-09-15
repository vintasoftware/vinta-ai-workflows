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
import { connect } from 'node:net'
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
// shared servers
// ---------------------------------------------------------------------------

/** How long a shared server has to accept a connection before it is unreachable. */
const REACH_TIMEOUT_MS = 2_000

/** Ports for the schemes a project is likely to point a shared service at. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'postgres:': 5432,
  'postgresql:': 5432,
  'redis:': 6379,
  'rediss:': 6380,
  'amqp:': 5672,
  'amqps:': 5671,
  'mysql:': 3306,
  'mongodb:': 27017,
  'http:': 80,
  'https:': 443,
}

/** Every shared server this project connects to but does not start. */
export function sharedServers(project: ProjectSpec | undefined): { label: string; url: string }[] {
  if (project === undefined) return []
  const found: { label: string; url: string }[] = []

  for (const [role, db] of Object.entries(project.databases)) {
    // A compose-delivered database is booted *by the lane*, so it is correctly
    // unreachable now; a file-delivered one is a path, not an address.
    if (db?.engine === 'postgres' && db.delivery === 'external') {
      found.push({ label: `database ${role}`, url: db.serverUrl })
    }
  }
  for (const service of project.services ?? []) {
    // A service with no URL *is* its namespace — an object-storage prefix has
    // no address to connect to.
    if (service.url !== undefined) found.push({ label: `service ${service.id}`, url: service.url })
  }
  return found
}

/**
 * Whether a shared server answers.
 *
 * A TCP connect, not a protocol handshake: the question is whether the thing a
 * lane is about to connect to is listening, and this package has no client for
 * postgres, redis, rabbit or the rest — nor should it grow four.
 */
async function reachable(url: string): Promise<boolean> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  const port = target.port === '' ? DEFAULT_PORTS[target.protocol] : Number(target.port)
  if (port === undefined || !Number.isInteger(port)) return false
  const host = target.hostname === '' ? '127.0.0.1' : target.hostname

  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const settle = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(REACH_TIMEOUT_MS)
    socket.once('connect', () => {
      settle(true)
    })
    socket.once('timeout', () => {
      settle(false)
    })
    socket.once('error', () => {
      settle(false)
    })
  })
}

/**
 * The shared servers, probed.
 *
 * Without this, a `doctor` pass meant "the binaries are here and the disk
 * fits", and a project whose Postgres lives in some other checkout's compose
 * stack could pass it and then die on the very first `createdb` with a libpq
 * connection error — before a single worktree existed. A preflight that cannot
 * see the one hard dependency of every lane is checking the easy half.
 *
 * The address is named, because "a server did not answer" is not something
 * anyone can act on and `postgres://localhost:5432` is.
 */
async function checkServers(project: ProjectSpec | undefined): Promise<CheckResult[]> {
  const servers = sharedServers(project)
  if (servers.length === 0) {
    return [pass('servers', 'shared servers: none declared by this project')]
  }
  return await Promise.all(
    servers.map(async ({ label, url }) =>
      (await reachable(url))
        ? pass(`server:${label}`, `${label}: ${url} answers`)
        : flag(
            `server:${label}`,
            `${label}: nothing is listening on ${url}`,
            'fail',
            'start the shared stack this project connects to — a project.prepare_cmd is the ' +
              'place to do that automatically',
          ),
    ),
  )
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
// ---------------------------------------------------------------------------
// held branches — a previous run's worktrees make this one impossible
// ---------------------------------------------------------------------------

/**
 * Phase branches that another worktree already has checked out.
 *
 * Lane directories are named per *run* (`<run-id>-crew-2-mid`) and phase
 * branches are named per *workflow* (`plan/<id>/phase-p0`). So a run that fails
 * leaves worktrees holding branch names the next run of the same workflow will
 * try to cut — and git refuses to check out a branch a second worktree already
 * holds. Nothing cleans those up: `purge` deletes run state under
 * `.vinta-ai-maestro/runs/`, and lane worktrees are not there.
 *
 * The failure without this check is `git_branch` failing per node, after lanes
 * have been provisioned, with the lane acquired and no branch event to show for
 * it. It is diagnosable only by running `git worktree list` and noticing an old
 * run's directory — which is not a thing the tool should ask of anyone.
 *
 * A `fail`: the run cannot cut the branches it needs.
 */
async function checkHeldBranches(
  bin: string,
  repoPath: string,
  workflow: Workflow,
): Promise<readonly CheckResult[]> {
  const probe = await probeCommand(bin, ['worktree', 'list', '--porcelain'], repoPath)
  // `checkWorktrees` already reports an unusable checkout; saying it twice adds
  // nothing, and a missing listing is not evidence of a held branch.
  if (!probe.ok) return []

  // `worktree list --porcelain` is stanzas of `key value` lines separated by
  // blank lines, each opening with `worktree <path>`.
  const held = new Map<string, string>()
  let path = ''
  for (const line of probe.output.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ')) {
      const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      if (branch !== '') held.set(branch, path)
    }
  }

  const wanted = workflow.nodes.map((node) => `plan/${workflow.id}/phase-${node.id}`)
  const clashes = wanted.filter((branch) => held.has(branch))
  if (clashes.length === 0) {
    return [pass('branches', `phase branches: none held by another worktree`)]
  }

  // One line per clash, each naming the directory to remove. A single summary
  // line would make the operator run `git worktree list` themselves, which is
  // the step this check exists to remove.
  return clashes.map((branch) =>
    flag(
      `branch:${branch}`,
      `${branch}: already checked out in ${held.get(branch) as string}`,
      'fail',
      `git -C ${repoPath} worktree remove --force ${held.get(branch) as string}`,
    ),
  )
}

// ---------------------------------------------------------------------------
// briefs — does the base branch actually carry what the nodes point at
// ---------------------------------------------------------------------------

/**
 * Every `prompt_ref` and `plan_context_ref`, resolved against `base_branch`.
 *
 * This is the check that earns the command. A lane is a fresh worktree of the
 * base branch, so a plan that is uncommitted, staged-but-not-committed, or
 * committed on a different branch is present in the operator's checkout and
 * absent from every lane — and the run finds out one node at a time, after
 * provisioning worktrees and cutting branches, with every dependent blocked
 * behind it.
 *
 * `git cat-file -e <ref>:<path>` asks the one question that matters and reads
 * nothing: it resolves the path in the branch's *tree*, so a working-tree copy
 * cannot make it pass. That is the whole point — the working tree is exactly
 * what the lanes will not have.
 *
 * A `fail`, not a warning. There is no sense in which a run can proceed with a
 * brief it cannot read.
 */
async function checkBriefs(
  bin: string,
  repoPath: string,
  workflow: Workflow,
): Promise<CheckResult[]> {
  const base = workflow.base_branch
  // One entry per distinct file; several nodes usually share one plan, and
  // reporting the same missing file eight times buries the eight that differ.
  const wanted = new Map<string, string[]>()
  const note = (ref: string, owner: string): void => {
    const hash = ref.lastIndexOf('#')
    const path = hash === -1 ? ref : ref.slice(0, hash)
    if (path === '') return
    wanted.set(path, [...(wanted.get(path) ?? []), owner])
  }

  for (const node of workflow.nodes) note(node.prompt_ref, node.id)
  for (const ref of workflow.plan_context_refs) note(ref, 'plan_context_refs')

  if (wanted.size === 0) return []

  // The branch has to exist before asking what is in it, and "no such branch"
  // is a different fix from "no such file".
  const branch = await probeCommand(bin, ['rev-parse', '--verify', `${base}^{commit}`], repoPath)
  if (!branch.ok) {
    return [
      flag(
        'briefs',
        `base_branch "${base}": not a branch in this checkout`,
        'fail',
        `create or fetch ${base}, or point base_branch at a branch that exists`,
      ),
    ]
  }

  const results = await Promise.all(
    [...wanted].map(async ([path, owners]): Promise<CheckResult> => {
      const found = await probeCommand(bin, ['cat-file', '-e', `${base}:${path}`], repoPath)
      if (found.ok) return pass(`brief:${path}`, `${path}: present in ${base}`)

      // Distinguishing the two cases is most of the value: "commit it" and
      // "point base_branch somewhere else" are different actions, and the
      // operator cannot tell which they need from the failure alone.
      const tracked = await probeCommand(bin, ['ls-files', '--error-unmatch', path], repoPath)
      // `rev-list`, not `log --format=%H`. On Windows every probe goes through
      // `cmd.exe`, which expands `%…%` — so a format string is a argument the
      // shell rewrites, and the probe came back empty there while working
      // everywhere else. The path this whole check exists to distinguish then
      // reported as "staged, never committed", which is the wrong fix.
      const elsewhere = await probeCommand(
        bin,
        ['rev-list', '--all', '--max-count=1', '--', path],
        repoPath,
      )
      const onSomeBranch = elsewhere.ok && elsewhere.output.trim() !== ''

      const why = onSomeBranch
        ? `committed, but not on ${base}`
        : tracked.ok
          ? `staged, never committed — \`git add\` alone does not put it in a branch`
          : 'not committed anywhere'

      return flag(
        `brief:${path}`,
        `${path}: missing from ${base} (${why}) — needed by ${owners.join(', ')}`,
        'fail',
        onSomeBranch
          ? `merge it into ${base}, or set base_branch to the branch that has it`
          : `commit ${path} to ${base}`,
      )
    }),
  )
  return results
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { workflow, repoPath } = options
  const gitBin = options.bins?.git ?? 'git'
  const dockerBin = options.bins?.docker ?? 'docker'
  const summaryDir = options.summaryDir ?? `${repoPath}/.vinta-ai-workflows/worktrees`
  const laneCount = workflow.resources['lane']?.capacity ?? 1

  const [harnesses, git, worktrees, compose, servers, disk, lanes, briefs, branches] =
    await Promise.all([
      Promise.all(
        referencedHarnesses(workflow).map((id) => checkHarness(id, options.bins?.harness?.[id])),
      ),
      checkGit(gitBin),
      checkWorktrees(gitBin, repoPath),
      checkCompose(dockerBin, needsCompose(options.project)),
      checkServers(options.project),
      checkDisk(options, laneCount),
      checkLaneSummaries(summaryDir),
      checkBriefs(gitBin, repoPath, workflow),
      checkHeldBranches(gitBin, repoPath, workflow),
    ])

  const checks = [
    ...harnesses,
    git,
    worktrees,
    compose,
    ...servers,
    disk,
    ...briefs,
    ...branches,
    ...lanes,
  ]
  const ok = !checks.some((check) => check.status === 'fail')
  return { checks, ok, exitCode: ok ? 0 : 1 }
}

export { formatDoctorReport } from './report.ts'
