import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  computeWaves,
  findCycle,
  transitiveDependents,
  type GraphNode,
} from '../src/graph.ts'
import { buildSchema } from '../src/schema/build.ts'
import { pipelineFor, STANDARD_PHASE } from '../src/pipeline/standard.ts'
import { formatIssues, parseWorkflow } from '../src/validate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

const golden = (): Record<string, any> =>
  JSON.parse(readFileSync(join(HERE, 'fixtures', 'golden-workflow.json'), 'utf8'))

/** Parse and assert failure, returning the formatted issues for matching. */
const expectInvalid = (doc: unknown): string => {
  const result = parseWorkflow(doc)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  return formatIssues(result.issues)
}

describe('golden workflow', () => {
  it('parses and validates', () => {
    const result = parseWorkflow(golden())
    if (!result.ok) throw new Error(`expected valid, got:\n${formatIssues(result.issues)}`)
    expect(result.workflow.id).toBe('bookmark-folders')
    expect(result.workflow.nodes).toHaveLength(4)
  })

  it('applies defaults for omitted optional fields', () => {
    const result = parseWorkflow(golden())
    if (!result.ok) throw new Error('expected valid')

    const p1 = result.workflow.nodes[0]
    expect(p1?.depends_on).toEqual([])
    expect(p1?.max_fix_rounds).toBe(2)
    expect(result.workflow.gates.types?.requires).toEqual([])
  })

  it('is the diamond its waves imply', () => {
    const result = parseWorkflow(golden())
    if (!result.ok) throw new Error('expected valid')

    const waves = computeWaves(result.workflow.nodes)
    expect(Object.fromEntries(waves)).toEqual({ p1: 1, p2: 2, p3: 2, p4: 3 })
  })
})

describe('graph', () => {
  // Explicit graphs, not the workflow fixture: these are pure graph operations
  // and shouldn't fail when the fixture's shape changes.
  const graph = (...edges: [string, string[]][]): GraphNode[] =>
    edges.map(([id, deps]) => ({ id, depends_on: deps.map((node) => ({ node })) }))

  it('reports no cycle on a diamond', () => {
    expect(findCycle(graph(['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]))).toBeNull()
  })

  it('reports no cycle on a disconnected graph', () => {
    expect(findCycle(graph(['a', []], ['b', []], ['c', ['b']]))).toBeNull()
  })

  it('locates a cycle and names the nodes on it', () => {
    const cycle = findCycle(graph(['a', ['c']], ['b', ['a']], ['c', ['b']]))
    expect(cycle).not.toBeNull()
    expect(cycle).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    // The entry node is repeated so the loop reads as a closed path.
    expect(cycle?.at(0)).toBe(cycle?.at(-1))
  })

  it('ignores dangling dependencies, which are the validator’s business', () => {
    expect(findCycle(graph(['a', ['ghost']]))).toBeNull()
  })

  it('takes the longest path, not the shortest, when both reach a node', () => {
    // d depends on a directly AND through b → c, so it must land in wave 4.
    const waves = computeWaves(graph(['a', []], ['b', ['a']], ['c', ['b']], ['d', ['a', 'c']]))
    expect(Object.fromEntries(waves)).toEqual({ a: 1, b: 2, c: 3, d: 4 })
  })

  it('refuses to compute waves on a cyclic graph', () => {
    expect(() => computeWaves(graph(['a', ['b']], ['b', ['a']]))).toThrow(/cyclic/)
  })
})

describe('cross-reference validation', () => {
  it('locates an unknown node id at its exact path', () => {
    const doc = golden()
    doc.nodes[1].depends_on = [{ node: 'p9', artifact: 'a phase that does not exist' }]

    expect(expectInvalid(doc)).toContain('nodes[1].depends_on[0].node: unknown node "p9"')
  })

  it('rejects a node depending on itself', () => {
    const doc = golden()
    doc.nodes[1].depends_on = [{ node: 'p2', artifact: 'itself' }]

    expect(expectInvalid(doc)).toContain('depends on itself')
  })

  it('rejects a dependency cycle and names the loop', () => {
    const doc = golden()
    // p1 ← p4 closes the diamond into a loop.
    doc.nodes[0].depends_on = [{ node: 'p4', artifact: 'circular by construction' }]

    const issues = expectInvalid(doc)
    expect(issues).toContain('dependency cycle')
    expect(issues).toContain('p1')
    expect(issues).toContain('p4')
  })

  it('rejects duplicate node ids', () => {
    const doc = golden()
    doc.nodes[2].id = 'p2'

    expect(expectInvalid(doc)).toContain('duplicate node id "p2"')
  })

  it('requires a lane pool', () => {
    const doc = golden()
    delete doc.resources.lane

    expect(expectInvalid(doc)).toContain('a `lane` pool is required')
  })

  it('locates an unknown gate on a node', () => {
    const doc = golden()
    doc.nodes[0].gates = ['types', 'smoke']

    expect(expectInvalid(doc)).toContain('nodes[0].gates[1]: unknown gate "smoke"')
  })

  it('locates an unknown chore on a node', () => {
    const doc = golden()
    doc.chores = { deslop: { prompt: 'Rewrite the comments.' } }
    doc.nodes[0].chores = ['deslop', 'changelog']

    expect(expectInvalid(doc)).toContain('nodes[0].chores[1]: unknown chore "changelog"')
  })

  it('locates an unknown chore in the run-wide defaults', () => {
    const doc = golden()
    doc.defaults.chores = ['deslop']

    expect(expectInvalid(doc)).toContain('defaults.chores[0]: unknown chore "deslop"')
  })

  it('refuses a chore with no instruction at all', () => {
    const doc = golden()
    doc.chores = { deslop: { skill: 'deslop-comments' } }

    expect(expectInvalid(doc)).toContain('declares neither `prompt` nor `prompt_ref`')
  })

  it('refuses a chore that declares both instructions, since nothing says which wins', () => {
    const doc = golden()
    doc.chores = { deslop: { prompt: 'Rewrite them.', prompt_ref: 'ai-plans/PLAN.md#deslop' } }

    expect(expectInvalid(doc)).toContain('declares both `prompt` and `prompt_ref`')
  })

  it('locates a gate requiring an undeclared resource pool', () => {
    const doc = golden()
    doc.gates.unit.requires = ['gpu']

    expect(expectInvalid(doc)).toContain('gates.unit.requires[0]: unknown resource pool "gpu"')
  })

  it('locates an unknown pipeline', () => {
    const doc = golden()
    doc.defaults.pipeline = 'nope'

    expect(expectInvalid(doc)).toContain('defaults.pipeline: unknown pipeline "nope"')
  })

  it('locates a transition pointing at a state that does not exist', () => {
    const doc = golden()
    doc.pipelines['standard-phase'].transitions[0].to = 'nowhere'

    expect(expectInvalid(doc)).toContain(
      'pipelines.standard-phase.transitions[0].to: unknown state "nowhere"',
    )
  })
})

describe('shape validation', () => {
  it('rejects unknown top-level keys', () => {
    const doc = golden()
    doc.parallelism = 4

    expect(expectInvalid(doc)).toMatch(/parallelism|Unrecognized/)
  })

  it('requires an artifact on every dependency', () => {
    const doc = golden()
    doc.nodes[1].depends_on = [{ node: 'p1' }]

    expect(expectInvalid(doc)).toContain('nodes[1].depends_on[0].artifact')
  })

  it('rejects a wrong schema_version', () => {
    const doc = golden()
    doc.schema_version = 2

    expect(expectInvalid(doc)).toContain('schema_version')
  })
})

describe('the crew roster', () => {
  /** The golden workflow, staffed: four nodes, three members, nobody idle. */
  const staffed = (): Record<string, any> => {
    const doc = golden()
    doc.crew = {
      tier1: { tier: 1, model: 'cheap-1' },
      tier2: { tier: 2, model: 'medium-1' },
      tier4: { tier: 4, model: 'dear-1' },
    }
    const assignments = ['tier1', 'tier2', 'tier2', 'tier4']
    doc.nodes.forEach((node: Record<string, unknown>, i: number) => {
      delete node['model']
      node['crew'] = assignments[i]
    })
    return doc
  }

  it('parses a staffed workflow and keeps every assignment', () => {
    const result = parseWorkflow(staffed())
    if (!result.ok) throw new Error(`expected valid, got:\n${formatIssues(result.issues)}`)

    expect(Object.keys(result.workflow.crew)).toHaveLength(3)
    expect(result.workflow.nodes.map((node) => node.crew)).toEqual([
      'tier1',
      'tier2',
      'tier2',
      'tier4',
    ])
  })

  it('leaves an unstaffed workflow alone — the roster is opt-in', () => {
    const result = parseWorkflow(golden())
    if (!result.ok) throw new Error('expected valid')

    expect(result.workflow.crew).toEqual({})
    expect(result.workflow.nodes.every((node) => node.crew === undefined)).toBe(true)
  })

  it('locates an assignment to somebody who is not on the roster', () => {
    const doc = staffed()
    doc.nodes[1].crew = 'principal'

    expect(expectInvalid(doc)).toContain('nodes[1].crew: unknown crew member "principal"')
  })

  /**
   * The defect a roster exists to make visible. A member nobody was assigned to
   * is an agent the plan budgeted for and never used, and it is also the shape
   * of a plan whose widest wave is narrower than its author thought.
   */
  it('rejects a member who is assigned no node', () => {
    const doc = staffed()
    doc.crew['spare'] = { tier: 3, model: 'medium-1' }

    expect(expectInvalid(doc)).toContain('crew.spare: crew member "spare" is assigned no node')
  })

  /**
   * Half a roster would leave the scheduler running two staffing rules at once,
   * and would make the plan's own idleness arithmetic wrong.
   */
  it('rejects a node that names no member in a staffed workflow', () => {
    const doc = staffed()
    delete doc.nodes[2].crew

    const issues = expectInvalid(doc)
    expect(issues).toContain('nodes[2].crew')
    expect(issues).toContain('names no crew member')
  })

  it('rejects a node carrying both a model override and an assignment', () => {
    const doc = staffed()
    doc.nodes[0].model = 'something-else'

    expect(expectInvalid(doc)).toContain('nodes[0].model')
  })

  it('rejects a tier outside the rubric', () => {
    const doc = staffed()
    doc.crew.tier4.tier = 5

    expect(expectInvalid(doc)).toContain('crew.tier4.tier')
  })
})

describe('the project block', () => {
  const withProject = (project: unknown): Record<string, any> => {
    const doc = golden()
    doc.project = project
    return doc
  }

  it('is optional — a workflow that omits it is unchanged', () => {
    const result = parseWorkflow(golden())
    if (!result.ok) throw new Error('expected valid')
    expect(result.workflow.project).toBeUndefined()
    // And it is not required of the document either.
    expect((buildSchema() as { required: string[] }).required).not.toContain('project')
  })

  it('accepts the two forked databases a lane can carry', () => {
    const result = parseWorkflow(
      withProject({
        migrate_cmd: 'pnpm migrate',
        databases: {
          dev: {
            engine: 'postgres',
            delivery: 'external',
            name: 'app',
            server_url: 'postgres://localhost:5432',
            connection_url_var: 'DATABASE_URL',
          },
          test: { engine: 'sqlite', path: 'db.test.sqlite3', connection_url_var: 'TEST_DATABASE_URL' },
        },
      }),
    )
    if (!result.ok) throw new Error(`expected valid, got:\n${formatIssues(result.issues)}`)
    expect(result.workflow.project?.databases.dev?.engine).toBe('postgres')
    expect(result.workflow.project?.databases.test?.engine).toBe('sqlite')
  })

  it('takes a project that declares no database at all', () => {
    const result = parseWorkflow(withProject({ migrate_cmd: 'pnpm migrate' }))
    if (!result.ok) throw new Error('expected valid')
    expect(result.workflow.project?.databases).toEqual({})
  })

  it('rejects a database whose delivery the pool has no strategy for', () => {
    const issues = expectInvalid(
      withProject({
        migrate_cmd: 'pnpm migrate',
        databases: {
          dev: {
            engine: 'postgres',
            delivery: 'kubernetes',
            name: 'app',
            server_url: 'postgres://localhost:5432',
            connection_url_var: 'DATABASE_URL',
          },
        },
      }),
    )
    expect(issues).toContain('project.databases.dev')
  })

  it('rejects an engine nothing in `src/lanes/` knows how to fork', () => {
    expect(
      expectInvalid(
        withProject({
          migrate_cmd: 'pnpm migrate',
          databases: { dev: { engine: 'mysql', name: 'app', connection_url_var: 'DATABASE_URL' } },
        }),
      ),
    ).toContain('project.databases.dev')
  })

  it('rejects a lane role nobody provisions', () => {
    expect(
      expectInvalid(
        withProject({
          migrate_cmd: 'pnpm migrate',
          databases: {
            staging: { engine: 'sqlite', path: 'db.sqlite3', connection_url_var: 'DATABASE_URL' },
          },
        }),
      ),
    ).toMatch(/staging|Unrecognized/)
  })
})

describe('generated schema', () => {
  it('matches the committed schemas/workflow.v1.schema.json', () => {
    const committed = readFileSync(join(REPO_ROOT, 'schemas', 'workflow.v1.schema.json'), 'utf8')
    expect(committed).toBe(`${JSON.stringify(buildSchema(), null, 2)}\n`)
  })

  it('declares Draft 2020-12 and closes the object', () => {
    const schema = buildSchema()
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.description).toContain('GENERATED')
  })

  it('leaves defaulted fields optional, since it validates authored documents', () => {
    const schema = buildSchema() as { required: string[] }
    expect(schema.required).toContain('nodes')
    expect(schema.required).not.toContain('gates')
  })
})

// ---------------------------------------------------------------------------
// Failure containment (§6): a failed node blocks exactly its dependents.
// ---------------------------------------------------------------------------

const graph = (edges: Readonly<Record<string, readonly string[]>>): GraphNode[] =>
  Object.entries(edges).map(([id, deps]) => ({
    id,
    depends_on: deps.map((node) => ({ node })),
  }))

describe('transitiveDependents', () => {
  it('walks a chain to the end, excluding the node itself', () => {
    const nodes = graph({ a: [], b: ['a'], c: ['b'] })

    expect(transitiveDependents(nodes, 'a')).toEqual(['b', 'c'])
    expect(transitiveDependents(nodes, 'b')).toEqual(['c'])
    expect(transitiveDependents(nodes, 'c')).toEqual([])
  })

  it('reports a diamond join once, breadth first', () => {
    const nodes = graph({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] })

    expect(transitiveDependents(nodes, 'a')).toEqual(['b', 'c', 'd'])
    expect(transitiveDependents(nodes, 'b')).toEqual(['d'])
  })

  it('leaves an unrelated component alone', () => {
    const nodes = graph({ a: [], b: ['a'], c: [], d: ['c'] })

    expect(transitiveDependents(nodes, 'a')).toEqual(['b'])
    expect(transitiveDependents(nodes, 'c')).toEqual(['d'])
  })

  it('terminates on a cycle instead of walking it forever', () => {
    const nodes = graph({ a: ['c'], b: ['a'], c: ['b'] })

    expect(transitiveDependents(nodes, 'a').sort()).toEqual(['b', 'c'])
  })

  it('ignores a dependency on a node that is not in the graph', () => {
    const nodes = graph({ a: ['ghost'], b: ['a'] })

    expect(transitiveDependents(nodes, 'a')).toEqual(['b'])
    expect(transitiveDependents(nodes, 'ghost')).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Built-in pipelines: a workflow may name one the package ships instead of
// carrying a verbatim copy of it.
// ---------------------------------------------------------------------------

describe('built-in pipelines', () => {
  it('accepts a workflow that omits `pipelines` and names a shipped one', () => {
    const doc = golden()
    delete doc.pipelines
    doc.defaults.pipeline = 'standard-phase'

    const result = parseWorkflow(doc)
    if (!result.ok) throw new Error(`expected valid, got:\n${formatIssues(result.issues)}`)
    expect(result.workflow.pipelines).toEqual({})
  })

  it('still rejects a pipeline nobody ships and nobody declared', () => {
    const doc = golden()
    delete doc.pipelines
    doc.defaults.pipeline = 'not-a-real-pipeline'

    expect(expectInvalid(doc)).toContain('unknown pipeline "not-a-real-pipeline"')
  })

  it('lets a declared pipeline shadow the built-in of the same name', () => {
    const doc = golden()
    // The fixture already declares its own `standard-phase`; it must win, so a
    // project that needs a different lifecycle is never silently overridden.
    const result = parseWorkflow(doc)
    if (!result.ok) throw new Error('expected valid')

    const declared = result.workflow.pipelines['standard-phase']
    expect(declared).toBeDefined()
    expect(pipelineFor(result.workflow, 'standard-phase')).toBe(declared)
  })

  it('falls back to the shipped pipeline when none is declared', () => {
    expect(pipelineFor({ pipelines: {} }, 'standard-phase')).toBe(STANDARD_PHASE)
    expect(pipelineFor({ pipelines: {} }, 'nope')).toBeUndefined()
  })
})
