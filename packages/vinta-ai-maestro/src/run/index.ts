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
