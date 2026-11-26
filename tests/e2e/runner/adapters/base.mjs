// base.mjs — VendorAdapter contract + shared helpers.
//
// Adapter contract (from PLAN §6):
//   run(step, { model, cwd, timeoutMs }) → {
//     transcript, filesTouched, usage: {inTok, outTok, cacheTok, costUsd},
//     wallSec, exitCode
//   }
//
// A step is one entry from a scenario's `steps[]`:
//   { invoke: "/create-spec", input?: "tasks/feature.md",
//     answers?: "tasks/feature.answers.md", autonomous?: true, prompt?: "..." }
//
// The adapter's job is only to *drive the agent* for one step and report what
// happened. Grading and telemetry aggregation live elsewhere.

import { readText, git } from '../lib.mjs';
import { join } from 'node:path';

// Build the prompt for a step. This is the heart of the "canned answers"
// contract (§6): the answers file is injected so a headless agent never stalls
// on an interview question, and is told not to invent anything beyond it.
export function buildPrompt(step, { tasksDir }) {
  if (step.prompt) return step.prompt; // fully explicit override

  const parts = [];
  // Invoking a skill is just putting its trigger in the prompt.
  parts.push(step.invoke);

  const input = step.input ? readText(join(tasksDir, step.input)) : null;
  if (input) {
    parts.push('\n## Task\n');
    parts.push(input.trim());
  }

  const answers = step.answers ? readText(join(tasksDir, step.answers)) : null;
  if (answers) {
    parts.push('\n## Canned answers to every question you might ask\n');
    parts.push(answers.trim());
    parts.push(
      '\nThese are the answers to every interview question this skill would ask. '
      + 'Do not ask for anything else. If something is genuinely missing, state the '
      + 'assumption explicitly and proceed — never block waiting for input.',
    );
  }

  if (step.autonomous) {
    parts.push(
      '\nRun this to completion autonomously across all phases. Do not stop for '
      + 'confirmation between phases; make reasonable decisions and keep going until done.',
    );
  }

  return parts.join('\n');
}

// Snapshot which files a step touched, using git porcelain in the isolated
// fixture copy. Adapters call this before/after when the CLI itself doesn't
// report file writes.
export function gitDirtyFiles(cwd) {
  const res = git(cwd, ['status', '--porcelain']);
  if (res.code !== 0) return [];
  return res.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
}

export const EMPTY_USAGE = { inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 };

// Base class documents the contract; concrete adapters override run().
export class VendorAdapter {
  constructor({ vendor, models } = {}) {
    this.vendor = vendor;
    this.models = models || [];
  }

  // Return { available: boolean, reason?: string }. When unavailable the runner
  // reports the cell as *skipped*, never passed (§11: a vendor without a key is
  // skipped).
  available() { return { available: true }; }

  // eslint-disable-next-line no-unused-vars
  async run(step, ctx) {
    throw new Error(`${this.vendor}: run() not implemented`);
  }
}
