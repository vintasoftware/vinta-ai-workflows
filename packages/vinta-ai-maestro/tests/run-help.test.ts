/**
 * `run --help` on resume says what `resumeRefusal` does.
 *
 * It used to say a run that "finished, or was stopped" cannot be resumed,
 * which an operator read as "a failed run is over" — while `run --resume`
 * accepted it, re-attempted its failed and blocked phases, and `status`
 * printed the resume command for it.
 */
import { describe, expect, it } from 'vitest'

import { RUN_USAGE } from '../src/cli/run.ts'
import { isResumable } from '../src/cli/status.ts'

describe('run --help on resume', () => {
  it('names the states that resume, and agrees with status', () => {
    expect(RUN_USAGE).toContain('paused, interrupted or failed')
    for (const state of ['paused', 'interrupted', 'failed'] as const) expect(isResumable(state)).toBe(true)
  })

  it('says what a failed run’s resume does', () => {
    expect(RUN_USAGE).toMatch(/failed\s+phases and the ones they blocked are attempted again/)
  })

  it('names the only states that are refused', () => {
    expect(RUN_USAGE).toMatch(/Only a run that\s+is done, or was stopped \(cancelled\), cannot be resumed/)
    expect(RUN_USAGE).not.toContain('A run that finished, or was stopped, cannot be resumed')
    for (const state of ['done', 'cancelled'] as const) expect(isResumable(state)).toBe(false)
  })
})
