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

import { killTree, ownProcessGroup, shellInvocation, spawnOptionsFor } from '../platform/platform.ts'
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
  /** Whether the run has this target — asked before the answer starts streaming. */
  knows(target: string): boolean
  /**
   * Runs the request and resolves with its exit code, or null for a target
   * the run does not have. `onOutput` receives stdout and stderr, combined,
   * in arrival order. Aborting `signal` ends the command's process tree.
   */
  run(request: ExecRequest, onOutput: (chunk: string) => void, signal: AbortSignal): Promise<number | null>
}

export interface ExecPortOptions {
  readonly workspace: (target: string) => Workspace | null
  readonly holdIntegration?: <T>(label: string, work: () => Promise<T>) => Promise<T>
}

/** The exit code a command killed from outside reports. */
export const EXEC_KILLED = 137

export function execPort(options: ExecPortOptions): ExecPort {
  return {
    knows: (target) => options.workspace(target) !== null,
    async run(request, onOutput, signal) {
      const workspace = options.workspace(request.target)
      if (workspace === null) return null
      const work = () => runCommand(workspace, request.command, onOutput, signal)
      if (request.target !== 'integration' || options.holdIntegration === undefined) return await work()
      return await options.holdIntegration(request.actor, work)
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
