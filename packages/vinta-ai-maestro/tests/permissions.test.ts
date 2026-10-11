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
  codexThreadPolicy,
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
   * All three, every time. A parameter left out falls back to the user's own
   * `config.toml`, and a machine whose config routes approvals to codex's
   * reviewer would quietly turn `ask` into `auto`.
   */
  it('states the sandbox, the approval policy and the reviewer in every mode', () => {
    for (const permission of AGENT_PERMISSIONS) {
      expect(Object.keys(codexThreadPolicy(permission)).sort()).toEqual([
        'approvalPolicy',
        'approvalsReviewer',
        'sandbox',
      ])
    }
  })

  /**
   * `--approve-for-me` spelled out: the CLI implements that flag as exactly
   * these three overrides, so `auto` keeps the meaning it had under `exec`.
   */
  it('uses codex’s own automatic review on auto', () => {
    expect(codexThreadPolicy('auto')).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    })
  })

  /** The requests come to this client, which records and declines them (`codex.ts`). */
  it('confines the shell to the lane and routes requests to the client on ask', () => {
    expect(codexThreadPolicy('ask')).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    })
  })

  it('drops the sandbox and never asks on full', () => {
    expect(codexThreadPolicy('full')).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    })
  })

  /**
   * codex has no per-call hook to judge with, so `judged` must land on the
   * narrowest policy rather than on the `full` it is a variant of.
   */
  it('falls back to the narrowest policy on judged', () => {
    expect(codexThreadPolicy('judged')).toEqual(codexThreadPolicy('ask'))
  })
})
