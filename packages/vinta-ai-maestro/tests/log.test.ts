/**
 * The log unit: what it refuses to write, what it writes, and what it can read
 * back afterwards.
 *
 * The §11 assertions are the load-bearing ones here. `sanitize` is the only
 * thing standing between a call site holding an error object and a durable
 * file with repository content in it, and a control that is not tested is a
 * comment.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  MAX_FIELD_CHARS,
  REDACTED,
  MAX_MESSAGE_CHARS,
  clearRedactions,
  createFileSink,
  createLogger,
  createMemorySink,
  decodeRecord,
  errorFields,
  errorKind,
  formatRecord,
  installCrashHandlers,
  logFiles,
  nullLogger,
  readAfter,
  readTail,
  redactValue,
  sanitize,
  setErrorDetail,
} from '../src/log/index.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-log-'))
  clearRedactions()
  // Process-wide, so a test that narrows it must not leak into the next one.
  setErrorDetail('message')
})

afterEach(() => {
  clearRedactions()
  setErrorDetail('message')
  rmSync(dir, { recursive: true, force: true })
})

describe('sanitize', () => {
  it('keeps scalars', () => {
    expect(sanitize({ run: 'r1', count: 3, ok: true, lane: null })).toEqual({
      run: 'r1',
      count: 3,
      ok: true,
      lane: null,
    })
  })

  it('drops objects and arrays rather than stringifying them', () => {
    // The assertion that matters. `JSON.stringify` on an error, a git result or
    // a parsed file is exactly how repository content reaches a log.
    const fields = sanitize({
      run: 'r1',
      error: new Error('contents of src/secret.ts: ...'),
      rows: [{ patient: 'x' }],
      fn: () => 'nope',
    })
    expect(fields).toEqual({ run: 'r1' })
  })

  it('truncates a long value instead of storing it', () => {
    const long = 'a'.repeat(MAX_FIELD_CHARS + 500)
    const { blob } = sanitize({ blob: long })
    expect(String(blob)).toHaveLength(MAX_FIELD_CHARS + 1)
    expect(String(blob).endsWith('…')).toBe(true)
  })

  it('redacts fields that are secrets by their name', () => {
    expect(sanitize({ token: 'abc', authorization: 'Bearer x', password: 'hunter2' })).toEqual({
      token: REDACTED,
      authorization: REDACTED,
      password: REDACTED,
    })
  })

  it('redacts a registered secret wherever it appears in a value', () => {
    redactValue('s3cr3t-token-value')
    expect(sanitize({ url: 'http://127.0.0.1:9/?token=s3cr3t-token-value' })).toEqual({
      url: REDACTED,
    })
  })

  it('ignores a secret too short to be one', () => {
    redactValue('ab')
    expect(sanitize({ note: 'about' })).toEqual({ note: 'about' })
  })

  it('gives the one prose field a longer cap, and still redacts it', () => {
    // `message` is the single allowlisted long field (`errorDetail`). Every
    // other key keeps the identifier cap, whatever it holds.
    const long = 'b'.repeat(MAX_MESSAGE_CHARS + 100)
    const { message, note } = sanitize({ message: long, note: long })
    expect(String(message)).toHaveLength(MAX_MESSAGE_CHARS + 1)
    expect(String(note)).toHaveLength(MAX_FIELD_CHARS + 1)

    // A secret cannot survive by sitting past a long field's truncation point.
    redactValue('s3cr3t-token-value')
    expect(sanitize({ message: `${'x'.repeat(4000)} s3cr3t-token-value` })).toEqual({
      message: REDACTED,
    })
  })

  it('drops keys that are not plain identifiers', () => {
    expect(sanitize({ 'X-Api-Key': 'v', '../../etc': 'v', ok: 1 })).toEqual({ ok: 1 })
  })

  it('drops non-finite numbers', () => {
    expect(sanitize({ a: Number.NaN, b: Infinity, c: 1 })).toEqual({ c: 1 })
  })
})

describe('errorKind', () => {
  it('reports the name, never the message', () => {
    expect(errorKind(new TypeError('src/app.ts:12 says something private'))).toBe('TypeError')
  })

  it('adds the runtime code when there is one', () => {
    const error = Object.assign(new Error('nope'), { code: 'ENOENT' })
    expect(errorKind(error)).toBe('Error: ENOENT')
  })

  it('handles what is not an error at all', () => {
    expect(errorKind(null)).toBe('null')
    expect(errorKind(undefined)).toBe('undefined')
    expect(errorKind('a thrown string')).toBe('Error')
  })
})

describe('errorFields', () => {
  it('records the message by default, beside the kind', () => {
    expect(errorFields(new TypeError('cannot read x of undefined'))).toEqual({
      error: 'TypeError',
      message: 'cannot read x of undefined',
    })
  })

  it('drops the message under --log-detail kind', () => {
    setErrorDetail('kind')
    expect(errorFields(new TypeError('cannot read x of undefined'))).toEqual({
      error: 'TypeError',
    })
  })

  it('takes a per-call override, for handlers that were given one', () => {
    setErrorDetail('message')
    expect(errorFields(new Error('quiet'), 'kind')).toEqual({ error: 'Error' })
  })

  it('omits an empty message rather than writing an empty field', () => {
    expect(errorFields(new Error(''))).toEqual({ error: 'Error' })
    expect(errorFields('a thrown string')).toEqual({ error: 'Error' })
  })
})

describe('the logger', () => {
  it('honours its level', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, level: 'warn' })
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    expect(sink.records.map((r) => r.event)).toEqual(['c', 'd'])
  })

  it('stamps a child with its context and keeps one sequence', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, level: 'debug' })
    const node = log.child({ runId: 'r1' }).child({ nodeId: 'p0' })
    log.info('root')
    node.info('leaf')
    expect(sink.records[0]?.runId).toBeUndefined()
    expect(sink.records[1]?.runId).toBe('r1')
    expect(sink.records[1]?.nodeId).toBe('p0')
    // One counter across the tree, or two records in the same millisecond
    // cannot be ordered.
    expect(sink.records.map((r) => r.seq)).toEqual([1, 2])
  })

  it('discards everything through nullLogger', () => {
    const log = nullLogger()
    log.error('boom')
    expect(log.enabled('error')).toBe(false)
    expect(log.child({ runId: 'r' })).toBeDefined()
  })

  it('renders a record for a terminal', () => {
    const sink = createMemorySink()
    createLogger({ sink, level: 'debug', context: { runId: 'r1' } }).warn('a.b', { n: 2 })
    expect(formatRecord(sink.records[0] as never)).toBe('WARN  a.b [r1] n=2')
  })
})

describe('the file sink', () => {
  it('writes one NDJSON line per record', () => {
    const sink = createFileSink({ dir })
    const log = createLogger({ sink, level: 'debug' })
    log.info('daemon.listening', { port: 1234 })
    log.error('daemon.uncaught_exception', { error: 'TypeError' })

    const lines = readFileSync(join(dir, 'daemon.ndjson'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(decodeRecord(lines[0] as string)?.event).toBe('daemon.listening')
    expect(decodeRecord(lines[1] as string)?.fields).toEqual({ error: 'TypeError' })
  })

  it('rotates by size and keeps generations increasing', () => {
    const sink = createFileSink({ dir, maxBytes: 400, keep: 5 })
    const log = createLogger({ sink, level: 'debug' })
    for (let i = 0; i < 40; i += 1) log.info('e', { i })

    const files = logFiles(dir)
    expect(files.length).toBeGreaterThan(1)
    // Ascending, active last — the property every cursor depends on.
    const generations = files.map((f) => f.generation)
    expect([...generations].sort((a, b) => a - b)).toEqual(generations)
    expect(files.at(-1)?.active).toBe(true)
  })

  it('prunes rotated files beyond keep', () => {
    const sink = createFileSink({ dir, maxBytes: 200, keep: 2 })
    const log = createLogger({ sink, level: 'debug' })
    for (let i = 0; i < 80; i += 1) log.info('e', { i })
    expect(logFiles(dir).filter((f) => !f.active)).toHaveLength(2)
  })

  it('counts a failed write instead of throwing', () => {
    // A file where the directory should be: every append fails, and the host
    // must not notice. This is §11's "instrumentation never fails its host".
    const wedged = join(dir, 'wedged')
    writeFileSync(wedged, 'not a directory')
    const sink = createFileSink({ dir: join(wedged, 'logs') })
    const log = createLogger({ sink, level: 'debug' })
    expect(() => log.info('e')).not.toThrow()
    expect(sink.failures).toBeGreaterThan(0)
  })
})

describe('reading back', () => {
  const write = (count: number, level = 'info'): void => {
    const sink = createFileSink({ dir })
    const log = createLogger({ sink, level: 'debug' })
    for (let i = 0; i < count; i += 1) {
      ;(log as never as Record<string, (e: string, f: object) => void>)[level]?.('e', { i })
    }
  }

  it('tails the last records, oldest first', () => {
    write(10)
    const page = readTail(dir, 3)
    expect(page.records.map((r) => r.fields['i'])).toEqual([7, 8, 9])
  })

  it('follows from a cursor with no gap and no duplicate', () => {
    write(5)
    const first = readTail(dir, 2)
    const sink = createFileSink({ dir })
    const log = createLogger({ sink, level: 'debug' })
    log.info('after', { i: 99 })

    const next = readAfter(dir, first.cursor, 100)
    expect(next.records.map((r) => r.event)).toEqual(['after'])
    expect(next.reset).toBe(false)
  })

  it('returns nothing when nothing was written since', () => {
    write(3)
    const page = readTail(dir, 3)
    expect(readAfter(dir, page.cursor, 100).records).toEqual([])
  })

  it('continues across a rotation without a reset', () => {
    // `keep` deliberately high: this is the case where the cursor's own file
    // is still on disk. The pruned case is the test below it.
    const sink = createFileSink({ dir, maxBytes: 300, keep: 50 })
    const log = createLogger({ sink, level: 'debug' })
    log.info('first', { i: 0 })
    const start = readTail(dir, 1)

    for (let i = 1; i < 30; i += 1) log.info('e', { i })

    const next = readAfter(dir, start.cursor, 1000)
    // The cursor's own generation still exists, so the read walks forward
    // through the rotated files rather than declaring a gap.
    expect(next.reset).toBe(false)
    expect(next.records.map((r) => r.fields['i'])).toEqual(
      Array.from({ length: 29 }, (_, k) => k + 1),
    )
  })

  it('reports a reset when the cursor’s generation was pruned', () => {
    const sink = createFileSink({ dir, maxBytes: 200, keep: 1 })
    const log = createLogger({ sink, level: 'debug' })
    log.info('first', { i: 0 })
    const start = readTail(dir, 1)
    for (let i = 1; i < 120; i += 1) log.info('e', { i })

    const next = readAfter(dir, start.cursor, 1000)
    expect(next.reset).toBe(true)
    expect(next.records.length).toBeGreaterThan(0)
  })

  it('filters by level, run and search on the daemon’s side', () => {
    const sink = createFileSink({ dir })
    const log = createLogger({ sink, level: 'debug' })
    log.info('a.one', { lane: 'lane-1' })
    log.error('b.two', { lane: 'lane-2' })
    log.child({ runId: 'r9' }).warn('c.three')

    expect(readTail(dir, 50, { level: 'warn' }).records.map((r) => r.event)).toEqual([
      'b.two',
      'c.three',
    ])
    expect(readTail(dir, 50, { runId: 'r9' }).records.map((r) => r.event)).toEqual(['c.three'])
    expect(readTail(dir, 50, { search: 'lane-2' }).records.map((r) => r.event)).toEqual(['b.two'])
  })

  it('skips a torn last line rather than failing the read', () => {
    write(3)
    // A record half-written when the machine lost power. It must not take the
    // read that was going to explain the outage down with it.
    appendFileSync(join(dir, 'daemon.ndjson'), '{"ts":1,"seq":4,"pid":1,"lev')
    expect(readTail(dir, 50).records).toHaveLength(3)
  })

  it('answers an empty directory rather than throwing', () => {
    const page = readTail(join(dir, 'never-written'), 10)
    expect(page.records).toEqual([])
    expect(page.reset).toBe(false)
  })

  it('re-sanitizes what it reads off disk', () => {
    // The file is a file in a checkout. Nothing guarantees this process wrote
    // every line in it.
    appendFileSync(
      join(dir, 'daemon.ndjson'),
      `${JSON.stringify({
        ts: 1,
        seq: 1,
        pid: 1,
        level: 'info',
        event: 'e',
        fields: { nested: { repository: 'contents' }, token: 'abc', ok: 1 },
      })}\n`,
    )
    expect(readTail(dir, 10).records[0]?.fields).toEqual({ token: REDACTED, ok: 1 })
  })
})

describe('crash handlers', () => {
  /** A stand-in for `process`, so the runner is not the thing being crashed. */
  const target = (): EventEmitter => new EventEmitter()

  it('records an uncaught exception, then lets the process go', () => {
    const emitter = target()
    const sink = createMemorySink()
    const exits: number[] = []
    const settled: string[] = []

    installCrashHandlers({
      logger: createLogger({ sink, level: 'debug' }),
      target: emitter as never,
      exit: (code) => exits.push(code),
      inFlight: () => ['run-a', 'run-b'],
      onFatal: () => settled.push('journalled'),
    })

    emitter.emit('uncaughtException', new TypeError('a message that must not be stored'))

    const record = sink.records[0]
    expect(record?.event).toBe('daemon.uncaught_exception')
    expect(record?.level).toBe('error')
    expect(record?.fields['error']).toBe('TypeError')
    // The blast radius, on the record: which runs were in flight when it died.
    expect(record?.fields['runs']).toBe(2)
    expect(record?.fields['run_ids']).toBe('run-a,run-b')
    // The default keeps the message *and* the frames.
    expect(record?.fields['message']).toBe('a message that must not be stored')
    expect(record?.fields['stack_0']).toMatch(/^at /)
    // The host got its chance to make the runs resumable, then the exit.
    expect(settled).toEqual(['journalled'])
    expect(exits).toEqual([1])
  })

  it('records an unhandled rejection the same way', () => {
    const emitter = target()
    const sink = createMemorySink()
    installCrashHandlers({
      logger: createLogger({ sink, level: 'debug' }),
      target: emitter as never,
      exit: () => {},
    })
    emitter.emit('unhandledRejection', new Error('boom'))
    expect(sink.records[0]?.event).toBe('daemon.unhandled_rejection')
  })

  it('drops the message when the operator narrowed it, keeping the frames', () => {
    const emitter = target()
    const sink = createMemorySink()
    installCrashHandlers({
      logger: createLogger({ sink, level: 'debug' }),
      target: emitter as never,
      detail: 'kind',
      exit: () => {},
    })
    emitter.emit('uncaughtException', new Error('the actual reason'))
    const record = sink.records[0]
    expect(record?.fields['message']).toBeUndefined()
    // The frames must not smuggle it back: a V8 stack's first line is
    // `Name: message`, and `frames` drops it for exactly this reason.
    expect(record?.fields['stack_0']).toMatch(/^at /)
    expect(JSON.stringify(record?.fields)).not.toContain('the actual reason')
  })

  it('follows the process-wide setting when given no override', () => {
    const emitter = target()
    const sink = createMemorySink()
    setErrorDetail('kind')
    installCrashHandlers({
      logger: createLogger({ sink, level: 'debug' }),
      target: emitter as never,
      exit: () => {},
    })
    emitter.emit('uncaughtException', new Error('the actual reason'))
    expect(sink.records[0]?.fields['message']).toBeUndefined()
  })

  it('records a process warning without exiting', () => {
    const emitter = target()
    const sink = createMemorySink()
    const exits: number[] = []
    installCrashHandlers({
      logger: createLogger({ sink, level: 'debug' }),
      target: emitter as never,
      exit: (code) => exits.push(code),
    })
    emitter.emit('warning', Object.assign(new Error('x'), { name: 'MaxListenersExceededWarning' }))
    expect(sink.records[0]?.event).toBe('daemon.process_warning')
    expect(sink.records[0]?.fields['warning']).toBe('MaxListenersExceededWarning')
    expect(exits).toEqual([])
  })

  it('still exits when the logger itself throws', () => {
    const emitter = target()
    const exits: number[] = []
    const broken = {
      ...nullLogger(),
      error: () => {
        throw new Error('the log is the thing that broke')
      },
    }
    installCrashHandlers({
      logger: broken as never,
      target: emitter as never,
      exit: (code) => exits.push(code),
    })
    emitter.emit('uncaughtException', new Error('boom'))
    expect(exits).toEqual([1])
  })

  it('removes its handlers when uninstalled', () => {
    const emitter = target()
    const sink = createMemorySink()
    const uninstall = installCrashHandlers({
      logger: createLogger({ sink, level: 'debug' }),
      target: emitter as never,
      exit: () => {},
    })
    uninstall()
    expect(emitter.listenerCount('uncaughtException')).toBe(0)
    expect(emitter.listenerCount('unhandledRejection')).toBe(0)
    expect(emitter.listenerCount('warning')).toBe(0)
  })
})
