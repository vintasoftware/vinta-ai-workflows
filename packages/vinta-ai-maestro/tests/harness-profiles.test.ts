/**
 * Operator-level harness profiles (`src/harness/profiles.ts`): a named binary
 * and environment for one harness, chosen per run with `--harness-profile`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { jobArgs, toRunPolicy } from '../src/cli/policy.ts'
import type { Io } from '../src/cli/io.ts'
import {
  HarnessProfileError,
  loadHarnessProfiles,
  PROFILES_ENV,
  profileEnv,
  profilesPath,
} from '../src/harness/profiles.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function profilesFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-profiles-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'profiles.yaml')
  writeFileSync(path, text)
  return path
}

const SECOND_ACCOUNT = `harness_profiles:
  claude-second:
    harness: claude-code
    bin: ~/bin/claude
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-second
  codex-work:
    harness: codex
    env:
      CODEX_HOME: /opt/codex-work
`

describe('harness profiles', () => {
  it('reads a named profile into the env its adapter reads, with ~ expanded', () => {
    const profiles = loadHarnessProfiles(['claude-second'], profilesFile(SECOND_ACCOUNT))
    expect(profiles).toEqual([
      {
        name: 'claude-second',
        harness: 'claude-code',
        bin: join(homedir(), 'bin/claude'),
        env: { CLAUDE_CONFIG_DIR: join(homedir(), '.claude-second') },
      },
    ])
    expect(profileEnv(profiles)).toEqual({
      CLAUDE_CONFIG_DIR: join(homedir(), '.claude-second'),
      VINTA_AI_MAESTRO_CLAUDE_BIN: join(homedir(), 'bin/claude'),
    })
  })

  it('refuses a name the file does not define, and says which it does', () => {
    expect(() => loadHarnessProfiles(['nope'], profilesFile(SECOND_ACCOUNT))).toThrow(
      /no harness profile "nope".*claude-second, codex-work/,
    )
  })

  it('refuses two profiles for one harness', () => {
    const path = profilesFile(`${SECOND_ACCOUNT}  claude-third:\n    harness: claude-code\n`)
    expect(() => loadHarnessProfiles(['claude-second', 'claude-third'], path)).toThrow(HarnessProfileError)
  })

  it('refuses a missing file, naming where it looked', () => {
    expect(() => loadHarnessProfiles(['x'], '/nonexistent/profiles.yaml')).toThrow(/\/nonexistent\/profiles.yaml/)
    // No names, no file needed: a run without the flag never reads it.
    expect(loadHarnessProfiles([], '/nonexistent/profiles.yaml')).toEqual([])
  })

  it('reads the file from the operator config directory unless told otherwise', () => {
    expect(profilesPath({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/vinta-ai-maestro/profiles.yaml')
    expect(profilesPath({ [PROFILES_ENV]: '/elsewhere.yaml', XDG_CONFIG_HOME: '/cfg' })).toBe('/elsewhere.yaml')
  })

  it('passes the profile on to a launched job by name only', () => {
    const path = profilesFile(SECOND_ACCOUNT)
    const previous = process.env[PROFILES_ENV]
    process.env[PROFILES_ENV] = path
    cleanups.push(() => {
      if (previous === undefined) delete process.env[PROFILES_ENV]
      else process.env[PROFILES_ENV] = previous
    })
    const errors: string[] = []
    const io: Io = { out: () => {}, err: (line) => errors.push(line), confirm: async () => false }

    const policy = toRunPolicy({ 'harness-profile': ['claude-second'] }, io)
    if (policy === null) throw new Error(errors.join('\n'))
    const args = jobArgs({ kind: 'resume', runId: 'r' }, { repoPath: '/repo' }, policy, {})
    expect(args).toEqual(expect.arrayContaining(['--harness-profile', 'claude-second']))
    expect(args.join(' ')).not.toContain('.claude-second')

    expect(toRunPolicy({ 'harness-profile': ['missing'] }, io)).toBeNull()
    expect(errors.join('\n')).toContain('--harness-profile: no harness profile "missing"')
  })
})
