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
import { availableParallelism, loadavg } from 'node:os'
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
  /** Present only on `timed_out`. See `TimeoutFacts`. */
  readonly timeout?: TimeoutFacts
}

/**
 * What the runner could see at the moment it killed a gate — the evidence
 * that tells a gate that *hung* from one that was *slow*, which the timeout by
 * itself cannot. Numbers about the process and the host, never anything the
 * gate printed (§11).
 *
 * - `quietMs` is how long the gate had gone without writing a byte. Near the
 *   full timeout is a gate waiting on something (a lock, a port, a prompt
 *   nobody will answer); small is a gate still working when time ran out.
 * - `outputBytes` separates "silent from the first second" from "went quiet".
 * - `load1m` over `cpus` is the host's run queue per core when the kill fired.
 *   Well above 1 beside a small `quietMs` is contention, not a broken suite.
 *   Absent where the platform reports no load average (Windows reports zeros).
 */
export interface TimeoutFacts {
  readonly quietMs: number
  readonly outputBytes: number
  readonly load1m?: number
  readonly cpus: number
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
  /**
   * Called once the gate is actually starting, with the same clock reading
   * `durationMs` is measured from.
   *
   * It exists so a caller can journal a *start* whose distance from the
   * result is the gate's own runtime and nothing else. Emitting that event
   * from the call site instead would fold in the pool wait — `runGate` and
   * `runGateCached` both block on `acquire` first — and a gate reported as
   * having taken nine minutes when it ran for forty seconds behind a busy
   * `test-suite` is a measurement that points at the wrong problem. A cache
   * hit never reaches the runner, so it never fires: nothing ran.
   */
  readonly onStart?: (startedAtMs: number) => void
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
  options.onStart?.(startedAt)
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

  // Counted, never kept: only the size and the time of the last write.
  let outputBytes = 0
  let lastOutputAt = startedAt
  const heard = (chunk: Buffer | string): void => {
    outputBytes += chunk.length
    lastOutputAt = Date.now()
  }
  child.stdout?.on('data', heard)
  child.stderr?.on('data', heard)

  let timeout: TimeoutFacts | undefined
  const timer = setTimeout(() => {
    // Read before the kill: once the tree is gone, the load it was causing is too.
    timeout = timeoutFacts(Date.now() - lastOutputAt, outputBytes)
    killTree(child.pid)
  }, options.gate.timeout_s * 1000)

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', resolve)
  })
  clearTimeout(timer)
  await new Promise<void>((resolve) => log.end(resolve))

  return {
    gateId: options.gateId,
    status: timeout !== undefined ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed',
    exitCode: timeout !== undefined ? null : exitCode,
    durationMs: Date.now() - startedAt,
    logPath: options.logPath,
    ...(timeout === undefined ? {} : { timeout }),
  }
}

function timeoutFacts(quietMs: number, outputBytes: number): TimeoutFacts {
  const [load1m] = loadavg()
  const reported = load1m !== undefined && load1m > 0
  return {
    quietMs,
    outputBytes,
    ...(reported ? { load1m: Math.round(load1m * 100) / 100 } : {}),
    cpus: availableParallelism(),
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
