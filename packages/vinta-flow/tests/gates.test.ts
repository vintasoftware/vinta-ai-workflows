import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGate } from '../src/gates/runner.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import type { Gate } from '../src/types.ts'
import { renderGate, type GateScript } from './support/gate-script.ts'

/**
 * A gate whose command is declared rather than written in one shell's syntax.
 *
 * These lines are run through `shellInvocation`, so they must stay shell — but
 * they must not stay `sh`, which is what kept this whole suite skipped on
 * Windows. `renderGate` spells each step for the platform actually running it.
 */
const gate = (script: GateScript, overrides: Partial<Gate> = {}): Gate => ({
  cmd: renderGate(script),
  requires: ['test-suite'],
  timeout_s: 30,
  ...overrides,
})

/** Every gate here runs in a throwaway temp dir; nothing touches the repo. */
let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'vinta-flow-gates-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const newPools = (): ResourcePools =>
  new ResourcePools({ 'test-suite': { capacity: 1, kind: 'semaphore' } }, { agingMs: 0 })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** True once the pid is gone. Reaping is asynchronous, so this is polled. */
async function awaitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await sleep(25)
  }
  return false
}

describe('gate runner', () => {
  it('runs a command, captures combined output, and reports the exit code', async () => {
    const pools = newPools()
    const logPath = join(workspace, 'lint.log')

    const result = await runGate({
      gateId: 'lint',
      gate: gate({
        stdout: ['out-line'],
        stderr: ['err-line'],
        echoEnv: ['GATE_MARKER'],
        printCwd: true,
      }),
      cwd: workspace,
      env: { GATE_MARKER: 'from-env' },
      logPath,
      pools,
    })

    expect(result.status).toBe('passed')
    expect(result.exitCode).toBe(0)
    expect(result.gateId).toBe('lint')

    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('out-line')
    expect(log).toContain('err-line')
    expect(log).toContain('from-env')
    // Ran in the directory it was handed, not in the daemon's cwd. Compared by
    // basename because macOS resolves the temp dir through a symlink.
    expect(log).toContain(basename(workspace))

    expect(pools.held('test-suite')).toBe(0)
  })

  it('kills the process tree on timeout, reports timed_out, and releases its pools', async () => {
    const pools = newPools()
    const pidFile = join(workspace, 'grandchild.pid')

    const result = await runGate({
      gateId: 'slow-suite',
      // The shell backgrounds a grandchild, so killing only the shell would
      // leave it orphaned. Killing the tree must reach it. The grandchild is
      // `node` on both platforms — `$!` has no `cmd.exe` counterpart, and what
      // this asserts is about the process tree rather than the syntax.
      gate: gate({ background: { seconds: 60, pidFile } }, { timeout_s: 1 }),
      cwd: workspace,
      env: {},
      logPath: join(workspace, 'slow-suite.log'),
      pools,
    })

    expect(result.status).toBe('timed_out')
    expect(result.exitCode).toBeNull()
    expect(result.durationMs).toBeLessThan(10_000)
    expect(pools.held('test-suite')).toBe(0)

    const grandchild = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
    expect(Number.isInteger(grandchild)).toBe(true)
    expect(await awaitGone(grandchild, 5_000)).toBe(true)
  }, 20_000)

  it('releases its pools when the command fails', async () => {
    const pools = newPools()

    const result = await runGate({
      gateId: 'failing',
      gate: gate({ stderr: ['nope'], exit: 3 }),
      cwd: workspace,
      env: {},
      logPath: join(workspace, 'failing.log'),
      pools,
    })

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(3)
    expect(pools.held('test-suite')).toBe(0)

    // The slot is genuinely back: a second gate can take it.
    const next = await runGate({
      gateId: 'after',
      gate: gate({}),
      cwd: workspace,
      env: {},
      logPath: join(workspace, 'after.log'),
      pools,
    })
    expect(next.status).toBe('passed')
    expect(pools.held('test-suite')).toBe(0)
  })

  it('queues behind a full pool rather than running concurrently', async () => {
    const pools = newPools()
    const blocker = await pools.acquire(['test-suite'])

    let settled = false
    const queued = runGate({
      gateId: 'queued',
      gate: gate({}),
      cwd: workspace,
      env: {},
      logPath: join(workspace, 'queued.log'),
      pools,
    }).then((result) => {
      settled = true
      return result
    })

    await sleep(50)
    expect(settled).toBe(false)

    blocker.release()
    expect((await queued).status).toBe('passed')
    expect(pools.held('test-suite')).toBe(0)
  })
})
