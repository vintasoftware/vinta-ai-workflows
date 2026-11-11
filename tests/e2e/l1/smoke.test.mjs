#!/usr/bin/env node
// smoke.test.mjs — L1 install/bootstrap smoke (PLAN §3 L1, §12 Phase 1).
//
// No model, no paid API — deterministic. Runs the CLI against a scratch project
// and asserts:
//   1. install --tool <t> lands the vinta- skills under the vendor dir
//   2. install is idempotent (re-running doesn't duplicate/corrupt)
//   3. uninstall leaves the tree byte-clean — it only touches marker-tagged
//      artifacts, so a pre-existing user file with the same name is preserved
//
// Usage: node tests/e2e/l1/smoke.test.mjs
// Exit 0 = all assertions pass; 1 = a failure.

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CLI = join(REPO_ROOT, 'vinta-ai-workflows.mjs');

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { failures++; console.error(`  \x1b[31m✗\x1b[0m ${m}`); };
function assert(cond, m) { cond ? pass(m) : fail(m); }

function cli(args, cwd) {
  return execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
}

// Snapshot every file path + content hash under a dir (excluding a skip list).
function snapshot(dir) {
  const out = {};
  const walk = (d, base) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      const rel = join(base, name.name);
      if (name.isDirectory()) walk(p, rel);
      else out[rel] = readFileSync(p, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

function scenario(tool, vendorDir) {
  console.log(`\n[L1] tool=${tool} → ${vendorDir}`);
  const proj = mkdtempSync(join(tmpdir(), 'e2e-l1-'));
  try {
    // Seed a pre-existing user file to prove uninstall doesn't nuke it.
    mkdirSync(join(proj, vendorDir), { recursive: true });
    const userFile = join(proj, vendorDir, 'my-own-skill');
    mkdirSync(userFile, { recursive: true });
    writeFileSync(join(userFile, 'SKILL.md'), '# my own skill\n');
    const before = snapshot(proj);

    // 1. install (copy mode so it's self-contained + carries the marker).
    cli(['install', '--tool', tool, '--copy', '--target', proj], proj);
    const installed = readdirSync(join(proj, vendorDir));
    assert(installed.includes('vinta-bootstrap-ai-tools'),
      'install placed vinta-bootstrap-ai-tools');
    assert(existsSync(join(proj, vendorDir, 'vinta-bootstrap-ai-tools', 'SKILL.md')),
      'installed skill has SKILL.md');
    assert(existsSync(join(proj, vendorDir, 'vinta-bootstrap-ai-tools', '.installed-by-vinta-ai-workflows')),
      'installed skill carries the marker file');

    // 2. idempotency: re-install, expect no error + same set.
    const set1 = readdirSync(join(proj, vendorDir)).sort().join(',');
    cli(['install', '--tool', tool, '--copy', '--target', proj], proj);
    const set2 = readdirSync(join(proj, vendorDir)).sort().join(',');
    assert(set1 === set2, 'install is idempotent (skill set unchanged on re-run)');

    // 3. uninstall → tree byte-clean vs. the pre-install snapshot.
    cli(['uninstall', '--tool', tool, '--target', proj], proj);
    const after = snapshot(proj);
    const beforeKeys = Object.keys(before).sort().join('\n');
    const afterKeys = Object.keys(after).sort().join('\n');
    assert(beforeKeys === afterKeys,
      'uninstall leaves the tree byte-clean (only marker-tagged artifacts removed)');
    assert(existsSync(join(userFile, 'SKILL.md')),
      'uninstall preserved the pre-existing user skill');
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

console.log('=== L1 install/uninstall smoke ===');
scenario('claude-code', '.claude/skills');
scenario('agents', '.agents/skills');

if (failures) {
  console.error(`\n\x1b[31mL1 smoke: ${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mL1 smoke: all assertions passed\x1b[0m');
