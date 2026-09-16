/**
 * Who a merge conflict is handed to.
 *
 * Every way this can be wrong is silent. A conflict between two Tier 4 phases
 * resolved by the default-tier model does not throw — it produces a merge that
 * compiles, passes the gate, and quietly keeps whichever side the junior model
 * found easier to read. The whole point of the roster is that work of that
 * difficulty is not given to that model, so these assert the *model the adapter
 * was spawned with*, which is the only place the decision becomes observable.
 *
 * Fast on purpose: no git, no worktrees. Selection is a fold over journal rows
 * and a roster, and the spawn is a `MockAdapter` — the real-git conflict loop
 * around it is `integration.test.ts`, and it is not what these are about.
 */
import { describe, expect, it } from 'vitest'

import type { AgentTask } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import type { ConflictRequest } from '../src/integration/fixer.ts'
import { createCrewConflictFixer, seniorImplementer } from '../src/integration/staffing.ts'
import type { StoredEvent } from '../src/journal/events.ts'
import type { CrewMember } from '../src/types.ts'

let nextId = 0

/** One `node_crew` row, as the scheduler journals it at the claim. */
function claim(nodeId: string, payload: Record<string, unknown>): StoredEvent {
  nextId += 1
  return {
    id: nextId,
    ts: 1_000 + nextId,
    runId: 'r1',
    nodeId,
    type: 'node_crew',
    payload,
  } as StoredEvent
}

const member = (tier: number, model: string, harness?: string): CrewMember =>
  ({ role: 'implementer', tier, model, ...(harness === undefined ? {} : { harness }) }) as CrewMember

/** A roster with one member per tier, so "most senior" has a single answer. */
const ROSTER: Readonly<Record<string, CrewMember>> = {
  junior: member(1, 'cheap-model'),
  senior: member(4, 'expensive-model'),
  peer: member(4, 'other-expensive-model'),
}

const request = (nodes: readonly string[]): ConflictRequest => ({
  cwd: '/tmp/integration',
  into: 'plan/p/wave-1',
  incoming: `plan/p/phase-${nodes[nodes.length - 1] as string}`,
  nodeId: nodes[nodes.length - 1] as string,
  nodes,
  paths: ['src/app.ts'],
  promptRefs: nodes.map((id) => `plan.md#${id}`),
  round: 1,
})

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('seniorImplementer', () => {
  it('takes the highest tier among the nodes in conflict', () => {
    const staff = seniorImplementer(
      [
        claim('a', { member: 'junior', tier: 1, substitute: false }),
        claim('b', { member: 'senior', tier: 4, substitute: false }),
      ],
      ['a', 'b'],
      ROSTER,
    )

    expect(staff?.member).toBe('senior')
    expect(staff?.model).toBe('expensive-model')
    expect(staff?.implemented).toEqual(['b'])
  })

  /**
   * The plan's staffing and the run's staffing diverge whenever a named member
   * was busy, and it is the member who *ran* whose code is in the branch. A
   * selection that read `instead_of` would hand the conflict to an agent that
   * never wrote a line of either side.
   */
  it('resolves a substituted node to the member who actually ran', () => {
    const staff = seniorImplementer(
      [
        claim('a', { member: 'junior', tier: 1, substitute: false }),
        claim('b', { member: 'senior', tier: 4, substitute: true, instead_of: 'junior' }),
      ],
      ['a', 'b'],
      ROSTER,
    )

    expect(staff?.member).toBe('senior')
    expect(staff?.implemented).toEqual(['b'])
  })

  /** A retried node is claimed again; the branch is what the last attempt left. */
  it('takes the last claim on a node, not the first', () => {
    const staff = seniorImplementer(
      [
        claim('a', { member: 'senior', tier: 4, substitute: false }),
        claim('a', { member: 'junior', tier: 1, substitute: false }),
      ],
      ['a'],
      ROSTER,
    )

    expect(staff?.member).toBe('junior')
  })

  /** A reviewer read the phase. The implementer wrote the code in conflict. */
  it('ignores reviewer claims', () => {
    const staff = seniorImplementer(
      [
        claim('a', { member: 'junior', tier: 1, substitute: false }),
        claim('a', { member: 'senior', tier: 4, substitute: false, role: 'reviewer' }),
      ],
      ['a'],
      ROSTER,
    )

    expect(staff?.member).toBe('junior')
  })

  /**
   * Two phases staffed at the same tier is the common case, not an edge one.
   * It breaks on id, the way `roster()` breaks its own ties, so two runs of one
   * plan cannot cost differently for a reason nobody can see.
   */
  it('breaks a tier tie on member id, stably', () => {
    const rows = [
      claim('a', { member: 'senior', tier: 4, substitute: false }),
      claim('b', { member: 'peer', tier: 4, substitute: false }),
    ]
    expect(seniorImplementer(rows, ['a', 'b'], ROSTER)?.member).toBe('peer')
    // Same answer whichever order the conflict presents the nodes in.
    expect(seniorImplementer(rows, ['b', 'a'], ROSTER)?.member).toBe('peer')
  })

  it('declines when there are no rows, and when a member left the roster', () => {
    expect(seniorImplementer([], ['a', 'b'], ROSTER)).toBeNull()
    expect(
      seniorImplementer([claim('a', { member: 'gone', tier: 4, substitute: false })], ['a'], ROSTER),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

describe('the crew conflict fixer', () => {
  it('spawns the senior implementing member’s model, on their harness', async () => {
    const claudeAdapter = new MockAdapter({ id: 'claude' })
    const codexAdapter = new MockAdapter({ id: 'codex' })
    const fixer = createCrewConflictFixer({
      adapters: { claude: claudeAdapter, codex: codexAdapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: { junior: member(1, 'cheap-model'), senior: member(4, 'expensive-model', 'codex') },
      crewAssignments: () => [
        claim('a', { member: 'junior', tier: 1, substitute: false }),
        claim('b', { member: 'senior', tier: 4, substitute: false }),
      ],
    })

    await fixer.fix(request(['a', 'b']))

    // The whole point: the model, not the default. The harness override took
    // the spawn to the other adapter entirely.
    expect(claudeAdapter.spawned).toHaveLength(0)
    expect(codexAdapter.spawned).toHaveLength(1)
    const task = codexAdapter.spawned[0] as AgentTask
    expect(task.model).toBe('expensive-model')
    expect(task.cwd).toBe('/tmp/integration')
    // Told which side is its own, and that it may not trust that as memory.
    expect(task.prompt).toContain('You implemented b')
    expect(task.prompt).toContain('fresh')
  })

  /**
   * The pre-roster path. Every plan written before rosters existed has an empty
   * crew, and must keep resolving conflicts exactly as it did.
   */
  it('falls back to defaults on an unstaffed workflow', async () => {
    const adapter = new MockAdapter({ id: 'claude' })
    const fixer = createCrewConflictFixer({
      adapters: { claude: adapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: {},
      crewAssignments: () => [],
    })

    await fixer.fix(request(['a', 'b']))

    const task = adapter.spawned[0] as AgentTask
    expect(task.model).toBe('default-model')
    // Nothing to claim about who wrote what, so the prompt claims nothing.
    expect(task.prompt).not.toContain('You implemented')
  })

  /** A staffed run whose conflict happens to name nodes nobody is on record for. */
  it('falls back to defaults when no node in the conflict resolves to a member', async () => {
    const adapter = new MockAdapter({ id: 'claude' })
    const fixer = createCrewConflictFixer({
      adapters: { claude: adapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: ROSTER,
      crewAssignments: () => [claim('z', { member: 'senior', tier: 4, substitute: false })],
    })

    await fixer.fix(request(['a', 'b']))

    expect((adapter.spawned[0] as AgentTask).model).toBe('default-model')
  })

  /**
   * A member's `harness` is only honoured if the run built that adapter. The
   * model is the half of the decision that matters, so a run handed one
   * injected adapter still gets the senior member's model through it.
   */
  it('keeps the senior model when their harness has no adapter', async () => {
    const adapter = new MockAdapter({ id: 'claude' })
    const fixer = createCrewConflictFixer({
      adapters: { claude: adapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: { senior: member(4, 'expensive-model', 'codex') },
      crewAssignments: () => [claim('a', { member: 'senior', tier: 4, substitute: false })],
    })

    await fixer.fix(request(['a']))

    expect((adapter.spawned[0] as AgentTask).model).toBe('expensive-model')
  })

  /**
   * The constraint the whole design turns on. The member's session ran in their
   * lane; this runs in the integration worktree, where the files in dispute are
   * half-merged and unlike anything that session saw. §15.2 would refuse the
   * resume (`lane_changed` is its first rule) — but the fixer must not ask for
   * one, because asking encodes the wrong intent for the next reader.
   */
  it('never resumes a session into the integration worktree', async () => {
    const adapter = new MockAdapter({ id: 'claude' })
    const fixer = createCrewConflictFixer({
      adapters: { claude: adapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: ROSTER,
      crewAssignments: () => [
        claim('a', { member: 'junior', tier: 1, substitute: false }),
        claim('b', { member: 'senior', tier: 4, substitute: false }),
      ],
    })

    await fixer.fix(request(['a', 'b']))

    expect((adapter.spawned[0] as AgentTask).resumeSessionId).toBeUndefined()
  })

  /**
   * No adapter at all: the merge exhausts its rounds and stops as the plan
   * defect it is. The orchestrator resolves nothing itself.
   */
  it('is a no-op with no adapters', async () => {
    const fixer = createCrewConflictFixer({
      adapters: {},
      defaults: { harness: 'claude', model: 'default-model' },
      crew: ROSTER,
      crewAssignments: () => [],
    })

    await expect(fixer.fix(request(['a']))).resolves.toBeUndefined()
  })
})
