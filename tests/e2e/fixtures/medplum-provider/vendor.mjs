#!/usr/bin/env node
// vendor.mjs — build the medplum-provider fixture's three committed states.
//
// The fixture app is NOT committed to this repo (it's a large external app);
// this script vendors it on demand, pinned to a commit, and materializes the
// clean/stale/current states each as its own git repo (PLAN §4). Run once
// locally before the first L2 run:
//
//   node tests/e2e/fixtures/medplum-provider/vendor.mjs
//   node tests/e2e/fixtures/medplum-provider/vendor.mjs --state clean   # just one
//
// Requires: git, network access, and (for stale/current) the vinta-ai-workflows
// CLI to place the harness skills. The SPEC/PLAN interview content that a real
// bootstrap authors (AGENTS.md, .vinta-ai-workflows.yaml) is seeded minimally
// here so the fixture is a valid, schema-passing starting point; regenerate with
// a real bootstrap when you want richer fixtures.
//
// ⚠ Before first use: set `upstream.pinnedCommit` in fixture.json to a real SHA.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const fixture = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'));

const args = process.argv.slice(2);
const onlyState = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
const cacheDir = join(HERE, '.upstream-cache');

function sh(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
}
function shq(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts }).trim();
}

function fetchUpstream() {
  const { repo, subdir, pinnedCommit } = fixture.upstream;
  if (!pinnedCommit || pinnedCommit.startsWith('REPLACE')) {
    throw new Error('Set upstream.pinnedCommit in fixture.json to a real SHA before vendoring.');
  }
  if (existsSync(join(cacheDir, subdir))) {
    console.log(`· upstream cache present at ${cacheDir}`);
    return join(cacheDir, subdir);
  }
  console.log(`· cloning ${repo} @ ${pinnedCommit} (sparse: ${subdir})`);
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  sh('git', ['init', '-q'], { cwd: cacheDir });
  sh('git', ['remote', 'add', 'origin', repo], { cwd: cacheDir });
  sh('git', ['sparse-checkout', 'set', '--cone', subdir], { cwd: cacheDir });
  sh('git', ['fetch', '-q', '--depth', '1', 'origin', pinnedCommit], { cwd: cacheDir });
  sh('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: cacheDir });
  return join(cacheDir, subdir);
}

function initRepo(dir, message) {
  sh('git', ['init', '-q'], { cwd: dir });
  sh('git', ['config', 'user.name', 'fixture-seed'], { cwd: dir });
  sh('git', ['config', 'user.email', 'fixture@vinta.local'], { cwd: dir });
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['commit', '-q', '-m', message], { cwd: dir });
  sh('git', ['branch', '-q', '-M', 'main'], { cwd: dir });
}

function copyApp(srcApp, destState) {
  rmSync(destState, { recursive: true, force: true });
  mkdirSync(destState, { recursive: true });
  cpSync(srcApp, destState, { recursive: true });
  // Wire the Medplum test setup pair from the shipped test pack (§4).
  const pack = join(REPO_ROOT, 'skills', 'vinta-derive-skills',
    'resources', 'write-unit-test-packs', 'stacks');
  for (const [src, dst] of [
    ['medplum-test.globalSetup.ts', 'test.globalSetup.ts'],
    ['medplum-test.setup.ts', 'test.setup.ts'],
  ]) {
    const from = join(pack, src);
    if (existsSync(from)) cpSync(from, join(destState, dst));
  }
  // Copy the scenario task inputs + canned answers into the fixture's tasks/
  // stays out of the app tree — they live beside fixture.json, not in states.
}

function seedHarness(destState, version) {
  // Place the vinta skills for the target version and seed a minimal, schema-
  // valid AGENTS.md + config so the state is a valid starting point. A real
  // bootstrap produces richer content; regenerate when you want that.
  console.log(`· installing vinta-ai-workflows@${version} skills into ${destState}`);
  try {
    sh('npx', ['-y', `vinta-ai-workflows@${version}`, 'install', '--tool', 'claude-code',
      '--copy', '--target', destState], { cwd: destState });
  } catch {
    console.warn(`  (could not install @${version} — placing local skills as fallback)`);
    sh('node', [join(REPO_ROOT, 'vinta-ai-workflows.mjs'), 'install', '--tool', 'claude-code',
      '--copy', '--target', destState]);
  }
  writeFileSync(join(destState, 'AGENTS.md'),
    `# AGENTS\n\nStack: ${fixture.project.stack_summary}\n\n<!-- hand-tuned:keep -->\n`);
  writeFileSync(join(destState, '.vinta-ai-workflows.yaml'),
`schema_version: 1
vinta_ai_workflows_version: ${version}
project:
  name: ${fixture.project.name}
  default_branch: main
  code_host: github
  stack_summary: ${fixture.project.stack_summary}
  ai_plans_dir: ${fixture.commands.ai_plans_dir}
commands: {}
policies: {}
vendors: {}
foundation_skills: []
foundation_agents: []
`);
}

function buildState(state, appSrc) {
  const stateDir = join(HERE, fixture.states[state].path);
  console.log(`\n=== building state: ${state} → ${stateDir} ===`);
  copyApp(appSrc, stateDir);
  if (state === 'stale') seedHarness(stateDir, fixture.states.stale.bootstrappedFrom);
  if (state === 'current') seedHarness(stateDir, fixture.states.current.bootstrappedFrom);
  initRepo(stateDir, `chore: seed medplum-provider fixture (${state} state)`);
  console.log(`  committed ${state} @ ${shq('git', ['rev-parse', '--short', 'HEAD'], { cwd: stateDir })}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
const appSrc = fetchUpstream();
const states = onlyState ? [onlyState] : ['clean', 'stale', 'current'];
for (const s of states) {
  if (!fixture.states[s]) { console.error(`unknown state ${s}`); process.exit(2); }
  buildState(s, appSrc);
}
console.log('\n✓ fixture states built. They are gitignored — not committed to this repo.');
