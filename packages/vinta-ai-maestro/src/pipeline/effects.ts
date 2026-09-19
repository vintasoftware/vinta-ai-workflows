/**
 * The side-effect catalog and the seam the interpreter reaches it through.
 *
 * §5.2 says hosts inject the catalog; this module is that injection point. The
 * interpreter never calls git, never spawns an agent, and never opens a PR —
 * it hands an `EffectInvocation` to an `EffectExecutor` and waits. Two things
 * fall out of that seam, and both are the reason it exists:
 *
 * - Every pipeline path is testable without a git repo, a model, or a network.
 * - This module depends on nothing but `types.ts`. The real bodies belong to
 *   the harness, gate, git and notification units, which are separate steps;
 *   were they wired in here, the interpreter could not be built before them.
 *
 * `params` are passed through verbatim. The catalog below documents each verb's
 * arguments but does not enforce them: the executor resolves defaults (a
 * `git_merge` with no `branch` merges the node's own phase branch), and a
 * schema that rejected the shipped `standard-phase` pipeline would be wrong
 * about the pipeline, not the other way round.
 */
import { EFFECT_IDS, type EffectId, type SideEffect } from '../types.ts'
import type { GuardContext } from './guard.ts'

export interface EffectDefinition {
  readonly id: EffectId
  /** Documented parameter names (§5.2). Advisory — the executor owns defaults. */
  readonly params: readonly string[]
  readonly description: string
}

export const EFFECT_CATALOG: Readonly<Record<EffectId, EffectDefinition>> = {
  spawn_agent: {
    id: 'spawn_agent',
    params: ['role', 'prompt_template', 'harness', 'model', 'session'],
    description:
      'Runs a coding agent in the node’s lane. `role` is one of AGENT_ROLES. `session` names a ' +
      'session slot to continue (§15): absent starts a fresh session every time, which is what ' +
      'every pipeline written before slots existed keeps doing.',
  },
  run_gate: {
    id: 'run_gate',
    params: ['gate'],
    description: 'Runs a gate command, acquiring the gate’s resource pools first.',
  },
  run_chore: {
    id: 'run_chore',
    params: ['chore'],
    description:
      'Runs the node’s declared chores as agent turns, in order — `defaults.chores` unless the ' +
      'node named its own. `chore` runs exactly one instead, whatever the node declared. Each ' +
      'turn continues the slot its chore names, so the default is the implementer’s session.',
  },
  git_branch: {
    id: 'git_branch',
    params: ['from'],
    description: 'Creates the phase branch. `from` resolves via the dependency-derived base rule.',
  },
  git_merge: {
    id: 'git_merge',
    params: ['branch', 'strategy'],
    description: 'Merges a branch. `--no-ff` for lane merges; never squash.',
  },
  git_push: { id: 'git_push', params: [], description: 'Pushes the phase branch.' },
  open_pr: { id: 'open_pr', params: ['base', 'draft'], description: 'Opens a pull request.' },
  write_tracking: {
    id: 'write_tracking',
    params: ['scope'],
    description: 'Writes tracking output. `scope` is run, phase or wave.',
  },
  await_human: {
    id: 'await_human',
    params: ['question', 'kind', 'choices', 'context', 'reason'],
    description:
      'Asks the operator a question and suspends the run. The only verb with control-flow ' +
      'meaning to the interpreter; the answer re-enters the guard context as `human.answer`. ' +
      'The params carry §9.1’s question shape: `question` is what the operator is asked, ' +
      '`kind` is confirm | choice | text, `choices` are the options a choice offers, and ' +
      '`context` names what the node view renders beside it — `diffRef`, `gateLogRef`, ' +
      '`transcriptCursor`. `reason` is the older one-line form and still reads as the ' +
      'question when no `question` is given. The host journals the whole shape with the ' +
      'pause, which is what makes the question outlive a daemon restart.',
  },
  notify: {
    id: 'notify',
    params: ['channel', 'text'],
    description: 'Sends a browser or OS notification.',
  },
}

/** Where a declared effect came from — for journalling and for assertions. */
export type EffectOrigin =
  | { readonly kind: 'onEnter' | 'onLeave'; readonly stateId: string }
  | { readonly kind: 'transition'; readonly transitionId: string }

export interface EffectInvocation {
  /** The effect exactly as the pipeline declared it, `data` blob included. */
  readonly effect: SideEffect
  readonly origin: EffectOrigin
  /** The guard context as of this invocation, with every prior fact merged. */
  readonly context: GuardContext
}

export interface EffectOutcome {
  /**
   * Facts the effect learned, merged into the guard context at the root level
   * before the next guard is evaluated. A reviewer returns `{ review: {...} }`;
   * a gate returns `{ gate: { exit_code } }`.
   */
  readonly facts?: GuardContext
}

/** The injected seam. One method, so a test double is three lines. */
export interface EffectExecutor {
  execute(invocation: EffectInvocation): Promise<EffectOutcome>
}

export interface RecordedEffect {
  readonly effectId: string
  readonly definitionId: EffectId
  readonly origin: EffectOrigin
  readonly params: Readonly<Record<string, unknown>>
}

export interface RecordingExecutor extends EffectExecutor {
  readonly calls: readonly RecordedEffect[]
}

/**
 * The test double. Records what it was asked to do and replays outcomes keyed
 * by the declared effect id, which is what makes "review returns fail the first
 * time and pass the second" a data change rather than a mock framework.
 */
export function createRecordingExecutor(
  outcomes: Readonly<Record<string, EffectOutcome | readonly EffectOutcome[]>> = {},
): RecordingExecutor {
  const calls: RecordedEffect[] = []
  const seen = new Map<string, number>()

  return {
    calls,
    async execute(invocation: EffectInvocation): Promise<EffectOutcome> {
      const { effect } = invocation
      calls.push({
        effectId: effect.id,
        definitionId: effect.definitionId,
        origin: invocation.origin,
        params: effect.params,
      })

      const scripted = outcomes[effect.id]
      if (scripted === undefined) return {}
      if (!Array.isArray(scripted)) return scripted as EffectOutcome

      // A list is a per-invocation script; the last entry repeats.
      const list = scripted as readonly EffectOutcome[]
      const nth = seen.get(effect.id) ?? 0
      seen.set(effect.id, nth + 1)
      return list[Math.min(nth, list.length - 1)] ?? {}
    },
  }
}

/** Every verb the catalog knows. Re-exported so hosts need one import. */
export const EFFECT_VERBS = EFFECT_IDS
