/**
 * What an integration step says, as a line of text — the same words in
 * `status`, the run view's worktree panel and a phase's timeline, because all
 * three name the same step and an operator reads them side by side.
 *
 * Structural, so the journal's rows and the API's both fit, and store-free so
 * the browser bundle can take it.
 */
import type { IntegrationStepKind } from './events.ts'

export interface DescribedStep {
  readonly step: IntegrationStepKind
  readonly branch: string | null
  readonly incoming: string | null
  readonly wave: number | null
  readonly gate: string | null
  readonly round: number | null
}

export function describeStep(step: DescribedStep): string {
  switch (step.step) {
    case 'hold':
      return 'holding the integration worktree'
    case 'merge':
      return `merge ${step.incoming ?? 'a phase'} into ${step.branch ?? 'its branch'}`
    case 'fix_round':
      return `conflict fix, round ${step.round ?? '?'}`
    case 'verify':
      // One row per gate now that `verify` reports them as they start; the
      // outcome mark beside the row says whether it went red.
      return step.gate === null ? 'gates on the merged tree' : `gate ${step.gate} on the merged tree`
    case 'base_gate':
      return `gate ${step.gate ?? '?'} on the base${step.branch === null ? '' : ` ${step.branch}`}`
    case 'wave_gate':
      return `wave ${step.wave ?? '?'} gate ${step.gate ?? '?'}`
    case 'push':
      return 'push the phase branch'
    case 'open_pr':
      return 'open the pull request'
  }
}
