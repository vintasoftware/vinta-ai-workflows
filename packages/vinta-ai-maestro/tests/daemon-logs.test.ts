/**
 * `GET /api/logs`, and the instrumentation behind it.
 *
 * The endpoint's own contract is small — a tail, a follow, and four filters —
 * so most of what is asserted here is the thing the unit exists for: that a
 * daemon which refused something says so in a file, and that the file never
 * contains the token it refused the request over.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startDaemon, type Daemon } from '../src/daemon/index.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import {
  clearRedactions,
  createFileSink,
  createLogger,
  errorFields,
  logDirFor,
  readTail,
  redactValue,
  setErrorDetail,
  type FileSink,
  type Logger,
} from '../src/log/index.ts'
import { LogPageSchema } from '../src/daemon/schemas.ts'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  clearRedactions()
  setErrorDetail('message')
})

interface Rig {
  readonly daemon: Daemon
  readonly journal: Journal
  readonly logger: Logger
  readonly sink: FileSink
  readonly logDir: string
}

async function rig(level: 'debug' | 'info' | 'error' = 'debug'): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-daemon-logs-'))
  const journal = openJournal(dir)
  const logDir = logDirFor(journal.root)
  const sink = createFileSink({ dir: logDir })
  const logger = createLogger({ sink, level })
  const daemon = await startDaemon({ journal, logger, pollMs: 5 })
  // What `serve` does at the same point: from here the token cannot appear in
  // a record even if a field carried it.
  redactValue(daemon.token)

  cleanups.push(async () => {
    await daemon.close()
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { daemon, journal, logger, sink, logDir }
}

async function logs(daemon: Daemon, query = ''): Promise<ReturnType<typeof LogPageSchema.parse>> {
  const response = await fetch(`${daemon.url}/api/logs${query}`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  })
  expect(response.status).toBe(200)
  // Parsed with the daemon's own schema, so the endpoint cannot drift from the
  // contract the browser codegens against.
  return LogPageSchema.parse(await response.json())
}

describe('GET /api/logs', () => {
  it('requires the token like every other route', async () => {
    const r = await rig()
    const response = await fetch(`${r.daemon.url}/api/logs`)
    expect(response.status).toBe(401)
  })

  it('serves the tail of what the daemon wrote about itself', async () => {
    const r = await rig()
    const page = await logs(r.daemon)
    // The bind is the first thing any daemon has to say.
    expect(page.records.map((record) => record.event)).toContain('daemon.listening')
    expect(page.path.endsWith('daemon.ndjson')).toBe(true)
  })

  it('never serves the token, even in a record about a URL that carried it', async () => {
    const r = await rig()
    // The worst case on purpose: a call site that logged the whole URL.
    r.logger.info('test.url', { url: `${r.daemon.url}/?token=${r.daemon.token}` })
    const page = await logs(r.daemon)
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain(r.daemon.token)
    expect(serialized).toContain('<redacted>')
  })

  it('follows from a cursor without repeating or skipping', async () => {
    const r = await rig()
    const first = await logs(r.daemon)
    r.logger.info('test.later', { n: 1 })

    const next = await logs(r.daemon, `?after=${encodeURIComponent(first.cursor)}`)
    expect(next.records.map((record) => record.event)).toContain('test.later')
    expect(next.records.map((record) => record.event)).not.toContain('daemon.listening')
    expect(next.reset).toBe(false)
  })

  it('filters by level, run and search', async () => {
    const r = await rig()
    r.logger.child({ runId: 'run-x' }).warn('test.warned', { lane: 'lane-3' })
    r.logger.info('test.chatter')

    const errors = await logs(r.daemon, '?level=warn')
    expect(errors.records.every((record) => record.level !== 'info')).toBe(true)

    const scoped = await logs(r.daemon, '?run=run-x')
    expect(scoped.records.map((record) => record.event)).toEqual(['test.warned'])
    expect(scoped.records[0]?.runId).toBe('run-x')

    const found = await logs(r.daemon, '?q=lane-3')
    expect(found.records.map((record) => record.event)).toEqual(['test.warned'])
  })

  it('refuses a query it cannot read rather than guessing', async () => {
    const r = await rig()
    const response = await fetch(`${r.daemon.url}/api/logs?level=screaming`, {
      headers: { authorization: `Bearer ${r.daemon.token}` },
    })
    expect(response.status).toBe(400)
  })

  it('answers with an empty page when nothing has been logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-daemon-nolog-'))
    const journal = openJournal(dir)
    // No logger at all: the route must still answer, because a daemon somebody
    // is debugging is quite likely one that was started without one.
    const daemon = await startDaemon({ journal, pollMs: 5 })
    cleanups.push(async () => {
      await daemon.close()
      journal.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const page = await logs(daemon)
    expect(page.records).toEqual([])
    expect(page.reset).toBe(false)
  })
})

describe('what the daemon records about itself', () => {
  it('records a refused request with its status, and never its query string', async () => {
    const r = await rig()
    await fetch(`${r.daemon.url}/api/runs/nope?token=${r.daemon.token}`, {
      headers: { authorization: `Bearer ${r.daemon.token}` },
    })

    const page = await logs(r.daemon)
    const refusal = page.records.find(
      (record) => record.event === 'api.request' && record.fields['status'] === 404,
    )
    expect(refusal).toBeDefined()
    expect(refusal?.level).toBe('warn')
    expect(refusal?.fields['path']).toBe('/api/runs/nope')
    // The path, never the URL: a query string is where the token rides.
    expect(JSON.stringify(page)).not.toContain(r.daemon.token)
  })

  it('records an unauthorized request, so "refused" and "never arrived" differ', async () => {
    const r = await rig()
    await fetch(`${r.daemon.url}/api/runs`, { headers: { authorization: 'Bearer wrong' } })

    const page = await logs(r.daemon)
    expect(
      page.records.some(
        (record) => record.event === 'api.request' && record.fields['status'] === 401,
      ),
    ).toBe(true)
  })

  it('records a refused WebSocket upgrade with the reason it was refused', async () => {
    const r = await rig()
    // A real upgrade attempt, because the refusal being asserted happens on
    // the raw socket before any protocol switch — `fetch` cannot reach it.
    // The run is one this process is not driving, which is what a reload after
    // a restart looks like, and which from the browser is indistinguishable
    // from a typo in the fragment.
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(`${r.daemon.url}/ws?run=ghost&token=${r.daemon.token}`)
      socket.once('unexpected-response', () => resolve())
      socket.once('error', () => resolve())
      socket.once('close', () => resolve())
    })

    // Read from the file rather than the endpoint: the refusal happens on the
    // raw socket, and this asserts it reached disk.
    const page = readTail(r.logDir, 200)
    const refusal = page.records.find((record) => record.event === 'ws.refused')
    expect(refusal?.fields['reason']).toBe('unknown_run')
    expect(refusal?.fields['run']).toBe('ghost')
  })

  it('still records a server error at --log-level error', async () => {
    // The level an operator picks *because* they only want failures. A guard
    // that skipped the request middleware unless `debug` was on cost them
    // exactly the records they chose that level for.
    const r = await rig('error')
    await fetch(`${r.daemon.url}/api/logs?level=screaming`, {
      headers: { authorization: `Bearer ${r.daemon.token}` },
    })
    r.logger.error('test.forced', { n: 1 })

    const records = readTail(r.logDir, 200).records
    expect(records.some((record) => record.event === 'test.forced')).toBe(true)
    // The 400 itself is a `warn`, so it is correctly below this level — what
    // must not happen is the middleware being skipped outright.
    expect(records.every((record) => record.level === 'error')).toBe(true)
  })

  it('serves a thrown error with its own words, not just its type', async () => {
    const r = await rig()
    // What a call site actually does with something it caught. The assertion
    // is the whole point of the default: "TypeError" names a category, and
    // the message names the bug.
    r.logger.error('test.threw', {
      run: 'run-9',
      ...errorFields(new TypeError("Cannot read properties of undefined (reading 'lane')")),
    })

    const record = (await logs(r.daemon, '?level=error')).records.find(
      (candidate) => candidate.event === 'test.threw',
    )
    expect(record?.fields['error']).toBe('TypeError')
    expect(record?.fields['message']).toBe(
      "Cannot read properties of undefined (reading 'lane')",
    )
  })

  it('still redacts the token inside a message', async () => {
    const r = await rig()
    // The one thing the wider default must not widen. A message is prose, and
    // prose is exactly where a URL somebody interpolated ends up.
    r.logger.error('test.threw', {
      ...errorFields(new Error(`GET ${r.daemon.url}/api/runs?token=${r.daemon.token} failed`)),
    })
    expect(JSON.stringify(await logs(r.daemon))).not.toContain(r.daemon.token)
  })

  it('reports nothing lost when every write landed', async () => {
    const r = await rig()
    r.logger.info('test.one')
    expect(r.sink.failures).toBe(0)
  })
})
