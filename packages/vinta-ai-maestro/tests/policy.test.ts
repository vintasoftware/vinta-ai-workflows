/**
 * The run policy a `run` command is started with, and what of it reaches the
 * job it launches: `--coordinator-authority` above all, because a typo there
 * that quietly became `standard` would look like it worked until the
 * coordinator was refused.
 */
import { describe, expect, it } from 'vitest'

import type { Io } from '../src/cli/io.ts'
import { jobArgs, toRunPolicy } from '../src/cli/policy.ts'

function io(): Io & { readonly errors: string[] } {
  const errors: string[] = []
  return { errors, out: () => {}, err: (line: string) => errors.push(line), confirm: async () => false }
}

describe('--coordinator-authority', () => {
  it('is standard unless asked, carries `full` to the job, and refuses anything else', () => {
    expect(toRunPolicy({}, io())?.coordinatorAuthority).toBeUndefined()

    const full = toRunPolicy({ 'coordinator-authority': 'full' }, io())
    expect(full?.coordinatorAuthority).toBe('full')
    const args = jobArgs({ kind: 'resume', runId: 'r' }, { repoPath: '/repo' } as never, full as NonNullable<typeof full>, {})
    expect(args.slice(args.indexOf('--coordinator-authority'), args.indexOf('--coordinator-authority') + 2)).toEqual([
      '--coordinator-authority',
      'full',
    ])

    const typo = io()
    expect(toRunPolicy({ 'coordinator-authority': 'ful' }, typo)).toBeNull()
    expect(typo.errors.join('\n')).toContain('--coordinator-authority must be one of standard, full')
  })
})
