/** Public surface of prompt composition — what each agent role is told (§5.2). */
export {
  composeConflictPrompt,
  composeSpawnPrompt,
  dependencyClosure,
  PromptError,
  readVerdict,
  resolveBrief,
  VERDICT_MARKER,
  type ChorePrompt,
  type ConflictContext,
  type DependencyContext,
  type PromptJournal,
  type Reorientation,
  type SpawnPromptRequest,
} from './prompts.ts'
export {
  GATE_TRIGGERS,
  LEDGER_FENCE,
  parseLedger,
  readFixerReport,
  viewLedger,
  type FixerReport,
  type GatedFinding,
  type LedgerEntry,
  type LedgerView,
  type RejectedFinding,
  type SettledDecision,
} from './ledger.ts'
