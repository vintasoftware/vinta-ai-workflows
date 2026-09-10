/** Public surface of prompt composition — what each agent role is told (§5.2). */
export {
  composeConflictPrompt,
  composeSpawnPrompt,
  dependencyClosure,
  PromptError,
  readVerdict,
  resolveBrief,
  VERDICT_MARKER,
  type ConflictContext,
  type DependencyContext,
  type PromptJournal,
  type SpawnPromptRequest,
} from './prompts.ts'
