/**
 * Cleaning up after a failed run.
 *
 * This deletes worktrees and branches, so the cases worth writing are the ones
 * where it must *not*. A cleanup command that occasionally eats work is one
 * nobody runs quickly, and the whole point is to run it quickly — between
 * failed attempts, without reading the list first every time.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { findReapable, reap, worktrees } from '../src/cli/reap.ts'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * A repository shaped like one a run left behind: lane worktrees under the
 * store, each holding a phase branch, with summaries beside them.
 */
function repoWithLanes(runIds: readonly string[]): {
  readonly repo: string
  readonly laneRoot: string
  readonly summaryDir: string
} {
  const repo = mkdtempSync(join(tmpdir(), 'vinta-reap-'))
  temps.push(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 'T')
  writeFileSync(join(repo, 'seed.txt'), 'seed\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'seed')

  const laneRoot = join(repo, '.vinta-ai-maestro', 'lanes')
  const summaryDir = join(repo, '.vinta-ai-workflows', 'worktrees')
  mkdirSync(laneRoot, { recursive: true })
  mkdirSync(summaryDir, { recursive: true })

  for (const runId of runIds) {
    const name = `${runId}-crew-1-junior`
    git(repo, 'worktree', 'add', '-q', '-b', `plan/p/phase-${runId}`, join(laneRoot, name))
    writeFileSync(join(summaryDir, `${name}.yaml`), `name: ${name}\n`, 'utf8')
  }
  return { repo, laneRoot, summaryDir }
}

describe('finding what a run left behind', () => {
  it('finds a run’s lanes, the branches they hold, and their summaries', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])

    const found = await findReapable({
      repoPath: repo,
      laneRoot,
      summaryDir,
      includeBranches: true,
    })

    expect(found.lanes).toHaveLength(1)
    expect(found.lanes[0]?.branch).toBe('plan/p/phase-runa')
    expect(found.summaries).toHaveLength(1)
  })

  it('scopes to one run when asked, leaving the others alone', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa', 'runb'])

    const found = await findReapable({
      repoPath: repo,
      laneRoot,
      summaryDir,
      runId: 'runa',
      includeBranches: true,
    })

    expect(found.lanes.map((lane) => lane.branch)).toEqual(['plan/p/phase-runa'])
    expect(found.summaries.every((path) => path.includes('runa'))).toBe(true)
  })

  /**
   * The main checkout is a worktree too, and so is any worktree a human made
   * for their own work. Only what lives under the lane root is a lane.
   */
  it('never reaches a worktree outside the lane root', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])
    const mine = join(repo, '..', `human-${Date.now()}`)
    temps.push(mine)
    git(repo, 'worktree', 'add', '-q', '-b', 'my-own-work', mine)

    const found = await findReapable({
      repoPath: repo,
      laneRoot,
      summaryDir,
      includeBranches: true,
    })

    expect(found.lanes.some((lane) => lane.branch === 'my-own-work')).toBe(false)
    expect(found.lanes.some((lane) => lane.path === repo)).toBe(false)
  })

  /**
   * The case this command exists for is a *failed* run, whose phase branch
   * holds the only copy of whatever the agent wrote. Deleting it to tidy up
   * would destroy exactly the thing worth keeping.
   */
  it('keeps an unmerged branch and reports it instead of deleting it', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])
    const lane = join(laneRoot, 'runa-crew-1-junior')
    writeFileSync(join(lane, 'work.txt'), 'the phase wrote this\n', 'utf8')
    git(lane, 'add', '.')
    git(lane, 'commit', '-qm', 'phase work')

    const found = await findReapable({
      repoPath: repo,
      laneRoot,
      summaryDir,
      includeBranches: true,
    })

    expect(found.unmergedBranches).toEqual(['plan/p/phase-runa'])
    expect(found.mergedBranches).toEqual([])
  })

  it('offers a merged branch, which has nothing left to lose', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])

    const found = await findReapable({
      repoPath: repo,
      laneRoot,
      summaryDir,
      includeBranches: true,
    })

    // Never committed to, so it is still exactly `main`.
    expect(found.mergedBranches).toEqual(['plan/p/phase-runa'])
    expect(found.unmergedBranches).toEqual([])
  })

  it('finds no branches at all unless branches were asked for', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])

    const found = await findReapable({
      repoPath: repo,
      laneRoot,
      summaryDir,
      includeBranches: false,
    })

    expect(found.lanes).toHaveLength(1)
    expect(found.mergedBranches).toEqual([])
    expect(found.unmergedBranches).toEqual([])
  })
})

describe('reaping', () => {
  it('removes the worktrees and frees the branch names for the next run', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])
    const found = await findReapable({ repoPath: repo, laneRoot, summaryDir, includeBranches: true })

    const failures = await reap(repo, found, { branches: true })

    expect(failures).toEqual([])
    expect(existsSync(join(laneRoot, 'runa-crew-1-junior'))).toBe(false)
    // The point of the exercise: the next run can cut this branch again.
    expect((await worktrees(repo)).some((lane) => lane.branch === 'plan/p/phase-runa')).toBe(false)
    expect(git(repo, 'branch', '--list', 'plan/p/phase-runa').trim()).toBe('')
  })

  /**
   * Worktrees must go first: git refuses to delete a branch a worktree still
   * holds, so the other order silently leaves every branch behind.
   */
  it('leaves the branch alone when branches were not asked for', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])
    const found = await findReapable({ repoPath: repo, laneRoot, summaryDir, includeBranches: false })

    await reap(repo, found, { branches: false })

    expect(existsSync(join(laneRoot, 'runa-crew-1-junior'))).toBe(false)
    expect(git(repo, 'branch', '--list', 'plan/p/phase-runa').trim()).toContain('plan/p/phase-runa')
  })

  it('does not delete an unmerged branch even when branches were asked for', async () => {
    const { repo, laneRoot, summaryDir } = repoWithLanes(['runa'])
    const lane = join(laneRoot, 'runa-crew-1-junior')
    writeFileSync(join(lane, 'work.txt'), 'the phase wrote this\n', 'utf8')
    git(lane, 'add', '.')
    git(lane, 'commit', '-qm', 'phase work')
    const found = await findReapable({ repoPath: repo, laneRoot, summaryDir, includeBranches: true })

    await reap(repo, found, { branches: true })

    expect(git(repo, 'branch', '--list', 'plan/p/phase-runa').trim()).toContain('plan/p/phase-runa')
  })
})
