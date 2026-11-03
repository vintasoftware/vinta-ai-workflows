import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { choreIdsFor, choresFor } from '../src/chores.ts'
import { formatIssues, parseWorkflow } from '../src/validate.ts'
import type { Workflow } from '../src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The golden workflow with chores declared on it. Parsed rather than
 * hand-built, so the defaults under test are the ones the schema applies.
 */
const staffed = (mutate: (doc: Record<string, any>) => void): Workflow => {
  const doc = JSON.parse(readFileSync(join(HERE, 'fixtures', 'golden-workflow.json'), 'utf8'))
  doc.chores = {
    deslop: { prompt: 'Rewrite the comments this phase wrote.' },
    changelog: { prompt: 'Add a CHANGELOG entry.' },
  }
  mutate(doc)
  const result = parseWorkflow(doc)
  if (!result.ok) throw new Error(`expected valid, got:\n${formatIssues(result.issues)}`)
  return result.workflow
}

const node = (workflow: Workflow, id: string) => {
  const found = workflow.nodes.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no node "${id}"`)
  return found
}

describe('which chores a node runs', () => {
  it('takes the run-wide default when the node names none', () => {
    const workflow = staffed((doc) => {
      doc.defaults.chores = ['deslop']
    })

    expect(choreIdsFor(workflow, node(workflow, 'p1'))).toEqual(['deslop'])
  })

  it('replaces the default rather than adding to it', () => {
    const workflow = staffed((doc) => {
      doc.defaults.chores = ['deslop']
      doc.nodes[1].chores = ['changelog']
    })

    expect(choreIdsFor(workflow, node(workflow, 'p2'))).toEqual(['changelog'])
  })

  it('lets an empty list opt one phase out of the run-wide default', () => {
    const workflow = staffed((doc) => {
      doc.defaults.chores = ['deslop', 'changelog']
      doc.nodes[1].chores = []
    })

    expect(choreIdsFor(workflow, node(workflow, 'p2'))).toEqual([])
    // And the phases that said nothing still run both.
    expect(choreIdsFor(workflow, node(workflow, 'p1'))).toEqual(['deslop', 'changelog'])
  })

  it('runs nothing when neither the node nor the defaults name a chore', () => {
    const workflow = staffed(() => {})

    expect(choresFor(workflow, node(workflow, 'p1'))).toEqual([])
  })

  it('resolves ids to declarations in the order they were named', () => {
    const workflow = staffed((doc) => {
      doc.nodes[0].chores = ['changelog', 'deslop']
    })

    expect(choresFor(workflow, node(workflow, 'p1')).map((entry) => entry.id)).toEqual([
      'changelog',
      'deslop',
    ])
    expect(choresFor(workflow, node(workflow, 'p1'))[0]?.chore.session).toBe('main')
  })

  it('narrows to the chores that run at one point in the phase', () => {
    const workflow = staffed((doc) => {
      doc.chores.canvas = { prompt: 'Post a review canvas.', when: 'after_pr' }
      doc.chores.review = { prompt: 'Review the diff.', when: 'review' }
      doc.defaults.chores = ['review', 'deslop', 'canvas']
    })
    const p1 = node(workflow, 'p1')

    expect(choresFor(workflow, p1, 'review').map((entry) => entry.id)).toEqual(['review'])
    expect(choresFor(workflow, p1, 'after_review').map((entry) => entry.id)).toEqual(['deslop'])
    expect(choresFor(workflow, p1, 'after_pr').map((entry) => entry.id)).toEqual(['canvas'])
    // No timing is every chore, which is what a named `run_chore` reads.
    expect(choresFor(workflow, p1).map((entry) => entry.id)).toEqual(['review', 'deslop', 'canvas'])
  })

  it('refuses an after_pr chore that would fail an already-merged phase', () => {
    const doc = JSON.parse(readFileSync(join(HERE, 'fixtures', 'golden-workflow.json'), 'utf8'))
    doc.chores = { canvas: { prompt: 'Post a canvas.', when: 'after_pr', on_failure: 'fail' } }
    const result = parseWorkflow(doc)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(formatIssues(result.issues)).toMatch(/cannot `on_failure: fail`/)
  })

  it('drops an undeclared id rather than throwing — the validator refuses those', () => {
    const workflow = staffed((doc) => {
      doc.nodes[0].chores = ['deslop']
    })
    const edited = { ...workflow, chores: {} }

    expect(choresFor(edited, node(workflow, 'p1'))).toEqual([])
  })
})
