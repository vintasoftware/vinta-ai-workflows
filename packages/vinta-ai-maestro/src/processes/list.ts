/**
 * What a phase is running right now, as processes — and stopping one.
 *
 * A phase waiting on a process looks stuck: the transcript is quiet, the
 * gates panel shows nothing running, and the one thing moving is a suite the
 * agent started in the background half an hour ago, or a command of its own
 * that hung. The node view lists these so the operator can tell the two
 * apart, and stop the one that is the problem.
 *
 * Two kinds, each found from something the run already knows:
 *
 * - **The agent's commands.** Every shell line the agent runs is a child of
 *   its CLI process (`AgentSession.pid`): the shells among that process's
 *   children, and only those — an MCP server or a helper it starts is not a
 *   command the agent is waiting on. A command is `foreground` while the
 *   turn's matching shell call has no result yet; one started in the
 *   background got its result at once.
 * - **Gates.** The runner's own registry (`liveGates`), attributed by where
 *   they run: the phase's lane, or the integration worktree while the phase
 *   holds it. Always `foreground` — the pipeline is waiting on them.
 *
 * Stopping ends the whole tree under the process. A gate is stopped through
 * the runner, so its result reads as cancelled and its containers are
 * stopped; an agent's command is signalled from the process table, so the
 * agent sees its command die and carries on with that.
 *
 * Only a pid this module just listed for the phase can be stopped: the route
 * is not a way to signal arbitrary processes on the machine.
 */
import { isAbsolute, relative } from 'node:path'

import type { LiveGate } from '../gates/runner.ts'
import { descendants, stopTree, type ProcessTable } from '../platform/processes.ts'

export type NodeProcessKind = 'agent' | 'gate'

export interface NodeProcess {
  readonly pid: number
  readonly kind: NodeProcessKind
  /** `foreground`: the phase is waiting on it. `background`: it runs while the phase does something else, or nothing. */
  readonly mode: 'foreground' | 'background'
  /** The command as the agent or the gate wrote it, unwrapped from its shell. Bounded. */
  readonly command: string
  /** The gate's id, for a gate. */
  readonly gateId: string | null
  /** Epoch ms. */
  readonly startedAt: number
  /** How many processes run under it: a test runner's workers, a compose client. */
  readonly descendants: number
}

export interface ProcessSources {
  /** The node's live agent turn: its CLI's pid, and the shell lines it waits on. */
  readonly liveTurn: (nodeId: string) => { readonly pid: number | undefined; readonly foreground: readonly string[] } | null
  /** The node's lane on disk, or null. */
  readonly lanePath: (nodeId: string) => string | null
  readonly integrationPath: string | null
  /** The node holding the integration worktree now, if any. */
  readonly integrationHolder: () => string | null
  readonly gates: () => readonly LiveGate[]
  readonly table: () => Promise<ProcessTable | null>
  readonly stopGate: (pid: number) => boolean
  /** Injected in tests. */
  readonly stopTree?: (pid: number, table: ProcessTable) => Promise<void>
}

/** How much of a command line the view is sent. */
const COMMAND_LIMIT = 500

/** A process whose program is a shell: what an agent's command line runs under. */
const SHELL = /^(?:\S*[\\/])?(?:ba|z|da|k|fi)?sh(?:\.exe)?\b|^(?:\S*[\\/])?(?:cmd|powershell|pwsh)(?:\.exe)?\b/i

/** The node's processes, or null when the process table cannot be read here. */
export async function nodeProcesses(sources: ProcessSources, nodeId: string): Promise<readonly NodeProcess[] | null> {
  const table = await sources.table()
  if (table === null) return null
  return listFrom(sources, nodeId, table)
}

function listFrom(sources: ProcessSources, nodeId: string, table: ProcessTable): readonly NodeProcess[] {
  const byPid = new Map(table.map((row) => [row.pid, row]))
  const found: NodeProcess[] = []
  const gatePids = new Set<number>()

  const lane = sources.lanePath(nodeId)
  const holds = sources.integrationHolder() === nodeId
  for (const gate of sources.gates()) {
    const ours = (lane !== null && within(lane, gate.cwd)) || (holds && sources.integrationPath !== null && within(sources.integrationPath, gate.cwd))
    if (!ours) continue
    gatePids.add(gate.pid)
    const row = byPid.get(gate.pid)
    found.push({
      pid: gate.pid,
      kind: 'gate',
      mode: 'foreground',
      command: bounded(row === undefined ? gate.gateId : displayCommand(row.command)),
      gateId: gate.gateId,
      startedAt: gate.startedAt,
      descendants: descendants(table, gate.pid).length,
    })
  }

  const turn = sources.liveTurn(nodeId)
  if (turn?.pid !== undefined) {
    const waiting = turn.foreground.map(normalized).filter((line) => line !== '')
    for (const row of table) {
      if (row.ppid !== turn.pid || gatePids.has(row.pid) || !SHELL.test(row.command)) continue
      const command = displayCommand(row.command)
      const line = normalized(command)
      found.push({
        pid: row.pid,
        kind: 'agent',
        mode: waiting.some((open) => line.includes(open) || open.includes(line)) ? 'foreground' : 'background',
        command: bounded(command),
        gateId: null,
        startedAt: row.startedAt,
        descendants: descendants(table, row.pid).length,
      })
    }
  }

  // What the phase is waiting on first, then the oldest: the likeliest culprit.
  return found.sort((a, b) =>
    a.mode === b.mode ? a.startedAt - b.startedAt : a.mode === 'foreground' ? -1 : 1,
  )
}

/**
 * Stops one of the node's processes and everything under it. False when the
 * pid is not one of the node's processes now — gone already, or never its.
 */
export async function stopNodeProcess(
  sources: ProcessSources,
  nodeId: string,
  pid: number,
): Promise<{ readonly stopped: boolean; readonly process?: NodeProcess }> {
  const table = await sources.table()
  if (table === null) return { stopped: false }
  const target = listFrom(sources, nodeId, table).find((entry) => entry.pid === pid)
  if (target === undefined) return { stopped: false }
  if (target.kind === 'gate') return { stopped: sources.stopGate(pid), process: target }
  await (sources.stopTree ?? ((root, known) => stopTree(root, { table: known })))(pid, table)
  return { stopped: true, process: target }
}

/**
 * The line the agent wrote, out of the shell that runs it. Claude Code wraps
 * each command as `zsh -c -l source <snapshot> && eval '<command>' < /dev/null
 * && pwd -P >| <file>`; codex as `bash -lc '<command>'`. Anything else is
 * shown as it is.
 */
export function displayCommand(command: string): string {
  const evaluated = /\beval '((?:[^']|'\\'')*)'/.exec(command)
  if (evaluated !== null) return (evaluated[1] as string).replaceAll("'\\''", "'")
  const wrapped = /^\S*\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-\w*c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim())
  if (wrapped !== null) return wrapped[2] as string
  return command
}

function normalized(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function bounded(text: string): string {
  return text.length <= COMMAND_LIMIT ? text : `${text.slice(0, COMMAND_LIMIT - 1)}…`
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

