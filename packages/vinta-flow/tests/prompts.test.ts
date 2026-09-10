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
  resolveBrief,
  VERDICT_MARKER,
  type PromptJournal,
} from '../src/prompts/index.ts'
import { SideEffectSchema, WorkflowSchema, type Workflow } from '../src/types.ts'

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

/** A checkout holding the plan every `prompt_ref` above points at. */
function workspace(sections: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-prompts-'))
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
  })
}

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

  it('lists the gates the phase has to survive, with their commands', () => {
    expect(compose('api-layer', 'implementer')).toContain('unit: `pnpm test`')
  })
})

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

  it('names the node and the reference when the anchor is not in the file', () => {
    const dir = workspace()
    expect(() => resolveBrief(dir, 'db-schema', 'plan.md#no-such-anchor')).toThrow(
      /node "db-schema".*plan\.md#no-such-anchor/,
    )
  })

  it('never puts the brief into the error it raises', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-prompts-'))
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
  const root = mkdtempSync(join(tmpdir(), 'vinta-flow-prompts-run-'))
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
  })
})

it('resolves every node of the diamond against the plan the fixture writes', () => {
  const dir = workspace()
  for (const node of diamond().nodes) {
    expect(resolveBrief(dir, node.id, node.prompt_ref)).not.toBe('')
  }
})
