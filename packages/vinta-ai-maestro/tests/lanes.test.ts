import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdtemp, realpath, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planDatabase, planTemplate, type PostgresSpec } from '../src/lanes/database.ts'
import { DiskProbeError } from '../src/lanes/disk.ts'
import {
  type Lane,
  LanePool,
  LaneRecycleError,
  type PoolOptions,
  type ProjectSpec,
} from '../src/lanes/pool.ts'
import { readSummary } from '../src/lanes/summary.ts'
import { shellQuote } from '../src/platform/platform.ts'

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
  // No background writer in a tree this suite is about to delete. git starts
  // detached maintenance of its own accord after ordinary operations, and it
  // writes `.git/objects/maintenance.lock` and then removes it — so a
  // recursive delete racing it fails on `lstat` of a file that existed a
  // moment ago. That surfaced as `ENOENT … maintenance.lock` in teardown on
  // macOS, from a process nothing in this file started. It is also one fewer
  // git holding a handle on Windows, where that is what `EBUSY` is made of.
  git('config', 'maintenance.auto', 'false')
  git('config', 'gc.auto', '0')
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

/**
 * Rows in a lane's test database, with the connection closed before the count
 * is returned.
 *
 * The close is the point. On Windows a directory cannot be removed while any
 * handle into it is open, so a `Database` left open by an assertion is not a
 * leak that the garbage collector eventually tidies — it is an `EBUSY` in this
 * suite's own teardown, blaming a temp directory that nothing in the product
 * is holding. `finally` rather than a close after the read, so a failing query
 * fails the test instead of poisoning the cleanup too.
 */
const widgetCount = (databasePath: string): number => {
  const db = new Database(databasePath, { readonly: true })
  try {
    return db.prepare('SELECT count(*) FROM widgets').pluck().get() as number
  } finally {
    db.close()
  }
}

const envVar = (lane: Lane, key: string): string => {
  const value = lane.env[key]
  if (!value) throw new Error(`lane "${lane.name}" has no ${key}`)
  return value
}

/**
 * The worktrees git knows about, as **git** spells them.
 *
 * `git worktree list` prints forward slashes on Windows too — git speaks posix
 * paths everywhere — while `mkdtemp` hands the test a native `C:\…` path, so
 * comparing the two directly failed on a separator rather than on anything the
 * test is about. Both sides are normalised to git's spelling, which is the one
 * that is the same on every platform.
 */
const gitPath = (path: string): string => path.replaceAll('\\', '/')

const worktreePaths = (repo: string): string[] =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => gitPath(line.slice('worktree '.length)))

describe('lane pool', () => {
  let root: string
  let repo: string
  let poolRoot: string
  let migrateLog: string
  const previousLog = process.env.VINTA_FIXTURE_MIGRATE_LOG

  beforeEach(async () => {
    // realpath: macOS resolves /var to /private/var, and git reports the real
    // path back, so worktree comparisons need the resolved form.
    root = await realpath(await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-lanes-')))
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
    // Retried rather than attempted once, because of what this tree is: a git
    // repo the suite has spawned `git` against and a pool of sqlite files it
    // has opened. On Windows a directory cannot be removed while any handle
    // into it is open, and a child that has already exited can still be holding
    // one for a moment afterwards — `EBUSY` on `rmdir …\source`, from nothing
    // that is still running. Every handle this suite owns is closed by the time
    // it gets here; `maxRetries` covers the ones the OS has not let go of yet,
    // backing off linearly between attempts.
    //
    // Still awaited and still allowed to throw. A teardown that swallowed this
    // would leave a temp directory per run behind forever and say nothing.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  const provision = (
    project: ProjectSpec,
    laneCount = 3,
    extra: Partial<PoolOptions> = {},
  ): Promise<LanePool> =>
    LanePool.provision({
      repoPath: repo,
      poolRoot,
      runId: 'run-1',
      laneCount,
      baseRef: 'main',
      project,
      ...extra,
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
    expect(widgetCount(testDb)).toBe(1)

    const recycled = await pool.recycle(lane.name)

    expect(recycled.path).toBe(lane.path)
    expect(widgetCount(testDb)).toBe(0)
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

  it('gives every lane its own copy of the project’s env files', async () => {
    await writeFile(join(repo, '.env'), 'SHARED=1\n', 'utf8')
    const pool = await provision({ ...sqliteProject(), envFiles: ['.env'] }, 2)

    for (const lane of pool.lanes) {
      expect(readFileSync(join(lane.path, '.env'), 'utf8')).toBe('SHARED=1\n')
    }

    // A copy, not a link — the property the whole field exists for. Lane
    // provisioning appends lane-specific lines to these files, and through a
    // symlink every one of them would land in the main checkout instead.
    const [first] = pool.lanes as [Lane]
    await writeFile(join(first.path, '.env'), 'SHARED=1\nLANE=1\n', 'utf8')
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('SHARED=1\n')
  })

  it('refuses to provision when a declared env file is not there', async () => {
    // Fail closed. The alternative is a lane that provisions cleanly and then
    // cannot boot its stack, four steps later, wearing an unrelated error.
    await expect(provision({ ...sqliteProject(), envFiles: ['.env.docker'] }, 1)).rejects.toThrow(
      /\.env\.docker/,
    )
  })

  it('restores an env file the phase edited when the lane is recycled', async () => {
    await writeFile(join(repo, '.env'), 'SHARED=1\n', 'utf8')
    const pool = await provision({ ...sqliteProject(), envFiles: ['.env'] }, 1)
    const lane = pool.lanes[0] as Lane

    await writeFile(join(lane.path, '.env'), 'SHARED=1\nMEDDLED=1\n', 'utf8')
    await pool.recycle(lane.name)

    // `git clean` cannot do this: the file is ignored, so the clean leaves it
    // exactly as the previous phase left it. A lane is its env as much as it is
    // its rows, and both go back.
    expect(readFileSync(join(lane.path, '.env'), 'utf8')).toBe('SHARED=1\n')
  })

  // Writes the lane's own cwd-relative receipt out of the lane's own
  // environment, so what it proves is that the hook ran *in the lane* and *with
  // its env* rather than in the daemon's directory with the daemon's.
  const SETUP_RECEIPT = 'setup.receipt'
  const writesReceipt =
    `node -e "require('fs').writeFileSync('${SETUP_RECEIPT}', ` +
    `process.env.DATABASE_URL + '|' + process.env.COMPOSE_PROJECT_NAME)"`

  it('runs the project’s setup command in the lane, with the lane’s environment', async () => {
    const pool = await provision({ ...sqliteProject(), setupCmd: writesReceipt }, 2)

    for (const lane of pool.lanes) {
      const written = readFileSync(join(lane.path, SETUP_RECEIPT), 'utf8')
      expect(written).toBe(`${envVar(lane, 'DATABASE_URL')}|${lane.composeProject}`)
    }
  })

  it('runs the setup command again every time the lane is recycled', async () => {
    // Which is why its contract says idempotent. The receipt is untracked, so
    // the recycle's own `git clean` deletes it — a receipt standing afterwards
    // can only have been written again, which is the assertion.
    const pool = await provision({ ...sqliteProject(), setupCmd: writesReceipt }, 1)
    const lane = pool.lanes[0] as Lane
    expect(existsSync(join(lane.path, SETUP_RECEIPT))).toBe(true)

    await pool.recycle(lane.name)

    expect(existsSync(join(lane.path, SETUP_RECEIPT))).toBe(true)
  })

  it('fails the lane, naming no output, when the setup command fails', async () => {
    const failure = await provision(
      { ...sqliteProject(), setupCmd: 'node -e "console.log(process.cwd()); process.exit(3)"' },
      1,
    ).then(
      () => null,
      (error: unknown) => error as Error,
    )

    expect(failure?.name).toBe('LaneSetupError')
    // §11 again: what the project's own command printed is the project's, and
    // it reaches an error message no more than it reaches a log field. Nor does
    // the command line itself — a lane name is enough to act on.
    expect(failure?.message).not.toContain('node -e')
    expect(failure?.message).not.toContain(root)
  })

  // The config `docker compose config` would have printed, supplied directly:
  // the real read shells out to docker, and what is under test here is the
  // wiring around it rather than compose's own parser.
  const readCompose = async () => ({
    baseFile: 'docker-compose.yml',
    config: {
      name: 'app',
      services: { db: { ports: [{ target: 5432, published: '5432' }] } },
      volumes: { dbdata: { name: 'app_dbdata', external: true } },
    },
  })

  it('gives each lane its own compose override, outside the worktree', async () => {
    const pool = await provision({ ...sqliteProject(), compose: {} }, 2, { readCompose })

    for (const lane of pool.lanes) {
      const composeFile = envVar(lane, 'COMPOSE_FILE')
      const [base, override] = composeFile.split(delimiter)

      // The base stays relative — the lane carries its own tracked copy — and
      // the override is absolute, because it lives outside the worktree and a
      // bare name would not resolve from the compose project directory.
      expect(base).toBe('docker-compose.yml')
      expect(isAbsolute(override as string)).toBe(true)
      expect(existsSync(override as string)).toBe(true)

      // And never at the worktree root. `docker-compose.override.yml` there is
      // auto-loaded, which is convenient, and is also frequently a *tracked*
      // file — writing this into it would put the lane's isolation into the
      // phase's commit and from there into the merge.
      expect(existsSync(join(lane.path, 'docker-compose.override.yml'))).toBe(false)

      const written = readFileSync(override as string, 'utf8')
      expect(written).toContain('ports: !override []')
      expect(written).toContain(`name: "${lane.composeProject}_dbdata"`)
    }

    // Two lanes, two volume names. One would be two postmasters on one PGDATA.
    const overrides = pool.lanes.map((lane) => envVar(lane, 'COMPOSE_FILE'))
    expect(new Set(overrides).size).toBe(2)
  })

  it('records the forked volumes in the summary, which is the teardown manifest', async () => {
    const pool = await provision({ ...sqliteProject(), compose: {} }, 1, { readCompose })
    const lane = pool.lanes[0] as Lane

    const summary = await readSummary(join(repo, '.vinta-ai-workflows', 'worktrees'), lane.name)

    // A volume on this list is a `docker volume rm` target; one that is not is
    // a volume somebody else is still using.
    expect(summary.state.compose.forked_volumes).toEqual([
      { key: 'dbdata', name: `${lane.composeProject}_dbdata`, reason: 'external: true' },
    ])
    expect(summary.state.compose.ports_stripped_from).toEqual(['db'])
    expect(summary.state.compose.base_compose_file).toBe('docker-compose.yml')
  })

  it('leaves a project with no compose file entirely alone', async () => {
    // Which is the fixture repo. No compose file means no docker call and no
    // `COMPOSE_FILE`, not an empty override nobody asked for.
    const pool = await provision({ ...sqliteProject(), compose: {} }, 1)
    const lane = pool.lanes[0] as Lane

    expect(lane.env['COMPOSE_FILE']).toBeUndefined()
    expect(lane.compose).toBeNull()
  })

  it('gives each lane its own namespace inside one shared service', async () => {
    const receipts = join(root, 'created')
    const pool = await provision(
      {
        ...sqliteProject(),
        services: [
          {
            id: 'redis',
            namespace: 'index',
            url: 'redis://localhost:6379',
            urlVar: 'REDIS_URL',
            capacity: 16,
            // Stands in for `rabbitmqadmin declare vhost` and the like: proof
            // the command ran, per lane, with its own namespace substituted.
            createCmd: `node -e "require('fs').appendFileSync(process.argv[1], '{namespace},')" ${receipts}`,
            resetCmd: `node -e "require('fs').appendFileSync(process.argv[1], 'r{namespace},')" ${receipts}`,
          },
        ],
      },
      2,
    )

    // One server. Three namespaces — two lanes and the integration worktree,
    // which takes the slot after the last lane rather than sharing one.
    expect(pool.lanes.map((lane) => envVar(lane, 'REDIS_URL'))).toEqual([
      'redis://localhost:6379/0',
      'redis://localhost:6379/1',
    ])
    expect(envVar(pool.integration, 'REDIS_URL')).toBe('redis://localhost:6379/2')
    expect(readFileSync(receipts, 'utf8').split(',').filter(Boolean).sort()).toEqual(['0', '1', '2'])
  })

  it('empties a lane’s namespace when the lane is handed to the next phase', async () => {
    const receipts = join(root, 'reset')
    const pool = await provision(
      {
        ...sqliteProject(),
        services: [
          {
            id: 'redis',
            namespace: 'index',
            url: 'redis://localhost:6379',
            urlVar: 'REDIS_URL',
            capacity: 16,
            resetCmd: `node -e "require('fs').appendFileSync(process.argv[1], '{namespace}')" ${receipts}`,
          },
        ],
      },
      1,
    )
    const lane = pool.lanes[0] as Lane

    await pool.recycle(lane.name)

    // The same stage as the database reset, because it is the same kind of
    // thing: state the previous phase left that the next one must not read.
    expect(readFileSync(receipts, 'utf8')).toBe('0')
    // And the lane keeps its slot across the hand-over — a lane whose redis
    // database moved between phases is a lane that lost its own state.
    expect(envVar(pool.lane(lane.name), 'REDIS_URL')).toBe('redis://localhost:6379/0')
  })

  it('refuses a pool larger than a shared service has room for, before creating anything', async () => {
    const tooMany = provision(
      {
        ...sqliteProject(),
        services: [
          {
            id: 'redis',
            namespace: 'index',
            url: 'redis://localhost:6379',
            urlVar: 'REDIS_URL',
            capacity: 2,
          },
        ],
      },
      3,
    )

    await expect(tooMany).rejects.toThrow(/raise its capacity, or run fewer lanes/)
    expect(existsSync(poolRoot)).toBe(false)
    expect(worktreePaths(repo)).toEqual([gitPath(repo)])
    expect(existsSync(migrateLog)).toBe(false)
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
    expect(worktreePaths(repo)).toEqual([gitPath(repo)])
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
    // Quoted through the platform seam rather than with POSIX quotes written
    // out. The subject here is the *command* `planDatabase` builds — that it
    // clones from the shared template and drops by the lane's own name — and
    // on Windows those names are wrapped for `cmd.exe`, which has no use for
    // single quotes. Writing the POSIX form by hand asserted this module's
    // behaviour on one platform and `shellQuote`'s on the other; `shellQuote`
    // has its own tests in `platform.test.ts` for the quoting itself.
    const q = (name: string) => shellQuote(name)
    expect(one.cloneCmd).toContain(`-T ${q('app_wt_template')}`)
    expect(two.cloneCmd).toContain(`-T ${q('app_wt_template')}`)
    expect(one.resetCmd).toContain(`dropdb --if-exists ${q('app_wt_run_1_lane_1')}`)
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
