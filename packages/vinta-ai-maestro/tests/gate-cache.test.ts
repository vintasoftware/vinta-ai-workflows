import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GateCache, laneTreeHash, runGateCached } from '../src/gates/cache.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import type { Gate } from '../src/types.ts'
import { renderGate, type GateScript } from './support/gate-script.ts'

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
  repo = await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-cache-repo-'))
  store = await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-cache-store-'))
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

/**
 * Records one line per actual execution, outside the repo so it is invisible to
 * the hash.
 *
 * The counting step is `renderGate`'s `append` rather than a hand-written
 * `echo ran >> "..."`: on `cmd.exe` that line writes "ran " *with* the trailing
 * space, and every count here is a line-exact filter, so the same text spelled
 * for one shell would have quietly counted nothing on the other.
 */
const gate = (script: GateScript = {}, overrides: Partial<Gate> = {}): Gate => ({
  cmd: renderGate({ append: { path: counter(), line: 'ran' }, ...script }),
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

describe('gate result caching', () => {
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
    // `background` is the spec's only step that outlives its own shell, so it
    // is what stands in for `sleep 30` — the wait is the part this test needs,
    // and the grandchild's pid file goes to `store` rather than the repo so the
    // gate that never finished still cannot change the tree hash.
    const slow = gate(
      { background: { seconds: 30, pidFile: join(store, 'slow.pid') } },
      { timeout_s: 1 },
    )

    const first = await run({ gate: slow })
    expect(first.status).toBe('timed_out')
    expect(first.cached).toBe(false)
    expect(cache.lookup('suite', laneTreeHash(repo), slow.cmd)).toBeUndefined()

    // A timeout says the gate did not finish, not that the tree is bad: the
    // second attempt must actually run.
    const second = await run({ gate: slow })
    expect(second.cached).toBe(false)
    expect(await runs()).toBe(2)
  }, 20_000)

  it('misses when the gate id is unchanged but its command is not', async () => {
    // §9's amend can move `gates[id].cmd` under a live run, and the id it moves
    // under does not. A key of `(gate id, tree hash)` would serve the old
    // command's verdict against an unchanged tree — so the one amendment whose
    // whole purpose is to change what the gate does would change nothing.
    const before = gate()
    expect((await run({ gate: before })).cached).toBe(false)
    expect((await run({ gate: before })).cached).toBe(true)
    expect(await runs()).toBe(1)

    const tuned = gate({ stdout: ['tuned'] })
    expect(tuned.cmd).not.toBe(before.cmd)

    const amended = await run({ gate: tuned })
    expect(amended.cached).toBe(false)
    expect(await runs()).toBe(2)

    // Both entries stand: the key gained a component rather than being
    // overwritten, so reverting the amendment is a hit and not a third run.
    expect((await run({ gate: tuned })).cached).toBe(true)
    expect((await run({ gate: before })).cached).toBe(true)
    expect(await runs()).toBe(2)
  })

  it('caches a failing result and returns it as a hit', async () => {
    const failing = gate({ exit: 3 })

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

  /**
   * What the caching is actually worth once agents run gates through it.
   *
   * The `gate` verb's whole speed argument is that four agents running the same
   * suite against one unchanged tree pay for it once. That argument rests on
   * `laneTreeHash`, and `laneTreeHash` hashes **untracked but non-ignored**
   * files — so a gate that drops `coverage/`, `.pytest_cache/` or a build
   * directory into the lane changes the key it was just looked up under. It
   * invalidates itself, and nobody watching a run would be able to tell that
   * from the cache simply not working.
   *
   * These three measure it rather than reasoning about it, because the answer
   * turned out to depend on something no design document would have mentioned:
   * whether the artifact's *bytes* are stable.
   */
  describe('a gate that writes into its own lane', () => {
    /** `coverage/` as a real suite leaves it. Empty here, so git cannot see it yet. */
    const artifact = (): string => {
      mkdirSync(join(repo, 'coverage'), { recursive: true })
      return join(repo, 'coverage', 'report.txt')
    }

    it('hits every time when it leaves nothing behind — the baseline the verb assumes', async () => {
      for (let i = 0; i < 4; i += 1) await run()

      // Four asks, one suite. This is the number the prompts are written around.
      expect(await runs()).toBe(1)
    })

    it('never hits when the artifact’s contents change each run', async () => {
      // An appended line stands in for the timestamp, duration or run id that
      // real coverage and JUnit reports carry. Every run writes a tree nobody
      // has seen, so every lookup misses — including the `gate` node's, which
      // pays full price for a suite four agents already ran.
      const growing = gate({
        append: [
          { path: counter(), line: 'ran' },
          { path: artifact(), line: 'cov' },
        ],
      })

      const results = []
      for (let i = 0; i < 4; i += 1) results.push((await run({ gate: growing })).cached)

      expect(results).toEqual([false, false, false, false])
      expect(await runs()).toBe(4)
    })

    it('hits after one extra run when the artifact is byte-identical', async () => {
      // The gentler and commoner case: a build directory whose output is
      // reproducible. Run 1 runs against a tree with no artifact and creates
      // one; run 2 runs against the tree *with* it and rewrites the same bytes,
      // which leaves the hash where it is; run 3 onwards hit. The cache still
      // pays, one run later than it looks like it should.
      const stable = gate({ write: { path: artifact(), line: 'cov' } })

      const results = []
      for (let i = 0; i < 4; i += 1) results.push((await run({ gate: stable })).cached)

      expect(results).toEqual([false, false, true, true])
      expect(await runs()).toBe(2)
    })

    it('hits every time once the artifact path is ignored — the mitigation', async () => {
      // The fix a project applies, and the reason `.gitignore` is honoured by
      // the key at all: ignore what the gate produces and the gate stops
      // invalidating itself. Nothing in the orchestrator can do this for a
      // project — which is why it is worth saying out loud that a plan whose
      // gates write untracked output into the lane gets no caching until it
      // does.
      await writeFile(join(repo, '.gitignore'), 'ignored.txt\ncoverage/\n')
      const growing = gate({
        append: [
          { path: counter(), line: 'ran' },
          { path: artifact(), line: 'cov' },
        ],
      })

      const results = []
      for (let i = 0; i < 4; i += 1) results.push((await run({ gate: growing })).cached)

      expect(results).toEqual([false, true, true, true])
      expect(await runs()).toBe(1)
    })
  })

  it('does not collide across gate ids on the same tree', async () => {
    const passing = await run({ gateId: 'lint' })
    const failing = await run({ gateId: 'suite', gate: gate({ exit: 1 }) })
    expect(passing.status).toBe('passed')
    expect(failing.status).toBe('failed')

    const lint = await run({ gateId: 'lint' })
    const suite = await run({ gateId: 'suite', gate: gate({ exit: 1 }) })
    expect(lint.cached).toBe(true)
    expect(lint.gateId).toBe('lint')
    expect(lint.status).toBe('passed')
    expect(suite.cached).toBe(true)
    expect(suite.gateId).toBe('suite')
    expect(suite.status).toBe('failed')
    expect(await runs()).toBe(2)
  })
})
