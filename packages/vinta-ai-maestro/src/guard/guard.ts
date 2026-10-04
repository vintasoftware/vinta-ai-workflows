/**
 * The run's side of the gate guard: the daemon answering the hook
 * (`guard/hook.ts`) and journalling what it blocked.
 *
 * Reads the run's definition through a getter rather than holding one, so a
 * gate retuned mid-run — by an operator, the monitor or a config commit — is
 * matched on the command it runs now.
 */
import type { Journal } from '../journal/journal.ts'
import type { Workflow } from '../types.ts'
import { checkCommand, guardReason, type GuardHit } from './match.ts'

export interface GateGuardPort {
  check(request: { readonly holderNode: string; readonly command: string }): {
    readonly allow: boolean
    readonly reason?: string
  }
}

export interface GateGuardOptions {
  readonly journal: Journal
  readonly runId: string
  readonly workflow: () => Workflow
}

export function createGateGuard(options: GateGuardOptions): GateGuardPort {
  return {
    check({ holderNode, command }) {
      const hit = checkCommand(options.workflow(), command)
      if (hit === null) return { allow: true }
      options.journal.append({
        runId: options.runId,
        nodeId: holderNode,
        type: 'bare_gate_blocked',
        payload: { ...ids(hit), harness: 'claude-code' },
      })
      return { allow: false, reason: guardReason(hit) }
    },
  }
}

/** The hit as the journal carries it: the rule and an id, never the command (§11). */
export function ids(hit: GuardHit): { readonly rule: 'gate' | 'pool'; readonly gate?: string; readonly pool?: string } {
  return hit.rule === 'gate' ? { rule: 'gate', gate: hit.gate } : { rule: 'pool', pool: hit.pool }
}
