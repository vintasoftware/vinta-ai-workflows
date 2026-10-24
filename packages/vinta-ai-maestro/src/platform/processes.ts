/**
 * The machine's process table, read for one purpose: saying what a phase is
 * running right now, and stopping it when asked.
 *
 * A phase that waits on a process looks exactly like a phase that is stuck:
 * the transcript is quiet, no gate is running, and the only thing moving is a
 * test suite an agent started in the background twenty minutes ago. The node
 * view lists those processes and offers to stop them (`processes/list.ts`);
 * this module is the part that asks the operating system.
 *
 * POSIX reads `ps`; Windows asks PowerShell for `Win32_Process`. Either one
 * failing answers null — a view with no process list, not an error. Nothing
 * here logs: a command line is the agent's own text, which the transcript
 * already shows the operator and no log record may carry (§11).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { isWindows, type Platform } from './platform.ts'

const execFileAsync = promisify(execFile)

/** One live process. `startedAt` is epoch ms, derived from its elapsed time. */
export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly startedAt: number
  readonly command: string
}

export type ProcessTable = readonly ProcessRow[]

/** How long the table read may take; a host under heavy load is when this view matters most. */
const READ_TIMEOUT_MS = 10_000

/** The process table, or null when it cannot be read here. */
export async function readProcessTable(
  platform: Platform = process.platform,
  now: number = Date.now(),
): Promise<ProcessTable | null> {
  try {
    if (isWindows(platform)) {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
        ],
        { timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      )
      return parseWindowsTable(stdout)
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], {
      timeout: READ_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    return parsePsTable(stdout, now)
  } catch {
    return null
  }
}

/** `ps -o pid=,ppid=,etime=,command=` output. */
export function parsePsTable(text: string, now: number): ProcessTable {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const elapsed = parseElapsed(match[3] as string)
    if (elapsed === null) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: now - elapsed * 1000,
      command: (match[4] as string).trim(),
    })
  }
  return rows
}

/** `ps`'s `etime`, `[[dd-]hh:]mm:ss`, in seconds. */
export function parseElapsed(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (match === null) return null
  const [, days, hours, minutes, seconds] = match
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/** PowerShell's `ConvertTo-Json` of `Win32_Process`: one object, or an array. */
export function parseWindowsTable(text: string): ProcessTable {
  const parsed = JSON.parse(text) as unknown
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const rows: ProcessRow[] = []
  for (const item of items) {
    const row = item as { ProcessId?: unknown; ParentProcessId?: unknown; CreationDate?: unknown; CommandLine?: unknown }
    if (typeof row.ProcessId !== 'number' || typeof row.ParentProcessId !== 'number') continue
    rows.push({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      startedAt: windowsDate(row.CreationDate),
      command: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    })
  }
  return rows
}

/** `ConvertTo-Json` writes a `DateTime` as `/Date(1729600000000)/` or as ISO, by PowerShell version. */
function windowsDate(value: unknown): number {
  if (typeof value !== 'string') return Date.now()
  const legacy = /\/Date\((\d+)\)\//.exec(value)
  if (legacy !== null) return Number(legacy[1])
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

/** Every process under `pid`, not including it, nearest first. */
export function descendants(table: ProcessTable, pid: number): readonly ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of table) {
    if (row.pid === row.ppid) continue
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  }
  const found: ProcessRow[] = []
  const queue = [...(children.get(pid) ?? [])]
  const seen = new Set<number>([pid])
  while (queue.length > 0) {
    const row = queue.shift() as ProcessRow
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    found.push(row)
    queue.push(...(children.get(row.pid) ?? []))
  }
  return found
}

export type Signaller = (pid: number, signal: NodeJS.Signals) => void

const defaultSignal: Signaller = (pid, signal) => {
  try {
    process.kill(pid, signal)
  } catch {
    // Gone already, or not ours to signal: either way nothing is left to do.
  }
}

/**
 * Ends `pid` and everything under it: SIGTERM to the whole tree, deepest
 * first so a parent does not respawn what it just lost, then SIGKILL to
 * whatever is still there after `graceMs`.
 *
 * Walked from the table rather than sent to a process group, because the
 * commands an agent runs do not lead groups of their own: a group signal
 * would miss them or hit the agent itself.
 */
export async function stopTree(
  pid: number,
  options: {
    readonly table?: ProcessTable
    readonly read?: () => Promise<ProcessTable | null>
    readonly signal?: Signaller
    readonly graceMs?: number
    readonly sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<void> {
  const read = options.read ?? (() => readProcessTable())
  const signal = options.signal ?? defaultSignal
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const table = options.table ?? (await read()) ?? []
  const tree = [...descendants(table, pid).map((row) => row.pid).reverse(), pid]
  for (const member of tree) signal(member, 'SIGTERM')
  await sleep(options.graceMs ?? 3_000)
  const after = await read()
  const alive = new Set((after ?? []).map((row) => row.pid))
  for (const member of tree) if (after === null || alive.has(member)) signal(member, 'SIGKILL')
}
