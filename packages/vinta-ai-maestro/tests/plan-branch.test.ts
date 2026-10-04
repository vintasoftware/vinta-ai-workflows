/**
 * The plan branch, and the run following it: `ensurePlanBranch`, the config
 * reload a commit on it triggers, and the scoped gate line rendered from a
 * lane's changes.
 *
 * Every repository is created under `tmpdir()` and removed afterwards. Nothing
 * here runs git against the checkout the suite lives in.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AmendRunner } from '../src/amend/amend.ts'
import { amendRun } from '../src/amend/amend.ts'
import { startConfigReloader } from '../src/config/reload.ts'
import { resolveWorkflow } from '../src/config/resolve.ts'
import { changedFiles, phaseGate } from '../src/gates/scope.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import { ensurePlanBranch, planBranchName } from '../src/run/plan-branch.ts'
import { readSources, writeSources, type RunSources } from '../src/run/sources.ts'
import { isJudgeGate, type CommandGate, type Workflow } from '../src/types.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function repo(): string {
  const dir = temp('maestro-plan-branch-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  commit(dir, { 'README.md': 'base\n' }, 'base')
  return dir
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

describe('ensurePlanBranch', () => {
  it('cuts the branch from the base, and reuses one that already contains it', async () => {
    const dir = repo()
    const created = await ensurePlanBranch(dir, 'wf', 'main')
    expect(created).toMatchObject({ ok: true, branch: 'plan/wf/base', created: true })
    expect(git(dir, 'rev-parse', 'plan/wf/base')).toBe(git(dir, 'rev-parse', 'main'))

    // A config change prepared on the branch before the run is kept.
    git(dir, 'checkout', '-q', 'plan/wf/base')
    const prepared = commit(dir, { '.vinta-ai-workflows.yaml': 'commands: {}\n' }, 'prepare')
    git(dir, 'checkout', '-q', 'main')
    expect(await ensurePlanBranch(dir, 'wf', 'main')).toMatchObject({ ok: true, head: prepared, created: false })
  })

  it('moves a branch that is merely behind, unless somebody has it checked out', async () => {
    const dir = repo()
    await ensurePlanBranch(dir, 'wf', 'main')
    const ahead = commit(dir, { 'b.txt': 'b\n' }, 'main moved')
    expect(await ensurePlanBranch(dir, 'wf', 'main')).toMatchObject({ ok: true, head: ahead })

    commit(dir, { 'c.txt': 'c\n' }, 'main moved again')
    git(dir, 'checkout', '-q', 'plan/wf/base')
    const refused = await ensurePlanBranch(dir, 'wf', 'main')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('checked out')
  })

  it('refuses a branch that diverged, and lets a resume keep it', async () => {
    const dir = repo()
    await ensurePlanBranch(dir, 'wf', 'main')
    git(dir, 'checkout', '-q', 'plan/wf/base')
    commit(dir, { 'p.txt': 'p\n' }, 'on the plan branch')
    git(dir, 'checkout', '-q', 'main')
    commit(dir, { 'm.txt': 'm\n' }, 'on main')

    const refused = await ensurePlanBranch(dir, 'wf', 'main')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('diverged')
    expect(await ensurePlanBranch(dir, 'wf', 'main', { resume: true })).toMatchObject({ ok: true })
  })

  it('is named beside the run’s branches, not above them', () => {
    expect(planBranchName('wf')).toBe('plan/wf/base')
  })
})

// ---------------------------------------------------------------------------
// The reload
// ---------------------------------------------------------------------------

const PLAN_PATH = 'ai-plans/wf.workflow.json'

const authored = {
  schema_version: 1,
  id: 'wf',
  base_branch: 'main',
  defaults: { model: 'sonnet', pipeline: 'solo' },
  resources: { lane: { capacity: 2, kind: 'worktree' } },
  nodes: [
    { id: 'a', name: 'A', prompt_ref: 'plan.md#a', gates: ['test'] },
    { id: 'b', name: 'B', prompt_ref: 'plan.md#b', gates: ['test'] },
  ],
  pipelines: {
    solo: {
      states: [
        { id: 'work', name: 'Work', position: { x: 0, y: 0 } },
        { id: 'done', name: 'Done', position: { x: 1, y: 0 } },
      ],
      transitions: [{ id: 't', from: 'work', to: 'done' }],
      initialStateIds: ['work'],
      finalStateIds: ['done'],
    },
  },
}

interface Rig {
  readonly dir: string
  readonly journal: Journal
  readonly runner: AmendRunner
  current(): Workflow
  sources(): RunSources | null
}

async function reloadRig(): Promise<Rig> {
  const dir = repo()
  commit(
    dir,
    {
      '.vinta-ai-workflows.yaml': 'commands:\n  test_unit: npm test\n',
      [PLAN_PATH]: `${JSON.stringify(authored, null, 2)}\n`,
    },
    'plan',
  )
  const ensured = await ensurePlanBranch(dir, 'wf', 'main')
  if (!ensured.ok) throw new Error(ensured.message)

  const config = { commands: { test_unit: 'npm test' } }
  const resolved = resolveWorkflow(authored, config)
  if (!resolved.ok) throw new Error('fixture does not resolve')

  const journal = openJournal(temp('maestro-reload-store-'))
  cleanups.push(() => journal.close())
  journal.createRun('run-1', resolved.workflow)
  writeSources(journal, 'run-1', {
    workflow_path: PLAN_PATH,
    plan_branch: ensured.branch,
    head: ensured.head,
    authored,
    config,
  })

  let current = resolved.workflow
  const runner: AmendRunner = {
    adopt: (amended) => {
      current = amended
    },
  }
  return { dir, journal, runner, current: () => current, sources: () => readSources(journal, 'run-1') }
}

function reloader(rig: Rig) {
  const sources = rig.sources()
  if (sources === null) throw new Error('no sources')
  const loop = startConfigReloader({
    repoPath: rig.dir,
    journal: rig.journal,
    runId: 'run-1',
    sources,
    workflow: rig.current,
    runner: rig.runner,
    tickMs: 3_600_000,
  })
  cleanups.push(() => loop.stop())
  return loop
}

/** Commits on the plan branch, from a worktree of it — the way a person would. */
function commitOnPlanBranch(rig: Rig, files: Record<string, string>, message: string): string {
  const wt = join(temp('maestro-plan-wt-'), 'wt')
  git(rig.dir, 'worktree', 'add', '-q', wt, 'plan/wf/base')
  cleanups.push(() => git(rig.dir, 'worktree', 'remove', '--force', wt))
  return commit(wt, files, message)
}

const commandOf = (workflow: Workflow, id: string) => {
  const gate = workflow.gates[id]
  return gate === undefined || isJudgeGate(gate) ? undefined : gate.cmd
}

describe('a commit on the plan branch', () => {
  it('reaches the run as a `config` amendment naming the commit', async () => {
    const rig = await reloadRig()
    const loop = reloader(rig)
    expect(await loop.tick()).toEqual({ kind: 'unchanged' })

    const sha = commitOnPlanBranch(rig, { '.vinta-ai-workflows.yaml': 'commands:\n  test_unit: npm test -- --runInBand\n' }, 'tune')
    expect(await loop.tick()).toMatchObject({ kind: 'applied', head: sha })
    expect(commandOf(rig.current(), 'test')).toBe('npm test -- --runInBand')

    const row = rig.journal.events('run-1').find((event) => event.type === 'workflow_amended')
    expect(row?.payload).toMatchObject({ author: 'config', source: sha, targets: ['gate:test'] })
    // The sources moved with it, so a resume starts from here.
    expect(rig.sources()?.head).toBe(sha)
  })

  it('passes over a commit that touched neither file', async () => {
    const rig = await reloadRig()
    const loop = reloader(rig)
    const sha = commitOnPlanBranch(rig, { 'src/x.ts': 'x\n' }, 'unrelated')
    expect(await loop.tick()).toEqual({ kind: 'irrelevant', head: sha })
    expect(rig.journal.events('run-1').some((event) => event.type === 'workflow_amended')).toBe(false)
  })

  it('reads the plan’s own file at the commit too', async () => {
    const rig = await reloadRig()
    const loop = reloader(rig)
    const edited = { ...authored, nodes: [authored.nodes[0], { ...authored.nodes[1], name: 'B, renamed' }] }
    commitOnPlanBranch(rig, { [PLAN_PATH]: JSON.stringify(edited) }, 'rename b')
    expect(await loop.tick()).toMatchObject({ kind: 'applied' })
    expect(rig.current().nodes.find((node) => node.id === 'b')?.name).toBe('B, renamed')
  })

  it('leaves alone what a person changed in this run, and a node that has started', async () => {
    const rig = await reloadRig()
    // An operator retunes `test` mid-run, and `a` starts.
    const retuned = structuredClone(rig.current())
    ;(retuned.gates['test'] as CommandGate).cmd = 'npm test -- --bail'
    const amended = await amendRun({ journal: rig.journal, runId: 'run-1', proposed: retuned, runner: rig.runner })
    expect(amended.ok).toBe(true)
    rig.journal.append({ runId: 'run-1', nodeId: 'a', type: 'node_status', payload: { status: 'running' } })

    const loop = reloader(rig)
    const edited = {
      ...authored,
      nodes: authored.nodes.map((node) => ({ ...node, name: `${node.name}!` })),
    }
    commitOnPlanBranch(
      rig,
      { '.vinta-ai-workflows.yaml': 'commands:\n  test_unit: npm test -- --ci\n', [PLAN_PATH]: JSON.stringify(edited) },
      'both',
    )
    expect(await loop.tick()).toMatchObject({ kind: 'applied' })
    expect(commandOf(rig.current(), 'test')).toBe('npm test -- --bail')
    expect(rig.current().nodes.find((node) => node.id === 'a')?.name).toBe('A')
    expect(rig.current().nodes.find((node) => node.id === 'b')?.name).toBe('B!')
  })

  it('journals a configuration it cannot read and moves past it', async () => {
    const rig = await reloadRig()
    const loop = reloader(rig)
    const sha = commitOnPlanBranch(rig, { '.vinta-ai-workflows.yaml': 'maestro:\n  gates: [oops\n' }, 'broken')
    expect(await loop.tick()).toEqual({ kind: 'refused', head: sha, code: 'invalid_config' })
    const row = rig.journal.events('run-1').find((event) => event.type === 'config_reload')
    expect(row?.payload).toMatchObject({ source: sha, outcome: 'refused', code: 'invalid_config' })
    expect(await loop.tick()).toEqual({ kind: 'unchanged' })
  })
})

// ---------------------------------------------------------------------------
// Scoped gates
// ---------------------------------------------------------------------------

describe('the scoped gate line', () => {
  const gate: CommandGate = {
    cmd: 'npx vitest run',
    scoped_cmd: 'npx vitest related {changed_files} --run',
    requires: [],
    timeout_s: 60,
  }

  it('names what the lane changed against its base — committed, unstaged, untracked — minus deletions', async () => {
    const dir = repo()
    commit(dir, { 'gone.ts': 'x\n' }, 'to delete')
    git(dir, 'checkout', '-q', '-b', 'phase')
    commit(dir, { 'src/a.ts': 'a\n' }, 'committed')
    writeFileSync(join(dir, 'README.md'), 'edited\n')
    writeFileSync(join(dir, 'new file.ts'), 'n\n')
    rmSync(join(dir, 'gone.ts'))

    const context = { lanePath: dir, base: 'main', touches: ['src/'] }
    expect((await changedFiles(context)).sort()).toEqual(['README.md', 'new file.ts', 'src/a.ts'])

    const scoped = await phaseGate(gate, 'scoped', context)
    expect(scoped.cmd).toMatch(/^npx vitest related .* --run$/)
    expect(scoped.cmd).toContain("'new file.ts'")
    expect((await phaseGate(gate, 'full', context)).cmd).toBe('npx vitest run')
  })

  it('runs the full command when there is nothing to scope to', async () => {
    const dir = repo()
    expect((await phaseGate(gate, 'scoped', { lanePath: dir, base: 'main', touches: [] })).cmd).toBe('npx vitest run')
    const touches = { ...gate, scoped_cmd: 'npx vitest related {touches} --run' }
    expect((await phaseGate(touches, 'scoped', { lanePath: dir, base: 'main', touches: ['src/a.ts'] })).cmd).toBe(
      "npx vitest related 'src/a.ts' --run",
    )
  })
})
