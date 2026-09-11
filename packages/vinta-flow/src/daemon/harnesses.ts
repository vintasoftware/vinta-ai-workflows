/**
 * What each shipped harness can do, read from the adapters themselves.
 *
 * The UI needs §7's capability block to grey out a control instead of failing
 * at the moment the operator presses it, and adapter modules are Node-only —
 * they supervise child processes — so the browser cannot ask one directly.
 * Before this file, `ui/src/capabilities.ts` restated the three blocks by
 * hand, which is a copy that can go stale silently and make the node view lie
 * about what a harness supports.
 *
 * So the daemon reads them off the adapters and serves them. Every adapter
 * declares `capabilities` as an instance field, and the constructors do no
 * work beyond resolving a binary name from an env var — no process, no socket,
 * no filesystem — so a module-level instance is a cheap way to ask the one
 * object that knows.
 *
 * An id with no adapter here answers `null`: an out-of-tree harness or a test
 * double has declared nothing, and inventing a capability block for it would
 * be the same lie in a different file.
 */
import type { HarnessAdapter, HarnessCapabilities } from '../harness/adapter.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import { CodexAdapter } from '../harness/codex.ts'
import { OpencodeAdapter } from '../harness/opencode.ts'

const REGISTERED: readonly HarnessAdapter[] = [
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
  new OpencodeAdapter(),
]

const CAPABILITIES: ReadonlyMap<string, HarnessCapabilities> = new Map(
  REGISTERED.map((adapter) => [adapter.id, adapter.capabilities]),
)

/** The adapter's own declaration, or null for an id this daemon does not ship. */
export function harnessCapabilities(id: string): HarnessCapabilities | null {
  return CAPABILITIES.get(id) ?? null
}
