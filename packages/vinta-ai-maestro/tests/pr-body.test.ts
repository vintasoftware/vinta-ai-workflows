/**
 * What a phase's pull request says.
 *
 * The body used to be `node.prompt_ref` — one line, the plan anchor. Seven PRs
 * from one fourteen-hour run each carried nothing else, which is what this
 * module exists to stop.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composePrBody, readPrContext, PRS_CONTEXT_DIR } from '../src/integration/pr-body.ts'

const lane = (): string => mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-prbody-'))

const write = (root: string, planId: string, nodeId: string, body: string): void => {
  const dir = join(root, PRS_CONTEXT_DIR, planId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `phase-${nodeId}.md`), body, 'utf8')
}

const FACTS = {
  nodeId: 'p2',
  name: 'Aggregate root fields',
  promptRef: 'ai-plans/2026-09-11-X_IMPLEMENTATION_PLAN.md#phase-2',
  branch: 'plan/x/phase-p2',
  base: 'plan/x/integ-p2',
  dependsOn: ['p0', 'p1'],
  gates: [
    { gate: 'lint', exitCode: 0 },
    { gate: 'unit', exitCode: 0 },
  ],
  attempts: 1,
  conflicts: [],
  touches: ['public_api/aggregations/plan.py'],
} as const

describe('reading the phase’s prs-context file', () => {
  it('takes the title and description the agent wrote', () => {
    const root = lane()
    write(
      root,
      'x',
      'p2',
      `---\nstatus: pending\n---\n\n# Title\n\nAdd aggregate root fields\n\n# Description\n\nAdds the root field and its permission class.\n\nSecond paragraph.\n\n# Notes\n\nignored\n`,
    )

    const text = readPrContext(root, 'x', 'p2')

    expect(text?.source).toBe('context')
    expect(text?.title).toBe('Add aggregate root fields')
    // Everything up to the next `# ` heading, and nothing from beyond it.
    expect(text?.body).toBe('Adds the root field and its permission class.\n\nSecond paragraph.')
    expect(text?.body).not.toContain('ignored')
  })

  it('declines a file that is still the template', () => {
    const root = lane()
    write(
      root,
      'x',
      'p2',
      '# Title\n\n<single-line PR title — keep under 72 chars>\n\n# Description\n\n<what changed>\n',
    )

    // Shipping an unfilled placeholder as a PR title is worse than the composed
    // body it would displace, so this is a decline rather than a pass-through.
    expect(readPrContext(root, 'x', 'p2')).toBeNull()
  })

  it('declines a missing file, and one missing a section', () => {
    const root = lane()
    expect(readPrContext(root, 'x', 'p2')).toBeNull()
    write(root, 'x', 'p3', '# Title\n\nOnly a title\n')
    expect(readPrContext(root, 'x', 'p3')).toBeNull()
  })
})

describe('composing a body when the agent wrote none', () => {
  it('says what the phase is based on, which is not the default branch', () => {
    const text = composePrBody(FACTS)

    expect(text.source).toBe('composed')
    expect(text.title).toBe('Aggregate root fields')
    expect(text.body).toContain(FACTS.promptRef)
    // The trap this exists to close: a reviewer who assumes the diff is against
    // the default branch misreads every multi-dependency phase.
    expect(text.body).toContain('plan/x/integ-p2')
    expect(text.body).toContain('`p0`')
    expect(text.body).toContain('`p1`')
    expect(text.body).toContain('public_api/aggregations/plan.py')
    expect(text.body).toContain('2/2 green')
  })

  it('flags a phase that took more than one attempt', () => {
    const clean = composePrBody(FACTS)
    const retried = composePrBody({ ...FACTS, attempts: 3 })

    expect(clean.body).toContain('first attempt')
    expect(retried.body).toContain('3 attempts')
  })

  it('names the conflicts nobody reviewed', () => {
    const text = composePrBody({
      ...FACTS,
      conflicts: [{ paths: ['public_api/aggregations/__init__.py'], rounds: 1 }],
    })

    expect(text.body).toContain('1 merge conflict was')
    expect(text.body).toContain('public_api/aggregations/__init__.py')
    // The point of surfacing it: those resolutions are not part of any review.
    expect(text.body).toContain('Nobody has reviewed those resolutions')
  })

  it('carries no gate output — a PR body is published (§11)', () => {
    const text = composePrBody({ ...FACTS, gates: [{ gate: 'unit', exitCode: 1 }] })

    // An exit code, never the run's stdout.
    expect(text.body).toContain('`unit` (exit 1)')
    expect(text.body).not.toMatch(/FAILED|Traceback|assert/)
  })
})
