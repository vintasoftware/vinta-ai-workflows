/**
 * Who a merge conflict is handed to.
 *
 * Every way this can be wrong is silent. A conflict between two Tier 4 phases
 * resolved by the default-tier model does not throw — it produces a merge that
 * compiles, passes the gate, and quietly keeps whichever side the lower-tier
 * model found easier to read. The whole point of the roster is that work of
 * that difficulty is not given to that model, so these assert the *model the
 * adapter was spawned with*, which is the only place the decision becomes
 * observable.
 *
 * Fast on purpose: no git, no worktrees. Selection is a fold over journal rows
 * and a roster, and the spawn is a `MockAdapter` — the real-git conflict loop
 * around it is `integration.test.ts`, and it is not what these are about.
 */
import { describe, expect, it } from 'vitest'

import type { AgentTask } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import type { ConflictRequest } from '../src/integration/fixer.ts'
import { createCrewConflictFixer, highestTierImplementer } from '../src/integration/staffing.ts'
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

/** A roster with one member per tier, so "highest tier" has a single answer. */
const ROSTER: Readonly<Record<string, CrewMember>> = {
  tier1: member(1, 'cheap-model'),
  tier4: member(4, 'expensive-model'),
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

describe('highestTierImplementer', () => {
  it('takes the highest tier among the nodes in conflict', () => {
    const staff = highestTierImplementer(
      [
        claim('a', { member: 'tier1', tier: 1, substitute: false }),
        claim('b', { member: 'tier4', tier: 4, substitute: false }),
      ],
      ['a', 'b'],
      ROSTER,
    )

    expect(staff?.member).toBe('tier4')
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
    const staff = highestTierImplementer(
      [
        claim('a', { member: 'tier1', tier: 1, substitute: false }),
        claim('b', { member: 'tier4', tier: 4, substitute: true, instead_of: 'tier1' }),
      ],
      ['a', 'b'],
      ROSTER,
    )

    expect(staff?.member).toBe('tier4')
    expect(staff?.implemented).toEqual(['b'])
  })

  /** A retried node is claimed again; the branch is what the last attempt left. */
  it('takes the last claim on a node, not the first', () => {
    const staff = highestTierImplementer(
      [
        claim('a', { member: 'tier4', tier: 4, substitute: false }),
        claim('a', { member: 'tier1', tier: 1, substitute: false }),
      ],
      ['a'],
      ROSTER,
    )

    expect(staff?.member).toBe('tier1')
  })

  /** A reviewer read the phase. The implementer wrote the code in conflict. */
  it('ignores reviewer claims', () => {
    const staff = highestTierImplementer(
      [
        claim('a', { member: 'tier1', tier: 1, substitute: false }),
        claim('a', { member: 'tier4', tier: 4, substitute: false, role: 'reviewer' }),
      ],
      ['a'],
      ROSTER,
    )

    expect(staff?.member).toBe('tier1')
  })

  /**
   * Two phases staffed at the same tier is the common case, not an edge one.
   * It breaks on id, the way `roster()` breaks its own ties, so two runs of one
   * plan cannot cost differently for a reason nobody can see.
   */
  it('breaks a tier tie on member id, stably', () => {
    const rows = [
      claim('a', { member: 'tier4', tier: 4, substitute: false }),
      claim('b', { member: 'peer', tier: 4, substitute: false }),
    ]
    expect(highestTierImplementer(rows, ['a', 'b'], ROSTER)?.member).toBe('peer')
    // Same answer whichever order the conflict presents the nodes in.
    expect(highestTierImplementer(rows, ['b', 'a'], ROSTER)?.member).toBe('peer')
  })

  it('declines when there are no rows, and when a member left the roster', () => {
    expect(highestTierImplementer([], ['a', 'b'], ROSTER)).toBeNull()
    expect(
      highestTierImplementer([claim('a', { member: 'gone', tier: 4, substitute: false })], ['a'], ROSTER),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

describe('the crew conflict fixer', () => {
  it('spawns the highest-tier implementing member’s model, on their harness', async () => {
    const claudeAdapter = new MockAdapter({ id: 'claude' })
    const codexAdapter = new MockAdapter({ id: 'codex' })
    const fixer = createCrewConflictFixer({
      adapters: { claude: claudeAdapter, codex: codexAdapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: { tier1: member(1, 'cheap-model'), tier4: member(4, 'expensive-model', 'codex') },
      crewAssignments: () => [
        claim('a', { member: 'tier1', tier: 1, substitute: false }),
        claim('b', { member: 'tier4', tier: 4, substitute: false }),
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
      crewAssignments: () => [claim('z', { member: 'tier4', tier: 4, substitute: false })],
    })

    await fixer.fix(request(['a', 'b']))

    expect((adapter.spawned[0] as AgentTask).model).toBe('default-model')
  })

  /**
   * A member's `harness` is only honoured if the run built that adapter. The
   * model is the half of the decision that matters, so a run handed one
   * injected adapter still gets that member's model through it.
   */
  it('keeps the highest-tier member’s model when their harness has no adapter', async () => {
    const adapter = new MockAdapter({ id: 'claude' })
    const fixer = createCrewConflictFixer({
      adapters: { claude: adapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: { tier4: member(4, 'expensive-model', 'codex') },
      crewAssignments: () => [claim('a', { member: 'tier4', tier: 4, substitute: false })],
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
        claim('a', { member: 'tier1', tier: 1, substitute: false }),
        claim('b', { member: 'tier4', tier: 4, substitute: false }),
      ],
    })

    await fixer.fix(request(['a', 'b']))

    expect((adapter.spawned[0] as AgentTask).resumeSessionId).toBeUndefined()
  })

  /**
   * The fixer is an agent standing in a worktree, and an agent without its
   * tree's environment resolves `docker compose` to whatever the daemon's shell
   * says. With `COMPOSE_PROJECT_NAME` unset docker names the project after the
   * directory, and the `compose.publish: []` override that lives in
   * `COMPOSE_FILE` is not read at all — so a fix round brought a second stack
   * up and published the project's fixed ports on the host, where they collided
   * with the developer's own and outlived the run.
   *
   * Asserted on the spawned task rather than through the compose files, because
   * the task is where the wiring either happened or did not.
   */
  it('spawns with the integration worktree’s environment', async () => {
    const adapter = new MockAdapter({ id: 'claude' })
    const env = {
      COMPOSE_PROJECT_NAME: 'r1-integ',
      COMPOSE_FILE: 'compose.yaml:/lanes/r1-integ/.maestro-compose.yaml',
      DATABASE_URL: 'postgres://localhost/r1_integ',
      MAESTRO_RUN: 'r1',
    }
    const fixer = createCrewConflictFixer({
      adapters: { claude: adapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: ROSTER,
      env,
      crewAssignments: () => [claim('a', { member: 'tier4', tier: 4, substitute: false })],
    })

    await fixer.fix(request(['a']))

    expect((adapter.spawned[0] as AgentTask).env).toEqual(env)
  })

  /**
   * The environment belongs to the worktree, not to whoever is spawned into it,
   * so the staffed path and the `defaults` path must carry the identical one. A
   * fixer that only got its environment when the roster could name a member
   * would leave every pre-roster plan publishing ports on the host.
   */
  it('carries the same environment on the unstaffed fallback', async () => {
    const adapter = new MockAdapter({ id: 'claude' })
    const env = { COMPOSE_PROJECT_NAME: 'r1-integ' }
    const fixer = createCrewConflictFixer({
      adapters: { claude: adapter },
      defaults: { harness: 'claude', model: 'default-model' },
      crew: {},
      env,
      crewAssignments: () => [],
    })

    await fixer.fix(request(['a', 'b']))

    const task = adapter.spawned[0] as AgentTask
    expect(task.model).toBe('default-model')
    expect(task.env).toEqual(env)
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
