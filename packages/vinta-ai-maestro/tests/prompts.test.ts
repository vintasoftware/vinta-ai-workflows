/**
 * Prompt composition: what each role is actually told.
 *
 * Every other test in this suite injects a mock adapter or a recording
 * executor, so none of them ever exercised what a real agent is handed. That is
 * how `spawn_agent`'s `prompt_template` reached a release consumed by nothing
 * and every role received `node.prompt_ref` as its entire prompt — an
 * implementer copes, a reviewer never states the verdict the executor reads,
 * and the node burns its fix rounds on a review nobody asked for.
 *
 * Two assertions here are about correctness rather than wording:
 *
 * - **A sibling's work is never in an implementer's context.** The diamond
 *   below is the case: a wave-2 node is told about its own dependency and
 *   nothing about the phase running beside it, whose commits are not in its
 *   base branch.
 * - **The reviewer's verdict line is asserted against the executor's own
 *   parser**, by feeding the exact line the prompt demands through
 *   `RunEffectExecutor`. A copy of the regex here would agree with itself
 *   forever while the two halves drifted apart.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createRunExecutor } from '../src/executor/index.ts'
import { Integrator } from '../src/integration/integrator.ts'
import { openJournal, type NodeRow } from '../src/journal/journal.ts'
import type { EffectInvocation } from '../src/pipeline/effects.ts'
import {
  composeConflictPrompt,
  composeSpawnPrompt,
  dependencyClosure,
  PromptError,
  readVerdict,
  resolveBrief,
  VERDICT_MARKER,
  type ChorePrompt,
  type PromptJournal,
  type Reorientation,
} from '../src/prompts/index.ts'
import { ChoreSchema, SideEffectSchema, WorkflowSchema, type Workflow } from '../src/types.ts'

const RUN_ID = 'run-1'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/**
 * The diamond: one root, two phases that run in parallel off it, one that joins
 * them. `api-layer` and `web-ui` are the siblings — neither may ever appear in
 * the other's context.
 */
function diamond(): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'bookmarks',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
    resources: { lane: { capacity: 2, kind: 'worktree' } },
    gates: { unit: { cmd: 'pnpm test', requires: [] } },
    nodes: [
      { id: 'db-schema', name: 'Schema', prompt_ref: 'plan.md#db-schema' },
      {
        id: 'api-layer',
        name: 'API',
        prompt_ref: 'plan.md#api-layer',
        gates: ['unit'],
        depends_on: [{ node: 'db-schema', artifact: 'the Folder model' }],
      },
      {
        id: 'web-ui',
        name: 'Web UI',
        prompt_ref: 'plan.md#web-ui',
        depends_on: [{ node: 'db-schema', artifact: 'the Folder model' }],
      },
      {
        id: 'docs',
        name: 'Docs',
        prompt_ref: 'plan.md#docs',
        depends_on: [
          { node: 'api-layer', artifact: 'the /folders endpoints' },
          { node: 'web-ui', artifact: 'the folder tree component' },
        ],
      },
    ],
  })
}

/**
 * The two plan-level sections `plan_context_refs` points at, written into the
 * same plan file the phase briefs come from. Headings as `plan-feature`'s "Plan
 * structure" numbers them, which is what makes their anchors knowable.
 */
const PLAN_SECTIONS = {
  '1. Goals': [
    '1. Let a user group bookmarks into folders.',
    '',
    'Non-goals:',
    '- Sharing a folder with another user.',
    '- Paginating the folder tree.',
  ].join('\n'),
  '2. Guiding Decisions': [
    '| Decision | Resolution |',
    '|---|---|',
    '| **Storage shape** | Adjacency list on `parent_id` — writes dominate reads. |',
  ].join('\n'),
} as const

const GOALS_REF = 'plan.md#1-goals'
const DECISIONS_REF = 'plan.md#2-guiding-decisions'

/** The diamond, plus the plan-level anchors every phase is bounded by. */
function diamondWithPlanContext(): Workflow {
  return WorkflowSchema.parse({
    ...diamond(),
    plan_context_refs: [GOALS_REF, DECISIONS_REF],
  })
}

/** A checkout holding the plan every `prompt_ref` above points at. */
function workspace(sections: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-prompts-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const body = Object.entries({
    'db-schema': 'Add the Folder model and its migration.',
    'api-layer': 'Add REST endpoints for folders.',
    'web-ui': 'Add the folder tree component.',
    docs: 'Document the folders feature.',
    ...sections,
  }).flatMap(([anchor, text]) => [`## ${anchor}`, '', text, ''])
  writeFileSync(join(dir, 'plan.md'), `${body.join('\n')}\n`)
  return dir
}

/** The journal as prompt composition reads it: final reports, and node rows. */
function journalStub(options: {
  readonly reports?: Readonly<Record<string, string>>
  readonly rows?: readonly Partial<NodeRow>[]
}): PromptJournal {
  return {
    tailTranscript: (_runId: string, nodeId: string): unknown[] => {
      const report = options.reports?.[nodeId]
      return report === undefined ? [] : [{ type: 'assistant_text', text: report }]
    },
    nodes: (): NodeRow[] =>
      (options.rows ?? []).map((row) => ({
        run_id: RUN_ID,
        node_id: '',
        status: 'running',
        wave: 1,
        lane: null,
        branch: null,
        base_branch: null,
        harness: 'claude-code',
        session_id: null,
        ...row,
      })),
  }
}

/** One composed prompt, with everything defaulted to the diamond's world. */
function compose(
  nodeId: string,
  template: unknown,
  options: {
    readonly workflow?: Workflow
    readonly dir?: string | null
    readonly reports?: Readonly<Record<string, string>>
    readonly rows?: readonly Partial<NodeRow>[]
    readonly facts?: EffectInvocation['context']
    /** §15.3: this turn continues a session that already ran. */
    readonly continuation?: boolean
    /** §15.2: that session last ran on a different node. */
    readonly reorientation?: Reorientation
    /** The chore a `chore`-template turn is running. */
    readonly chore?: ChorePrompt
  } = {},
): string {
  const workflow = options.workflow ?? diamond()
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined) throw new Error(`no node "${nodeId}"`)
  return composeSpawnPrompt({
    template,
    workflow,
    node,
    runId: RUN_ID,
    journal: journalStub({
      ...(options.reports === undefined ? {} : { reports: options.reports }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
    }),
    workspace: options.dir === undefined ? workspace() : options.dir,
    facts: options.facts ?? {},
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
    ...(options.reorientation === undefined ? {} : { reorientation: options.reorientation }),
    ...(options.chore === undefined ? {} : { chore: options.chore }),
  })
}

/** A chore as the scheduler resolves one, with the schema's own defaults on it. */
const chore = (chore: Record<string, unknown>, id = 'deslop'): ChorePrompt => ({
  id,
  chore: ChoreSchema.parse(chore),
})

// ---------------------------------------------------------------------------
// 1. The implementer gets the brief itself
// ---------------------------------------------------------------------------

describe('the implementer prompt', () => {
  it('carries the phase brief resolved from prompt_ref, not the reference', () => {
    const prompt = compose('db-schema', 'implementer')

    expect(prompt).toContain('Add the Folder model and its migration.')
    expect(prompt).toContain('You are implementing db-schema: Schema of plan bookmarks')
    // The reference is where the brief lives, not something to hand an agent.
    expect(prompt.trim()).not.toBe('plan.md#db-schema')
  })

  it('names the lane, the branch and the base the phase was cut from', () => {
    const dir = workspace()
    const prompt = compose('api-layer', 'implementer', {
      dir,
      rows: [
        {
          node_id: 'api-layer',
          branch: 'plan/bookmarks/phase-api-layer',
          base_branch: 'plan/bookmarks/phase-db-schema',
        },
      ],
    })

    expect(prompt).toContain(dir)
    expect(prompt).toContain('plan/bookmarks/phase-api-layer')
    expect(prompt).toContain('plan/bookmarks/phase-db-schema')
  })

  it('tells a phase with no dependencies that it starts from the base branch', () => {
    expect(compose('db-schema', 'implementer')).toContain(
      'Nothing yet — this phase starts from `main`.',
    )
  })

  /**
   * It used to assert the gate's declared command line was printed. That is
   * what the implementers were running by hand — outside the cache, outside the
   * pool, and four times a phase before the gate node ran it a fifth. The id
   * and the verb are the whole listing now; the command stays on the daemon's
   * side, which is the point of the verb.
   */
  it('names the gates the phase has to survive, as the command that runs one', () => {
    const prompt = compose('api-layer', 'implementer')

    expect(prompt).toContain('`vinta-ai-maestro gate unit`')
    expect(prompt).not.toContain('unit: `pnpm test`')
  })
})

/**
 * A phase ran four sessions, reported `## Status: SUCCESS` with a green inner
 * loop, and never once ran `git commit`. Its deliverables were untracked files.
 * The reviewer reads the committed diff, so it reported "phase not implemented
 * at all"; the fixer re-implemented, also without committing; the fix rounds
 * ran out; and the lane was then recycled and the files deleted.
 *
 * Every instruction that agent had was *about* committing — "never commit while
 * a gate is red" — and not one of them said it had to. An agent that reads its
 * instructions carefully and never commits was following them.
 */
describe('committing is part of the work', () => {
  const writers = ['implementer', 'fixer'] as const

  it.each(writers)('tells the %s the phase is judged on commits', (role) => {
    const prompt = compose('api-layer', role)

    expect(prompt).toContain('Committing is part of the work, not after it')
    expect(prompt).toContain('git status --porcelain')
    // Named concretely, because "commit your work" is what it already implied.
    expect(prompt).toContain('reviewed and merged **from the commits on')
  })

  it.each(writers)('tells the %s to stage by path, never with -A', (role) => {
    // Projects keep untracked local files at the worktree root — env files the
    // pool copied in, a virtualenv a hook built, a database file — and sweeping
    // those onto the phase branch is its own kind of damage.
    expect(compose('api-layer', role)).toContain('never `git add -A`')
  })

  it('says it again in the continuations, which are the turns that end phases', () => {
    // A delta that dropped this would leave the *last* writer the least told.
    for (const role of writers) {
      expect(compose('api-layer', role, { continuation: true })).toContain(
        'Committing is part of the work',
      )
    }
  })

  it('has the reviewer read the working tree, not only the diff', () => {
    const prompt = compose('api-layer', 'reviewer')

    expect(prompt).toContain('status --porcelain')
    // The distinction that decides whether the fixer writes the code again or
    // simply commits it — and getting it wrong costs every fix round there is.
    expect(prompt).toContain('not "the phase was not')
  })

  /**
   * The prompt used to say both "the turn is not complete until `git status` is
   * empty of your work" and "never commit while a gate is red". Whenever the
   * gate could not be turned green inside the turn — most of why fix rounds
   * exist — that is a contradiction with a `never` on one side, and agents
   * resolved it the way the stronger word points: they committed nothing. The
   * reviewer then found a full tree and an empty diff and raised the BLOCKER it
   * is told to raise, and a fix round went on re-implementing work that was
   * already sitting on the disk.
   */
  describe('a red gate changes the report, not the decision to commit', () => {
    it.each(writers)('never forbids the %s from committing', (role) => {
      for (const prompt of [
        compose('api-layer', role),
        compose('api-layer', role, { continuation: true }),
      ]) {
        expect(prompt).not.toMatch(/[Nn]ever commit/)
        expect(prompt).not.toContain('must all pass before you commit')
      }
    })

    it.each(writers)('tells the %s to commit a phase that failed', (role) => {
      expect(compose('api-layer', role)).toContain('Commit whether or not you succeeded')
    })

    /**
     * The other half. "Where you find uncommitted work, that *is* the finding"
     * made any unclean tree a BLOCKER — and a lane's tree is essentially never
     * clean: the pool copies configuration in, links dependency trees, and the
     * gates the reviewer was just asked to run leave caches and build output
     * behind. The implementer is told by name not to stage any of it, so a
     * phase could be implemented, committed and correct and still fail review
     * for the files the harness itself created around it.
     */
    it('does not let the reviewer fail a committed phase over a dirty lane', () => {
      for (const prompt of [
        compose('api-layer', 'reviewer'),
        compose('api-layer', 'reviewer', { continuation: true }),
      ]) {
        expect(prompt).toContain('not by itself a finding')
        // The narrower failure it is actually for survives.
        expect(prompt).toContain('missing from the diff')
      }
    })
  })
})

/**
 * An implementer started five commands with `run_in_background: true` and ended
 * its turn with "I'll wait for the test result notification before continuing to
 * the outer gate." There is no notification — a headless session ends when the
 * turn ends, and whatever it backgrounded dies with it. Three sessions ended
 * that way, with no report and no commit.
 *
 * Nothing had told it otherwise, and believing a tool that offers backgrounding
 * will still be there afterwards is not an unreasonable thing to believe.
 */
describe('background work', () => {
  const writers = ['implementer', 'fixer'] as const

  it.each(writers)('forbids it to the %s, and says why', (role) => {
    const prompt = compose('api-layer', role)

    expect(prompt).toContain('Run everything in the foreground')
    expect(prompt).toContain('run_in_background')
    // The reason, not only the rule: an agent told a bare "do not" has no way
    // to generalise to the `&` it was about to type instead.
    expect(prompt).toContain('This session is headless')
  })

  it('says it in the continuations too', () => {
    for (const role of writers) {
      expect(compose('api-layer', role, { continuation: true })).toContain(
        'Run everything in the foreground',
      )
    }
  })
})

/**
 * claude-code agents were dispatching their phase to a sub-agent and reporting
 * its summary back. Every role is affected and the cost is cumulative: the
 * session that is kept warm across phases learns nothing, so the reorientation
 * a cross-phase turn opens with — "everything you learned still holds" — holds
 * over a paragraph, and each phase pays a cold agent's first turn again.
 *
 * The conductor skills are named in the prompt and asserted here, because the
 * pull is a skill the runtime surfaced on its own: `implement-phase` ships into
 * these same repositories, its description matches "you are implementing P3 of
 * plan X", and its content is "spawn exactly one implementer subagent".
 */
describe('no sub-agents', () => {
  const roles = ['implementer', 'reviewer', 'fixer', 'chore'] as const

  const composeRole = (role: (typeof roles)[number], continuation: boolean): string =>
    compose('api-layer', role, {
      continuation,
      ...(role === 'chore' ? { chore: chore({ prompt: 'Tidy up.' }) } : {}),
      ...(role === 'fixer' ? { facts: { review: { verdict: 'fail' } } } : {}),
    })

  it.each(roles)('forbids delegation to the %s, and says what it costs', (role) => {
    const prompt = composeRole(role, false)

    expect(prompt).toContain('Do this work in this session, yourself')
    expect(prompt).toContain('Task/Agent tool')
    // The reason, not only the rule. Without it the agent has no way to weigh
    // delegating a search, which is the form it takes once the work is banned.
    expect(prompt).toContain('pays for a cold start')
    // And the skills that are the actual pull, by name.
    expect(prompt).toContain('`implement-phase`')
    expect(prompt).toContain('never follow its spawn steps')
  })

  it.each(roles)('says it to the %s on a continuation too', (role) => {
    expect(composeRole(role, true)).toContain('Do this work in this session, yourself')
  })
})

/**
 * A reused reviewer session reached a verdict in under four minutes without
 * running the project's test command at all. The prompt had asked it to confirm
 * the gate was green, which an agent can do by reading a report.
 */
describe('the reviewer runs the gates', () => {
  it('asks the cold reviewer to run them and report what they returned', () => {
    const prompt = compose('api-layer', 'reviewer')

    expect(prompt).toContain('you run these yourself and read what they print')
    expect(prompt).toContain('is a claim, not evidence')
    expect(prompt).toContain('Say in your report that you ran them')
  })

  it('asks again every round, because the tree has moved', () => {
    const prompt = compose('api-layer', 'reviewer', { continuation: true })

    expect(prompt).toContain('Run these again yourself, every round')
    expect(prompt).toContain('`vinta-ai-maestro gate unit`')
    // And the working tree with them: the round after a fix is the likeliest
    // place to find work that was written and never committed.
    expect(prompt).toContain('status --porcelain')
  })
})

// ---------------------------------------------------------------------------
// 1a. The project's own commands
// ---------------------------------------------------------------------------

/**
 * An agent told to "run the scoped suite" and given no command runs the one it
 * knows. In a project whose suite only runs as `docker compose run --rm api
 * python -m pytest …`, a bare `pytest` fails against a database it cannot see,
 * for reasons that have nothing to do with the phase's code — and the agent
 * then debugs *that*, with its fix rounds.
 *
 * So the project states its commands and every agent that will run something is
 * handed them, with the one instruction that matters: these exactly, not the
 * tool underneath them.
 */
describe('the project’s commands', () => {
  const withCommands = (): Workflow => {
    const base = diamond()
    return WorkflowSchema.parse({
      ...base,
      project: {
        migrate_cmd: 'make migrate',
        commands: {
          lint: 'make lint',
          test: 'make test',
          test_one: 'make test',
          migrate: 'make migrate',
        },
      },
    })
  }

  const roles = ['implementer', 'reviewer', 'fixer'] as const

  it.each(roles)('hands them to the %s, which is who runs them', (role) => {
    const prompt = compose('api-layer', role, { workflow: withCommands() })

    expect(prompt).toContain('The project’s commands')
    expect(prompt).toContain('Lint: `make lint`')
    expect(prompt).toContain('The whole suite: `make test`')
    // Glossed, so the agent knows what each one is *for* — `test_one` takes a
    // target appended to it and `test` does not, and nothing but the gloss says
    // so when both are spelled `make test`.
    expect(prompt).toContain('One test, or one subtree — append the target: `make test`')
  })

  it('tells the implementer to use them rather than the tool underneath', () => {
    const prompt = compose('api-layer', 'implementer', { workflow: withCommands() })

    expect(prompt).toContain('Use these exactly as written')
    // The inner loop points at them by name. An instruction to "run the scoped
    // suite" sitting above a list the agent was never told to use is the same
    // prompt it had before.
    expect(prompt).toContain('through the project’s commands')
  })

  it('omits only the commands the project did not declare', () => {
    const workflow = WorkflowSchema.parse({
      ...diamond(),
      project: { migrate_cmd: 'true', commands: { lint: 'make lint' } },
    })
    const prompt = compose('api-layer', 'implementer', { workflow })

    expect(prompt).toContain('Lint: `make lint`')
    expect(prompt).not.toContain('The whole suite')
  })

  it('changes nothing at all for a workflow that declares none', () => {
    // A field added after a plan was written cannot make that plan's prompts
    // worse. The section disappears, and so does the sentence pointing at it.
    const bare = compose('api-layer', 'implementer')

    expect(bare).not.toContain('The project’s commands')
    expect(bare).toContain('then the scoped suite')
  })
})

describe('agent-held resource leases', () => {
  it.each(['implementer', 'reviewer', 'fixer'] as const)(
    'tells the %s how heavy inner-loop commands reach the pool',
    (role) => {
      const base = diamond()
      const workflow = WorkflowSchema.parse({
        ...base,
        resources: {
          ...base.resources,
          'test-suite': { capacity: 1, kind: 'semaphore' },
        },
      })
      const prompt = compose('api-layer', role, { workflow })

      expect(prompt).toContain('Resource leases for heavy commands')
      expect(prompt).toContain('vinta-ai-maestro with test-suite -- <command>')
      expect(prompt).toContain('Do not run that command bare')
    },
  )

  it('does not advertise a lease when the workflow has only its lane pool', () => {
    expect(compose('api-layer', 'implementer')).not.toContain('Resource leases for heavy commands')
  })
})

// ---------------------------------------------------------------------------
// 1b. Plan-level context: the plan's own bounds, verbatim and labelled
// ---------------------------------------------------------------------------

/**
 * `prompt_ref` gives a phase its body and nothing else, so an implementer that
 * never read the plan's **Non-goals** scope-creeps and one that never read its
 * **Guiding Decisions** re-litigates them. `plan_context_refs` names those
 * sections as file-and-anchor references — the same form `prompt_ref` uses, so
 * one resolver serves both — and they reach the prompt whole.
 *
 * Two properties matter more than the wording:
 *
 * - **Verbatim.** A paraphrased non-goal is a boundary an agent argues with.
 *   The assertions compare against what the resolver itself returns.
 * - **Labelled as the plan's.** Pasted next to a phase brief, "we are not
 *   building X" reads as "build X". So the block is under its own heading,
 *   ahead of the phase's tasks, and says which of the two it is.
 */
describe('plan-level context', () => {
  /** A checkout whose plan carries the phase bodies and the plan-level sections. */
  const planned = (): string => workspace(PLAN_SECTIONS)

  it('carries the plan’s Goals, Non-goals and Guiding Decisions verbatim', () => {
    const dir = planned()
    const prompt = compose('api-layer', 'implementer', {
      dir,
      workflow: diamondWithPlanContext(),
    })

    // Verbatim means exactly what the resolver read, not a rendering of it.
    expect(prompt).toContain(resolveBrief(dir, 'api-layer', GOALS_REF))
    expect(prompt).toContain(resolveBrief(dir, 'api-layer', DECISIONS_REF))
    expect(prompt).toContain('- Sharing a folder with another user.')
    expect(prompt).toContain('| **Storage shape** | Adjacency list on `parent_id` — writes dominate reads. |')
  })

  it('marks it as the plan’s, not the phase’s, and puts it before the tasks', () => {
    const prompt = compose('api-layer', 'implementer', {
      dir: planned(),
      workflow: diamondWithPlanContext(),
    })

    // The framing is the load-bearing part: a non-goal read as a task is the
    // exact failure this section would otherwise introduce.
    expect(prompt).toContain('## Plan-level decisions — the whole plan’s, not this phase’s')
    expect(prompt).toContain('they bound your phase rather than describe it')
    expect(prompt).toContain('do not build it, and do not treat it as a')
    expect(prompt).toContain('is the phase brief further down, and only that.')

    const planLevel = prompt.indexOf('## Plan-level decisions')
    const tasks = prompt.indexOf('## Your tasks (api-layer only)')
    expect(planLevel).toBeGreaterThan(-1)
    expect(tasks).toBeGreaterThan(planLevel)
    // The phase brief still stands on its own, under its own heading.
    expect(prompt.slice(tasks)).toContain('Add REST endpoints for folders.')
  })

  it('gives the reviewer the same sections, framed as what scope creep is measured against', () => {
    const dir = planned()
    const prompt = compose('api-layer', 'reviewer', {
      dir,
      workflow: diamondWithPlanContext(),
    })

    expect(prompt).toContain(resolveBrief(dir, 'api-layer', GOALS_REF))
    expect(prompt).toContain(resolveBrief(dir, 'api-layer', DECISIONS_REF))
    expect(prompt).toContain('## Plan-level decisions — the whole plan’s, not this phase’s')
    expect(prompt).toContain('a change serving a non-goal is scope creep')
    // A reviewer that failed the phase for not delivering the whole plan would
    // be worse than one with no non-goals at all.
    expect(prompt).toContain('ask this diff to satisfy the whole plan')
    expect(prompt.indexOf('## Plan-level decisions')).toBeLessThan(
      prompt.indexOf('## The three layers'),
    )
  })

  it('does not give it to the fixer, whose brief is exactly one list of findings', () => {
    const prompt = compose('api-layer', 'fixer', {
      dir: planned(),
      workflow: diamondWithPlanContext(),
      reports: { 'api-layer': 'BLOCKER: POST /folders does not validate parent_id.' },
      facts: { review: { verdict: 'fail' } },
    })

    expect(prompt).not.toContain('Plan-level decisions')
    expect(prompt).not.toContain('Sharing a folder with another user.')
    expect(prompt).toContain('and nothing else')
  })

  it('composes exactly as before when the workflow names no plan-level context', () => {
    // The whole output, byte for byte: the field's absence may not move a
    // single character of what an implementer was already handed.
    const dir = workspace()
    const prompt = compose('db-schema', 'implementer', { dir })

    expect(prompt).toBe(IMPLEMENTER_WITHOUT_PLAN_CONTEXT(dir))
    expect(prompt).not.toContain('Plan-level')
  })

  it('fails loudly on an anchor that does not resolve, naming the node and the ref', () => {
    const workflow = WorkflowSchema.parse({
      ...diamond(),
      plan_context_refs: ['plan.md#no-such-section'],
    })
    const dir = planned()
    const attempt = (): string => compose('api-layer', 'implementer', { dir, workflow })

    expect(attempt).toThrow(PromptError)
    expect(attempt).toThrow(/node "api-layer".*plan_context_refs.*plan\.md#no-such-section/)
  })

  it('never puts the plan’s text into that error', () => {
    const workflow = WorkflowSchema.parse({
      ...diamond(),
      plan_context_refs: ['plan.md#no-such-section'],
    })
    const dir = planned()

    try {
      compose('api-layer', 'implementer', { dir, workflow })
      expect.unreachable('an unresolvable plan-context anchor must throw')
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain('Sharing a folder with another user.')
      expect(message).not.toContain('Adjacency list')
      expect(message).not.toContain('Add REST endpoints for folders.')
    }
  })
})

/**
 * The implementer prompt with no `plan_context_refs`, lane path parameterised.
 * Pinned rather than described, because "composes exactly as before" is a claim
 * about every character.
 *
 * It is a golden of the *plan-context* feature's blast radius, not a freeze on
 * the prompt: a deliberate change elsewhere in the implementer brief updates
 * this fixture, and what the test still guarantees is that adding or omitting
 * plan-level context moves nothing else.
 */
const IMPLEMENTER_WITHOUT_PLAN_CONTEXT = (dir: string): string =>
  `You are implementing db-schema: Schema of plan bookmarks.

## Working location
Work entirely inside \`${dir}\`. cd into it before any command:
every git, lint, test and build call runs there. Other phases of this plan may
be running right now in sibling worktrees next to yours — never read or write
any path outside your own. Anything you need from another phase is either
already in your base branch or is a dependency the plan failed to declare; say
so in your report rather than reaching for it.
Your branch is \`HEAD\`, cut from \`main\` — derived from
this phase's dependencies, not from plan order. Commit straight to it.

## What your phase builds on
Nothing yet — this phase starts from \`main\`.

## Your tasks (db-schema only)
## db-schema

Add the Folder model and its migration.

## Working instructions
1. Read the code paths your changes touch before you write anything.
2. Implement, matching the patterns already in the repository.
3. Inner loop, scoped to what you touched: lint clean, then each new test on
   its own, then the scoped suite. Do not go on while any of them is red.
4. Outer gate, once the inner loop is green. Run every one of these yourself
   and read what it returns — step 3 does not speak for them, and the phase is
   judged on these:
   - the repository’s own type/build check and its test suite.
5. A red outer gate sends you back to step 2, for as long as you have room to
   work. It is not a reason to leave the work uncommitted — see below.

## Do this work in this session, yourself
You are the agent that implements this phase — not an orchestrator for one. Do not spawn,
dispatch or delegate to a sub-agent (claude-code’s Task/Agent tool, or whatever
your harness calls the same thing) for any part of it: not the work, not a
search of the codebase, not a second opinion on your own output. Read, run and
write yourself.
This session is reused across phases and rounds, and a later turn will open by
telling you that what you learned about this repository still holds. It holds
only because this session is what learned it. A sub-agent’s reading of the code
ends when the sub-agent does, so a delegated turn leaves you holding its summary
and nothing else, and every turn after it pays for a cold start.
A project skill that tells you to spawn an implementer, reviewer or fixer —
\`implement-plan\`, \`implement-phase\`, \`review-phase\`, \`amend-plan\`, anything
shaped like them — is written for the orchestrator that dispatches phases. That
orchestrator is already running: it is what spawned you, and its job is not this
turn’s. Take what such a skill says about this repository’s conventions, gates
and commit rules; never follow its spawn steps.

## Run everything in the foreground
Do not start background tasks — no \`run_in_background\`, no \`&\`, no detached
processes you intend to come back to. This session is headless: it ends when
your turn ends, nothing will notify you, and anything still running is killed
with it. A turn that finishes by waiting for a background result finishes
having done nothing, and the phase is then judged on an empty branch.
Long commands are fine — run them and wait for them to return.

## Committing is part of the work, not after it
Your phase is reviewed and merged **from the commits on \`HEAD\`**. The
reviewer reads \`git diff main...HEAD\` and nothing else:
a file you wrote and did not commit does not exist as far as the rest of this
run is concerned, and the lane it sits in is reset before the next phase.

So the turn is not complete until \`git status --porcelain\` is empty of your
work. Stage **by explicit path** — never \`git add -A\` or \`git add .\`, because
this worktree holds local files that are not yours to commit — then commit to
\`HEAD\`. The repository's own git hooks run when you do; if one
rewrites your files, stage the result and commit again rather than bypassing
it.

**Commit whether or not you succeeded.** A gate you could not turn green, a
test you could not make pass, a phase you got half way through: none of them
is a reason to end the turn with the work only on disk. Commit it and report
FAILURE, saying what is still red. A commit is not a claim that the phase is
finished — it is what makes the work exist for the reviewer, for the fixer who
acts on their findings, and for the next turn on this branch. The alternative
is not "a clean branch": it is a phase that is reviewed as though you had
written nothing, fixed by someone writing it a second time, and then deleted
with the lane.

## Write the pull request description
Before your final report, write \`.vinta-ai-workflows/prs-context/bookmarks/phase-db-schema.md\`
(create the directories). **Do not commit it** — it describes the change rather
than being part of it.
Two sections, exactly these headings:

\`\`\`markdown
# Title

<one line, imperative, under 72 characters>

# Description

<what this phase changed and why, in Simple English. Lead with the change a
reviewer is about to read. Name the decisions you took and anything you
deliberately left out. Say what you could not do. No preamble, no restating
the phase brief — it is linked from the PR already.>
\`\`\`

This is what a human reads on the pull request, so write it for them rather
than for the orchestrator. If you leave the placeholders in, it is discarded
and the PR falls back to a summary built from gate results.

## Required output (a single final report)
- Status: SUCCESS or FAILURE, and why.
- Files created or modified, paths only.
- A 5–15 line summary of what you implemented and the decisions you took.
- Deviations from the phase body above, and your reasoning.
- Anything you could not do, with an explanation.
`

// ---------------------------------------------------------------------------
// 2. The correctness rule: the dependency closure, never a sibling
// ---------------------------------------------------------------------------

describe('the dependency closure', () => {
  const reports = {
    'db-schema': 'SCHEMA REPORT: added Folder with a parent_id column.',
    'api-layer': 'API REPORT: added GET and POST /folders.',
    'web-ui': 'UI REPORT: added the folder tree component.',
  }

  it('tells a wave-2 phase about its dependency and nothing about its sibling', () => {
    const prompt = compose('api-layer', 'implementer', { reports })

    // Its own dependency, with the artifact the plan says it needs and the
    // report that phase actually filed.
    expect(prompt).toContain('db-schema')
    expect(prompt).toContain('the Folder model')
    expect(prompt).toContain('SCHEMA REPORT: added Folder with a parent_id column.')

    // Its sibling ran in parallel, in another worktree, and its commits are not
    // in this phase's base branch. Describing them would make this implementer
    // code against files it cannot see.
    expect(prompt).not.toContain('web-ui')
    expect(prompt).not.toContain('UI REPORT')
    expect(prompt).not.toContain('the folder tree component')
  })

  it('gives a joining phase the whole transitive closure, in wave order', () => {
    const prompt = compose('docs', 'implementer', { reports })

    expect(prompt).toContain('SCHEMA REPORT')
    expect(prompt).toContain('API REPORT')
    expect(prompt).toContain('UI REPORT')
    expect(prompt.indexOf('SCHEMA REPORT')).toBeLessThan(prompt.indexOf('API REPORT'))
  })

  it('is an ancestor walk: a sibling and a dependent are both outside it', () => {
    const nodes = diamond().nodes
    expect(dependencyClosure(nodes, 'api-layer')).toEqual(['db-schema'])
    expect(dependencyClosure(nodes, 'docs')).toEqual(['db-schema', 'api-layer', 'web-ui'])
    expect(dependencyClosure(nodes, 'db-schema')).toEqual([])
  })

  it('says so when a dependency filed no report, rather than inventing one', () => {
    expect(compose('api-layer', 'implementer')).toContain('No report recorded')
  })
})

// ---------------------------------------------------------------------------
// 3. An unresolvable reference fails loudly
// ---------------------------------------------------------------------------

describe('an unresolvable prompt_ref', () => {
  const missingFile = (): Workflow => {
    const workflow = diamond()
    return {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === 'db-schema' ? { ...node, prompt_ref: 'no-such-plan.md#db-schema' } : node,
      ),
    }
  }

  it('names the node and the reference when the file is not there', () => {
    expect(() => compose('db-schema', 'implementer', { workflow: missingFile() })).toThrow(
      PromptError,
    )
    expect(() => compose('db-schema', 'implementer', { workflow: missingFile() })).toThrow(
      /node "db-schema".*no-such-plan\.md#db-schema/,
    )
  })

  /**
   * What this looked like in practice: a plan sitting untracked in the
   * operator's checkout, and two nodes failing against a path spelled
   * perfectly. A lane is a fresh worktree of the base branch, so an
   * uncommitted plan is in exactly one place the run cannot look — and the old
   * wording sent people to check a spelling that was already right.
   */
  it('says which directory it looked in, and why a plan is often not in it', () => {
    const dir = workspace()

    try {
      resolveBrief(dir, 'db-schema', 'no-such-plan.md#db-schema')
      expect.unreachable('a missing file must throw')
    } catch (error) {
      const message = (error as Error).message
      // The lane it resolved against, not the checkout the operator is in.
      expect(message).toContain(dir)
      expect(message).toContain('fresh worktree of the base branch')
      expect(message).toMatch(/uncommitted|another branch/)
    }
  })

  it('names the node and the reference when the anchor is not in the file', () => {
    const dir = workspace()
    expect(() => resolveBrief(dir, 'db-schema', 'plan.md#no-such-anchor')).toThrow(
      /node "db-schema".*plan\.md#no-such-anchor/,
    )
  })

  it('never puts the brief into the error it raises', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-prompts-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'plan.md'), '## other\n\nSECRET BRIEF TEXT\n')

    try {
      resolveBrief(dir, 'db-schema', 'plan.md#db-schema')
      expect.unreachable('an unresolvable anchor must throw')
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET BRIEF TEXT')
    }
  })

  it('reads a whole file when the reference carries no anchor', () => {
    const dir = workspace()
    expect(resolveBrief(dir, 'db-schema', 'plan.md')).toContain('Add the Folder model')
  })

  it('takes the section down to the next heading of the same depth', () => {
    const dir = workspace()
    const brief = resolveBrief(dir, 'api-layer', 'plan.md#api-layer')
    expect(brief).toContain('Add REST endpoints for folders.')
    expect(brief).not.toContain('Add the folder tree component.')
  })
})

// ---------------------------------------------------------------------------
// 4. The reviewer's protocol is the executor's parser
// ---------------------------------------------------------------------------

describe('the reviewer prompt', () => {
  it('says what to review: the phase diff against its own base', () => {
    const dir = workspace()
    const prompt = compose('api-layer', 'reviewer', {
      dir,
      rows: [
        {
          node_id: 'api-layer',
          branch: 'plan/bookmarks/phase-api-layer',
          base_branch: 'plan/bookmarks/phase-db-schema',
        },
      ],
    })

    expect(prompt).toContain(
      `git -C ${dir} diff plan/bookmarks/phase-db-schema...plan/bookmarks/phase-api-layer`,
    )
    // Layer 2 is a walk of the diff against the phase body, so the body is here.
    expect(prompt).toContain('Add REST endpoints for folders.')
    expect(prompt).toContain('BLOCKER')
    expect(prompt).toContain('never edit code')
  })

  it('asks for a verdict line the executor’s own parser reads back as pass', async () => {
    const demanded = verdictLine(compose('api-layer', 'reviewer'), 'pass')
    expect(await readBackVerdict(demanded)).toBe('pass')
  })

  it('asks for a verdict line the executor’s own parser reads back as fail', async () => {
    const demanded = verdictLine(compose('api-layer', 'reviewer'), 'fail')
    expect(await readBackVerdict(demanded)).toBe('fail')
  })

  it('fails closed when a reviewer says nothing — which is why the ask matters', async () => {
    expect(await readBackVerdict('I looked at the diff and it seems fine.')).toBe('fail')
  })
})

/** The exact line the composed prompt tells the reviewer to end on. */
function verdictLine(prompt: string, outcome: 'pass' | 'fail'): string {
  const line = prompt
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate === `${VERDICT_MARKER} ${outcome}`)
  if (line === undefined) {
    throw new Error(`the reviewer prompt never asks for "${VERDICT_MARKER} ${outcome}"`)
  }
  return line
}

/**
 * What the production executor makes of a reviewer whose last words were
 * exactly `text` — the real `RunEffectExecutor`, over a real transcript, so
 * this is the parser itself rather than a copy of its regex.
 */
async function readBackVerdict(text: string): Promise<unknown> {
  const workflow = diamond()
  const root = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-prompts-run-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const journal = openJournal(join(root, 'state'))
  cleanups.push(() => journal.close())
  journal.createRun(RUN_ID, workflow)

  journal.appendTranscript(RUN_ID, 'api-layer', { type: 'assistant_text', text })
  journal.appendTranscript(RUN_ID, 'api-layer', { type: 'session_ended', result: 'ok' })

  const executor = createRunExecutor({
    workflow,
    runId: RUN_ID,
    journal,
    integrator: new Integrator({
      plan: workflow,
      integrationPath: join(root, 'integ'),
      fixer: { fix: async () => undefined },
      ghPath: join(root, 'no-such-gh'),
    }),
    integrationPath: join(root, 'integ'),
    laneRoot: join(root, 'lanes'),
    notifier: { notify: async () => true },
  })

  const invocation: EffectInvocation = {
    effect: SideEffectSchema.parse({
      id: 'e-review',
      definitionId: 'spawn_agent',
      params: { role: 'reviewer', prompt_template: 'reviewer' },
    }),
    origin: { kind: 'onEnter', stateId: 'review' },
    context: { node: { id: 'api-layer' } },
  }
  // The scheduler already ran the turn; this body only reads what it meant.
  const outcome = await executor.execute(invocation)
  return outcome.facts?.review?.['verdict']
}

// ---------------------------------------------------------------------------
// 5. The fixer is told what failed
// ---------------------------------------------------------------------------

describe('the fixer prompt', () => {
  it('quotes the review findings when the review is what failed', () => {
    const prompt = compose('api-layer', 'fixer', {
      reports: { 'api-layer': 'BLOCKER: POST /folders does not validate parent_id.' },
      facts: { review: { verdict: 'fail' } },
    })

    expect(prompt).toContain('BLOCKER: POST /folders does not validate parent_id.')
    expect(prompt).toContain('You are fixing api-layer')
  })

  it('carries the gate’s log reference when a gate is what failed', () => {
    const prompt = compose('api-layer', 'fixer', {
      // A red gate leaves the review that passed as the last thing in the
      // transcript, so the facts of the turn decide, not the transcript.
      reports: { 'api-layer': 'VERDICT: pass' },
      facts: {
        gate: { id: 'unit', exit_code: 1, status: 'failed', log_ref: '/runs/run-1/gates/unit.log' },
      },
    })

    expect(prompt).toContain('Gate unit failed with exit code 1')
    expect(prompt).toContain('/runs/run-1/gates/unit.log')
    expect(prompt).not.toContain('VERDICT: pass')
  })

  it('carries the phase body, so a fix is checked against what was asked for', () => {
    expect(compose('api-layer', 'fixer')).toContain('Add REST endpoints for folders.')
  })
})

// ---------------------------------------------------------------------------
// 5b. The chore prompt: a general slot that must not widen into a second
// implementation round
// ---------------------------------------------------------------------------

describe('the chore prompt', () => {
  it('carries the chore’s own instruction, inline', () => {
    const prompt = compose('api-layer', 'chore', {
      chore: chore({ prompt: 'Rewrite the comments this phase wrote in Simple English.' }),
    })

    expect(prompt).toContain('Rewrite the comments this phase wrote in Simple English.')
    expect(prompt).toContain('You are running the `deslop` chore over api-layer')
  })

  it('resolves an instruction that lives in the plan, like a phase brief', () => {
    const dir = workspace({ deslop: 'Delete the comments that restate the code.' })
    const prompt = compose('api-layer', 'chore', {
      dir,
      chore: chore({ prompt_ref: 'plan.md#deslop' }),
    })

    expect(prompt).toContain('Delete the comments that restate the code.')
    expect(prompt).not.toContain('plan.md#deslop')
  })

  it('names the file and the field when the instruction does not resolve', () => {
    expect(() =>
      compose('api-layer', 'chore', { chore: chore({ prompt_ref: 'missing.md#nope' }) }),
    ).toThrow(/chores\.deslop\.prompt_ref/)
  })

  it('bounds the scope to this phase’s diff and forbids widening it', () => {
    const dir = workspace()
    const prompt = compose('api-layer', 'chore', {
      dir,
      chore: chore({ prompt: 'Rewrite the comments.' }),
      rows: [
        {
          node_id: 'api-layer',
          branch: 'plan/bookmarks/phase-api-layer',
          base_branch: 'plan/bookmarks/phase-db-schema',
        },
      ],
    })

    expect(prompt).toContain(
      'git diff plan/bookmarks/phase-db-schema...plan/bookmarks/phase-api-layer',
    )
    expect(prompt).toContain('Do what the chore says and nothing else')
    expect(prompt).toContain('This is not another implementation')
  })

  it('tells the chore not to run the gates the phase is about to run anyway', () => {
    const prompt = compose('api-layer', 'chore', { chore: chore({ prompt: 'Tidy up.' }) })

    expect(prompt).toContain("Do not run this phase's gates")
  })

  it('names a skill when the chore declares one, with a fallback for harnesses that have none', () => {
    const prompt = compose('api-layer', 'chore', {
      chore: chore({ prompt: 'Tidy up.', skill: 'deslop-comments' }),
    })

    expect(prompt).toContain('`deslop-comments` skill')
    expect(prompt).toContain('If your harness has no such skill')
  })

  it('says nothing about a chore skill when the chore declares none', () => {
    const prompt = compose('api-layer', 'chore', { chore: chore({ prompt: 'Tidy up.' }) })

    // Narrowed from a bare `not.toContain('skill')`: the no-delegation section
    // names the conductor skills on purpose, and it is in every prompt.
    expect(prompt).not.toContain('skill for this')
    expect(prompt).not.toContain('If your harness has no such skill')
  })

  it('carries the phase brief on a cold turn, as context rather than as work', () => {
    const prompt = compose('api-layer', 'chore', { chore: chore({ prompt: 'Tidy up.' }) })

    expect(prompt).toContain('Add REST endpoints for folders.')
    expect(prompt).toContain('It is not a list of work to do')
  })

  it('drops the brief on a continuation but keeps the instruction', () => {
    // §15.3's rule cuts one way and not the other: the session holds the phase
    // and has never been told to do the chore.
    const prompt = compose('api-layer', 'chore', {
      continuation: true,
      chore: chore({ prompt: 'Rewrite the comments.' }),
    })

    expect(prompt).toContain('Rewrite the comments.')
    expect(prompt).toContain('same session — but a')
    expect(prompt).not.toContain('Add REST endpoints for folders.')
  })

  it('still demands a commit: a chore’s work merges from the branch like any other', () => {
    for (const continuation of [false, true]) {
      const prompt = compose('api-layer', 'chore', {
        continuation,
        chore: chore({ prompt: 'Tidy up.' }),
      })
      expect(prompt).toContain('Committing is part of the work')
    }
  })

  it('fails loudly when a chore template is spawned with no chore', () => {
    expect(() => compose('api-layer', 'chore')).toThrow(PromptError)
    expect(() => compose('api-layer', 'chore')).toThrow(/needs a chore/)
  })
})

// ---------------------------------------------------------------------------
// 6. prompt_template is the seam
// ---------------------------------------------------------------------------

describe('prompt_template', () => {
  it('selects the role’s composition', () => {
    expect(compose('api-layer', 'implementer')).toContain('You are implementing api-layer')
    expect(compose('api-layer', 'reviewer')).toContain('You are reviewing api-layer')
    expect(compose('api-layer', 'fixer')).toContain('You are fixing api-layer')
  })

  it('fails loudly on a template nothing composes', () => {
    expect(() => compose('api-layer', 'archaeologist')).toThrow(PromptError)
    expect(() => compose('api-layer', 'archaeologist')).toThrow(
      /node "api-layer".*archaeologist.*implementer, reviewer, fixer/,
    )
  })

  it('refuses a conflict-fixer template: a conflict is not a phase', () => {
    expect(() => compose('api-layer', 'conflict-fixer')).toThrow(/integrator/)
  })

  it('hands back the reference where a pipeline declared no template', () => {
    expect(compose('api-layer', undefined)).toBe('plan.md#api-layer')
  })

  it('hands back the reference where the lane has no worktree — a projection', () => {
    // `simulate.ts` drives the real scheduler over lanes that were never
    // provisioned: nothing spawns, and its report promises identifiers only.
    expect(compose('api-layer', 'implementer', { dir: null })).toBe('plan.md#api-layer')
  })
})

// ---------------------------------------------------------------------------
// 7. The conflict fixer's prompt is the same one the integrator sends
// ---------------------------------------------------------------------------

describe('the conflict-fixer prompt', () => {
  it('carries identifiers and plan references, and the one rule that matters', () => {
    const prompt = composeConflictPrompt({
      into: 'plan/bookmarks/wave-2',
      incoming: 'plan/bookmarks/phase-web-ui',
      nodes: ['api-layer', 'web-ui'],
      paths: ['src/folders.ts'],
      promptRefs: ['plan.md#api-layer', 'plan.md#web-ui'],
    })

    expect(prompt).toContain('plan/bookmarks/phase-web-ui')
    expect(prompt).toContain('src/folders.ts')
    expect(prompt).toContain('plan.md#web-ui')
    expect(prompt).toContain('--ours')
    // Nothing claims authorship on an unstaffed run: there is nobody to name.
    expect(prompt).not.toContain('You implemented')
  })

  /**
   * The fixer is now the member who wrote one side (`integration/staffing.ts`),
   * and that changes how it should resolve — the temptation is to keep your own
   * half and call it merged. It is told together with the reason it cannot
   * treat that as memory: a fresh session in the integration worktree, not the
   * lane the phase was written in.
   */
  it('names the phases the fixer implemented, and refuses to let that stand as memory', () => {
    const prompt = composeConflictPrompt({
      into: 'plan/bookmarks/wave-2',
      incoming: 'plan/bookmarks/phase-web-ui',
      nodes: ['api-layer', 'web-ui'],
      paths: ['src/folders.ts'],
      promptRefs: ['plan.md#api-layer', 'plan.md#web-ui'],
      implemented: ['api-layer'],
    })

    expect(prompt).toContain('You implemented api-layer')
    expect(prompt).toContain('fresh')
    expect(prompt).toContain('do not privilege your own side')
    // Identifiers and plan references only (§11) — no path outside `paths`,
    // no hunk, nothing a diff could have leaked into.
    expect(prompt).not.toContain('<<<<<<<')
  })
})

// ---------------------------------------------------------------------------
// 8. Continuation: the same role, told only what is new (§15.3)
// ---------------------------------------------------------------------------

/**
 * A continued turn is handed to a session that already holds the phase brief,
 * the plan's bounds and its own prior work, so its prompt is a delta. Re-sending
 * the brief there is not a wasted prefix — it instructs an agent to implement
 * what it has already implemented.
 *
 * Every "does not contain" below is paired, in the same test, with the cold
 * prompt that *does* contain the same string. A negative assertion against a
 * string the renderer could never emit passes forever and proves nothing; the
 * positive half is what makes each of these fail when a delta starts re-sending
 * what the session already has.
 */
describe('a continuation prompt', () => {
  const findings = 'BLOCKER: POST /folders does not validate parent_id.'
  const reports = { 'api-layer': findings }
  const reviewFailed = { review: { verdict: 'fail' } } as const

  /** The phase brief text and a plan-level line, as the fixtures write them. */
  const BRIEF = 'Add REST endpoints for folders.'
  const NON_GOAL = '- Sharing a folder with another user.'

  describe('for the fixer, continuing the implementer’s own session', () => {
    it('carries the findings and drops the brief the session already holds', () => {
      const dir = workspace(PLAN_SECTIONS)
      const options = { dir, workflow: diamondWithPlanContext(), reports, facts: reviewFailed }
      const cold = compose('api-layer', 'fixer', options)
      const continued = compose('api-layer', 'fixer', { ...options, continuation: true })

      // The delta still says what to change: findings are the whole point.
      expect(continued).toContain(findings)
      expect(continued).toContain('nothing else')

      // The cold half proves the brief is something this renderer emits, so the
      // absence below is a real difference rather than a string that was never
      // in either prompt.
      expect(cold).toContain(BRIEF)
      expect(continued).not.toContain(BRIEF)
      expect(cold).toContain('## The phase this branch is implementing')
      expect(continued).not.toContain('## The phase this branch is implementing')
    })

    it('drops the plan-level sections too, and says why nothing is repeated', () => {
      const dir = workspace(PLAN_SECTIONS)
      const workflow = diamondWithPlanContext()
      const options = { dir, workflow, reports, facts: reviewFailed }
      // The fixer has never had plan-level context, cold or continued (§ the
      // module header). The reviewer is where those sections do reach a prompt,
      // so it is the control that proves this fixture really carries them.
      const reviewer = compose('api-layer', 'reviewer', options)
      const continued = compose('api-layer', 'fixer', { ...options, continuation: true })

      expect(reviewer).toContain(NON_GOAL)
      expect(reviewer).toContain('## Plan-level decisions')
      expect(continued).not.toContain(NON_GOAL)
      expect(continued).not.toContain('Plan-level')
      expect(continued).toContain('none of')
      expect(continued).toContain('is repeated here')
    })

    it('carries a red gate the same way the cold prompt does', () => {
      const continued = compose('api-layer', 'fixer', {
        reports: { 'api-layer': 'VERDICT: pass' },
        facts: {
          gate: { id: 'unit', exit_code: 1, status: 'failed', log_ref: '/runs/run-1/gates/unit.log' },
        },
        continuation: true,
      })

      expect(continued).toContain('Gate unit failed with exit code 1')
      expect(continued).toContain('/runs/run-1/gates/unit.log')
      expect(continued).toContain('`vinta-ai-maestro gate unit`')
      // The gate, not the review that passed before it — same rule as cold.
      expect(continued).not.toContain('VERDICT: pass')
    })

    it('does not point at a phase body that is not on the page', () => {
      // With no findings recorded the cold prompt says "the phase body below",
      // which is a lie in a delta: there is no body below.
      const continued = compose('api-layer', 'fixer', { facts: reviewFailed, continuation: true })

      expect(compose('api-layer', 'fixer', { facts: reviewFailed })).toContain('phase body below')
      expect(continued).not.toContain('below')
      expect(continued).toContain('already above')
    })
  })

  describe('for the reviewer, continuing its own session across rounds', () => {
    const continued = (): string =>
      compose('api-layer', 'reviewer', {
        rows: [
          {
            node_id: 'api-layer',
            branch: 'plan/bookmarks/phase-api-layer',
            base_branch: 'plan/bookmarks/phase-db-schema',
          },
        ],
        continuation: true,
      })

    it('says the fixer acted and asks for the new diff, without re-sending the brief', () => {
      const prompt = continued()

      expect(prompt).toContain('A fixer has acted on the findings you')
      // The diff command, over the branches the journal recorded for this node.
      expect(prompt).toContain('plan/bookmarks/phase-db-schema...plan/bookmarks/phase-api-layer')
      // It still reports rather than edits — the one standing rule of the role.
      expect(prompt).toContain('report every issue, fix none of them')
      expect(compose('api-layer', 'reviewer')).toContain(BRIEF)
      expect(prompt).not.toContain(BRIEF)
    })

    it('restates the verdict protocol — the one thing a delta may never drop', () => {
      const prompt = continued()

      // Asserted through the exported marker, so a rename moves both halves.
      expect(prompt).toContain(VERDICT_MARKER)
      expect(prompt).toContain(`${VERDICT_MARKER} pass`)
      expect(prompt).toContain(`${VERDICT_MARKER} fail`)
      expect(prompt).toContain('a turn that ends without it is taken as a failure')
    })

    it('demands a line the exported parser reads back, in both outcomes', () => {
      const prompt = continued()

      expect(readVerdict(verdictLine(prompt, 'pass'))).toBe('pass')
      expect(readVerdict(verdictLine(prompt, 'fail'))).toBe('fail')
      // And what the parser makes of a reviewer that states nothing, which is
      // what a delta with the protocol trimmed out would produce every round.
      expect(readVerdict('The fix looks fine to me.')).toBeUndefined()
    })

    it('demands a line the executor itself reads back as the verdict', async () => {
      const prompt = continued()

      expect(await readBackVerdict(verdictLine(prompt, 'pass'))).toBe('pass')
      expect(await readBackVerdict(verdictLine(prompt, 'fail'))).toBe('fail')
    })
  })

  describe('for the implementer, resumed rather than re-briefed', () => {
    it('is a nudge: the lane and the branch, and none of the cold materials', () => {
      const dir = workspace(PLAN_SECTIONS)
      const options = { dir, workflow: diamondWithPlanContext(), reports: DEPENDENCY_REPORTS }
      const cold = compose('api-layer', 'implementer', options)
      const prompt = compose('api-layer', 'implementer', { ...options, continuation: true })

      expect(prompt).toContain('Resuming api-layer: API')
      expect(prompt).toContain('Pick up exactly where you left off')
      expect(prompt).toContain(dir)

      // Each of the three things the session already holds, with the cold
      // prompt standing as proof that this fixture really produces them.
      expect(cold).toContain(BRIEF)
      expect(prompt).not.toContain(BRIEF)
      expect(cold).toContain('SCHEMA REPORT: added Folder with a parent_id column.')
      expect(prompt).not.toContain('SCHEMA REPORT')
      expect(cold).toContain(NON_GOAL)
      expect(prompt).not.toContain(NON_GOAL)
    })

    it('tells it to read the worktree before trusting its own memory of it', () => {
      // A resumed implementer was interrupted by a capacity wait or an operator
      // takeover (§9), either of which can have moved the lane underneath it.
      const prompt = compose('api-layer', 'implementer', { continuation: true })

      expect(prompt).toContain('git status')
      expect(prompt).toContain('say so in your report instead of')
      expect(prompt).toContain('`vinta-ai-maestro gate unit`')
    })
  })

  it('hands back the reference for a lane with no worktree, continued or not', () => {
    // A projection never continues anything: there is no session and no
    // checkout, and §15.2's fallback is a cold prompt, not a delta into thin air.
    expect(compose('api-layer', 'fixer', { dir: null, continuation: true })).toBe(
      'plan.md#api-layer',
    )
  })

  it('is still refused for a conflict-fixer, which has no session to continue', () => {
    expect(() => compose('api-layer', 'conflict-fixer', { continuation: true })).toThrow(
      /integrator/,
    )
  })
})

// ---------------------------------------------------------------------------
// 8b. The cold path is unchanged
// ---------------------------------------------------------------------------

/**
 * `continuation` is a new branch through a module whose other branch was
 * already shipping. Section 1b pins the implementer's cold output byte for
 * byte; these pin the other two, because "unchanged" is a claim about every
 * character and the two renderers that grew a sibling are exactly the ones a
 * shared helper could quietly reword.
 */
describe('the cold prompt', () => {
  it('composes the reviewer exactly as before', () => {
    const dir = workspace()
    expect(compose('api-layer', 'reviewer', { dir })).toBe(COLD_REVIEWER(dir))
  })

  it('composes the fixer exactly as before', () => {
    const dir = workspace()
    const prompt = compose('api-layer', 'fixer', {
      dir,
      reports: FIXER_REPORTS,
      facts: { review: { verdict: 'fail' } },
    })
    expect(prompt).toBe(COLD_FIXER(dir))
  })

  it('treats an explicit continuation: false exactly as its absence', () => {
    const dir = workspace()
    for (const template of ['implementer', 'reviewer', 'fixer']) {
      expect(
        compose('api-layer', template, { dir, reports: FIXER_REPORTS, continuation: false }),
      ).toBe(compose('api-layer', template, { dir, reports: FIXER_REPORTS }))
    }
  })
})

/** The dependency reports the closure tests use, reused as a cold-prompt control. */
const DEPENDENCY_REPORTS = {
  'db-schema': 'SCHEMA REPORT: added Folder with a parent_id column.',
} as const

/** The findings the cold fixer golden quotes back. */
const FIXER_REPORTS = { 'api-layer': 'BLOCKER: POST /folders does not validate parent_id.' } as const

const COLD_REVIEWER = (dir: string): string =>
  `You are reviewing api-layer: API of plan bookmarks.
You review: read, run and report, but never edit code. Every issue you find
is reported, not fixed — a fixer agent acts on your findings after you.

## What to review
The diff of \`HEAD\` against its base \`main\`:
    git -C ${dir} diff main...HEAD
Read the full diff of every changed file. Spot-checking is not enough.

**Check the working tree too, before you conclude anything from an empty or a
thin diff:**
    git -C ${dir} status --porcelain
An implementer that did the work and never committed it leaves a full tree and
an empty diff. That is a real failure, and it is not "the phase was not
implemented" — the difference decides whether the fixer writes the code again
or simply commits it, and getting it wrong costs the phase every fix round it
has. Where the phase’s work is in the tree and missing from the diff, that
*is* the finding: name the paths, make it a BLOCKER, and say the work needs
committing rather than writing again.

An unclean tree is **not by itself a finding.** A lane carries files nobody is
meant to commit — configuration the pool copied in, dependency trees it
linked, caches and build output the gates you just ran produced — and the
implementer is told by name not to stage them. If the diff holds the phase’s
work, do not raise what is sitting in the tree beside it.

## The outer gate — ask the orchestrator to run it
This plan declares its gates, and the orchestrator runs them for you. Ask for
one by id, from your own worktree:
    vinta-ai-maestro gate unit
It runs the plan’s own command for that gate, in your lane, and exits with the
gate’s exit code — \`0\` is green. It prints the path to the gate’s output; read
that file when a gate is red, rather than inferring what broke from the code.

**Run gates this way rather than running their commands yourself.** Three
things are true of a gate the orchestrator ran and none of them survive a
command you typed: the result is cached against your lane’s contents, so a
gate you have already run on an unchanged tree returns instantly the next time
anyone asks; the machine capacity it needs is queued for rather than taken out
from under the other lanes; and what runs is the command this plan declares —
the same one the orchestrator will run to judge this phase. Something you ran
that resembles the gate is not the gate, and reporting it as one is how a
phase passes review and fails its gate afterwards.

Waiting is the expected outcome, not a failure: it queues for capacity and then
runs a suite. Let it finish — do not interrupt it, add a timeout, or retry it
in some other form. And if it refuses outright, that is the answer to the gate
rather than permission to run the command by hand: say so in your report.

## What that diff was supposed to implement
## api-layer

Add REST endpoints for folders.

## The three layers, all of them, in order
1. Mechanical. The changed-file list matches the report; the whole diff read;
   and **you run these yourself and read what they print** — an implementer
   saying they were green is a claim, not evidence, and a verdict reached
   without running them is a guess:
   - \`vinta-ai-maestro gate unit\`
   Say in your report that you ran them and what they returned. If you could
   not run them, that is a finding, not something to pass over.
   The implementer’s report lists the gates it ran and what they returned.
   That is a claim to check against your own run, not one to accept in place
   of it. Running them again is cheap: an unchanged tree is served from cache.
   Scope creep and unrelated churn surfaced; a scan of the diff for secrets
   (password, secret, token, api_key, AKIA, BEGIN … KEY).
2. Plan compliance. Every change the phase body asked for is implemented;
   every test it named exists and its assertions exercise the named behaviour;
   the acceptance line is satisfiable by this diff; repo conventions followed;
   new comments read as plain English, one idea per sentence.
3. Independent judgment. Correctness, edge cases, and one structural question:
   is there a reframe that would make whole branches, helpers or layers
   disappear rather than be polished? Finding nothing in a large multi-file
   diff is suspicious — read it again.

## Do this work in this session, yourself
You are the agent that reviews this diff — not an orchestrator for one. Do not spawn,
dispatch or delegate to a sub-agent (claude-code’s Task/Agent tool, or whatever
your harness calls the same thing) for any part of it: not the work, not a
search of the codebase, not a second opinion on your own output. Read, run and
write yourself.
This session is reused across phases and rounds, and a later turn will open by
telling you that what you learned about this repository still holds. It holds
only because this session is what learned it. A sub-agent’s reading of the code
ends when the sub-agent does, so a delegated turn leaves you holding its summary
and nothing else, and every turn after it pays for a cold start.
A project skill that tells you to spawn an implementer, reviewer or fixer —
\`implement-plan\`, \`implement-phase\`, \`review-phase\`, \`amend-plan\`, anything
shaped like them — is written for the orchestrator that dispatches phases. That
orchestrator is already running: it is what spawned you, and its job is not this
turn’s. Take what such a skill says about this repository’s conventions, gates
and commit rules; never follow its spawn steps.

Triage each finding as BLOCKER, SHOULD-FIX or NIT.

## How to report
List your findings, each with its triage level, file and line. Then end your
final message with one line, exactly:
    ${VERDICT_MARKER} pass
or
    ${VERDICT_MARKER} fail
Use \`${VERDICT_MARKER} fail\` if any BLOCKER stands. That line is read by the
orchestrator; a turn that ends without it is taken as a failure, so it must be
the last thing you write.
`

const COLD_FIXER = (dir: string): string =>
  `You are fixing api-layer: API of plan bookmarks.
Work entirely inside \`${dir}\`, on branch \`HEAD\`.

## The outer gate — ask the orchestrator to run it
This plan declares its gates, and the orchestrator runs them for you. Ask for
one by id, from your own worktree:
    vinta-ai-maestro gate unit
It runs the plan’s own command for that gate, in your lane, and exits with the
gate’s exit code — \`0\` is green. It prints the path to the gate’s output; read
that file when a gate is red, rather than inferring what broke from the code.

**Run gates this way rather than running their commands yourself.** Three
things are true of a gate the orchestrator ran and none of them survive a
command you typed: the result is cached against your lane’s contents, so a
gate you have already run on an unchanged tree returns instantly the next time
anyone asks; the machine capacity it needs is queued for rather than taken out
from under the other lanes; and what runs is the command this plan declares —
the same one the orchestrator will run to judge this phase. Something you ran
that resembles the gate is not the gate, and reporting it as one is how a
phase passes review and fails its gate afterwards.

Waiting is the expected outcome, not a failure: it queues for capacity and then
runs a suite. Let it finish — do not interrupt it, add a timeout, or retry it
in some other form. And if it refuses outright, that is the answer to the gate
rather than permission to run the command by hand: say so in your report.

## What failed
The reviewer reported:

BLOCKER: POST /folders does not validate parent_id.

## The phase this branch is implementing
## api-layer

Add REST endpoints for folders.

## What to do
Fix exactly what is listed above, and nothing else — an unrelated change here
is scope creep the reviewer will send back. Then re-run the inner loop, and run
each of these yourself:
   - \`vinta-ai-maestro gate unit\`
Keep at it while you have a red gate you know how to fix and room to fix it.
A gate you cannot turn green is not a reason to keep going until the turn ends:
commit what you have and report FAILURE naming the gate and what it said. Green
is what you are aiming at, not the condition for finishing.

## Do this work in this session, yourself
You are the agent that fixes what came back — not an orchestrator for one. Do not spawn,
dispatch or delegate to a sub-agent (claude-code’s Task/Agent tool, or whatever
your harness calls the same thing) for any part of it: not the work, not a
search of the codebase, not a second opinion on your own output. Read, run and
write yourself.
This session is reused across phases and rounds, and a later turn will open by
telling you that what you learned about this repository still holds. It holds
only because this session is what learned it. A sub-agent’s reading of the code
ends when the sub-agent does, so a delegated turn leaves you holding its summary
and nothing else, and every turn after it pays for a cold start.
A project skill that tells you to spawn an implementer, reviewer or fixer —
\`implement-plan\`, \`implement-phase\`, \`review-phase\`, \`amend-plan\`, anything
shaped like them — is written for the orchestrator that dispatches phases. That
orchestrator is already running: it is what spawned you, and its job is not this
turn’s. Take what such a skill says about this repository’s conventions, gates
and commit rules; never follow its spawn steps.

## Run everything in the foreground
Do not start background tasks — no \`run_in_background\`, no \`&\`, no detached
processes you intend to come back to. This session is headless: it ends when
your turn ends, nothing will notify you, and anything still running is killed
with it. A turn that finishes by waiting for a background result finishes
having done nothing, and the phase is then judged on an empty branch.
Long commands are fine — run them and wait for them to return.

## Committing is part of the work, not after it
Your phase is reviewed and merged **from the commits on \`HEAD\`**. The
reviewer reads \`git diff main...HEAD\` and nothing else:
a file you wrote and did not commit does not exist as far as the rest of this
run is concerned, and the lane it sits in is reset before the next phase.

So the turn is not complete until \`git status --porcelain\` is empty of your
work. Stage **by explicit path** — never \`git add -A\` or \`git add .\`, because
this worktree holds local files that are not yours to commit — then commit to
\`HEAD\`. The repository's own git hooks run when you do; if one
rewrites your files, stage the result and commit again rather than bypassing
it.

**Commit whether or not you succeeded.** A gate you could not turn green, a
test you could not make pass, a phase you got half way through: none of them
is a reason to end the turn with the work only on disk. Commit it and report
FAILURE, saying what is still red. A commit is not a claim that the phase is
finished — it is what makes the work exist for the reviewer, for the fixer who
acts on their findings, and for the next turn on this branch. The alternative
is not "a clean branch": it is a phase that is reviewed as though you had
written nothing, fixed by someone writing it a second time, and then deleted
with the lane.

## Required output
- Status: SUCCESS or FAILURE, and why.
- Files modified, paths only.
- Every gate you ran, by id, and what it returned. If you did not run one of
  the gates listed above, say so and say why rather than leaving it out.
- What you changed for each finding, and any finding you did not act on.
`

it('resolves every node of the diamond against the plan the fixture writes', () => {
  const dir = workspace()
  for (const node of diamond().nodes) {
    expect(resolveBrief(dir, node.id, node.prompt_ref)).not.toBe('')
  }
})

// ---------------------------------------------------------------------------
// A session that outlived its phase
// ---------------------------------------------------------------------------

describe('a cross-phase continuation', () => {
  const DOCS_BRIEF = 'Document the folders feature.'

  const carried = (reorientation: Partial<Reorientation> = {}): string =>
    compose('docs', 'implementer', {
      continuation: true,
      reorientation: {
        priorNodeId: 'api-layer',
        priorWorkPresent: true,
        changedFiles: ['apps/api/views.py'],
        ...reorientation,
      },
    })

  /**
   * The distinction the whole shape turns on. A same-phase continuation is a
   * delta — the session already holds the brief. This session holds a brief for
   * work that is *finished*, so withholding the new one would ask an agent to
   * implement a phase it has never been told about.
   */
  it('carries the new phase’s brief in full, unlike a same-phase delta', () => {
    const prompt = carried()
    const delta = compose('docs', 'implementer', { continuation: true })

    expect(prompt).toContain(DOCS_BRIEF)
    expect(delta).not.toContain(DOCS_BRIEF)
  })

  it('puts the re-orientation before the brief, not after it', () => {
    const prompt = carried()

    expect(prompt.indexOf('the worktree moved')).toBeLessThan(prompt.indexOf(DOCS_BRIEF))
  })

  it('names the files that changed, so staleness is checkable rather than vague', () => {
    expect(carried({ changedFiles: ['a.py', 'b.py'] })).toContain('- a.py')
    expect(carried({ changedFiles: ['a.py', 'b.py'] })).toContain('- b.py')
  })

  /**
   * The single most important sentence in the preamble. An agent that remembers
   * writing a model and does not know it is absent will code against something
   * that is not there.
   */
  it('says plainly when the previous phase’s work is NOT in this tree', () => {
    const prompt = carried({ priorWorkPresent: false })

    expect(prompt).toContain('are NOT in this tree')
    expect(prompt).toContain('Do not rely on it')
  })

  it('says the opposite when the phase does depend on it', () => {
    const prompt = carried({ priorWorkPresent: true })

    expect(prompt).toContain('ARE in this tree')
    expect(prompt).not.toContain('are NOT in this tree')
  })

  /**
   * A missing answer is not an empty one. A host with no way to compute the
   * delta must not produce a prompt that reads as "nothing changed" — that is
   * the one wording that would make an agent skip re-reading.
   */
  it('treats an uncomputable delta as everything stale, never as nothing changed', () => {
    const prompt = carried({ changedFiles: null })

    expect(prompt).toContain('could not be computed')
    expect(prompt).toContain('stale')
    expect(prompt).not.toContain('No file differs')
  })

  it('says so when genuinely nothing changed', () => {
    expect(carried({ changedFiles: [] })).toContain('No file differs')
  })

  /** The reason the session was kept at all — say it, so the agent trusts it. */
  it('tells the agent its knowledge of the repository still holds', () => {
    expect(carried()).toContain('everything you learned about this repository still holds')
  })
})
