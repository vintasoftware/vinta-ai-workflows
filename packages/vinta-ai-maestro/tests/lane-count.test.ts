/**
 * `count.ts` and `estimateLaneBytes` — the two halves of what the disk probe
 * charges, shared by the doctor, the pool and the refusal line.
 *
 * Both were wrong in the same direction on one observed resume: the doctor
 * charged `capacity + 1` worktrees whatever was already on disk, at a per-lane
 * estimate that had walked the whole main checkout — `.git`, the maestro store
 * holding the lanes themselves, every ignored cache — and refused for want of
 * 38 GiB a pool that would have created nothing.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  countWorktrees,
  describeWorktrees,
  laneNames,
  spareHeadroom,
  worktreeCount,
} from '../src/lanes/count.ts'
import { DiskProbeError, estimateLaneBytes } from '../src/lanes/disk.ts'
import { refusal } from '../src/run/host.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

const workflow = (options: {
  capacity: number
  crew?: readonly string[]
  maxSpareCrew?: number
}): Workflow =>
  WorkflowSchema.parse({
    schema_version: 1,
    id: 'count-fixture',
    base_branch: 'main',
    defaults: {
      harness: 'claude-code',
      model: 'opus',
      pipeline: 'standard-phase',
      ...(options.maxSpareCrew === undefined ? {} : { max_spare_crew: options.maxSpareCrew }),
    },
    resources: { lane: { capacity: options.capacity, kind: 'worktree' } },
    crew: Object.fromEntries(
      (options.crew ?? []).map((id) => [id, { tier: 1, model: 'opus' }]),
    ),
    nodes: [
      {
        id: 'p1',
        name: 'One',
        prompt_ref: 'plan.md#phase-1',
        ...(options.crew === undefined ? {} : { crew: options.crew[0] }),
      },
    ],
  })

describe('the worktree count', () => {
  it('is capacity lanes plus the integration worktree on a fresh unstaffed run', () => {
    const count = worktreeCount(workflow({ capacity: 3 }))

    expect(count).toEqual({ lanes: 3, integration: 1, spares: 0, adopted: 0, total: 4, creating: 4 })
    expect(describeWorktrees(count)).toBe('3 lanes + 1 integration worktree')
  })

  it('is one lane per crew member when the roster outnumbers the capacity', () => {
    // Capacity bounds how many phases run at once. Every member still gets a
    // desk for the whole run, and a desk is a worktree.
    const staffed = workflow({ capacity: 2, crew: ['a', 'b', 'c', 'd', 'e'], maxSpareCrew: 0 })

    expect(worktreeCount(staffed)).toMatchObject({ lanes: 5, total: 6, creating: 6 })
    expect(laneNames(staffed, 'r')).toEqual([
      'r-crew-1-a',
      'r-crew-2-b',
      'r-crew-3-c',
      'r-crew-4-d',
      'r-crew-5-e',
    ])
  })

  it('weighs spare-crew headroom on a staffed run, and none on an unstaffed one', () => {
    const staffed = workflow({ capacity: 2, crew: ['a', 'b'], maxSpareCrew: 2 })
    const count = worktreeCount(staffed)

    expect(count).toMatchObject({ lanes: 2, spares: 2, total: 5, creating: 5 })
    expect(describeWorktrees(count)).toBe('2 lanes + 1 integration worktree + 2 spare-crew worktrees')
    // An unstaffed run has no member to copy, so `max_spare_crew` adds nothing.
    expect(spareHeadroom(workflow({ capacity: 2, maxSpareCrew: 4 }))).toBe(0)
  })

  it('charges a resume only for what is not already on disk', () => {
    const staffed = workflow({ capacity: 3, crew: ['a', 'b', 'c', 'd', 'e'], maxSpareCrew: 0 })

    // The observed case: every up-front worktree survived, so nothing is new.
    const all = worktreeCount(staffed, 6)
    expect(all).toMatchObject({ total: 6, adopted: 6, creating: 0 })
    expect(describeWorktrees(all)).toBe('5 lanes + 1 integration worktree (6 already on disk)')

    // A run that died partway through provisioning left only some.
    expect(worktreeCount(staffed, 2).creating).toBe(4)
  })

  it('never lets adoption cover spare headroom', () => {
    // A resumed scheduler starts with no spares and may take on different ones,
    // so their desks are new whatever stands on disk.
    expect(countWorktrees({ lanes: 2, spares: 2, adopted: 9 })).toMatchObject({
      adopted: 3,
      creating: 2,
    })
  })

  it('reaches the refusal line, which names the pool the probe sized', () => {
    const staffed = workflow({ capacity: 2, crew: ['a', 'b', 'c'], maxSpareCrew: 1 })
    const error = new DiskProbeError(
      { requiredBytes: 10, availableBytes: 1, fits: false },
      countWorktrees({ lanes: 3, spares: 1, adopted: 2 }),
    )

    const message = refusal(error, staffed, '/lanes')

    expect(message).toContain('3 lanes + 1 integration worktree + 1 spare-crew worktree (2 already on disk)')
    expect(message).toContain('for 3 new')
    expect(message).toContain('max_spare_crew')
    // Not the old "capacity lanes" sentence, which described a different pool.
    expect(message).not.toContain('2 lanes')
  })
})

describe('the per-lane estimate', () => {
  const temps: string[] = []
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  })

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })

  /** A checkout whose ignored contents dwarf what a lane actually gets. */
  const checkout = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-lane-estimate-'))
    temps.push(dir)
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'user.email', 't@example.com')
    git(dir, 'config', 'user.name', 'T')
    git(dir, 'config', 'maintenance.auto', 'false')
    await writeFile(join(dir, '.gitignore'), 'node_modules\n.env\n.vinta-ai-maestro/\n.mypy_cache/\n')
    await writeFile(join(dir, 'tracked.txt'), 'x'.repeat(1_000))
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'seed')
    return dir
  }

  const tracked = (dir: string): number =>
    statSync(join(dir, '.gitignore')).size + statSync(join(dir, 'tracked.txt')).size
  const index = (dir: string): number => statSync(join(dir, '.git', 'index')).size

  it('counts the tracked tree, the copied deps and the env files, and nothing else', async () => {
    const dir = await checkout()
    // What a lane gets.
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'y'.repeat(2_000))
    await writeFile(join(dir, '.env'), 'z'.repeat(100))
    // What it does not: the maestro store with a lane inside it, an ignored
    // cache, and an untracked file nobody copies.
    await mkdir(join(dir, '.vinta-ai-maestro', 'runs'), { recursive: true })
    await writeFile(join(dir, '.vinta-ai-maestro', 'runs', 'gate-cache.db'), 'c'.repeat(50_000))
    git(dir, 'worktree', 'add', '-q', '-b', 'wt/nested', join(dir, '.vinta-ai-maestro', 'lanes', 'nested'))
    await writeFile(join(dir, '.vinta-ai-maestro', 'lanes', 'nested', 'big'), 'n'.repeat(50_000))
    await mkdir(join(dir, '.mypy_cache'))
    await writeFile(join(dir, '.mypy_cache', 'cache.json'), 'm'.repeat(50_000))
    await writeFile(join(dir, 'scratch.bin'), 's'.repeat(50_000))

    const estimate = await estimateLaneBytes({ repoPath: dir, baseRef: 'main', envFiles: ['.env'] })

    const deps = statSync(join(dir, 'node_modules')).size + statSync(join(dir, 'node_modules', 'pkg')).size + 2_000
    expect(estimate).toBe(tracked(dir) + index(dir) + deps + 100)
  })

  it('sizes the tree at the base ref, not the working copy', async () => {
    const dir = await checkout()
    // Uncommitted growth is the main checkout's, not something a lane checks out.
    await writeFile(join(dir, 'tracked.txt'), 'x'.repeat(90_000))

    expect(await estimateLaneBytes({ repoPath: dir, baseRef: 'main' })).toBe(1_000 + statSync(join(dir, '.gitignore')).size + index(dir))
  })

  it('falls back to HEAD when the base ref does not resolve yet', async () => {
    const dir = await checkout()

    expect(await estimateLaneBytes({ repoPath: dir, baseRef: 'plan/not-cut-yet' })).toBe(
      tracked(dir) + index(dir),
    )
  })

  it('charges nothing for a dependency tree that is a link, which a lane links too', async () => {
    const dir = await checkout()
    const elsewhere = mkdtempSync(join(tmpdir(), 'vinta-lane-estimate-deps-'))
    temps.push(elsewhere)
    await writeFile(join(elsewhere, 'huge'), 'h'.repeat(50_000))
    await symlink(elsewhere, join(dir, 'node_modules'))

    expect(await estimateLaneBytes({ repoPath: dir, baseRef: 'main' })).toBe(tracked(dir) + index(dir))
  })
})
