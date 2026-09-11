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
  const resourceIds = new Set(Object.keys(workflow.resources))

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
  })

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
