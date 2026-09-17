/**
 * Integration against real git repositories in temp directories.
 *
 * Every assertion about topology is made against git itself — `merge-base
 * --is-ancestor`, parent counts, commit subjects — rather than against the
 * branch name the code chose. A base computed correctly and a base *named*
 * correctly are different claims, and only the first one matters at merge time.
 *
 * `gh` is stubbed with a fake that records its argv. Nothing in this file ever
 * reaches a remote.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentTask } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import {
  createAgentConflictFixer,
  type ConflictFixer,
  type ConflictRequest,
} from '../src/integration/fixer.ts'
import type { TranscriptEntry } from '../src/journal/transcript.ts'
import {
  Integrator,
  type IntegrationNode,
  type IntegrationPlan,
  UnresolvedConflictError,
} from '../src/integration/integrator.ts'
import { fakeCliFromSource } from './support/fake-cli.ts'
import { FAKE_BIN_VIA_EXECFILE } from './support/platform.ts'

// ---------------------------------------------------------------------------
// Fixture repository
// ---------------------------------------------------------------------------

const roots: string[] = []

afterEach(async () => {
  // Both on success and on failure: a leaked temp repo outlives the run.
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const run = (cwd: string, ...args: string[]): string =>
  // stderr piped rather than inherited: git narrates every worktree add.
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

interface Repo {
  readonly root: string
  readonly main: string
  readonly integ: string
  lane(name: string): Promise<string>
  commit(cwd: string, files: Readonly<Record<string, string>>, message: string): Promise<void>
}

async function makeRepo(files: Readonly<Record<string, string>> = {}): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-integration-'))
  roots.push(root)
  const main = join(root, 'repo')
  await mkdir(main, { recursive: true })

  run(main, 'init', '-b', 'main')
  run(main, 'config', 'user.email', 'fixture@example.invalid')
  run(main, 'config', 'user.name', 'fixture')
  run(main, 'config', 'commit.gpgsign', 'false')

  const repo: Repo = {
    root,
    main,
    integ: join(root, 'integ'),
    async lane(name: string): Promise<string> {
      const path = join(root, name)
      run(main, 'worktree', 'add', '--detach', path, 'main')
      return path
    },
    async commit(cwd, contents, message): Promise<void> {
      for (const [path, body] of Object.entries(contents)) {
        await writeFile(join(cwd, path), body)
      }
      run(cwd, 'add', '--all')
      run(cwd, 'commit', '-m', message)
    },
  }

  await repo.commit(main, { 'README.md': 'fixture\n', ...files }, 'base')
  // The dedicated integration worktree: detached, so `main` stays checked out
  // in the main checkout exactly as a real pool leaves it.
  run(main, 'worktree', 'add', '--detach', repo.integ, 'main')
  return repo
}

const node = (id: string, deps: readonly string[] = []): IntegrationNode => ({
  id,
  name: `Phase ${id}`,
  prompt_ref: `plan.md#phase-${id}`,
  depends_on: deps.map((dep) => ({ node: dep, artifact: 'artifact' })),
})

const plan = (nodes: readonly IntegrationNode[]): IntegrationPlan => ({
  id: 'wf',
  base_branch: 'main',
  nodes,
})

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => {
  try {
    run(cwd, 'merge-base', '--is-ancestor', ancestor, descendant)
    return true
  } catch {
    return false
  }
}

const subjects = (cwd: string, ref: string): string[] =>
  run(cwd, 'log', '--format=%s', ref).split('\n')

const parents = (cwd: string, ref: string): string[] =>
  run(cwd, 'rev-list', '--parents', '-n', '1', ref).split(' ').slice(1)

/** Every file in a worktree, contents included. `.git` is a file in a worktree. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else files[child] = await readFile(join(dir, child), 'utf8')
    }
  }
  await walk('')
  return files
}

interface SpyFixer extends ConflictFixer {
  readonly calls: ConflictRequest[]
  /** The worktree as the fixer left it, per call. */
  readonly after: Record<string, string>[]
}

/** Stands in for the agent. Whatever it writes is the only content change allowed. */
function spyFixer(resolve?: (request: ConflictRequest) => Promise<void>): SpyFixer {
  const calls: ConflictRequest[] = []
  const after: Record<string, string>[] = []
  return {
    calls,
    after,
    async fix(request: ConflictRequest): Promise<void> {
      calls.push(request)
      await resolve?.(request)
      after.push(await snapshot(request.cwd))
    },
  }
}

const CONFLICTING = { 'app.ts': 'const value = 0\n' }

/** Two nodes, no dependencies, editing the same line of the same file. */
async function conflictingPair(): Promise<Repo> {
  const repo = await makeRepo(CONFLICTING)
  const one = await repo.lane('lane-1')
  const two = await repo.lane('lane-2')
  run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
  await repo.commit(one, { 'app.ts': 'const value = "a"\n' }, 'phase a: value')
  run(two, 'checkout', '-B', 'plan/wf/phase-b', 'main')
  await repo.commit(two, { 'app.ts': 'const value = "b"\n' }, 'phase b: value')
  return repo
}

// ---------------------------------------------------------------------------
// Bases
// ---------------------------------------------------------------------------

describe('dependency-derived bases', () => {
  it('branches a dependency-free node from base_branch', async () => {
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })
    expect(integrator.base('a')).toEqual({ kind: 'base_branch', branch: 'main' })

    const lane = await repo.lane('lane-1')
    await integrator.startNode('a', lane)

    expect(run(lane, 'rev-parse', 'plan/wf/phase-a')).toBe(run(lane, 'rev-parse', 'main'))
    expect(isAncestor(lane, 'main', 'plan/wf/phase-a')).toBe(true)
  })

  /**
   * A retry re-enters the pipeline at its initial state, which runs
   * `git_branch` again. `checkout -B` moves an existing branch unconditionally,
   * so attempt 2 used to begin by resetting attempt 1's commits to base — the
   * files disappeared from the worktree, the next reviewer reported "phase not
   * implemented at all", and the fix budget burned re-implementing from
   * nothing. In a real run it showed as two implementer commits and three
   * `branch: Reset to <base>` entries in one branch's reflog.
   */
  describe('a second attempt at the same phase', () => {
    it('keeps the commits the first attempt made', async () => {
      const repo = await makeRepo()
      const integrator = new Integrator({
        plan: plan([node('a')]),
        integrationPath: repo.integ,
        fixer: spyFixer(),
      })

      const lane = await repo.lane('lane-1')
      await integrator.startNode('a', lane)
      await repo.commit(lane, { 'a.ts': 'the first attempt\n' }, 'phase a: unit')
      const attemptOne = run(lane, 'rev-parse', 'plan/wf/phase-a')

      await integrator.startNode('a', lane, true)

      expect(run(lane, 'rev-parse', 'plan/wf/phase-a')).toBe(attemptOne)
      // And the files are still on disk, which is what the reviewer reads.
      expect(existsSync(join(lane, 'a.ts'))).toBe(true)
      expect(run(lane, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('plan/wf/phase-a')
    })

    it('still moves a branch that committed nothing up to its base', async () => {
      // Nothing is lost by it and the retry starts from a fresher base, which
      // is exactly what the old behaviour got right.
      const repo = await makeRepo()
      const integrator = new Integrator({
        plan: plan([node('a')]),
        integrationPath: repo.integ,
        fixer: spyFixer(),
      })

      const lane = await repo.lane('lane-1')
      await integrator.startNode('a', lane)
      // In the main checkout, which is where `main` is actually checked out —
      // the integration worktree is detached and committing there moves nothing.
      await repo.commit(repo.main, { 'moved.ts': 'base moved on\n' }, 'base: another commit')

      await integrator.startNode('a', lane, true)

      expect(run(lane, 'rev-parse', 'plan/wf/phase-a')).toBe(run(lane, 'rev-parse', 'main'))
    })

    it('cuts a fresh branch when the node has not been branched in this run', async () => {
      // A phase branch's name carries the plan id and not the run id, so an
      // identically-named ref left by an unrelated earlier run is not this
      // run's previous attempt and must not be inherited.
      const repo = await makeRepo()
      const integrator = new Integrator({
        plan: plan([node('a')]),
        integrationPath: repo.integ,
        fixer: spyFixer(),
      })

      const lane = await repo.lane('lane-1')
      run(lane, 'checkout', '-B', 'plan/wf/phase-a', 'main')
      await repo.commit(lane, { 'stale.ts': 'from a run last week\n' }, 'an older run')

      await integrator.startNode('a', lane)

      expect(run(lane, 'rev-parse', 'plan/wf/phase-a')).toBe(run(lane, 'rev-parse', 'main'))
      expect(existsSync(join(lane, 'stale.ts'))).toBe(false)
    })

    it('does not rebase onto a base that moved under it', async () => {
      // Either a rebase or a fast-forward could conflict, and a conflict here
      // would fail the retry during its *setup* — before the agent that might
      // resolve it has run. An out-of-date base is what any feature branch has,
      // and the wave merge is what reconciles it.
      const repo = await makeRepo()
      const integrator = new Integrator({
        plan: plan([node('a')]),
        integrationPath: repo.integ,
        fixer: spyFixer(),
      })

      const lane = await repo.lane('lane-1')
      await integrator.startNode('a', lane)
      await repo.commit(lane, { 'a.ts': 'the first attempt\n' }, 'phase a: unit')
      const attemptOne = run(lane, 'rev-parse', 'plan/wf/phase-a')
      await repo.commit(repo.main, { 'moved.ts': 'base moved on\n' }, 'base: another commit')

      await integrator.startNode('a', lane, true)

      expect(run(lane, 'rev-parse', 'plan/wf/phase-a')).toBe(attemptOne)
      expect(isAncestor(lane, 'main', 'plan/wf/phase-a')).toBe(false)
    })
  })

  it('branches a single-dependency node from that dependency’s branch', async () => {
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b', ['a'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })
    expect(integrator.base('b')).toEqual({
      kind: 'dependency',
      branch: 'plan/wf/phase-a',
      node: 'a',
    })

    const one = await repo.lane('lane-1')
    await integrator.startNode('a', one)
    await repo.commit(one, { 'a.ts': 'a\n' }, 'phase a: unit')

    const two = await repo.lane('lane-2')
    await integrator.startNode('b', two)
    await repo.commit(two, { 'b.ts': 'b\n' }, 'phase b: unit')

    // Ancestry, not the name: a's commit is genuinely in b's history.
    expect(isAncestor(two, 'plan/wf/phase-a', 'plan/wf/phase-b')).toBe(true)
    expect(run(two, 'merge-base', 'plan/wf/phase-a', 'plan/wf/phase-b')).toBe(
      run(two, 'rev-parse', 'plan/wf/phase-a'),
    )
    expect(subjects(two, 'plan/wf/phase-b')).toContain('phase a: unit')
  })

  it('branches a multi-dependency node from an integ- merge of every dependency', async () => {
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('d', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })
    expect(integrator.base('d')).toEqual({
      kind: 'integration',
      branch: 'plan/wf/integ-d',
      nodes: ['a', 'b'],
    })

    const one = await repo.lane('lane-1')
    await integrator.startNode('a', one)
    await repo.commit(one, { 'a.ts': 'a\n' }, 'phase a: unit')
    const two = await repo.lane('lane-2')
    await integrator.startNode('b', two)
    await repo.commit(two, { 'b.ts': 'b\n' }, 'phase b: unit')

    const base = await integrator.prepareBase('d')
    expect(base).toBe('plan/wf/integ-d')

    // The integ branch really contains both parents' commits.
    expect(isAncestor(repo.integ, 'plan/wf/phase-a', base)).toBe(true)
    expect(isAncestor(repo.integ, 'plan/wf/phase-b', base)).toBe(true)
    expect(parents(repo.integ, base)).toHaveLength(2)
    expect(run(repo.integ, 'show', `${base}:a.ts`)).toBe('a')
    expect(run(repo.integ, 'show', `${base}:b.ts`)).toBe('b')

    const three = await repo.lane('lane-3')
    await integrator.startNode('d', three)
    expect(run(three, 'rev-parse', 'plan/wf/phase-d')).toBe(run(three, 'rev-parse', base))
  })
})

// ---------------------------------------------------------------------------
// Waves
// ---------------------------------------------------------------------------

describe('a base that was already prepared', () => {
  /**
   * The cost this avoids. A phase whose base conflicted fails *after* the base
   * was built — building it is what happens first — so every retry came back
   * through `prepareBase`, which reset and re-merged unconditionally and spawned
   * a fresh fixer to redo work that was already done. One observed run paid for
   * the same resolution three times, minutes and real money each.
   */
  it('does not merge again, and does not call the fixer again', async () => {
    const repo = await conflictingPair()
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
    })

    const first = await integrator.prepareBase('c')
    expect(fixer.calls).toHaveLength(1)
    const built = run(repo.integ, 'rev-parse', first)

    // The retry. Same base, untouched, and no second fix round bought.
    const second = await integrator.prepareBase('c')
    expect(second).toBe(first)
    expect(fixer.calls).toHaveLength(1)
    expect(run(repo.integ, 'rev-parse', second)).toBe(built)
  })

  /**
   * The resolution a person finished by hand is the thing most worth keeping:
   * a conflict no fixer could settle is meant to be completable in this
   * worktree, and the rebuild used to discard it before the next attempt looked.
   */
  it('keeps a resolution that was finished by hand', async () => {
    const repo = await conflictingPair()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(async (request) => {
        await writeFile(join(request.cwd, 'app.ts'), 'const value = "fixer"\n')
      }),
    })

    await integrator.prepareBase('c')
    // Somebody improves on it, in the integration worktree, by hand.
    await writeFile(join(repo.integ, 'app.ts'), 'const value = "by hand"\n')
    run(repo.integ, 'add', '--all')
    run(repo.integ, 'commit', '-m', 'resolve by hand')

    await integrator.prepareBase('c')

    expect(run(repo.integ, 'show', 'plan/wf/integ-c:app.ts').trim()).toBe('const value = "by hand"')
  })

  /**
   * Reuse is about the dependencies' *current* tips, not about the branch
   * existing. A dependency that was retried and re-implemented has a tip this
   * base has never seen, and handing the phase a base built on the old one
   * would give it work that is no longer there.
   */
  it('rebuilds when a dependency has moved since', async () => {
    const repo = await conflictingPair()
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
    })

    await integrator.prepareBase('c')
    expect(fixer.calls).toHaveLength(1)

    // `b` is retried and lands a new commit. `conflictingPair` already cut this
    // worktree, so it is reused rather than added again.
    const two = join(repo.root, 'lane-2')
    run(two, 'checkout', 'plan/wf/phase-b')
    await repo.commit(two, { 'extra.ts': 'export const extra = 1\n' }, 'phase b: again')

    await integrator.prepareBase('c')

    expect(fixer.calls).toHaveLength(2)
    expect(isAncestor(repo.integ, 'plan/wf/phase-b', 'plan/wf/integ-c')).toBe(true)
  })
})

describe('reporting a conflict as it is settled', () => {
  /**
   * A conflict is an ordinary outcome — the plan's file-overlap analysis is a
   * guess and two sibling phases legitimately edit one file — but nothing
   * recorded that one had happened. `mergeWave` returned its conflicts to its
   * caller and `prepareBase` discarded its own, so a phase sat in `running` for
   * minutes while an agent merged in a worktree nobody could see.
   */
  it('reports the conflict from a base merge, which was recorded nowhere at all', async () => {
    const repo = await conflictingPair()
    const seen: { where: string; branch: string; nodes: readonly string[]; paths: readonly string[] }[] = []
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(async (request) => {
        await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
      }),
      onConflict: (conflict) => seen.push(conflict),
    })

    await integrator.prepareBase('c')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.where).toBe('base')
    expect(seen[0]?.branch).toBe('plan/wf/integ-c')
    expect(seen[0]?.paths).toEqual(['app.ts'])
    // Both participants, not only the one whose merge happened to be second.
    expect(seen[0]?.nodes).toEqual(['a', 'b'])
  })

  it('reports a wave conflict too, as it happens rather than at the end', async () => {
    const repo = await conflictingPair()
    const seen: { where: string; branch: string }[] = []
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer: spyFixer(async (request) => {
        await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
      }),
      onConflict: (conflict) => seen.push(conflict),
    })

    const wave = await integrator.mergeWave(1)

    expect(seen.map((entry) => entry.where)).toEqual(['wave'])
    expect(seen[0]?.branch).toBe(wave.branch)
    // Still returned as well: the post-mortem reads the return value.
    expect(wave.conflicts).toHaveLength(1)
  })

  it('says nothing when a merge is clean', async () => {
    const repo = await makeRepo()
    const seen: unknown[] = []
    const one = await repo.lane('lane-1')
    run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
    await repo.commit(one, { 'a.ts': 'export const a = 1\n' }, 'phase a')
    const integrator = new Integrator({
      plan: plan([node('a')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
      onConflict: (conflict) => seen.push(conflict),
    })

    await integrator.mergeWave(1)
    expect(seen).toEqual([])
  })
})

describe('wave merges', () => {
  it('merges every wave node with --no-ff, keeping the unit commits', async () => {
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })

    const one = await repo.lane('lane-1')
    await integrator.startNode('a', one)
    await repo.commit(one, { 'a1.ts': '1\n' }, 'phase a: unit 1')
    await repo.commit(one, { 'a2.ts': '2\n' }, 'phase a: unit 2')
    const two = await repo.lane('lane-2')
    await integrator.startNode('b', two)
    await repo.commit(two, { 'b1.ts': '1\n' }, 'phase b: unit 1')

    const wave1 = await integrator.mergeWave(1)
    expect(wave1).toMatchObject({ branch: 'plan/wf/wave-1', merged: ['a', 'b'], conflicts: [] })

    // --no-ff: both merges produced a merge commit, even the first one, which
    // could have fast-forwarded off main.
    expect(run(repo.integ, 'rev-list', '--merges', '--count', wave1.branch)).toBe('2')
    expect(parents(repo.integ, wave1.branch)).toHaveLength(2)

    // Never squashed: every atomic unit commit survives integration.
    const log = subjects(repo.integ, wave1.branch)
    expect(log).toContain('phase a: unit 1')
    expect(log).toContain('phase a: unit 2')
    expect(log).toContain('phase b: unit 1')

    // The spine: wave-2 is built on wave-1, and wave-0 is base_branch itself.
    expect(integrator.waveBranch(0)).toBe('main')
    const three = await repo.lane('lane-3')
    await integrator.startNode('c', three)
    await repo.commit(three, { 'c1.ts': '1\n' }, 'phase c: unit 1')
    const wave2 = await integrator.mergeWave(2)
    expect(wave2.merged).toEqual(['c'])
    expect(isAncestor(repo.integ, wave1.branch, wave2.branch)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe('merge conflicts', () => {
  it('hands the conflict to a fixer agent in the integration worktree and completes the merge', async () => {
    const repo = await conflictingPair()
    const resolved = 'const value = "a" + "b"\n'
    const adapter = new MockAdapter()
    const agent = createAgentConflictFixer({ adapter, model: 'mock-model' })
    const fixer = spyFixer(async (request) => {
      // The real spawn path, then the edit the agent itself would have made.
      await agent.fix(request)
      await writeFile(join(request.cwd, 'app.ts'), resolved)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
    })

    const wave = await integrator.mergeWave(1)

    expect(fixer.calls).toHaveLength(1)
    const request = fixer.calls[0] as ConflictRequest
    // The fixer runs in the dedicated integration worktree — never in a lane.
    expect(request.cwd).toBe(repo.integ)
    expect(request.paths).toEqual(['app.ts'])
    expect(request.nodes).toEqual(['a', 'b'])
    expect(request.promptRefs).toEqual(['plan.md#phase-a', 'plan.md#phase-b'])
    expect(request.round).toBe(1)

    // The agent was spawned in the integration worktree, told which paths and
    // which briefs, and told not to resolve by taking a side.
    expect(adapter.spawned).toHaveLength(1)
    const task = adapter.spawned[0] as AgentTask
    expect(task.cwd).toBe(repo.integ)
    expect(task.nodeId).toBe('b')
    expect(task.prompt).toContain('app.ts')
    expect(task.prompt).toContain('plan.md#phase-a')
    expect(task.prompt).toContain('--ours')

    expect(wave.conflicts).toEqual([{ nodes: ['a', 'b'], paths: ['app.ts'], rounds: 1 }])
    expect(run(repo.integ, 'show', `${wave.branch}:app.ts`).trim()).toBe(resolved.trim())
    expect(run(repo.integ, 'rev-list', '--merges', '--count', wave.branch)).toBe('2')
    // Both sides' commits are in the history: nothing was taken from one side.
    const log = subjects(repo.integ, wave.branch)
    expect(log).toContain('phase a: value')
    expect(log).toContain('phase b: value')
  })

  /**
   * The fix round's turn is written down.
   *
   * The stream was always drained and every event dropped, so the one agent
   * turn in a run that nobody could watch live was also the one nobody could
   * read afterwards: a resolved merge, a row saying it took two rounds, and no
   * record of what was decided. It lands in the incoming phase's own transcript
   * — beside the implementer and reviewer turns that produced the branches now
   * being merged — under a role that keeps it distinguishable from them.
   */
  it('records the fixer’s turn in the incoming phase’s transcript', async () => {
    const repo = await conflictingPair()
    const adapter = new MockAdapter()
    const recorded: { nodeId: string; entry: TranscriptEntry }[] = []
    const agent = createAgentConflictFixer({
      adapter,
      model: 'mock-model',
      record: (nodeId, entry) => recorded.push({ nodeId, entry }),
    })
    const fixer = spyFixer(async (request) => {
      await agent.fix(request)
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
    })

    await integrator.mergeWave(1)

    expect(recorded.length).toBeGreaterThan(0)
    // Filed against the phase whose merge conflicted, not against the branch.
    expect(new Set(recorded.map((line) => line.nodeId))).toEqual(new Set(['b']))
    // Its own role: a phase transcript already interleaves an implementer, a
    // reviewer and review fixers, and this is a fourth job, not a third again.
    expect(recorded.every((line) => line.entry.by?.role === 'conflict-fixer')).toBe(true)
  })

  it('sends a resolution that fails the gate back to the fixer', async () => {
    const repo = await conflictingPair()
    let attempt = 0
    const fixer = spyFixer(async (request) => {
      attempt += 1
      await writeFile(join(request.cwd, 'app.ts'), `const value = "${attempt}"\n`)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
      verify: async () => attempt > 1,
    })

    const wave = await integrator.mergeWave(1)
    expect(fixer.calls.map((call) => call.round)).toEqual([1, 2])
    expect(wave.conflicts[0]?.rounds).toBe(2)
    expect(run(repo.integ, 'show', `${wave.branch}:app.ts`).trim()).toBe('const value = "2"')
  })

  it('changes no file content itself: the committed tree is what the fixer left', async () => {
    const repo = await conflictingPair()
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
    })

    const wave = await integrator.mergeWave(1)

    // Every content change between the fixer returning and the merge commit
    // would show up here. The orchestrator only staged and committed.
    expect(await snapshot(repo.integ)).toEqual(fixer.after.at(-1))
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')
    for (const [path, body] of Object.entries(fixer.after.at(-1) as Record<string, string>)) {
      expect(run(repo.integ, 'show', `${wave.branch}:${path}`)).toBe(body.trimEnd())
    }
  })

  /**
   * The failure this whole branch exists for.
   *
   * An agent told to resolve a conflict reaches for the sequence a person
   * would — abort, merge again, resolve, **commit**. That last step used to
   * break the run: the orchestrator committed unconditionally, so against an
   * already-committed resolution `git add --all` was a no-op exiting 0 and
   * `git commit --no-edit` exited 1 with "nothing to commit", which `git()`
   * turns into a throw. A successful resolution was reported as a failed
   * phase, deterministically, on every wave after a parallel one.
   */
  it('accepts a resolution the fixer committed itself', async () => {
    const repo = await conflictingPair()
    const resolved = 'const value = "a" + "b"\n'
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), resolved)
      // Exactly what the agent did in the run this was found in.
      run(request.cwd, 'add', '--all')
      run(request.cwd, 'commit', '--no-edit')
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
    })

    const wave = await integrator.mergeWave(1)

    expect(wave.conflicts).toEqual([{ nodes: ['a', 'b'], paths: ['app.ts'], rounds: 1 }])
    expect(run(repo.integ, 'show', `${wave.branch}:app.ts`).trim()).toBe(resolved.trim())
    // The incoming phase is in the history — which is the only thing the wave
    // spine needs, and the thing a fixer that threw the merge away would lack.
    const log = subjects(repo.integ, wave.branch)
    expect(log).toContain('phase a: value')
    expect(log).toContain('phase b: value')
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')
  })

  it('still sends a committed resolution back when it fails the gate', async () => {
    const repo = await conflictingPair()
    let attempt = 0
    const fixer = spyFixer(async (request) => {
      attempt += 1
      await writeFile(join(request.cwd, 'app.ts'), `const value = "${attempt}"\n`)
      run(request.cwd, 'add', '--all')
      // Round 1 commits; round 2 leaves it for the orchestrator. Both shapes
      // have to reach `verify`, or a fixer could dodge the gate by committing.
      if (attempt === 1) run(request.cwd, 'commit', '--no-edit')
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
      verify: async () => attempt > 1,
    })

    const wave = await integrator.mergeWave(1)
    expect(fixer.calls.map((call) => call.round)).toEqual([1, 2])
    expect(run(repo.integ, 'show', `${wave.branch}:app.ts`).trim()).toBe('const value = "2"')
  })

  /**
   * A fixer that "resolves" by discarding the merge leaves no conflict markers
   * and a clean tree — indistinguishable from success by those tests alone.
   * Accepting it would record the incoming phase as integrated while its
   * commits are nowhere in the branch, and the defect would surface later as a
   * phase built on work that is not there.
   */
  it('refuses a resolution that threw the merge away', async () => {
    const repo = await conflictingPair()
    const fixer = spyFixer(async (request) => {
      // Tolerant: round 2 is entered with the merge already gone, which is the
      // very state this test is about.
      try {
        run(request.cwd, 'merge', '--abort')
      } catch {
        // Nothing in progress to abort.
      }
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
      maxFixRounds: 2,
    })

    await expect(integrator.mergeWave(1)).rejects.toBeInstanceOf(UnresolvedConflictError)
    expect(fixer.calls.map((call) => call.round)).toEqual([1, 2])
  })

  it('reports a conflict surviving max_fix_rounds as a plan defect naming both nodes', async () => {
    const repo = await conflictingPair()
    // A fixer that returns without resolving anything — conflict markers stay.
    const fixer = spyFixer()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
      maxFixRounds: 2,
    })

    const defect = await integrator.mergeWave(1).then(
      () => null,
      (error: unknown) => error,
    )

    expect(defect).toBeInstanceOf(UnresolvedConflictError)
    const error = defect as UnresolvedConflictError
    expect(error.nodes).toEqual(['a', 'b'])
    expect(error.paths).toEqual(['app.ts'])
    expect(error.rounds).toBe(2)
    expect(error.message).toContain('a')
    expect(error.message).toContain('b')
    expect(error.message).toContain('app.ts')

    // Bounded, not retried forever.
    expect(fixer.calls).toHaveLength(2)
    // And not silently taken from one side: no merge commit was produced.
    expect(run(repo.integ, 'rev-list', '--merges', '--count', 'HEAD')).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * A `gh` that records its argv and prints a URL. Never touches a remote.
 *
 * Source rather than a `FakeCliSpec`: what this fixture is *for* is the argv,
 * and no spec describes "write back what you were called with". Node says it
 * once for both platforms — `process.argv` is the same list under a shebang
 * script and under a `.cmd` shim, which a `for a in "$@"` loop was never going
 * to be. The separator is written as `\n` explicitly so the reader below can
 * split on it whatever the platform's own line ending is.
 */
function stubGh(root: string): { path: string; args: () => Promise<string[]> } {
  const log = join(root, 'gh.log')
  const path = fakeCliFromSource(
    root,
    'gh',
    [
      `import { appendFileSync } from 'node:fs'`,
      `for (const arg of process.argv.slice(2)) {`,
      `  appendFileSync(${JSON.stringify(log)}, arg + '\\n')`,
      `}`,
      `process.stdout.write(${JSON.stringify('https://example.invalid/pr/1\n')})`,
    ].join('\n'),
  )
  return {
    path,
    args: async () => (await readFile(log, 'utf8')).split('\n').filter((line) => line.length > 0),
  }
}

describe('pull requests', () => {
  /**
   * Still POSIX-only, and not because of the fixture.
   *
   * `openPullRequest` (`src/integration/pr.ts`) hands `ghPath` straight to
   * `execFile` rather than through `commandInvocation`, which is fine for a
   * real `gh` — that one is `gh.exe` on Windows and resolves without a shell —
   * but leaves no way to point it at a fixture there: since CVE-2024-27980
   * Node refuses to spawn a `.bat`/`.cmd` without `shell`, and a `.cmd` shim is
   * the only executable form a Node fake can take. The fixture itself is
   * already portable.
   *
   * **Do not "just use the seam" here without reading this.** Every other CLI
   * spawn in the package routes through `commandInvocation` precisely so a
   * `.cmd` shim works, so that looks like the obvious fix — and it would trade
   * a real problem for a worse one. `commandInvocation` builds a `cmd.exe`
   * command line, and `shellQuote` refuses `"` and `%` outright because
   * `cmd.exe` offers no way to escape either inside a quoted region. One of
   * `gh`'s arguments is `--body`: the pull request body, which is derived from
   * the plan and the run and can hold both characters. Routing it through a
   * shell would turn a spawn that cannot be broken by its own payload into one
   * that can — an `UnquotableArgumentError` on a legitimate PR.
   *
   * So the gate comes off when `pr.ts` can reach a `.cmd` *without* putting
   * that body through a shell — `--body-file` instead of `--body` is the
   * shape that gets there, since it leaves only paths and branch names on the
   * command line. That is a change to the product with its own risk, and it
   * does not belong in a commit about test fixtures.
   */
  it.runIf(FAKE_BIN_VIA_EXECFILE)(
    'opens each PR against the node’s own computed base, never base_branch',
    async () => {
      const repo = await makeRepo()
      const gh = stubGh(repo.root)
      const integrator = new Integrator({
        plan: plan([node('a'), node('b'), node('c', ['a']), node('d', ['a', 'b'])]),
        integrationPath: repo.integ,
        fixer: spyFixer(),
        ghPath: gh.path,
      })

      const one = await repo.lane('lane-1')
      await integrator.startNode('a', one)
      await repo.commit(one, { 'a.ts': 'a\n' }, 'phase a: unit')
      const two = await repo.lane('lane-2')
      await integrator.startNode('b', two)
      await repo.commit(two, { 'b.ts': 'b\n' }, 'phase b: unit')

      expect(await integrator.openPr('a')).toMatchObject({
        opened: true,
        base: 'main',
        head: 'plan/wf/phase-a',
        url: 'https://example.invalid/pr/1',
      })
      expect(await integrator.openPr('c')).toMatchObject({
        opened: true,
        base: 'plan/wf/phase-a',
        head: 'plan/wf/phase-c',
      })
      expect(await integrator.openPr('d', { draft: true })).toMatchObject({
        opened: true,
        base: 'plan/wf/integ-d',
      })

      const args = await gh.args()
      expect(args.filter((arg) => arg === '--draft')).toHaveLength(1)
      // A dependent node's PR base is never the run's base branch.
      const bases = args.map((arg, i) => (args[i - 1] === '--base' ? arg : null)).filter(Boolean)
      expect(bases).toEqual(['main', 'plan/wf/phase-a', 'plan/wf/integ-d'])
    },
  )

  it('degrades to a clear report when gh is unavailable', async () => {
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
      ghPath: join(repo.root, 'no-such-gh'),
    })
    const lane = await repo.lane('lane-1')
    await integrator.startNode('a', lane)

    const result = await integrator.openPr('a')
    expect(result).toMatchObject({
      opened: false,
      reason: 'unavailable',
      nodeId: 'a',
      base: 'main',
      head: 'plan/wf/phase-a',
    })
    expect(result.message).toContain('gh is not installed')
    // The run is not failed by it: the branch is untouched and still there.
    expect(run(lane, 'rev-parse', '--verify', 'plan/wf/phase-a')).toHaveLength(40)
  })
})
