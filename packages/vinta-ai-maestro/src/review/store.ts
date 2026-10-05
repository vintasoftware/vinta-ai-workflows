/**
 * Where a review is kept, and how two processes share it.
 *
 * The review page (the `ui` daemon) and the agent (`vinta-ai-maestro review
 * wait` / `reply`) are different processes writing one file. Each change is a
 * read-modify-write under an exclusive lock file, so neither can write over a
 * comment the other just added. The changes are small and synchronous, so the
 * lock is held for microseconds and a plain retry loop is enough.
 *
 * Two files, in two places, on purpose:
 *
 * - **The review** is `ai-plans/<id>.review.json` — the committed document
 *   (`document.ts`). Written atomically, like the workflow beside it.
 * - **The presence** of an agent is `.vinta-ai-maestro/reviews/<id>.listener.json`
 *   — a pid and a heartbeat, which is per-machine state and must not be
 *   committed. So is the lock.
 *
 * Nothing here logs and nothing here throws a message carrying file contents:
 * a review holds a person's prose about a repository (§11).
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  REVIEW_SUFFIX,
  ReviewRefusal,
  awaitingAgent,
  emptyReview,
  PlanReviewSchema,
  type PlanReview,
} from './document.ts'

/** Under the project's gitignored store, beside the journal. */
export const REVIEWS_DIRNAME = 'reviews'

/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 10_000
/** How long a writer waits for the lock before giving up. */
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 20

/**
 * How long a heartbeat counts as an agent listening. `review wait` beats every
 * few seconds; three missed beats is a process that is gone, not one that is
 * slow.
 */
export const LISTENING_WINDOW_MS = 15_000

/**
 * How long after an agent last listened it is still assumed to be working on
 * what it picked up. Long, because revising a plan is a real turn — but not
 * for ever, or a session that was closed would be "working" until somebody
 * deleted a file.
 */
export const WORKING_WINDOW_MS = 30 * 60_000

export type ReviewRead =
  | { readonly ok: true; readonly review: PlanReview; readonly exists: boolean }
  | { readonly ok: false; readonly reason: 'unreadable' | 'invalid' }

/**
 * Whether an agent is on the other end, as the chat shows it.
 *
 * - `listening`: blocked in `review wait` right now — a message is read at once.
 * - `working`: it picked up a message and has not answered yet.
 * - `away`: neither. A message waits until an agent runs `review wait`.
 */
export type Presence =
  | { readonly state: 'listening'; readonly since: string }
  | { readonly state: 'working'; readonly lastSeenAt: string }
  | { readonly state: 'away'; readonly lastSeenAt: string | null }

interface ListenerRecord {
  readonly pid: number | null
  readonly since: string | null
  readonly heartbeat_at: string
}

export interface ReviewStore {
  /** The committed document's path. */
  readonly path: string
  /** A missing file is an empty review, not an error: nobody has commented yet. */
  read(): ReviewRead
  /** One read-modify-write under the lock. Returns what was written. */
  update(change: (review: PlanReview) => PlanReview): PlanReview
  presence(now?: number): Presence
  /** Called by `review wait` while it blocks. */
  heartbeat(since: string, now?: string): void
  /** Called when `review wait` returns: keeps the last-seen time, drops the pid. */
  leave(now?: string): void
}

export interface ReviewStoreOptions {
  /** The directory holding `<id>.workflow.json` — the review is its sibling. */
  readonly plansDir: string
  /** `<project>/.vinta-ai-maestro`. */
  readonly stateRoot: string
  readonly workflowId: string
  /** Liveness of a pid. Injected so a test can say a process died. */
  readonly alive?: (pid: number) => boolean
}

/**
 * A path as the review's readers see it: relative to the repository and
 * `/`-separated on every platform. The agent quotes it back in commands and
 * the page prints it, so a Windows `ai-plans\x.review.json` would be a path
 * neither of them could use on the next machine.
 */
export function repoRelative(repoDir: string, path: string): string {
  return relative(repoDir, path).split(sep).join('/')
}

export function reviewPathFor(plansDir: string, workflowId: string): string {
  return join(plansDir, `${workflowId}${REVIEW_SUFFIX}`)
}

export function createReviewStore(options: ReviewStoreOptions): ReviewStore {
  const { plansDir, workflowId } = options
  const path = reviewPathFor(plansDir, workflowId)
  const stateDir = join(options.stateRoot, REVIEWS_DIRNAME)
  const lockPath = join(stateDir, `${workflowId}.lock`)
  const listenerPath = join(stateDir, `${workflowId}.listener.json`)
  const alive = options.alive ?? processAlive

  function read(): ReviewRead {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, review: emptyReview(workflowId), exists: false }
      }
      return { ok: false, reason: 'unreadable' }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'invalid' }
    }
    const parsed = PlanReviewSchema.safeParse(raw)
    if (!parsed.success || parsed.data.workflow_id !== workflowId) return { ok: false, reason: 'invalid' }
    return { ok: true, review: parsed.data, exists: true }
  }

  return {
    path,
    read,

    update(change) {
      return withLock(() => {
        const current = read()
        // A file somebody broke by hand is not overwritten: their edit is the
        // only copy of whatever they were trying to say.
        if (!current.ok) throw new ReviewRefusal('invalid_review')
        const next = PlanReviewSchema.parse(change(current.review))
        mkdirSync(plansDir, { recursive: true })
        writeAtomic(path,`${JSON.stringify(next, null, 2)}\n`)
        return next
      })
    },

    presence(now = Date.now()) {
      const listener = readListener()
      if (listener === null) return { state: 'away', lastSeenAt: null }
      const beat = Date.parse(listener.heartbeat_at)
      if (
        listener.pid !== null &&
        listener.since !== null &&
        now - beat <= LISTENING_WINDOW_MS &&
        alive(listener.pid)
      ) {
        return { state: 'listening', since: listener.since }
      }
      const current = read()
      if (current.ok && awaitingAgent(current.review) && now - beat <= WORKING_WINDOW_MS) {
        return { state: 'working', lastSeenAt: listener.heartbeat_at }
      }
      return { state: 'away', lastSeenAt: listener.heartbeat_at }
    },

    heartbeat(since, now = new Date().toISOString()) {
      writeListener({ pid: process.pid, since, heartbeat_at: now })
    },

    leave(now = new Date().toISOString()) {
      writeListener({ pid: null, since: null, heartbeat_at: now })
    },
  }

  function readListener(): ListenerRecord | null {
    try {
      const raw = JSON.parse(readFileSync(listenerPath, 'utf8')) as Partial<ListenerRecord>
      if (typeof raw.heartbeat_at !== 'string') return null
      return {
        pid: typeof raw.pid === 'number' ? raw.pid : null,
        since: typeof raw.since === 'string' ? raw.since : null,
        heartbeat_at: raw.heartbeat_at,
      }
    } catch {
      return null
    }
  }

  function writeListener(record: ListenerRecord): void {
    mkdirSync(stateDir, { recursive: true })
    writeAtomic(listenerPath, `${JSON.stringify(record)}\n`)
  }

  function withLock<T>(body: () => T): T {
    mkdirSync(stateDir, { recursive: true })
    const deadline = Date.now() + LOCK_WAIT_MS
    let fd: number | null = null
    while (fd === null) {
      try {
        fd = openSync(lockPath, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (lockIsStale()) {
          rmSync(lockPath, { force: true })
          continue
        }
        if (Date.now() > deadline) throw new ReviewRefusal('review_busy')
        sleepSync(LOCK_RETRY_MS)
      }
    }
    try {
      return body()
    } finally {
      closeSync(fd)
      rmSync(lockPath, { force: true })
    }
  }

  function lockIsStale(): boolean {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS
    } catch {
      // Gone between the failed open and this stat: the next open will tell.
      return false
    }
  }
}

/** Temporary file in the same directory, then rename — never a half-written review. */
function writeAtomic(target: string, text: string): void {
  const temporary = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process owned by somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms)
}
