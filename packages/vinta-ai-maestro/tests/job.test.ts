/**
 * A run as a background job (`src/job/job.ts`): the record other commands find
 * it by, and the launch that waits for it to report the run started.
 *
 * The last test spawns the real CLI, detached, exactly as `run` does — with a
 * resume of a run that does not exist, so the job refuses before it hosts
 * anything and the test is about the launch, not about a run.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { runOfPath } from '../src/daemon/proxy.ts'
import {
  cliSpawner,
  isAlive,
  jobLogPathFor,
  jobPathFor,
  launchJob,
  liveJob,
  readJob,
  removeJob,
  writeJob,
  type JobRecord,
} from '../src/job/job.ts'
import { isWindows } from '../src/platform/platform.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const temps: string[] = []
const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-job-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const record = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  runId: 'r1',
  pid: process.pid,
  url: 'http://127.0.0.1:1',
  token: 'secret',
  state: 'running',
  startedAt: 1,
  ...overrides,
})

/** A child that exits, or does not, when the test says. */
const fakeChild = (pid: number): ChildProcess & { exit(): void } => {
  const child = new EventEmitter() as ChildProcess & { exit(): void }
  Object.defineProperty(child, 'pid', { value: pid })
  child.exit = () => child.emit('exit', 1, null)
  return child
}

describe('the job record', () => {
  it('round-trips, readable by this user only', () => {
    const dir = makeTemp()
    writeJob(dir, record())
    expect(readJob(dir, 'r1')).toEqual(record())
    if (!isWindows()) expect(statSync(jobPathFor(dir, 'r1')).mode & 0o777).toBe(0o600)
  })

  it('treats a record whose process is gone as no job at all', () => {
    const dir = makeTemp()
    writeJob(dir, record({ pid: 999_999 }))
    expect(liveJob(dir, 'r1', () => false)).toBeNull()
    expect(liveJob(dir, 'r1', () => true)?.pid).toBe(999_999)
    expect(isAlive(process.pid)).toBe(true)
  })

  it('is removed only by the job that wrote it', () => {
    const dir = makeTemp()
    writeJob(dir, record({ pid: 2 }))
    removeJob(dir, 'r1', 1)
    expect(readJob(dir, 'r1')).not.toBeNull()
    removeJob(dir, 'r1', 2)
    expect(readJob(dir, 'r1')).toBeNull()
  })
})

describe('launching a job', () => {
  it('waits through "starting" and returns once the job says the run is running', async () => {
    const dir = makeTemp()
    const child = fakeChild(4242)
    let polls = 0
    const launched = launchJob({
      repoPath: dir,
      runId: 'r1',
      args: ['run'],
      pollMs: 1,
      spawn: () => child,
    })
    // A record from some other process is not this job's word.
    writeJob(dir, record({ pid: 1, state: 'running' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    writeJob(dir, record({ pid: 4242, state: 'starting' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    polls += 1
    writeJob(dir, record({ pid: 4242, state: 'running' }))

    const result = await launched
    expect(polls).toBe(1)
    expect(result).toEqual({ ok: true, record: record({ pid: 4242, state: 'running' }) })
  })

  it('relays the job log as whole lines while it waits, this attempt only', async () => {
    const dir = makeTemp()
    const logPath = jobLogPathFor(dir, 'r1')
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, 'an earlier attempt\n')
    const seen: string[] = []
    const launched = launchJob({
      repoPath: dir,
      runId: 'r1',
      args: ['run'],
      pollMs: 1,
      spawn: () => fakeChild(4242),
      onOutput: (text) => seen.push(text),
    })
    appendFileSync(logPath, 'running prepare_cmd…\nhalf a li')
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The unfinished line is held back until its newline arrives.
    expect(seen.join('')).toBe('running prepare_cmd…\n')
    appendFileSync(logPath, 'ne\n')
    await new Promise((resolve) => setTimeout(resolve, 10))
    writeJob(dir, record({ pid: 4242, state: 'running' }))
    await launched
    expect(seen.join('')).toBe('running prepare_cmd…\nhalf a line\n')
  })

  it('spawns the real CLI detached, and returns what it said when it refuses', async () => {
    const dir = makeTemp()
    const result = await launchJob({
      repoPath: dir,
      runId: 'ghost',
      args: ['run', '--resume', 'ghost', '--foreground', '--repo', dir],
      spawn: cliSpawner(join(HERE, '..', 'src', 'cli', 'bin.ts'), [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
      ]),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.output).toContain('no run "ghost"')
  }, 30_000)
})

describe('which run a path addresses', () => {
  it('is the segment after /api/runs/, and only there', () => {
    expect(runOfPath('/api/runs/abc')).toBe('abc')
    expect(runOfPath('/api/runs/abc/nodes/n1/pause')).toBe('abc')
    expect(runOfPath('/api/runs')).toBeNull()
    expect(runOfPath('/api/runs/')).toBeNull()
    expect(runOfPath('/api/workflows/abc')).toBeNull()
  })
})
