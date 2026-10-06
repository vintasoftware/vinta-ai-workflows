/**
 * `describeChanges` against real git: a fixture repository, a branch with
 * commits on it, and a lane worktree with work it has not committed.
 *
 * Asserted through the description it returns rather than through git's own
 * output, because the description is the contract the node view renders.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeChanges, parseNameStatus, parseNumstat } from '../src/integration/changes.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

interface Repo {
  readonly main: string
  readonly root: string
  commit(cwd: string, files: Readonly<Record<string, string>>, message: string): Promise<void>
}

async function makeRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-changes-'))
  roots.push(root)
  const main = join(root, 'repo')
  await mkdir(main, { recursive: true })
  run(main, 'init', '-b', 'main')
  run(main, 'config', 'user.email', 'fixture@example.invalid')
  run(main, 'config', 'user.name', 'fixture')
  run(main, 'config', 'commit.gpgsign', 'false')

  const repo: Repo = {
    main,
    root,
    async commit(cwd, contents, message) {
      for (const [path, body] of Object.entries(contents)) {
        await mkdir(join(cwd, path, '..'), { recursive: true })
        await writeFile(join(cwd, path), body)
      }
      run(cwd, 'add', '--all')
      run(cwd, 'commit', '-m', message)
    },
  }
  await repo.commit(
    main,
    {
      'README.md': 'fixture\n',
      'src/app.ts': 'export const value = 1\n',
      'src/old.ts': 'export const old = true\n',
      'src/gone.ts': 'export const gone = true\n',
    },
    'base',
  )
  return repo
}

/** A lane: a worktree on its own branch, cut from `main`. */
function lane(repo: Repo, name: string, branch: string): string {
  const path = join(repo.root, name)
  run(repo.main, 'worktree', 'add', '-b', branch, path, 'main')
  return path
}

describe('a branch that committed its work', () => {
  it('lists each file with its status and line counts, and the patch', async () => {
    const repo = await makeRepo()
    const path = lane(repo, 'lane-1', 'phase/a')
    await writeFile(join(path, 'src/app.ts'), 'export const value = 2\nexport const extra = 3\n')
    run(path, 'mv', 'src/old.ts', 'src/renamed.ts')
    run(path, 'rm', '-q', 'src/gone.ts')
    await repo.commit(path, { 'src/new.ts': 'export const fresh = 1\n' }, 'phase a')
    // The lane is recycled: `phase/a` is no longer checked out anywhere, so the
    // description has to come from the branch.
    run(repo.main, 'worktree', 'remove', '--force', path)

    const changes = await describeChanges({
      repo: repo.main,
      branch: 'phase/a',
      baseBranch: 'main',
      lanePath: path,
      patch: true,
    })

    expect(changes.source).toBe('branch')
    expect(changes.files.map((file) => [file.path, file.status, file.additions, file.deletions]))
      .toEqual([
        ['src/app.ts', 'modified', 2, 1],
        ['src/gone.ts', 'deleted', 0, 1],
        ['src/new.ts', 'added', 1, 0],
        ['src/renamed.ts', 'renamed', 0, 0],
      ])
    expect(changes.files.find((file) => file.status === 'renamed')?.oldPath).toBe('src/old.ts')
    expect(changes.totals).toEqual({ files: 4, additions: 3, deletions: 2 })
    expect(changes.truncated).toBe(false)
    expect(changes.patch).toContain('diff --git a/src/app.ts b/src/app.ts')
    expect(changes.patch).toContain('+export const extra = 3')
    expect(changes.patch).toContain('rename from src/old.ts')
  })

  it('does not read the patch unless asked', async () => {
    const repo = await makeRepo()
    const path = lane(repo, 'lane-1', 'phase/a')
    await repo.commit(path, { 'src/new.ts': 'x\n' }, 'phase a')

    const changes = await describeChanges({
      repo: repo.main,
      branch: 'phase/a',
      baseBranch: 'main',
      lanePath: null,
    })

    expect(changes.patch).toBeNull()
    expect(changes.totals.files).toBe(1)
  })

  it('cuts a patch past the limit at a file boundary and says so', async () => {
    const repo = await makeRepo()
    const path = lane(repo, 'lane-1', 'phase/a')
    const big = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
    await repo.commit(path, { 'a.txt': `${big}\n`, 'b.txt': `${big}\n`, 'c.txt': `${big}\n` }, 'big')

    const changes = await describeChanges({
      repo: repo.main,
      branch: 'phase/a',
      baseBranch: 'main',
      lanePath: null,
      patch: true,
      patchLimitBytes: 3_000,
    })

    expect(changes.truncated).toBe(true)
    expect(changes.patch).toContain('diff --git a/a.txt b/a.txt')
    expect(changes.patch).not.toContain('diff --git a/c.txt b/c.txt')
    // Cut at a header, so what is served ends with a whole file.
    expect(changes.patch?.endsWith('\n')).toBe(true)
    // The counts never shrink with the patch.
    expect(changes.totals).toEqual({ files: 3, additions: 600, deletions: 0 })
  })

  it('counts a binary file as binary rather than as zero lines', async () => {
    const repo = await makeRepo()
    const path = lane(repo, 'lane-1', 'phase/a')
    await writeFile(join(path, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    run(path, 'add', '--all')
    run(path, 'commit', '-m', 'binary')

    const changes = await describeChanges({
      repo: repo.main,
      branch: 'phase/a',
      baseBranch: 'main',
      lanePath: null,
    })

    expect(changes.files).toEqual([
      { path: 'logo.png', oldPath: null, status: 'added', additions: null, deletions: null, binary: true },
    ])
    expect(changes.totals).toEqual({ files: 1, additions: 0, deletions: 0 })
  })
})

describe('a lane still holding the branch', () => {
  it('describes the working tree, uncommitted edits and untracked files included', async () => {
    const repo = await makeRepo()
    const path = lane(repo, 'lane-1', 'phase/a')
    await repo.commit(path, { 'src/new.ts': 'export const fresh = 1\n' }, 'phase a: committed')
    // Then work the agent has not committed: an edit to a tracked file, and a
    // file git does not know about yet.
    await writeFile(join(path, 'src/app.ts'), 'export const value = 2\n')
    await writeFile(join(path, 'src/scratch.ts'), 'one\ntwo\n')

    const changes = await describeChanges({
      repo: repo.main,
      branch: 'phase/a',
      baseBranch: 'main',
      lanePath: path,
      patch: true,
    })

    expect(changes.source).toBe('worktree')
    expect(changes.files.map((file) => [file.path, file.status, file.additions, file.deletions]))
      .toEqual([
        ['src/app.ts', 'modified', 1, 1],
        ['src/new.ts', 'added', 1, 0],
        ['src/scratch.ts', 'untracked', 2, 0],
      ])
    expect(changes.totals).toEqual({ files: 3, additions: 4, deletions: 1 })
    expect(changes.patch).toContain('+export const value = 2')
    // The untracked file is in the patch too, as a new file against nothing.
    expect(changes.patch).toContain('b/src/scratch.ts')
    expect(changes.patch).toContain('+two')
  })

  it('falls back to the branch when the lane has moved on to another one', async () => {
    const repo = await makeRepo()
    const path = lane(repo, 'lane-1', 'phase/a')
    await repo.commit(path, { 'src/new.ts': 'x\n' }, 'phase a')
    // The pool hands the lane to the next phase; its edits are not phase a's.
    run(path, 'checkout', '-q', '-b', 'phase/b')
    await writeFile(join(path, 'src/app.ts'), 'not phase a\n')

    const changes = await describeChanges({
      repo: repo.main,
      branch: 'phase/a',
      baseBranch: 'main',
      lanePath: path,
    })

    expect(changes.source).toBe('branch')
    expect(changes.files.map((file) => file.path)).toEqual(['src/new.ts'])
  })
})

describe('a branch git cannot find', () => {
  it('is an empty description, not an error', async () => {
    const repo = await makeRepo()

    const changes = await describeChanges({
      repo: repo.main,
      branch: 'phase/never-cut',
      baseBranch: 'main',
      lanePath: null,
      patch: true,
    })

    expect(changes).toEqual({
      source: 'none',
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      patch: null,
      truncated: false,
    })
  })
})

describe('parsing git’s -z output', () => {
  it('reads numstat records, renames included', () => {
    const raw = '3\t1\tsrc/app.ts\0-\t-\tlogo.png\x000\t0\t\0src/old.ts\0src/renamed.ts\0'
    const counts = parseNumstat(raw)

    expect(counts.get('src/app.ts')).toEqual({ additions: 3, deletions: 1 })
    expect(counts.get('logo.png')).toEqual({ additions: null, deletions: null })
    expect(counts.get('src/renamed.ts')).toEqual({ additions: 0, deletions: 0 })
  })

  it('reads name-status records, with both paths of a rename', () => {
    const named = parseNameStatus('M\0src/app.ts\0R100\0src/old.ts\0src/renamed.ts\0D\0gone.ts\0X\0odd\0')

    expect(named).toEqual([
      { path: 'src/app.ts', oldPath: null, status: 'modified' },
      { path: 'src/renamed.ts', oldPath: 'src/old.ts', status: 'renamed' },
      { path: 'gone.ts', oldPath: null, status: 'deleted' },
      // A letter this build does not know is shown as unknown, not dropped.
      { path: 'odd', oldPath: null, status: 'unknown' },
    ])
  })
})
