/**
 * Where the log lives on disk, and how it stops growing.
 *
 * Inside the project, beside the journal, for the reason §11 gives about
 * everything else in `.vinta-ai-maestro/`: a global cache directory would put a
 * client's identifiers somewhere the project's own retention rules do not
 * reach. Unlike `runs/`, this directory holds no repository content by
 * construction (`record.ts`), which is why `purge` does not delete it —
 * exactly as `purge` does not delete `flow.db`, and for exactly the same
 * reason. What bounds it is rotation, below.
 *
 * ### Generations
 *
 * The active file is `daemon.ndjson`. Rotating renames it to
 * `daemon.<generation>.ndjson` and starts a new active file one generation
 * later, so numbers only ever go up and the newest rotated file is the
 * highest-numbered one.
 *
 * That ordering is the whole point, and it is why this does not do what
 * logrotate does — shifting `.1` to `.2`, `.2` to `.3`, and so on. Under
 * shifting, a file's name changes while a reader is holding it: a cursor
 * pointing into `daemon.1.ndjson` is pointing at different bytes a minute
 * later, and a reader cannot tell that happened. Here a generation names the
 * same bytes for as long as the file exists, and when retention finally
 * deletes it the reader gets a clean "that is gone" instead of silently
 * reading somebody else's lines.
 *
 * The active file's generation is derived from the directory rather than
 * stored: one more than the highest rotated file. A reader computes it the
 * same way, so writer and reader agree without a shared counter file to fall
 * out of step.
 *
 * ### More than one daemon
 *
 * Two daemons on one project write to the same active file. `appendFileSync`
 * with `O_APPEND` puts each line down whole, and every record carries its
 * `pid`, so the result interleaves legibly. The one race is both rotating at
 * once: the loser's next append recreates `daemon.ndjson`, and a reader
 * holding a cursor into the renamed file sees that generation end where it
 * ended. It costs a reader one `reset`, which is a visible, recoverable thing
 * — the alternative was a lock file held across a rename by a process that may
 * be killed while holding it.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** `<project>/.vinta-ai-maestro/logs`. The journal's `root` is its parent. */
export const logDirFor = (storeDir: string): string => join(storeDir, 'logs')

const ACTIVE = 'daemon.ndjson'
const ROTATED = /^daemon\.(\d+)\.ndjson$/

/** 8 MiB per file. A busy run produces a few hundred KiB of these. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Rotated files kept. Five at 8 MiB is 40 MiB of history — enough to hold the
 * days before somebody noticed, bounded enough to sit in a checkout.
 */
export const DEFAULT_KEEP = 5

export interface LogFile {
  readonly generation: number
  readonly path: string
  /** The one being appended to. Exactly one entry has this. */
  readonly active: boolean
}

export const activePath = (dir: string): string => join(dir, ACTIVE)

/**
 * Every log file, oldest generation first, active last.
 *
 * A missing directory is an empty list, not an error: reading the log of a
 * daemon that has not written one yet is an ordinary thing for the UI to do.
 */
export function logFiles(dir: string): readonly LogFile[] {
  let names: readonly string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const rotated: LogFile[] = []
  for (const name of names) {
    const match = ROTATED.exec(name)
    if (match?.[1] === undefined) continue
    rotated.push({ generation: Number(match[1]), path: join(dir, name), active: false })
  }
  rotated.sort((a, b) => a.generation - b.generation)

  const active = { generation: nextGeneration(rotated), path: join(dir, ACTIVE), active: true }
  return names.includes(ACTIVE) ? [...rotated, active] : rotated
}

/** What the active file's generation is, whether or not it exists yet. */
export function activeGeneration(dir: string): number {
  const files = logFiles(dir)
  const last = files.at(-1)
  if (last === undefined) return 1
  return last.active ? last.generation : last.generation + 1
}

function nextGeneration(rotated: readonly LogFile[]): number {
  return (rotated.at(-1)?.generation ?? 0) + 1
}

export function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * Renames the active file to its generation and prunes the oldest beyond
 * `keep`. Returns the generation the new active file will have.
 *
 * Every step tolerates having lost the race with another daemon: the rename
 * may find no file, and the unlink may find the file already gone. Neither is
 * worth failing a log write over — the write is usually the one explaining
 * something worse.
 */
export function rotate(dir: string, keep: number): number {
  const generation = activeGeneration(dir)
  try {
    renameSync(join(dir, ACTIVE), join(dir, `daemon.${generation}.ndjson`))
  } catch {
    // Already rotated by somebody else, or never created. Either way the next
    // append starts a fresh active file, which is what was wanted.
  }
  prune(dir, keep)
  return activeGeneration(dir)
}

export function prune(dir: string, keep: number): void {
  const rotated = logFiles(dir).filter((file) => !file.active)
  for (const file of rotated.slice(0, Math.max(0, rotated.length - keep))) {
    try {
      unlinkSync(file.path)
    } catch {
      // Gone already, or held open on Windows. It will be pruned next time.
    }
  }
}
