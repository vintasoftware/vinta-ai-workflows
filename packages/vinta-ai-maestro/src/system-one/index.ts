/** Public surface of System One (§17): the adapter seam, the shipped adapters, the config, the judges. */
export {
  YES_NO,
  isYesNo,
  mass,
  normalizeScores,
  type SystemOneAdapter,
  type SystemOneOutcome,
  type SystemOnePreflight,
  type SystemOneQuestion,
  type SystemOneRefusalKind,
  type SystemOneScores,
} from './adapter.ts'
export { HttpSystemOneAdapter, type HttpSystemOneOptions } from './http.ts'
export { CommandSystemOneAdapter, type CommandSystemOneOptions } from './command.ts'
export { MockSystemOneAdapter, type MockAnswer } from './mock.ts'
export {
  SystemOneConfigError,
  SystemOneConfigSchema,
  createSystemOne,
  loadSystemOne,
  registerSystemOneAdapter,
  type GateTriageConfig,
  type PermissionJudgeConfig,
  type SystemOne,
  type SystemOneAdapterFactory,
  type SystemOneConfig,
} from './config.ts'
export {
  PERMISSION_LABELS,
  PERMISSION_QUESTION,
  TRIAGE_LABELS,
  TRIAGE_QUESTION,
  judgeCacheKey,
  judgePermission,
  laneDiff,
  runJudgeGate,
  triageGateFailure,
  type JudgeOutcome,
  type Judgement,
  type PermissionDecision,
  type PermissionRequest,
  type Triage,
  type TriageLabel,
} from './judges.ts'
