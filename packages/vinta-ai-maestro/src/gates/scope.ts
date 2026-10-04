/**
 * Which of a gate's two commands runs, and what its placeholders become.
 *
 * A gate may carry a `scoped_cmd` beside its `cmd`: the same check, narrowed to
 * what the phase changed. A phase gate runs inside a fix loop — the implementer
 * asks for it, the reviewer asks for it, each fixer round asks for it — so the
 * narrow form is where the time goes. The full form still runs, once per wave,
 * on the merged tree (`executor.ts`'s wave gate), which is where the
 * regressions *between* phases show up and where nothing narrower would see
 * them.
 *
 * The result is an ordinary `CommandGate` whose `cmd` is the line that runs.
 * The runner and the cache read only `cmd`, so the cache keys on the rendered
 * command — the same scoped line over the same tree is a hit, and a different
 * set of changed files is a different line and a miss, which is correct.
 */
import { git, gitLines } from '../integration/git.ts'
import { shellQuote } from '../platform/platform.ts'
import type { CommandGate, GateScope } from '../types.ts'
import { laneTreeHash } from './cache.ts'

export interface ScopeContext {
  /** The lane the gate runs in. */
  readonly lanePath: string
  /** The phase's base, for the changed-file list. */
  readonly base: string
  /** The node's Touch List. */
  readonly touches: readonly string[]
}

/**
 * The gate to run for a phase. `cmd` when the run says `full`, when the gate
 * has no scoped form, or when a placeholder would substitute nothing — an empty
 * list would make most test runners run everything anyway, and saying so
 * explicitly is better than relying on it.
 */
export async function phaseGate(
  gate: CommandGate,
  scope: GateScope,
  context: ScopeContext,
): Promise<CommandGate> {
  const template = gate.scoped_cmd
  if (scope === 'full' || template === undefined) return gate

  const values: Record<string, readonly string[]> = {}
  if (template.includes('{changed_files}')) values['{changed_files}'] = await changedFiles(context)
  if (template.includes('{touches}')) values['{touches}'] = context.touches
  if (Object.values(values).some((list) => list.length === 0)) return gate

  let cmd = template
  for (const [placeholder, list] of Object.entries(values)) {
    cmd = cmd.split(placeholder).join(list.map((path) => shellQuote(path)).join(' '))
  }
  return { ...gate, cmd }
}

/**
 * The files the lane changed against the phase's base: committed, staged,
 * unstaged and untracked, the tree the cache keys on, compared with the merge
 * base. Deletions are left out — a runner handed a path that no longer exists
 * fails on the path, not on the code.
 */
export async function changedFiles(context: ScopeContext): Promise<string[]> {
  const tree = laneTreeHash(context.lanePath)
  const merged = await gitLines(context.lanePath, ['merge-base', context.base, 'HEAD']).catch(() => [])
  const from = merged[0] ?? context.base
  // `-z`, because without it git C-quotes any path with a non-ASCII byte and
  // the runner is handed a name with literal backslashes in it.
  const out = await git(context.lanePath, ['diff', '--name-only', '-z', '--diff-filter=d', from, tree])
  return out.split('\0').filter((path) => path.length > 0)
}
