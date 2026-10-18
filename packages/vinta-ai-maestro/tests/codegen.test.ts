/**
 * Codegen steps and append-only files, against real git repositories in temp
 * directories: the runner and its skip cache, the commit and its hook retry,
 * and the integrator settling a generated-file conflict, regenerating a clean
 * merge, and union-merging a registry — none of which reaches a fixer.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodegenCache,
  codegenOrder,
  commitOutputs,
  runCodegen,
  type CodegenSteps,
} from '../src/codegen/codegen.ts'
import { probeCodegen } from '../src/codegen/determinism.ts'
import { createIntegrationCodegen } from '../src/codegen/integration.ts'
import type { ConflictRequest } from '../src/integration/fixer.ts'
import { Integrator, type IntegrationNode, type ReportedConflict } from '../src/integration/integrator.ts'
import { composeConflictPrompt } from '../src/prompts/index.ts'
import { CodegenStepSchema, type Workflow } from '../src/types.ts'
import { formatIssues, parseWorkflow } from '../src/validate.ts'
import { resolveWorkflow } from '../src/config/resolve.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const step = (fields: Record<string, unknown>) => CodegenStepSchema.parse(fields)

/** `gen.txt` is every `in/*.txt`, concatenated in name order: deterministic and a function of its inputs. */
const GENERATE = step({ cmd: 'cat in/*.txt > gen.txt', inputs: ['in/**'], outputs: ['gen.txt'] })

async function makeRepo(files: Readonly<Record<string, string>>): Promise<{ root: string; main: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-codegen-'))
  roots.push(root)
  const main = join(root, 'repo')
  await mkdir(main, { recursive: true })
  run(main, 'init', '-b', 'main')
  run(main, 'config', 'user.email', 'fixture@example.invalid')
  run(main, 'config', 'user.name', 'fixture')
  run(main, 'config', 'commit.gpgsign', 'false')
  await commit(main, { 'README.md': 'fixture\n', ...files }, 'base')
  return { root, main }
}

async function commit(cwd: string, files: Readonly<Record<string, string>>, message: string): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), body)
  }
  run(cwd, 'add', '--all')
  run(cwd, 'commit', '-m', message)
}

const logs = (root: string) => (id: string) => join(root, `codegen-${id}.log`)

describe('codegen order', () => {
  const steps: CodegenSteps = {
    client: step({ cmd: 'x', outputs: ['c'], after: ['schema'] }),
    lint: step({ cmd: 'x {changed_files}', outputs: ['**'], format: true, after: ['client'] }),
    schema: step({ cmd: 'x', outputs: ['s'] }),
    routes: step({ cmd: 'x', outputs: ['r'] }),
  }

  it('runs a step after the steps it names, ties in declaration order', () => {
    expect(codegenOrder(steps)).toEqual(['schema', 'client', 'lint', 'routes'])
  })

  it('narrows to a step and what it comes after', () => {
    expect(codegenOrder(steps, ['client'])).toEqual(['schema', 'client'])
  })
})

describe('codegen validation', () => {
  const golden = (): Record<string, any> =>
    JSON.parse(readFileSync(join(HERE, 'fixtures', 'golden-workflow.json'), 'utf8'))

  const issues = (codegen: Record<string, unknown>): string => {
    const result = parseWorkflow({ ...golden(), codegen })
    return result.ok ? '' : formatIssues(result.issues)
  }

  it('accepts a declared chain and append-only files', () => {
    const result = parseWorkflow({
      ...golden(),
      codegen: {
        schema: { cmd: 'make schema', inputs: ['api/**'], outputs: ['schema.yml'] },
        client: { cmd: 'make client', outputs: ['client/**'], after: ['schema'], requires: ['test-suite'] },
      },
      append_only: ['app/containers.py'],
    })
    expect(result.ok).toBe(true)
  })

  it('takes codegen steps and append-only files from the project config, the plan winning per id', () => {
    const result = resolveWorkflow(
      { ...golden(), codegen: { schema: { cmd: 'plan schema', outputs: ['schema.yml'] } } },
      {
        maestro: {
          codegen: {
            schema: { cmd: 'project schema', outputs: ['schema.yml'] },
            routes: { cmd: 'project routes', outputs: ['routeTree.gen.ts'] },
          },
          append_only: ['app/containers.py'],
        },
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workflow.codegen['schema']?.cmd).toBe('plan schema')
    expect(result.workflow.codegen['routes']?.cmd).toBe('project routes')
    expect(result.workflow.append_only).toEqual(['app/containers.py'])
  })

  it('refuses an unknown step, a cycle, a missing pool, the lane, and a formatter with no files', () => {
    expect(issues({ a: { cmd: 'x', outputs: ['a'], after: ['nope'] } })).toMatch(/unknown codegen step "nope"/)
    expect(
      issues({ a: { cmd: 'x', outputs: ['a'], after: ['b'] }, b: { cmd: 'x', outputs: ['b'], after: ['a'] } }),
    ).toMatch(/codegen cycle/)
    expect(issues({ a: { cmd: 'x', outputs: ['a'], requires: ['nope'] } })).toMatch(/unknown resource pool "nope"/)
    expect(issues({ a: { cmd: 'x', outputs: ['a'], requires: ['lane'] } })).toMatch(/cannot require `lane`/)
    expect(issues({ a: { cmd: 'prettier --write .', outputs: ['**'], format: true } })).toMatch(
      /must take `\{changed_files\}`/,
    )
  })
})

describe('running codegen steps', () => {
  it('writes the outputs, and skips a step whose inputs and outputs match a recorded run', async () => {
    const { root, main } = await makeRepo({ 'in/a.txt': 'a\n', 'gen.txt': 'stale\n' })
    const cache = new CodegenCache(join(root, 'cache.json'))
    const options = { steps: { gen: GENERATE }, cwd: main, env: {}, logPath: logs(root), cache }

    const first = await runCodegen(options)
    expect(first.failed).toBeNull()
    expect(first.changed).toEqual(['gen.txt'])
    expect(await readFile(join(main, 'gen.txt'), 'utf8')).toBe('a\n')

    const again = await runCodegen(options)
    expect(again.runs.map((r) => r.skipped)).toEqual(['cached'])

    // A hand edit to the output is not what the step wrote: it runs.
    await writeFile(join(main, 'gen.txt'), 'hand edit\n')
    expect((await runCodegen(options)).runs.map((r) => r.status)).toEqual(['passed'])
    expect(await readFile(join(main, 'gen.txt'), 'utf8')).toBe('a\n')

    // So does a change to an input.
    await writeFile(join(main, 'in/b.txt'), 'b\n')
    expect((await runCodegen(options)).runs.map((r) => r.status)).toEqual(['passed'])
    expect(await readFile(join(main, 'gen.txt'), 'utf8')).toBe('a\nb\n')
  })

  it('stops at a failing step and names it', async () => {
    const { root, main } = await makeRepo({})
    const outcome = await runCodegen({
      steps: {
        broken: step({ cmd: 'echo nope >&2; exit 3', outputs: ['x'] }),
        later: step({ cmd: 'touch y', outputs: ['y'], after: ['broken'] }),
      },
      cwd: main,
      env: {},
      logPath: logs(root),
    })
    expect(outcome.failed).toMatchObject({ id: 'broken', status: 'failed', exitCode: 3 })
    expect(outcome.runs.map((r) => r.id)).toEqual(['broken'])
    expect(readFileSync(logs(root)('broken'), 'utf8')).toContain('nope')
  })

  it('hands a formatter only the changed files its outputs match, and skips it with none', async () => {
    const { root, main } = await makeRepo({ 'a.py': 'a\n', 'b.py': 'b\n', 'c.ts': 'c\n' })
    const format = step({ cmd: 'for f in {changed_files}; do echo formatted >> "$f"; done', outputs: ['**/*.py'], format: true })
    const outcome = await runCodegen({
      steps: { format },
      cwd: main,
      env: {},
      logPath: logs(root),
      changedFiles: async () => ['b.py', 'c.ts'],
    })
    expect(outcome.changed).toEqual(['b.py'])
    expect(await readFile(join(main, 'a.py'), 'utf8')).toBe('a\n')

    const none = await runCodegen({ steps: { format }, cwd: main, env: {}, logPath: logs(root), changedFiles: async () => ['c.ts'] })
    expect(none.runs.map((r) => r.skipped)).toEqual(['no_files'])
  })

  it('flags a step that writes different outputs from the same inputs', async () => {
    const { root, main } = await makeRepo({ 'in/a.txt': 'a\n' })
    const random = step({
      cmd: `node -e "require('fs').writeFileSync('gen.txt', String(Math.random()))"`,
      inputs: ['in/**'],
      outputs: ['gen.txt'],
    })
    const options = { steps: { random }, cwd: main, env: {}, logPath: logs(root), cache: new CodegenCache() }
    expect((await runCodegen(options)).runs[0]?.nondeterministic).toBeUndefined()
    expect((await runCodegen({ ...options, force: true })).runs[0]?.nondeterministic).toBe(true)
  })
})

describe('committing codegen outputs', () => {
  it('commits only the outputs, leaving other staged work staged', async () => {
    const { main } = await makeRepo({ 'gen.txt': 'old\n', 'mine.txt': 'mine\n' })
    await writeFile(join(main, 'gen.txt'), 'new\n')
    await writeFile(join(main, 'mine.txt'), 'edited\n')
    run(main, 'add', 'mine.txt')

    expect(await commitOutputs(main, ['gen.txt'], 'chore(codegen): regenerate gen')).toBe(true)
    expect(run(main, 'show', '--name-only', '--format=%s', 'HEAD')).toBe('chore(codegen): regenerate gen\n\ngen.txt')
    expect(run(main, 'diff', '--cached', '--name-only')).toBe('mine.txt')
    expect(await commitOutputs(main, ['gen.txt'], 'nothing')).toBe(false)
  })

  it('stages what a hook rewrote and commits once more', async () => {
    const { main } = await makeRepo({ 'gen.txt': 'old\n' })
    const hook = join(main, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\ngrep -q hooked gen.txt && exit 0\necho hooked >> gen.txt\nexit 1\n')
    chmodSync(hook, 0o755)
    await writeFile(join(main, 'gen.txt'), 'new\n')

    await commitOutputs(main, ['gen.txt'], 'chore(codegen): regenerate gen')
    expect(run(main, 'show', 'HEAD:gen.txt')).toBe('new\nhooked')
  })
})

describe('codegen in integration', () => {
  const node = (id: string, deps: readonly string[] = []): IntegrationNode => ({
    id,
    name: `Phase ${id}`,
    prompt_ref: `plan.md#phase-${id}`,
    depends_on: deps.map((dep) => ({ node: dep, artifact: 'artifact' })),
  })

  async function setup(
    base: Readonly<Record<string, string>>,
    a: Readonly<Record<string, string>>,
    b: Readonly<Record<string, string>>,
    workflow: Pick<Workflow, 'codegen' | 'append_only'>,
    resolve?: (cwd: string) => Promise<void>,
    hook?: string,
  ) {
    const { root, main } = await makeRepo(base)
    const integ = join(root, 'integ')
    run(main, 'worktree', 'add', '--detach', integ, 'main')
    const fixes: ConflictRequest[] = []
    const asked: string[] = []
    const conflicts: ReportedConflict[] = []
    const integrator = new Integrator({
      onConflict: (conflict) => conflicts.push(conflict),
      plan: { id: 'wf', base_branch: 'main', nodes: [node('a'), node('b'), node('c', ['a', 'b'])] },
      integrationPath: integ,
      fixer: {
        async fix(request) {
          fixes.push(request)
          await resolve?.(request.cwd)
        },
      },
      onCommitFailure: async (failure) => {
        asked.push(failure.incoming)
        return 'abort'
      },
      codegen: createIntegrationCodegen({
        workflow: () => workflow as Workflow,
        env: {},
        logPath: logs(root),
        attributesFile: join(root, 'merge-attributes'),
      }),
    })
    for (const [id, files] of [['a', a], ['b', b]] as const) {
      const lane = join(root, `lane-${id}`)
      run(main, 'worktree', 'add', '--detach', lane, 'main')
      await integrator.startNode(id, lane)
      await commit(lane, files, `phase ${id}`)
    }
    if (hook !== undefined) {
      const path = join(main, '.git', 'hooks', 'pre-commit')
      await writeFile(path, hook)
      chmodSync(path, 0o755)
    }
    return { integ, integrator, fixes, asked, conflicts }
  }

  it('settles a conflict confined to generated files by regenerating them, with no fixer', async () => {
    const { integ, integrator, fixes } = await setup(
      { 'in/base.txt': 'base\n', 'gen.txt': 'base\n' },
      { 'in/x-a.txt': 'a\n', 'gen.txt': 'base\na\n' },
      { 'in/y-b.txt': 'b\n', 'gen.txt': 'base\nb\n' },
      { codegen: { gen: GENERATE }, append_only: [] },
    )
    await integrator.prepareBase('c')
    expect(fixes).toHaveLength(0)
    expect(run(integ, 'show', 'plan/wf/integ-c:gen.txt')).toBe('base\na\nb')
    expect(run(integ, 'status', '--porcelain')).toBe('')
  })

  it('regenerates a clean merge whose generated files are stale, in a commit of its own', async () => {
    const { integ, integrator } = await setup(
      { 'in/base.txt': 'base\n', 'gen.txt': 'base\n' },
      // Phase a forgot to regenerate.
      { 'in/x-a.txt': 'a\n' },
      { 'other.txt': 'b\n' },
      { codegen: { gen: GENERATE }, append_only: [] },
    )
    await integrator.prepareBase('c')
    expect(run(integ, 'show', 'plan/wf/integ-c:gen.txt')).toBe('base\na')
    expect(run(integ, 'log', '--format=%s', 'plan/wf/integ-c')).toMatch(/chore\(codegen\): regenerate outputs after merging plan\/wf\/phase-/)
  })

  it('commits a resolution once more after a hook rewrote it, without asking anyone', async () => {
    const { integ, integrator, asked } = await setup(
      { 'app.txt': 'one\n' },
      { 'app.txt': 'one\ntwo\n' },
      { 'app.txt': 'one\nthree\n' },
      { codegen: {}, append_only: [] },
      async (cwd) => writeFile(join(cwd, 'app.txt'), 'one\ntwo\nthree\n'),
      // A formatter: rewrites what it was handed and fails the commit for it.
      '#!/bin/sh\ngrep -q formatted app.txt && exit 0\necho formatted >> app.txt\nexit 1\n',
    )
    await integrator.prepareBase('c')
    expect(asked).toEqual([])
    expect(run(integ, 'show', 'plan/wf/integ-c:app.txt')).toBe('one\ntwo\nthree\nformatted')
  })

  it('tells a conflict fixer which files are generated', () => {
    const prompt = composeConflictPrompt({
      into: 'x',
      incoming: 'y',
      nodes: ['a'],
      paths: ['app.ts'],
      promptRefs: [],
      generated: ['schema.yml'],
    })
    expect(prompt).toContain('Generated files (schema.yml) are not yours to edit')
  })

  it('merges an append-only file with the union driver, with no fixer', async () => {
    const { integ, integrator, fixes, conflicts } = await setup(
      { 'registry.txt': 'one\n' },
      { 'registry.txt': 'one\ntwo\n' },
      { 'registry.txt': 'one\nthree\n' },
      { codegen: {}, append_only: ['registry.txt'] },
    )
    await integrator.prepareBase('c')
    expect(fixes).toHaveLength(0)
    expect(run(integ, 'show', 'plan/wf/integ-c:registry.txt').split('\n').sort()).toEqual(['one', 'three', 'two'])
    // Two appends: nothing was deleted, so nothing was reverted and nothing is reported.
    expect(conflicts).toEqual([])
  })

  it('flags a line the union driver re-added after one phase deleted it', async () => {
    const { integ, integrator, fixes, conflicts } = await setup(
      { 'registry.txt': 'alpha\nunused\nomega\n' },
      // Phase a replaces the unused kind; phase b appends right after it.
      { 'registry.txt': 'alpha\nbeta\nomega\n' },
      { 'registry.txt': 'alpha\nunused\ngamma\nomega\n' },
      { codegen: {}, append_only: ['registry.txt'] },
    )
    await integrator.prepareBase('c')
    expect(fixes).toHaveLength(0)
    expect(run(integ, 'show', 'plan/wf/integ-c:registry.txt')).toContain('unused')
    expect(conflicts).toEqual([
      {
        where: 'base',
        branch: 'plan/wf/integ-c',
        nodes: ['a', 'b'],
        paths: ['registry.txt'],
        rounds: 0,
        revertedDeletions: [{ path: 'registry.txt', node: 'a', lines: 1 }],
      },
    ])
  })

  it('does not flag a deletion in a generated file, which the steps regenerate', async () => {
    const { conflicts, integrator } = await setup(
      { 'in/base.txt': 'base\n', 'gen.txt': 'base\n', 'registry.txt': 'alpha\nunused\nomega\n' },
      { 'in/x-a.txt': 'a\n', 'registry.txt': 'alpha\nbeta\nomega\n' },
      { 'in/y-b.txt': 'b\n', 'registry.txt': 'alpha\nunused\ngamma\nomega\n' },
      { codegen: { gen: GENERATE }, append_only: ['registry.txt'] },
    )
    await integrator.prepareBase('c')
    // Only the source file is reported; gen.txt lost lines on both sides and is regenerated.
    expect(conflicts.flatMap((conflict) => conflict.revertedDeletions ?? []).map((entry) => entry.path)).toEqual(['registry.txt'])
  })

  it('still hands a conflict in a file that is not append-only to the fixer', async () => {
    const { integrator, fixes } = await setup(
      { 'registry.txt': 'one\n', 'app.txt': 'one\n' },
      { 'app.txt': 'one\ntwo\n' },
      { 'app.txt': 'one\nthree\n' },
      { codegen: {}, append_only: ['registry.txt'] },
    )
    await expect(integrator.prepareBase('c')).rejects.toThrow()
    expect(fixes.length).toBeGreaterThan(0)
  })
})

describe('doctor --codegen', () => {
  it('flags a nondeterministic step and puts the outputs back', async () => {
    const { root, main } = await makeRepo({ 'in/a.txt': 'a\n', 'gen.txt': 'a\n', 'rand.txt': 'x\n' })
    const probe = await probeCodegen(
      {
        codegen: {
          gen: GENERATE,
          random: step({ cmd: `node -e "require('fs').writeFileSync('rand.txt', String(Math.random()))"`, outputs: ['rand.txt'] }),
        },
      },
      main,
      root,
    )
    expect(probe.deterministic).toEqual(['gen'])
    expect(probe.nondeterministic).toEqual(['random'])
    expect(probe.stale).toEqual(['rand.txt'])
    expect(run(main, 'status', '--porcelain')).toBe('')
  })

  it('refuses to run while generated files have uncommitted changes', async () => {
    const { root, main } = await makeRepo({ 'in/a.txt': 'a\n', 'gen.txt': 'a\n' })
    await writeFile(join(main, 'gen.txt'), 'mine\n')
    const probe = await probeCodegen({ codegen: { gen: GENERATE } }, main, root)
    expect(probe.dirty).toEqual(['gen.txt'])
    expect(await readFile(join(main, 'gen.txt'), 'utf8')).toBe('mine\n')
  })
})
