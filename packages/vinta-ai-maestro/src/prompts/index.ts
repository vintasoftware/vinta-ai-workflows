/** Public surface of prompt composition — what each agent role is told (§5.2). */
export {
  composeConflictPrompt,
  composeSpawnPrompt,
  dependencyClosure,
  PromptError,
  readVerdict,
  resolveBrief,
  VERDICT_MARKER,
  verdictFollowUp,
  type ChorePrompt,
  type ConflictContext,
  type DependencyContext,
  type PromptJournal,
  type RedGate,
  type Reorientation,
  type SpawnPromptRequest,
} from './prompts.ts'
