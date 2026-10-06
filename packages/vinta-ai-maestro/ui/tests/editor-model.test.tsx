/**
 * The editor's translations, without a DOM.
 *
 * Two properties are asserted here rather than through the screen, because
 * they are properties of the data and not of the rendering: that no edit ever
 * mutates the workflow it was given, and that a pipeline survives a round trip
 * through the state machine editor's shape unchanged.
 */
import { expect, test } from 'vitest'
import { addEdge, type Dag } from 'vinta-dag-editor/src/index.ts'
import { EFFECT_CATALOG } from '../../src/pipeline/effects.ts'
import { STANDARD_PHASE } from '../../src/pipeline/standard.ts'
import { WorkflowSchema, type Workflow } from '../../src/types.ts'
import { parseWorkflow } from '../../src/validate.ts'
import {
  addDependency,
  applyDag,
  EFFECT_DEFINITIONS,
  edgeRefusal,
  fromMachine,
  patchDependency,
  patchNode,
  setPipeline,
  toDag,
  toMachine,
  usesShippedPipeline,
} from '../src/editor-model.ts'

function workflow(): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'billing',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    gates: { unit: { cmd: 'pnpm test', requires: [] } },
    nodes: [
      { id: 'p1', name: 'Model', prompt_ref: 'plan.md#p1', gates: ['unit'] },
      {
        id: 'p2',
        name: 'API',
        prompt_ref: 'plan.md#p2',
        depends_on: [{ node: 'p1', artifact: 'the BookmarkFolder model' }],
      },
    ],
  })
}

test('the plan graph round-trips through the canvas shape', () => {
  const before = workflow()
  const after = applyDag(before, toDag(before))
  expect(after).toEqual(before)
  expect(after).not.toBe(before)
})

test('an edge label is the dependency artifact', () => {
  expect(toDag(workflow()).edges).toEqual([
    { id: 'p1-p2', from: 'p1', to: 'p2', artifact: 'the BookmarkFolder model' },
  ])
})

test('adding a node produces a new workflow and leaves the input alone', () => {
  const before = workflow()
  const snapshot = structuredClone(before)
  const dag: Dag = {
    ...toDag(before),
    nodes: [...toDag(before).nodes, { id: 'p3', name: 'New node', status: 'pending', wave: 1 }],
  }

  const after = applyDag(before, dag)
  expect(after).not.toBe(before)
  expect(before).toEqual(snapshot)
  expect(after.nodes.map((node) => node.id)).toEqual(['p1', 'p2', 'p3'])
  // A node the canvas invented cannot carry a phase brief, so it does not
  // pretend to: the workflow is invalid until someone supplies one.
  expect(after.nodes[2]?.prompt_ref).toBe('')
})

test('drawing a dependency carries its artifact into the workflow', () => {
  const before = workflow()
  const snapshot = structuredClone(before)
  const withNode = applyDag(before, {
    ...toDag(before),
    nodes: [...toDag(before).nodes, { id: 'p3', name: 'UI', status: 'pending', wave: 1 }],
  })

  const added = addDependency(withNode, 'p2', 'p3', 'the CRUD endpoints')
  if (!added.ok) throw new Error('the dependency was refused')
  expect(added.workflow).not.toBe(withNode)
  expect(before).toEqual(snapshot)
  expect(added.workflow.nodes[2]?.depends_on).toEqual([
    { node: 'p2', artifact: 'the CRUD endpoints' },
  ])
})

test('deleting an edge produces a new workflow with the dependency gone', () => {
  const before = workflow()
  const snapshot = structuredClone(before)
  const dag = toDag(before)

  const after = applyDag(before, { ...dag, edges: [] })
  expect(after).not.toBe(before)
  expect(before).toEqual(snapshot)
  expect(after.nodes[1]?.depends_on).toEqual([])
  // The fields the canvas never saw survive the edit.
  expect(after.nodes[0]?.gates).toEqual(['unit'])
})

test('the component refuses an edge that would make a cycle, and says which rule', () => {
  const dag = toDag(workflow())
  expect(addEdge(dag, 'p2', 'p1', 'anything')).toBe(null)
  expect(edgeRefusal(dag, 'p2', 'p1')).toBe('cycle')
  expect(edgeRefusal(dag, 'p1', 'p1')).toBe('self')
  expect(edgeRefusal(dag, 'p1', 'p2')).toBe('duplicate')
  expect(edgeRefusal(dag, 'p1', 'p2')).not.toBe(null)
})

test('a dependency with no artifact fails validation at its own path', () => {
  const before = workflow()
  const blanked = patchDependency(before, 'p2', 0, '')
  expect(before.nodes[1]?.depends_on[0]?.artifact).toBe('the BookmarkFolder model')

  const parsed = parseWorkflow(blanked)
  if (parsed.ok) throw new Error('an empty artifact was accepted')
  expect(parsed.issues.map((issue) => issue.path)).toContainEqual([
    'nodes',
    1,
    'depends_on',
    0,
    'artifact',
  ])
})

test('patching a node never touches the original, and undefined clears an override', () => {
  const before = patchNode(workflow(), 'p1', { harness: 'codex', model: 'sonnet' })
  expect(before.nodes[0]?.harness).toBe('codex')

  const cleared = patchNode(before, 'p1', { harness: undefined })
  expect(before.nodes[0]?.harness).toBe('codex')
  expect('harness' in (cleared.nodes[0] ?? {})).toBe(false)
  expect(cleared.nodes[0]?.model).toBe('sonnet')
})

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

test('a workflow with no pipelines uses the shipped one', () => {
  const before = workflow()
  expect(before.pipelines).toEqual({})
  expect(usesShippedPipeline(before, 'standard-phase')).toBe(true)

  const authored = setPipeline(before, 'standard-phase', STANDARD_PHASE)
  expect(usesShippedPipeline(authored, 'standard-phase')).toBe(false)
  // Authoring an override is a new workflow; the one it came from is untouched.
  expect(before.pipelines).toEqual({})
  expect(parseWorkflow(authored).ok).toBe(true)

  expect(setPipeline(authored, 'standard-phase', null).pipelines).toEqual({})
})

test('a pipeline round-trips through the state machine editor shape', () => {
  expect(fromMachine(toMachine(STANDARD_PHASE))).toEqual(STANDARD_PHASE)
})

test('the state machine editor sees the workflow pipeline as a machine', () => {
  const machine = toMachine(STANDARD_PHASE)
  expect(machine.initialStateIds).toEqual(['implement'])
  expect(machine.finalStateIds).toEqual(['done', 'failed'])
  // Our one effect list becomes the editor's ordered `before` hook.
  const implement = machine.states.find((state) => state.id === 'implement')
  expect(implement?.onEnter.before.map((effect) => effect.definitionId)).toEqual([
    'git_branch',
    'spawn_agent',
  ])
  expect(implement?.onEnter.after).toEqual([])
  expect(
    machine.transitions.find((transition) => transition.id === 't-review-pass')?.guard,
  ).toBe("review.verdict == 'pass'")
})

test('the effect palette is EFFECT_CATALOG', () => {
  expect(EFFECT_DEFINITIONS.map((definition) => definition.id)).toEqual(
    Object.keys(EFFECT_CATALOG),
  )
  expect(EFFECT_DEFINITIONS.find((definition) => definition.id === 'run_gate')?.description).toBe(
    EFFECT_CATALOG.run_gate.description,
  )
})
