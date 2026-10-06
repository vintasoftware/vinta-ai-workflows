/**
 * Applying the project's configuration to a run that is already going.
 *
 * A run watches its plan branch (`src/run/plan-branch.ts`). When the branch
 * moves and the commits touched `.vinta-ai-workflows.yaml` or the plan's own
 * workflow file, both are read *at the new commit*, resolved exactly as they
 * were at start, and handed to `amendRun` as a `config` amendment. Nothing is
 * read from anybody's working tree: a commit is the trigger, so every change a
 * run takes this way is one somebody can point at — the journal records the
 * sha — and an edit in progress on a checkout reaches no run at all.
 *
 * ## What a reload may not change
 *
 * The project's configuration is the layer *under* the run's own amendments,
 * so the proposal is pinned before it is submitted:
 *
 * - **Whatever an operator or the monitor changed in this run** keeps the run's
 *   value. A person who retuned `unit` mid-run made a decision about this run;
 *   a commit that happens to touch the same gate in the shared file is not a
 *   decision to undo it. The targets come from `workflow_amended` rows.
 * - **A node that has started** keeps its definition. Most of what a reload
 *   could change about one is refused by §9 once it runs — its body, its
 *   harness, its model — and a reload that is refused whole because one phase
 *   was mid-turn would hold back the gate change it was really for.
 * - **`base_branch`** is the run's pull-request target, and a commit changing
 *   the project's default branch does not retarget a plan already in flight.
 *
 * What is left reaches the run through the same §9 rules as any amendment:
 * gate tables take effect at the next gate run, unstarted nodes take their new
 * definitions, and anything §9 refuses is refused and journalled.
 *
 * ## Failure
 *
 * Never fatal. A refusal that is about timing — a node §9 says is in flight —
 * is retried on the next tick without moving past the commit. Anything else is
 * journalled as a `config_reload` row and the commit is passed over: the next
 * one starts from the run's definition as it stands.
 */
import type { AmendRunner } from '../amend/amend.ts'
import { amendRun } from '../amend/amend.ts'
import { gitLines } from '../integration/git.ts'
import type { NodeStatus } from '../journal/events.ts'
import type { Journal } from '../journal/journal.ts'
import type { Logger } from '../log/logger.ts'
import { commitOf } from '../run/plan-branch.ts'
import { writeSources, type RunSources } from '../run/sources.ts'
import type { Workflow } from '../types.ts'
import { parseWorkflow, type ValidationIssue } from '../validate.ts'
import { parseProjectConfig, PROJECT_CONFIG_FILE, readFileAt } from './project-config.ts'
import { resolveWorkflow } from './resolve.ts'

const DEFAULT_TICK_MS = 10_000

/** Statuses at which a node has not started. Everything else keeps its definition. */
const NOT_STARTED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['pending', 'blocked'])

/** Amendments whose targets a reload leaves alone. */
const PINNING_AUTHORS = new Set(['operator', 'monitor', 'coordinator', undefined])

export type ReloadOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'irrelevant'; readonly head: string }
  | { readonly kind: 'applied'; readonly head: string; readonly amendment: number }
  | { readonly kind: 'no_change'; readonly head: string }
  | { readonly kind: 'deferred'; readonly head: string }
  | { readonly kind: 'refused'; readonly head: string; readonly code: string }

export interface ConfigReloaderOptions {
  readonly repoPath: string
  readonly journal: Journal
  readonly runId: string
  readonly sources: RunSources
  /** The run's definition as it stands — not the snapshot it started with. */
  readonly workflow: () => Workflow
  readonly runner: AmendRunner
  readonly tickMs?: number
  readonly logger?: Logger
}

export interface ConfigReloader {
  /** One pass. Exposed so tests drive the loop without waiting on a timer. */
  tick(): Promise<ReloadOutcome>
  stop(): void
}

export function startConfigReloader(options: ConfigReloaderOptions): ConfigReloader {
  const { repoPath, journal, runId } = options
  let sources = options.sources
  let running = false
  let stopped = false
  /** The head a deferral was last journalled for, so a long wait is one row. */
  let deferredAt: string | null = null

  const advance = (next: Partial<RunSources> & { readonly head: string }): void => {
    sources = { ...sources, ...next }
    writeSources(journal, runId, sources)
  }

  const record = (head: string, outcome: 'refused' | 'deferred', code: string, issues: readonly ValidationIssue[] = []) => {
    journal.append({
      runId,
      type: 'config_reload',
      payload: {
        source: head,
        outcome,
        code,
        issues: issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
      },
    })
    options.logger?.warn('run.config_reload', { run: runId, outcome, code })
  }

  const pass = async (): Promise<ReloadOutcome> => {
    const head = await commitOf(repoPath, `refs/heads/${sources.plan_branch}`)
    if (head === null || head === sources.head) return { kind: 'unchanged' }

    const watched = [PROJECT_CONFIG_FILE, ...(sources.workflow_path === null ? [] : [sources.workflow_path])]
    const touched = await gitLines(repoPath, ['diff', '--name-only', sources.head, head, '--', ...watched])
    if (touched.length === 0) {
      advance({ head })
      return { kind: 'irrelevant', head }
    }

    const config = parseProjectConfig(await readFileAt(repoPath, head, PROJECT_CONFIG_FILE))
    if (!config.ok) {
      record(head, 'refused', 'invalid_config', config.issues)
      advance({ head })
      return { kind: 'refused', head, code: 'invalid_config' }
    }

    let authored = sources.authored
    if (sources.workflow_path !== null) {
      const text = await readFileAt(repoPath, head, sources.workflow_path)
      if (text !== null) {
        try {
          authored = JSON.parse(text) as unknown
        } catch {
          record(head, 'refused', 'invalid_workflow', [{ path: [], message: `${sources.workflow_path} is not valid JSON` }])
          advance({ head })
          return { kind: 'refused', head, code: 'invalid_workflow' }
        }
      }
    }

    const resolved = resolveWorkflow(authored, config.config)
    if (!resolved.ok) {
      record(head, 'refused', 'invalid_workflow', resolved.issues)
      advance({ head })
      return { kind: 'refused', head, code: 'invalid_workflow' }
    }

    const current = options.workflow()
    const statuses = statusesOf(journal, runId, options.runner)
    const proposed = pin(resolved.workflow, current, pinnedTargets(journal, runId), started(current, statuses))
    if (proposed === null) {
      record(head, 'refused', 'invalid_workflow')
      advance({ head })
      return { kind: 'refused', head, code: 'invalid_workflow' }
    }

    if (JSON.stringify(proposed) === JSON.stringify(current)) {
      advance({ head, authored, config: config.config })
      return { kind: 'no_change', head }
    }

    const result = await amendRun({
      journal,
      runId,
      proposed,
      runner: options.runner,
      author: 'config',
      source: head,
    })
    if (result.ok) {
      advance({ head, authored, config: config.config })
      deferredAt = null
      options.logger?.info('run.config_reloaded', { run: runId, amendment: result.amendment })
      return { kind: 'applied', head, amendment: result.amendment }
    }

    if (result.code === 'nodes_in_flight') {
      if (deferredAt !== head) record(head, 'deferred', result.code, result.issues)
      deferredAt = head
      return { kind: 'deferred', head }
    }
    record(head, 'refused', result.code, result.issues)
    advance({ head })
    return { kind: 'refused', head, code: result.code }
  }

  const tick = async (): Promise<ReloadOutcome> => {
    if (stopped || running) return { kind: 'unchanged' }
    running = true
    try {
      return await pass()
    } catch (error) {
      // A git failure is a moment, not a verdict: the next tick tries again.
      // The kind only — git's output is repository content (§11).
      options.logger?.warn('run.config_reload_failed', {
        run: runId,
        error: error instanceof Error ? error.name : 'unknown',
      })
      return { kind: 'unchanged' }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, options.tickMs ?? DEFAULT_TICK_MS)
  timer.unref?.()

  return {
    tick,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** Everything a person or the monitor changed in this run, as amendment targets. */
export function pinnedTargets(journal: Journal, runId: string): Set<string> {
  const pinned = new Set<string>()
  for (const event of journal.events(runId)) {
    if (event.type !== 'workflow_amended') continue
    const { author, targets, changes } = event.payload
    if (!PINNING_AUTHORS.has(author)) continue
    if (targets !== undefined) {
      for (const target of targets) pinned.add(target)
      continue
    }
    // An operator row written before operator rows carried targets: the nodes
    // it moved are known, and what it did to the gate table is not. Pinning the
    // nodes is the part that can be done honestly.
    for (const change of changes) pinned.add(`node:${change.node}`)
  }
  return pinned
}

/**
 * The proposal with the run's own value put back wherever the run owns it.
 * Null when the result does not parse — which pinning cannot cause on a valid
 * pair, and which is reported rather than thrown if it ever does.
 */
export function pin(
  proposed: Workflow,
  current: Workflow,
  pinned: ReadonlySet<string>,
  startedNodes: ReadonlySet<string>,
): Workflow | null {
  const next = structuredClone(proposed) as Record<string, unknown> & Workflow
  const keep = <T>(field: 'gates' | 'chores' | 'resources' | 'crew' | 'pipelines', prefix: string) => {
    const table = { ...(next[field] as Record<string, T>) }
    const from = current[field] as Readonly<Record<string, T>>
    for (const target of pinned) {
      if (!target.startsWith(`${prefix}:`)) continue
      const id = target.slice(prefix.length + 1)
      if (id in from) table[id] = from[id] as T
      else delete table[id]
    }
    ;(next as Record<string, unknown>)[field] = table
  }
  keep('gates', 'gate')
  keep('chores', 'chore')
  keep('resources', 'resource')
  keep('crew', 'crew')
  keep('pipelines', 'pipeline')

  const defaults = { ...next.defaults } as Record<string, unknown>
  for (const target of pinned) {
    if (!target.startsWith('defaults.')) continue
    const field = target.slice('defaults.'.length) as keyof Workflow['defaults']
    defaults[field] = current.defaults[field]
  }
  ;(next as Record<string, unknown>).defaults = defaults

  for (const field of ['project', 'plan_ref', 'plan_context_refs', 'data'] as const) {
    if (pinned.has(field)) (next as Record<string, unknown>)[field] = current[field]
  }
  ;(next as Record<string, unknown>).base_branch = current.base_branch

  const held = new Set([...startedNodes, ...[...pinned].filter((t) => t.startsWith('node:')).map((t) => t.slice(5))])
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]))
  const nodes = next.nodes.map((node) => (held.has(node.id) ? (currentNodes.get(node.id) ?? node) : node))
  for (const id of held) {
    const node = currentNodes.get(id)
    if (node !== undefined && !nodes.some((candidate) => candidate.id === id)) nodes.push(node)
  }
  ;(next as Record<string, unknown>).nodes = nodes

  const parsed = parseWorkflow(next)
  return parsed.ok ? parsed.workflow : null
}

function started(workflow: Workflow, statuses: (id: string) => NodeStatus | undefined): Set<string> {
  return new Set(
    workflow.nodes.filter((node) => !NOT_STARTED.has(statuses(node.id) ?? 'pending')).map((node) => node.id),
  )
}

/** The projection with the live view laid over it, as `amendRun` reads them. */
function statusesOf(
  journal: Journal,
  runId: string,
  runner: AmendRunner,
): (nodeId: string) => NodeStatus | undefined {
  const projected = new Map(journal.nodes(runId).map((row) => [row.node_id, row.status]))
  const live = runner.statuses?.() ?? {}
  return (nodeId) => live[nodeId] ?? projected.get(nodeId)
}

