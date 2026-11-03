/**
 * `doctor --codegen`: each generator run twice in the checkout, to flag one
 * whose output is not a function of its inputs, and once against HEAD, to
 * flag generated files already out of date there.
 *
 * In the checkout rather than a scratch worktree because a generator needs
 * the project's installed dependencies, which a fresh worktree does not have.
 * So it refuses to start while any output has uncommitted changes, and puts
 * every output back as HEAD has it afterwards — tracked files checked out,
 * files it created removed. Formatters are left out: with no phase there are
 * no changed files to give them. A difference that only shows between
 * machines or between worktree paths needs the run itself, which flags it
 * (`CodegenStepRun.nondeterministic`).
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../integration/git.ts'
import type { Workflow } from '../types.ts'
import { codegenLogName, codegenOrder, contentKey, matchingFiles, runCodegen } from './codegen.ts'

export interface CodegenProbe {
  /** Outputs had uncommitted changes, so nothing ran. Paths, at most a few. */
  readonly dirty?: readonly string[]
  /** The step that failed, its exit code and log. */
  readonly failed?: { readonly id: string; readonly exitCode: number; readonly logPath: string }
  /** Steps whose second run wrote different outputs from the first. */
  readonly nondeterministic: readonly string[]
  /** Steps that ran deterministically. */
  readonly deterministic: readonly string[]
  /** Output files the steps changed against HEAD on their first run. */
  readonly stale: readonly string[]
}

export async function probeCodegen(
  workflow: Pick<Workflow, 'codegen'>,
  repoPath: string,
  logDir: string,
  env: Readonly<Record<string, string>> = {},
): Promise<CodegenProbe> {
  const steps = workflow.codegen
  const ids = codegenOrder(steps).filter((id) => steps[id]?.format !== true)
  const generators = Object.fromEntries(ids.map((id) => [id, steps[id] as NonNullable<(typeof steps)[string]>]))
  const patterns = ids.flatMap((id) => generators[id]?.outputs ?? [])
  const none = { nondeterministic: [], deterministic: [], stale: [] }
  if (ids.length === 0) return none

  const dirty = await statusPaths(repoPath, patterns)
  if (dirty.length > 0) return { ...none, dirty: dirty.slice(0, 5) }
  const untracked = new Set(await untrackedPaths(repoPath, patterns))

  const keys = async (): Promise<Map<string, string>> =>
    new Map(
      await Promise.all(
        ids.map(async (id) => [id, await contentKey(repoPath, generators[id]?.outputs ?? [])] as const),
      ),
    )
  const run = async () =>
    await runCodegen({
      steps: generators,
      cwd: repoPath,
      env,
      logPath: (id) => join(logDir, `${codegenLogName(id)}.log`),
      force: true,
    })

  try {
    const first = await run()
    if (first.failed !== null) {
      return { ...none, failed: { id: first.failed.id, exitCode: first.failed.exitCode, logPath: first.failed.logPath } }
    }
    const once = await keys()
    const second = await run()
    if (second.failed !== null) {
      return { ...none, failed: { id: second.failed.id, exitCode: second.failed.exitCode, logPath: second.failed.logPath } }
    }
    const twice = await keys()
    const nondeterministic = ids.filter((id) => once.get(id) !== twice.get(id))
    return {
      nondeterministic,
      deterministic: ids.filter((id) => !nondeterministic.includes(id)),
      stale: first.changed,
    }
  } finally {
    await restore(repoPath, patterns, untracked)
  }
}

async function statusPaths(cwd: string, patterns: readonly string[]): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', ...patterns.map((p) => `:(glob)${p}`)])
  return out
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
}

async function untrackedPaths(cwd: string, patterns: readonly string[]): Promise<string[]> {
  const tracked = new Set(
    (await git(cwd, ['ls-files', '-z', '--', ...patterns.map((p) => `:(glob)${p}`)])).split('\0'),
  )
  return (await matchingFiles(cwd, patterns)).filter((path) => !tracked.has(path))
}

/** Every output back as HEAD has it; files the steps created removed. */
async function restore(cwd: string, patterns: readonly string[], untrackedBefore: ReadonlySet<string>): Promise<void> {
  const changed = await statusPaths(cwd, patterns).catch(() => [])
  if (changed.length > 0) await git(cwd, ['checkout', 'HEAD', '--', ...changed]).catch(() => '')
  for (const path of await untrackedPaths(cwd, patterns).catch(() => [])) {
    if (!untrackedBefore.has(path)) rmSync(join(cwd, path), { force: true })
  }
}
