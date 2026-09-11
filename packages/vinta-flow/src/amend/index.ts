/** Public surface of the amend unit (§9's "Amending a live run"). */
export {
  amendRun,
  type AmendApplied,
  type AmendOptions,
  type AmendRefusal,
  type AmendRefusalCode,
  type AmendResult,
  type AmendRunner,
  type RebaseRequest,
} from './amend.ts'
export { diffWorkflows, topoOrder, type WorkflowDiff } from './diff.ts'
export { createRebaser, RebaseConflictError, type RebaserOptions } from './rebase.ts'
