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
import type { AgentEvent, AgentTask, HarnessAdapter } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import {
  ConflictFixerTimeout,
  createAgentConflictFixer,
  type ConflictFixer,
  type ConflictRequest,
} from '../src/integration/fixer.ts'
import type { TranscriptEntry } from '../src/journal/transcript.ts'
import {
  type CommitDecision,
  type CommitFailure,
  IntegrationCommitError,
  IntegrationVerifyError,
  IntegrationWorktreeBusyError,
  Integrator,
  type IntegrationNode,
  type IntegrationPlan,
  type ReportedConflict,
  UnresolvedConflictError,
} from '../src/integration/integrator.ts'
import { GIT_STDERR_LIMIT, GitCommandError, git } from '../src/integration/git.ts'
import { clearRedactions, redactValue } from '../src/log/index.ts'
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
   * existing. A dependency that was retried and landed more work has a tip
   * this base has never seen; it is merged on top, which brings in only the
   * new commits and keeps the resolution already made.
   */
  it('merges on top a dependency that has moved since', async () => {
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

    expect(fixer.calls).toHaveLength(1)
    expect(isAncestor(repo.integ, 'plan/wf/phase-b', 'plan/wf/integ-c')).toBe(true)
    expect(run(repo.integ, 'show', 'plan/wf/integ-c:app.ts').trim()).toBe('const value = "a" + "b"')
  })

  /** A dependency redone from scratch: its old commits are in the base and no longer in it. */
  it('rebuilds when a dependency was redone', async () => {
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

    const two = join(repo.root, 'lane-2')
    run(two, 'reset', '--hard', 'main')
    await repo.commit(two, { 'b.ts': 'export const b = 2\n' }, 'phase b, redone')

    await integrator.prepareBase('c')

    expect(fixer.calls).toHaveLength(1)
    expect(run(repo.integ, 'show', 'plan/wf/integ-c:app.ts').trim()).toBe('const value = "a"')
    expect(isAncestor(repo.integ, 'plan/wf/phase-b', 'plan/wf/integ-c')).toBe(true)
  })
})

const RED_GATE = { gateId: 'test', logPath: '/runs/r/nodes/_integration/gates/test.log', exitCode: 1 }

/**
 * Textually resolved, and the merged tree fails a gate: two sibling phases that
 * each added a migration on the same parent. It used to run out its rounds as
 * "unresolved conflict: p4a both changed , …" — no paths, no gate, and the
 * fixer never told what was red.
 */
describe('a merge the gates reject', () => {
  it('hands the red gate to the next round, and names it when the rounds run out', async () => {
    const repo = await conflictingPair()
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      maxFixRounds: 2,
      verify: async () => RED_GATE,
    })

    const failure = await integrator.prepareBase('c').then(
      () => null,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(IntegrationVerifyError)
    const error = failure as IntegrationVerifyError
    expect(error.gate).toEqual(RED_GATE)
    expect(error.message).toContain('gate test')
    expect(error.message).toContain(RED_GATE.logPath)
    expect(fixer.calls[0]?.redGate).toBeUndefined()
    expect(fixer.calls[1]?.redGate).toEqual(RED_GATE)
  })
})

/**
 * `rerere.autoupdate` replays a recorded resolution and stages it, and `git
 * merge` still exits 1: no unmerged path, no marker, `MERGE_HEAD` in place. A
 * fixer was spawned for it anyway, to resolve nothing.
 */
describe('a merge git resolved before any fixer', () => {
  const REPLAYED = 'const value = "a" + "b"\n'

  async function replaying(): Promise<Repo> {
    const repo = await conflictingPair()
    run(repo.main, 'config', 'rerere.enabled', 'true')
    run(repo.main, 'config', 'rerere.autoupdate', 'true')
    const lane = await repo.lane('lane-record')
    run(lane, 'checkout', '-B', 'record', 'plan/wf/phase-a')
    try {
      run(lane, 'merge', '--no-edit', 'plan/wf/phase-b')
    } catch {
      // The conflict being recorded.
    }
    await writeFile(join(lane, 'app.ts'), REPLAYED)
    run(lane, 'add', 'app.ts')
    run(lane, 'commit', '--no-edit')
    return repo
  }

  it('verifies and commits it as resolved in 0 rounds, with no fixer', async () => {
    const repo = await replaying()
    const fixer = spyFixer()
    const reported: { paths: readonly string[]; rounds: number }[] = []
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      verify: async () => true,
      onConflict: (conflict) => reported.push({ paths: conflict.paths, rounds: conflict.rounds }),
    })

    const base = await integrator.prepareBase('c')

    expect(fixer.calls).toHaveLength(0)
    expect(run(repo.integ, 'show', `${base}:app.ts`).trim()).toBe(REPLAYED.trim())
    expect(reported).toEqual([{ paths: ['app.ts'], rounds: 0 }])
    expect(midMerge(repo.integ)).toBe(false)
  })

  it('hands it to the fixer with the red gate when the merged tree fails verify', async () => {
    const repo = await replaying()
    const fixer = spyFixer()
    let verified = 0
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      verify: async () => (verified++ === 0 ? RED_GATE : true),
    })

    await integrator.prepareBase('c')

    expect(fixer.calls).toHaveLength(1)
    expect(fixer.calls[0]?.redGate).toEqual(RED_GATE)
    expect(midMerge(repo.integ)).toBe(false)
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

/**
 * Git merged two phases' additions to one routes file without a conflict and
 * left code that did not build (two list openers, a duplicated import), three
 * times in one observed run. `post_merge` runs on what a clean merge combined.
 */
describe('post_merge', () => {
  async function appendingPair(): Promise<Repo> {
    const repo = await makeRepo({ 'routes.py': 'start\n\n\n\n\nend\n' })
    const one = await repo.lane('lane-1')
    run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
    await repo.commit(one, { 'routes.py': 'start\na\n\n\n\nend\n', 'only-a.py': 'a\n' }, 'phase a: route')
    const two = await repo.lane('lane-2')
    run(two, 'checkout', '-B', 'plan/wf/phase-b', 'main')
    await repo.commit(two, { 'routes.py': 'start\n\n\n\nb\nend\n' }, 'phase b: route')
    return repo
  }

  it('runs on the files both sides changed and commits what it changes on top of the merge', async () => {
    const repo = await appendingPair()
    const seen: string[][] = []
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
      postMerge: async (cwd, files) => {
        seen.push([...files])
        await writeFile(join(cwd, 'routes.py'), 'start\na\nb\nend\n')
        return { ok: true, changed: ['routes.py'] }
      },
    })
    const wave = await integrator.mergeWave(1)
    expect(seen).toEqual([['routes.py']])
    expect(run(repo.integ, 'show', `${wave.branch}:routes.py`)).toBe('start\na\nb\nend')
    expect(subjects(repo.integ, wave.branch)[0]).toBe('chore(post-merge): normalize files merged from plan/wf/phase-b')
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')
  })

  it('leaves the merge as git made it when the command fails, for the gates to judge', async () => {
    const repo = await appendingPair()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
      postMerge: async (cwd) => {
        await writeFile(join(cwd, 'routes.py'), 'half-written\n')
        return { ok: false, changed: ['routes.py'] }
      },
    })
    const wave = await integrator.mergeWave(1)
    expect(run(repo.integ, 'show', `${wave.branch}:routes.py`)).toBe('start\na\n\n\nb\nend')
    expect(subjects(repo.integ, wave.branch)[0]).not.toContain('post-merge')
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')
  })
})

/**
 * A wave conflict the fixer could not settle is finished by hand, as the error
 * says to. The next attempt used to `checkout -B wave-<N> wave-<N-1>` and merge
 * every member again, which threw the resolution away and brought the same
 * conflict back on every attempt.
 */
describe('a wave finished by hand', () => {
  const BY_HAND = 'const value = "by hand"\n'

  /** `a` and `b` conflict on `app.ts`; `d` touches its own file. All are wave 1. */
  async function wave(): Promise<{ repo: Repo; fixer: SpyFixer; integrator: Integrator }> {
    const repo = await conflictingPair()
    const three = await repo.lane('lane-3')
    run(three, 'checkout', '-B', 'plan/wf/phase-d', 'main')
    await repo.commit(three, { 'd.ts': 'export const d = 1\n' }, 'phase d')
    const fixer = spyFixer()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('d')]),
      integrationPath: repo.integ,
      fixer,
      maxFixRounds: 1,
    })
    await expect(integrator.mergeWave(1)).rejects.toBeInstanceOf(UnresolvedConflictError)
    expect(fixer.calls).toHaveLength(1)
    return { repo, fixer, integrator }
  }

  const finishByHand = async (repo: Repo): Promise<void> => {
    await writeFile(join(repo.integ, 'app.ts'), BY_HAND)
    run(repo.integ, 'add', 'app.ts')
    run(repo.integ, 'commit', '--no-edit')
  }

  it('keeps the resolution and merges only the members still missing', async () => {
    const { repo, fixer, integrator } = await wave()
    await finishByHand(repo)

    const retried = await integrator.mergeWave(1)

    expect(fixer.calls).toHaveLength(1)
    expect(retried.merged).toEqual(['a', 'b', 'd'])
    expect(run(repo.integ, 'show', 'plan/wf/wave-1:app.ts').trim()).toBe(BY_HAND.trim())
    for (const id of ['a', 'b', 'd']) {
      expect(isAncestor(repo.integ, `plan/wf/phase-${id}`, 'plan/wf/wave-1')).toBe(true)
    }
  })

  it('keeps a wave the operator also finished merging, without merging anything', async () => {
    const { repo, fixer, integrator } = await wave()
    await finishByHand(repo)
    run(repo.integ, 'merge', '--no-ff', '--no-edit', 'plan/wf/phase-d')
    const built = run(repo.integ, 'rev-parse', 'plan/wf/wave-1')

    const retried = await integrator.mergeWave(1)

    expect(fixer.calls).toHaveLength(1)
    expect(run(repo.integ, 'rev-parse', 'plan/wf/wave-1')).toBe(built)
    expect(retried).toMatchObject({ merged: ['a', 'b', 'd'], conflicts: [] })
  })

  it('rebuilds when a member was redone after it was merged', async () => {
    const { repo, fixer, integrator } = await wave()
    await finishByHand(repo)
    // `a` is redone from scratch: its old commit is in the wave and no longer
    // in its branch, so keeping the wave would ship the old work.
    const lane = join(repo.root, 'lane-1')
    run(lane, 'reset', '--hard', 'main')
    await repo.commit(lane, { 'a.ts': 'export const a = 2\n' }, 'phase a, redone')

    const retried = await integrator.mergeWave(1)

    expect(retried.merged).toEqual(['a', 'b', 'd'])
    expect(run(repo.integ, 'show', 'plan/wf/wave-1:app.ts').trim()).toBe('const value = "b"')
    expect(fixer.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The plan branch
// ---------------------------------------------------------------------------

describe('a run with a plan branch', () => {
  async function withPlanBranch(): Promise<{ repo: Repo; integrator: Integrator; ghPath: string }> {
    const repo = await makeRepo()
    run(repo.main, 'branch', 'plan/wf/base', 'main')
    const gh = stubGh(repo.root)
    const integrator = new Integrator({
      plan: plan([node('a'), node('b', ['a'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
      ghPath: gh.path,
      runBase: 'plan/wf/base',
    })
    return { repo, integrator, ghPath: gh.path }
  }

  /** A commit on the plan branch, made the way a person would: in a worktree of it. */
  async function commitOnPlanBranch(repo: Repo, files: Record<string, string>, message: string): Promise<void> {
    const path = join(repo.root, `plan-${message.replace(/\W+/g, '-')}`)
    run(repo.main, 'worktree', 'add', path, 'plan/wf/base')
    await repo.commit(path, files, message)
    run(repo.main, 'worktree', 'remove', '--force', path)
  }

  it('branches dependency-free phases and starts the wave spine from it', async () => {
    const { repo, integrator } = await withPlanBranch()
    await commitOnPlanBranch(repo, { '.vinta-ai-workflows.yaml': 'commands: {}\n' }, 'config before')
    expect(integrator.base('a')).toEqual({ kind: 'base_branch', branch: 'plan/wf/base' })
    expect(integrator.waveBranch(0)).toBe('plan/wf/base')

    const lane = await repo.lane('lane-1')
    await integrator.startNode('a', lane)
    expect(subjects(lane, 'plan/wf/phase-a')).toContain('config before')
  })

  it('carries a commit made on it mid-run into every later wave', async () => {
    const { repo, integrator } = await withPlanBranch()
    const lane = await repo.lane('lane-1')
    await integrator.startNode('a', lane)
    await repo.commit(lane, { 'a.ts': 'a\n' }, 'phase a: unit')
    const wave1 = await integrator.mergeWave(1, ['a'])

    // A config change lands after wave 1 was built.
    await commitOnPlanBranch(repo, { '.vinta-ai-workflows.yaml': 'commands: {}\n' }, 'config mid-run')
    await integrator.startNode('b', lane)
    await repo.commit(lane, { 'b.ts': 'b\n' }, 'phase b: unit')
    const wave2 = await integrator.mergeWave(2, ['b'])

    expect(subjects(repo.integ, wave1.branch)).not.toContain('config mid-run')
    expect(subjects(repo.integ, wave2.branch)).toContain('config mid-run')
    expect(isAncestor(repo.integ, 'plan/wf/base', wave2.branch)).toBe(true)
  })

  it.runIf(FAKE_BIN_VIA_EXECFILE)('still targets base_branch with every pull request', async () => {
    const { repo, integrator } = await withPlanBranch()
    const lane = await repo.lane('lane-1')
    await integrator.startNode('a', lane)
    await repo.commit(lane, { 'a.ts': 'a\n' }, 'phase a: unit')
    expect(await integrator.openPr('a')).toMatchObject({ opened: true, base: 'main', head: 'plan/wf/phase-a' })
  })
})

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

describe('an amended plan', () => {
  it('puts a phase added mid-run into the right wave’s merge', async () => {
    // §9 refuses an amendment while a node it *blocks* is in flight. Nothing is
    // blocked by a phase nobody depends on, so `c` lands freely beside `a` and
    // `b` — and an integrator still holding the old plan would build wave 1 out
    // of two branches while the run believed it had three.
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })

    const one = await repo.lane('lane-1')
    await integrator.startNode('a', one)
    await repo.commit(one, { 'a1.ts': '1\n' }, 'phase a: unit 1')

    integrator.adopt(plan([node('a'), node('b'), node('c')]))

    // The added phase is dispatchable through the same object that was built
    // without it — before, this threw `unknown node "c"`.
    const two = await repo.lane('lane-2')
    await integrator.startNode('b', two)
    await repo.commit(two, { 'b1.ts': '1\n' }, 'phase b: unit 1')
    const three = await repo.lane('lane-3')
    await integrator.startNode('c', three)
    await repo.commit(three, { 'c1.ts': '1\n' }, 'phase c: unit 1')

    const wave1 = await integrator.mergeWave(1)
    expect(wave1.merged).toEqual(['a', 'b', 'c'])
    const log = subjects(repo.integ, wave1.branch)
    expect(log).toContain('phase c: unit 1')
  })

  it('derives an added phase’s base from the amended graph', async () => {
    // A phase that gains a dependency is cut from that dependency's branch, not
    // from `base_branch` — the whole topology rule has to move with the plan.
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })

    const one = await repo.lane('lane-1')
    await integrator.startNode('a', one)
    await repo.commit(one, { 'a1.ts': '1\n' }, 'phase a: unit 1')

    integrator.adopt(plan([node('a'), node('d', ['a'])]))
    expect(integrator.base('d')).toEqual({
      kind: 'dependency',
      branch: 'plan/wf/phase-a',
      node: 'a',
    })

    const two = await repo.lane('lane-2')
    await integrator.startNode('d', two)
    // Asserted against git, not against the name the code picked.
    expect(isAncestor(repo.integ, 'plan/wf/phase-a', 'plan/wf/phase-d')).toBe(true)
  })

  it('does not change a queued merge’s membership underneath it', async () => {
    // The hazard the `members` argument exists for. A wave merge is decided the
    // moment its last phase arrives and executed later, behind the integration
    // worktree's queue; an amendment can land in that window. The set that was
    // declared complete and the set that is merged must be the same one, or a
    // phase that never ran is merged from a branch that was never cut.
    const repo = await makeRepo()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })

    const one = await repo.lane('lane-1')
    await integrator.startNode('a', one)
    await repo.commit(one, { 'a1.ts': '1\n' }, 'phase a: unit 1')
    const two = await repo.lane('lane-2')
    await integrator.startNode('b', two)
    await repo.commit(two, { 'b1.ts': '1\n' }, 'phase b: unit 1')

    // Decided now, against the plan as it stands.
    const members = ['a', 'b']
    // …and the plan moves before the merge runs. `e` is in wave 1 and has no
    // branch: deriving membership at execution time would try to merge it.
    integrator.adopt(plan([node('a'), node('b'), node('e')]))

    const wave1 = await integrator.mergeWave(1, members)
    expect(wave1.merged).toEqual(['a', 'b'])

    // The proof that this is not a coincidence of ordering: the amended plan
    // really does put `e` in this wave, and the same call without the pinned
    // membership is exactly the failure being prevented.
    expect(integrator.nodesAt(1)).toEqual(['a', 'b', 'e'])
    await expect(integrator.mergeWave(1)).rejects.toThrow()
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

  /**
   * A base merge for `c` that resolves `b`'s branch was written only to `b`,
   * which finished long ago, while `c` — the phase being watched, sitting in
   * `running` — showed nothing.
   */
  it('records the fixer’s turn under the phase being based too', async () => {
    const repo = await conflictingPair()
    const recorded: { nodeId: string; entry: TranscriptEntry }[] = []
    const agent = createAgentConflictFixer({
      adapter: new MockAdapter(),
      model: 'mock-model',
      record: (nodeId, entry) => recorded.push({ nodeId, entry }),
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(async (request) => {
        await agent.fix(request)
        await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
      }),
    })

    await integrator.prepareBase('c')

    const into = (nodeId: string) => recorded.filter((line) => line.nodeId === nodeId).map((line) => line.entry)
    expect(into('c').length).toBeGreaterThan(0)
    expect(into('c')).toEqual(into('b'))
  })

  /** What a phase in `integrate` is doing, step by step, filed against it. */
  it('reports each step it takes, against the node whose turn it is', async () => {
    const repo = await conflictingPair()
    const steps: { node: string; step: string; state: string; round?: number; outcome?: string; gate?: string }[] = []
    let verified = 0
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(async (request) => {
        await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
      }),
      verify: async () => (verified++ === 0 ? RED_GATE : true),
      onStep: (forNode, payload) =>
        steps.push({
          node: forNode,
          step: payload.step,
          state: payload.state,
          ...(payload.round === undefined ? {} : { round: payload.round }),
          ...(payload.outcome === undefined ? {} : { outcome: payload.outcome }),
          ...(payload.gate === undefined ? {} : { gate: payload.gate }),
        }),
    })

    await integrator.prepareBase('c')

    expect(new Set(steps.map((step) => step.node))).toEqual(new Set(['c']))
    expect(steps.map(({ node: _, ...rest }) => rest)).toEqual([
      { step: 'merge', state: 'started' },
      { step: 'fix_round', state: 'started', round: 1 },
      { step: 'fix_round', state: 'finished', round: 1 },
      { step: 'verify', state: 'started' },
      { step: 'verify', state: 'finished', outcome: 'failed', gate: 'test' },
      { step: 'fix_round', state: 'started', round: 2 },
      { step: 'fix_round', state: 'finished', round: 2 },
      { step: 'verify', state: 'started' },
      { step: 'verify', state: 'finished', outcome: 'ok' },
      { step: 'merge', state: 'finished', outcome: 'resolved' },
    ])
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

  /**
   * A fixer that finds the merged tree's failures are a test database from
   * another tree changes no code and says so. The gates then run from fresh
   * state, and the round it spent finding that out is given back.
   */
  it('runs verify from fresh state when the fixer reports ENVIRONMENT_STALE, and gives the round back', async () => {
    const repo = await conflictingPair()
    const forced: (string | undefined)[] = []
    let rounds = 0
    const fixer: ConflictFixer = {
      async fix(request) {
        rounds += 1
        if (request.round === 1) {
          await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
          return 'environment_stale'
        }
        await writeFile(join(request.cwd, 'app.ts'), 'const value = "ab"\n')
      },
    }
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer,
      maxFixRounds: 1,
      verify: async (_cwd, force) => {
        forced.push(force)
        return forced.length === 1 ? RED_GATE : true
      },
    })

    const wave = await integrator.mergeWave(1)

    expect(forced).toEqual(['fixer_reported', undefined])
    expect(rounds).toBe(2)
    expect(run(repo.integ, 'show', `${wave.branch}:app.ts`).trim()).toBe('const value = "ab"')
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

  describe('a resolution that keeps a line one phase deleted', () => {
    // Observed: a phase deleted an unused notification kind on its agent's
    // answer to a design question, the fixer kept "both sides", and every gate
    // passed — unused code breaks nothing — so the deletion never landed.
    const REGISTRY = { 'kinds.ts': 'export const KINDS = [\n  "email",\n  "sms",\n  "fax",\n]\n' }

    async function deletingPair(): Promise<Repo> {
      const repo = await makeRepo(REGISTRY)
      const one = await repo.lane('lane-1')
      const two = await repo.lane('lane-2')
      run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
      await repo.commit(one, { 'kinds.ts': 'export const KINDS = [\n  "email",\n  "sms",\n]\n' }, 'phase a: drop fax')
      run(two, 'checkout', '-B', 'plan/wf/phase-b', 'main')
      await repo.commit(two, { 'kinds.ts': 'export const KINDS = [\n  "email",\n  "sms",\n  "fax",\n  "push",\n]\n' }, 'phase b: push')
      return repo
    }

    it('flags the reverted deletion on the conflict record, naming the phase and the count', async () => {
      const repo = await deletingPair()
      const seen: ReportedConflict[] = []
      const fixer = spyFixer(async (request) => {
        await writeFile(join(request.cwd, 'kinds.ts'), 'export const KINDS = [\n  "email",\n  "sms",\n  "fax",\n  "push",\n]\n')
      })
      const integrator = new Integrator({
        plan: plan([node('a'), node('b')]),
        integrationPath: repo.integ,
        fixer,
        onConflict: (conflict) => seen.push(conflict),
      })

      const wave = await integrator.mergeWave(1)

      expect(wave.conflicts).toEqual([
        { nodes: ['a', 'b'], paths: ['kinds.ts'], rounds: 1, revertedDeletions: [{ path: 'kinds.ts', node: 'a', lines: 1 }] },
      ])
      expect(seen[0]?.revertedDeletions).toEqual([{ path: 'kinds.ts', node: 'a', lines: 1 }])
      // Flagged, not refused: the merge is made as the fixer left it.
      expect(run(repo.integ, 'show', `${wave.branch}:kinds.ts`)).toContain('"fax"')
    })

    it('says nothing when the resolution keeps the deletion', async () => {
      const repo = await deletingPair()
      const fixer = spyFixer(async (request) => {
        await writeFile(join(request.cwd, 'kinds.ts'), 'export const KINDS = [\n  "email",\n  "sms",\n  "push",\n]\n')
      })
      const integrator = new Integrator({ plan: plan([node('a'), node('b')]), integrationPath: repo.integ, fixer })

      const wave = await integrator.mergeWave(1)

      expect(wave.conflicts).toEqual([{ nodes: ['a', 'b'], paths: ['kinds.ts'], rounds: 1 }])
    })
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

  /**
   * A phase stacked on an `integ-` branch only reaches `base_branch` if the
   * `integ-` branch does. It used to be pushed and then left without a PR, so
   * no stack containing a multi-dependency phase could be merged through PRs.
   */
  it.runIf(FAKE_BIN_VIA_EXECFILE)(
    'opens a PR for each integration branch, into base_branch',
    async () => {
      const repo = await makeRepo()
      const gh = stubGh(repo.root)
      const integrator = new Integrator({
        plan: plan([node('a'), node('b'), node('c', ['a']), node('d', ['a', 'b'])]),
        integrationPath: repo.integ,
        fixer: spyFixer(),
        ghPath: gh.path,
      })

      // Only a multi-dependency node has one.
      expect(await integrator.openIntegrationPr('a')).toBeNull()
      expect(await integrator.openIntegrationPr('c')).toBeNull()

      const result = await integrator.openIntegrationPr('d', { draft: true })
      expect(result).toMatchObject({
        opened: true,
        nodeId: 'd',
        base: 'main',
        head: 'plan/wf/integ-d',
      })
      const args = await gh.args()
      expect(args[args.indexOf('--title') + 1]).toBe('Integrate a + b for Phase d')
      expect(args).toContain('--draft')
    },
  )

  it.runIf(FAKE_BIN_VIA_EXECFILE)(
    'opens the plan PR from the final wave branch into base_branch',
    async () => {
      const repo = await makeRepo()
      const gh = stubGh(repo.root)
      const integrator = new Integrator({
        plan: plan([node('a'), node('b', ['a'])]),
        integrationPath: repo.integ,
        fixer: spyFixer(),
        ghPath: gh.path,
      })
      const text = { title: 'Land plan wf', body: 'body', source: 'composed' as const }

      // Wave 0 is `base_branch` itself: there is nothing to open.
      expect(await integrator.openPlanPr(0, { text })).toBeNull()

      const result = await integrator.openPlanPr(2, { text })
      expect(result).toMatchObject({ opened: true, base: 'main', head: 'plan/wf/wave-2' })
      expect(result?.nodeId).toBeUndefined()
    },
  )

  /**
   * A retried phase or a resumed run asks again. "That PR is already open"
   * is the answer it wanted, and it used to be journalled as a failure.
   */
  it.runIf(FAKE_BIN_VIA_EXECFILE)('treats a PR that is already open as opened', async () => {
    const repo = await makeRepo()
    const ghPath = fakeCliFromSource(
      repo.root,
      'gh',
      [
        `process.stderr.write(${JSON.stringify(
          'a pull request for branch "plan/wf/phase-a" into branch "main" already exists:\nhttps://example.invalid/pr/7\n',
        )})`,
        'process.exit(1)',
      ].join('\n'),
    )
    const integrator = new Integrator({
      plan: plan([node('a')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
      ghPath,
    })

    expect(await integrator.openPr('a')).toMatchObject({
      opened: true,
      existing: true,
      url: 'https://example.invalid/pr/7',
    })
  })

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

// ---------------------------------------------------------------------------
// A commit git refuses, and a worktree left mid-merge
// ---------------------------------------------------------------------------

/**
 * A `pre-commit` hook that refuses every commit, the way a hook chain does
 * when it imports a gitignored settings module the integration worktree never
 * received. Hooks live in the main checkout's `.git/hooks` and every worktree
 * shares them, so this refuses commits in `integ` and in the lanes alike —
 * which is why it is installed only once the fixture's own commits are made.
 */
const HOOK_COMPLAINT = "ModuleNotFoundError: No module named 'settings.local'"

async function installRefusingHook(repo: Repo): Promise<string> {
  const hooks = join(repo.main, '.git', 'hooks')
  await mkdir(hooks, { recursive: true })
  const path = join(hooks, 'pre-commit')
  await writeFile(path, `#!/bin/sh\necho "${HOOK_COMPLAINT}" >&2\nexit 1\n`, { mode: 0o755 })
  return path
}

/** Three nodes: `c` depends on both `a` and `b`, which conflict. */
async function conflictingBase(): Promise<Repo> {
  return await conflictingPair()
}

const midMerge = (cwd: string): boolean => {
  try {
    run(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')
    return true
  } catch {
    return false
  }
}

describe('a resolution git refuses to commit', () => {
  const RESOLVED = 'const value = "a" + "b"\n'

  /**
   * The failure that cost the observed run four phases: the fixer resolved
   * the conflict, the integrator's `git commit` was refused by a hook, and
   * `MERGE_HEAD` was left in the one worktree every later base is built in.
   */
  it('abandons the merge rather than leaving the integration worktree mid-merge', async () => {
    const repo = await conflictingBase()
    await installRefusingHook(repo)
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
    })

    const failure = await integrator.prepareBase('c').then(
      () => null,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(IntegrationCommitError)
    const error = failure as IntegrationCommitError
    // Git's own diagnostic, which is the hook's last line here, is in the
    // reason — "git commit exited 1" alone took a manual investigation.
    expect(error.message).toContain('git commit exited 1')
    expect(error.message).toContain(HOOK_COMPLAINT)
    expect(error.cause).toBeInstanceOf(GitCommandError)
    expect(error.cause.detail).toContain(HOOK_COMPLAINT)
    // The *incoming* phase, whose merge was being committed — the same node a
    // conflict record names — not the phase whose base was being built.
    expect(error.nodeId).toBe('b')
    expect(error.incoming).toBe('plan/wf/phase-b')
    expect(error.branch).toBe('plan/wf/integ-c')

    // The invariant: nothing is in progress in the shared worktree, so the
    // next phase whose base is built here is not failed by this one.
    expect(midMerge(repo.integ)).toBe(false)
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')

    // And the fixer's work survived the abort, as a commit with the parents
    // the merge commit would have had.
    expect(error.preservedRef).toBe('refs/vinta-ai-maestro/resolutions/b')
    expect(run(repo.integ, 'show', `${error.preservedRef}:app.ts`).trim()).toBe(RESOLVED.trim())
    expect(parents(repo.integ, error.preservedRef as string)).toHaveLength(2)
  })

  it('reuses the kept resolution on the retry instead of spending another fixer round', async () => {
    const repo = await conflictingBase()
    const hook = await installRefusingHook(repo)
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
    })
    await expect(integrator.prepareBase('c')).rejects.toBeInstanceOf(IntegrationCommitError)
    expect(fixer.calls).toHaveLength(1)

    // The operator fixes what the hook wanted, and the phase is retried.
    await rm(hook)
    const base = await integrator.prepareBase('c')

    expect(fixer.calls).toHaveLength(1)
    expect(run(repo.integ, 'show', `${base}:app.ts`).trim()).toBe(RESOLVED.trim())
    expect(isAncestor(repo.integ, 'plan/wf/phase-a', base)).toBe(true)
    expect(isAncestor(repo.integ, 'plan/wf/phase-b', base)).toBe(true)
    expect(midMerge(repo.integ)).toBe(false)
  })

  it('asks, and `no-verify` commits past the hook with the resolution intact', async () => {
    const repo = await conflictingBase()
    await installRefusingHook(repo)
    const asked: CommitFailure[] = []
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      onCommitFailure: async (failure) => {
        asked.push(failure)
        return 'no-verify'
      },
    })

    const base = await integrator.prepareBase('c')

    expect(asked).toHaveLength(1)
    expect(asked[0]?.nodeId).toBe('b')
    expect(asked[0]?.attempt).toBe(1)
    expect(asked[0]?.error.detail).toContain(HOOK_COMPLAINT)
    expect(run(repo.integ, 'show', `${base}:app.ts`).trim()).toBe(RESOLVED.trim())
    expect(run(repo.integ, 'rev-list', '--merges', '--count', base)).toBe('1')
    expect(midMerge(repo.integ)).toBe(false)
  })

  it('asks, and `commit` tries again with the hooks the operator has since fixed', async () => {
    const repo = await conflictingBase()
    const hook = await installRefusingHook(repo)
    const attempts: number[] = []
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      onCommitFailure: async (failure) => {
        attempts.push(failure.attempt)
        // First time: the operator has not fixed it yet, and says commit anyway.
        // Second time: they remove the cause and say commit.
        if (failure.attempt === 2) await rm(hook)
        return 'commit'
      },
    })

    const base = await integrator.prepareBase('c')

    expect(attempts).toEqual([1, 2])
    expect(run(repo.integ, 'show', `${base}:app.ts`).trim()).toBe(RESOLVED.trim())
    expect(midMerge(repo.integ)).toBe(false)
  })

  it('asks, and `abort` fails the phase with the worktree clean and the resolution kept', async () => {
    const repo = await conflictingBase()
    await installRefusingHook(repo)
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      onCommitFailure: async () => 'abort',
    })

    await expect(integrator.prepareBase('c')).rejects.toMatchObject({
      name: 'IntegrationCommitError',
      decision: 'abort',
      preservedRef: 'refs/vinta-ai-maestro/resolutions/b',
    })
    expect(midMerge(repo.integ)).toBe(false)
  })

  it('leaves the worktree clean when the question itself is withdrawn', async () => {
    // A halt reaches the integrator as the question rejecting. The worktree
    // must still be usable by whatever resumes the run.
    const repo = await conflictingBase()
    await installRefusingHook(repo)
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      onCommitFailure: async () => {
        throw new Error('halted')
      },
    })

    await expect(integrator.prepareBase('c')).rejects.toThrow('halted')
    expect(midMerge(repo.integ)).toBe(false)
    expect(run(repo.integ, 'show', 'refs/vinta-ai-maestro/resolutions/b:app.ts').trim()).toBe(
      RESOLVED.trim(),
    )
  })
})

/**
 * A merge that fails with nothing conflicted. Git merged the trees and a hook
 * checking the merged code refused the commit — `git merge` runs
 * `pre-merge-commit`, and concluding it runs `pre-commit`. Read as a conflict,
 * it handed the fixer an empty file list nineteen times in one observed phase.
 */
describe('a clean merge git refuses to commit', () => {
  /** `c` depends on `a` and `b`, which touch different files. */
  async function disjointPair(): Promise<Repo> {
    const repo = await makeRepo()
    const one = await repo.lane('lane-1')
    const two = await repo.lane('lane-2')
    run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
    await repo.commit(one, { 'a.ts': 'export const a = 1\n' }, 'phase a')
    run(two, 'checkout', '-B', 'plan/wf/phase-b', 'main')
    await repo.commit(two, { 'b.ts': 'export const b = 1\n' }, 'phase b')
    return repo
  }

  async function refuseMergeCommits(repo: Repo): Promise<void> {
    const hooks = join(repo.main, '.git', 'hooks')
    await mkdir(hooks, { recursive: true })
    for (const hook of ['pre-merge-commit', 'pre-commit']) {
      await writeFile(join(hooks, hook), `#!/bin/sh\necho "${HOOK_COMPLAINT}" >&2\nexit 1\n`, { mode: 0o755 })
    }
  }

  const integratorFor = (repo: Repo, fixer: SpyFixer, onCommitFailure?: (f: CommitFailure) => Promise<CommitDecision>) =>
    new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      ...(onCommitFailure === undefined ? {} : { onCommitFailure }),
    })

  it('asks about the commit instead of handing the fixer a conflict with no files', async () => {
    const repo = await disjointPair()
    await refuseMergeCommits(repo)
    const asked: CommitFailure[] = []
    const fixer = spyFixer()

    const base = await integratorFor(repo, fixer, async (failure) => {
      asked.push(failure)
      return 'no-verify'
    }).prepareBase('c')

    expect(fixer.calls).toHaveLength(0)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.conflicted).toBe(false)
    expect(asked[0]?.nodeId).toBe('b')
    expect(asked[0]?.error.detail).toContain(HOOK_COMPLAINT)
    expect(isAncestor(repo.integ, 'plan/wf/phase-a', base)).toBe(true)
    expect(isAncestor(repo.integ, 'plan/wf/phase-b', base)).toBe(true)
    expect(midMerge(repo.integ)).toBe(false)
  })

  it('abandons the merge with no one to ask, and leaves the worktree clean', async () => {
    const repo = await disjointPair()
    await refuseMergeCommits(repo)
    const fixer = spyFixer()

    const failure = await integratorFor(repo, fixer)
      .prepareBase('c')
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(IntegrationCommitError)
    expect((failure as IntegrationCommitError).message).toContain(HOOK_COMPLAINT)
    expect(fixer.calls).toHaveLength(0)
    expect(midMerge(repo.integ)).toBe(false)
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')
  })

  it("reports git's own refusal when nothing was merged at all", async () => {
    const repo = await disjointPair()
    const fixer = spyFixer()
    // An untracked file where the incoming phase adds one: git refuses the
    // merge before touching anything, and there is no MERGE_HEAD.
    await writeFile(join(repo.integ, 'b.ts'), 'in the way\n')

    const failure = await integratorFor(repo, fixer)
      .prepareBase('c')
      .then(
      () => null,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(GitCommandError)
    expect((failure as GitCommandError).subcommand).toBe('merge')
    expect(fixer.calls).toHaveLength(0)
    expect(midMerge(repo.integ)).toBe(false)
  })
})

describe('an integration worktree that is mid-merge', () => {
  /** A merge of `incoming` into `into`, left standing — conflicted, as a kill or a person would leave it. */
  const leaveMerge = (cwd: string, into: string, from: string, incoming: string): void => {
    run(cwd, 'checkout', '-B', into, from)
    try {
      run(cwd, 'merge', '--no-ff', '--no-edit', incoming)
    } catch {
      // Conflicted, as intended.
    }
  }

  it('refuses a merge this run did not start by name, before any checkout', async () => {
    const repo = await conflictingPair()
    // A person's own merge of a branch the plan does not know.
    const elsewhere = await repo.lane('lane-3')
    run(elsewhere, 'checkout', '-B', 'feature/manual', 'main')
    await repo.commit(elsewhere, { 'app.ts': 'const value = "manual"\n' }, 'manual: value')
    leaveMerge(repo.integ, 'plan/wf/integ-c', 'plan/wf/phase-a', 'feature/manual')
    expect(midMerge(repo.integ)).toBe(true)
    const fixer = spyFixer()
    const reclaimed: unknown[] = []
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b']), node('d', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      onReclaimed: (merge) => reclaimed.push(merge),
    })

    // Another phase's base, built in the same worktree.
    const failure = await integrator.prepareBase('d').then(
      () => null,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(IntegrationWorktreeBusyError)
    const error = failure as IntegrationWorktreeBusyError
    expect(error.operation).toBe('merge')
    expect(error.incoming).toBe('feature/manual')
    expect(error.into).toBe('plan/wf/integ-c')
    expect(error.message).toContain('mid-merge')
    expect(error.message).toContain('feature/manual into plan/wf/integ-c')
    // Nothing was touched: the merge is still there for whoever owns it.
    expect(midMerge(repo.integ)).toBe(true)
    expect(fixer.calls).toEqual([])
    expect(reclaimed).toEqual([])
    // A wave merge is refused the same way, and so is an explicit sweep.
    await expect(integrator.mergeWave(1)).rejects.toBeInstanceOf(IntegrationWorktreeBusyError)
    await expect(integrator.reclaim()).rejects.toBeInstanceOf(IntegrationWorktreeBusyError)
  })

  it('refuses a plan branch merged into a branch that is not the plan\'s', async () => {
    const repo = await conflictingPair()
    leaveMerge(repo.integ, 'scratch', 'plan/wf/phase-a', 'plan/wf/phase-b')
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
    })

    await expect(integrator.prepareBase('c')).rejects.toBeInstanceOf(IntegrationWorktreeBusyError)
    expect(midMerge(repo.integ)).toBe(true)
  })

  /**
   * The observed wedge: a stop landed while `phase-p4a` was being merged into
   * `wave-1`. The merge had staged without a conflict and was never committed,
   * and every later attempt failed on `IntegrationWorktreeBusyError` until a
   * person ran `git merge --abort`.
   */
  it('redoes an interrupted wave merge of its own, so the wave is built afresh', async () => {
    const repo = await makeRepo()
    const one = await repo.lane('lane-1')
    const two = await repo.lane('lane-2')
    run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
    await repo.commit(one, { 'a.ts': 'a\n' }, 'phase a')
    run(two, 'checkout', '-B', 'plan/wf/phase-b', 'main')
    await repo.commit(two, { 'b.ts': 'b\n' }, 'phase b')
    // Phase a merged; phase b staged and never committed.
    run(repo.integ, 'checkout', '-B', 'plan/wf/wave-1', 'main')
    run(repo.integ, 'merge', '--no-ff', '--no-edit', 'plan/wf/phase-a')
    run(repo.integ, 'merge', '--no-ff', '--no-commit', 'plan/wf/phase-b')
    expect(midMerge(repo.integ)).toBe(true)
    const reclaimed: unknown[] = []
    const integrator = new Integrator({
      plan: plan([node('a'), node('b')]),
      integrationPath: repo.integ,
      fixer: spyFixer(),
      onReclaimed: (merge) => reclaimed.push(merge),
    })

    const result = await integrator.mergeWave(1, undefined, 'b')

    expect(result.merged).toEqual(['a', 'b'])
    expect(midMerge(repo.integ)).toBe(false)
    expect(isAncestor(repo.integ, 'plan/wf/phase-a', 'plan/wf/wave-1')).toBe(true)
    expect(isAncestor(repo.integ, 'plan/wf/phase-b', 'plan/wf/wave-1')).toBe(true)
    expect(reclaimed).toEqual([
      { into: 'plan/wf/wave-1', incoming: 'plan/wf/phase-b', kept: 'refs/vinta-ai-maestro/abandoned/wave-1' },
    ])
    expect(parents(repo.integ, 'refs/vinta-ai-maestro/abandoned/wave-1')).toHaveLength(2)
  })

  /**
   * A conflict left for a person (`UnresolvedConflictError`) that nobody
   * finished. The retry used to fail in setup on every attempt; it now keeps
   * the fixer's attempt and hands the merge to a fixer again.
   */
  it('keeps an unfinished conflict of its own and redoes the merge on the retry', async () => {
    const repo = await conflictingPair()
    const RESOLVED = 'const value = "a" + "b"\n'
    let resolve = false
    const fixer = spyFixer(async (request) => {
      if (resolve) await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
    })
    const verify: string[] = []
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
      maxFixRounds: 1,
      verify: async (cwd) => {
        verify.push(await readFile(join(cwd, 'app.ts'), 'utf8'))
        return true
      },
    })

    await expect(integrator.prepareBase('c')).rejects.toBeInstanceOf(UnresolvedConflictError)
    // Left standing, by design: it is what a person finishing it by hand needs.
    expect(midMerge(repo.integ)).toBe(true)

    resolve = true
    const base = await integrator.prepareBase('c')

    expect(base).toBe('plan/wf/integ-c')
    expect(midMerge(repo.integ)).toBe(false)
    expect(fixer.calls).toHaveLength(2)
    // The merge's result went through the gate again.
    expect(verify).toEqual([RESOLVED])
    expect(run(repo.integ, 'show', 'plan/wf/integ-c:app.ts')).toBe(RESOLVED.trim())
    // The fixer's unfinished attempt is not lost, and not reused: it still has its markers.
    expect(run(repo.integ, 'show', 'refs/vinta-ai-maestro/abandoned/integ-c:app.ts')).toContain('<<<<<<<')
  })

  it('recognises a phase branch a retry has moved on since the merge began', async () => {
    const repo = await makeRepo()
    const one = await repo.lane('lane-1')
    run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
    await repo.commit(one, { 'a.ts': 'a\n' }, 'phase a')
    run(repo.integ, 'checkout', '-B', 'plan/wf/wave-1', 'main')
    run(repo.integ, 'merge', '--no-ff', '--no-commit', 'plan/wf/phase-a')
    // The retried phase committed more on top.
    await repo.commit(one, { 'a.ts': 'a, again\n' }, 'phase a: attempt 2')
    const integrator = new Integrator({ plan: plan([node('a')]), integrationPath: repo.integ, fixer: spyFixer() })

    const reclaimed = await integrator.reclaim()

    expect(reclaimed).toMatchObject({ into: 'plan/wf/wave-1', incoming: 'plan/wf/phase-a' })
    expect(midMerge(repo.integ)).toBe(false)
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')
  })

  it('answers null with nothing in progress', async () => {
    const repo = await makeRepo()
    const integrator = new Integrator({ plan: plan([node('a')]), integrationPath: repo.integ, fixer: spyFixer() })
    expect(await integrator.reclaim()).toBe(null)
  })

  it('does not leave one behind when the fixer could not run at all', async () => {
    const repo = await conflictingPair()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: {
        async fix(): Promise<void> {
          throw new Error('conflict fixer spawn refused: quota')
        },
      },
    })

    await expect(integrator.prepareBase('c')).rejects.toThrow('quota')
    expect(midMerge(repo.integ)).toBe(false)
    expect(run(repo.integ, 'status', '--porcelain')).toBe('')
  })
})

describe('GitCommandError', () => {
  it('carries the tail of what git said, so a failure explains itself', async () => {
    const repo = await makeRepo()
    const failure = await git(repo.main, ['checkout', 'no-such-branch']).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitCommandError)
    const error = failure as GitCommandError
    expect(error.subcommand).toBe('checkout')
    expect(error.exitCode).toBe(1)
    expect(error.detail).toContain('no-such-branch')
    expect(error.message).toMatch(/^git checkout exited 1: /)
  })

  it('bounds the tail and redacts a registered secret', () => {
    redactValue('hunter2-secret-token')
    try {
      const long = `${'x'.repeat(2_000)}\npassword is hunter2-secret-token\n`
      const error = new GitCommandError('commit', 1, long)
      expect(error.detail.length).toBeLessThanOrEqual(GIT_STDERR_LIMIT + 1)
      expect(error.detail).not.toContain('hunter2-secret-token')
      // A secret anywhere in the tail replaces the whole tail.
      expect(error.message).not.toContain('hunter2')
    } finally {
      clearRedactions()
    }
  })
})

describe('a phase branch another lane still has checked out', () => {
  it('is released from that lane so the phase can move', async () => {
    // Thirty-nine attempts in a row failed with `fatal: 'plan/…/phase-p13' is
    // already used by worktree at '…/crew-1'` after the crew assignment moved
    // the phase to another desk and nothing moved the old desk off its branch.
    const repo = await makeRepo()
    const one = await repo.lane('crew-1')
    const two = await repo.lane('crew-2')
    const integrator = new Integrator({ plan: plan([node('a')]), integrationPath: repo.integ, fixer: spyFixer() })
    await integrator.startNode('a', one)
    await repo.commit(one, { 'a.ts': 'attempt 1\n' }, 'phase a: attempt 1')
    // Uncommitted work in the old lane, which a detach must not touch.
    await writeFile(join(one, 'scratch.ts'), 'wip\n')
    const tip = run(one, 'rev-parse', 'HEAD')

    const branch = await integrator.startNode('a', two, true)

    expect(run(two, 'symbolic-ref', '--short', 'HEAD')).toBe(branch)
    expect(run(two, 'rev-parse', 'HEAD')).toBe(tip)
    // The old lane is detached at the same commit, its tree exactly as it was.
    expect(() => run(one, 'symbolic-ref', '--quiet', 'HEAD')).toThrow()
    expect(run(one, 'rev-parse', 'HEAD')).toBe(tip)
    expect(existsSync(join(one, 'scratch.ts'))).toBe(true)
  })
})

/** A session that never ends on its own: the fixer looping on a check. */
function hangingAdapter(): { adapter: HarnessAdapter; killed: () => number; spawned: () => number } {
  let killed = 0
  let spawned = 0
  const adapter: HarnessAdapter = {
    id: 'hanging',
    capabilities: {
      inject: false,
      interrupt: false,
      resume: false,
      pty: false,
      permissionControl: false,
      autoCompact: false,
      backgroundWork: false,
    },
    preflight: async () => ({ installed: true, authenticated: true, version: '0' }),
    spawn: async () => {
      spawned += 1
      let end!: () => void
      const ended = new Promise<void>((resolve) => {
        end = resolve
      })
      return {
        ok: true,
        session: {
          id: 'hang-1',
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'session_started', sessionId: 'hang-1' } as AgentEvent
              await ended
              yield { type: 'session_ended', result: 'interrupted' } as AgentEvent
            },
          },
          send: async () => {},
          interrupt: async () => {},
          kill: async () => {
            killed += 1
            end()
          },
        },
      }
    },
  }
  return { adapter, killed: () => killed, spawned: () => spawned }
}

describe('a fix round with a time limit', () => {
  it('is stopped when it runs over, and the phase fails with the worktree clean', async () => {
    const repo = await conflictingPair()
    const { adapter, killed } = hangingAdapter()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: createAgentConflictFixer({ adapter, model: 'm', timeoutMs: 50 }),
    })

    const failure = await integrator.prepareBase('c').then(() => null, (error: unknown) => error)

    expect(failure).toBeInstanceOf(ConflictFixerTimeout)
    expect((failure as Error).message).toContain('exceeded its 0 minute limit')
    expect(killed()).toBe(1)
    expect(midMerge(repo.integ)).toBe(false)
  })

  it('can be interrupted from outside, which ends the round', async () => {
    const repo = await conflictingPair()
    const { adapter, killed, spawned } = hangingAdapter()
    const fixer = createAgentConflictFixer({ adapter, model: 'm', timeoutMs: 60_000 })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
    })

    const preparing = integrator.prepareBase('c').then(() => 'done', () => 'failed')
    // Until the round is actually running: the merge takes a moment to conflict.
    for (let i = 0; i < 200 && spawned() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    await fixer.interrupt?.()
    expect(await preparing).toBe('failed')

    expect(killed()).toBe(1)
    // Nothing to interrupt afterwards is not an error.
    await fixer.interrupt?.()
    expect(midMerge(repo.integ)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Staging only what the merge touched, an amended fixer, a stopped round kept
// ---------------------------------------------------------------------------

describe('staging a resolution', () => {
  const RESOLVED = 'const value = "a" + "b"\n'

  /**
   * A gate run in the integration worktree left a 3.2 MB `.testmondata-wal`
   * behind; `add --all` staged it into the merge, a large-file hook refused
   * the commit, and the kept resolution replayed it on every retry.
   */
  it('leaves untracked files out, and keeps a new file the fixer staged itself', async () => {
    const repo = await conflictingPair()
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer: spyFixer(async (request) => {
        await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
        await writeFile(join(request.cwd, '.testmondata-wal'), 'gate leftovers\n')
        await writeFile(join(request.cwd, 'merge-migration.ts'), 'export {}\n')
        run(request.cwd, 'add', 'merge-migration.ts')
      }),
    })

    const base = await integrator.prepareBase('c')

    expect(run(repo.integ, 'show', `${base}:app.ts`).trim()).toBe(RESOLVED.trim())
    expect(run(repo.integ, 'show', `${base}:merge-migration.ts`).trim()).toBe('export {}')
    expect(run(repo.integ, 'ls-tree', '--name-only', base)).not.toContain('.testmondata-wal')
    expect(run(repo.integ, 'status', '--porcelain')).toBe('?? .testmondata-wal')
  })

  it('drops a kept resolution that carries files from outside the merge instead of replaying it', async () => {
    const repo = await conflictingPair()
    const hook = await installRefusingHook(repo)
    let round = 0
    const fixer = spyFixer(async (request) => {
      round += 1
      await writeFile(join(request.cwd, 'app.ts'), RESOLVED)
      // The first round stages debris the way `add --all` used to.
      if (round === 1) {
        await writeFile(join(request.cwd, 'debris.bin'), 'large\n')
        run(request.cwd, 'add', 'debris.bin')
      }
    })
    const integrator = new Integrator({
      plan: plan([node('a'), node('b'), node('c', ['a', 'b'])]),
      integrationPath: repo.integ,
      fixer,
    })
    const failure = await integrator.prepareBase('c').then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(IntegrationCommitError)
    const kept = (failure as IntegrationCommitError).preservedRef as string
    expect(run(repo.integ, 'ls-tree', '--name-only', kept)).toContain('debris.bin')

    await rm(hook)
    const base = await integrator.prepareBase('c')

    expect(fixer.calls).toHaveLength(2)
    expect(run(repo.integ, 'ls-tree', '--name-only', base)).not.toContain('debris.bin')
    expect(run(repo.integ, 'for-each-ref', 'refs/vinta-ai-maestro/resolutions/')).toBe('')
  })
})

describe('an amended crew', () => {
  /**
   * An amendment moved every desk from Codex to Claude Code, and the fixer
   * built at start kept spawning on Codex: seven failures on "conflict fixer
   * spawn refused: codex".
   */
  it('hands the next conflict to the fixer adopted with the plan', async () => {
    const repo = await conflictingPair()
    const before = spyFixer()
    const after = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
    })
    const nodes = [node('a'), node('b'), node('c', ['a', 'b'])]
    const integrator = new Integrator({ plan: plan(nodes), integrationPath: repo.integ, fixer: before })

    integrator.adopt(plan(nodes), after)
    await integrator.prepareBase('c')

    expect(before.calls).toHaveLength(0)
    expect(after.calls).toHaveLength(1)
  })
})

describe('a fix round stopped by its time limit', () => {
  it('keeps what it had under the abandoned refs and points the retry at it', async () => {
    const repo = await conflictingPair()
    const { adapter } = hangingAdapter()
    const nodes = [node('a'), node('b'), node('c', ['a', 'b'])]
    const integrator = new Integrator({
      plan: plan(nodes),
      integrationPath: repo.integ,
      fixer: createAgentConflictFixer({ adapter, model: 'm', timeoutMs: 50 }),
    })
    await writeFile(join(repo.integ, 'untracked.log'), 'not the merge\n')

    const failure = await integrator.prepareBase('c').then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ConflictFixerTimeout)
    expect(midMerge(repo.integ)).toBe(false)

    const ref = 'refs/vinta-ai-maestro/abandoned/integ-c'
    expect(parents(repo.integ, ref)).toHaveLength(2)
    expect(run(repo.integ, 'ls-tree', '--name-only', ref)).not.toContain('untracked.log')

    const retry = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "b"\n')
    })
    integrator.adopt(plan(nodes), retry)
    await integrator.prepareBase('c')
    expect(retry.calls[0]?.previousAttempt).toBe(ref)
  })
})

// ---------------------------------------------------------------------------
// A branch that is no phase's: sync-base's wave merges
// ---------------------------------------------------------------------------

describe('mergeBranch', () => {
  /** wave-1 carries phase a's edit to app.ts; then main edits the same line. */
  async function movedBase(): Promise<{ repo: Repo; wave: string }> {
    const repo = await makeRepo(CONFLICTING)
    const one = await repo.lane('lane-1')
    run(one, 'checkout', '-B', 'plan/wf/phase-a', 'main')
    await repo.commit(one, { 'app.ts': 'const value = "a"\n' }, 'phase a: value')
    const builder = new Integrator({ plan: plan([node('a')]), integrationPath: repo.integ, fixer: spyFixer() })
    const { branch } = await builder.mergeWave(1)
    await repo.commit(repo.main, { 'app.ts': 'const value = "main"\n' }, 'main moved on')
    return { repo, wave: branch }
  }

  it('hands a conflict with the base to the fixer, naming the phases that touched the path', async () => {
    const { repo, wave } = await movedBase()
    const seen: { where: string; branch: string }[] = []
    const fixer = spyFixer(async (request) => {
      await writeFile(join(request.cwd, 'app.ts'), 'const value = "a" + "main"\n')
    })
    const integrator = new Integrator({
      plan: plan([node('a')]),
      integrationPath: repo.integ,
      fixer,
      onConflict: (conflict) => seen.push(conflict),
    })

    const conflict = await integrator.mergeBranch(wave, 'main', ['a'])

    expect(conflict).toMatchObject({ nodes: ['a'], paths: ['app.ts'], rounds: 1 })
    expect(fixer.calls[0]).toMatchObject({ into: wave, incoming: 'main', nodeId: 'a', nodes: ['a'] })
    expect(isAncestor(repo.main, 'main', wave)).toBe(true)
    expect(run(repo.main, 'show', `${wave}:app.ts`)).toBe('const value = "a" + "main"')
    expect(seen).toEqual([expect.objectContaining({ where: 'wave', branch: wave })])
  })

  it('leaves no merge standing when no round resolves it, and the branch as it was', async () => {
    const { repo, wave } = await movedBase()
    const before = run(repo.main, 'rev-parse', wave)
    const integrator = new Integrator({ plan: plan([node('a')]), integrationPath: repo.integ, fixer: spyFixer(), maxFixRounds: 1 })

    await expect(integrator.mergeBranch(wave, 'main', ['a'])).rejects.toBeInstanceOf(UnresolvedConflictError)
    expect(run(repo.main, 'rev-parse', wave)).toBe(before)
    expect(existsSync(join(run(repo.integ, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'))).toBe(false)
    // The run's next merge in that worktree is not refused over it.
    expect(await integrator.reclaim()).toBeNull()
  })
})
