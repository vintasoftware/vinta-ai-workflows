/**
 * The host's sweep of the integration worktree on a resume: an unfinished
 * merge of this run's — the shape a pause, a stop or a kill leaves when it
 * lands mid-merge — is taken down before any phase needs the worktree, and
 * journalled. One somebody else left there is not touched.
 *
 * Built against a real pool in a temp repository, because the thing under
 * test is the wiring between `provision`, the integrator and the journal.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MockAdapter } from '../src/harness/mock.ts'
import { openJournal } from '../src/journal/journal.ts'
import { provision } from '../src/run/host.ts'
import { parseWorkflow } from '../src/validate.ts'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const midMerge = (cwd: string): boolean => {
  try {
    g(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')
    return true
  } catch {
    return false
  }
}

const RUN_ID = 'recovery-run'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-recovery-'))
  temps.push(root)
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  g(repo, 'config', 'user.email', 'fixture@example.invalid')
  g(repo, 'config', 'user.name', 'fixture')
  g(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  g(repo, 'add', '--all')
  g(repo, 'commit', '-m', 'base')
  // Two phase branches with nothing in common but the base.
  for (const id of ['a', 'b']) {
    g(repo, 'checkout', '-B', `plan/wf/phase-${id}`, 'main')
    writeFileSync(join(repo, `${id}.txt`), `${id}\n`)
    g(repo, 'add', '--all')
    g(repo, 'commit', '-m', `phase ${id}`)
  }
  g(repo, 'checkout', 'main')

  const parsed = parseWorkflow({
    schema_version: 1,
    id: 'wf',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus' },
    resources: { lane: { capacity: 1, kind: 'worktree' } },
    nodes: [
      { id: 'a', name: 'a', prompt_ref: 'plan.md#a' },
      { id: 'b', name: 'b', prompt_ref: 'plan.md#b' },
    ],
  })
  if (!parsed.ok) throw new Error('fixture workflow does not parse')
  const journal = openJournal(repo)
  journal.createRun(RUN_ID, parsed.workflow)
  const options = {
    workflow: parsed.workflow,
    runId: RUN_ID,
    journal,
    repoPath: repo,
    laneRoot: join(root, 'lanes'),
    adapters: { 'claude-code': new MockAdapter({ id: 'claude-code' }) },
    agentEnv: {},
    perLaneBytes: 0,
  }
  const integ = join(root, 'lanes', `${RUN_ID}-integ`)
  return { repo, journal, options, integ }
}

describe('a resume', () => {
  it('takes down an unfinished merge of its own and journals it', async () => {
    const rig = setup()
    const first = await provision(rig.options)
    first.close()
    // A stop landed half-way through building wave 1.
    g(rig.integ, 'checkout', '-B', 'plan/wf/wave-1', 'main')
    g(rig.integ, 'merge', '--no-ff', '--no-edit', 'plan/wf/phase-a')
    g(rig.integ, 'merge', '--no-ff', '--no-commit', 'plan/wf/phase-b')
    expect(midMerge(rig.integ)).toBe(true)

    const second = await provision({ ...rig.options, adopt: true })
    second.close()

    expect(midMerge(rig.integ)).toBe(false)
    expect(g(rig.integ, 'status', '--porcelain')).toBe('')
    const rows = rig.journal.events(RUN_ID).filter((event) => event.type === 'integration_reclaimed')
    expect(rows.map((row) => row.payload)).toEqual([
      { into: 'plan/wf/wave-1', incoming: 'plan/wf/phase-b', kept: 'refs/vinta-ai-maestro/abandoned/wave-1' },
    ])
    rig.journal.close()
  })

  it('leaves a merge it did not start where it is', async () => {
    const rig = setup()
    const first = await provision(rig.options)
    first.close()
    g(rig.integ, 'checkout', '-B', 'scratch', 'plan/wf/phase-a')
    g(rig.integ, 'merge', '--no-ff', '--no-commit', 'plan/wf/phase-b')

    const second = await provision({ ...rig.options, adopt: true })
    second.close()

    expect(midMerge(rig.integ)).toBe(true)
    expect(rig.journal.events(RUN_ID).some((event) => event.type === 'integration_reclaimed')).toBe(false)
    rig.journal.close()
  })
})
