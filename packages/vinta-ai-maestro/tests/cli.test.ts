/**
 * The CLI entrypoint.
 *
 * Every test here invokes a command *function* with an injected `Io`, never a
 * built binary through a shell. That is not only faster: it is what lets the
 * §11 assertions be exact. "The token is never logged" is not checkable against
 * a subprocess's interleaved stdio — it is checkable against the complete,
 * separated list of lines the command emitted, which is what `recorder()`
 * below collects.
 *
 * Nothing in this file consults the machine's PATH or its real repository. The
 * doctor's binaries are fakes written into a temp directory, the workflows are
 * written per test, and every `.vinta-ai-maestro/` store is a temp directory that is
 * removed afterwards — including the ones the purge tests try, and fail, to
 * escape.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { amendRun, type AmendResult } from '../src/amend/amend.ts'
import { doctorCommand, type DoctorOverrides } from '../src/cli/doctor.ts'
import { FAILED, OK, USAGE, type Io } from '../src/cli/io.ts'
import { main } from '../src/cli/index.ts'
import { purgeCommand } from '../src/cli/purge.ts'
import { runCommand } from '../src/cli/run.ts'
import { serveCommand } from '../src/cli/serve.ts'
import { simulateCommand } from '../src/cli/simulate.ts'
import type { Daemon, DaemonRun } from '../src/daemon/index.ts'
import type { HarnessAdapter } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { openJournal } from '../src/journal/journal.ts'
import type { EffectExecutor } from '../src/pipeline/effects.ts'
import { isWindows } from '../src/platform/platform.ts'
import { parsePostMortem } from '../src/postmortem/postmortem.ts'
import { fakeCli } from './support/fake-cli.ts'
import { renderGate } from './support/gate-script.ts'

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-cli-'))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

interface Recorder {
  readonly io: Io
  readonly out: string[]
  readonly err: string[]
  readonly asked: string[]
  /** Every line the command emitted, on either stream. */
  all(): string[]
}

/** `answer` is what `confirm` returns; a command that never asks is asserted on too. */
const recorder = (answer = false): Recorder => {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  return {
    out,
    err,
    asked,
    all: () => [...out, ...err],
    io: {
      // Commands print multi-line blocks; splitting keeps one array entry per
      // printed line, which is what the token assertion counts.
      out: (line) => out.push(...line.split('\n')),
      err: (line) => err.push(...line.split('\n')),
      confirm: async (question) => {
        asked.push(question)
        return answer
      },
    },
  }
}

const writeJson = (dir: string, name: string, value: unknown): string => {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  return path
}

/** One agent turn, then done — the cheapest pipeline a projection can run. */
const SOLO = {
  states: [
    {
      id: 'work',
      name: 'Work',
      position: { x: 0, y: 0 },
      onEnter: [{ id: 'e-work', definitionId: 'spawn_agent', params: { role: 'implementer' } }],
    },
    { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
  ],
  transitions: [{ id: 't-done', from: 'work', to: 'done' }],
  initialStateIds: ['work'],
  finalStateIds: ['done'],
}

const workflowJson = (nodes: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  schema_version: 1,
  id: 'cli-fixture',
  base_branch: 'main',
  defaults: { harness: 'claude-code', model: 'opus', pipeline: 'solo' },
  resources: { lane: { capacity: 2, kind: 'worktree' } },
  nodes,
  pipelines: { solo: SOLO },
})

/** `RunDeps.executor`: a host that owns its own lanes and supplies no facts. */
const NO_EFFECTS: EffectExecutor = { execute: async () => ({}) }

const node = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  id,
  name: id,
  prompt_ref: `plan.md#${id}`,
  depends_on: deps.map((dep) => ({ node: dep, artifact: `${dep}'s artifact` })),
})

// ---------------------------------------------------------------------------
// Rig: the doctor's environment
// ---------------------------------------------------------------------------

const MISSING = '/nonexistent/vinta-ai-maestro-cli/not-a-binary'

/**
 * A machine where nothing is wrong. Each test breaks exactly one thing.
 *
 * These are `tests/support/fake-cli.ts`'s fakes rather than shell scripts, so
 * the doctor reaches them through `commandInvocation` the same way it reaches
 * a real npm-installed CLI on either platform. Every one of them is a plain
 * spec: nothing here branches on a subcommand, because the only question with
 * an *answer* is `--version` — `git worktree list` and `docker compose` just
 * have to succeed, which is what the spec's default exit already does.
 */
const healthyBins = (dir: string): DoctorOverrides => ({
  repoPath: dir,
  poolRoot: join(dir, 'pool'),
  summaryDir: join(dir, 'summaries'),
  perLaneBytes: 1,
  bins: {
    git: fakeCli(dir, 'git', { version: 'git version 2.45.2' }),
    // Never actually probed: no workflow here declares a compose-delivered
    // database, so the compose check is "not required by this project" and
    // this binary only has to exist.
    docker: fakeCli(dir, 'docker', {}),
    harness: { 'claude-code': fakeCli(dir, 'claude', { version: '9.9.9 (Claude Code)' }) },
  },
})

// ---------------------------------------------------------------------------
// 1: doctor
// ---------------------------------------------------------------------------

describe('vinta-ai-maestro doctor', () => {
  it('exits zero on a healthy environment and prints the report', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a')]))
    const io = recorder()

    expect(await doctorCommand([path], io.io, healthyBins(dir))).toBe(OK)
    expect(io.out.some((line) => line.includes('A run can start.'))).toBe(true)
    expect(io.out.some((line) => line.includes('FAIL'))).toBe(false)
  })

  it('exits non-zero on a broken environment, and still reports every check', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a')]))
    const base = healthyBins(dir)
    const io = recorder()

    const code = await doctorCommand([path], io.io, {
      ...base,
      bins: { ...base.bins, harness: { 'claude-code': MISSING } },
    })

    expect(code).toBe(FAILED)
    expect(io.out.some((line) => line.includes('FAIL') && line.includes('claude-code'))).toBe(true)
    // The whole point of the command: one broken check does not hide the rest.
    expect(io.out.some((line) => line.includes('PASS') && line.includes('git'))).toBe(true)
    expect(io.out.some((line) => line.includes('A run cannot start'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2 & 3: simulate, and located validation errors
// ---------------------------------------------------------------------------

describe('vinta-ai-maestro simulate', () => {
  it('prints a projection for a valid workflow and exits zero', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a'), node('b', ['a'])]))
    const io = recorder()

    expect(await simulateCommand([path], io.io)).toBe(OK)
    const text = io.out.join('\n')
    expect(text).toContain('Projected wall clock')
    expect(text).toContain('Critical path')
    expect(text).toMatch(/\ba\b/)
    expect(text).toContain('b')
    expect(io.err).toEqual([])
  })

  it('exits non-zero on a cyclic workflow and names the cycle', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'cyclic.json', workflowJson([node('a', ['b']), node('b', ['a'])]))
    const io = recorder()

    expect(await simulateCommand([path], io.io)).toBe(FAILED)
    const text = io.err.join('\n')
    expect(text).toContain('dependency cycle')
    // The cycle itself, not just the word: an operator has to know which nodes.
    expect(text).toMatch(/a → b → a|b → a → b/)
  })

  it('reports located validation errors rather than a stack trace', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'broken.json', workflowJson([node('a'), node('b', ['ghost'])]))
    const io = recorder()

    expect(await simulateCommand([path], io.io)).toBe(FAILED)
    const text = io.err.join('\n')
    expect(text).toContain('nodes[1].depends_on[0].node: unknown node "ghost"')
    // A stack trace would carry frames and absolute module paths; none of that
    // is an operator's business, and some of it is repository content.
    expect(text).not.toMatch(/\n\s+at /)
    expect(text).not.toContain('node_modules')
  })

  it('reports an unreadable or non-JSON file without quoting its contents', async () => {
    const dir = makeTemp()
    const path = join(dir, 'not-json.json')
    writeFileSync(path, '{ "secret-from-the-repo": ', 'utf8')
    const io = recorder()

    expect(await simulateCommand([path], io.io)).toBe(FAILED)
    expect(io.err.join('\n')).toContain('is not valid JSON')
    expect(io.err.join('\n')).not.toContain('secret-from-the-repo')

    const missing = recorder()
    expect(await simulateCommand([join(dir, 'nope.json')], missing.io)).toBe(FAILED)
    expect(missing.err.join('\n')).toContain('cannot read workflow file')
  })
})

// ---------------------------------------------------------------------------
// 4 & 5: serve — the bind, the warning, and the token
// ---------------------------------------------------------------------------

/** Runs `serve`, captures the daemon, and lets it shut down immediately. */
const serve = async (
  argv: readonly string[],
): Promise<{ code: number; io: Recorder; daemon: Daemon }> => {
  const io = recorder()
  let captured: Daemon | null = null
  const code = await serveCommand(argv, io.io, {
    wait: async (daemon) => {
      captured = daemon
    },
  })
  if (captured === null) throw new Error('serve never started a daemon')
  return { code, io, daemon: captured }
}

describe('vinta-ai-maestro serve', () => {
  it('binds loopback by default and prints the URL', async () => {
    const dir = makeTemp()
    const { code, io, daemon } = await serve(['--repo', dir])

    expect(code).toBe(OK)
    expect(daemon.host).toBe('127.0.0.1')
    expect(io.out.some((line) => line.includes(daemon.url))).toBe(true)
    // Loopback is the default, so nothing is warned about.
    expect(io.err).toEqual([])
  })

  it('warns and names the host when --host is given', async () => {
    const dir = makeTemp()
    const { code, io, daemon } = await serve(['--repo', dir, '--host', '0.0.0.0'])

    expect(code).toBe(OK)
    const warning = io.err.join('\n')
    expect(warning).toContain('0.0.0.0')
    expect(warning).toContain('reachable from other machines')
    // The warning is about exposure; leaking the token into it would be the
    // exposure it is warning about.
    expect(warning).not.toContain(daemon.token)
  })

  it('writes the token on exactly one line, and never to a log', async () => {
    const dir = makeTemp()
    const { io, daemon } = await serve(['--repo', dir])

    const carrying = io.all().filter((line) => line.includes(daemon.token))
    expect(carrying).toHaveLength(1)
    // …and that one line is the URL, not prose that happens to quote it.
    expect(carrying[0]?.trim()).toBe(`${daemon.url}/?token=${daemon.token}`)
    // Never on stderr, which is where warnings and anything log-shaped goes.
    expect(io.err.some((line) => line.includes(daemon.token))).toBe(false)
  })

  it('warns on --host without leaking the token there either', async () => {
    const dir = makeTemp()
    const { io, daemon } = await serve(['--repo', dir, '--host', '0.0.0.0'])

    expect(io.all().filter((line) => line.includes(daemon.token))).toHaveLength(1)
  })

  it('rejects a nonsense --port as a usage error', async () => {
    const io = recorder()
    expect(await serveCommand(['--port', 'eighty'], io.io)).toBe(USAGE)
    expect(io.err.join('\n')).toContain('--port must be an integer')
  })
})

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe('vinta-ai-maestro run', () => {
  it('brings the daemon up before executing, and freezes the snapshot', async () => {
    // Every test in this block injects `executor`, which is the seam a host —
    // or a test that is not about the host composition — uses to own its own
    // effect bodies and lanes. The composed run is exercised below, against a
    // real git repository.
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a'), node('b', ['a'])]))
    const io = recorder()
    let daemon: Daemon | null = null

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      executor: NO_EFFECTS,
      runId: 'cli-run',
      onStarted: (started) => {
        daemon = started
      },
    })

    expect(code).toBe(OK)
    expect(daemon).not.toBeNull()
    // The URL is printed before the first node dispatches — §9's whole
    // interaction model depends on being able to open it during the run.
    expect(io.out.findIndex((line) => line.includes('token='))).toBeLessThan(
      io.out.findIndex((line) => line.includes('cli-run completed')),
    )
    // §5.3: the snapshot the run executes, frozen into its own directory.
    expect(existsSync(join(dir, '.vinta-ai-maestro', 'runs', 'cli-run', 'workflow.json'))).toBe(true)
  })

  it('never writes the token more than once here either', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a')]))
    const io = recorder()
    let daemon: Daemon | null = null

    await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      executor: NO_EFFECTS,
      runId: 'token-run',
      onStarted: (started) => {
        daemon = started
      },
    })

    const token = (daemon as unknown as Daemon).token
    expect(io.all().filter((line) => line.includes(token))).toHaveLength(1)
  })

  /**
   * §13.6's artifact, at the path `plan-feature` reads. A post-mortem is true
   * at exactly one moment — after `run_ended` — and this command is the only
   * place that moment is reachable with the journal still open, so a run that
   * ends without writing one leaves the planner nothing to compound on.
   */
  it('writes a post-mortem that validates against its own schema', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a'), node('b', ['a'])]))
    const io = recorder()

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      executor: NO_EFFECTS,
      runId: 'pm-run',
    })

    expect(code).toBe(OK)
    const artifact = join(dir, '.vinta-ai-maestro', 'runs', 'pm-run', 'postmortem.json')
    expect(existsSync(artifact)).toBe(true)

    const parsed = parsePostMortem(JSON.parse(readFileSync(artifact, 'utf8')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.report).toMatchObject({
      schema_version: 1,
      run_id: 'pm-run',
      workflow_id: 'cli-fixture',
      run: { status: 'done', node_count: 2 },
    })
    // Nothing observes dependency use, so the finding stays empty and its gap
    // stays in the file. That is this artifact's whole discipline.
    expect(parsed.report.findings.unused_dependencies).toEqual([])
    expect(parsed.report.gaps.map((gap) => gap.kind)).toContain('dependency_use_unrecorded')
    expect(io.out.some((line) => line.includes('post-mortem written to'))).toBe(true)
  })

  /**
   * Conflicts reach no event — `mergeWave` returns them in process — so the
   * host hands them over or the artifact says "unrecorded". Both readings are
   * pinned here, because an empty `wave_conflicts` means something different
   * under each.
   */
  it('records conflicts from the integrator’s wave results, and their absence as a gap', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a'), node('b')]))
    const io = recorder()

    await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      executor: NO_EFFECTS,
      runId: 'conflict-run',
      waveResults: () => [
        { wave: 1, conflicts: [{ nodes: ['a', 'b'], paths: ['src/models.py'], rounds: 2 }] },
      ],
    })

    const withRecord = parsePostMortem(
      JSON.parse(
        readFileSync(join(dir, '.vinta-ai-maestro', 'runs', 'conflict-run', 'postmortem.json'), 'utf8'),
      ),
    )
    expect(withRecord.ok).toBe(true)
    if (!withRecord.ok) return
    expect(withRecord.report.findings.wave_conflicts).toEqual([
      { wave: 1, nodes: ['a', 'b'], paths: ['src/models.py'], fix_rounds: 2 },
    ])
    expect(withRecord.report.gaps.map((gap) => gap.kind)).not.toContain(
      'integration_record_unavailable',
    )

    // The same run without the record: empty findings, and a gap that says so.
    const bare = makeTemp()
    const barePath = writeJson(bare, 'workflow.json', workflowJson([node('a'), node('b')]))
    await runCommand([barePath, '--repo', bare], recorder().io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      executor: NO_EFFECTS,
      runId: 'bare-run',
    })
    const withoutRecord = parsePostMortem(
      JSON.parse(
        readFileSync(join(bare, '.vinta-ai-maestro', 'runs', 'bare-run', 'postmortem.json'), 'utf8'),
      ),
    )
    expect(withoutRecord.ok).toBe(true)
    if (!withoutRecord.ok) return
    expect(withoutRecord.report.findings.wave_conflicts).toEqual([])
    expect(withoutRecord.report.gaps.map((gap) => gap.kind)).toContain(
      'integration_record_unavailable',
    )
  })
})

// ---------------------------------------------------------------------------
// run, composed: the lane pool, the integrator and the production executor
// ---------------------------------------------------------------------------

/**
 * The assembled command, against a real repository.
 *
 * Everything here runs in a temp git repository created per test — never the
 * checkout the suite runs in — and the only agent is a `MockAdapter`, so no
 * model turn is spent proving that gates ran in lanes that were provisioned.
 */

/** A repository with one commit on `main`, and an identity to commit with. */
const gitRepo = (): string => {
  const dir = makeTemp()
  const git = (...args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir, stdio: 'ignore' })
  }
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'tests@vinta-ai-maestro.invalid')
  git('config', 'user.name', 'vinta-ai-maestro tests')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), 'fixture\n', 'utf8')
  git('add', '--all')
  git('commit', '-m', 'initial')
  return dir
}

/** Branch, one agent turn, the node's gates, then tracking and the wave merge. */
const PHASE = {
  states: [
    {
      id: 'implement',
      name: 'Implement',
      position: { x: 0, y: 0 },
      onEnter: [
        { id: 'e-branch', definitionId: 'git_branch' },
        { id: 'e-implement', definitionId: 'spawn_agent', params: { role: 'implementer' } },
      ],
    },
    {
      id: 'gate',
      name: 'Gate',
      position: { x: 200, y: 0 },
      onEnter: [{ id: 'e-gate', definitionId: 'run_gate' }],
    },
    {
      id: 'integrate',
      name: 'Integrate',
      position: { x: 400, y: 0 },
      onEnter: [
        { id: 'e-tracking', definitionId: 'write_tracking', params: { scope: 'phase' } },
        { id: 'e-merge', definitionId: 'git_merge' },
      ],
    },
    { id: 'done', name: 'Done', position: { x: 600, y: 0 }, data: { outcome: 'done' } },
    { id: 'failed', name: 'Failed', position: { x: 400, y: 200 }, data: { outcome: 'failed' } },
  ],
  transitions: [
    { id: 't-implemented', from: 'implement', to: 'gate' },
    { id: 't-gate-pass', from: 'gate', to: 'integrate', guard: 'gate.exit_code == 0' },
    { id: 't-gate-fail', from: 'gate', to: 'failed', guard: 'gate.exit_code != 0' },
    { id: 't-integrated', from: 'integrate', to: 'done' },
  ],
  initialStateIds: ['implement'],
  finalStateIds: ['done', 'failed'],
}

/** The gate leaves a file behind, which is how a test sees it ran, and where. */
const GATE_MARKER = 'gate-ran.txt'

const assemblyWorkflow = (
  nodes: readonly Record<string, unknown>[],
  laneCapacity = 1,
): Record<string, unknown> => ({
  schema_version: 1,
  id: 'assembly',
  base_branch: 'main',
  defaults: { harness: 'claude-code', model: 'opus', pipeline: 'phase' },
  resources: { lane: { capacity: laneCapacity, kind: 'worktree' } },
  // Declared rather than written as `touch`, which `cmd.exe` does not have.
  // The marker's *content* is never read — only that it exists, and where.
  gates: { unit: { cmd: renderGate({ append: { path: GATE_MARKER, line: 'ran' } }) } },
  nodes: nodes.map((entry) => ({ ...entry, gates: ['unit'] })),
  pipelines: { phase: PHASE },
})

/** A `MockAdapter` that records how much had been printed at the first dispatch. */
const dispatchSpy = (io: Recorder): { adapter: HarnessAdapter; at: () => number } => {
  const mock = new MockAdapter({ id: 'claude-code' })
  let at = -1
  return {
    at: () => at,
    adapter: {
      id: mock.id,
      capabilities: mock.capabilities,
      preflight: () => mock.preflight(),
      spawn: (task) => {
        if (at < 0) at = io.out.length
        return mock.spawn(task)
      },
    },
  }
}

const laneRoot = (dir: string): string => join(dir, '.vinta-ai-maestro', 'lanes')

/**
 * `tests/fixtures/repo/` — the fixture project with a SQLite database and a
 * migrate command — as a real git repo, plus the two gate scripts this file's
 * database test needs.
 *
 * The dependency tree is symlinked rather than installed, which is what lets
 * the fixture's scripts resolve `better-sqlite3`, and what `LanePool` then
 * links on into every lane.
 */
const sqliteRepo = (): string => {
  const dir = makeTemp()
  cpSync(join(HERE, 'fixtures', 'repo'), dir, { recursive: true })
  // A *junction* on Windows, exactly as `LanePool.#linkDeps` does it: a plain
  // directory symlink there needs SeCreateSymbolicLinkPrivilege, so an
  // unelevated run would fail to build the fixture rather than to test it.
  symlinkSync(
    join(HERE, '..', 'node_modules'),
    join(dir, 'node_modules'),
    isWindows() ? 'junction' : undefined,
  )

  const script = (name: string, body: string): void =>
    writeFileSync(join(dir, 'scripts', name), `${body}\n`, 'utf8')

  // The phase that dirties the lane. It fails if its own insert did not take,
  // so the check below cannot pass vacuously.
  script(
    'seed.mjs',
    [
      `import Database from 'better-sqlite3'`,
      `import { writeFileSync } from 'node:fs'`,
      `const db = new Database(process.env.DATABASE_URL)`,
      `db.prepare('INSERT INTO widgets (label) VALUES (?)').run('phase-a')`,
      `const rows = db.prepare('SELECT count(*) FROM widgets').pluck().get()`,
      `db.close()`,
      // Untracked, so only a clean of the worktree removes it.
      `writeFileSync('left-behind.txt', 'phase a')`,
      `if (rows !== 1) process.exit(1)`,
    ].join('\n'),
  )
  // The phase that inherits the lane. The table must exist — the template was
  // migrated — and be empty — the lane was recycled between the two.
  script(
    'check.mjs',
    [
      `import Database from 'better-sqlite3'`,
      `import { existsSync } from 'node:fs'`,
      `const db = new Database(process.env.DATABASE_URL, { readonly: true })`,
      `const rows = db.prepare('SELECT count(*) FROM widgets').pluck().get()`,
      `db.close()`,
      `if (rows !== 0 || existsSync('left-behind.txt')) process.exit(1)`,
    ].join('\n'),
  )

  const git = (...args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir, stdio: 'ignore' })
  }
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'tests@vinta-ai-maestro.invalid')
  git('config', 'user.name', 'vinta-ai-maestro tests')
  git('config', 'commit.gpgsign', 'false')
  git('add', '--all')
  git('commit', '-m', 'initial')
  return dir
}

/**
 * Why each failed node failed, read back out of the run's own journal.
 *
 * Only ever used to *explain* an assertion that is already failing, so it
 * swallows its own errors: a diagnostic that throws replaces the failure it was
 * meant to describe.
 */
function whyNodesFailed(repo: string, runId: string): string {
  try {
    const journal = openJournal(repo)
    try {
      const reasons = journal
        .events(runId)
        .filter((event) => event.type === 'node_status')
        .map((event) => `${'nodeId' in event ? event.nodeId : '?'}: ${JSON.stringify(event.payload)}`)
      return `node statuses:\n${reasons.join('\n')}`
    } finally {
      journal.close()
    }
  } catch (error) {
    return `could not read the journal: ${String(error)}`
  }
}

describe('vinta-ai-maestro run, composed', () => {
  it('provisions lanes, runs gates in them, and reaches done', async () => {
    const dir = gitRepo()
    const path = writeJson(dir, 'workflow.json', assemblyWorkflow([node('a'), node('b', ['a'])], 2))
    const io = recorder()
    const spy = dispatchSpy(io)
    let registered: DaemonRun | null = null

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': spy.adapter },
      runId: 'e2e',
      doctor: healthyBins(dir),
      perLaneBytes: 1,
      onStarted: (_daemon, run) => {
        registered = run
      },
    })

    expect(io.err).toEqual([])
    expect(code).toBe(OK)

    // The pool: one worktree per lane slot, plus the integration worktree (§8).
    expect(existsSync(join(laneRoot(dir), 'e2e-lane-1'))).toBe(true)
    expect(existsSync(join(laneRoot(dir), 'e2e-lane-2'))).toBe(true)
    expect(existsSync(join(laneRoot(dir), 'e2e-integ'))).toBe(true)

    // The gate ran, and it ran in a lane — never in the checkout the operator
    // is sitting in. Which lane is the scheduler's business, not this test's.
    const marked = ['e2e-lane-1', 'e2e-lane-2'].filter((lane) =>
      existsSync(join(laneRoot(dir), lane, GATE_MARKER)),
    )
    expect(marked.length).toBeGreaterThan(0)
    expect(existsSync(join(dir, GATE_MARKER))).toBe(false)

    // Every node settled `done`, which takes the whole pipeline: a branch cut
    // in the lane, a green gate, a tracking commit and a wave merge.
    const report = parsePostMortem(
      JSON.parse(readFileSync(join(dir, '.vinta-ai-maestro', 'runs', 'e2e', 'postmortem.json'), 'utf8')),
    )
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.report.run).toMatchObject({ status: 'done', node_count: 2 })

    // §13.6: the wave results came off the integrator this command built, so
    // an empty `wave_conflicts` means clean rather than unrecorded.
    expect(report.report.gaps.map((gap) => gap.kind)).not.toContain(
      'integration_record_unavailable',
    )
    expect(report.report.findings.wave_conflicts).toEqual([])

    // §9's amend path is reachable: the rebaser is registered on the run.
    expect(typeof (registered as unknown as DaemonRun).amend?.rebase).toBe('function')

    // The URL is printed before the first node dispatches — an operator who
    // could only reach the UI afterwards could not steer anything.
    const url = io.out.findIndex((line) => line.includes('token='))
    expect(url).toBeGreaterThanOrEqual(0)
    expect(url).toBeLessThan(spy.at())

    // Teardown is never automatic (§8): the lanes outlive the run they served.
    expect(existsSync(join(laneRoot(dir), 'e2e-lane-1'))).toBe(true)
    expect(existsSync(join(dir, '.vinta-ai-workflows', 'worktrees', 'e2e-lane-1.yaml'))).toBe(true)
  })

  it('refuses on a failing doctor check, before anything is created', async () => {
    const dir = gitRepo()
    const path = writeJson(dir, 'workflow.json', assemblyWorkflow([node('a')]))
    const bins = healthyBins(dir)
    const io = recorder()

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      runId: 'sick',
      doctor: { ...bins, bins: { ...bins.bins, harness: { 'claude-code': MISSING } } },
      perLaneBytes: 1,
    })

    expect(code).toBe(FAILED)
    // The whole report, so the operator fixes every minute-zero failure at once.
    expect(io.out.some((line) => line.includes('FAIL') && line.includes('claude-code'))).toBe(true)
    expect(io.err.some((line) => line.includes('refusing to start'))).toBe(true)
    // Nothing was created: no lane, no store, not even a journal.
    expect(existsSync(laneRoot(dir))).toBe(false)
    expect(existsSync(join(dir, '.vinta-ai-maestro'))).toBe(false)
  })

  it('refuses on the pool’s disk probe, before a worktree exists', async () => {
    const dir = gitRepo()
    const path = writeJson(dir, 'workflow.json', assemblyWorkflow([node('a')]))
    const io = recorder()

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      runId: 'full',
      // The doctor's probe passes and the pool's does not, which is the case
      // that matters: §8's refusal is the pool's own, not a preflight opinion.
      doctor: healthyBins(dir),
      perLaneBytes: Number.MAX_SAFE_INTEGER,
    })

    expect(code).toBe(FAILED)
    expect(io.err.some((line) => line.includes('refusing to provision'))).toBe(true)
    expect(existsSync(laneRoot(dir))).toBe(false)
  })

  /**
   * §9's amend, against the live run rather than after it: the lanes run one
   * at a time, so while `c` is in flight `a` and `b` are already `done`, and
   * giving `b` a dependency on `a` moves a `done` node's base. That is exactly
   * the amendment `src/amend/` refuses as `rebase_unavailable` when the host
   * registered no integration worktree to rebase in.
   */
  it('rebases a done node’s branch when the live run is amended', async () => {
    const dir = gitRepo()
    const path = writeJson(
      dir,
      'workflow.json',
      assemblyWorkflow([node('a'), node('b'), node('c')]),
    )
    const amended = assemblyWorkflow([node('a'), node('b', ['a']), node('c')])
    const io = recorder()

    const mock = new MockAdapter({ id: 'claude-code' })
    let registered: DaemonRun | null = null
    let result: AmendResult | null = null

    const adapter: HarnessAdapter = {
      id: mock.id,
      capabilities: mock.capabilities,
      preflight: () => mock.preflight(),
      spawn: async (task) => {
        if (task.nodeId === 'c' && result === null) {
          const run = registered as unknown as DaemonRun
          const journal = openJournal(dir)
          try {
            result = await amendRun({
              journal,
              runId: 'amend',
              proposed: amended,
              // Exactly what the daemon builds from a registered run.
              runner: { statuses: () => run.control.statuses, ...run.amend },
            })
          } finally {
            journal.close()
          }
        }
        return await mock.spawn(task)
      },
    }

    expect(
      await runCommand([path, '--repo', dir], io.io, {
        adapters: { 'claude-code': adapter },
        runId: 'amend',
        doctor: healthyBins(dir),
        perLaneBytes: 1,
        onStarted: (_daemon, run) => {
          registered = run
        },
      }),
    ).toBe(OK)

    expect(typeof (registered as unknown as DaemonRun).amend?.rebase).toBe('function')
    const outcome = result as unknown as AmendResult
    expect(outcome).not.toBeNull()
    expect(outcome.ok ? undefined : outcome.code).not.toBe('rebase_unavailable')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.rebased).toEqual(['b'])
  })

  /**
   * §8 end to end, through the one path that can switch it on: a workflow's
   * `project` block.
   *
   * Two phases, one lane, one forked SQLite database. `a` writes a row; `b`'s
   * gate refuses unless it finds a table (so the template was migrated) with
   * nothing in it (so the lane was recycled between the phases rather than
   * handed on with the previous phase's data).
   */
  it('forks a database per lane and hands the next phase a clean one', async () => {
    const dir = sqliteRepo()
    const path = writeJson(dir, 'workflow.json', {
      ...assemblyWorkflow([node('a'), node('b', ['a'])]),
      project: {
        migrate_cmd: 'node scripts/migrate.mjs',
        databases: {
          dev: { engine: 'sqlite', path: 'db.sqlite3', connection_url_var: 'DATABASE_URL' },
        },
      },
      gates: {
        seed: { cmd: 'node scripts/seed.mjs' },
        check: { cmd: 'node scripts/check.mjs' },
      },
      nodes: [
        { ...node('a'), gates: ['seed'] },
        { ...node('b', ['a']), gates: ['check'] },
      ],
    })
    const io = recorder()

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      runId: 'db',
      doctor: healthyBins(dir),
      perLaneBytes: 1,
    })

    expect(io.err).toEqual([])
    expect(code).toBe(OK)

    // One lane, so `b` ran where `a` had: the gate that passed is the
    // assertion that it arrived migrated and empty.
    const lane = join(laneRoot(dir), 'db-lane-1')
    expect(existsSync(join(lane, 'db.sqlite3'))).toBe(true)
    // The fork is the lane's own file, never the main checkout's.
    expect(existsSync(join(dir, 'db.sqlite3'))).toBe(false)

    // Both gates passed, which is the whole assertion: `seed` refuses unless
    // its insert took, and `check` refuses unless the row is gone again.
    const gates = openJournal(dir)
    try {
      const results = gates
        .events('db')
        .filter((event) => event.type === 'gate_result')
        .map((event) => event.payload)
      expect(results).toEqual([
        { gate: 'seed', exit_code: 0, status: 'passed' },
        { gate: 'check', exit_code: 0, status: 'passed' },
      ])
    } finally {
      gates.close()
    }
  })

  /**
   * §8's other half: a compose-delivered database has no template to clone
   * from and therefore no reset, so its lane is single-use. The run must still
   * finish — the pool re-provisions the slot rather than resetting it.
   */
  it('re-provisions a lane whose databases cannot be reset, and still completes', async () => {
    const dir = gitRepo()
    const path = writeJson(dir, 'workflow.json', {
      ...assemblyWorkflow([node('a'), node('b', ['a'])]),
      project: {
        migrate_cmd: 'true',
        databases: {
          dev: {
            engine: 'postgres',
            delivery: 'compose',
            name: 'app',
            server_url: 'postgres://localhost:5432',
            connection_url_var: 'DATABASE_URL',
          },
        },
      },
    })
    const io = recorder()

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      runId: 'single',
      doctor: healthyBins(dir),
      perLaneBytes: 1,
    })

    // The reason, not just the fact. `failed nodes: b` is all stderr carries —
    // the *why* is a `node_status` payload in the journal, and without it a
    // failure here is a CI round spent learning nothing.
    expect(io.err, whyNodesFailed(dir, 'single')).toEqual([])
    expect(code).toBe(OK)

    // The slot was torn down and rebuilt between the phases, and what it left
    // is a lane like any other: one worktree, its summary rewritten.
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
    expect(worktrees).toHaveLength(3)
    expect(existsSync(join(laneRoot(dir), 'single-lane-1'))).toBe(true)
    expect(existsSync(join(dir, '.vinta-ai-workflows', 'worktrees', 'single-lane-1.yaml'))).toBe(
      true,
    )
  })

  it('provisions no database at all for a workflow with no project block', async () => {
    const dir = sqliteRepo()
    const path = writeJson(dir, 'workflow.json', assemblyWorkflow([node('a')]))
    const io = recorder()

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      runId: 'plain',
      doctor: healthyBins(dir),
      perLaneBytes: 1,
    })

    expect(code).toBe(OK)
    // A lane is a worktree and nothing else: no template was built, no fork
    // was cloned, and no connection variable was invented.
    expect(readdirSync(join(laneRoot(dir), '.templates'))).toEqual([])
    expect(existsSync(join(laneRoot(dir), 'plain-lane-1', 'db.sqlite3'))).toBe(false)
  })

  /**
   * The two halves of the product, on one file.
   *
   * `plan-feature` writes `ai-plans/<id>.workflow.json`, a person opens the
   * editor and approves it, and the orchestrator starts from it. That flow is
   * only real if `serve` lists the very file `run` executes — no copy, no
   * relocation, and no flag on either command saying where to look.
   */
  it('lists in the editor exactly the file run executes, unmoved', async () => {
    const dir = makeTemp()
    mkdirSync(join(dir, 'ai-plans'), { recursive: true })
    const path = writeJson(
      dir,
      join('ai-plans', 'cli-fixture.workflow.json'),
      workflowJson([node('a')]),
    )

    // The editor's half: `serve --repo <dir>`, told nothing else, lists it.
    let listed: unknown
    let opened: unknown
    await serveCommand(['--repo', dir], recorder().io, {
      wait: async (daemon) => {
        const headers = { authorization: `Bearer ${daemon.token}` }
        listed = await (await fetch(`${daemon.url}/api/workflows`, { headers })).json()
        opened = await (
          await fetch(`${daemon.url}/api/workflows/cli-fixture`, { headers })
        ).json()
      },
    })
    expect(listed).toEqual({ workflows: [{ id: 'cli-fixture' }] })
    expect((opened as { id: string }).id).toBe('cli-fixture')

    // `run`'s half: the same path, executed without moving anything.
    const code = await runCommand([path, '--repo', dir], recorder().io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      executor: NO_EFFECTS,
      runId: 'agreed-run',
    })
    expect(code).toBe(OK)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(dir, '.vinta-ai-maestro', 'runs', 'agreed-run', 'workflow.json'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6: purge
// ---------------------------------------------------------------------------

/** A store with two run directories, each holding a transcript. */
const storeWithRuns = (...runIds: readonly string[]): string => {
  const dir = makeTemp()
  for (const runId of runIds) {
    const nodeDir = join(dir, '.vinta-ai-maestro', 'runs', runId, 'nodes', 'p1')
    mkdirSync(nodeDir, { recursive: true })
    writeFileSync(join(nodeDir, 'transcript.jsonl'), '{"type":"session_started"}\n', 'utf8')
  }
  return dir
}

const runDir = (repo: string, runId: string): string =>
  join(repo, '.vinta-ai-maestro', 'runs', runId)

/** A run's store directory as `purge` prints it: relative, native separators. */
const runPath = (runId: string): string => join('.vinta-ai-maestro', 'runs', runId)

describe('vinta-ai-maestro purge', () => {
  it('--dry-run lists every target and deletes nothing', async () => {
    const dir = storeWithRuns('run-a', 'run-b')
    const io = recorder()

    expect(await purgeCommand(['--repo', dir, '--dry-run'], io.io)).toBe(OK)
    const text = io.out.join('\n')
    // Built with the platform's own separator, because the line this checks is
    // one a human reads on their own machine before confirming a deletion.
    // `purge` prints `relative()` output deliberately — a Windows operator
    // shown a posix path might not recognise it, and could paste it somewhere
    // that does not resolve. Unlike a git path (see `tracking.ts`) there is no
    // second consumer here with an opinion about separators.
    expect(text).toContain(runPath('run-a'))
    expect(text).toContain(runPath('run-b'))
    expect(text).toContain('nothing was deleted')
    // Not asked, because nothing was going to happen.
    expect(io.asked).toEqual([])
    expect(existsSync(runDir(dir, 'run-a'))).toBe(true)
    expect(existsSync(runDir(dir, 'run-b'))).toBe(true)
  })

  it('--yes deletes without asking', async () => {
    const dir = storeWithRuns('run-a', 'run-b')
    const io = recorder()

    expect(await purgeCommand(['--repo', dir, '--yes'], io.io)).toBe(OK)
    expect(io.asked).toEqual([])
    expect(existsSync(runDir(dir, 'run-a'))).toBe(false)
    expect(existsSync(runDir(dir, 'run-b'))).toBe(false)
  })

  it('deletes only the named run', async () => {
    const dir = storeWithRuns('run-a', 'run-b')
    const io = recorder()

    expect(await purgeCommand(['run-a', '--repo', dir, '--yes'], io.io)).toBe(OK)
    expect(existsSync(runDir(dir, 'run-a'))).toBe(false)
    expect(existsSync(runDir(dir, 'run-b'))).toBe(true)
  })

  it('asks before deleting, and a refusal deletes nothing', async () => {
    const dir = storeWithRuns('run-a')
    const refused = recorder(false)

    expect(await purgeCommand(['--repo', dir], refused.io)).toBe(FAILED)
    expect(refused.asked).toHaveLength(1)
    expect(refused.out.join('\n')).toContain(runPath('run-a'))
    expect(existsSync(runDir(dir, 'run-a'))).toBe(true)

    const accepted = recorder(true)
    expect(await purgeCommand(['--repo', dir], accepted.io)).toBe(OK)
    expect(accepted.asked).toHaveLength(1)
    expect(existsSync(runDir(dir, 'run-a'))).toBe(false)
  })

  it.each([
    '../../something',
    '..',
    '../runs',
    'a/../../b',
    '/etc',
    'nested/run',
  ])('refuses a run id that escapes .vinta-ai-maestro/ (%s)', async (escape) => {
    const dir = storeWithRuns('run-a')
    // A sibling of the store, which a successful traversal would reach.
    const outside = join(dir, 'keep-me')
    mkdirSync(outside, { recursive: true })
    const io = recorder(true)

    expect(await purgeCommand([escape, '--repo', dir, '--yes'], io.io)).toBe(FAILED)
    expect(io.err.join('\n')).toContain('refusing')
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(runDir(dir, 'run-a'))).toBe(true)
    expect(existsSync(join(dir, '.vinta-ai-maestro'))).toBe(true)
  })

  it('says so, and succeeds, when there is nothing to purge', async () => {
    const io = recorder()
    expect(await purgeCommand(['--repo', makeTemp(), '--yes'], io.io)).toBe(OK)
    expect(io.out.join('\n')).toContain('no run state to purge')

    const named = recorder()
    expect(await purgeCommand(['ghost', '--repo', makeTemp(), '--yes'], named.io)).toBe(OK)
    expect(named.out.join('\n')).toContain('no run state for "ghost"')
  })
})

// ---------------------------------------------------------------------------
// 7: dispatch
// ---------------------------------------------------------------------------

describe('vinta-ai-maestro dispatch', () => {
  it('prints help and exits zero for --help', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const io = recorder()
      expect(await main([flag], io.io)).toBe(OK)
      expect(io.out.join('\n')).toContain('usage: vinta-ai-maestro <command>')
      expect(io.err).toEqual([])
    }
  })

  it('answers a subcommand --help with that subcommand’s options, and exits zero', async () => {
    const io = recorder()
    expect(await main(['purge', '--help'], io.io)).toBe(OK)
    expect(io.out.join('\n')).toContain('usage: vinta-ai-maestro purge')
    expect(io.out.join('\n')).toContain('--dry-run')
  })

  it('exits 2 on an unknown subcommand, naming it, with help on stderr', async () => {
    const io = recorder()
    expect(await main(['simluate', 'x.json'], io.io)).toBe(USAGE)
    expect(io.err.join('\n')).toContain('unknown command "simluate"')
    expect(io.err.join('\n')).toContain('usage: vinta-ai-maestro <command>')
    expect(io.out).toEqual([])
  })

  it('exits 2 when no command is given', async () => {
    const io = recorder()
    expect(await main([], io.io)).toBe(USAGE)
    expect(io.out).toEqual([])
  })

  it('exits 2 when a command that needs a workflow is given none', async () => {
    for (const command of ['doctor', 'simulate', 'run']) {
      const io = recorder()
      expect(await main([command], io.io)).toBe(USAGE)
      expect(io.err.join('\n')).toContain(`usage: vinta-ai-maestro ${command}`)
    }
  })

  it('exits 2 on an unknown flag rather than ignoring it', async () => {
    const io = recorder()
    expect(await main(['simulate', 'x.json', '--fast'], io.io)).toBe(USAGE)
    expect(io.err.join('\n')).toContain('usage: vinta-ai-maestro simulate')
  })
})
