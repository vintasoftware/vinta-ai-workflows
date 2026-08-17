// index.mjs — adapter registry. v1 targets Claude Code + Codex (§6); `mock`
// is the no-spend self-test adapter. Cursor / Copilot are deferred.

import { ClaudeCodeAdapter } from './claude-code.mjs';
import { CodexAdapter } from './codex.mjs';
import { MockAdapter } from './mock.mjs';

const REGISTRY = {
  'claude-code': ClaudeCodeAdapter,
  codex: CodexAdapter,
  mock: MockAdapter,
};

const ALIASES = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  'openai-codex': 'codex',
  mock: 'mock',
};

// The real vendors for a full-matrix run (mock is opt-in only).
export const MATRIX_VENDORS = ['claude-code', 'codex'];

export function resolveVendor(name) {
  return ALIASES[name?.toLowerCase()] || null;
}

export function makeAdapter(vendor, opts = {}) {
  const Cls = REGISTRY[vendor];
  if (!Cls) throw new Error(`unknown vendor "${vendor}". Known: ${Object.keys(REGISTRY).join(', ')}`);
  return new Cls(opts);
}

export function knownVendors() {
  return Object.keys(REGISTRY);
}
