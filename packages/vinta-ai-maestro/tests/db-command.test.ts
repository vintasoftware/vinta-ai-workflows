/**
 * A database command that would wait for a password must fail, quickly and
 * loudly, rather than leave the run at `starting` forever; and the commands
 * that create lane databases must be redirectable to a container.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { planDatabase, planTemplate, type PostgresSpec } from '../src/lanes/database.ts'
import { DatabaseCommandError, runDatabaseCommand } from '../src/lanes/db-command.ts'
import { DatabaseSchema } from '../src/types.ts'
import { shellQuote } from '../src/platform/platform.ts'

const temps: string[] = []
const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-dbcmd-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const node = (source: string): string => `${shellQuote(process.execPath)} -e ${shellQuote(source)}`

describe('configurable createdb / dropdb', () => {
  const external: PostgresSpec = {
    engine: 'postgres',
    delivery: 'external',
    name: 'app',
    serverUrl: 'postgres://app@localhost:5432',
    connectionUrlVar: 'DATABASE_URL',
  }
  const ctx = { laneName: 'run-1-lane-1', lanePath: '/pool/lane', templatesDir: '/pool/.t' }
  const q = (value: string): string => shellQuote(value)
  const flags = `-h ${q('localhost')} -p ${q('5432')} -U ${q('app')}`

  it('defaults to the bare binaries', () => {
    expect(planTemplate('dev', external, '/pool/.t')?.setupCmd).toBe(
      `dropdb ${flags} --if-exists ${q('app_wt_template')} && createdb ${flags} ${q('app_wt_template')}`,
    )
  })

  it('puts the override in the template, the clone and the reset, flags still following', () => {
    const spec: PostgresSpec = {
      ...external,
      createdbCmd: 'docker compose exec -T db createdb',
      dropdbCmd: 'docker compose exec -T db dropdb',
    }
    expect(planTemplate('dev', spec, '/pool/.t')?.setupCmd).toBe(
      `docker compose exec -T db dropdb ${flags} --if-exists ${q('app_wt_template')} && ` +
        `docker compose exec -T db createdb ${flags} ${q('app_wt_template')}`,
    )
    const lane = planDatabase('dev', spec, ctx)
    expect(lane.cloneCmd).toBe(
      `docker compose exec -T db createdb ${flags} -T ${q('app_wt_template')} ${q('app_wt_run_1_lane_1')}`,
    )
    expect(lane.resetCmd).toBe(
      `docker compose exec -T db dropdb ${flags} --if-exists ${q('app_wt_run_1_lane_1')} && ` +
        `docker compose exec -T db createdb ${flags} -T ${q('app_wt_template')} ${q('app_wt_run_1_lane_1')}`,
    )
  })

  it('accepts the fields in a workflow and rejects them on sqlite', () => {
    const database = (extra: object) => ({
      engine: 'postgres',
      delivery: 'external',
      name: 'app',
      server_url: 'postgres://localhost:5432',
      connection_url_var: 'DATABASE_URL',
      ...extra,
    })
    const kept = DatabaseSchema.parse(
      database({ createdb_cmd: 'x createdb', dropdb_cmd: 'x dropdb' }),
    )
    expect(kept).toMatchObject({ createdb_cmd: 'x createdb', dropdb_cmd: 'x dropdb' })
    expect(
      DatabaseSchema.safeParse({
        engine: 'sqlite',
        path: 'db.sqlite3',
        connection_url_var: 'U',
        createdb_cmd: 'x',
      }).success,
    ).toBe(false)
  })
})

describe('database commands cannot hang a run', () => {
  it('kills a command that waits on a prompt and reports it as a timeout', async () => {
    const started = Date.now()
    const failure = await runDatabaseCommand(node('setTimeout(() => {}, 60000)'), {
      cwd: makeTemp(),
      timeoutMs: 300,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DatabaseCommandError)
    expect((failure as DatabaseCommandError).timedOut).toBe(true)
    expect((failure as DatabaseCommandError).message).toContain('PGPASSWORD')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('closes stdin, so a command reading it sees end-of-file instead of blocking', async () => {
    await expect(
      runDatabaseCommand(node("process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"), {
        cwd: makeTemp(),
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined()
  })

  it('carries a failing command’s stderr and exit code', async () => {
    const failure = await runDatabaseCommand(
      node("console.error('FATAL: password authentication failed'); process.exit(2)"),
      { cwd: makeTemp(), timeoutMs: 5_000 },
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DatabaseCommandError)
    expect((failure as DatabaseCommandError).exitCode).toBe(2)
    expect((failure as DatabaseCommandError).message).toContain('password authentication failed')
  })
})
