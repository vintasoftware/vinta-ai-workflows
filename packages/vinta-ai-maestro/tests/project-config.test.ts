/**
 * The project's configuration under a plan: `.vinta-ai-workflows.yaml` parsed,
 * layered under the workflow file, and subtracted back out of an editor save.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ownDocument } from '../src/config/own.ts'
import { loadProjectConfig, parseProjectConfig, type ProjectConfig } from '../src/config/project-config.ts'
import { resolveDocument, resolveWorkflow } from '../src/config/resolve.ts'
import { isJudgeGate, type Gate, type Workflow } from '../src/types.ts'

const commandOf = (gate: Gate | undefined): string | undefined =>
  gate === undefined || isJudgeGate(gate) ? undefined : gate.cmd

/** The smallest plan that runs, with whatever the test overrides. */
function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'widgets',
    base_branch: 'main',
    defaults: { model: 'sonnet' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    nodes: [
      { id: 'p1', name: 'One', prompt_ref: 'plan.md#phase-1' },
      { id: 'p2', name: 'Two', prompt_ref: 'plan.md#phase-2', gates: [] },
    ],
    ...overrides,
  }
}

function resolved(authored: unknown, config: ProjectConfig | null): Workflow {
  const result = resolveWorkflow(authored, config)
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  return result.workflow
}

describe('resolving a plan over its project', () => {
  it('runs a plan with no configuration exactly as it did before', () => {
    const workflow = resolved(plan({ gates: { unit: { cmd: 'npm test' } } }), null)
    expect(commandOf(workflow.gates['unit'])).toBe('npm test')
    // The two run defaults a plan used to have to repeat.
    expect(workflow.defaults.harness).toBe('claude-code')
    expect(workflow.defaults.pipeline).toBe('standard-phase')
  })

  it('gives a typed gate the project’s command, and makes each type available by name', () => {
    const config = { commands: { test_unit: 'pnpm test', build: 'pnpm typecheck', lint: 'pnpm lint' } }
    const workflow = resolved(
      plan({ gates: { unit: { type: 'test', timeout_s: 600 } }, nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#phase-1', gates: ['typecheck', 'unit'] }] }),
      config,
    )
    expect(workflow.gates['unit']).toMatchObject({ type: 'test', cmd: 'pnpm test', timeout_s: 600 })
    expect(commandOf(workflow.gates['typecheck'])).toBe('pnpm typecheck')
    expect(commandOf(workflow.gates['lint'])).toBe('pnpm lint')
    // No `e2e` line, no `e2e` gate.
    expect(workflow.gates['e2e']).toBeUndefined()
  })

  it('layers maestro’s own gate settings over `commands`, and the plan over both', () => {
    const config: ProjectConfig = {
      commands: { test_unit: 'pytest' },
      maestro: {
        gates: { test: { cmd: 'pytest --reuse-db', requires: ['test-suite'], timeout_s: 1200 } },
        resources: { 'test-suite': { capacity: 1, kind: 'semaphore' } },
      },
    }
    const inherited = resolved(plan({ nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#phase-1', gates: ['test'] }] }), config)
    expect(inherited.gates['test']).toMatchObject({ cmd: 'pytest --reuse-db', requires: ['test-suite'], timeout_s: 1200 })
    expect(inherited.resources['test-suite']).toEqual({ capacity: 1, kind: 'semaphore' })

    const overridden = resolved(plan({ gates: { test: { type: 'test', cmd: 'pytest -x' } } }), config)
    // Field by field: the plan's command, the project's pool and timeout.
    expect(overridden.gates['test']).toMatchObject({ cmd: 'pytest -x', requires: ['test-suite'], timeout_s: 1200 })
  })

  it('replaces a pool, a chore or an untyped gate whole rather than merging into it', () => {
    const config: ProjectConfig = {
      commands: { test_unit: 'pytest' },
      maestro: { resources: { 'test-suite': { capacity: 1, kind: 'semaphore', match: ['pytest*'] } } },
    }
    const workflow = resolved(
      plan({
        resources: { lane: { capacity: 2, kind: 'worktree' }, 'test-suite': { capacity: 2, kind: 'semaphore' } },
        gates: { test: { cmd: 'make test' } },
      }),
      config,
    )
    expect(workflow.resources['test-suite']).toEqual({ capacity: 2, kind: 'semaphore' })
    expect(workflow.gates['test']).toEqual({ cmd: 'make test', requires: [], timeout_s: 1800 })
  })

  it('inherits a scoped command only when it says how it is scoped', () => {
    const fixed = resolved(plan(), { commands: { test_unit: 'pnpm test', test_unit_scoped: 'pnpm test:patient' } })
    expect(fixed.gates['test']).not.toHaveProperty('scoped_cmd')

    const templated = resolved(plan(), {
      commands: { test_unit: 'pnpm test', test_unit_scoped: 'pnpm vitest related {changed_files} --run' },
    })
    expect(templated.gates['test']).toMatchObject({ scoped_cmd: 'pnpm vitest related {changed_files} --run' })
  })

  it('fills `defaults.gates` into the nodes that name none, and leaves an explicit list alone', () => {
    const workflow = resolved(plan({ defaults: { model: 'sonnet', gates: ['typecheck', 'test'] } }), {
      commands: { test_unit: 'pnpm test', build: 'pnpm build' },
    })
    expect(workflow.nodes.find((node) => node.id === 'p1')?.gates).toEqual(['typecheck', 'test'])
    // p2 says `[]`, which is an opt-out, not an omission.
    expect(workflow.nodes.find((node) => node.id === 'p2')?.gates).toEqual([])
  })

  it('takes the base branch from the project when the plan names none, and run defaults from maestro', () => {
    const { base_branch: _omitted, ...rest } = plan()
    const workflow = resolved(rest, {
      project: { default_branch: 'develop' },
      maestro: { defaults: { harness: 'codex', gate_scope: 'full', chores: [] } },
    })
    expect(workflow.base_branch).toBe('develop')
    expect(workflow.defaults.harness).toBe('codex')
    expect(workflow.defaults.gate_scope).toBe('full')
    // The plan's own `model` survives the merge.
    expect(workflow.defaults.model).toBe('sonnet')
  })

  it('carries the project’s commands into `project.commands` when there is a project block', () => {
    const config: ProjectConfig = {
      commands: { test_unit: 'pytest', build: 'mypy .', lint: 'ruff check' },
      maestro: { project: { migrate_cmd: 'python manage.py migrate' } },
    }
    const workflow = resolved(plan({ project: { commands: { test: 'pytest -q' } } }), config)
    expect(workflow.project?.migrate_cmd).toBe('python manage.py migrate')
    expect(workflow.project?.commands).toEqual({ test: 'pytest -q', typecheck: 'mypy .', lint: 'ruff check' })
  })

  it('says what to set when a typed gate gets no command from anywhere', () => {
    const result = resolveWorkflow(plan({ gates: { e2e: { type: 'e2e' } } }), { commands: { test_unit: 'x' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([
      {
        path: ['gates', 'e2e', 'cmd'],
        message: expect.stringContaining('`commands.e2e` in .vinta-ai-workflows.yaml'),
      },
    ])
  })

  it('reports an unknown pool a project gate requires against the resolved document', () => {
    const result = resolveWorkflow(plan(), { commands: { test_unit: 'x' }, maestro: { gates: { test: { requires: ['nope'] } } } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]).toMatchObject({ path: ['gates', 'test', 'requires', 0] })
  })

  it('leaves a document it cannot merge for the parser to report where it was written', () => {
    expect(resolveDocument('not a workflow', { commands: { test_unit: 'x' } })).toBe('not a workflow')
  })
})

describe('reading .vinta-ai-workflows.yaml', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('treats a missing or empty file as a project with no configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-config-'))
    dirs.push(dir)
    expect(await loadProjectConfig(dir)).toEqual({ ok: true, config: null })
    writeFileSync(join(dir, '.vinta-ai-workflows.yaml'), '')
    expect(await loadProjectConfig(dir)).toEqual({ ok: true, config: null })
  })

  it('passes the rest of the file through and validates only what maestro reads', () => {
    const result = parseProjectConfig(
      'schema_version: 1\npolicies: { pr_creation: agents-create }\ncommands:\n  test_unit: pytest\n',
    )
    expect(result.ok).toBe(true)
  })

  it('accepts the config schema’s own fixture, and resolves a bare plan over it', () => {
    // The JSON Schema at the repo root and the zod schema here describe the
    // same section; this is the payload the first is proven against.
    const text = readFileSync(
      join(import.meta.dirname, '../../../tests/schema-fixtures/vinta-ai-workflows-config.v1/valid/maestro-defaults.yaml'),
      'utf8',
    )
    const parsed = parseProjectConfig(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const { base_branch: _omitted, ...bare } = plan({ nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#phase-1' }] })
    const workflow = resolved(bare, parsed.config)
    expect(workflow.base_branch).toBe('main')
    expect(workflow.nodes[0]?.gates).toEqual(['typecheck', 'lint', 'test'])
    expect(workflow.gates['test']).toMatchObject({
      cmd: 'uv run pytest --reuse-db -n auto',
      scoped_cmd: 'uv run pytest --testmon {changed_files}',
      requires: ['test-suite'],
    })
    expect(workflow.gates['lint']).toMatchObject({ cmd: 'uv run ruff check', scoped_cmd: 'uv run ruff check {changed_files}' })
    expect(workflow.project?.commands).toMatchObject({ test: 'uv run pytest', typecheck: 'uv run mypy .' })
    expect(workflow.defaults.model_fallbacks).toEqual({ 'claude-fable-5-1': 'claude-opus-5-5' })
  })

  it('locates a bad `maestro` value and never quotes the file', () => {
    const bad = parseProjectConfig('maestro:\n  gates:\n    test:\n      timeout_s: soon\n')
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.issues[0]?.path).toEqual(['maestro', 'gates', 'test', 'timeout_s'])

    const broken = parseProjectConfig('maestro:\n  gates: [secret-token\n')
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.issues[0]?.message).toMatch(/^\.vinta-ai-workflows\.yaml is not valid YAML/)
    expect(JSON.stringify(broken.issues)).not.toContain('secret-token')
  })
})

describe('what an editor save writes', () => {
  const config: ProjectConfig = {
    commands: { test_unit: 'pnpm test', build: 'pnpm build' },
    maestro: { resources: { 'test-suite': { capacity: 1, kind: 'semaphore' } } },
  }

  it('writes nothing new when nothing was edited, however much the editor displayed', () => {
    const stored = plan({ defaults: { model: 'sonnet', gates: ['test'] } })
    const shown = resolved(stored, config)
    expect(ownDocument(shown, stored, config)).toEqual(stored)
  })

  it('writes the one field that changed, and a typed gate as its type plus the override', () => {
    const stored = plan()
    const shown = resolved(stored, config)
    const edited = structuredClone(shown)
    ;(edited.gates['test'] as { timeout_s: number }).timeout_s = 99
    edited.nodes[0] = { ...edited.nodes[0]!, name: 'Renamed' }

    const own = ownDocument(edited, stored, config) as Record<string, any>
    expect(own.gates).toEqual({ test: { type: 'test', timeout_s: 99 } })
    expect(own.nodes[0]).toEqual({ id: 'p1', name: 'Renamed', prompt_ref: 'plan.md#phase-1' })
    // The project's pool stayed the project's.
    expect(own.resources).toEqual({ lane: { capacity: 2, kind: 'worktree' } })
    // And the result resolves to what the editor showed.
    expect(resolved(own, config)).toEqual(resolved(edited, null))
  })

  it('copies a whole pool into the plan when one of its fields is edited', () => {
    const stored = plan()
    const edited = structuredClone(resolved(stored, config))
    ;(edited.resources['test-suite'] as { capacity: number }).capacity = 3
    const own = ownDocument(edited, stored, config) as Record<string, any>
    expect(own.resources['test-suite']).toEqual({ capacity: 3, kind: 'semaphore' })
  })
})
