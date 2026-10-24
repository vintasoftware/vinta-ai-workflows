/**
 * Slots in a pool shared by every run on this machine (`scope: host`).
 *
 * A pool is otherwise one run's: two runs on one laptop each had their own
 * `test-suite` of capacity 1, and ran two full suites at once. One observed
 * pair of runs took a ten-minute suite to 28–42 minutes at a load average of
 * 22 to 26, past its 30-minute timeout again and again — and each timeout left
 * a container and a half-migrated database behind it for the next attempt.
 *
 * A host slot is a lock file, `<root>/<pool>/slot-<n>.lock`, created with
 * `O_EXCL` so exactly one process gets it. It holds the owner's pid and run id
 * and nothing else (§11). A slot whose pid is gone is a run that died holding
 * it, and is taken over. Capacity is each run's own reading of the pool: a run
 * declaring 2 may take slot 0 or 1, one declaring 1 only slot 0, so the
 * stricter run is never pushed past what it declared.
 *
 * Synchronous on purpose: `ResourcePools` grants inside one scan of its queue,
 * all-or-nothing, and a slot taken by an `await` would let the scan interleave
 * with another grant. The file operations are a few microseconds on a local
 * disk.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where host slots live when nothing says otherwise. Overridden by `VINTA_AI_MAESTRO_HOST_LEASES`. */
export function defaultHostSlotsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['VINTA_AI_MAESTRO_HOST_LEASES'] ?? join(homedir(), '.vinta-ai-maestro', 'host-leases')
}

/** How long an unreadable slot file must have been so before it is taken for a dead run's. */
const HALF_WRITTEN_MS = 5_000

export interface HostSlot {
  release(): void
}

export interface HostSlotHolder {
  readonly pid: number
  readonly run: string
}

export interface HostSlotsOptions {
  readonly root: string
  /** This run's id, written into each slot it holds so another run can say who has it. */
  readonly run: string
  readonly pid?: number
  readonly alive?: (pid: number) => boolean
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a process that exists and is somebody else's.
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

export class HostSlots {
  readonly #root: string
  readonly #run: string
  readonly #pid: number
  readonly #alive: (pid: number) => boolean

  constructor(options: HostSlotsOptions) {
    this.#root = options.root
    this.#run = options.run
    this.#pid = options.pid ?? process.pid
    this.#alive = options.alive ?? processAlive
  }

  /** One free slot of `pool` below `capacity`, taken now, or null when all are held. */
  tryTake(pool: string, capacity: number): HostSlot | null {
    const dir = join(this.#root, pool)
    mkdirSync(dir, { recursive: true })
    for (let slot = 0; slot < capacity; slot += 1) {
      const path = join(dir, `slot-${slot}.lock`)
      if (this.#create(path) || (this.#stale(path) && this.#create(path))) return this.#slot(path)
    }
    return null
  }

  /** Who holds each slot of `pool` now, for a waiter to be told. Dead holders are left out. */
  holders(pool: string, capacity: number): readonly HostSlotHolder[] {
    const found: HostSlotHolder[] = []
    for (let slot = 0; slot < capacity; slot += 1) {
      const holder = this.#read(join(this.#root, pool, `slot-${slot}.lock`))
      if (holder !== null && this.#alive(holder.pid)) found.push(holder)
    }
    return found
  }

  #create(path: string): boolean {
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch {
      return false
    }
    try {
      writeSync(fd, JSON.stringify({ pid: this.#pid, run: this.#run, since: Date.now() }))
    } finally {
      closeSync(fd)
    }
    return true
  }

  /** Removes a slot whose holder is gone; true when it did. */
  #stale(path: string): boolean {
    const holder = this.#read(path)
    if (holder !== null && this.#alive(holder.pid)) return false
    // No pid to ask: half-written. Only once it has been so for a while — a
    // moment ago it may be another run between its `open` and its `write`.
    if (holder === null && Date.now() - this.#mtime(path) < HALF_WRITTEN_MS) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  #mtime(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }

  #read(path: string): HostSlotHolder | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; run?: unknown }
      return typeof parsed.pid === 'number' ? { pid: parsed.pid, run: typeof parsed.run === 'string' ? parsed.run : '?' } : null
    } catch {
      return null
    }
  }

  #slot(path: string): HostSlot {
    let released = false
    return {
      release: (): void => {
        if (released) return
        released = true
        // Only our own: a slot taken over after we were wrongly thought dead
        // belongs to whoever took it.
        const holder = this.#read(path)
        if (holder !== null && (holder.pid !== this.#pid || holder.run !== this.#run)) return
        try {
          unlinkSync(path)
        } catch {}
      },
    }
  }
}
