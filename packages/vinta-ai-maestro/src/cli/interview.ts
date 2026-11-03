/**
 * `vinta-ai-maestro interview` — a decision-heavy interview as a browser form.
 *
 * Chat is a poor surface for deciding: options arrive as one-line labels, the
 * context that made them meaningful scrolled away, and a diagram is
 * impossible. The interview page gives each decision the whole screen — what
 * the agent already knows, an explainer with diagrams, the options as cards
 * with their consequences — and keeps the chat for *questions* to the agent.
 *
 * The protocol is file-based, so it works under every harness and the agent
 * needs no tool of its own for it:
 *
 *   interview start  --dir <d>             serve the page, print its URL
 *   interview wait   --dir <d> --round N   block until answers/round-NN.json lands
 *   interview status --dir <d>             the server and the rounds, as JSON
 *   interview stop   --dir <d>             stop the server
 *   interview serve  --dir <d>             the server, in the foreground
 *
 * `start` spawns `serve` detached, the way `run` spawns a job, so the agent's
 * shell command returns and the server outlives it. `wait` never talks to the
 * server: it watches the answers directory, which is also what makes a
 * `status` after a crash honest — the files are the state.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { cliSpawner, type JobSpawner } from '../job/job.ts'
import {
  ANSWERS_DIR,
  answersPath,
  buildState,
  ensureLayout,
  isAlive,
  liveServer,
  readServerRecord,
  removeServerRecord,
  roundPath,
  SERVER_LOG,
  serverRecordPath,
  startInterviewServer,
  INTERVIEW_PAGE,
  writeServerRecord,
  type InterviewServer,
} from '../interview/index.ts'
import { TOKEN_QUERY } from '../daemon/auth.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { untilSignalled } from './serve.ts'

/** `wait` ran out of time. `timeout(1)`'s code, so a script can tell it from a failure. */
export const WAIT_TIMED_OUT = 124

export const INTERVIEW_USAGE = `usage: vinta-ai-maestro interview start  --dir <interview-dir> [--port <n>] [--no-open]
       vinta-ai-maestro interview wait   --dir <interview-dir> --round <n> [--timeout <seconds>]
       vinta-ai-maestro interview status --dir <interview-dir>
       vinta-ai-maestro interview stop   --dir <interview-dir>
       vinta-ai-maestro interview serve  --dir <interview-dir> [--port <n>]

  A decision-heavy interview as a browser form. The agent writes one round
  at a time as JSON — <interview-dir>/rounds/round-NN.json, the
  interview-round.v1 schema — the person answers it on the interview page,
  one decision per screen with the context, the explainers and each option's
  consequences in view, and the server writes
  <interview-dir>/answers/round-NN.json (interview-answers.v1). The chat
  inside the page is for questions to the agent, answered in the next round.

  start   Start the server for this interview in the background, print the
          page's URL and open it in the default browser (--no-open to skip).
          Running start again on a live server reprints the URL.
  wait    Block until answers/round-NN.json exists, then print its path.
          Exits 0 with the path; 124 after --timeout seconds (default 3600 —
          keep it under the ceiling the harness puts on one command, and run
          wait again); 1 when the round file is missing or no server is up.
  status  The server (alive, pid, port, URL) and every round with whether it
          is answered, as one JSON object.
  stop    Stop the server. The interview files stay where they are.
  serve   The server in the foreground; start runs this. Ctrl-C stops it.

  --dir <interview-dir>   Required. Where the interview lives; rounds/,
                          answers/ and docs/ are created when missing. The
                          convention is .vinta-ai-workflows/interviews/<slug>.
  --port <n>              Defaults to 0 — an OS-assigned port.
  --timeout <seconds>     wait only. Defaults to 3600.

  The server binds 127.0.0.1 only, serves documents only from
  <interview-dir>/docs/, and gates its API behind the token in the URL it
  prints. The URL is the credential: treat it as one.`

const DEFAULT_TIMEOUT_S = 3600
const START_DEADLINE_MS = 5_000
const POLL_MS = 500

export interface InterviewDeps {
  /** How `start` spawns `serve`. Defaults to re-executing this CLI, detached. */
  readonly spawn?: JobSpawner
  /** How `start` opens the browser. Defaults to the platform's opener. */
  readonly open?: (url: string) => void
  /** How long `serve` stays up. Defaults to "until a signal". */
  readonly wait?: (server: InterviewServer) => Promise<void>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  /** Where the bundle is read from. Defaults to this package's `dist/ui`. */
  readonly uiDir?: string
}

export async function interviewCommand(
  argv: readonly string[],
  io: Io,
  deps: InterviewDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'start':
      return await startCommand(rest, io, deps)
    case 'serve':
      return await serveCommand(rest, io, deps)
    case 'wait':
      return await waitCommand(rest, io, deps)
    case 'status':
      return statusCommand(rest, io)
    case 'stop':
      return await stopCommand(rest, io, deps)
    default:
      io.err(INTERVIEW_USAGE)
      return USAGE
  }
}

interface Parsed {
  readonly dir: string
  readonly port: number | undefined
  readonly round: number | undefined
  readonly timeoutS: number | undefined
  readonly open: boolean
}

function parse(argv: readonly string[], io: Io): Parsed | null {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        dir: { type: 'string', short: 'd' },
        port: { type: 'string', short: 'p' },
        round: { type: 'string', short: 'r' },
        timeout: { type: 'string', short: 't' },
        'no-open': { type: 'boolean' },
      },
      allowPositionals: false,
    })
  } catch {
    io.err(INTERVIEW_USAGE)
    return null
  }
  const { values } = parsed
  if (values.dir === undefined) {
    io.err('vinta-ai-maestro: --dir <interview-dir> is required')
    return null
  }
  let port: number | undefined
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      io.err('vinta-ai-maestro: --port must be an integer between 0 and 65535')
      return null
    }
  }
  let round: number | undefined
  if (values.round !== undefined) {
    round = Number(values.round)
    if (!Number.isInteger(round) || round < 1) {
      io.err('vinta-ai-maestro: --round must be a positive integer')
      return null
    }
  }
  let timeoutS: number | undefined
  if (values.timeout !== undefined) {
    timeoutS = Number(values.timeout)
    if (!Number.isFinite(timeoutS) || timeoutS < 0 || timeoutS > 24 * 3600) {
      io.err('vinta-ai-maestro: --timeout must be a number of seconds, up to a day')
      return null
    }
  }
  return { dir: resolve(values.dir), port, round, timeoutS, open: values['no-open'] !== true }
}

/** The page's address with the token — the one line that carries it. */
const pageUrl = (server: InterviewServer): string =>
  `${server.url}${INTERVIEW_PAGE}?${TOKEN_QUERY}=${server.token}`

async function serveCommand(argv: readonly string[], io: Io, deps: InterviewDeps): Promise<number> {
  const parsed = parse(argv, io)
  if (parsed === null) return USAGE
  ensureLayout(parsed.dir)
  const live = liveServer(parsed.dir)
  if (live !== null) {
    io.err(`vinta-ai-maestro: an interview server is already running for this directory (pid ${live.pid})`)
    return FAILED
  }

  let server: InterviewServer
  try {
    server = await startInterviewServer({
      dir: parsed.dir,
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
      ...(deps.uiDir === undefined ? {} : { uiDir: deps.uiDir }),
    })
  } catch {
    io.err(`vinta-ai-maestro: could not bind 127.0.0.1:${parsed.port ?? 0}`)
    return FAILED
  }

  writeServerRecord(parsed.dir, {
    pid: process.pid,
    port: server.port,
    url: pageUrl(server),
    started_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
  })
  io.out(`vinta-ai-maestro: interview server listening on ${server.url} (pid ${process.pid})`)
  io.out('Open this URL. It carries the access token, so treat it as a secret:')
  io.out(`  ${pageUrl(server)}`)

  try {
    await (deps.wait ?? (() => untilSignalled().signalled))(server)
  } finally {
    removeServerRecord(parsed.dir, process.pid)
    await server.close()
  }
  return OK
}

async function startCommand(argv: readonly string[], io: Io, deps: InterviewDeps): Promise<number> {
  const parsed = parse(argv, io)
  if (parsed === null) return USAGE
  ensureLayout(parsed.dir)
  const open = deps.open ?? openBrowser

  const live = liveServer(parsed.dir)
  if (live !== null) {
    io.out(`vinta-ai-maestro: interview server already running (pid ${live.pid})`)
    io.out(`  ${live.url}`)
    if (parsed.open) open(live.url)
    return OK
  }

  const args = ['interview', 'serve', '--dir', parsed.dir]
  if (parsed.port !== undefined) args.push('--port', String(parsed.port))
  const logPath = join(parsed.dir, SERVER_LOG)
  const child = (deps.spawn ?? cliSpawner())(args, logPath, process.cwd())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = deps.now ?? Date.now

  const deadline = now() + START_DEADLINE_MS
  while (now() < deadline) {
    const record = readServerRecord(parsed.dir)
    if (record !== null && record.pid === child.pid && isAlive(record.pid)) {
      io.out(`vinta-ai-maestro: interview server started (pid ${record.pid})`)
      io.out('Open this URL. It carries the access token, so treat it as a secret:')
      io.out(`  ${record.url}`)
      if (parsed.open) open(record.url)
      return OK
    }
    await sleep(100)
  }
  io.err(`vinta-ai-maestro: the interview server did not come up; see ${logPath}`)
  return FAILED
}

async function waitCommand(argv: readonly string[], io: Io, deps: InterviewDeps): Promise<number> {
  const parsed = parse(argv, io)
  if (parsed === null) return USAGE
  if (parsed.round === undefined) {
    io.err('vinta-ai-maestro: --round <n> is required')
    return USAGE
  }
  const target = answersPath(parsed.dir, parsed.round)
  if (!existsSync(roundPath(parsed.dir, parsed.round))) {
    io.err(`vinta-ai-maestro: round file missing: ${roundPath(parsed.dir, parsed.round)}`)
    return FAILED
  }
  const live = liveServer(parsed.dir)
  if (live === null) {
    io.err('vinta-ai-maestro: no interview server is running — run `interview start` first')
    return FAILED
  }

  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const timeoutS = parsed.timeoutS ?? DEFAULT_TIMEOUT_S
  const deadline = now() + timeoutS * 1000
  io.err(`waiting for ${target}`)
  io.err(`the person answers at ${live.url}`)

  // A file event ends a sleep early; the poll is what makes a missed event cost
  // half a second rather than the round.
  let woke: (() => void) | null = null
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(join(parsed.dir, ANSWERS_DIR), () => woke?.())
    watcher.on('error', () => {})
  } catch {
    // Polling covers it.
  }
  try {
    for (;;) {
      if (existsSync(target)) {
        io.out(target)
        return OK
      }
      if (now() >= deadline) {
        io.err(`vinta-ai-maestro: timed out after ${timeoutS}s; run wait again`)
        return WAIT_TIMED_OUT
      }
      await Promise.race([
        sleep(POLL_MS),
        new Promise<void>((resolve) => {
          woke = resolve
        }),
      ])
      woke = null
    }
  } finally {
    watcher?.close()
  }
}

function statusCommand(argv: readonly string[], io: Io): number {
  const parsed = parse(argv, io)
  if (parsed === null) return USAGE
  const live = liveServer(parsed.dir)
  io.out(
    JSON.stringify(
      {
        dir: parsed.dir,
        server: live === null ? { alive: false } : { alive: true, ...live },
        ...buildState(parsed.dir),
      },
      null,
      2,
    ),
  )
  return OK
}

async function stopCommand(argv: readonly string[], io: Io, deps: InterviewDeps): Promise<number> {
  const parsed = parse(argv, io)
  if (parsed === null) return USAGE
  const record = readServerRecord(parsed.dir)
  if (record === null || !isAlive(record.pid)) {
    io.out('not running')
    if (record !== null) removeServerRecord(parsed.dir, record.pid)
    return OK
  }
  try {
    process.kill(record.pid, 'SIGTERM')
  } catch {
    // Gone between the check and the signal.
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = deps.now ?? Date.now
  const deadline = now() + START_DEADLINE_MS
  while (isAlive(record.pid) && now() < deadline) await sleep(100)
  if (isAlive(record.pid)) {
    io.err(`vinta-ai-maestro: pid ${record.pid} did not exit`)
    return FAILED
  }
  // The server removes its own record on the way out; a crashed one did not.
  if (existsSync(serverRecordPath(parsed.dir))) removeServerRecord(parsed.dir, record.pid)
  io.out(`stopped pid ${record.pid}`)
  return OK
}

/** The default browser, or nothing: in a headless session the printed URL is the whole answer. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // No desktop session.
  }
}
