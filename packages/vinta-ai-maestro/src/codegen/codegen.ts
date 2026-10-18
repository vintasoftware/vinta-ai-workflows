/**
 * Codegen steps (`workflow.codegen`): deterministic commands that write
 * declared files, run and committed without an agent turn.
 *
 * Generated files were most of one observed run's merge conflicts — an OpenAPI
 * schema 25 times, a route tree 21, the API client behind the schema 20 — and
 * a hook that rewrote the schema refused seven merge commits. None of those is
 * a conflict anyone should resolve by hand: the file is a function of others,
 * so the answer is to run the function. This module is that function's
 * runner, and the places that call it decide *when*:
 *
 * - **In a lane, before the gates** (`executor.ts`): after every implement or
 *   fix turn, so a phase branch never carries a stale generated file. What a
 *   step changes among its `outputs` is committed there and then.
 * - **In the integration worktree** (`integrator.ts`): a conflict confined to
 *   a step's outputs is settled by taking either side and running the step
 *   (`settleOutputs`), and every merge result is regenerated before it is
 *   committed, so a file-modifying hook finds nothing left to change.
 * - **From inside a turn** (`vinta-ai-maestro codegen`, through the gate
 *   broker), so an agent can see the generated client its change implies.
 *
 * A step's `inputs` make it skippable the way the gate cache makes a gate
 * skippable: the key is the step, its command and its inputs' contents, and
 * the entry is the outputs' contents it produced. A lane whose inputs and
 * outputs both match a recorded run has nothing to regenerate.
 *
 * A step that fails is a red gate wherever it runs: a generator that crashes
 * means code that does not build. Its output goes to a log file, never to a
 * result field (§11), exactly like a gate's.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { executeGate, TIMEOUT_EXIT } from '../gates/runner.ts'
import { git, GitCommandError, gitLines, gitOk } from '../integration/git.ts'
import { shellQuote } from '../platform/platform.ts'
import { CODEGEN_GATE_PREFIX, type CodegenStep, type CommandGate } from '../types.ts'

export type CodegenSteps = Readonly<Record<string, CodegenStep>>

/** The id a step's result travels under wherever a gate's would. */
export const codegenGateId = (stepId: string): string => `${CODEGEN_GATE_PREFIX}${stepId}`

/** The log file name for a step: a gate log beside the gates', without the colon. */
export const codegenLogName = (stepId: string): string => `codegen-${stepId}`

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * The steps to run, in `after` order, ties kept in declaration order. `only`
 * narrows to those steps and whatever they come `after`, transitively —
 * running the client generator on a schema nobody regenerated is the stale
 * output this exists to prevent. A cycle (refused by `validate`) is broken in
 * declaration order rather than looping.
 */
export function codegenOrder(steps: CodegenSteps, only?: readonly string[]): string[] {
  const wanted = new Set<string>()
  const want = (id: string): void => {
    if (wanted.has(id) || steps[id] === undefined) return
    wanted.add(id)
    for (const before of steps[id].after) want(before)
  }
  for (const id of only ?? Object.keys(steps)) want(id)

  const order: string[] = []
  const placed = new Set<string>()
  const visiting = new Set<string>()
  const place = (id: string): void => {
    if (placed.has(id) || visiting.has(id) || !wanted.has(id)) return
    visiting.add(id)
    for (const before of steps[id]?.after ?? []) place(before)
    visiting.delete(id)
    placed.add(id)
    order.push(id)
  }
  for (const id of Object.keys(steps)) place(id)
  return order
}

/** The pools `codegen [<step>]` holds: those of every step it runs. */
export function codegenPools(workflow: { readonly codegen: CodegenSteps }, stepId = ''): string[] {
  const steps = workflow.codegen
  const ids = codegenOrder(steps, stepId === '' ? undefined : [stepId])
  return [...new Set(ids.flatMap((id) => steps[id]?.requires ?? []))]
}

/** The output patterns a merge may settle by regenerating: every generator's, no formatter's. */
export function generatedOutputs(steps: CodegenSteps): string[] {
  return Object.values(steps).flatMap((step) => (step.format ? [] : step.outputs))
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** `:(glob)` so `**` crosses directories and `*` does not, whatever git's defaults. */
const pathspecs = (patterns: readonly string[]): string[] => patterns.map((pattern) => `:(glob)${pattern}`)

/** Tracked and untracked-but-not-ignored files matching the patterns, sorted, once each. */
export async function matchingFiles(cwd: string, patterns: readonly string[]): Promise<string[]> {
  if (patterns.length === 0) return []
  const out = await git(cwd, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', ...pathspecs(patterns)], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return [...new Set(out.split('\0').filter((path) => path.length > 0))].sort()
}

/** The members of `paths` that match the patterns. */
export async function filterMatching(
  cwd: string,
  paths: readonly string[],
  patterns: readonly string[],
): Promise<string[]> {
  if (paths.length === 0 || patterns.length === 0) return []
  const matching = new Set(await matchingFiles(cwd, patterns))
  return paths.filter((path) => matching.has(path))
}

/** Blob ids of the files as they are in the worktree; `-` for one that is not there. */
async function blobs(cwd: string, files: readonly string[]): Promise<Map<string, string>> {
  const present = files.filter((file) => existsSync(join(cwd, file)))
  const ids = new Map<string, string>(files.map((file) => [file, '-']))
  // Chunked: a formatter's outputs can be every source file in the repository.
  for (let i = 0; i < present.length; i += 500) {
    const chunk = present.slice(i, i + 500)
    const out = await gitLines(cwd, ['hash-object', '--', ...chunk])
    chunk.forEach((file, j) => ids.set(file, out[j] ?? '-'))
  }
  return ids
}

/** One hash over the contents of every file matching the patterns. */
export async function contentKey(cwd: string, patterns: readonly string[]): Promise<string> {
  const ids = await blobs(cwd, await matchingFiles(cwd, patterns))
  const hash = createHash('sha256')
  for (const [file, id] of ids) hash.update(`${file}\0${id}\n`)
  return hash.digest('hex')
}

/**
 * The paths matching the patterns that differ from HEAD right now, with the
 * blob each has in the worktree. Taken before and after the steps, so what is
 * committed is what the steps changed, and an uncommitted edit an agent left
 * in an output the steps did not touch stays the agent's.
 */
async function dirty(cwd: string, patterns: readonly string[]): Promise<Map<string, string>> {
  if (patterns.length === 0) return new Map()
  const out = await git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...pathspecs(patterns),
  ])
  const entries = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    // A rename or copy carries its source as the next field.
    if (entry[0] === 'R' || entry[0] === 'C') i += 1
  }
  return await blobs(cwd, paths)
}

function changedSince(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const changed = new Set<string>()
  for (const [path, id] of after) if (before.get(path) !== id) changed.add(path)
  // Dirty before and clean now: the step put it back to what HEAD has.
  for (const path of before.keys()) if (!after.has(path)) changed.add(path)
  return [...changed].sort()
}

// ---------------------------------------------------------------------------
// The skip cache
// ---------------------------------------------------------------------------

/**
 * What each step produced from which inputs, content-addressed, so a hit in
 * one lane is a hit in every lane with the same contents. A JSON file beside
 * the gate cache: an entry costs one step run when lost, never a wrong answer,
 * because a hit also requires the outputs to be what the entry says.
 */
export class CodegenCache {
  readonly #file: string | undefined
  readonly #entries: Map<string, string>

  constructor(file?: string) {
    this.#file = file
    this.#entries = new Map()
    if (file === undefined || !existsSync(file)) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (raw !== null && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') this.#entries.set(key, value)
      }
    } catch {
      // An unreadable cache is an empty one.
    }
  }

  /** The cache under a project's maestro store. */
  static forProject(projectDir: string): CodegenCache {
    return new CodegenCache(join(projectDir, '.vinta-ai-maestro', 'codegen-cache.json'))
  }

  fresh(key: string, outputs: string): boolean {
    return this.#entries.get(key) === outputs
  }

  /** The outputs recorded for a key, if any. */
  get(key: string): string | undefined {
    return this.#entries.get(key)
  }

  store(key: string, outputs: string): void {
    this.#entries.set(key, outputs)
    if (this.#file === undefined) return
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(this.#file, `${JSON.stringify(Object.fromEntries(this.#entries))}\n`)
    } catch {
      // Same as a lost row: one more run next time.
    }
  }
}

// ---------------------------------------------------------------------------
// Running the steps
// ---------------------------------------------------------------------------

export type CodegenStatus = 'passed' | 'failed' | 'timed_out' | 'skipped'

export interface CodegenStepRun {
  readonly id: string
  readonly status: CodegenStatus
  /** 0 for a skip. `TIMEOUT_EXIT` for a step killed at its timeout. */
  readonly exitCode: number
  readonly logPath: string
  readonly durationMs: number
  /** Why a skipped step was: its inputs and outputs matched a recorded run, or a formatter had no files. */
  readonly skipped?: 'cached' | 'no_files'
  /**
   * The step wrote different outputs from inputs a recorded run — in this
   * lane or another — wrote other outputs from. Either the generator reads
   * the clock, the timezone, the worktree's path or a hash order, or its
   * `inputs` miss a file it reads; either way each lane regenerates it
   * differently, and merges conflict in it.
   */
  readonly nondeterministic?: boolean
}

export interface CodegenOutcome {
  readonly runs: readonly CodegenStepRun[]
  /** The step that failed, which stopped the chain; null when every step passed or was skipped. */
  readonly failed: CodegenStepRun | null
  /** Output paths the steps changed, relative to the worktree. */
  readonly changed: readonly string[]
}

export interface RunCodegenOptions {
  readonly steps: CodegenSteps
  /** Narrow to these steps and what they come after. Absent runs every step. */
  readonly only?: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly logPath: (stepId: string) => string
  readonly cache?: CodegenCache
  /** Run every step, hit or not, and record the fresh result. */
  readonly force?: boolean
  /**
   * The files the work changed, for a `format` step's `{changed_files}`.
   * Absent skips format steps: there is no scope to give them, and the whole
   * repository is the wrong one.
   */
  readonly changedFiles?: () => Promise<readonly string[]>
  readonly onStart?: (stepId: string) => void
  readonly onResult?: (run: CodegenStepRun) => void
}

/**
 * Runs the steps in order and stops at the first that fails. Commits nothing:
 * where the result goes — a lane commit, the merge being concluded, an
 * agent's working tree — is the caller's.
 */
export async function runCodegen(options: RunCodegenOptions): Promise<CodegenOutcome> {
  const ids = codegenOrder(options.steps, options.only)
  const patterns = ids.flatMap((id) => options.steps[id]?.outputs ?? [])
  const before = await dirty(options.cwd, patterns)
  const runs: CodegenStepRun[] = []
  const finish = async (failed: CodegenStepRun | null): Promise<CodegenOutcome> => ({
    runs,
    failed,
    changed: changedSince(before, await dirty(options.cwd, patterns)),
  })
  const record = (run: CodegenStepRun): CodegenStepRun => {
    runs.push(run)
    options.onResult?.(run)
    return run
  }

  for (const id of ids) {
    const step = options.steps[id]
    if (step === undefined) continue
    const logPath = options.logPath(id)
    const skip = (why: 'cached' | 'no_files'): void => {
      record({ id, status: 'skipped', exitCode: 0, logPath, durationMs: 0, skipped: why })
    }

    let cmd = step.cmd
    if (step.format) {
      const changed = options.changedFiles === undefined ? [] : await options.changedFiles()
      const files = (await filterMatching(options.cwd, [...changed], step.outputs)).filter((file) =>
        existsSync(join(options.cwd, file)),
      )
      if (files.length === 0) {
        skip('no_files')
        continue
      }
      cmd = cmd.split('{changed_files}').join(files.map((file) => shellQuote(file)).join(' '))
    }

    // Formatters are scoped by what changed, which is already the narrowest
    // key there is; only a generator with declared inputs is cached.
    const cache = !step.format && step.inputs.length > 0 ? options.cache : undefined
    let key: string | undefined
    if (cache !== undefined) {
      key = createHash('sha256')
        .update(`${id}\0${cmd}\0${await contentKey(options.cwd, step.inputs)}`)
        .digest('hex')
      if (options.force !== true && cache.fresh(key, await contentKey(options.cwd, step.outputs))) {
        skip('cached')
        continue
      }
    }

    const gate: CommandGate = { cmd, requires: [], timeout_s: step.timeout_s }
    const result = await executeGate({
      gateId: codegenGateId(id),
      gate,
      cwd: options.cwd,
      env: options.env,
      logPath,
      onStart: () => options.onStart?.(id),
    })
    const exitCode = result.status === 'passed' ? 0 : (result.exitCode ?? TIMEOUT_EXIT)
    const status = result.status === 'passed' ? 'passed' : result.status
    const failed = exitCode === 0 && status !== 'passed' ? 1 : exitCode
    if (status !== 'passed') {
      return await finish(record({ id, status, exitCode: failed, logPath, durationMs: result.durationMs }))
    }
    let nondeterministic = false
    if (cache !== undefined && key !== undefined) {
      const outputs = await contentKey(options.cwd, step.outputs)
      const recorded = cache.get(key)
      nondeterministic = recorded !== undefined && recorded !== outputs
      cache.store(key, outputs)
    }
    record({
      id,
      status,
      exitCode: 0,
      logPath,
      durationMs: result.durationMs,
      ...(nondeterministic ? { nondeterministic } : {}),
    })
  }
  return await finish(null)
}

// ---------------------------------------------------------------------------
// Committing what they wrote
// ---------------------------------------------------------------------------

/**
 * Stages files a hook modified and reports whether there were any — the
 * fallback for a project with no codegen steps declared, and for one whose
 * hook still finds something. A `pre-commit` that reformats or regenerates a
 * file fails the commit after rewriting it; the rewrite is the fix, so it is
 * staged and the commit tried once more. `within` limits it to the paths
 * being committed, so an agent's unrelated unstaged edit is left unstaged.
 */
export async function restageHookEdits(cwd: string, within?: readonly string[]): Promise<boolean> {
  const out = await git(cwd, ['diff', '--name-only', '-z', ...(within === undefined ? [] : ['--', ...within])])
  const modified = out.split('\0').filter((path) => path.length > 0)
  if (modified.length === 0) return false
  await git(cwd, ['add', '-A', '--', ...modified])
  return true
}

/**
 * `git commit <args>`, retried once when it fails having left modified files
 * behind — a hook that rewrote what it was handed. Any other failure, or a
 * second one, is git's error.
 */
export async function commitRetryingHookEdits(
  cwd: string,
  args: readonly string[],
  within?: readonly string[],
): Promise<void> {
  try {
    await git(cwd, ['commit', ...args])
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error
    if (!(await restageHookEdits(cwd, within).catch(() => false))) throw error
    await git(cwd, ['commit', ...args])
  }
}

/**
 * Commits exactly `paths`, as they are in the worktree, and nothing else that
 * is staged. False when they hold nothing HEAD does not already have.
 */
export async function commitOutputs(cwd: string, paths: readonly string[], message: string): Promise<boolean> {
  if (paths.length === 0) return false
  await git(cwd, ['add', '-A', '--', ...paths])
  if (await gitOk(cwd, ['diff', '--cached', '--quiet', '--', ...paths])) return false
  await commitRetryingHookEdits(cwd, ['-m', message, '--only', '--', ...paths], paths)
  return true
}

/** The commit message for a lane or integration regeneration. Step ids only. */
export function codegenMessage(runs: readonly CodegenStepRun[], context?: string): string {
  const ran = runs.filter((run) => run.status === 'passed').map((run) => run.id)
  return `chore(codegen): regenerate ${ran.length === 0 ? 'outputs' : ran.join(', ')}${context === undefined ? '' : ` ${context}`}`
}

// ---------------------------------------------------------------------------
// Integration: settling conflicted outputs, and the union driver
// ---------------------------------------------------------------------------

/**
 * Takes a side for every unmerged path that is a generator's output — ours,
 * else theirs, else neither when both deleted it — and stages it, so the
 * merge's conflict is down to what a fixer has to read. The steps run next
 * and overwrite whichever side was taken; which one it was does not matter.
 * Returns the paths it settled.
 */
export async function settleOutputs(
  cwd: string,
  steps: CodegenSteps,
  unmerged: readonly string[],
): Promise<string[]> {
  const outputs = await filterMatching(cwd, unmerged, generatedOutputs(steps))
  for (const path of outputs) {
    if (!(await gitOk(cwd, ['checkout', '--ours', '--', path]))) {
      if (!(await gitOk(cwd, ['checkout', '--theirs', '--', path]))) {
        await gitOk(cwd, ['rm', '-q', '--cached', '--', path])
        continue
      }
    }
    await git(cwd, ['add', '--', path])
  }
  return outputs
}

/**
 * The `-c` arguments that make a merge use git's `union` driver for the
 * append-only files: an attributes file holding whatever `core.attributesFile`
 * already pointed at, then one `<pattern> merge=union` line per pattern. Passed
 * per merge rather than written to `.git/info/attributes`, which every
 * worktree of the repository — the operator's own checkout included — reads.
 */
export async function unionMergeArgs(
  cwd: string,
  patterns: readonly string[],
  file: string,
): Promise<string[]> {
  if (patterns.length === 0) return []
  const configured = (await git(cwd, ['config', '--path', 'core.attributesFile']).catch(() => '')).trim()
  const fallback = join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'git', 'attributes')
  const existing = configured !== '' ? configured : fallback
  let inherited = ''
  try {
    inherited = readFileSync(existing, 'utf8')
  } catch {
    // None configured.
  }
  const lines = patterns.map((pattern) => `${pattern} merge=union`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${inherited}${inherited === '' || inherited.endsWith('\n') ? '' : '\n'}# vinta-ai-maestro: append_only\n${lines.join('\n')}\n`,
  )
  return ['-c', `core.attributesFile=${file}`]
}
