/**
 * The gate runner. A gate is a declarative `{cmd, requires, timeout_s}` — not
 * an agent, no LLM involved — which is exactly why it can sit in a capacity
 * queue without burning a model turn.
 *
 * It takes the working directory and the environment as data. Provisioning
 * lanes and forking databases belongs to `src/lanes/**`; keeping that seam
 * means a gate can be run against any directory, including a temp one in a
 * test, without a worktree pool existing.
 *
 * Two things it must get right. The child leads its own process group where the
 * platform has them, so a timeout can signal the whole tree — a gate is usually
 * a shell line that starts a test runner that starts workers, and killing only
 * the shell orphans all of it. *Which* shell, and how a tree is reached, are
 * `src/platform/platform.ts`'s answers rather than this module's — a gate is
 * project text, and it must be run by the shell the project's own scripts
 * already assume. And the pools it acquired are
 * released in a `finally`, so a timeout, a non-zero exit and a throw all leave
 * the pools exactly as wide as they were.
 *
 * Gate output goes to the log file and nowhere else. It is repository content
 * verbatim, so it never reaches a result field or an error message.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  killTree as killPlatformTree,
  ownProcessGroup,
  shellInvocation,
  spawnOptionsFor,
} from '../platform/platform.ts'
import type { ResourcePools } from '../resources/pools.ts'
import type { Gate } from '../types.ts'

export type GateStatus = 'passed' | 'failed' | 'timed_out'

/**
 * The exit code a timed-out gate reports. `GateResult.exitCode` is null there —
 * the gate never got to say anything — and a guard reading `gate.exit_code`
 * needs a number that is not zero. 124 is `timeout(1)`'s.
 *
 * It lives here rather than beside either caller because both of them turn a
 * `GateResult` into an exit code, and two copies of a stand-in value is one
 * copy too many for a number a guard compares against.
 */
export const TIMEOUT_EXIT = 124

export interface GateResult {
  readonly gateId: string
  /** `timed_out` is distinct from `failed`: the gate never got to say anything. */
  readonly status: GateStatus
  /** null when the gate was killed rather than exiting on its own. */
  readonly exitCode: number | null
  readonly durationMs: number
  readonly logPath: string
}

export interface RunGateOptions {
  readonly gateId: string
  readonly gate: Gate
  /** The lane checkout, or any directory. The runner does not create it. */
  readonly cwd: string
  /** Overlaid on the daemon's own environment. */
  readonly env: Readonly<Record<string, string>>
  /** Supplied by the caller — the journal's `gateLogPath`. */
  readonly logPath: string
  readonly pools: ResourcePools
}

/**
 * Acquires the gate's pools, runs it, releases them. The standalone entry
 * point — use it when nothing else already holds those pools.
 */
export async function runGate(options: RunGateOptions): Promise<GateResult> {
  const lease = await options.pools.acquire(options.gate.requires)
  try {
    return await executeGate(options)
  } finally {
    lease.release()
  }
}

/**
 * Runs the gate **without acquiring anything** — for a caller that already
 * holds its pools.
 *
 * The scheduler is that caller: it takes the gate's pools around the whole
 * `run_gate` effect, because that is what makes "release gate resources at
 * `await_human`" implementable at all (§6, §9.1). Such a caller must NOT go
 * through `runGate`, which would acquire the same pools a second time and
 * self-deadlock the moment any of them has capacity 1.
 *
 * Taking no `pools` is the point: the type makes the mistake unwritable
 * rather than documented.
 */
export async function executeGate(options: Omit<RunGateOptions, 'pools'>): Promise<GateResult> {
  const startedAt = Date.now()
  const log = createWriteStream(options.logPath)

  const shell = shellInvocation(options.gate.cmd)
  const child = spawn(shell.file, [...shell.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: ownProcessGroup(),
    ...spawnOptionsFor(shell),
  })
  // Combined output, in arrival order. `end: false` because the log is closed
  // once, after the child is gone, rather than by whichever pipe drains first.
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, options.gate.timeout_s * 1000)

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', resolve)
  })
  clearTimeout(timer)
  await new Promise<void>((resolve) => log.end(resolve))

  return {
    gateId: options.gateId,
    status: timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed',
    exitCode: timedOut ? null : exitCode,
    durationMs: Date.now() - startedAt,
    logPath: options.logPath,
  }
}

/**
 * Ends the gate *and* whatever it spawned. On POSIX that is one signal to the
 * process group the shell leads; on Windows there are no groups, so the
 * platform seam walks the process table instead. A gate that exited between the
 * timer firing and this call is not an error either way.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  killPlatformTree(pid, 'SIGKILL')
}
