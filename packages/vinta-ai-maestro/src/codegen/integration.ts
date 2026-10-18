/**
 * The integration worktree's side of codegen steps and append-only files —
 * the seam `Integrator` calls, built by the host over the run's current
 * workflow so an amendment reaches it.
 */
import { git } from '../integration/git.ts'
import type { RedGate } from '../prompts/index.ts'
import type { Workflow } from '../types.ts'
import {
  type CodegenCache,
  type CodegenStepRun,
  codegenGateId,
  generatedOutputs,
  runCodegen,
  settleOutputs,
  unionMergeArgs,
} from './codegen.ts'

export interface IntegrationCodegen {
  /** Settles the unmerged paths that are a generator's outputs; returns them. */
  settle(cwd: string, unmerged: readonly string[]): Promise<string[]>
  /**
   * Runs every step on the merge result and stages what they wrote, so the
   * commit that follows carries regenerated outputs and a hook that would
   * regenerate them finds nothing. Red when a step failed.
   */
  refresh(cwd: string, forNode: string): Promise<RedGate | null>
  /** `-c` arguments every merge takes: the union driver for `append_only`. */
  mergeArgs(cwd: string): Promise<string[]>
  /** The generator output patterns, for the conflict fixer's prompt. */
  generated(): string[]
}

export interface IntegrationCodegenOptions {
  /** The run's workflow as it stands now. */
  readonly workflow: () => Workflow
  readonly env: Readonly<Record<string, string>>
  readonly logPath: (stepId: string) => string
  readonly cache?: CodegenCache
  /** Where the merge attributes file is written. */
  readonly attributesFile: string
  readonly onResult?: (forNode: string, run: CodegenStepRun) => void
}

export function createIntegrationCodegen(options: IntegrationCodegenOptions): IntegrationCodegen {
  return {
    async settle(cwd, unmerged) {
      const steps = options.workflow().codegen
      if (Object.keys(steps).length === 0) return []
      return await settleOutputs(cwd, steps, unmerged)
    },

    async refresh(cwd, forNode) {
      const steps = options.workflow().codegen
      if (Object.keys(steps).length === 0) return null
      const outcome = await runCodegen({
        steps,
        cwd,
        env: options.env,
        logPath: options.logPath,
        ...(options.cache === undefined ? {} : { cache: options.cache }),
        // What the merge brings in, staged or not: the files a hook run on
        // this commit would be handed.
        changedFiles: async () =>
          (await git(cwd, ['diff', '--name-only', '-z', 'HEAD'])).split('\0').filter((path) => path.length > 0),
        onResult: (run) => options.onResult?.(forNode, run),
      })
      if (outcome.failed !== null) {
        return {
          gateId: codegenGateId(outcome.failed.id),
          logPath: outcome.failed.logPath,
          exitCode: outcome.failed.exitCode,
        }
      }
      if (outcome.changed.length > 0) await git(cwd, ['add', '-A', '--', ...outcome.changed])
      return null
    },

    async mergeArgs(cwd) {
      return await unionMergeArgs(cwd, options.workflow().append_only, options.attributesFile)
    },

    generated() {
      return generatedOutputs(options.workflow().codegen)
    },
  }
}
