// mock.mjs — a no-spend adapter that fabricates plausible, grader-passing work.
//
// Purpose: exercise the *whole* harness pipeline (isolation → steps → graders →
// telemetry → report) deterministically, with zero API cost. It is NOT a vendor
// — `--vendor mock` is how you self-test the runner and graders after changing
// them, and how CI can smoke the plumbing without keys.
//
// It reproduces the *shape* a good agent run would leave behind: spec/plan files
// with the required sections, a fixed defect, a one-off script, conventional
// commits on properly-based stacked branches. It does NOT run real skills.

import { VendorAdapter, buildPrompt, gitDirtyFiles } from './base.mjs';
import { git } from '../lib.mjs';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class MockAdapter extends VendorAdapter {
  constructor(opts = {}) {
    super({ vendor: 'mock', ...opts });
  }

  available() { return { available: true }; }

  async run(step, ctx) {
    const { cwd, model, tasksDir, fixture, scenario } = ctx;
    // Realize the prompt so buildPrompt (canned-answer injection) is exercised
    // and the transcript reflects it — the answers-lint grader reads transcripts.
    const prompt = buildPrompt(step, { tasksDir });
    const started = Date.now();

    const plansDir = fixture?.commands?.ai_plans_dir || 'ai-plans';
    const feature = 'patient-allergy-panel';
    const lines = [`[mock] resolved prompt (${prompt.length} chars)`, `[mock] model=${model}`];

    if (step.invoke.includes('create-spec')) {
      write(cwd, `${plansDir}/2026-08-01-${feature}_SPEC.md`, mockSpec());
      commit(cwd, `docs(spec): add ${feature} spec`);
      lines.push('[mock] wrote spec');
    } else if (step.invoke.includes('plan-feature')) {
      branchStack(cwd, feature, 1);
      write(cwd, `${plansDir}/2026-08-01-${feature}_PLAN.md`, mockPlan());
      commit(cwd, `docs(plan): add ${feature} implementation plan`);
      lines.push('[mock] wrote plan on stacked branch');
    } else if (step.invoke.includes('implement-plan')) {
      write(cwd, `src/mock-${feature}.ts`, `export const allergyPanel = () => 'ok';\n`);
      commit(cwd, `feat(${feature}): implement allergy panel`);
      lines.push('[mock] implemented feature');
    } else if (step.invoke.includes('systematic-debugging')) {
      // "Fix" the planted bug by touching the region named in the bug task.
      write(cwd, 'src/mock-bugfix.ts', `export const fixed = true;\n`);
      commit(cwd, 'fix(allergy): correct AllergyIntolerance patient reference field');
      lines.push('[mock] applied bug fix');
    } else if (step.invoke.includes('add-one-off-script')) {
      const scriptsDir = fixture?.commands?.scripts_dir || 'scripts';
      write(cwd, `${scriptsDir}/one_off_2026_08_01_export_observations.ts`,
        `// mock one-off script\nconsole.log('rows,written');\n`);
      commit(cwd, 'chore(script): add observations CSV export one-off');
      lines.push('[mock] wrote one-off script');
    } else if (step.invoke.includes('bootstrap') || step.invoke.includes('sync')) {
      write(cwd, 'AGENTS.md', `# AGENTS\n\nStack: ${fixture?.project?.stack_summary || 'unknown'}\n`);
      mkdirSync(join(cwd, 'ai-tools', 'skills'), { recursive: true });
      write(cwd, 'ai-tools/agents/deploy-author.yaml', mockAgentYaml());
      write(cwd, '.vinta-ai-workflows.yaml', mockConfigYaml(fixture));
      commit(cwd, `chore(ai-tools): ${step.invoke.includes('sync') ? 'sync' : 'bootstrap'} harness`);
      lines.push('[mock] wrote ai-tools scaffold');
    }

    void scenario;
    return {
      transcript: `${lines.join('\n')}\n\n(resolved prompt)\n${prompt}`,
      filesTouched: gitDirtyFiles(cwd),
      usage: { inTok: 1000, outTok: 200, cacheTok: 500, costUsd: 0 },
      wallSec: Math.max(0.01, (Date.now() - started) / 1000),
      exitCode: 0,
    };
  }
}

function write(cwd, rel, content) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function commit(cwd, message) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message,
    '--author', 'mock-agent <mock@example.com>'],
  { env: { GIT_COMMITTER_NAME: 'mock-agent', GIT_COMMITTER_EMAIL: 'mock@example.com' } });
}

// Create/checkout a stacked phase branch `plan/<feature>/phase-N` based on the
// current branch — mirrors the real stacked-branch convention the git-tree
// grader asserts (guarding fix/stack-branches-base-resolution).
function branchStack(cwd, feature, phase) {
  git(cwd, ['checkout', '-q', '-b', `plan/${feature}/phase-${phase}`]);
}

const mockSpec = () => `# ${'Patient Allergy Panel'} — SPEC

## Overview
Add a patient allergy panel reading/writing AllergyIntolerance resources.

## Goals
- Read AllergyIntolerance for the active patient.

## Non-goals
- Server-side access policies.

## Acceptance criteria
- Tests pass against MockClient.
`;

const mockPlan = () => `# Patient Allergy Panel — PLAN

## Context
Implements the SPEC.

## Phases
### Phase 1
- Add the panel component.

## Testing
- Vitest against MockClient.

## Risks
- Version skew across @medplum packages.
`;

const mockAgentYaml = () => `schema_version: 1
name: deploy-author
description: Specialist for deploy-affecting Medplum changes.
access: read-write
body: |
  You handle deploy-affecting changes.
`;

const mockConfigYaml = (fixture) => `schema_version: 1
vinta_ai_workflows_version: 0.4.0
project:
  name: ${fixture?.project?.name || 'fixture'}
  default_branch: main
  code_host: github
  stack_summary: ${fixture?.project?.stack_summary || 'unknown'}
  ai_plans_dir: ${fixture?.commands?.ai_plans_dir || 'ai-plans'}
`;

// Keep import used even if a future path reads the file back.
export { existsSync, readFileSync };
