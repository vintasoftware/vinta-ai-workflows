/**
 * Cross-reference validation — everything JSON Schema structurally cannot say.
 *
 * A shape-valid workflow can still be unrunnable: a dependency naming a node
 * that does not exist, a cycle, a gate requiring a pool nobody declared. Those
 * are caught here, and every issue carries a path so the error points at the
 * offending line rather than at the document.
 */
import { findCycle } from './graph.ts'
import { BUILT_IN_PIPELINES } from './pipeline/standard.ts'
import { type Workflow, WorkflowSchema } from './types.ts'

export interface ValidationIssue {
  /** JSON path to the offending value, e.g. `['nodes', 2, 'depends_on', 0, 'node']`. */
  readonly path: readonly (string | number)[]
  readonly message: string
}

export type ParseResult =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

/** Cross-reference checks over an already shape-valid workflow. */
export function validateWorkflow(workflow: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeIds = new Set<string>()
  // A workflow may name a pipeline the package ships instead of authoring one.
  const pipelineIds = new Set([
    ...Object.keys(workflow.pipelines),
    ...Object.keys(BUILT_IN_PIPELINES),
  ])
  const gateIds = new Set(Object.keys(workflow.gates))
  const choreIds = new Set(Object.keys(workflow.chores))
  const resourceIds = new Set(Object.keys(workflow.resources))
  const crewIds = new Set(Object.keys(workflow.crew))
  const staffed = crewIds.size > 0
  const crewImplementers = new Set(
    Object.entries(workflow.crew)
      .filter(([, member]) => member.role === 'implementer')
      .map(([id]) => id),
  )
  /** Members some node actually named. Filled by the node pass below. */
  const employed = new Set<string>()
  /** The tiers phases are assigned at, for the reviewer-reachability check. */
  const assignedTiers: number[] = []

  if (!resourceIds.has('lane')) {
    issues.push({
      path: ['resources'],
      message: 'a `lane` pool is required — it is what phases are dispatched into',
    })
  }

  if (!pipelineIds.has(workflow.defaults.pipeline)) {
    issues.push({
      path: ['defaults', 'pipeline'],
      message: `unknown pipeline "${workflow.defaults.pipeline}"`,
    })
  }

  for (const [gateId, gate] of Object.entries(workflow.gates)) {
    gate.requires.forEach((resource, i) => {
      if (!resourceIds.has(resource)) {
        issues.push({
          path: ['gates', gateId, 'requires', i],
          message: `unknown resource pool "${resource}"`,
        })
      }
    })
  }

  // A chore with neither instruction is an agent turn with nothing to do, and a
  // chore with both leaves nothing to say which one the agent is handed. Both
  // are shape rules in spirit; they live here because expressing "exactly one
  // of these two" in zod means a refinement, and a refinement is not something
  // `z.toJSONSchema` can put in the generated document.
  for (const [choreId, chore] of Object.entries(workflow.chores)) {
    const declared = [chore.prompt, chore.prompt_ref].filter((text) => text !== undefined).length
    if (declared !== 1) {
      issues.push({
        path: ['chores', choreId],
        message:
          declared === 0
            ? `chore "${choreId}" declares neither \`prompt\` nor \`prompt_ref\``
            : `chore "${choreId}" declares both \`prompt\` and \`prompt_ref\` — keep one`,
      })
    }
  }

  workflow.defaults.chores.forEach((chore, i) => {
    if (!choreIds.has(chore)) {
      issues.push({ path: ['defaults', 'chores', i], message: `unknown chore "${chore}"` })
    }
  })

  workflow.nodes.forEach((node, i) => {
    if (nodeIds.has(node.id)) {
      issues.push({ path: ['nodes', i, 'id'], message: `duplicate node id "${node.id}"` })
    }
    nodeIds.add(node.id)

    if (node.pipeline !== undefined && !pipelineIds.has(node.pipeline)) {
      issues.push({ path: ['nodes', i, 'pipeline'], message: `unknown pipeline "${node.pipeline}"` })
    }

    node.gates.forEach((gate, j) => {
      if (!gateIds.has(gate)) {
        issues.push({ path: ['nodes', i, 'gates', j], message: `unknown gate "${gate}"` })
      }
    })

    // Only what the node itself named: a bad id in `defaults.chores` is already
    // reported once above, and reporting it again per node would bury the one
    // line that says where to fix it under one line per phase on the plan.
    node.chores?.forEach((chore, j) => {
      if (!choreIds.has(chore)) {
        issues.push({ path: ['nodes', i, 'chores', j], message: `unknown chore "${chore}"` })
      }
    })

    if (node.crew !== undefined) {
      if (!crewIds.has(node.crew)) {
        issues.push({
          path: ['nodes', i, 'crew'],
          message: `unknown crew member "${node.crew}"`,
        })
      } else if (!crewImplementers.has(node.crew)) {
        // The whole point of the two roles: a reviewer that can be handed a
        // phase is a reviewer that can end up reading its own diff.
        issues.push({
          path: ['nodes', i, 'crew'],
          message: `crew member "${node.crew}" is a reviewer and cannot be assigned a phase`,
        })
      }
      employed.add(node.crew)
      const tier = workflow.crew[node.crew]?.tier
      if (tier !== undefined) assignedTiers.push(tier)

      // Both would answer "which model runs this phase", and nothing says which
      // wins. The roster is the answer a staffed workflow is asking for, so the
      // node-level override has to go rather than be quietly outranked.
      if (node.model !== undefined) {
        issues.push({
          path: ['nodes', i, 'model'],
          message:
            `node "${node.id}" sets both \`model\` and \`crew\` — a crew member carries ` +
            'a model, so drop the override or drop the assignment',
        })
      }
    } else if (staffed) {
      // Half a roster is worse than none: the scheduler would run two staffing
      // rules at once, and the plan's own idleness arithmetic would be wrong.
      issues.push({
        path: ['nodes', i, 'crew'],
        message: `node "${node.id}" names no crew member, but this workflow is staffed`,
      })
    }
  })

  if (staffed) {
    // A roster of reviewers with nobody to write the code. Reachable by editing
    // a role and nothing else, and the resulting run would refuse every node.
    if (crewImplementers.size === 0) {
      issues.push({ path: ['crew'], message: 'no crew member has role "implementer"' })
    }

    // A reviewer qualifies for a phase when its tier is at or above the
    // phase's, so the easiest phase on the plan is the bar it has to clear.
    const easiest = assignedTiers.length === 0 ? 0 : Math.min(...assignedTiers)
    for (const [memberId, member] of Object.entries(workflow.crew)) {
      if (member.role === 'implementer') {
        // An implementer nobody was assigned to is an agent the plan pays to
        // watch. It is the exact defect a roster exists to make visible, so it
        // is refused rather than warned about.
        if (!employed.has(memberId)) {
          issues.push({
            path: ['crew', memberId],
            message: `crew member "${memberId}" is assigned no node`,
          })
        }
        continue
      }

      // A reviewer is idle in the same way when it is below every phase: the
      // floor is the author's tier, so it would never be picked for any of them.
      if (member.tier < easiest) {
        issues.push({
          path: ['crew', memberId],
          message:
            `reviewer "${memberId}" is tier ${member.tier}, below every phase on this ` +
            `plan (the easiest is tier ${easiest}) — it would never be picked`,
        })
      }
    }
  }

  // Dependencies are checked in a second pass so forward references resolve.
  workflow.nodes.forEach((node, i) => {
    node.depends_on.forEach((dep, j) => {
      if (dep.node === node.id) {
        issues.push({
          path: ['nodes', i, 'depends_on', j, 'node'],
          message: `node "${node.id}" depends on itself`,
        })
      } else if (!nodeIds.has(dep.node)) {
        issues.push({
          path: ['nodes', i, 'depends_on', j, 'node'],
          message: `unknown node "${dep.node}"`,
        })
      }
    })
  })

  const cycle = findCycle(workflow.nodes)
  if (cycle) {
    issues.push({ path: ['nodes'], message: `dependency cycle: ${cycle.join(' → ')}` })
  }

  for (const [pipelineId, pipeline] of Object.entries(workflow.pipelines)) {
    const stateIds = new Set<string>()
    pipeline.states.forEach((state, i) => {
      if (stateIds.has(state.id)) {
        issues.push({
          path: ['pipelines', pipelineId, 'states', i, 'id'],
          message: `duplicate state id "${state.id}"`,
        })
      }
      stateIds.add(state.id)
    })

    pipeline.transitions.forEach((transition, i) => {
      for (const end of ['from', 'to'] as const) {
        if (!stateIds.has(transition[end])) {
          issues.push({
            path: ['pipelines', pipelineId, 'transitions', i, end],
            message: `unknown state "${transition[end]}"`,
          })
        }
      }
    })

    for (const key of ['initialStateIds', 'finalStateIds'] as const) {
      pipeline[key].forEach((stateId, i) => {
        if (!stateIds.has(stateId)) {
          issues.push({
            path: ['pipelines', pipelineId, key, i],
            message: `unknown state "${stateId}"`,
          })
        }
      })
    }
  }

  return issues
}

/** Shape parse followed by cross-reference validation. */
export function parseWorkflow(input: unknown): ParseResult {
  const shape = WorkflowSchema.safeParse(input)
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map((issue) => ({
        // zod types paths as PropertyKey[]; symbols can't occur for JSON input.
        path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
        message: issue.message,
      })),
    }
  }

  const issues = validateWorkflow(shape.data)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, workflow: shape.data }
}

/** One issue per line, `nodes[2].depends_on[0].node: unknown node "p9"`. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map(({ path, message }) => {
      const location = path.reduce<string>(
        (acc, segment) =>
          typeof segment === 'number' ? `${acc}[${segment}]` : acc === '' ? segment : `${acc}.${segment}`,
        '',
      )
      return `${location === '' ? '(root)' : location}: ${message}`
    })
    .join('\n')
}
