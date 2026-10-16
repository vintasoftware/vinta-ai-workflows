/**
 * `purge --lanes` against runs that still need their lanes, and the teardown
 * each lane's summary records.
 *
 * Two failures from the field. A bulk `purge --lanes` removed the lanes of a
 * paused run, its integration worktree included, and the run could no longer
 * resume. And a purge removed worktrees while leaving every forked database,
 * compose stack and summary behind, so the cleanup was done by hand anyway.
 *
 * Teardown commands are recorded by a stub, never run: these tests must not
 * need docker or a Postgres server, and must never drop anything real.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { FAILED, OK, type Io } from '../src/cli/io.ts'
import { PURGE_USAGE, purgeCommand } from '../src/cli/purge.ts'
import type { RunStatus } from '../src/journal/events.ts'
import { openJournal } from '../src/journal/journal.ts'
import type { ProjectSpec } from '../src/lanes/pool.ts'
import { WorktreeSummarySchema, writeSummary, type WorktreeSummaryInput } from '../src/lanes/summary.ts'
import { planTeardown } from '../src/lanes/teardown.ts'
import { shellQuote } from '../src/platform/platform.ts'
import { parseWorkflow } from '../src/validate.ts'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const recorder = (answer = false) => {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  const io: Io = {
    out: (line) => out.push(...line.split('\n')),
    err: (line) => err.push(...line.split('\n')),
    confirm: async (question) => {
      asked.push(question)
      return answer
    },
  }
  return { io, out, err, asked }
}

/** Every command a purge would have run, in order, and nothing actually run. */
const stubExec = (fail: (command: string) => boolean = () => false) => {
  const ran: string[] = []
  return {
    ran,
    exec: async (command: string) => {
      ran.push(command)
      if (fail(command)) throw new Error('refused')
    },
  }
}

const PROJECT = {
  migrate_cmd: 'true',
  databases: {
    dev: {
      engine: 'postgres',
      delivery: 'external',
      name: 'app',
      server_url: 'postgres://db.local:5432',
      connection_url_var: 'DATABASE_URL',
    },
  },
}

const workflow = (project: unknown = PROJECT) => {
  const parsed = parseWorkflow({
    schema_version: 1,
    id: 'purge-fixture',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'solo' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    ...(project === undefined ? {} : { project }),
    nodes: [{ id: 'a', name: 'a', prompt_ref: 'plan.md#a', depends_on: [] }],
    pipelines: {
      solo: {
        states: [
          { id: 'work', name: 'Work', position: { x: 0, y: 0 } },
          { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
        ],
        transitions: [{ id: 't-done', from: 'work', to: 'done' }],
        initialStateIds: ['work'],
        finalStateIds: ['done'],
      },
    },
  })
  if (!parsed.ok) throw new Error('fixture workflow does not parse')
  return parsed.workflow
}

const laneRootOf = (repo: string): string => join(repo, '.vinta-ai-maestro', 'lanes')
const summaryDirOf = (repo: string): string => join(repo, '.vinta-ai-workflows', 'worktrees')

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-purge-lanes-'))
  temps.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'commit.gpgsign', 'false')
  // The store and summaries are gitignored in a real project; a lane's tree
  // must not see them as untracked work of its own.
  writeFileSync(join(dir, '.gitignore'), '.vinta-ai-maestro/\n.vinta-ai-workflows/\n', 'utf8')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'seed')
  mkdirSync(laneRootOf(dir), { recursive: true })
  return dir
}

/** A journalled run in `status`, frozen with `project`. */
function runIn(dir: string, runId: string, status: RunStatus, project?: unknown): void {
  const journal = openJournal(dir)
  try {
    journal.createRun(runId, workflow(project))
    if (status !== 'running') journal.append({ runId, type: 'run_ended', payload: { status } })
  } finally {
    journal.close()
  }
}

/** A lane worktree with the summary the pool would have written for it. */
async function lane(dir: string, name: string, extra: Partial<WorktreeSummaryInput['state']> = {}) {
  const path = join(laneRootOf(dir), name)
  git(dir, 'worktree', 'add', '-q', '-b', `plan/purge-fixture/phase-${name}`, path)
  await summary(dir, name, extra)
  return path
}

async function summary(dir: string, name: string, extra: Partial<WorktreeSummaryInput['state']> = {}) {
  await writeSummary(summaryDirOf(dir), {
    name,
    path: join(laneRootOf(dir), name),
    branch: `plan/purge-fixture/phase-${name}`,
    base_ref: 'main',
    created_at: '2026-10-01T00:00:00.000Z',
    state: { compose: { project_name: `repo_${name}` }, ...extra },
  })
}

const summaryOf = (dir: string, name: string): string => join(summaryDirOf(dir), `${name}.yaml`)

/**
 * The command lines as this machine's shell gets them: single quotes on POSIX,
 * double quotes on Windows. The tests check what is quoted, not how.
 */
const q = (value: string): string => shellQuote(value)
const down = (project: string): string => `docker compose -p ${q(project)} down`
const VOLUME_RM = `docker volume rm --force ${q('repo_over-lane-1_pgdata')}`
const DROP_ARGS = `-h ${q('db.local')} -p ${q('5432')} --if-exists ${q('app_wt_over_lane_1')}`

describe('purge --lanes keeps what a run can still resume', () => {
  it.each(['paused', 'failed', 'interrupted'] as const)(
    'keeps the lanes of a %s run, its integration worktree included, from a bulk purge',
    async (state) => {
      const dir = repo()
      runIn(dir, 'resumable', state === 'interrupted' ? 'running' : state)
      runIn(dir, 'over', 'cancelled')
      const keep = [await lane(dir, 'resumable-lane-1'), await lane(dir, 'resumable-integ')]
      const gone = await lane(dir, 'over-lane-1')
      const io = recorder()

      expect(await purgeCommand(['--repo', dir, '--lanes', '--yes'], io.io, { exec: stubExec().exec })).toBe(OK)

      for (const path of keep) expect(existsSync(path)).toBe(true)
      expect(existsSync(summaryOf(dir, 'resumable-integ'))).toBe(true)
      expect(existsSync(gone)).toBe(false)
      expect(existsSync(summaryOf(dir, 'over-lane-1'))).toBe(false)
      // The run directory goes no further than its lanes do.
      expect(existsSync(join(dir, '.vinta-ai-maestro', 'runs', 'resumable'))).toBe(true)
      expect(existsSync(join(dir, '.vinta-ai-maestro', 'runs', 'over'))).toBe(false)
      const text = io.out.join('\n')
      expect(text).toContain(`Kept — lanes of resumable: it is ${state} and can still be resumed`)
      expect(io.err.join('\n')).toContain('keeping resumable')
    },
  )

  it('purges a resumable run, and its lanes, when it is named', async () => {
    const dir = repo()
    runIn(dir, 'paused-run', 'paused')
    const path = await lane(dir, 'paused-run-integ')

    expect(await purgeCommand(['paused-run', '--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stubExec().exec })).toBe(OK)

    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir, '.vinta-ai-maestro', 'runs', 'paused-run'))).toBe(false)
  })

  it('purges resumable runs without naming them under --force', async () => {
    const dir = repo()
    runIn(dir, 'paused-run', 'paused')
    const path = await lane(dir, 'paused-run-lane-1')

    expect(await purgeCommand(['--repo', dir, '--lanes', '--force', '--yes'], recorder().io, { exec: stubExec().exec })).toBe(OK)

    expect(existsSync(path)).toBe(false)
  })

  it('never touches the lanes of a run whose job is alive, even named and forced', async () => {
    const dir = repo()
    runIn(dir, 'live', 'running')
    mkdirSync(join(dir, '.vinta-ai-maestro', 'runs', 'live'), { recursive: true })
    writeFileSync(
      join(dir, '.vinta-ai-maestro', 'runs', 'live', 'job.json'),
      JSON.stringify({ runId: 'live', pid: 4242, url: 'http://127.0.0.1:9', token: 't', state: 'running', startedAt: 0 }),
      'utf8',
    )
    const path = await lane(dir, 'live-lane-1')
    const io = recorder()

    await purgeCommand(['live', '--repo', dir, '--lanes', '--force', '--yes'], io.io, {
      exec: stubExec().exec,
      alive: (pid) => pid === 4242,
    })

    expect(existsSync(path)).toBe(true)
    expect(existsSync(summaryOf(dir, 'live-lane-1'))).toBe(true)
    expect(io.out.join('\n')).toContain('Kept — lanes of live: its job is still running')
  })

  /** `run-1-lane-1` is `run-1`'s, not a lane of a run that happens to be called `run`. */
  it('gives a lane to the longest run id it starts with', async () => {
    const dir = repo()
    runIn(dir, 'run', 'cancelled')
    runIn(dir, 'run-1', 'paused')
    const path = await lane(dir, 'run-1-lane-1')

    await purgeCommand(['run', '--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stubExec().exec })

    expect(existsSync(path)).toBe(true)
  })

  it('says in its help which runs it keeps, and how to override that', () => {
    expect(PURGE_USAGE).toContain('--force')
    expect(PURGE_USAGE).toMatch(/paused, failed, interrupted/)
    expect(PURGE_USAGE).not.toContain('a failed run left behind')
  })
})

describe('purge --lanes tears down what a lane made outside git', () => {
  const STATE = {
    dev_db: {
      engine: 'postgres',
      strategy: 'fork' as const,
      forked_name: 'app_wt_over_lane_1',
      connection_url_var: 'DATABASE_URL',
      reset_cmd: 'dropdb … && createdb …',
    },
    services: [
      { id: 'cache', namespace: 'over-lane-1', connection_url_var: 'REDIS_URL', reset_cmd: 'redis-cli -u redis://:s3cret@h/0 flushdb' },
      { id: 'queue', namespace: '0', connection_url_var: 'BROKER_URL', reset_cmd: 'flush 0' },
    ],
    compose: {
      project_name: 'repo_over-lane-1',
      override_path: '/x/over-lane-1.docker-compose.override.yml',
      forked_volumes: [{ key: 'pgdata', name: 'repo_over-lane-1_pgdata', reason: 'external: true' }],
    },
  }

  it('lists every command under --dry-run, runs none, and prints no service command', async () => {
    const dir = repo()
    runIn(dir, 'over', 'cancelled')
    const path = await lane(dir, 'over-lane-1', STATE)
    const stub = stubExec()
    const io = recorder()

    expect(await purgeCommand(['--repo', dir, '--lanes', '--dry-run'], io.io, { exec: stub.exec })).toBe(OK)

    expect(stub.ran).toEqual([])
    expect(existsSync(path)).toBe(true)
    const text = io.out.join('\n')
    expect(text).toContain(down('repo_over-lane-1'))
    expect(text).toContain(VOLUME_RM)
    expect(text).toContain(`dropdb ${DROP_ARGS}`)
    expect(text).toContain('reset service cache namespace over-lane-1 (its reset_cmd)')
    // A reset_cmd is the project's own text and may carry a credential.
    expect(text).not.toContain('s3cret')
    // An `index` slot is the next run's lane in the same position.
    expect(text).toContain('service queue slot 0')
  })

  it('runs the teardown in order, then removes the worktree and the summary', async () => {
    const dir = repo()
    runIn(dir, 'over', 'cancelled')
    const path = await lane(dir, 'over-lane-1', STATE)
    const stub = stubExec()

    expect(await purgeCommand(['--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stub.exec })).toBe(OK)

    expect(stub.ran).toEqual([
      down('repo_over-lane-1'),
      VOLUME_RM,
      'redis-cli -u redis://:s3cret@h/0 flushdb',
      `dropdb ${DROP_ARGS}`,
    ])
    expect(existsSync(path)).toBe(false)
    expect(existsSync(summaryOf(dir, 'over-lane-1'))).toBe(false)
  })

  it('honours the project’s dropdb_cmd', async () => {
    const dir = repo()
    const project = {
      ...PROJECT,
      databases: { dev: { ...PROJECT.databases.dev, dropdb_cmd: 'docker compose exec -T db dropdb' } },
    }
    runIn(dir, 'over', 'cancelled', project)
    await lane(dir, 'over-lane-1', { dev_db: STATE.dev_db })
    const stub = stubExec()

    await purgeCommand(['--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stub.exec })

    expect(stub.ran).toEqual([
      `docker compose exec -T db dropdb ${DROP_ARGS}`,
    ])
  })

  it('reports a failed step, keeps the summary for a retry, and still removes the worktree', async () => {
    const dir = repo()
    runIn(dir, 'over', 'cancelled')
    const path = await lane(dir, 'over-lane-1', STATE)
    const stub = stubExec((command) => command.startsWith('dropdb'))
    const io = recorder()

    expect(await purgeCommand(['--repo', dir, '--lanes', '--yes'], io.io, { exec: stub.exec })).toBe(FAILED)

    expect(stub.ran).toHaveLength(4)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(summaryOf(dir, 'over-lane-1'))).toBe(true)
    expect(io.err.join('\n')).toContain(`dropdb ${DROP_ARGS} (lane over-lane-1)`)
  })

  it('tears down nothing for a lane it keeps', async () => {
    const dir = repo()
    runIn(dir, 'paused-run', 'paused')
    await lane(dir, 'paused-run-lane-1', STATE)
    const stub = stubExec()

    await purgeCommand(['--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stub.exec })

    expect(stub.ran).toEqual([])
  })
})

describe('orphan summaries', () => {
  it('reaps a summary whose worktree is gone, tearing down what it records', async () => {
    const dir = repo()
    runIn(dir, 'over', 'cancelled')
    await summary(dir, 'over-lane-2', { compose: { project_name: 'repo_over-lane-2', override_path: '/x/o.yml' } })
    writeFileSync(join(summaryDirOf(dir), 'over-lane-2.docker-compose.override.yml'), '# GENERATED by vinta-ai-maestro.\n', 'utf8')
    const stub = stubExec()
    const io = recorder()

    expect(await purgeCommand(['--repo', dir, '--lanes', '--yes'], io.io, { exec: stub.exec })).toBe(OK)

    expect(stub.ran).toEqual([down('repo_over-lane-2')])
    expect(existsSync(summaryOf(dir, 'over-lane-2'))).toBe(false)
    expect(existsSync(join(summaryDirOf(dir), 'over-lane-2.docker-compose.override.yml'))).toBe(false)
  })

  it('reaps the summaries of a run that is already purged', async () => {
    const dir = repo()
    await summary(dir, 'long-gone-lane-1')

    await purgeCommand(['--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stubExec().exec })

    expect(existsSync(summaryOf(dir, 'long-gone-lane-1'))).toBe(false)
  })

  it('keeps the orphan summaries of a run that can still resume', async () => {
    const dir = repo()
    runIn(dir, 'paused-run', 'paused')
    await summary(dir, 'paused-run-lane-1')

    await purgeCommand(['--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stubExec().exec })

    expect(existsSync(summaryOf(dir, 'paused-run-lane-1'))).toBe(true)
  })

  /** `prepare-worktree` writes summaries for worktrees a person made, in the same directory. */
  it('leaves a summary that is not a lane’s alone', async () => {
    const dir = repo()
    await writeSummary(summaryDirOf(dir), {
      name: 'my-feature',
      path: join(dir, '..', 'my-feature'),
      branch: 'my-feature',
      base_ref: 'main',
      created_at: '2026-10-01T00:00:00.000Z',
      state: { compose: { project_name: 'repo_my-feature', override_path: '/x/o.yml' } },
    })
    writeFileSync(join(summaryDirOf(dir), 'notes.yaml'), 'not: a summary\n', 'utf8')
    writeFileSync(join(summaryDirOf(dir), 'hand.docker-compose.override.yml'), 'services: {}\n', 'utf8')
    const stub = stubExec()

    await purgeCommand(['--repo', dir, '--lanes', '--yes'], recorder().io, { exec: stub.exec })

    expect(stub.ran).toEqual([])
    expect(existsSync(summaryOf(dir, 'my-feature'))).toBe(true)
    expect(existsSync(join(summaryDirOf(dir), 'notes.yaml'))).toBe(true)
    expect(existsSync(join(summaryDirOf(dir), 'hand.docker-compose.override.yml'))).toBe(true)
  })
})

describe('planTeardown drops only what is provably the lane’s', () => {
  const base = (state: Partial<WorktreeSummaryInput['state']>) =>
    WorktreeSummarySchema.parse({
      name: 'r-lane-1',
      path: '/repo/.vinta-ai-maestro/lanes/r-lane-1',
      branch: 'b',
      base_ref: 'main',
      created_at: 'now',
      state: { compose: { project_name: 'repo_r-lane-1' }, ...state },
    })
  const db = (forked: string) => ({
    engine: 'postgres',
    strategy: 'fork' as const,
    forked_name: forked,
    connection_url_var: 'DATABASE_URL',
    reset_cmd: null,
  })
  const spec = (delivery: 'external' | 'compose'): ProjectSpec => ({
    migrateCmd: 'true',
    databases: {
      dev: { engine: 'postgres', delivery, name: 'app', serverUrl: 'postgres://h:5432', connectionUrlVar: 'DATABASE_URL' },
    },
  })

  /** A compose-delivered database records the main checkout's own name. */
  it('never drops a compose-delivered database by name', () => {
    const plan = planTeardown(base({ dev_db: db('app') }), spec('compose'), 'linux')
    expect(plan.steps).toEqual([])
  })

  it('leaves a database whose name is not the one this lane would have', () => {
    const plan = planTeardown(base({ dev_db: db('app') }), spec('external'), 'linux')
    expect(plan.steps).toEqual([])
    expect(plan.left.join('\n')).toContain('database app')
  })

  it('leaves a database when the run’s project block is unknown', () => {
    const plan = planTeardown(base({ dev_db: db('app_wt_r_lane_1') }), null, 'linux')
    expect(plan.steps).toEqual([])
    expect(plan.left.join('\n')).toContain('app_wt_r_lane_1')
  })

  it('stops no stack for a lane that had no compose file', () => {
    expect(planTeardown(base({}), null, 'linux').steps).toEqual([])
  })
})
