/** Public surface of the pipeline unit: the interpreter, its seam, its guards. */
export {
  EFFECT_CATALOG,
  EFFECT_VERBS,
  createRecordingExecutor,
  type EffectDefinition,
  type EffectExecutor,
  type EffectInvocation,
  type EffectOrigin,
  type EffectOutcome,
  type RecordedEffect,
  type RecordingExecutor,
} from './effects.ts'
export {
  GUARD_CONTEXT_ROOTS,
  GuardError,
  evaluateGuard,
  evaluateGuardExpression,
  parseGuard,
  type ContextValue,
  type Guard,
  type GuardContext,
} from './guard.ts'
export {
  PipelineRun,
  createPipelineRun,
  type PipelineEvent,
  type PipelineRunOptions,
  type PipelineStatus,
  type StepResult,
} from './interpreter.ts'
