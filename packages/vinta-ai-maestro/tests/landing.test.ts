/**
 * Landing a finished run and carrying a fix forward after it (`landing/`),
 * against real git repositories in temp directories.
 *
 * Both come from one 34-hour run's aftermath. Its 36 PRs said nothing about
 * which to merge, were merged in an order that resolved the same conflicts
 * several times, and left six phase PRs open whose only commit was a GitHub
 * "Update branch" merge of work already landed. And a fix found after the run
 * had to be merged by hand into three wave branches from a separate checkout.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { landCommand, propagateCommand, syncBaseCommand } from '../src/cli/land.ts'
import type { Io } from '../src/cli/io.ts'
import { openJournal } from '../src/journal/journal.ts'
import { addsNothing, type Forge } from '../src/landing/land.ts'
import { liveBranches } from '../src/landing/live.ts'
import { planPropagation, propagate } from '../src/landing/propagate.ts'
import { baseSource, planSyncBase, syncBase } from '../src/landing/sync-base.ts'
import { MAESTRO_RUN_ENV, MAESTRO_TOKEN_ENV, MAESTRO_URL_ENV } from '../src/resources/agent-leases.ts'
import { WorkflowSchema } from '../src/types.ts'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const isAncestor = (cwd: string, a: string, b: string): boolean => {
  try {
    g(cwd, 'merge-base', '--is-ancestor', a, b)
    return true
  } catch {
    return false
  }
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-landing-'))
  temps.push(dir)
  g(dir, 'init', '-b', 'main')
  g(dir, 'config', 'user.email', 'fixture@example.invalid')
  g(dir, 'config', 'user.name', 'fixture')
  g(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  g(dir, 'add', '--all')
  g(dir, 'commit', '-m', 'base')
  return dir
}

/** One commit on `branch`, cut from `from` if it does not exist yet. */
function commit(dir: string, branch: string, file: string, text: string, from = 'main'): void {
  try {
    g(dir, 'checkout', '-q', branch)
  } catch {
    g(dir, 'checkout', '-q', '-b', branch, from)
  }
  writeFileSync(join(dir, file), text)
  g(dir, 'add', '--all')
  g(dir, 'commit', '-q', '-m', `${branch}: ${file}`)
  g(dir, 'checkout', '-q', 'main')
}

function merge(dir: string, into: string, source: string, from = 'main'): void {
  try {
    g(dir, 'checkout', '-q', into)
  } catch {
    g(dir, 'checkout', '-q', '-b', into, from)
  }
  g(dir, 'merge', '-q', '--no-ff', '--no-edit', source)
  g(dir, 'checkout', '-q', 'main')
}

const P = (name: string): string => `plan/x/${name}`

/** p1, p2 in wave 1; p3 on p1 in wave 2; p4's integration branch merges p1 and p2. */
function builtRun(): string {
  const dir = repo()
  commit(dir, P('phase-p1'), 'p1.txt', 'p1\n')
  commit(dir, P('phase-p2'), 'p2.txt', 'p2\n')
  merge(dir, P('wave-1'), P('phase-p1'))
  merge(dir, P('wave-1'), P('phase-p2'))
  commit(dir, P('phase-p3'), 'p3.txt', 'p3\n', P('phase-p1'))
  merge(dir, P('wave-2'), P('phase-p3'), P('wave-1'))
  merge(dir, P('integ-p4'), P('phase-p2'), P('phase-p1'))
  return dir
}

describe('propagate', () => {
  it('carries a fix on a phase into every branch built from it, keeping the wave chain', async () => {
    const dir = builtRun()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1, fixed\n')

    const steps = await planPropagation({ repoPath: dir, planId: 'x', nodeId: 'p1', phaseBase: 'main' })
    expect(steps).toEqual([
      { branch: P('integ-p4'), source: P('phase-p1') },
      { branch: P('wave-1'), source: P('phase-p1') },
      { branch: P('wave-2'), source: P('wave-1') },
    ])

    const result = await propagate({ repoPath: dir, planId: 'x', nodeId: 'p1', phaseBase: 'main' })
    expect(result).toMatchObject({ kind: 'done', pushed: [] })
    for (const branch of [P('integ-p4'), P('wave-1'), P('wave-2')]) {
      expect(isAncestor(dir, P('phase-p1'), branch)).toBe(true)
    }
    expect(isAncestor(dir, P('wave-1'), P('wave-2'))).toBe(true)
    // A second run finds nothing left to carry.
    expect(await planPropagation({ repoPath: dir, planId: 'x', nodeId: 'p1', phaseBase: 'main' })).toEqual([])
  })

  it('leaves branches that never had the phase alone', async () => {
    const dir = builtRun()
    commit(dir, P('phase-p3'), 'p3.txt', 'p3, fixed\n', P('phase-p1'))
    const steps = await planPropagation({ repoPath: dir, planId: 'x', nodeId: 'p3', phaseBase: P('phase-p1') })
    expect(steps).toEqual([{ branch: P('wave-2'), source: P('phase-p3') }])
  })

  it('moves nothing on a dry run', async () => {
    const dir = builtRun()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1, fixed\n')
    const before = g(dir, 'rev-parse', P('wave-2'))
    const result = await propagate({ repoPath: dir, planId: 'x', nodeId: 'p1', phaseBase: 'main', dryRun: true })
    expect(result.kind).toBe('planned')
    expect(g(dir, 'rev-parse', P('wave-2'))).toBe(before)
  })

  it('stops at a conflict, names the paths, and leaves that branch as it was', async () => {
    const dir = builtRun()
    // A resolution made on the wave that the fix contradicts.
    commit(dir, P('wave-1'), 'p1.txt', 'resolved on the wave\n')
    commit(dir, P('phase-p1'), 'p1.txt', 'p1, fixed differently\n')
    const wave1 = g(dir, 'rev-parse', P('wave-1'))

    const result = await propagate({ repoPath: dir, planId: 'x', nodeId: 'p1', phaseBase: 'main' })
    expect(result).toMatchObject({ kind: 'conflict', at: { branch: P('wave-1') }, paths: ['p1.txt'] })
    expect(g(dir, 'rev-parse', P('wave-1'))).toBe(wave1)
    // The scratch worktree is gone; only the main checkout is left.
    expect(g(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  })

  it('releases a branch the run’s own worktree holds, and refuses one somebody else’s holds', async () => {
    const dir = builtRun()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1, fixed\n')
    mkdirSync(join(dir, '.vinta-ai-maestro', 'lanes'), { recursive: true })
    // Real paths: git reports worktrees by theirs, and a temp directory is often a symlink.
    const lanes = realpathSync(join(dir, '.vinta-ai-maestro', 'lanes'))
    g(dir, 'worktree', 'add', '-q', join(lanes, 'run-integ'), P('wave-2'))

    // One spelling for both sides: git prints Windows paths with forward
    // slashes, and Windows paths ignore case.
    const spell = (path: string): string => {
      const native = realpathSync.native(path)
      return process.platform === 'win32' ? native.toLowerCase() : native
    }
    const own = (path: string): boolean => spell(path).startsWith(spell(lanes))
    expect(await propagate({ repoPath: dir, planId: 'x', nodeId: 'p1', phaseBase: 'main', ownWorktrees: own })).toMatchObject({
      kind: 'done',
    })
    expect(isAncestor(dir, P('phase-p1'), P('wave-2'))).toBe(true)

    commit(dir, P('phase-p1'), 'p1.txt', 'p1, fixed again\n')
    const elsewhere = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-elsewhere-'))
    temps.push(elsewhere)
    g(dir, 'worktree', 'add', '-q', join(elsewhere, 'tree'), P('wave-1'))
    expect(await propagate({ repoPath: dir, planId: 'x', nodeId: 'p1', phaseBase: 'main', ownWorktrees: own })).toMatchObject({
      kind: 'held',
      branch: P('wave-1'),
    })
  })

  it('propagates a finished run from the command line', async () => {
    const dir = builtRun()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1, fixed\n')
    const journal = openJournal(dir)
    journal.createRun('r1', workflow())
    journal.append({ runId: 'r1', nodeId: 'p1', type: 'node_assigned', payload: { branch: P('phase-p1'), base_branch: 'main' } })
    journal.append({ runId: 'r1', type: 'run_ended', payload: { status: 'done' } })
    journal.close()

    const io = recorder()
    expect(await propagateCommand(['r1', 'p1', '--repo', dir, '--dry-run'], io.io)).toBe(0)
    expect(io.out).toContain(`would merge ${P('phase-p1')} into ${P('wave-1')}`)
    expect(await propagateCommand(['r1', 'p1', '--repo', dir], recorder().io)).toBe(0)
    expect(isAncestor(dir, P('phase-p1'), P('wave-2'))).toBe(true)
  })
})

describe('land', () => {
  it('tells a PR whose work landed from one that still carries some', async () => {
    const dir = repo()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1\n')
    commit(dir, P('phase-p2'), 'p2.txt', 'p2\n')
    merge(dir, P('wave-1'), P('phase-p1'))
    // The plan PR merged: wave-1 is in main.
    g(dir, 'merge', '-q', '--no-ff', '--no-edit', P('wave-1'))
    // GitHub's "Update branch" on the landed phase: a merge of main into it.
    merge(dir, P('phase-p1'), 'main', P('phase-p1'))

    expect(await addsNothing(dir, null, P('phase-p1'), 'main')).toBe(true)
    expect(await addsNothing(dir, null, P('phase-p2'), 'main')).toBe(false)
    expect(await addsNothing(dir, null, 'plan/x/no-such-branch', 'main')).toBeNull()
  })

  it('decides by content: bookkeeping merges that are not in the base still add nothing', async () => {
    const dir = repo()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1\n')
    commit(dir, P('phase-p2'), 'p2.txt', 'p2\n')
    // integ-p4: p1 with p2 merged in, then main merged in on top — a merge
    // whose first parent is the integ branch's own merge, which main never gets.
    merge(dir, P('integ-p4'), P('phase-p2'), P('phase-p1'))
    commit(dir, 'main', 'other.txt', 'unrelated\n')
    merge(dir, P('integ-p4'), 'main', P('integ-p4'))
    // The plan PR lands p1 and p2 through the waves, not through integ-p4.
    merge(dir, P('wave-1'), P('phase-p1'))
    merge(dir, P('wave-1'), P('phase-p2'))
    g(dir, 'merge', '-q', '--no-ff', '--no-edit', P('wave-1'))

    expect(isAncestor(dir, P('integ-p4'), 'main')).toBe(false)
    expect(await addsNothing(dir, null, P('integ-p4'), 'main')).toBe(true)

    // One more line on the integ branch is work the base lacks.
    commit(dir, P('integ-p4'), 'p4.txt', 'p4\n')
    expect(await addsNothing(dir, null, P('integ-p4'), 'main')).toBe(false)
  })

  it('names a draft plan PR as one, and marks it ready with --ready', async () => {
    const dir = repo()
    const journal = openJournal(dir)
    journal.createRun('r1', workflow())
    journal.append({
      runId: 'r1',
      type: 'run_pr',
      payload: { opened: true, base: 'main', head: P('wave-1'), url: 'https://example.invalid/pull/plan' },
    })
    journal.close()
    const readied: string[] = []
    const forge: Forge = {
      view: async () => ({ state: 'open', head: P('wave-1'), base: 'main', draft: true }),
      close: async () => true,
      ready: async (url) => {
        readied.push(url)
        return true
      },
    }

    const look = recorder()
    expect(await landCommand(['r1', '--repo', dir], look.io, { forge })).toBe(0)
    expect(look.out.join('\n')).toContain('Plan PR: https://example.invalid/pull/plan (open, draft)')
    expect(look.out.join('\n')).toContain('GitHub will not merge a draft')
    expect(readied).toEqual([])

    const act = recorder()
    expect(await landCommand(['r1', '--repo', dir, '--ready'], act.io, { forge })).toBe(0)
    expect(readied).toEqual(['https://example.invalid/pull/plan'])
    expect(act.out).toContain('Marked it ready for review.')
  })

  it('names the one PR to merge, and closes only the landed ones with --close', async () => {
    const dir = repo()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1\n')
    commit(dir, P('phase-p2'), 'p2.txt', 'p2\n')
    merge(dir, P('wave-1'), P('phase-p1'))
    g(dir, 'merge', '-q', '--no-ff', '--no-edit', P('wave-1'))

    const journal = openJournal(dir)
    journal.createRun('r1', workflow())
    for (const nodeId of ['p1', 'p2']) {
      journal.append({
        runId: 'r1',
        nodeId,
        type: 'node_pr',
        payload: { kind: 'phase', opened: true, base: 'main', head: P(`phase-${nodeId}`), url: `https://example.invalid/pull/${nodeId}` },
      })
    }
    journal.append({
      runId: 'r1',
      type: 'run_pr',
      payload: { opened: true, base: 'main', head: P('wave-1'), url: 'https://example.invalid/pull/plan' },
    })
    journal.close()

    const closed: { url: string; comment: string }[] = []
    const forge: Forge = {
      view: async (url) =>
        url.endsWith('/plan')
          ? { state: 'merged', head: P('wave-1'), base: 'main' }
          : { state: 'open', head: P(`phase-${url.slice(url.lastIndexOf('/') + 1)}`), base: 'main' },
      close: async (url, comment) => {
        closed.push({ url, comment })
        return true
      },
    }

    const look = recorder()
    expect(await landCommand(['r1', '--repo', dir], look.io, { forge })).toBe(0)
    const text = look.out.join('\n')
    expect(text).toContain('Plan PR: https://example.invalid/pull/plan (merged)')
    expect(text).toContain('merging the plan PR into main with a merge commit, and nothing else')
    expect(text).toContain('phase p1  https://example.invalid/pull/p1  open — its work is already in the base')
    expect(text).toContain('phase p2  https://example.invalid/pull/p2  open — carries work the base does not have yet')
    expect(closed).toEqual([])

    expect(await landCommand(['r1', '--repo', dir, '--close'], recorder().io, { forge })).toBe(0)
    expect(closed.map((entry) => entry.url)).toEqual(['https://example.invalid/pull/p1'])
    expect(closed[0]?.comment).toContain('landed through the plan PR https://example.invalid/pull/plan')
  })
})

function workflow() {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'x',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    gates: { unit: { cmd: 'true' } },
    nodes: [
      { id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit'] },
      { id: 'p2', name: 'Two', prompt_ref: 'plan.md#2', gates: ['unit'] },
    ],
  })
}

function recorder(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: { out: (line) => out.push(line), err: (line) => err.push(line), confirm: async () => false },
  }
}

/** builtRun, with a plan branch under its waves, and main moved on since. */
function planRun(): string {
  const dir = repo()
  g(dir, 'branch', P('base'), 'main')
  commit(dir, P('phase-p1'), 'p1.txt', 'p1\n', P('base'))
  commit(dir, P('phase-p2'), 'p2.txt', 'p2\n', P('base'))
  merge(dir, P('wave-1'), P('phase-p1'), P('base'))
  merge(dir, P('wave-1'), P('phase-p2'))
  commit(dir, P('phase-p3'), 'p3.txt', 'p3\n', P('phase-p1'))
  merge(dir, P('wave-2'), P('phase-p3'), P('wave-1'))
  commit(dir, 'main', 'main.txt', 'main moved on\n')
  return dir
}

describe('sync-base', () => {
  it('brings main into the plan branch and every wave, keeping the chain', async () => {
    const dir = planRun()
    const options = { repoPath: dir, planId: 'x', baseBranch: 'main' }
    expect(await planSyncBase(options)).toEqual([
      { branch: P('base'), source: 'main' },
      { branch: P('wave-1'), source: P('base') },
      { branch: P('wave-2'), source: P('wave-1') },
    ])

    expect(await syncBase(options)).toMatchObject({ kind: 'done', pushed: [] })
    for (const branch of [P('base'), P('wave-1'), P('wave-2')]) expect(isAncestor(dir, 'main', branch)).toBe(true)
    expect(isAncestor(dir, P('wave-1'), P('wave-2'))).toBe(true)
    expect(await planSyncBase(options)).toEqual([])
  })

  it('reads the base from the remote when the local branch is behind it', async () => {
    const upstream = planRun()
    const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-clone-'))
    temps.push(dir)
    g(dir, 'clone', '-q', upstream, '.')
    for (const name of ['base', 'wave-1', 'wave-2']) g(dir, 'branch', '-q', P(name), `origin/${P(name)}`)
    g(dir, 'reset', '-q', '--hard', 'HEAD~1')
    expect(await baseSource(dir, 'main')).toBe('refs/remotes/origin/main')
    const steps = await planSyncBase({ repoPath: dir, planId: 'x', baseBranch: 'main' })
    expect(steps[0]).toEqual({ branch: P('base'), source: 'refs/remotes/origin/main' })
  })

  it('stops at a wave that conflicts with the base, leaving it as it was', async () => {
    const dir = planRun()
    commit(dir, P('wave-1'), 'main.txt', 'a wave said otherwise\n')
    const wave1 = g(dir, 'rev-parse', P('wave-1'))
    const result = await syncBase({ repoPath: dir, planId: 'x', baseBranch: 'main' })
    expect(result).toMatchObject({
      kind: 'conflict',
      done: [{ branch: P('base') }],
      at: { branch: P('wave-1') },
      paths: ['main.txt'],
    })
    expect(g(dir, 'rev-parse', P('wave-1'))).toBe(wave1)
  })

  it('on a live run, merges the plan branch without a checkout and gives each wave to the fixer', async () => {
    const dir = planRun()
    const waves: { branch: string; source: string }[] = []
    const after: string[] = []
    const result = await syncBase({
      repoPath: dir,
      planId: 'x',
      baseBranch: 'main',
      mergeWave: async (step) => {
        waves.push(step)
        g(dir, 'checkout', '-q', step.branch)
        g(dir, 'merge', '-q', '--no-ff', '--no-edit', step.source)
        g(dir, 'checkout', '-q', 'main')
        return null
      },
      afterMerge: async (step) => {
        after.push(step.branch)
      },
    })
    expect(result).toMatchObject({ kind: 'done' })
    expect(isAncestor(dir, 'main', P('base'))).toBe(true)
    expect(g(dir, 'rev-list', '--parents', '-n', '1', P('base')).split(' ')).toHaveLength(3)
    expect(waves).toEqual([
      { branch: P('wave-1'), source: P('base') },
      { branch: P('wave-2'), source: P('wave-1') },
    ])
    expect(after).toEqual([P('base'), P('wave-1'), P('wave-2')])
  })

  it('never gives the plan branch’s own conflict to the fixer', async () => {
    const dir = planRun()
    commit(dir, P('base'), 'main.txt', 'the plan’s own config\n')
    const base = g(dir, 'rev-parse', P('base'))
    let asked = 0
    const result = await syncBase({
      repoPath: dir,
      planId: 'x',
      baseBranch: 'main',
      mergeWave: async () => {
        asked += 1
        return null
      },
    })
    expect(result).toMatchObject({ kind: 'conflict', at: { branch: P('base') }, paths: ['main.txt'] })
    expect(asked).toBe(0)
    expect(g(dir, 'rev-parse', P('base'))).toBe(base)
  })

  it('syncs a run that is not live from the command line', async () => {
    const dir = planRun()
    const journal = openJournal(dir)
    journal.createRun('r1', workflow())
    journal.close()
    const look = recorder()
    expect(await syncBaseCommand(['r1', '--repo', dir, '--dry-run'], look.io, { env: {} })).toBe(0)
    expect(look.out).toContain(`would merge main into ${P('base')}`)
    expect(await syncBaseCommand(['r1', '--repo', dir], recorder().io, { env: {} })).toBe(0)
    expect(isAncestor(dir, 'main', P('wave-2'))).toBe(true)
  })
})

describe('a live run', () => {
  it('makes propagate and sync-base hold the integration queue', async () => {
    const dir = planRun()
    commit(dir, P('phase-p1'), 'p1.txt', 'p1, fixed\n', P('base'))
    const held: string[] = []
    const port = liveBranches({
      repoPath: dir,
      laneRoot: join(dir, '.vinta-ai-maestro', 'lanes'),
      plan: () => ({ id: 'x', baseBranch: 'main' }),
      phaseBase: (nodeId) => (nodeId === 'p1' ? P('base') : null),
      hold: async (label, work) => {
        held.push(label)
        return await work()
      },
    })
    expect(await port.propagate({ nodeId: 'nope', dryRun: false, push: false })).toBeNull()
    expect(await port.propagate({ nodeId: 'p1', dryRun: false, push: false })).toMatchObject({ kind: 'done' })
    expect(await port.syncBase({ dryRun: false, push: false })).toMatchObject({ kind: 'done' })
    expect(held).toEqual(['propagate', 'sync-base'])
    expect(isAncestor(dir, P('phase-p1'), P('wave-2'))).toBe(true)
    expect(isAncestor(dir, 'main', P('wave-2'))).toBe(true)
  })

  it('reaches the job from the command line instead of refusing', async () => {
    const dir = repo()
    const sent: { url: string; body: unknown }[] = []
    const fake = (async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) })
      return new Response(
        JSON.stringify({ kind: 'done', steps: [{ branch: P('wave-1'), source: P('phase-p1') }], pushed: [] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const env = { [MAESTRO_URL_ENV]: 'http://job.invalid', [MAESTRO_TOKEN_ENV]: 't', [MAESTRO_RUN_ENV]: 'r1' }
    const look = recorder()
    expect(await propagateCommand(['r1', 'p1', '--repo', dir], look.io, { env, fetch: fake })).toBe(0)
    expect(sent).toEqual([
      { url: 'http://job.invalid/api/runs/r1/branches/propagate', body: { phase: 'p1', dryRun: false, push: true } },
    ])
    expect(look.out).toContain(`merged ${P('phase-p1')} into ${P('wave-1')}`)
  })
})
