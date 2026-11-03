/**
 * The browser interview (§20): the documents, the store, the server, and the
 * `interview` command.
 *
 * The server is tested over a real listener with `fetch`, because what it has
 * to prove is about the wire — a token on every API request, a document that
 * cannot escape `docs/`, answers written once and validated against the round
 * they answer. The command is invoked as a function with an injected `Io`,
 * like every other command here, so the lines it prints can be asserted
 * exactly: the page's URL, with its token, in the one place it is meant to be.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { interviewCommand, WAIT_TIMED_OUT } from '../src/cli/interview.ts'
import { FAILED, OK, USAGE, type Io } from '../src/cli/io.ts'
import { main } from '../src/cli/index.ts'
import {
  answersPath,
  buildState,
  docPath,
  InterviewAnswersSchema,
  InterviewRoundSchema,
  listRounds,
  readRound,
  readServerRecord,
  roundPath,
  serializeInterviewAnswersSchema,
  serializeInterviewRoundSchema,
  startInterviewServer,
  writeServerRecord,
  type InterviewRound,
  type InterviewServer,
} from '../src/interview/index.ts'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const SCHEMAS = join(REPO_ROOT, 'schemas')
const EXAMPLE = join(
  REPO_ROOT,
  'skills',
  'vinta-derive-skills',
  'resources',
  'foundation-skills',
  'interview-ui',
  'resources',
  'examples',
  'round-01.json',
)

const temps: string[] = []
const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-interview-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A bundle directory with the two pages, so the static handler has something to serve. */
function fakeUi(): string {
  const dir = join(makeTemp(), 'ui')
  mkdirSync(dir)
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>runs</title>')
  writeFileSync(join(dir, 'interview.html'), '<!doctype html><title>interview</title>')
  return dir
}

function round(n = 1, overrides: Partial<InterviewRound> = {}): InterviewRound {
  return InterviewRoundSchema.parse({
    schema_version: 1,
    round: n,
    interview: { slug: 'order-tags', title: 'Order tags — spec interview', skill: 'create-spec' },
    intro: 'Round one.',
    groups: [
      {
        id: 'A',
        title: 'Problem & customer',
        decisions: [
          {
            id: 'A1',
            title: 'Who is the primary user?',
            short: 'Primary user',
            input: {
              type: 'single',
              options: [
                { value: 'ops', label: 'Ops', recommended: true },
                { value: 'tenants', label: 'Tenant admins' },
              ],
              allow_other: true,
            },
          },
          {
            id: 'A2',
            title: 'What do they do today?',
            required: false,
            input: { type: 'text', label: 'Describe it' },
          },
        ],
      },
    ],
    ...overrides,
  })
}

function writeRound(dir: string, n: number, body: unknown = round(n)): void {
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(roundPath(dir, n), typeof body === 'string' ? body : JSON.stringify(body))
}

function answers(n = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    round: n,
    answers: [
      { decision_id: 'A1', status: 'answered', values: ['ops'], note: 'ops first' },
      { decision_id: 'A2', status: 'skipped' },
    ],
    questions: [{ id: 'q1', decision_id: 'A1', body: 'Can both be true?' }],
    ...overrides,
  }
}

interface Recorder {
  readonly io: Io
  readonly out: string[]
  readonly err: string[]
}

function recorder(): Recorder {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: { out: (line) => out.push(line), err: (line) => err.push(line), confirm: async () => true },
  }
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

describe('the interview documents', () => {
  it('are the source of the two committed JSON Schemas', () => {
    expect(readFileSync(join(SCHEMAS, 'interview-round.v1.schema.json'), 'utf8')).toBe(
      serializeInterviewRoundSchema(),
    )
    expect(readFileSync(join(SCHEMAS, 'interview-answers.v1.schema.json'), 'utf8')).toBe(
      serializeInterviewAnswersSchema(),
    )
  })

  it('accept the example round the interview-ui skill ships', () => {
    const example = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as unknown
    const parsed = InterviewRoundSchema.safeParse(example)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // Defaults are filled on the way in, so the page never has to guess.
      expect(parsed.data.kind).toBe('questions')
      expect(parsed.data.groups[0]?.decisions[0]?.required).toBe(true)
      expect(parsed.data.groups[0]?.decisions[0]?.waivable).toBe(true)
    }
  })

  it('refuse an explainer that names both inline markdown and a path, and a path outside docs', () => {
    const both = round(1)
    const decision = both.groups[0]?.decisions[0]
    expect(decision).toBeDefined()
    expect(
      InterviewRoundSchema.safeParse({
        ...both,
        groups: [{ ...both.groups[0], decisions: [{ ...decision, explainer: { markdown: 'x', path: 'docs/a.md' } }] }],
      }).success,
    ).toBe(false)
    expect(
      InterviewRoundSchema.safeParse({
        ...both,
        groups: [{ ...both.groups[0], decisions: [{ ...decision, explainer: { path: 'docs/a.txt' } }] }],
      }).success,
    ).toBe(false)
  })

  it('refuse an answer with an unknown status or an unknown key', () => {
    expect(InterviewAnswersSchema.safeParse(answers(1, { answers: [{ decision_id: 'A1', status: 'maybe' }] })).success).toBe(false)
    expect(InterviewAnswersSchema.safeParse(answers(1, { extra: true })).success).toBe(false)
    expect(InterviewAnswersSchema.safeParse(answers()).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('the interview store', () => {
  it('lists only round-NN.json files, and reports a broken one without its contents', () => {
    const dir = makeTemp()
    writeRound(dir, 1)
    writeRound(dir, 2, '{ not json')
    writeRound(dir, 3, { ...round(3), groups: [] })
    mkdirSync(join(dir, 'rounds'), { recursive: true })
    writeFileSync(join(dir, 'rounds', 'round-4.json'), '{}')
    writeFileSync(join(dir, 'rounds', 'notes.json'), '{}')
    expect(listRounds(dir)).toEqual([1, 2, 3])

    const state = buildState(dir)
    expect(state.rounds.map((r) => [r.round, r.error, r.answered])).toEqual([
      [1, null, false],
      [2, 'invalid_json', false],
      [3, 'invalid_round', false],
    ])
    expect(state.latest).toBe(3)
    expect(state.current).toBe(1)
    const read = readRound(dir, 3)
    expect(read.ok).toBe(false)
    if (!read.ok && read.reason === 'invalid_round') {
      expect(read.issues[0]?.path).toBe('groups')
      expect(JSON.stringify(read.issues)).not.toContain('Order tags')
    }
  })

  it('refuses a round whose body disagrees with its filename', () => {
    const dir = makeTemp()
    writeRound(dir, 2, round(1))
    const read = readRound(dir, 2)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toBe('invalid_round')
  })

  it('resolves documents inside docs/ only', () => {
    const dir = makeTemp()
    expect(docPath(dir, 'docs/D4.md')).toBe(join(dir, 'docs', 'D4.md'))
    expect(docPath(dir, 'D4.md')).toBe(join(dir, 'docs', 'D4.md'))
    expect(docPath(dir, 'sub/D4.md')).toBe(join(dir, 'docs', 'sub', 'D4.md'))
    expect(docPath(dir, '../rounds/round-01.json')).toBe(null)
    expect(docPath(dir, '%2e%2e/rounds/round-01.json')).toBe(null)
    expect(docPath(dir, 'docs/../../server.json')).toBe(null)
    expect(docPath(dir, '')).toBe(null)
    expect(docPath(dir, 'a\\b.md')).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

describe('the interview server', () => {
  const servers: InterviewServer[] = []
  afterAll(async () => {
    for (const server of servers) await server.close()
  })

  async function up(dir: string): Promise<InterviewServer> {
    const server = await startInterviewServer({ dir, uiDir: fakeUi(), pollMs: 50 })
    servers.push(server)
    return server
  }

  const get = (server: InterviewServer, path: string, token = server.token) =>
    fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const post = (server: InterviewServer, path: string, body: unknown, token = server.token) =>
    fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('serves the page unauthenticated and refuses the API without the token', async () => {
    const dir = makeTemp()
    const server = await up(dir)
    expect(server.host).toBe('127.0.0.1')

    const page = await fetch(`${server.url}/interview.html`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('interview')
    // `/` is the page too, with the query — and its token — kept.
    const root = await fetch(`${server.url}/?token=abc`, { redirect: 'manual' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/interview.html?token=abc')

    expect((await fetch(`${server.url}/api/interview/state`)).status).toBe(401)
    expect((await get(server, '/api/interview/state', 'wrong')).status).toBe(401)
    // The query is accepted too: an event stream and an iframe cannot set a header.
    expect((await fetch(`${server.url}/api/interview/state?token=${server.token}`)).status).toBe(200)
  })

  it('reports state, serves rounds, and answers a round once', async () => {
    const dir = makeTemp()
    const server = await up(dir)
    expect(await (await get(server, '/api/interview/state')).json()).toEqual({ rounds: [], latest: null, current: null })
    expect((await get(server, '/api/interview/rounds/1')).status).toBe(404)

    writeRound(dir, 1)
    const served = (await (await get(server, '/api/interview/rounds/1')).json()) as InterviewRound
    expect(served.interview.slug).toBe('order-tags')
    expect(served.kind).toBe('questions')
    expect((await get(server, '/api/interview/answers/1')).status).toBe(404)

    // Refusals: a decision the round did not ask, the wrong round, a bad body.
    expect((await post(server, '/api/interview/answers/1', answers(1, { answers: [{ decision_id: 'Z9', status: 'waived' }] }))).status).toBe(400)
    expect((await post(server, '/api/interview/answers/1', answers(2))).status).toBe(400)
    expect((await post(server, '/api/interview/answers/1', { schema_version: 1 })).status).toBe(400)
    expect((await post(server, '/api/interview/answers/2', answers(2))).status).toBe(404)

    const accepted = await post(server, '/api/interview/answers/1', answers())
    expect(accepted.status).toBe(200)
    const body = (await accepted.json()) as { ok: true; path: string }
    expect(body.path).toBe(answersPath(dir, 1))
    const written = InterviewAnswersSchema.parse(JSON.parse(readFileSync(answersPath(dir, 1), 'utf8')))
    expect(written.interview).toBe('order-tags')
    expect(written.submitted_at).toBeDefined()
    expect(written.answers[0]?.note).toBe('ops first')

    // Once. The agent may already be reading it.
    expect((await post(server, '/api/interview/answers/1', answers())).status).toBe(409)
    expect((await (await get(server, '/api/interview/answers/1')).json()) as unknown).toMatchObject({ round: 1 })

    const state = (await (await get(server, '/api/interview/state')).json()) as { current: number | null; latest: number }
    expect(state.current).toBe(null)
    expect(state.latest).toBe(1)
  })

  it('says why a round cannot be served, without quoting it', async () => {
    const dir = makeTemp()
    const server = await up(dir)
    writeRound(dir, 1, '{ "secret": not json')
    const broken = await get(server, '/api/interview/rounds/1')
    expect(broken.status).toBe(422)
    const text = await broken.text()
    expect(text).toContain('invalid_json')
    expect(text).not.toContain('secret')
  })

  it('serves documents from docs/ only, HTML sandboxed', async () => {
    const dir = makeTemp()
    const server = await up(dir)
    mkdirSync(join(dir, 'docs', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'D4.md'), '# Concurrency\n')
    writeFileSync(join(dir, 'docs', 'deep', 'page.html'), '<p>hi</p>')
    writeFileSync(join(dir, 'server.json'), '{}')

    const md = await get(server, '/api/interview/docs/docs/D4.md')
    expect(md.status).toBe(200)
    expect(md.headers.get('content-type')).toContain('text/markdown')
    expect(await md.text()).toBe('# Concurrency\n')
    expect((await get(server, '/api/interview/docs/D4.md')).status).toBe(200)

    const html = await get(server, '/api/interview/docs/deep/page.html')
    expect(html.status).toBe(200)
    expect(html.headers.get('content-security-policy')).toContain('sandbox')

    expect((await get(server, '/api/interview/docs/missing.md')).status).toBe(404)
    expect((await get(server, '/api/interview/docs/..%2Fserver.json')).status).toBe(403)
    expect((await get(server, '/api/interview/docs/docs%2F..%2F..%2Fserver.json')).status).toBe(403)
    // `%2e%2e` is a dot segment to the URL parser: it is collapsed before any
    // route sees it, so the request lands outside `docs/` and is unknown there.
    expect([403, 404]).toContain((await get(server, '/api/interview/docs/%2e%2e/server.json')).status)
  })

  it('streams state as rounds and answers land', async () => {
    const dir = makeTemp()
    const server = await up(dir)
    const response = await fetch(`${server.url}/api/interview/events?token=${server.token}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (reader === undefined) return
    const decoder = new TextDecoder()
    let buffer = ''
    const until = async (predicate: (text: string) => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000
      while (!predicate(buffer)) {
        if (Date.now() > deadline) throw new Error(`event stream never showed what was expected:\n${buffer}`)
        const chunk = await reader.read()
        if (chunk.done) throw new Error('event stream ended')
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    }
    await until((text) => text.includes('"rounds":[]'))
    writeRound(dir, 1)
    await until((text) => text.includes('"current":1'))
    await post(server, '/api/interview/answers/1', answers())
    await until((text) => text.includes('"answered":true'))
    await reader.cancel()
  })
})

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe('vinta-ai-maestro interview', () => {
  it('is registered, with its own usage', async () => {
    const rec = recorder()
    expect(await main(['interview', '--help'], rec.io)).toBe(OK)
    expect(rec.out.join('\n')).toContain('interview start')
    const bad = recorder()
    expect(await main(['interview', 'dance'], bad.io)).toBe(USAGE)
    const noDir = recorder()
    expect(await main(['interview', 'status'], noDir.io)).toBe(USAGE)
    expect(noDir.err.join('\n')).toContain('--dir')
  })

  it('serves, is waited on, reports status, and stops — the token printed once per command', async () => {
    const dir = join(makeTemp(), 'order-tags')
    writeRound(dir, 1)
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let server: InterviewServer | null = null
    const serve = recorder()
    const serving = interviewCommand(['serve', '--dir', dir], serve.io, {
      uiDir: fakeUi(),
      wait: async (started) => {
        server = started
        await released
      },
    })
    const deadline = Date.now() + 5_000
    while (readServerRecord(dir) === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    const record = readServerRecord(dir)
    expect(record).not.toBe(null)
    expect(record?.pid).toBe(process.pid)
    expect(server).not.toBe(null)
    const live = server as unknown as InterviewServer
    // The URL, with the token, on stdout and nowhere on stderr.
    expect(serve.out.filter((line) => line.includes(live.token))).toHaveLength(1)
    expect(serve.out.join('\n')).toContain(`/interview.html?token=${live.token}`)
    expect(serve.err.join('\n')).not.toContain(live.token)
    expect(record?.url).toBe(`${live.url}/interview.html?token=${live.token}`)

    // A second server for the same directory is refused.
    const second = recorder()
    expect(await interviewCommand(['serve', '--dir', dir], second.io, { uiDir: fakeUi() })).toBe(FAILED)
    expect(second.err.join('\n')).toContain('already running')

    // `start` on a live server reprints the URL and does not spawn.
    const start = recorder()
    let opened: string | null = null
    expect(
      await interviewCommand(['start', '--dir', dir], start.io, {
        open: (url) => {
          opened = url
        },
        spawn: () => {
          throw new Error('must not spawn')
        },
      }),
    ).toBe(OK)
    expect(start.out.join('\n')).toContain('already running')
    expect(opened).toBe(record?.url)

    const status = recorder()
    expect(await interviewCommand(['status', '--dir', dir], status.io)).toBe(OK)
    const reported = JSON.parse(status.out.join('\n')) as { server: { alive: boolean }; current: number | null }
    expect(reported.server.alive).toBe(true)
    expect(reported.current).toBe(1)

    // `wait` returns once the answers land, and times out otherwise.
    const timedOut = recorder()
    expect(await interviewCommand(['wait', '--dir', dir, '--round', '1', '--timeout', '0'], timedOut.io)).toBe(WAIT_TIMED_OUT)
    expect(timedOut.err.join('\n')).toContain(live.url)
    const missingRound = recorder()
    expect(await interviewCommand(['wait', '--dir', dir, '--round', '7'], missingRound.io)).toBe(FAILED)

    const waiting = recorder()
    const waited = interviewCommand(['wait', '--dir', dir, '--round', '1', '--timeout', '10'], waiting.io)
    await new Promise((r) => setTimeout(r, 100))
    const accepted = await fetch(`${live.url}/api/interview/answers/1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${live.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(answers()),
    })
    expect(accepted.status).toBe(200)
    expect(await waited).toBe(OK)
    expect(waiting.out).toEqual([answersPath(dir, 1)])

    release()
    expect(await serving).toBe(OK)
    expect(readServerRecord(dir)).toBe(null)

    // Nothing to stop any more, and `wait` says so rather than hanging.
    const stopped = recorder()
    expect(await interviewCommand(['stop', '--dir', dir], stopped.io)).toBe(OK)
    expect(stopped.out).toEqual(['not running'])
    const noServer = recorder()
    expect(await interviewCommand(['wait', '--dir', dir, '--round', '1'], noServer.io)).toBe(FAILED)
    expect(noServer.err.join('\n')).toContain('interview start')
  })

  it('start spawns serve detached and reports the URL once the record appears', async () => {
    const dir = join(makeTemp(), 'order-tags')
    const start = recorder()
    const spawned: string[][] = []
    let opened: string | null = null
    const code = await interviewCommand(['start', '--dir', dir, '--port', '0', '--no-open'], start.io, {
      open: (url) => {
        opened = url
      },
      spawn: (args, logPath) => {
        spawned.push([...args])
        expect(logPath).toBe(join(dir, 'server.log'))
        // The "child": a record written by this process, as `serve` would.
        setTimeout(() => {
          writeServerRecord(dir, {
            pid: process.pid,
            port: 4321,
            url: 'http://127.0.0.1:4321/interview.html?token=t',
            started_at: new Date().toISOString(),
          })
        }, 50)
        return { pid: process.pid } as unknown as ReturnType<typeof spawn>
      },
    })
    expect(code).toBe(OK)
    expect(spawned).toEqual([['interview', 'serve', '--dir', dir, '--port', '0']])
    expect(start.out.join('\n')).toContain('http://127.0.0.1:4321/interview.html?token=t')
    expect(opened).toBe(null)
  })

  it('start fails plainly when the server never comes up', async () => {
    const dir = join(makeTemp(), 'order-tags')
    const start = recorder()
    let clock = 0
    const code = await interviewCommand(['start', '--dir', dir], start.io, {
      spawn: () => ({ pid: 999_999 }) as unknown as ReturnType<typeof spawn>,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    expect(code).toBe(FAILED)
    expect(start.err.join('\n')).toContain('did not come up')
    expect(start.err.join('\n')).toContain(join(dir, 'server.log'))
  })

  it('stop ends a live server process and clears its record', async () => {
    const dir = join(makeTemp(), 'order-tags')
    mkdirSync(dir, { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    writeServerRecord(dir, {
      pid: child.pid as number,
      port: 4321,
      url: 'http://127.0.0.1:4321/interview.html?token=t',
      started_at: new Date().toISOString(),
    })
    const stop = recorder()
    expect(await interviewCommand(['stop', '--dir', dir], stop.io)).toBe(OK)
    await exited
    expect(stop.out).toEqual([`stopped pid ${child.pid}`])
    expect(readServerRecord(dir)).toBe(null)
  })
})
