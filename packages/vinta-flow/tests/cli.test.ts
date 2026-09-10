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
 * doctor's binaries are shell scripts written into a temp directory, the
 * workflows are written per test, and every `.vinta-flow/` store is a temp
 * directory that is removed afterwards — including the ones the purge tests
 * try, and fail, to escape.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { doctorCommand, type DoctorOverrides } from '../src/cli/doctor.ts'
import { FAILED, OK, USAGE, type Io } from '../src/cli/io.ts'
import { main } from '../src/cli/index.ts'
import { purgeCommand } from '../src/cli/purge.ts'
import { runCommand } from '../src/cli/run.ts'
import { serveCommand } from '../src/cli/serve.ts'
import { simulateCommand } from '../src/cli/simulate.ts'
import type { Daemon } from '../src/daemon/index.ts'
import { MockAdapter } from '../src/harness/mock.ts'

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-cli-'))
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

const node = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  id,
  name: id,
  prompt_ref: `plan.md#${id}`,
  depends_on: deps.map((dep) => ({ node: dep, artifact: `${dep}'s artifact` })),
})

// ---------------------------------------------------------------------------
// Rig: the doctor's environment
// ---------------------------------------------------------------------------

const fakeBin = (dir: string, name: string, body: string): string => {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

const MISSING = '/nonexistent/vinta-flow-cli/not-a-binary'

/** A machine where nothing is wrong. Each test breaks exactly one thing. */
const healthyBins = (dir: string): DoctorOverrides => ({
  repoPath: dir,
  poolRoot: join(dir, 'pool'),
  summaryDir: join(dir, 'summaries'),
  perLaneBytes: 1,
  bins: {
    git: fakeBin(
      dir,
      'git',
      [
        'if [ "$1" = "--version" ]; then echo "git version 2.45.2"; exit 0; fi',
        'exit 0',
      ].join('\n'),
    ),
    docker: fakeBin(dir, 'docker', 'exit 0'),
    harness: {
      'claude-code': fakeBin(
        dir,
        'claude',
        'if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi\nexit 0',
      ),
    },
  },
})

// ---------------------------------------------------------------------------
// 1: doctor
// ---------------------------------------------------------------------------

describe('vinta-flow doctor', () => {
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

describe('vinta-flow simulate', () => {
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

describe('vinta-flow serve', () => {
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

describe('vinta-flow run', () => {
  it('brings the daemon up before executing, and freezes the snapshot', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a'), node('b', ['a'])]))
    const io = recorder()
    let daemon: Daemon | null = null

    const code = await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
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
    expect(existsSync(join(dir, '.vinta-flow', 'runs', 'cli-run', 'workflow.json'))).toBe(true)
  })

  it('never writes the token more than once here either', async () => {
    const dir = makeTemp()
    const path = writeJson(dir, 'workflow.json', workflowJson([node('a')]))
    const io = recorder()
    let daemon: Daemon | null = null

    await runCommand([path, '--repo', dir], io.io, {
      adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
      runId: 'token-run',
      onStarted: (started) => {
        daemon = started
      },
    })

    const token = (daemon as unknown as Daemon).token
    expect(io.all().filter((line) => line.includes(token))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 6: purge
// ---------------------------------------------------------------------------

/** A store with two run directories, each holding a transcript. */
const storeWithRuns = (...runIds: readonly string[]): string => {
  const dir = makeTemp()
  for (const runId of runIds) {
    const nodeDir = join(dir, '.vinta-flow', 'runs', runId, 'nodes', 'p1')
    mkdirSync(nodeDir, { recursive: true })
    writeFileSync(join(nodeDir, 'transcript.jsonl'), '{"type":"session_started"}\n', 'utf8')
  }
  return dir
}

const runDir = (repo: string, runId: string): string =>
  join(repo, '.vinta-flow', 'runs', runId)

describe('vinta-flow purge', () => {
  it('--dry-run lists every target and deletes nothing', async () => {
    const dir = storeWithRuns('run-a', 'run-b')
    const io = recorder()

    expect(await purgeCommand(['--repo', dir, '--dry-run'], io.io)).toBe(OK)
    const text = io.out.join('\n')
    expect(text).toContain('.vinta-flow/runs/run-a')
    expect(text).toContain('.vinta-flow/runs/run-b')
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
    expect(refused.out.join('\n')).toContain('.vinta-flow/runs/run-a')
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
  ])('refuses a run id that escapes .vinta-flow/ (%s)', async (escape) => {
    const dir = storeWithRuns('run-a')
    // A sibling of the store, which a successful traversal would reach.
    const outside = join(dir, 'keep-me')
    mkdirSync(outside, { recursive: true })
    const io = recorder(true)

    expect(await purgeCommand([escape, '--repo', dir, '--yes'], io.io)).toBe(FAILED)
    expect(io.err.join('\n')).toContain('refusing')
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(runDir(dir, 'run-a'))).toBe(true)
    expect(existsSync(join(dir, '.vinta-flow'))).toBe(true)
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

describe('vinta-flow dispatch', () => {
  it('prints help and exits zero for --help', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const io = recorder()
      expect(await main([flag], io.io)).toBe(OK)
      expect(io.out.join('\n')).toContain('usage: vinta-flow <command>')
      expect(io.err).toEqual([])
    }
  })

  it('answers a subcommand --help with that subcommand’s options, and exits zero', async () => {
    const io = recorder()
    expect(await main(['purge', '--help'], io.io)).toBe(OK)
    expect(io.out.join('\n')).toContain('usage: vinta-flow purge')
    expect(io.out.join('\n')).toContain('--dry-run')
  })

  it('exits 2 on an unknown subcommand, naming it, with help on stderr', async () => {
    const io = recorder()
    expect(await main(['simluate', 'x.json'], io.io)).toBe(USAGE)
    expect(io.err.join('\n')).toContain('unknown command "simluate"')
    expect(io.err.join('\n')).toContain('usage: vinta-flow <command>')
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
      expect(io.err.join('\n')).toContain(`usage: vinta-flow ${command}`)
    }
  })

  it('exits 2 on an unknown flag rather than ignoring it', async () => {
    const io = recorder()
    expect(await main(['simulate', 'x.json', '--fast'], io.io)).toBe(USAGE)
    expect(io.err.join('\n')).toContain('usage: vinta-flow simulate')
  })
})
