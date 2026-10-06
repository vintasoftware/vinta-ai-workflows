/** Public surface of the run unit: starting one, and what starting it yields. */
export {
  preflightRun,
  startRun,
  type PreflightOptions,
  type PreflightResult,
  type RunOutcome,
  type StartRunOptions,
  type StartRunRefusal,
  type StartRunResult,
  type StartedRun,
} from './start.ts'
export {
  defaultAdapters,
  provision,
  refusal,
  type HostWiring,
  type ProvisionOptions,
} from './host.ts'
export { ensurePlanBranch, planBranchName, type PlanBranchResult } from './plan-branch.ts'
export { readSources, writeSources, type RunSources, type RunSourcesInput } from './sources.ts'
