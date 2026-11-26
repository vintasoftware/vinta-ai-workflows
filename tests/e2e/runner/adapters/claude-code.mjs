// claude-code.mjs — Claude Code adapter (headless, richest usage data).
//
// Invocation: `claude -p "<prompt>" --output-format json [--model <m>]`.
// Headless runs can't answer permission prompts, so we run inside the isolated
// fixture copy with permissions bypassed (§6 isolation — always a throwaway
// worktree/clone, never a shared checkout). The JSON envelope carries `usage`
// (input/output/cache tokens) and `total_cost_usd`, which map straight onto our
// telemetry record (§8).

import { VendorAdapter, buildPrompt, gitDirtyFiles, EMPTY_USAGE } from './base.mjs';
import { run, hasCommand } from '../lib.mjs';

export class ClaudeCodeAdapter extends VendorAdapter {
  constructor(opts = {}) {
    super({ vendor: 'claude-code', ...opts });
  }

  available() {
    if (!hasCommand('claude')) {
      return { available: false, reason: 'claude CLI not on PATH' };
    }
    // Auth is via subscription or ANTHROPIC_API_KEY; we can't fully verify here,
    // so presence of the CLI is the gate. A run that fails auth surfaces as a
    // non-zero exit, reported (not silently passed).
    return { available: true };
  }

  async run(step, { model, cwd, timeoutMs, tasksDir }) {
    const prompt = buildPrompt(step, { tasksDir });
    const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);

    const res = run('claude', args, { cwd, timeoutMs });

    let usage = { ...EMPTY_USAGE };
    let transcript = res.stdout;
    try {
      const json = JSON.parse(res.stdout);
      transcript = json.result ?? res.stdout;
      const u = json.usage || {};
      usage = {
        inTok: u.input_tokens ?? 0,
        outTok: u.output_tokens ?? 0,
        cacheTok: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        costUsd: json.total_cost_usd ?? 0,
      };
    } catch {
      // Non-JSON output (e.g. an early crash) — keep raw transcript, zero usage.
    }

    return {
      transcript,
      filesTouched: gitDirtyFiles(cwd),
      usage,
      wallSec: res.wallSec,
      exitCode: res.timedOut ? 124 : res.code,
      timedOut: res.timedOut,
      stderr: res.stderr,
    };
  }
}
