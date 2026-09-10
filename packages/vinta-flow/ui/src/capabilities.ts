/**
 * What each harness can actually do (§7), so the node view can grey out the
 * rest instead of failing at the moment the operator presses the button.
 *
 * **This table is a copy, and it should not have to be.** The adapters declare
 * their own capabilities, but `/api/runs/:runId` serves a `HarnessState` of
 * ceiling, in-flight and wake-at only — nothing on the wire says whether a
 * harness can join a running turn. The adapter modules themselves cannot be
 * imported here: they supervise child processes and are Node-only. So the one
 * fact §7 exists to give the UI is restated, keyed by the same registry id the
 * snapshot and the node summary already carry. Adding `capabilities` to
 * `HarnessStateSchema` would delete this file.
 *
 * An unknown harness — a test double, an out-of-tree adapter — is assumed to
 * be able to do nothing it has not claimed. The cost of that assumption is a
 * message that says "queued" and was in fact delivered live; the cost of the
 * opposite is telling the operator their steering landed in a turn that never
 * received it.
 */
import type { HarnessCapabilities } from '../../src/harness/adapter.ts'

const KNOWN: Readonly<Record<string, HarnessCapabilities>> = {
  // Bidirectional stdio: steering is a message on stdin.
  'claude-code': { inject: true, interrupt: true, resume: true, pty: true, permissionControl: true },
  // JSONL out, one way. Steering is interrupt, then resume with an amendment.
  codex: { inject: false, interrupt: true, resume: true, pty: true, permissionControl: true },
  // An HTTP session API — the richest control surface, and no PTY.
  opencode: { inject: true, interrupt: true, resume: true, pty: false, permissionControl: false },
}

const UNKNOWN: HarnessCapabilities = {
  inject: false,
  interrupt: false,
  resume: true,
  pty: false,
  permissionControl: false,
}

export function capabilitiesOf(harness: string): HarnessCapabilities {
  return KNOWN[harness] ?? UNKNOWN
}

/** True when this harness is declared, so the view can say "assumed" and mean it. */
export function isKnownHarness(harness: string): boolean {
  return harness in KNOWN
}
