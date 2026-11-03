/**
 * The interview server: the page, the rounds, the answers, the documents.
 *
 * One of these per interview, started by `vinta-ai-maestro interview start`
 * and stopped by `interview stop`. It hosts no run and reads no journal; its
 * whole world is one interview directory (`store.ts`). What it serves:
 *
 * - the app bundle, `interview.html` and its assets out of `dist/ui` — the
 *   same bundle `ui` serves, so the page is the design system's;
 * - `GET  /api/interview/state`, every round and which are answered;
 * - `GET  /api/interview/rounds/:n`, a round as the agent wrote it;
 * - `GET  /api/interview/answers/:n` and `POST …/answers/:n`, the answers —
 *   validated against `interview-answers.v1`, checked against the round they
 *   answer, written once;
 * - `GET  /api/interview/docs/<path>`, a document under the interview's
 *   `docs/` and nothing outside it;
 * - `GET  /api/interview/events`, server-sent state so the page switches to
 *   the next round the moment the agent writes it.
 *
 * §11 applies as it does to the daemon: loopback by default, the token on
 * every API request (header or query — the page's iframes and event stream
 * cannot set a header), the bundle itself unauthenticated for the reasons
 * `daemon/static.ts` gives, and nothing from a round or a document in a log
 * line or an error body.
 */
import { createReadStream, statSync, watch, type FSWatcher } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createToken, presentedToken, tokenMatches } from '../daemon/auth.ts'
import { LOOPBACK, respond } from '../daemon/bridge.ts'
import { createStaticHandler, DEFAULT_UI_DIR } from '../daemon/static.ts'
import { nullLogger, type Logger } from '../log/index.ts'
import { InterviewAnswersSchema, type InterviewAnswers } from './document.ts'
import {
  ANSWERS_DIR,
  buildState,
  docFile,
  docPath,
  ensureLayout,
  hasAnswers,
  readAnswers,
  readRound,
  ROUNDS_DIR,
  writeAnswers,
} from './store.ts'

/** The page, relative to the bundle. `/` redirects here with the query kept. */
export const INTERVIEW_PAGE = '/interview.html'
export const API_PREFIX = '/api/interview'

/** How often the event stream re-reads the directory when no file event woke it. */
const DEFAULT_POLL_MS = 1_500
/** A comment frame keeps a proxy from closing an idle stream. */
const PING_MS = 25_000
/** `interview-answers.v1` is prose; this is well above any round's worth of it. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

const DOC_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

/** The round number in a path segment, or null for anything that is not one. */
export function roundNumber(segment: string | undefined): number | null {
  if (segment === undefined || !/^\d{1,4}$/.test(segment)) return null
  const n = Number(segment)
  return n >= 1 ? n : null
}

/**
 * Something to wait on that any writer can wake.
 *
 * The event stream sleeps on this between polls; a file event or a submit
 * through this process wakes every sleeper at once, so the page sees a new
 * round within a few milliseconds of the agent writing it rather than at the
 * next poll.
 */
class Wake {
  readonly #waiters = new Set<() => void>()

  signal(): void {
    for (const waiter of this.#waiters) waiter()
    this.#waiters.clear()
  }

  /** Resolves on the next signal or after `ms`, whichever is first. */
  next(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(done)
        resolve()
      }, ms)
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.#waiters.add(done)
    })
  }
}

export interface InterviewAppOptions {
  readonly dir: string
  readonly token: string
  readonly uiDir?: string
  readonly logger?: Logger
  readonly pollMs?: number
  /** Wakes the event streams. The server passes its own; a test may pass none. */
  readonly wake?: Wake
  readonly now?: () => Date
}

export function createInterviewApp(options: InterviewAppOptions): Hono {
  const { dir, token } = options
  const log = options.logger ?? nullLogger()
  const ui = createStaticHandler(options.uiDir ?? DEFAULT_UI_DIR)
  const wake = options.wake ?? new Wake()
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const now = options.now ?? (() => new Date())
  const app = new Hono()

  // The page. The query is kept because the token rides in it.
  app.get('/', (c) => c.redirect(`${INTERVIEW_PAGE}${new URL(c.req.url).search}`, 302))

  // The bundle, before the token check and only ever before it — the same
  // boundary `daemon/api.ts` draws, for the reasons `daemon/static.ts` gives.
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) return await next()
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD') return await next()
    return ui(path, method)
  })

  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const presented = presentedToken(c.req.header('authorization'), new URL(c.req.url))
    if (!tokenMatches(token, presented)) {
      log.warn('interview.unauthorized', { path: new URL(c.req.url).pathname })
      return c.json({ error: 'unauthorized', issues: null }, 401)
    }
    await next()
  })

  app.get(`${API_PREFIX}/state`, (c) => c.json(buildState(dir)))

  app.get(`${API_PREFIX}/rounds/:n`, (c) => {
    const n = roundNumber(c.req.param('n'))
    if (n === null) return c.json({ error: 'bad_round', issues: null }, 400)
    const read = readRound(dir, n)
    if (read.ok) return c.json(read.value)
    if (read.reason === 'missing') return c.json({ error: 'unknown_round', issues: null }, 404)
    if (read.reason === 'invalid_json') return c.json({ error: 'invalid_json', issues: null }, 422)
    return c.json({ error: read.reason, issues: read.issues }, 422)
  })

  app.get(`${API_PREFIX}/answers/:n`, (c) => {
    const n = roundNumber(c.req.param('n'))
    if (n === null) return c.json({ error: 'bad_round', issues: null }, 400)
    const read = readAnswers(dir, n)
    if (read.ok) return c.json(read.value)
    if (read.reason === 'missing') return c.json({ error: 'unknown_answers', issues: null }, 404)
    if (read.reason === 'invalid_json') return c.json({ error: 'invalid_json', issues: null }, 422)
    return c.json({ error: read.reason, issues: read.issues }, 422)
  })

  app.post(`${API_PREFIX}/answers/:n`, async (c) => {
    const n = roundNumber(c.req.param('n'))
    if (n === null) return c.json({ error: 'bad_round', issues: null }, 400)
    const round = readRound(dir, n)
    if (!round.ok) {
      return round.reason === 'missing'
        ? c.json({ error: 'unknown_round', issues: null }, 404)
        : c.json({ error: 'invalid_round', issues: null }, 422)
    }
    // Written once. The agent may already be reading the file `wait` handed
    // it; a second submission would change it under them.
    if (hasAnswers(dir, n)) return c.json({ error: 'already_submitted', issues: null }, 409)

    const length = Number(c.req.header('content-length') ?? '0')
    if (length > MAX_BODY_BYTES) return c.json({ error: 'body_too_large', issues: null }, 413)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', issues: null }, 400)
    }
    const parsed = InterviewAnswersSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_answers',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        },
        400,
      )
    }
    if (parsed.data.round !== n) return c.json({ error: 'round_mismatch', issues: null }, 400)
    // Every answer names a decision the round asked. Ids only — never the text.
    const asked = new Set(round.value.groups.flatMap((group) => group.decisions.map((d) => d.id)))
    const unknown = parsed.data.answers.find((answer) => !asked.has(answer.decision_id))
    if (unknown !== undefined) {
      return c.json(
        { error: 'unknown_decision', issues: [{ path: 'answers', message: unknown.decision_id }] },
        400,
      )
    }

    const answers: InterviewAnswers = {
      ...parsed.data,
      interview: round.value.interview.slug,
      submitted_at: now().toISOString(),
    }
    const path = writeAnswers(dir, n, answers)
    log.info('interview.answered', { round: n })
    wake.signal()
    return c.json({ ok: true, path })
  })

  app.get(`${API_PREFIX}/docs/*`, (c) => {
    const rel = new URL(c.req.url).pathname.slice(`${API_PREFIX}/docs/`.length)
    if (docPath(dir, rel) === null) {
      log.warn('interview.doc_refused', { reason: 'outside_docs' })
      return c.json({ error: 'forbidden', issues: null }, 403)
    }
    const file = docFile(dir, rel)
    if (file === null) return c.json({ error: 'unknown_doc', issues: null }, 404)
    const type = DOC_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(statSync(file).size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }
    // An HTML explainer is the agent's page, shown in a sandboxed iframe. The
    // header says the same for a tab that opens it directly, so it can never
    // read the interview API with the token the page holds.
    if (type.startsWith('text/html')) headers['content-security-policy'] = 'sandbox allow-scripts allow-popups'
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers })
  })

  app.get(`${API_PREFIX}/events`, (c) =>
    streamSSE(c, async (stream) => {
      let last = ''
      let lastWrite = Date.now()
      const send = async (): Promise<void> => {
        const state = JSON.stringify(buildState(dir))
        if (state === last) return
        last = state
        lastWrite = Date.now()
        await stream.writeSSE({ event: 'state', data: state })
      }
      await send()
      while (!stream.aborted) {
        await wake.next(pollMs)
        if (stream.aborted) break
        await send()
        if (Date.now() - lastWrite >= PING_MS) {
          lastWrite = Date.now()
          await stream.write(': ping\n\n')
        }
      }
    }),
  )

  return app
}

export interface InterviewServerOptions {
  readonly dir: string
  /** Defaults to `127.0.0.1`. */
  readonly host?: string
  /** Defaults to `0` — an OS-assigned port. */
  readonly port?: number
  /** Defaults to a fresh 256-bit random token. Supplying one is for tests. */
  readonly token?: string
  readonly uiDir?: string
  readonly logger?: Logger
  readonly pollMs?: number
}

export interface InterviewServer {
  /** `http://host:port`, without the token. */
  readonly url: string
  readonly host: string
  readonly port: number
  /** Required on every API request. Never logged (§11). */
  readonly token: string
  close(): Promise<void>
}

export async function startInterviewServer(options: InterviewServerOptions): Promise<InterviewServer> {
  const { dir } = options
  ensureLayout(dir)
  const host = options.host ?? LOOPBACK
  const token = options.token ?? createToken()
  const log = options.logger ?? nullLogger()
  const wake = new Wake()

  const app = createInterviewApp({
    dir,
    token,
    wake,
    ...(options.uiDir === undefined ? {} : { uiDir: options.uiDir }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    logger: log,
  })

  // Best effort: `fs.watch` is not recursive everywhere and not reliable on
  // every filesystem. The event stream polls as well, so a missed event costs
  // one poll interval, not a stuck page.
  const watchers: FSWatcher[] = []
  for (const sub of [ROUNDS_DIR, ANSWERS_DIR]) {
    try {
      const watcher = watch(join(dir, sub), () => wake.signal())
      watcher.on('error', () => {})
      watchers.push(watcher)
    } catch {
      // Polling covers it.
    }
  }

  const server = createServer((req, res) => void respond(app, req, res, log))
  server.on('error', (error) => log.error('interview.server_error', { kind: error.name }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('interview server: listener did not report a port')
  }
  log.info('interview.listening', { host: address.address, port: address.port })

  return {
    url: `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`,
    host: address.address,
    port: address.port,
    token,
    async close(): Promise<void> {
      for (const watcher of watchers) watcher.close()
      wake.signal()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}
