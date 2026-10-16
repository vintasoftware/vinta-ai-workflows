/**
 * A command run by hand inside a live run's worktree: `vinta-ai-maestro exec
 * <run> <lane|integration> -- <cmd>`.
 *
 * It exists because the obvious alternative is wrong in a way that looks
 * right. A shell in the main checkout can `cd` into a lane, but it does not
 * have the lane's environment — the forked database, the compose project, the
 * published ports — so a test run from there talks to the wrong database and
 * reports something about the person running it rather than about the lane.
 * One monitor reported "the final gate fails on a port conflict" when no gate
 * had run at all. The job holds each worktree's environment; this runs the
 * command there, in the job, and streams what it prints back.
 *
 * In the integration worktree the command also holds the worktree's queue for
 * as long as it runs, so no wave merge, base preparation or unattended retry
 * checks a branch out underneath it. That is the race an operator hit
 * repairing a wave by hand while a timer-driven retry swapped files under
 * their test run.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { killTree, ownProcessGroup, shellInvocation, spawnOptionsFor } from '../platform/platform.ts'
import { MAESTRO_NODE_ENV, MAESTRO_TURN_ENV } from '../resources/agent-leases.ts'
import type { Actor } from './actor.ts'

/** Where `exec` may run. */
export interface Workspace {
  readonly path: string
  readonly env: Readonly<Record<string, string>>
}

export interface ExecRequest {
  /** A lane name, or `integration`. */
  readonly target: string
  readonly command: string
  readonly actor: Actor
}

/** What a run offers `exec` (`DaemonRun.exec`). */
export interface ExecPort {
  /** The target a typed name means, or null when the run has none — asked before the answer streams. */
  resolve(target: string): string | null
  /** Every target, as a refusal lists them. */
  targets(): readonly string[]
  /** Whether a running command holds as `holder` — what lets `with` inside `exec` take a lease. */
  holds(holder: string): boolean
  /**
   * Runs the request and resolves with its exit code, or null for a target
   * the run does not have. `onOutput` receives stdout and stderr, combined,
   * in arrival order. Aborting `signal` ends the command's process tree.
   */
  run(request: ExecRequest, onOutput: (chunk: string) => void, signal: AbortSignal): Promise<number | null>
}

export interface ExecPortOptions {
  /** The worktree a resolved target names. */
  readonly workspace: (target: string) => Workspace | null
  readonly holdIntegration?: <T>(label: string, work: () => Promise<T>) => Promise<T>
  /** What a typed name means (`resolveExecTarget`). Absent, the name is the target. */
  readonly resolve?: (target: string) => string | null
  readonly targets?: () => readonly string[]
  /** The phase running in a lane: a command there takes leases and runs gates as it. */
  readonly holder?: (target: string) => string | null
  /** A command's leases and queued waits end with it, as an agent turn's do. */
  readonly onEnded?: (holder: string, turn: string) => void
}

/** The exit code a command killed from outside reports. */
export const EXEC_KILLED = 137

/** The holder a command on a target no phase is running in leases as. */
export const execHolder = (target: string): string => `exec:${target}`

/**
 * The target a typed name means: `integration`, a lane's full name, its name
 * without the `<run-id>-` prefix every lane carries, or the id of the phase
 * running in it. Only the full name used to work, and the refusal did not say
 * so — an operator typing the name `status` shows them, or the phase they were
 * looking at, was told `unknown_target`.
 */
export function resolveExecTarget(
  target: string,
  run: {
    readonly runId: string
    readonly lanes: readonly string[]
    readonly phaseLanes: ReadonlyMap<string, string>
  },
): string | null {
  if (target === 'integration' || run.lanes.includes(target)) return target
  const prefixed = `${run.runId}-${target}`
  if (run.lanes.includes(prefixed)) return prefixed
  const lane = run.phaseLanes.get(target)
  return lane !== undefined && run.lanes.includes(lane) ? lane : null
}

/**
 * `with` and `gate` inside `exec` need what an agent's shell has: the run's
 * address and token, which the workspace's environment carries, and a holder
 * and turn of their own, which it did not — "no live run is available" while
 * the run was live. The holder is the phase running in the lane, so a gate
 * runs as that phase's, or the command itself on a lane nobody is in; the
 * turn is the command's, so its leases and waits end when it does.
 */
export function execPort(options: ExecPortOptions): ExecPort {
  const resolve = options.resolve ?? ((target: string) => (options.workspace(target) === null ? null : target))
  const live = new Map<string, number>()
  return {
    resolve: (target) => {
      const resolved = resolve(target)
      return resolved !== null && options.workspace(resolved) !== null ? resolved : null
    },
    targets: () => options.targets?.() ?? [],
    holds: (holder) => (live.get(holder) ?? 0) > 0,
    async run(request, onOutput, signal) {
      const target = resolve(request.target)
      const workspace = target === null ? null : options.workspace(target)
      if (target === null || workspace === null) return null
      const holder = options.holder?.(target) ?? execHolder(target)
      const turn = `exec-${randomUUID()}`
      const env = { ...workspace.env, [MAESTRO_NODE_ENV]: holder, [MAESTRO_TURN_ENV]: turn }
      live.set(holder, (live.get(holder) ?? 0) + 1)
      try {
        const work = () => runCommand({ ...workspace, env }, request.command, onOutput, signal)
        if (target !== 'integration' || options.holdIntegration === undefined) return await work()
        return await options.holdIntegration(request.actor, work)
      } finally {
        live.set(holder, (live.get(holder) ?? 1) - 1)
        options.onEnded?.(holder, turn)
      }
    },
  }
}

/** One shell command in one workspace; never throws for the command failing. */
export async function runCommand(
  workspace: Workspace,
  command: string,
  onOutput: (chunk: string) => void,
  signal: AbortSignal,
): Promise<number> {
  if (signal.aborted) return EXEC_KILLED
  const shell = shellInvocation(command)
  const child = spawn(shell.file, [...shell.args], {
    cwd: workspace.path,
    env: { ...process.env, ...workspace.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: ownProcessGroup(),
    ...spawnOptionsFor(shell),
  })
  child.stdout?.setEncoding('utf8').on('data', onOutput)
  child.stderr?.setEncoding('utf8').on('data', onOutput)
  const stop = (): void => {
    if (child.pid !== undefined && !killTree(child.pid, 'SIGTERM')) child.kill('SIGTERM')
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    return await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        onOutput(`vinta-ai-maestro: could not start the command: ${error.message}\n`)
        resolve(127)
      })
      child.once('close', (code, killedBy) => resolve(code ?? (killedBy === null ? 1 : EXEC_KILLED)))
    })
  } finally {
    signal.removeEventListener('abort', stop)
  }
}
