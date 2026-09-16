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
  /**
   * The id carries the plan's date, and it is the same date.
   *
   * `ai-plans/` holds every feature this repo has ever planned, and the three
   * files of one feature only sit together if they share that prefix — which
   * they only do if the id is derived from the plan rather than written
   * separately. A literal assertion on the id would not notice the two drifting
   * apart, because both would still be perfectly legal strings.
   *
   * The case difference is deliberate and is asserted too: the markdown
   * convention is `UPPERCASE_WITH_UNDERSCORES` and the id must be lowercase
   * kebab-case, so they share the prefix and nothing else.
   */
  it('prefixes the id with its plan’s date, so the three files sort together', () => {
    const workflow = parsed()
    const date = /^(\d{4}-\d{2}-\d{2})-/.exec(workflow.id)?.[1]
    expect(date).toBeDefined()
    expect(workflow.plan_ref).toContain(`ai-plans/${date as string}-`)
    // The stem is the filename the daemon resolves, so the schema's id rule is
    // also a filename rule: anything else is a workflow `serve` cannot list.
    expect(workflow.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('parses and cross-validates with no issues', () => {
    const workflow = parsed()
    expect(workflow.id).toBe('2026-03-04-bookmark-folders')
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

  it('anchors plan-level context at the plan’s own Goals and Guiding Decisions', () => {
    // Both anchors point into the same plan the phase briefs come from, and both
    // are references rather than a second copy of the prose — the whole reason
    // the field is anchors is that a copy drifts from the plan it summarises.
    const workflow = parsed()
    expect(workflow.plan_context_refs).toEqual([
      `${workflow.plan_ref}#1-goals`,
      `${workflow.plan_ref}#2-guiding-decisions`,
    ])
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

  it('forks a database per role, and gives the two roles different names', () => {
    // A lane's copy is named from `name` and the lane, never from the role, so
    // `dev` and `test` sharing one `name` would collapse to one forked database
    // and one template. The skill states that; this is what states it here.
    const project = parsed().project
    expect(project?.migrate_cmd).toBeTruthy()

    const dev = project?.databases.dev
    const test = project?.databases.test
    expect(dev?.engine).toBe('postgres')
    expect(test?.engine).toBe('postgres')
    if (dev?.engine !== 'postgres' || test?.engine !== 'postgres') throw new Error('unreachable')

    expect(dev.name).not.toBe(test.name)
    expect(dev.connection_url_var).not.toBe(test.connection_url_var)
    // A committed file beside the plan: the env var is a name, the server a host.
    for (const db of [dev, test]) expect(db.server_url).not.toMatch(/@/)
  })

  it('staffs every node off the roster, with no per-node model anywhere', () => {
    const workflow = parsed()

    // The roster is the only place a model id appears for a phase. A node
    // carrying its own would be an id to re-check on the next model bump, and
    // a second answer to "what runs this phase".
    expect(workflow.nodes.filter((node) => node.model !== undefined)).toEqual([])
    expect(workflow.nodes.map((node) => node.crew)).toEqual([
      'tier1',
      'tier2-1',
      'tier2-2',
      'tier2-2',
      'tier1',
    ])
    expect(workflow.defaults.pipeline).toBe('standard-phase')
  })

  /**
   * Lanes are bought with concurrency, and concurrency is capped by the widest
   * wave. The roster is *not* capped there — this example is deliberately three
   * members wide on a graph that is two — so asserting them equal would enforce
   * a rule the skill does not state and this example disproves.
   */
  /**
   * The roster is not capped at the widest wave: a member can earn their place
   * by being cheaper rather than by adding a lane. This example is three
   * implementers on a graph that is two phases wide, which is exactly that
   * case — so the assertion is a lower bound, not an equality.
   */
  it('staffs at least as many implementers as the widest wave needs', () => {
    const workflow = parsed()
    const perWave = new Map<number, number>()
    for (const wave of computeWaves(workflow.nodes).values()) {
      perWave.set(wave, (perWave.get(wave) ?? 0) + 1)
    }
    const widest = Math.max(...perWave.values())
    const built = Object.values(workflow.crew).filter(
      (member) => member.role === 'implementer',
    ).length

    expect(built).toBeGreaterThanOrEqual(widest)
  })

  /**
   * The check that caught this example the first time it was written. A wave of
   * two Tier 2 phases needs *two members at Tier 2 or above* — a Tier 1 member on the
   * roster does not help, because the floor forbids handing them one. Sorting
   * both sides and comparing one for one is the whole rule.
   */
  it('can staff every wave without dropping a phase below its tier', () => {
    const workflow = parsed()
    const waves = computeWaves(workflow.nodes)
    const tiers = Object.values(workflow.crew)
      .map((member) => member.tier)
      .sort((a, b) => a - b)

    const byWave = new Map<number, number[]>()
    for (const node of workflow.nodes) {
      const wave = waves.get(node.id) as number
      const tier = workflow.crew[node.crew ?? '']?.tier as number
      byWave.set(wave, [...(byWave.get(wave) ?? []), tier])
    }

    for (const [wave, demand] of byWave) {
      const wanted = [...demand].sort((a, b) => a - b)
      // The N most capable members against the N phases, hardest first.
      const available = tiers.slice(tiers.length - wanted.length)
      wanted.forEach((tier, i) => {
        expect(
          available[i],
          `wave ${wave} wants a tier ${tier} hand and the roster’s ${i + 1}th spare is lower`,
        ).toBeGreaterThanOrEqual(tier)
      })
    }
  })

  it('assigns a phase to every implementer, and staffs a reviewer for all of them', () => {
    const workflow = parsed()
    const assigned = new Set(workflow.nodes.map((node) => node.crew))
    const entries = Object.entries(workflow.crew)

    for (const [id, member] of entries) {
      if (member.role === 'implementer') expect(assigned.has(id)).toBe(true)
    }

    // The roles are disjoint, which is what makes an agent reading its own diff
    // unrepresentable rather than merely unlikely.
    const reviewersOnRoster = entries.filter(([, member]) => member.role === 'reviewer')
    expect(reviewersOnRoster.length).toBeGreaterThan(0)
    for (const [id] of reviewersOnRoster) expect(assigned.has(id)).toBe(false)

    // A reviewer's tier is a floor too: one below the hardest phase could never
    // be picked for it, and the plan would silently fall back to the project
    // default for that phase.
    const hardest = Math.max(
      ...workflow.nodes.map((node) => workflow.crew[node.crew ?? '']?.tier ?? 0),
    )
    expect(Math.max(...reviewersOnRoster.map(([, member]) => member.tier))).toBeGreaterThanOrEqual(
      hardest,
    )
  })

  /**
   * An implementer keeps one worktree — and therefore one session — for the
   * whole run, so the pool is sized by how many implementers there are rather
   * than by how many phases can run at once. The idle desks are the price of
   * the sessions the busy ones carry, and this example is deliberately a case
   * where the two numbers differ.
   *
   * Reviewers add nothing to it: a review runs in the lane it is reviewing, so
   * that it reads the working tree before anything is committed.
   */
  it('gives a desk to every implementer and none to the reviewer', () => {
    const workflow = parsed()
    const built = Object.values(workflow.crew).filter(
      (member) => member.role === 'implementer',
    ).length

    expect(workflow.resources['lane']?.capacity).toBe(built)
    expect(built).toBeLessThan(Object.keys(workflow.crew).length)
  })

  /**
   * The Tier 1 phases are the ones with exact precedent, and they are the two
   * the Crew table names for `tier1`. A plan that staffed the migration to a
   * Tier 2 member would still parse — this asserts the example demonstrates the rubric it
   * is printed next to.
   */
  it('gives the exact-precedent phases to the cheapest tier', () => {
    const workflow = parsed()
    const tierOf = (id: string): number | undefined =>
      workflow.crew[workflow.nodes.find((node) => node.id === id)?.crew ?? '']?.tier

    expect(tierOf('p1')).toBe(1)
    expect(tierOf('p5')).toBe(1)
    expect(tierOf('p2')).toBe(2)
  })
})
