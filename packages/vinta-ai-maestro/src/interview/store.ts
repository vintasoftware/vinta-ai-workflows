/**
 * An interview on disk.
 *
 * ```
 * <interview-dir>/
 * ├── rounds/round-NN.json     ← the agent writes   (interview-round.v1)
 * ├── answers/round-NN.json    ← the server writes  (interview-answers.v1)
 * ├── docs/**                  ← explainer documents a round references
 * ├── server.json              ← pid, port and URL of the running server
 * └── server.log               ← the detached server's output
 * ```
 *
 * The directory is the whole protocol: the agent and the server share no
 * process and no socket, only these files. `wait` watches `answers/`, the
 * server watches `rounds/`, and a reader never sees a half-written file
 * because every write here is write-then-rename.
 *
 * Nothing in this module deletes a round or an answer. The interview files are
 * the working trail behind the artefact the calling skill produces, and they
 * are cheap to keep.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  InterviewAnswersSchema,
  InterviewRoundSchema,
  type InterviewAnswers,
  type InterviewRound,
} from './document.ts'
import type { InterviewState, RoundSummary } from './wire.ts'

export const ROUNDS_DIR = 'rounds'
export const ANSWERS_DIR = 'answers'
export const DOCS_DIR = 'docs'
export const SERVER_FILE = 'server.json'
export const SERVER_LOG = 'server.log'

/** Where an interview lives in a target project, under the toolchain's gitignored state dir. */
export const INTERVIEWS_ROOT = join('.vinta-ai-workflows', 'interviews')

/** Two digits at least, as the skills write them: `round-2.json` is a typo, not round two. */
const ROUND_FILE = /^round-(\d{2,})\.json$/

const pad = (n: number): string => String(n).padStart(2, '0')

export const roundPath = (dir: string, n: number): string =>
  join(dir, ROUNDS_DIR, `round-${pad(n)}.json`)
export const answersPath = (dir: string, n: number): string =>
  join(dir, ANSWERS_DIR, `round-${pad(n)}.json`)

export function ensureLayout(dir: string): void {
  for (const sub of [ROUNDS_DIR, ANSWERS_DIR, DOCS_DIR]) mkdirSync(join(dir, sub), { recursive: true })
}

/** Every `round-NN.json`, ascending. Only that spelling: `round-2.json` is not a round. */
export function listRounds(dir: string): number[] {
  const roundsDir = join(dir, ROUNDS_DIR)
  if (!existsSync(roundsDir)) return []
  return readdirSync(roundsDir)
    .map((name) => ROUND_FILE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((n) => n >= 1)
    .sort((a, b) => a - b)
}

export type DocumentRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'missing' }
  | { readonly ok: false; readonly reason: 'invalid_json' }
  | {
      readonly ok: false
      readonly reason: 'invalid_round' | 'invalid_answers'
      /** Paths and messages: where the document is wrong, never what it says. */
      readonly issues: readonly { readonly path: string; readonly message: string }[]
    }

function readDocument<T>(
  path: string,
  schema: z.ZodType<T>,
  invalid: 'invalid_round' | 'invalid_answers',
): DocumentRead<T> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      reason: invalid,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    }
  }
  return { ok: true, value: result.data }
}

export function readRound(dir: string, n: number): DocumentRead<InterviewRound> {
  const read = readDocument(roundPath(dir, n), InterviewRoundSchema, 'invalid_round')
  // The filename is the round's identity; a body that claims another number
  // would make `wait --round N` and the page disagree about which file this is.
  if (read.ok && read.value.round !== n) {
    return {
      ok: false,
      reason: 'invalid_round',
      issues: [{ path: 'round', message: `must be ${n}, the number in the filename` }],
    }
  }
  return read
}

export function readAnswers(dir: string, n: number): DocumentRead<InterviewAnswers> {
  return readDocument(answersPath(dir, n), InterviewAnswersSchema, 'invalid_answers')
}

/** Write-then-rename, so a reader never sees a half-written JSON file. */
export function writeJsonAtomic(path: string, data: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, mode === undefined ? {} : { mode })
  renameSync(tmp, path)
}

export function writeAnswers(dir: string, n: number, answers: InterviewAnswers): string {
  const path = answersPath(dir, n)
  writeJsonAtomic(path, answers)
  return path
}

export function hasAnswers(dir: string, n: number): boolean {
  return existsSync(answersPath(dir, n))
}

/** The page's picture of the interview: every round, which are answered, which is open. */
export function buildState(dir: string): InterviewState {
  const rounds: RoundSummary[] = listRounds(dir).map((n) => {
    const read = readRound(dir, n)
    const answered = hasAnswers(dir, n)
    if (read.ok) {
      return { round: n, title: read.value.interview.title, kind: read.value.kind, answered, error: null }
    }
    return {
      round: n,
      title: null,
      kind: null,
      answered,
      error: read.reason === 'invalid_json' ? 'invalid_json' : 'invalid_round',
    }
  })
  const open = rounds.filter((round) => !round.answered && round.error === null)
  const last = rounds[rounds.length - 1]
  return {
    rounds,
    latest: last === undefined ? null : last.round,
    current: open[0]?.round ?? null,
  }
}

/**
 * Resolves a document path inside `<dir>/docs`, or null when it would escape.
 *
 * Rounds reference documents as `docs/foo.md` (relative to the interview dir)
 * or `foo.md` (relative to `docs/`); both are accepted. The check is on the
 * resolved path, so `..` segments and encoded traversals are caught after
 * they are normalised rather than pattern-matched before.
 */
export function docPath(dir: string, rel: string): string | null {
  const docsRoot = resolve(dir, DOCS_DIR)
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const stripped = decoded.replace(/^\/+/, '').replace(/^docs\//, '')
  const full = resolve(docsRoot, normalize(stripped))
  if (full === docsRoot || !full.startsWith(docsRoot + sep)) return null
  return full
}

/** A regular file under `docs/`, or null. */
export function docFile(dir: string, rel: string): string | null {
  const full = docPath(dir, rel)
  if (full === null) return null
  try {
    return statSync(full).isFile() ? full : null
  } catch {
    return null
  }
}

/**
 * The running server, as `start`, `wait`, `status` and `stop` find it.
 *
 * The URL carries the token: it is how `start` reprints the page's address
 * when the server is already up, and how `wait` tells the person where to
 * answer. The file is written `0600` inside the gitignored interview
 * directory, and is the one place besides stdout the token is written.
 */
export const ServerRecordSchema = z.strictObject({
  pid: z.int().min(1),
  port: z.int().min(1).max(65_535),
  url: z.string().url(),
  started_at: z.iso.datetime(),
})
export type ServerRecord = z.infer<typeof ServerRecordSchema>

export const serverRecordPath = (dir: string): string => join(dir, SERVER_FILE)

export function readServerRecord(dir: string): ServerRecord | null {
  const read = readDocument(serverRecordPath(dir), ServerRecordSchema, 'invalid_answers')
  return read.ok ? read.value : null
}

export function writeServerRecord(dir: string, record: ServerRecord): void {
  writeJsonAtomic(serverRecordPath(dir), record, 0o600)
}

/** Removes the record, but only when it is this process's: a stale file is another server's to clear. */
export function removeServerRecord(dir: string, pid: number): void {
  const record = readServerRecord(dir)
  if (record !== null && record.pid !== pid) return
  rmSync(serverRecordPath(dir), { force: true })
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The live server, or null when there is none or its record is stale. */
export function liveServer(dir: string): ServerRecord | null {
  const record = readServerRecord(dir)
  return record !== null && isAlive(record.pid) ? record : null
}
