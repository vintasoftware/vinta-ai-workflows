// codex.mjs — OpenAI Codex adapter (best-effort; see Phase 0 spike, §12/§14).
//
// Invocation: `codex exec "<prompt>"` runs non-interactively. Open questions
// the Phase 0 spike must confirm before this is considered production-ready:
//   1. Does `codex exec "/skill-name …"` reliably fire a shipped skill, or must
//      the skill body be inlined? (buildPrompt puts the trigger first either way.)
//   2. Can a multi-phase `implement-plan` run unattended to completion?
//   3. Where/whether does `codex exec` surface per-run token usage?
//
// Until the spike resolves (3), usage is parsed best-effort from stdout and
// otherwise reported as zero with `usageEstimated: true` so telemetry never
// silently claims Codex numbers it doesn't have.

import { VendorAdapter, buildPrompt, gitDirtyFiles, EMPTY_USAGE } from './base.mjs';
import { run, hasCommand } from '../lib.mjs';

export class CodexAdapter extends VendorAdapter {
  constructor(opts = {}) {
    super({ vendor: 'codex', ...opts });
  }

  available() {
    if (!hasCommand('codex')) {
      return { available: false, reason: 'codex CLI not on PATH' };
    }
    return { available: true };
  }

  async run(step, { model, cwd, timeoutMs, tasksDir }) {
    const prompt = buildPrompt(step, { tasksDir });
    // Non-interactive; pre-grant workspace writes for the sandboxed copy.
    const args = ['exec', '--full-auto', prompt];
    if (model) args.push('--model', model);

    const res = run('codex', args, { cwd, timeoutMs });

    const usage = parseCodexUsage(res.stdout) || { ...EMPTY_USAGE };

    return {
      transcript: res.stdout,
      filesTouched: gitDirtyFiles(cwd),
      usage,
      usageEstimated: !parseCodexUsage(res.stdout),
      wallSec: res.wallSec,
      exitCode: res.timedOut ? 124 : res.code,
      timedOut: res.timedOut,
      stderr: res.stderr,
    };
  }
}

// Best-effort: look for a "tokens used" summary line Codex prints. Returns null
// when nothing parseable is found so the caller can flag the estimate.
function parseCodexUsage(stdout) {
  if (!stdout) return null;
  const m = stdout.match(/tokens?\s+used[:\s]+([\d,]+)/i);
  if (!m) return null;
  const total = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(total)) return null;
  return { inTok: total, outTok: 0, cacheTok: 0, costUsd: 0 };
}
