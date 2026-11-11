/**
 * The first failure in a gate log. A red base gate used to be reported as "a
 * regression between" the phases, which one run found wrong three times out of
 * three; the failure itself is what settles it, and the log can be tens of
 * thousands of lines long.
 */
import { describe, expect, it } from 'vitest'

import { firstFailure } from '../src/gates/failures.ts'

describe('the first failure in a gate log', () => {
  it('names a pytest failure and its first E line', () => {
    const log = [
      '============ test session starts ============',
      'collected 812 items',
      '',
      '________ test_target_counts_started ________',
      '',
      '    def test_target_counts_started(self):',
      '>       assert target.has_started',
      'E       AssertionError: assert False',
      'E        +  where False = <Target>.has_started',
      '',
      '======= short test summary info =======',
      'FAILED workshops/tests/test_targets.py::test_target_counts_started - AssertionError',
    ].join('\n')
    expect(firstFailure(log)).toEqual({
      test: '________ test_target_counts_started ________',
      cause: 'E       AssertionError: assert False',
      testLine: 4,
      causeLine: 8,
    })
  })

  it('names a vitest failure', () => {
    const log = [' ✓ tests/a.test.ts (3)', ' × tests/b.test.ts > counts (12ms)', 'AssertionError: expected 2 to be 3'].join('\n')
    expect(firstFailure(log)).toMatchObject({ test: '× tests/b.test.ts > counts (12ms)', cause: 'AssertionError: expected 2 to be 3' })
  })

  it('finds the error line of a type checker that names no test', () => {
    const log = ['> tsc --noEmit', "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'."].join('\n')
    expect(firstFailure(log)).toMatchObject({ test: null, causeLine: 2 })
  })

  it('answers null for a log it cannot read a failure from', () => {
    expect(firstFailure('all good\n12 passed\n')).toBeNull()
  })
})
