import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdtemp, realpath, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planDatabase, planTemplate, type PostgresSpec } from '../src/lanes/database.ts'
import { DiskProbeError } from '../src/lanes/disk.ts'
import { type Lane, LanePool, LaneRecycleError, type ProjectSpec } from '../src/lanes/pool.ts'
import { readSummary } from '../src/lanes/summary.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

/**
 * Materializes `tests/fixtures/repo/` into a temp dir as a real git repo.
 *
 * The dependency tree is symlinked in rather than installed — the same decision
 * `prepare-worktree` makes for a worktree that adds no dependencies, and what
 * lets the fixture's `node scripts/migrate.mjs` resolve `better-sqlite3`.
 */
async function materializeFixtureRepo(root: string): Promise<string> {
  const repo = join(root, 'source')
  await cp(join(HERE, 'fixtures', 'repo'), repo, { recursive: true })
  await symlink(join(PACKAGE_ROOT, 'node_modules'), join(repo, 'node_modules'))

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  git('init', '-b', 'main')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'fixture')
  git('add', '-A')
  git('commit', '-m', 'fixture')
  return repo
}

const sqliteProject = (): ProjectSpec => ({
  migrateCmd: 'node scripts/migrate.mjs',
  databases: {
    dev: {
      engine: 'sqlite',
      delivery: 'file',
      path: 'db.sqlite3',
      connectionUrlVar: 'DATABASE_URL',
    },
    test: {
      engine: 'sqlite',
      delivery: 'file',
      path: 'db.test.sqlite3',
      connectionUrlVar: 'TEST_DATABASE_URL',
    },
  },
})

/** A compose-delivered database: no template, therefore no reset. */
const composeProject = (): ProjectSpec => ({
  migrateCmd: 'true',
  databases: {
    dev: {
      engine: 'postgres',
      delivery: 'compose',
      name: 'app',
      serverUrl: 'postgres://localhost:5432',
      connectionUrlVar: 'DATABASE_URL',
    },
  },
})

const envVar = (lane: Lane, key: string): string => {
  const value = lane.env[key]
  if (!value) throw new Error(`lane "${lane.name}" has no ${key}`)
  return value
}

const worktreePaths = (repo: string): string[] =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))

describe('lane pool', () => {
  let root: string
  let repo: string
  let poolRoot: string
  let migrateLog: string
  const previousLog = process.env.VINTA_FIXTURE_MIGRATE_LOG

  beforeEach(async () => {
    // realpath: macOS resolves /var to /private/var, and git reports the real
    // path back, so worktree comparisons need the resolved form.
    root = await realpath(await mkdtemp(join(tmpdir(), 'vinta-flow-lanes-')))
    repo = await materializeFixtureRepo(root)
    poolRoot = join(root, 'pool')
    migrateLog = join(root, 'migrate.log')
    // The fixture's migrate command appends a line per invocation, so template
    // creations are counted from outside the pool rather than from a counter
    // the pool keeps about itself.
    process.env.VINTA_FIXTURE_MIGRATE_LOG = migrateLog
  })

  afterEach(async () => {
    if (previousLog === undefined) delete process.env.VINTA_FIXTURE_MIGRATE_LOG
    else process.env.VINTA_FIXTURE_MIGRATE_LOG = previousLog
    await rm(root, { recursive: true, force: true })
  })

  const provision = (project: ProjectSpec, laneCount = 3): Promise<LanePool> =>
    LanePool.provision({
      repoPath: repo,
      poolRoot,
      runId: 'run-1',
      laneCount,
      baseRef: 'main',
      project,
    })

  const migrated = (): string[] =>
    readFileSync(migrateLog, 'utf8').split('\n').filter(Boolean)

  it('provisions N lanes plus one integration worktree', async () => {
    const pool = await provision(sqliteProject())

    expect(pool.lanes).toHaveLength(3)
    expect(pool.integration.kind).toBe('integration')

    const paths = [...pool.lanes, pool.integration].map((lane) => lane.path)
    expect(new Set(paths).size).toBe(4)
    for (const path of paths) expect(existsSync(join(path, '.git'))).toBe(true)

    // The main checkout plus the four provisioned worktrees, and nothing else.
    expect(worktreePaths(repo)).toHaveLength(5)
  })

  it('creates each template exactly once and clones it into every lane', async () => {
    const pool = await provision(sqliteProject())
    const all = [...pool.lanes, pool.integration]

    // One migrate run per template — the dev one and the test one — and not one
    // per lane, which is the whole reason N lanes are affordable.
    const templates = migrated()
    expect(templates).toHaveLength(2)
    expect(new Set(templates).size).toBe(2)
    for (const template of templates) {
      expect(template.startsWith(join(poolRoot, '.templates'))).toBe(true)
    }

    const devTemplate = templates.find((path) => path.includes('dev-'))
    expect(devTemplate).toBeDefined()
    const templateBytes = readFileSync(devTemplate as string)
    for (const lane of all) {
      expect(readFileSync(join(lane.path, 'db.sqlite3'))).toEqual(templateBytes)
    }
  })

  it('gives every lane its own test database and compose project name', async () => {
    const pool = await provision(sqliteProject())
    const all = [...pool.lanes, pool.integration]

    const testDbs = all.map((lane) => envVar(lane, 'TEST_DATABASE_URL'))
    expect(new Set(testDbs).size).toBe(4)

    const projects = all.map((lane) => lane.composeProject)
    expect(new Set(projects).size).toBe(4)

    // Both land in the summary, which is what a restarted daemon reads back.
    const summaries = await Promise.all(
      all.map((lane) => readSummary(join(repo, '.vinta-ai-workflows', 'worktrees'), lane.name)),
    )
    expect(new Set(summaries.map((s) => s.state.compose.project_name)).size).toBe(4)
    expect(new Set(summaries.map((s) => s.state.test_db?.forked_name)).size).toBe(4)
  })

  it('resets a lane database back to the template', async () => {
    const pool = await provision(sqliteProject())
    const lane = pool.lanes[0] as Lane
    const testDb = envVar(lane, 'TEST_DATABASE_URL')

    const runSuite = () =>
      execFileSync('node', ['tests/widgets.mjs'], {
        cwd: lane.path,
        env: { ...process.env, ...lane.env },
      })
    runSuite()

    const write = new Database(testDb)
    write.prepare('INSERT INTO widgets (label) VALUES (?)').run('dirty')
    write.close()
    expect(new Database(testDb, { readonly: true }).prepare('SELECT count(*) FROM widgets').pluck().get()).toBe(1)

    const recycled = await pool.recycle(lane.name)

    expect(recycled.path).toBe(lane.path)
    expect(new Database(testDb, { readonly: true }).prepare('SELECT count(*) FROM widgets').pluck().get()).toBe(0)
    runSuite()
  })

  it('puts a reused worktree back on its own base, with nothing of the last phase in it', async () => {
    const pool = await provision(sqliteProject())
    const lane = pool.lanes[0] as Lane
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: lane.path,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()

    // A phase, as the executor runs one: its own branch cut in the lane, a
    // commit on it, and a scratch file nobody tracked.
    git('checkout', '-B', 'phase/a', 'main')
    await writeFile(join(lane.path, 'implemented.txt'), 'phase a', 'utf8')
    git('add', '-A')
    git('commit', '-m', 'phase a')
    await writeFile(join(lane.path, 'scratch.txt'), 'x', 'utf8')

    await pool.recycle(lane.name)

    // Back on the lane's own branch at its own base — not on the previous
    // phase's, which is where the next phase would otherwise start.
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(lane.branch)
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'main'))
    expect(existsSync(join(lane.path, 'implemented.txt'))).toBe(false)
    expect(existsSync(join(lane.path, 'scratch.txt'))).toBe(false)
    expect(git('status', '--porcelain')).toBe('')

    // The phase branch itself survives: integration still has to merge it.
    expect(git('rev-parse', '--verify', 'phase/a')).toMatch(/^[0-9a-f]{40}$/)
    // And the lane can still run: its linked dependency tree was not cleaned
    // away with the phase's leftovers.
    expect(existsSync(join(lane.path, 'node_modules'))).toBe(true)
    execFileSync('node', ['tests/widgets.mjs'], {
      cwd: lane.path,
      env: { ...process.env, ...lane.env },
    })
  })

  it('refuses loudly, naming only the lane, when a lane will not recycle', async () => {
    const pool = await provision(sqliteProject())
    const lane = pool.lanes[0] as Lane

    // The template the reset copies back is gone, so the reset cannot run.
    await rm(join(poolRoot, '.templates'), { recursive: true, force: true })

    const failure = await pool.recycle(lane.name).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LaneRecycleError)
    expect((failure as LaneRecycleError).lane).toBe(lane.name)
    expect((failure as LaneRecycleError).stage).toBe('database')
    // §11: the reset command and whatever it printed never reach the message.
    expect((failure as Error).message).not.toContain('cp ')
    expect((failure as Error).message).not.toContain('.templates')
  })

  it('re-provisions a single-use lane instead of reusing it', async () => {
    const pool = await provision(composeProject(), 2)
    const lane = pool.lanes[0] as Lane

    expect(lane.reusable).toBe(false)
    const summary = await readSummary(join(repo, '.vinta-ai-workflows', 'worktrees'), lane.name)
    expect(summary.state.dev_db?.reset_cmd).toBeNull()

    const marker = join(lane.path, 'left-behind')
    await writeFile(marker, 'x', 'utf8')

    const fresh = await pool.recycle(lane.name)

    expect(fresh.path).toBe(lane.path)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(lane.path, '.git'))).toBe(true)
    expect(worktreePaths(repo)).toHaveLength(4)
    expect(pool.lanes[0]).toBe(fresh)
  })

  it('refuses on the N× disk probe before provisioning anything', async () => {
    const { bavail, bsize } = await statfs(root)
    const available = bavail * bsize

    await expect(
      LanePool.provision({
        repoPath: repo,
        poolRoot,
        runId: 'run-1',
        laneCount: 3,
        baseRef: 'main',
        project: sqliteProject(),
        // Fits once over, not four times over — which is exactly the failure
        // mode a 1× probe would wave through.
        perLaneBytes: Math.floor(available / 2),
      }),
    ).rejects.toThrow(DiskProbeError)

    expect(existsSync(poolRoot)).toBe(false)
    expect(worktreePaths(repo)).toEqual([repo])
    expect(existsSync(migrateLog)).toBe(false)
  })
})

describe('database strategy selection', () => {
  // No server and no container: these are the decisions, not their execution.
  const external: PostgresSpec = {
    engine: 'postgres',
    delivery: 'external',
    name: 'app',
    serverUrl: 'postgres://localhost:5432',
    connectionUrlVar: 'DATABASE_URL',
  }
  const ctx = (laneName: string) => ({
    laneName,
    lanePath: `/pool/${laneName}`,
    templatesDir: '/pool/.templates',
  })

  it('clones every external lane database from one shared template', () => {
    const template = planTemplate('dev', external, '/pool/.templates')
    expect(template?.name).toBe('app_wt_template')

    const one = planDatabase('dev', external, ctx('run-1-lane-1'))
    const two = planDatabase('dev', external, ctx('run-1-lane-2'))

    expect(one.forkedName).toBe('app_wt_run_1_lane_1')
    expect(two.forkedName).toBe('app_wt_run_1_lane_2')
    expect(one.cloneCmd).toContain(`-T 'app_wt_template'`)
    expect(two.cloneCmd).toContain(`-T 'app_wt_template'`)
    expect(one.resetCmd).toContain(`dropdb --if-exists 'app_wt_run_1_lane_1'`)
    expect(one.connectionUrl).toContain('application_name=wt-run-1-lane-1')
  })

  it('gives a compose-delivered database no template and no reset', () => {
    const compose: PostgresSpec = { ...external, delivery: 'compose' }

    expect(planTemplate('dev', compose, '/pool/.templates')).toBeNull()

    const plan = planDatabase('dev', compose, ctx('run-1-lane-1'))
    // The lane boots its own server on its own volume, so the name is unchanged
    // and there is nothing to clone from — hence nothing to reset to.
    expect(plan.forkedName).toBe('app')
    expect(plan.cloneCmd).toBeNull()
    expect(plan.resetCmd).toBeNull()
  })
})
