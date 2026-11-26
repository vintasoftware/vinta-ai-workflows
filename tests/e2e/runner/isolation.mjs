// isolation.mjs — per-run isolated fixture copies (PLAN §6 isolation).
//
// Every run operates on a throwaway copy of the fixture state — never the
// vendored fixture in place. We clone the state's git repo into a tmp dir and
// check out the frozen ref, so each run starts from an identical, committed
// baseline and the git-tree grader has a real base to diff against.
//
// (The sandboxing of *agent permissions* — pre-granting filesystem writes so a
// headless agent doesn't stall — is handled per-adapter, e.g. Claude Code's
// --dangerously-skip-permissions. This module handles filesystem isolation.
// See feat/filesystem-sandbox-for-worktrees for stronger OS-level sandboxing.)

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, run } from './lib.mjs';

// Resolve a fixture state to { repoDir, ref } from fixture.json.
export function resolveState(fixture, fixtureDir, state) {
  const s = fixture.states?.[state];
  if (!s) throw new Error(`fixture "${fixture.name}" has no state "${state}" in fixture.json`);
  const repoDir = resolve(fixtureDir, s.path);
  return { repoDir, ref: s.ref || 'HEAD', vendored: existsSync(repoDir) };
}

// Create an isolated copy of a fixture state. Returns { dir, baseRef, cleanup }.
export function isolate(fixture, fixtureDir, state, { keep = false } = {}) {
  const { repoDir, ref, vendored } = resolveState(fixture, fixtureDir, state);
  if (!vendored) {
    throw new Error(
      `fixture state not vendored: ${repoDir}\n`
      + `Run the fixture vendoring script first (e.g. \`node tests/e2e/fixtures/${fixture.name}/vendor.mjs\`).`,
    );
  }
  if (!existsSync(join(repoDir, '.git'))) {
    throw new Error(`fixture state at ${repoDir} is not a git repo — vendoring must commit each state`);
  }

  const dir = mkdtempSync(join(tmpdir(), `e2e-${fixture.name}-${state}-`));
  // Local clone is fast (hardlinks) and gives us a real repo to diff against.
  const clone = run('git', ['clone', '--quiet', '--no-hardlinks', repoDir, dir]);
  if (clone.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git clone of fixture failed: ${clone.stderr}`);
  }
  const co = git(dir, ['checkout', '--quiet', ref]);
  if (co.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git checkout ${ref} failed: ${co.stderr}`);
  }
  // Detach & record base so graders diff new work against exactly this ref.
  const baseSha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  // Ensure a committer identity exists for agent commits inside the copy.
  git(dir, ['config', 'user.name', 'e2e-runner']);
  git(dir, ['config', 'user.email', 'e2e@vinta.local']);

  return {
    dir,
    baseRef: baseSha,
    cleanup() {
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}
