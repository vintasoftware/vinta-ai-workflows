import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GateCache, laneTreeHash, runGateCached } from '../src/gates/cache.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import type { Gate } from '../src/types.ts'
import { POSIX_SHELL_FIXTURES } from './support/platform.ts'

/**
 * `repo` is a throwaway git repository — every git command in this file and in
 * the code under test runs with it as cwd, so nothing reaches the repository
 * this suite itself lives in. `store` holds the cache database, the gate logs
 * and the run counter: all of it must live *outside* the repo, because writing
 * any of it inside would change the tree hash and defeat the very hits these
 * tests assert on.
 */
let repo: string
let store: string
let cache: GateCache

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vinta-flow-cache-repo-'))
  store = await mkdtemp(join(tmpdir(), 'vinta-flow-cache-store-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  await writeFile(join(repo, 'src.txt'), 'v1\n')
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  cache = new GateCache(store)
})

afterEach(async () => {
  cache.close()
  await rm(repo, { recursive: true, force: true })
  await rm(store, { recursive: true, force: true })
})

const newPools = (): ResourcePools =>
  new ResourcePools({ 'test-suite': { capacity: 1, kind: 'semaphore' } }, { agingMs: 0 })

const counter = (): string => join(store, 'runs.txt')

/** Records one line per actual execution, outside the repo so it is invisible to the hash. */
const gate = (cmd = 'true', overrides: Partial<Gate> = {}): Gate => ({
  cmd: `echo ran >> "${counter()}"; ${cmd}`,
  requires: ['test-suite'],
  timeout_s: 30,
  ...overrides,
})

async function runs(): Promise<number> {
  try {
    return (await readFile(counter(), 'utf8')).split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

interface RunOptions {
  readonly gateId?: string
  readonly gate?: Gate
  readonly pools?: ResourcePools
  readonly noCache?: boolean
}

const run = async (options: RunOptions = {}) =>
  runGateCached({
    gateId: options.gateId ?? 'suite',
    gate: options.gate ?? gate(),
    cwd: repo,
    env: {},
    logPath: join(store, `${options.gateId ?? 'suite'}.log`),
    pools: options.pools ?? newPools(),
    cache,
    ...(options.noCache === undefined ? {} : { noCache: options.noCache }),
  })

describe.runIf(POSIX_SHELL_FIXTURES)('gate result caching', () => {
  it('serves an unchanged tree from cache without acquiring the gate’s pools', async () => {
    const first = await run()
    expect(first.cached).toBe(false)
    expect(first.status).toBe('passed')

    const pools = newPools()
    const acquire = vi.spyOn(pools, 'acquire')
    const second = await run({ pools })

    expect(second.cached).toBe(true)
    expect(second.status).toBe('passed')
    expect(second.exitCode).toBe(0)
    // The whole point: a hit never enters the queue for the most contended
    // resource in the system.
    expect(acquire).not.toHaveBeenCalled()
    expect(pools.held('test-suite')).toBe(0)
    expect(await runs()).toBe(1)
  })

  it('invalidates when a tracked file changes', async () => {
    await run()
    const before = laneTreeHash(repo)

    await writeFile(join(repo, 'src.txt'), 'v2\n')
    expect(laneTreeHash(repo)).not.toBe(before)

    const second = await run()
    expect(second.cached).toBe(false)
    expect(await runs()).toBe(2)

    // Reverting to the original content returns to the original key, which is
    // the content-addressed behaviour working, not a stale hit.
    await writeFile(join(repo, 'src.txt'), 'v1\n')
    expect(laneTreeHash(repo)).toBe(before)
    expect((await run()).cached).toBe(true)
  })

  it('invalidates when an untracked file appears, but not when an ignored one does', async () => {
    await run()

    // Untracked-but-not-ignored is exactly the agent-created-fixture case, and
    // `git add -A` hashes it, so it must invalidate.
    await writeFile(join(repo, 'fixture.txt'), 'new\n')
    expect((await run()).cached).toBe(false)
    expect(await runs()).toBe(2)

    // Ignored files are deliberately outside the hash — documented in
    // src/gates/cache.ts, pinned here so it stays a choice.
    const withoutIgnored = laneTreeHash(repo)
    await writeFile(join(repo, 'ignored.txt'), 'build output\n')
    expect(laneTreeHash(repo)).toBe(withoutIgnored)
    expect((await run()).cached).toBe(true)
    expect(await runs()).toBe(2)
  })

  it('re-runs on a hit when noCache is set, and refreshes the entry', async () => {
    await run()
    const pools = newPools()
    const acquire = vi.spyOn(pools, 'acquire')

    const forced = await run({ pools, noCache: true })
    expect(forced.cached).toBe(false)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(await runs()).toBe(2)

    // The forced run refreshed the entry rather than bypassing the store, so
    // the next cached run still hits.
    expect((await run()).cached).toBe(true)
    expect(await runs()).toBe(2)
  })

  it('never caches a timed_out result', async () => {
    const slow = gate('sleep 30', { timeout_s: 1 })

    const first = await run({ gate: slow })
    expect(first.status).toBe('timed_out')
    expect(first.cached).toBe(false)
    expect(cache.lookup('suite', laneTreeHash(repo))).toBeUndefined()

    // A timeout says the gate did not finish, not that the tree is bad: the
    // second attempt must actually run.
    const second = await run({ gate: slow })
    expect(second.cached).toBe(false)
    expect(await runs()).toBe(2)
  }, 20_000)

  it('caches a failing result and returns it as a hit', async () => {
    const failing = gate('exit 3')

    const first = await run({ gate: failing })
    expect(first.status).toBe('failed')
    expect(first.exitCode).toBe(3)

    const second = await run({ gate: failing })
    expect(second.cached).toBe(true)
    expect(second.status).toBe('failed')
    expect(second.exitCode).toBe(3)
    expect(await runs()).toBe(1)
  })

  it('survives a restart', async () => {
    await run()
    cache.close()
    cache = new GateCache(store)

    const reopened = await run()
    expect(reopened.cached).toBe(true)
    expect(await runs()).toBe(1)
  })

  it('does not collide across gate ids on the same tree', async () => {
    const passing = await run({ gateId: 'lint' })
    const failing = await run({ gateId: 'suite', gate: gate('exit 1') })
    expect(passing.status).toBe('passed')
    expect(failing.status).toBe('failed')

    const lint = await run({ gateId: 'lint' })
    const suite = await run({ gateId: 'suite', gate: gate('exit 1') })
    expect(lint.cached).toBe(true)
    expect(lint.gateId).toBe('lint')
    expect(lint.status).toBe('passed')
    expect(suite.cached).toBe(true)
    expect(suite.gateId).toBe('suite')
    expect(suite.status).toBe('failed')
    expect(await runs()).toBe(2)
  })
})
