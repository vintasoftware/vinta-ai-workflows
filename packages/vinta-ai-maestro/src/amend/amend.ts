/**
 * §9's amend path: changing a live run's workflow at a safe point.
 *
 * The rule this file exists to enforce, in §9's own words — nodes not yet
 * started take the change immediately; nodes already `done` whose dependency
 * closure changed are rebased in topological order, `integ-` bases rebuilt
 * first; and amending is **refused while any affected node is running**.
 *
 * ## What "running" means here
 *
 * §5.2 gives a node seven statuses and §9 names one of them. The other two
 * that are neither settled nor unstarted are decided here, both towards the
 * refusal:
 *
 * - **`waiting_on_capacity` blocks.** §6.1 is explicit that a vendor refusing
 *   a session is backpressure and that the node "waits and resumes
 *   automatically" — on a timer this path does not own. There is no moment
 *   between that timer firing and the agent spawning at which an amendment
 *   could be handed over, so allowing it would be a race, not a safe point.
 *   The refusal is transient and says so.
 * - **`awaiting_human` blocks.** §9.1 keeps a paused node's lane precisely
 *   because "the human is being asked about work in progress *in that lane*",
 *   and the diff and gate log the operator is reading are that lane's. Moving
 *   the node's base under the question would answer a different question than
 *   the one that was asked, and the node resumes into a pipeline that already
 *   captured its old definition.
 *
 * `blocked` and `pending` are both "not yet started" and take the change
 * immediately. `failed` is settled: it is not rebased and does not block —
 * there is no downstream work depending on it by construction, because §6's
 * containment already blocked everything that did.
 *
 * ## The snapshot
 *
 * The run's `workflow.json` is **replaced**, and the version it replaced is
 * kept beside it as `amendments/<n>.json`. §5.3's rule is that editing the
 * *source* workflow does not reach back into a run — which still holds, since
 * the only thing that changes a run is this deliberate, journalled path. What
 * §5.3 also requires is that the snapshot never become a second source of
 * truth, and a *chain* of amendments would do exactly that: every reader would
 * have to fold it, and the effective workflow would become a derived thing
 * sitting beside the projections with nobody folding it from `events`. One
 * file, one reader, and a `workflow_amended` row pointing at what it used to
 * be.
 *
 * The projection invariant is untouched. `workflow_amended` is history and is
 * not projected; the node rows an amendment does move are moved by the events
 * that already project — `node_registered` for a node the run gains, and
 * `node_assigned` for a base that moved — so dropping `runs` and `nodes` and
 * replaying `events` still reproduces both.
 *
 * Every issue, error and journalled field below carries node ids, branch names
 * and paths. A workflow holds plan prose; none of it leaves this file.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeWaves } from '../graph.ts'
import type { AmendmentAuthor, AmendmentChange, NodeStatus } from '../journal/events.ts'
import type { Journal } from '../journal/journal.ts'
import type { Workflow } from '../types.ts'
import { parseWorkflow, type ValidationIssue } from '../validate.ts'
import { diffWorkflows, type WorkflowDiff } from './diff.ts'

/** Started and not settled. §9's "running", read across §5.2's whole vocabulary. */
const IN_FLIGHT: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'running',
  'waiting_on_capacity',
  'awaiting_human',
])

/** Statuses at which a node has not started and may simply take a new definition. */
const NOT_STARTED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['pending', 'blocked'])

/** Why an amendment was refused. Prose belongs to the issues, not to the code. */
export type AmendRefusalCode =
  | 'invalid_workflow'
  | 'id_mismatch'
  | 'nodes_in_flight'
  | 'node_removed_after_start'
  | 'body_changed_after_done'
  | 'dependency_not_done'
  | 'rebase_unavailable'
  | 'rebase_failed'

export interface AmendRefusal {
  readonly ok: false
  readonly code: AmendRefusalCode
  /** Located, like every other refusal in this package (`validate.ts`). */
  readonly issues: readonly ValidationIssue[]
}

export interface AmendApplied {
  readonly ok: true
  /** 1 for a run's first amendment. Matches the journalled ordinal. */
  readonly amendment: number
  readonly workflow: Workflow
  readonly changes: readonly AmendmentChange[]
  readonly affected: readonly string[]
  /** Not-yet-started nodes that took the change immediately. */
  readonly applied: readonly string[]
  /** Already-`done` nodes rebased, in the order they were rebased. */
  readonly rebased: readonly string[]
}

export type AmendResult = AmendApplied | AmendRefusal

/** What one node's rebase asks of the host. Ids and a workflow — never a diff. */
export interface RebaseRequest {
  /** The amended workflow, which is what the new bases are derived from. */
  readonly workflow: Workflow
  /** `done` nodes whose base moved, already in topological order. */
  readonly nodes: readonly string[]
}

/**
 * The run-side of an amendment, supplied by whoever is running the run.
 *
 * Both members are optional and mean different things when absent: with no
 * `rebase`, an amendment that would move a `done` node's base is **refused**
 * rather than half-applied — a snapshot describing a topology nothing built is
 * worse than no amendment. With no `adopt`, the amendment is still durable and
 * the new definitions are picked up when the run next reads its snapshot.
 */
export interface AmendRunner {
  /** Live statuses. Unioned with the journal's, never trusted instead of it. */
  statuses?(): Readonly<Record<string, NodeStatus>>
  /** Rebuilds `integ-` bases and re-cuts `done` branches, in the order given. */
  rebase?(request: RebaseRequest): Promise<void>
  /** Hands the amended workflow to the live scheduler for its unstarted nodes. */
  adopt?(workflow: Workflow): void
}

export interface AmendOptions {
  readonly journal: Journal
  readonly runId: string
  /** The proposed workflow, unparsed: this path is the validation boundary. */
  readonly proposed: unknown
  readonly runner?: AmendRunner
  /**
   * Who is amending. Defaults to `operator`, which is every caller that
   * predates the run being able to amend itself.
   */
  readonly author?: AmendmentAuthor
  /** What an autonomous amendment changed, as `gate:<id>` / `node:<id>` tokens. */
  readonly targets?: readonly string[]
}

/**
 * Computes, gates, applies and journals one amendment.
 *
 * The order is deliberate: git moves **before** the snapshot does. A rebase
 * that fails leaves the snapshot still describing the branches that exist, and
 * the refusal names the node it stopped at. The other order would leave a run
 * whose definition claims a topology nothing ever built.
 */
export async function amendRun(options: AmendOptions): Promise<AmendResult> {
  const { journal, runId } = options

  const parsed = parseWorkflow(options.proposed)
  if (!parsed.ok) return { ok: false, code: 'invalid_workflow', issues: parsed.issues }
  const proposed = parsed.workflow

  const snapshot = journal.readWorkflow(runId)
  if (proposed.id !== snapshot.id) {
    return {
      ok: false,
      code: 'id_mismatch',
      issues: [{ path: ['id'], message: `amendment is for workflow "${proposed.id}"` }],
    }
  }

  const diff = diffWorkflows(snapshot, proposed)
  const status = statuses(options)
  const refusal = refuse(diff, status, snapshot, proposed, options.runner)
  if (refusal !== null) return refusal

  const rebase = diff.rebaseable.filter((id) => status(id) === 'done')
  if (rebase.length > 0) {
    try {
      // `prepareBase` inside the host's rebaser rebuilds each multi-dependency
      // node's `integ-` branch before that node moves onto it, and the queue is
      // topological, so every dependency has already moved by the time the
      // `integ-` merging it is rebuilt. That is §9's "`integ-` bases rebuilt
      // first", and it falls out of the order rather than being a second pass.
      await options.runner?.rebase?.({ workflow: proposed, nodes: rebase })
    } catch (error) {
      return {
        ok: false,
        code: 'rebase_failed',
        // The thrown message is the rebaser's, which reports node and branch
        // ids only — see `rebase.ts`. Nothing from a diff reaches here.
        issues: [{ path: ['nodes'], message: message(error) }],
      }
    }
  }

  const applied = diff.affected.filter((id) => {
    const current = status(id)
    return current === undefined || NOT_STARTED.has(current)
  })

  const amendment = countAmendments(journal, runId) + 1
  const superseded = supersede(journal, runId, snapshot, proposed, amendment)

  journal.append({
    runId,
    type: 'workflow_amended',
    payload: {
      amendment,
      changes: diff.changes,
      affected: diff.affected,
      applied,
      rebased: rebase,
      superseded,
      author: options.author ?? 'operator',
      ...(options.targets === undefined ? {} : { targets: [...options.targets] }),
    },
  })
  registerNodes(journal, runId, proposed, status, diff)
  options.runner?.adopt?.(proposed)

  return {
    ok: true,
    amendment,
    workflow: proposed,
    changes: diff.changes,
    affected: diff.affected,
    applied,
    rebased: rebase,
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

type StatusOf = (nodeId: string) => NodeStatus | undefined

/**
 * The journal's projection, with the live run's view laid over it.
 *
 * The union, not a choice: the projection is what survives a restart and is
 * authoritative, and a live scheduler leads it by the width of one event. A
 * node either of them calls in-flight is in flight, which is the only reading
 * of a safety gate that cannot be raced.
 */
function statuses(options: AmendOptions): StatusOf {
  const projected = new Map(
    options.journal.nodes(options.runId).map((row) => [row.node_id, row.status]),
  )
  const live = options.runner?.statuses?.() ?? {}
  return (nodeId) => {
    const projectedStatus = projected.get(nodeId)
    const liveStatus = live[nodeId]
    if (projectedStatus === undefined) return liveStatus
    if (liveStatus === undefined) return projectedStatus
    return IN_FLIGHT.has(liveStatus) ? liveStatus : projectedStatus
  }
}

function refuse(
  diff: WorkflowDiff,
  status: StatusOf,
  snapshot: Workflow,
  proposed: Workflow,
  runner: AmendRunner | undefined,
): AmendRefusal | null {
  const at = locator(snapshot, proposed)

  // §9's headline rule, checked before every other refusal so that an operator
  // amending a live run is told the one thing that makes the answer "not yet"
  // rather than "not like this".
  //
  // `blocking` rather than `affected`, which is the narrowing §9's rule always
  // implied and did not express. The rule protects a node from having its
  // definition moved after the moment it read it; a gate's *command* has no
  // such moment — every reader of it resolves it per gate run and takes an
  // amendment (`adopt`) — so a node running now runs the new command at its
  // next gate and no work already done is invalidated. Nothing downstream is
  // reached at all, because no base moved.
  //
  // This is not an exception carved out for one caller: an operator retuning a
  // slow gate in the editor mid-run gets exactly the same relief, and it is
  // what makes a mis-tuned run fixable without throwing the run away.
  const inFlight = diff.blocking.filter((id) => IN_FLIGHT.has(status(id) as NodeStatus))
  if (inFlight.length > 0) {
    return {
      ok: false,
      code: 'nodes_in_flight',
      issues: inFlight.map((id) => ({
        path: at(id),
        message: `node "${id}" is ${reason(status(id) as NodeStatus)} — amending an affected node is refused while it is in flight`,
      })),
    }
  }

  const started = diff.removed.filter((id) => !NOT_STARTED.has(status(id) ?? 'pending'))
  if (started.length > 0) {
    return {
      ok: false,
      code: 'node_removed_after_start',
      issues: started.map((id) => ({
        path: at(id),
        message:
          `node "${id}" has already run and cannot be removed from the run — ` +
          'its branch and its journalled history are the record of work that happened',
      })),
    }
  }

  // The divergence from `amend-plan`'s `body-rewrite`, and the reason for it:
  // that skill re-spawns an implementer against the new phase body. The daemon
  // has no way to re-enter a settled node's pipeline, so rebasing a `done`
  // node whose body changed would ship a branch that does not implement its
  // own definition. Refusing names the forward path instead.
  const rewritten = diff.contentChanged.filter((id) => status(id) === 'done')
  if (rewritten.length > 0) {
    return {
      ok: false,
      code: 'body_changed_after_done',
      issues: rewritten.map((id) => ({
        path: at(id),
        message:
          `node "${id}" is already done; its definition cannot be rewritten in place — ` +
          'add a node that depends on it instead',
      })),
    }
  }

  // A `done` node's new base is built out of its dependencies' branches, so
  // every one of them has to exist. Gaining a dependency on a node that has
  // not completed asks for a base nothing has built.
  const unbuilt: ValidationIssue[] = []
  for (const id of diff.rebaseable) {
    if (status(id) !== 'done') continue
    const node = proposed.nodes.find((candidate) => candidate.id === id)
    node?.depends_on.forEach((dependency, index) => {
      if (status(dependency.node) === 'done') return
      unbuilt.push({
        path: [...at(id), 'depends_on', index, 'node'],
        message: `node "${id}" is done and cannot be rebased onto "${dependency.node}", which has not completed`,
      })
    })
  }
  if (unbuilt.length > 0) return { ok: false, code: 'dependency_not_done', issues: unbuilt }

  const rebase = diff.rebaseable.filter((id) => status(id) === 'done')
  if (rebase.length > 0 && runner?.rebase === undefined) {
    return {
      ok: false,
      code: 'rebase_unavailable',
      issues: rebase.map((id) => ({
        path: at(id),
        message: `node "${id}" is done and its base moved, but this run has no integration worktree to rebase in`,
      })),
    }
  }

  return null
}

function reason(status: NodeStatus): string {
  if (status === 'waiting_on_capacity') return 'waiting on harness capacity and resumes on its own'
  if (status === 'awaiting_human') return 'paused on a human question and still holds its lane'
  return 'running'
}

/** `nodes[i]`, from the proposal when it declares the node and the snapshot otherwise. */
function locator(snapshot: Workflow, proposed: Workflow): (nodeId: string) => (string | number)[] {
  const index = new Map<string, number>()
  snapshot.nodes.forEach((node, i) => index.set(node.id, i))
  proposed.nodes.forEach((node, i) => index.set(node.id, i))
  return (nodeId) => {
    const found = index.get(nodeId)
    return found === undefined ? ['nodes'] : ['nodes', found]
  }
}

// ---------------------------------------------------------------------------
// The durable side
// ---------------------------------------------------------------------------

/**
 * Replaces the frozen snapshot, keeping the version it replaced.
 *
 * Written to a temporary file and renamed over the target for the same reason
 * `workflows.ts` does it: a crash mid-write must leave the run's definition
 * intact rather than truncated. Returns the run-relative path of the copy,
 * which is what the journalled row points at.
 */
function supersede(
  journal: Journal,
  runId: string,
  previous: Workflow,
  next: Workflow,
  amendment: number,
): string {
  const dir = runDir(journal, runId)
  const relative = join('amendments', `${amendment}.json`)
  mkdirSync(join(dir, 'amendments'), { recursive: true })
  writeFileSync(join(dir, relative), `${JSON.stringify(previous, null, 2)}\n`, 'utf8')

  const target = join(dir, 'workflow.json')
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
  return relative
}

/**
 * The one projected event an amendment emits about node identity.
 *
 * A node the run gains has no row at all until `node_registered` creates one,
 * and a node that is still `pending` may have moved wave or harness. Both are
 * emitted here and nowhere else, and both are replay-safe: `node_registered`
 * projects a row at status `pending`, so re-emitting one for a node that is
 * *already* pending changes nothing a later event has to undo. A node at any
 * other status is deliberately left alone — re-registering it would reset a
 * status the log has already moved past.
 */
function registerNodes(
  journal: Journal,
  runId: string,
  workflow: Workflow,
  status: StatusOf,
  diff: WorkflowDiff,
): void {
  const waves = computeWaves(workflow.nodes)
  const projected = new Map(journal.nodes(runId).map((row) => [row.node_id, row]))
  const added = new Set(diff.added)

  for (const node of workflow.nodes) {
    const row = projected.get(node.id)
    const harness = node.harness ?? workflow.defaults.harness
    const wave = waves.get(node.id) ?? 1
    const isNew = added.has(node.id) || row === undefined
    if (!isNew && (status(node.id) !== 'pending' || (row.wave === wave && row.harness === harness))) {
      continue
    }
    journal.append({ runId, nodeId: node.id, type: 'node_registered', payload: { wave, harness } })
  }
}

function countAmendments(journal: Journal, runId: string): number {
  return journal.events(runId).filter((event) => event.type === 'workflow_amended').length
}

/**
 * §5.3's run directory. `Journal` publishes its root and its gate log paths
 * but not this, and the layout is the spec's rather than either file's — so it
 * is spelled once here rather than reached for through a private field.
 */
function runDir(journal: Journal, runId: string): string {
  return join(journal.root, 'runs', runId)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'rebase failed'
}
