/**
 * Reading the log back: a tail, and a follow.
 *
 * Two modes, because there are two questions. "Something went wrong, show me"
 * wants the last N records and does not care where they came from. "I am
 * watching this" wants everything since the last answer, repeatedly, cheaply.
 * The first is a bounded backwards read; the second is a forward read from a
 * cursor. They share a filter and nothing else.
 *
 * ### The cursor
 *
 * `"<generation>:<byte offset>"` — a position in the log, not in a result set.
 * A filtered follow therefore advances its cursor past records it did not
 * return, which is the property that makes filtering free: narrowing to
 * `error` does not make the poll read more.
 *
 * Generations come from `files.ts`, where the naming scheme is explained. What
 * matters here is that a generation names the same bytes for as long as its
 * file exists, so a cursor stays valid across a rotation — the read simply
 * continues into the next generation. When retention has deleted the file a
 * cursor points into, that is reported as `reset` rather than papered over:
 * the client is told it has a gap, and resumes from the oldest file still
 * held. Silently resuming somewhere else is how a UI shows a continuous
 * stream with a hole in it.
 *
 * ### Bounded reads
 *
 * A tail reads whole files into memory, which is only acceptable because
 * `files.ts` caps a file at 8 MiB and this caps the number of files it will
 * open (`TAIL_BYTES`). Neither read is allowed to grow with the length of the
 * run it describes.
 */
import { openSync, readSync, closeSync } from 'node:fs'
import { logFiles, sizeOf, type LogFile } from './files.ts'
import { atLeast, decodeRecord, type LogLevel, type LogRecord } from './record.ts'

/** The most a tail will read off disk, across however many files that spans. */
const TAIL_BYTES = 4 * 1024 * 1024

/** The most one follow returns, so a burst cannot become an unbounded response. */
export const MAX_PAGE = 1000

export interface LogFilter {
  /** Records below this level are skipped. Defaults to everything. */
  readonly level?: LogLevel
  readonly runId?: string
  readonly nodeId?: string
  /**
   * A case-insensitive substring, matched against the event name and the
   * field values — which are identifiers, so this is a search over ids and
   * statuses rather than over prose.
   */
  readonly search?: string
}

export interface LogPage {
  readonly records: readonly LogRecord[]
  /** Pass back as `after` to continue. Opaque to the client. */
  readonly cursor: string
  /**
   * The cursor named a generation that no longer exists: records between it
   * and the oldest file still held were pruned, and this page starts after
   * the gap.
   */
  readonly reset: boolean
  /** More is already waiting beyond this page — poll again without sleeping. */
  readonly more: boolean
}

export function encodeCursor(generation: number, offset: number): string {
  return `${generation}:${offset}`
}

export function decodeCursor(value: string): { generation: number; offset: number } | null {
  const match = /^(\d+):(\d+)$/.exec(value)
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { generation: Number(match[1]), offset: Number(match[2]) }
}

/** The cursor for "everything from here on", without reading anything. */
export function endCursor(dir: string): string {
  const files = logFiles(dir)
  const last = files.at(-1)
  if (last === undefined) return encodeCursor(1, 0)
  return encodeCursor(last.generation, sizeOf(last.path))
}

/**
 * The last `limit` matching records, newest generation backwards.
 *
 * Files are read from the end, and the walk stops as soon as it has enough —
 * so the common case, a tail of a busy log, touches one file.
 */
export function readTail(dir: string, limit: number, filter: LogFilter = {}): LogPage {
  const files = logFiles(dir)
  const collected: LogRecord[] = []
  let budget = TAIL_BYTES

  for (let index = files.length - 1; index >= 0 && collected.length < limit; index -= 1) {
    const file = files[index] as LogFile
    const size = sizeOf(file.path)
    if (size === 0) continue
    const span = Math.min(size, budget)
    if (span <= 0) break
    budget -= span

    const matching = parse(read(file.path, size - span, span), span < size).filter((record) =>
      matches(record, filter),
    )
    // Newest last within a file, so take from its end and keep building
    // backwards across files; one reverse at the end restores the order.
    collected.push(...matching.slice(Math.max(0, matching.length - (limit - collected.length))).reverse())
  }

  return {
    records: collected.reverse(),
    cursor: endCursor(dir),
    reset: false,
    more: false,
  }
}

/**
 * Everything written after `after`, up to `limit`.
 *
 * An unparseable cursor is treated as "start from the end" rather than as an
 * error: the client's next poll then behaves like a fresh follow, which is a
 * better answer to a corrupted query parameter than a 400 that stops the view
 * updating.
 */
export function readAfter(dir: string, after: string, limit: number, filter: LogFilter = {}): LogPage {
  const position = decodeCursor(after)
  if (position === null) return { records: [], cursor: endCursor(dir), reset: true, more: false }

  const files = logFiles(dir)
  if (files.length === 0) return { records: [], cursor: after, reset: false, more: false }

  const from = files.findIndex((file) => file.generation === position.generation)
  // The generation is gone — pruned by retention while this client was away.
  // Everything between it and the oldest file still held is a gap, and saying
  // so is the whole reason `reset` exists.
  const reset = from === -1
  let start = reset ? 0 : from
  let offset = reset ? 0 : position.offset

  const records: LogRecord[] = []
  let cursor = after
  let more = false

  for (; start < files.length; start += 1) {
    const file = files[start] as LogFile
    const size = sizeOf(file.path)
    if (offset >= size) {
      // Finished with this generation. A rotated one is complete, so the
      // cursor moves on to the next; the active one just has nothing new.
      cursor = encodeCursor(file.generation, size)
      offset = 0
      continue
    }

    const chunk = read(file.path, offset, size - offset)
    const { complete, consumed } = split(chunk)
    for (const line of complete) {
      const record = decodeRecord(line)
      if (record !== null && matches(record, filter)) {
        if (records.length === limit) {
          more = true
          break
        }
        records.push(record)
      }
      offset += Buffer.byteLength(line) + 1
      cursor = encodeCursor(file.generation, offset)
    }
    if (more) break
    // A trailing partial line is a record mid-write. Leaving the cursor before
    // it is what makes the next poll pick it up whole instead of discarding it.
    if (consumed === 0 && complete.length === 0) cursor = encodeCursor(file.generation, offset)
    offset = 0
  }

  return { records, cursor, reset, more }
}

function matches(record: LogRecord, filter: LogFilter): boolean {
  if (filter.level !== undefined && !atLeast(record.level, filter.level)) return false
  if (filter.runId !== undefined && record.runId !== filter.runId) return false
  if (filter.nodeId !== undefined && record.nodeId !== filter.nodeId) return false
  if (filter.search === undefined || filter.search.length === 0) return true

  const needle = filter.search.toLowerCase()
  if (record.event.toLowerCase().includes(needle)) return true
  if (record.runId?.toLowerCase().includes(needle) === true) return true
  if (record.nodeId?.toLowerCase().includes(needle) === true) return true
  return Object.entries(record.fields).some(
    ([key, value]) =>
      key.includes(needle) || (value !== null && String(value).toLowerCase().includes(needle)),
  )
}

/** A byte range, as a string. Files are UTF-8 NDJSON by construction. */
function read(path: string, offset: number, length: number): string {
  if (length <= 0) return ''
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const buffer = Buffer.allocUnsafe(length)
    const bytes = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, bytes).toString('utf8')
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

/**
 * Whole lines only. The trailing fragment — a record being written right now,
 * or the first half of a line a backwards read started inside — is discarded
 * by the caller that knows which case it is in.
 */
function split(chunk: string): { complete: readonly string[]; consumed: number } {
  const end = chunk.lastIndexOf('\n')
  if (end === -1) return { complete: [], consumed: 0 }
  return { complete: chunk.slice(0, end).split('\n'), consumed: end + 1 }
}

/**
 * Lines from a chunk, dropping the first when the chunk began mid-file —
 * a backwards read lands in the middle of a record as often as not, and half
 * a record parses as nothing anyway.
 */
function parse(chunk: string, partialStart: boolean): readonly LogRecord[] {
  const lines = chunk.split('\n')
  if (partialStart) lines.shift()
  const records: LogRecord[] = []
  for (const line of lines) {
    const record = decodeRecord(line)
    if (record !== null) records.push(record)
  }
  return records
}
