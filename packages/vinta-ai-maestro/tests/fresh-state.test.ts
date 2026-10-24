/**
 * The integration worktree runs merges for different trees one after another,
 * and a gate there that keeps its test database (`pytest --reuse-db`) applied
 * each tree's migrations on top of the last tree's database. One observed run
 * had three merges fail on columns and relations that belonged to another
 * branch — false "pass alone, break together" failures, each two fix rounds.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type FreshReason, IntegrationFreshness, looksStale } from '../src/integration/fresh.ts'
import { fixVerdict } from '../src/integration/fixer.ts'
import type { CommandGate } from '../src/types.ts'

let root: string
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function commit(file: string, message: string): Promise<void> {
  await writeFile(join(root, file), message)
  git('add', '--all')
  git('commit', '-q', '-m', message)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-fresh-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'fixture')
  git('config', 'commit.gpgsign', 'false')
  await commit('base.txt', 'base')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const gate: CommandGate = {
  cmd: 'pytest --reuse-db',
  fresh_cmd: 'pytest --create-db',
  requires: [],
  timeout_s: 60,
}

function recorder() {
  const ran: string[] = []
  const fresh: FreshReason[] = []
  const tracker = new IntegrationFreshness({ onFresh: (_gate, reason) => fresh.push(reason) })
  const pass = async (chosen: CommandGate) => {
    ran.push(chosen.cmd)
    return { status: 'passed', logPath: join(root, 'none.log') }
  }
  return { ran, fresh, tracker, pass }
}

describe('fresh state for integration gates', () => {
  it('starts fresh when the worktree moves to a tree that is not a descendant, and reuses going forward', async () => {
    const { ran, fresh, tracker, pass } = recorder()
    git('checkout', '-q', '-b', 'integ-p10')
    await commit('p10.txt', 'p10 migration')
    await tracker.run('test', gate, root, pass)

    // Forward on the same tree: a reused database applies the new migration.
    await commit('p10b.txt', 'p10 second migration')
    await tracker.run('test', gate, root, pass)

    // A sibling tree lacks p10's migration; the database still has it.
    git('checkout', '-q', '-b', 'wave-2', 'main')
    await commit('wave.txt', 'wave-2 migration')
    await tracker.run('test', gate, root, pass)

    expect(ran).toEqual(['pytest --create-db', 'pytest --reuse-db', 'pytest --create-db'])
    expect(fresh).toEqual(['first_run', 'tree_moved'])
  })

  it('reruns a red gate from fresh state once when its output reads as a stale schema', async () => {
    const { ran, fresh, tracker, pass } = recorder()
    await tracker.run('test', gate, root, pass)
    await commit('next.txt', 'next')
    const log = join(root, 'test.log')
    await writeFile(log, 'psycopg.errors.UndefinedTable: relation "payments_cohortfee" does not exist\n')
    const result = await tracker.run('test', gate, root, async (chosen) => {
      ran.push(chosen.cmd)
      return { status: chosen.cmd === gate.fresh_cmd ? 'passed' : 'failed', logPath: log }
    })
    expect(result.status).toBe('passed')
    expect(ran.slice(1)).toEqual(['pytest --reuse-db', 'pytest --create-db'])
    expect(fresh).toEqual(['first_run', 'stale_schema'])
  })

  it('believes a red gate whose output is about the code', async () => {
    const { ran, tracker, pass } = recorder()
    await tracker.run('test', gate, root, pass)
    const log = join(root, 'test.log')
    await writeFile(log, 'AssertionError: expected 2, got 3\n')
    const result = await tracker.run('test', gate, root, async (chosen) => {
      ran.push(chosen.cmd)
      return { status: 'failed', logPath: log }
    })
    expect(result.status).toBe('failed')
    expect(ran).toEqual(['pytest --create-db', 'pytest --reuse-db'])
  })

  /**
   * A suite killed by its timeout left one worker database with 71 of 134
   * migrations; the next run on the same tree reused it and failed on columns
   * that were not there yet.
   */
  it('starts fresh after a run that was killed, even on the same tree', async () => {
    const { ran, fresh, tracker, pass } = recorder()
    await tracker.run('test', gate, root, pass)
    await tracker.run('test', gate, root, async (chosen) => {
      ran.push(chosen.cmd)
      return { status: 'timed_out', logPath: join(root, 'none.log') }
    })
    await tracker.run('test', gate, root, pass)
    await tracker.run('test', gate, root, pass)
    expect(ran).toEqual(['pytest --create-db', 'pytest --reuse-db', 'pytest --create-db', 'pytest --reuse-db'])
    expect(fresh).toEqual(['first_run', 'interrupted'])
  })

  it('runs `cmd` everywhere for a gate without `fresh_cmd`', async () => {
    const { ran, tracker, pass } = recorder()
    const plain: CommandGate = { cmd: 'pytest', requires: [], timeout_s: 60 }
    await tracker.run('test', plain, root, pass)
    git('checkout', '-q', '--detach', 'HEAD~0')
    await tracker.run('test', plain, root, pass, 'fixer_reported')
    expect(ran).toEqual(['pytest', 'pytest'])
  })

  it('does not count a cached verdict as having touched the database', async () => {
    const { ran, tracker, pass } = recorder()
    git('checkout', '-q', '-b', 'integ-a')
    await commit('a.txt', 'a')
    await tracker.run('test', gate, root, pass)
    git('checkout', '-q', '-b', 'integ-b', 'main')
    await commit('b.txt', 'b')
    await tracker.run('test', gate, root, async (chosen) => ({ ...(await pass(chosen)), cached: true }))
    // The database still holds integ-a's state, so moving on from integ-b's
    // tip is still a move away from it.
    await commit('b2.txt', 'b2')
    await tracker.run('test', gate, root, pass)
    expect(ran).toEqual(['pytest --create-db', 'pytest --create-db', 'pytest --create-db'])
  })

  it('reads the usual stale-schema errors', async () => {
    const log = join(root, 'x.log')
    for (const line of [
      'column "min_registrations" of relation "events_event" does not exist',
      'null value in column "default_room_commission_percent" of relation "spaces_venue" violates not-null constraint',
      'sqlite3.OperationalError: no such column: venue.capacity',
    ]) {
      await writeFile(log, line)
      expect(await looksStale(log)).toBe(true)
    }
  })

  it('reads ENVIRONMENT_STALE alone on a line as the fixer’s verdict', () => {
    expect(fixVerdict('The columns belong to another branch.\n\nENVIRONMENT_STALE')).toBe('environment_stale')
    expect(fixVerdict('**ENVIRONMENT_STALE**')).toBe('environment_stale')
    expect(fixVerdict('I did not report ENVIRONMENT_STALE because it is a real bug.')).toBeNull()
    expect(fixVerdict(null)).toBeNull()
  })
})
