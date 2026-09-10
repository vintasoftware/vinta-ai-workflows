/**
 * The worked example in `plan-feature`'s "Emit the executable workflow" section
 * is a document a prompt is told to produce, so the only thing that can be
 * verified here is the document itself: that it parses, and that its graph is
 * the same graph as the Execution graph table the same section shows.
 *
 * `tests/fixtures/plan-feature-example.workflow.json` is a byte-for-byte copy
 * of that example. When the skill's example changes, this fixture changes with
 * it — a drift between them is the failure this file exists to catch, since a
 * skill that instructs an unrunnable emission fails silently in every consumer
 * project and nowhere here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeWaves } from '../src/graph.ts'
import { formatIssues, parseWorkflow } from '../src/validate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const example = (): unknown =>
  JSON.parse(readFileSync(join(HERE, 'fixtures', 'plan-feature-example.workflow.json'), 'utf8'))

/** Parse, or fail with the located issues rather than a bare boolean. */
const parsed = () => {
  const result = parseWorkflow(example())
  if (!result.ok) throw new Error(`expected valid, got:\n${formatIssues(result.issues)}`)
  return result.workflow
}

/**
 * The Execution graph table as the example plan prints it, transcribed. Phase
 * numbers, not node ids — the transcription is from the human table, and the
 * `Phase N` → `pN` mapping is itself part of what the skill specifies.
 */
const EXECUTION_GRAPH: readonly { wave: number; phases: string[]; dependsOn: string[] }[] = [
  { wave: 1, phases: ['Phase 1'], dependsOn: [] },
  { wave: 2, phases: ['Phase 2', 'Phase 3'], dependsOn: ['Phase 1'] },
  { wave: 3, phases: ['Phase 4'], dependsOn: ['Phase 2', 'Phase 3'] },
  { wave: 4, phases: ['Phase 5'], dependsOn: ['Phase 2', 'Phase 3', 'Phase 4'] },
]

/** `Phase 4a` → `p4a`, the id rule the skill states. */
const nodeId = (phase: string): string => `p${phase.replace(/^Phase /, '').toLowerCase()}`

describe('plan-feature worked example', () => {
  it('parses and cross-validates with no issues', () => {
    const workflow = parsed()
    expect(workflow.id).toBe('bookmark-folders')
    expect(workflow.nodes).toHaveLength(5)
  })

  it('declares the canonical $schema so editors validate the emitted file', () => {
    expect((example() as { $schema: string }).$schema).toBe(
      'https://github.com/vintasoftware/vinta-ai-workflows/schemas/workflow.v1.schema.json',
    )
  })

  it('has exactly the nodes the table lists', () => {
    const expected = EXECUTION_GRAPH.flatMap(({ phases }) => phases.map(nodeId))
    expect(parsed().nodes.map((node) => node.id)).toEqual(expected)
  })

  it('has exactly the edges the table implies', () => {
    // A wave row lists the union of what that wave depends on, so the check is
    // per row: the union of its nodes' `depends_on` must be that row, no more
    // (an undeclared edge in the table) and no less (an edge the table hides).
    const workflow = parsed()
    const depsOf = new Map(
      workflow.nodes.map((node) => [node.id, node.depends_on.map((dep) => dep.node)]),
    )

    for (const { phases, dependsOn } of EXECUTION_GRAPH) {
      const union = new Set(phases.flatMap((phase) => depsOf.get(nodeId(phase)) ?? []))
      expect([...union].sort()).toEqual(dependsOn.map(nodeId).sort())
    }
  })

  it('lands every phase in the wave the table puts it in', () => {
    const expected = Object.fromEntries(
      EXECUTION_GRAPH.flatMap(({ wave, phases }) => phases.map((phase) => [nodeId(phase), wave])),
    )

    expect(Object.fromEntries(computeWaves(parsed().nodes))).toEqual(expected)
  })

  it('names an artifact on every edge, which is what the implementer prompt reads', () => {
    for (const node of parsed().nodes) {
      for (const dep of node.depends_on) {
        expect(dep.artifact.length).toBeGreaterThan(0)
        // A bare id restated as prose is the smell the artifact string exists to catch.
        expect(dep.artifact).not.toBe(dep.node)
      }
    }
  })

  it('points every prompt_ref at its own phase anchor in the plan it was emitted beside', () => {
    const workflow = parsed()
    for (const node of workflow.nodes) {
      expect(node.prompt_ref).toBe(
        `${workflow.plan_ref}#phase-${node.id.replace(/^p/, '')}`,
      )
    }
  })

  it('declares a lane pool and queues the suite gate behind a semaphore', () => {
    const workflow = parsed()
    expect(workflow.resources.lane?.kind).toBe('worktree')
    expect(workflow.gates.unit?.requires).toEqual(['test-suite'])
    expect(workflow.resources['test-suite']?.capacity).toBe(1)
  })

  it('gives every node a Touch List and the gates it must pass', () => {
    for (const node of parsed().nodes) {
      expect(node.touches.length).toBeGreaterThan(0)
      expect(node.gates).toEqual(['types', 'unit'])
    }
  })

  it('overrides the model only where the phase tier differs from the default', () => {
    const workflow = parsed()
    const overridden = workflow.nodes.filter((node) => node.model !== undefined).map((n) => n.id)
    // p1 (migration) and p5 (flag deletion) are Tier 1; the rest sit on the default.
    expect(overridden).toEqual(['p1', 'p5'])
    expect(workflow.defaults.pipeline).toBe('standard-phase')
  })
})
