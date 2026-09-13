/**
 * Reading outside the lane without gaining the right to write there.
 *
 * The failure worth testing is the quiet one. `--add-dir <repo>` lifts the
 * working-directory boundary in both directions, so if the deny list comes out
 * wrong — or empty — nothing breaks, nothing is logged, and every agent simply
 * has write access to the operator's checkout and to every sibling lane. So
 * these assert the *shape* of the list, not merely that one exists.
 *
 * Behaviour against the CLI itself was verified by hand at the time this was
 * written: with the grant and this list in place, a read of the repository root
 * succeeds, a write in the lane succeeds, and writes into the checkout's source
 * and into a sibling lane are both refused.
 */
import { describe, expect, it } from 'vitest'

import { addDirArgs, writeDenyRules, type ListDir } from '../src/harness/read-access.ts'

const REPO = '/repo'
const LANE = '/repo/.vinta-ai-maestro/lanes/run-crew-1-junior'

/** A repository with source beside the store, and two lanes in it. */
const tree: Record<string, readonly string[]> = {
  '/repo': ['src', 'package.json', '.vinta-ai-maestro', '.git'],
  '/repo/.vinta-ai-maestro': ['lanes', 'runs'],
  '/repo/.vinta-ai-maestro/lanes': ['run-crew-1-junior', 'run-crew-2-senior'],
}
const list: ListDir = (dir) => tree[dir] ?? []

const rulesFor = (roots: readonly string[], lane = LANE): readonly string[] =>
  writeDenyRules({ roots, lane }, list)

/** Whether the list refuses a write at this path, by either form of the rule. */
function denies(rules: readonly string[], path: string): boolean {
  return rules.some(
    (rule) => rule === `Write(//${path.slice(1)})` || rule === `Write(//${path.slice(1)}/**)`,
  )
}

describe('the corridor down to the lane', () => {
  it('denies the checkout’s own source', () => {
    const rules = rulesFor([REPO])

    expect(denies(rules, '/repo/src')).toBe(true)
    expect(denies(rules, '/repo/package.json')).toBe(true)
  })

  /** Two phases run at once. One writing in the other's worktree corrupts it. */
  it('denies a sibling lane', () => {
    expect(denies(rulesFor([REPO]), '/repo/.vinta-ai-maestro/lanes/run-crew-2-senior')).toBe(true)
  })

  /** Transcripts and the journal are the run's own record of itself. */
  it('denies the rest of the store', () => {
    expect(denies(rulesFor([REPO]), '/repo/.vinta-ai-maestro/runs')).toBe(true)
  })

  /**
   * The point of the exercise. A rule covering any directory on the way down
   * would cover the lane inside it, and the vendor resolves deny before allow
   * with no carve-out — so naming them is not something a later `allow` could
   * undo.
   */
  it('never names the lane or anything above it', () => {
    const rules = rulesFor([REPO])

    expect(denies(rules, LANE)).toBe(false)
    expect(denies(rules, '/repo')).toBe(false)
    expect(denies(rules, '/repo/.vinta-ai-maestro')).toBe(false)
    expect(denies(rules, '/repo/.vinta-ai-maestro/lanes')).toBe(false)
    expect(rules.some((rule) => rule.includes('run-crew-1-junior'))).toBe(false)
  })

  it('covers every file-editing tool, and never Bash', () => {
    const rules = rulesFor([REPO])

    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(rules.some((rule) => rule.startsWith(`${tool}(`))).toBe(true)
    }
    // A shell redirection was never confined to the working directory and is
    // not confined now; claiming it here would be claiming a guard that a
    // single `echo >` walks through.
    expect(rules.some((rule) => rule.startsWith('Bash('))).toBe(false)
  })
})

describe('a root that is not the lane’s ancestor', () => {
  it('is denied whole, with no corridor through it', () => {
    const rules = rulesFor(['/elsewhere'])

    expect(denies(rules, '/elsewhere')).toBe(true)
  })
})

describe('granting nothing', () => {
  /**
   * No roots means the working directory is the whole world, which is what it
   * was before any of this existed — and an empty deny list must not be read
   * as "a guard ran and found nothing to say".
   */
  it('produces no rules and no arguments', () => {
    expect(rulesFor([])).toEqual([])
    expect(addDirArgs({ roots: [], lane: LANE })).toEqual([])
  })
})

describe('the arguments', () => {
  it('names each root once', () => {
    expect(addDirArgs({ roots: [REPO, '/elsewhere'], lane: LANE })).toEqual([
      '--add-dir',
      REPO,
      '--add-dir',
      '/elsewhere',
    ])
  })
})

/**
 * The bug this caught while being written: paths were rebuilt by joining split
 * segments, which drops the leading separator, so every listing was of a
 * relative path that did not exist. The result was an empty deny list — a
 * grant shipped with no guard at all, and nothing to see in any output.
 */
describe('the listing it asks for', () => {
  it('asks about real absolute paths', () => {
    const asked: string[] = []
    writeDenyRules({ roots: [REPO], lane: LANE }, (dir) => {
      asked.push(dir)
      return tree[dir] ?? []
    })

    expect(asked).toEqual([REPO, '/repo/.vinta-ai-maestro', '/repo/.vinta-ai-maestro/lanes'])
    expect(asked.every((dir) => dir.startsWith('/'))).toBe(true)
  })
})
