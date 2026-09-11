/**
 * The doctor is only worth having if it is right about a *broken* machine, so
 * every case here is a deliberately broken environment built from scratch: temp
 * directories, fake binaries, synthetic worktree summaries.
 *
 * Nothing in this file consults the machine's PATH. Every binary the doctor
 * probes is injected, which is what makes "a harness is missing" and "git
 * cannot do worktrees" assertable on a laptop where both are installed and
 * working — and what keeps the suite passing in CI, where neither may be.
 *
 * The fakes are `tests/support/fake-cli.ts`'s: a Node program behind the
 * launcher the platform actually installs. That matters more here than
 * anywhere else in the suite, because the doctor probes through
 * `commandInvocation` — so on Windows these fixtures are `.cmd` shims reached
 * via `cmd.exe`, which is exactly the shape an npm-installed `claude` has and
 * the exact thing a shebang fixture could never test.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { formatDoctorReport, runDoctor, type CheckResult, type DoctorOptions } from '../src/doctor/index.ts'
import { writeSummary, type WorktreeSummary } from '../src/lanes/summary.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'
import { fakeCli, fakeCliFromSource } from './support/fake-cli.ts'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-doctor-'))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/**
 * A `.mjs` line that writes `text` verbatim.
 *
 * `JSON.stringify` rather than an inlined `\n`, because these strings are the
 * subject: a fixture whose newline was eaten by one level of escaping would
 * change what the adapter's version parser and the refusal patterns see, and
 * would do it silently.
 */
const write = (stream: 'stdout' | 'stderr', text: string): string =>
  `process.${stream}.write(${JSON.stringify(`${text}\n`)})`

/**
 * `process.exitCode` rather than `process.exit(code)`.
 *
 * Every one of these fakes writes a line and then reports a code, and on POSIX
 * stdout to a pipe is asynchronous: `process.exit` can truncate a write that
 * has not drained, which would turn "not authenticated" into a blank probe and
 * a passing check. Setting the code and falling off the end of the program
 * flushes first.
 */
const exitWith = (code: number): string => `process.exitCode = ${code}`

const MISSING = '/nonexistent/vinta-ai-maestro-doctor/not-a-binary'

/**
 * `--version` answers, then the adapter's auth probe says whatever it is told.
 *
 * No argv branch is needed for the second half: claude-code's auth probe *is*
 * the real invocation with stdin closed (`src/harness/claude-code.ts`), so
 * "anything that is not `--version`" is precisely that probe.
 */
const fakeClaude = (dir: string, authOutput: string | null): string =>
  fakeCli(dir, 'claude', {
    version: '9.9.9 (Claude Code)',
    ...(authOutput === null ? {} : { stdout: [authOutput], exit: 1 }),
  })

/**
 * `codex login status` is what the adapter asks; nothing here holds a credential.
 *
 * Written as source rather than as a spec because the fixture's subject is the
 * *subcommand*: `--version` must succeed while `login` fails, and a spec that
 * answered every invocation the same way would pass this test for the wrong
 * reason. `process.argv` reads identically under a shebang script and under a
 * `.cmd` shim, which is why it can be said once.
 */
const fakeCodex = (dir: string, loggedIn: boolean): string =>
  fakeCliFromSource(
    dir,
    'codex',
    [
      `const argv = process.argv.slice(2)`,
      `if (argv[0] === '--version') {`,
      `  ${write('stdout', 'codex-cli 0.20.0')}`,
      `} else if (argv[0] === 'login') {`,
      loggedIn
        ? `  ${write('stdout', 'account active')}`
        : `  ${write('stdout', 'Not logged in')}\n  ${exitWith(1)}`,
      `}`,
    ].join('\n'),
  )

/** Likewise: `git --version` answers while `git worktree` is the half that breaks. */
const fakeGit = (dir: string, worktreesWork: boolean): string =>
  fakeCliFromSource(
    dir,
    'git',
    [
      `const argv = process.argv.slice(2)`,
      `if (argv[0] === '--version') {`,
      `  ${write('stdout', 'git version 2.45.2')}`,
      `} else if (argv[0] === 'worktree') {`,
      // stderr, not stdout: §11's assertion below is that a probe's *diagnostic*
      // never reaches a check line, and stderr is where a real git puts it.
      worktreesWork
        ? `  // usable: says nothing and exits 0`
        : `  ${write('stderr', 'fatal: not a working tree')}\n  ${exitWith(128)}`,
      `}`,
    ].join('\n'),
  )

const fakeDocker = (dir: string): string =>
  fakeCliFromSource(
    dir,
    'docker',
    [
      `if (process.argv[2] === 'compose') {`,
      `  ${write('stdout', 'v2.29.0')}`,
      `} else {`,
      `  ${exitWith(1)}`,
      `}`,
    ].join('\n'),
  )

const workflow = (harnessOverride?: Workflow['defaults']['harness']): Workflow =>
  WorkflowSchema.parse({
    schema_version: 1,
    id: 'doctor-fixture',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    nodes: [
      { id: 'p1', name: 'One', prompt_ref: 'plan.md#phase-1' },
      ...(harnessOverride === undefined
        ? []
        : [{ id: 'p2', name: 'Two', prompt_ref: 'plan.md#phase-2', harness: harnessOverride }]),
    ],
  })

/** A summary with one forked dev database, with or without a reset. */
const summary = (name: string, resetCmd: string | null): WorktreeSummary => ({
  name,
  path: `/tmp/${name}`,
  branch: `wt/${name}`,
  base_ref: 'main',
  created_at: new Date(0).toISOString(),
  state: {
    dev_db: {
      engine: 'postgres',
      strategy: 'fork',
      forked_name: `app_wt_${name.replaceAll('-', '_')}`,
      connection_url_var: 'DATABASE_URL',
      reset_cmd: resetCmd,
    },
    test_db: null,
    compose: { project_name: name },
  },
})

/**
 * An environment where nothing is wrong: every binary answers, disk is ample,
 * no compose is needed, no lane has been provisioned yet. Each test below
 * breaks exactly one thing about it, so a failure names its own cause.
 */
const greenOptions = (): DoctorOptions & { summaryDir: string } => {
  const root = makeTemp()
  return {
    workflow: workflow(),
    repoPath: root,
    poolRoot: join(root, 'pool'),
    summaryDir: join(root, 'summaries'),
    perLaneBytes: 1,
    bins: {
      git: fakeGit(root, true),
      docker: fakeDocker(root),
      harness: { 'claude-code': fakeClaude(root, null) },
    },
  }
}

const find = (checks: readonly CheckResult[], id: string): CheckResult => {
  const check = checks.find((candidate) => candidate.id === id)
  if (!check) throw new Error(`no check "${id}" in report`)
  return check
}

describe('vinta-ai-maestro doctor', () => {
  it('reports an all-green environment as all-pass and exits zero', async () => {
    const report = await runDoctor(greenOptions())

    expect(report.checks.every((check) => check.status === 'pass')).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.exitCode).toBe(0)
    // Passing checks carry no remedy: a fix printed beside working machinery is
    // what teaches a reader to skim past the ones that matter.
    expect(report.checks.every((check) => check.remedy === undefined)).toBe(true)
  })

  it('fails on a missing harness binary, with the install command', async () => {
    const base = greenOptions()
    const report = await runDoctor({
      ...base,
      bins: { ...base.bins, harness: { 'claude-code': MISSING } },
    })

    const check = find(report.checks, 'harness:claude-code')
    expect(check.status).toBe('fail')
    expect(check.label).toContain('not installed')
    expect(check.remedy).toContain('npm install -g')
    expect(report.exitCode).toBe(1)
  })

  it('fails a harness that is installed but not authenticated, with the login command', async () => {
    const base = greenOptions()
    const dir = makeTemp()
    const codexBin = fakeCodex(dir, false)
    const report = await runDoctor({
      ...base,
      workflow: workflow('codex'),
      bins: {
        ...base.bins,
        harness: { ...base.bins?.harness, codex: codexBin },
      },
    })

    // The harness that *is* logged in still passes: one broken harness must not
    // smear across the report.
    expect(find(report.checks, 'harness:claude-code').status).toBe('pass')

    const check = find(report.checks, 'harness:codex')
    expect(check.status).toBe('fail')
    expect(check.label).toContain('not authenticated')
    expect(check.remedy).toBe(`${codexBin} login`)
    expect(report.exitCode).toBe(1)
  })

  it('fails when git cannot use worktrees, while still seeing git itself', async () => {
    const base = greenOptions()
    const dir = makeTemp()
    const report = await runDoctor({
      ...base,
      bins: { ...base.bins, git: fakeGit(dir, false) },
    })

    expect(find(report.checks, 'git:present').status).toBe('pass')
    const check = find(report.checks, 'git:worktrees')
    expect(check.status).toBe('fail')
    expect(check.remedy).toContain('worktree list')
    expect(report.exitCode).toBe(1)
  })

  it('fails when git is absent entirely', async () => {
    const base = greenOptions()
    const report = await runDoctor({ ...base, bins: { ...base.bins, git: MISSING } })

    expect(find(report.checks, 'git:present').status).toBe('fail')
    expect(find(report.checks, 'git:present').remedy).toContain('install git')
    expect(report.exitCode).toBe(1)
  })

  it('warns — never fails — on a forked database with no reset_cmd', async () => {
    const base = greenOptions()
    const { summaryDir } = base
    await mkdir(summaryDir, { recursive: true })
    await writeSummary(summaryDir, summary('run-lane-1', 'dropdb --if-exists x'))
    await writeSummary(summaryDir, summary('run-lane-2', null))

    const report = await runDoctor(base)

    expect(find(report.checks, 'lane:run-lane-1').status).toBe('pass')
    const single = find(report.checks, 'lane:run-lane-2')
    expect(single.status).toBe('warn')
    expect(single.label).toContain('single-use')
    expect(single.label).toContain('re-provisioned')
    expect(single.remedy).toContain('reset_cmd')
    // Degraded, not blocked: the run still starts.
    expect(report.ok).toBe(true)
    expect(report.exitCode).toBe(0)
  })

  it('fails when the disk cannot hold lanes + 1 worktrees', async () => {
    const base = greenOptions()
    // Two lanes plus the integration worktree at 1 PiB each: no volume fits it.
    const report = await runDoctor({ ...base, perLaneBytes: 2 ** 50 })

    const check = find(report.checks, 'disk')
    expect(check.status).toBe('fail')
    expect(check.label).toContain('2 lanes + 1 integration worktree')
    expect(check.remedy).toContain('resources.lane.capacity')
    expect(report.exitCode).toBe(1)
  })

  it('does not fail a project that needs no compose, even with docker missing', async () => {
    const base = greenOptions()
    const report = await runDoctor({ ...base, bins: { ...base.bins, docker: MISSING } })

    const check = find(report.checks, 'compose')
    expect(check.status).toBe('pass')
    expect(check.label).toContain('not required')
    expect(report.exitCode).toBe(0)
  })

  it('fails a compose-delivered project when compose is unavailable', async () => {
    const base = greenOptions()
    const report = await runDoctor({
      ...base,
      bins: { ...base.bins, docker: MISSING },
      project: {
        migrateCmd: 'true',
        databases: {
          dev: {
            engine: 'postgres',
            delivery: 'compose',
            name: 'app',
            serverUrl: 'postgres://localhost:5432',
            connectionUrlVar: 'DATABASE_URL',
          },
        },
      },
    })

    const check = find(report.checks, 'compose')
    expect(check.status).toBe('fail')
    expect(check.remedy).toContain('docker compose')
    expect(report.exitCode).toBe(1)
  })

  it('reports every problem in one pass rather than stopping at the first', async () => {
    const base = greenOptions()
    const dir = makeTemp()
    const report = await runDoctor({
      ...base,
      perLaneBytes: 2 ** 50,
      bins: { git: fakeGit(dir, false), docker: MISSING, harness: { 'claude-code': MISSING } },
    })

    const failed = report.checks.filter((check) => check.status === 'fail').map((c) => c.id)
    expect(failed).toEqual(['harness:claude-code', 'git:worktrees', 'disk'])
  })

  it('renders one line per check and a fix line only under what is broken', async () => {
    const base = greenOptions()
    const report = await runDoctor({
      ...base,
      bins: { ...base.bins, harness: { 'claude-code': MISSING } },
    })
    const text = formatDoctorReport(report)

    expect(text).toContain('FAIL  harness claude-code: not installed')
    expect(text).toContain('        fix: ')
    expect(text.match(/^\s+fix: /gm)).toHaveLength(1)
    expect(text).toContain('1 failed, 0 warned, ')
    expect(text).toContain('A run cannot start')
  })

  it('never puts a probe’s output into a check line', async () => {
    const base = greenOptions()
    const dir = makeTemp()
    const report = await runDoctor({
      ...base,
      // The fake git prints "fatal: not a working tree" on stderr. It informs
      // the verdict and must not reach the report (§11).
      bins: { ...base.bins, git: fakeGit(dir, false) },
    })

    const rendered = formatDoctorReport(report)
    expect(rendered).not.toContain('fatal:')
    expect(rendered).not.toContain('not a working tree')
  })
})
