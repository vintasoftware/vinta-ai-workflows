/**
 * The permission policy each adapter passes to its CLI.
 *
 * Worth its own file because the failure it prevents is silent in the worst
 * way: with no policy at all, a headless run spawns fine, the agent asks before
 * its first write, a `permission_request` event is emitted, the transcript
 * renders it — and nothing answers. The phase fails reporting a permission
 * system it cannot see, and nothing in the invocation looks wrong.
 *
 * Both vendors also have argument combinations that are rejected outright, and
 * both were found by running the real CLIs rather than by reading them.
 */
import { describe, expect, it } from 'vitest'

import {
  AGENT_PERMISSIONS,
  claudeCodeArgs,
  codexArgs,
  codexResumeArgs,
  DEFAULT_PERMISSION,
  isAgentPermission,
} from '../src/harness/permissions.ts'

describe('the policy vocabulary', () => {
  /**
   * `auto`, not `ask`: the CLIs' own default is to ask, and asking is what
   * fails a headless run. The default here has to be the one under which an
   * unattended lane can finish.
   */
  it('defaults to working unattended inside the lane', () => {
    expect(DEFAULT_PERMISSION).toBe('auto')
  })

  it('accepts only the three it defines', () => {
    for (const value of AGENT_PERMISSIONS) expect(isAgentPermission(value)).toBe(true)
    // The typo worth catching, because the default is the permissive end.
    expect(isAgentPermission('ful')).toBe(false)
    expect(isAgentPermission('bypassPermissions')).toBe(false)
    expect(isAgentPermission(undefined)).toBe(false)
  })
})

describe('claude-code', () => {
  it('always states a mode, so the CLI never falls back to asking', () => {
    for (const permission of AGENT_PERMISSIONS) {
      expect(claudeCodeArgs(permission)).toContain('--permission-mode')
    }
  })

  /**
   * Our `auto` is not the vendor's mode of the same name, and the collision is
   * the whole point of this assertion.
   *
   * `--permission-mode auto` still routes a write to a permission prompt, and
   * in `-p` there is nobody to answer one: run against the CLI, a `Write` to
   * the agent's own working directory comes back denied with no reason
   * attached. `acceptEdits` is the mode under which the same write succeeds.
   * The previous version of this test asserted the word rather than the
   * behaviour, and so pinned the bug in place.
   */
  it('runs unattended on auto — which is the vendor mode that writes, not the one called auto', () => {
    expect(claudeCodeArgs('auto')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(claudeCodeArgs('auto')).not.toContain('auto')
  })

  /**
   * `bypassPermissions` is refused unless the session also opts in with
   * `--allow-dangerously-skip-permissions`. Asking for the mode without
   * enabling it is a spawn that dies at the vendor rather than a policy that
   * applies — so the pair travels together or not at all.
   */
  it('pairs the bypass mode with the flag that enables it', () => {
    const args = claudeCodeArgs('full')

    expect(args).toContain('--allow-dangerously-skip-permissions')
    expect(args).toContain('bypassPermissions')
  })

  it('keeps asking when asked to', () => {
    expect(claudeCodeArgs('ask')).toEqual(['--permission-mode', 'manual'])
  })
})

describe('codex', () => {
  /**
   * The pair the CLI refuses: "the argument '--sandbox <SANDBOX_MODE>' cannot
   * be used with '--approve-for-me'". `--approve-for-me` *is* automatic review
   * under the workspace-write sandbox, so naming the sandbox too reads as belt
   * and braces and is a spawn that never reaches the model.
   */
  it('never passes --sandbox alongside --approve-for-me', () => {
    for (const permission of AGENT_PERMISSIONS) {
      const args = codexArgs(permission)
      expect(args.includes('--sandbox') && args.includes('--approve-for-me')).toBe(false)
    }
  })

  it('confines the shell to the lane when a human is approving', () => {
    expect(codexArgs('ask')).toEqual(['--sandbox', 'workspace-write'])
  })

  it('uses codex’s own automatic review on auto', () => {
    expect(codexArgs('auto')).toEqual(['--approve-for-me'])
  })

  /**
   * `exec resume` takes a different argument set: it rejects both `--sandbox`
   * and `--approve-for-me` as unexpected, and accepts only the bypass flag.
   * Passing the fresh-spawn policy there turns a `stale_session` refusal —
   * which the scheduler retries cold — into a `fatal` one, which fails the node.
   */
  it('passes resume only what resume accepts', () => {
    for (const permission of ['ask', 'auto'] as const) {
      expect(codexResumeArgs(permission)).toEqual([])
    }
    expect(codexResumeArgs('full')).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
  })

  /**
   * The one case where silence would surprise: a run told to skip every check
   * must not start asking again the moment a session is continued.
   */
  it('carries full across a resume', () => {
    expect(codexResumeArgs('full')).toEqual(codexArgs('full'))
  })
})
