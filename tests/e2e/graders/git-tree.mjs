// git-tree.mjs — the "commit tree looks healthy" grader (PLAN §7).
//
// Deterministic, git-porcelain based. Asserts the invariants a healthy agent
// run should leave behind:
//   - working tree clean (no uncommitted leftovers, no conflict markers)
//   - commit messages match the conventional-commit shape
//   - commits are logically scoped (no giant "WIP" dumps)
//   - no committed secrets / obvious fixture noise
//   - when the scenario expects stacked phase branches, they exist and descend
//     from the right base (guards fix/stack-branches-base-resolution)

import { git } from '../runner/lib.mjs';

const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?!?: .+/;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
];

export function gitTreeHealthy(ctx) {
  const { cwd, scenario } = ctx;
  const details = [];
  let pass = true;
  const fail = (m) => { pass = false; details.push(`✗ ${m}`); };
  const ok = (m) => details.push(`✓ ${m}`);

  // 1. Working tree clean.
  const status = git(cwd, ['status', '--porcelain']);
  if (status.stdout.trim()) fail(`working tree dirty:\n${indent(status.stdout.trim())}`);
  else ok('working tree clean');

  // 2. New commits exist since the baseline (the fixture's starting ref).
  const base = ctx.baseRef || 'HEAD';
  const range = ctx.baseRef ? `${base}..HEAD` : null;
  const logArgs = ['log', '--no-merges', '--format=%H%x1f%s%x1f%an'];
  if (range) logArgs.push(range);
  else logArgs.push('-20');
  const logRes = git(cwd, logArgs);
  const commits = logRes.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, subject, author] = l.split('\x1f');
    return { hash, subject, author };
  });

  if (range && commits.length === 0) {
    fail('no new commits since fixture baseline — agent produced nothing committed');
  } else {
    ok(`${commits.length} commit(s) evaluated`);
  }

  // 3. Conventional-commit subjects.
  for (const c of commits) {
    if (!CONVENTIONAL.test(c.subject)) {
      fail(`non-conventional commit subject: "${c.subject}"`);
    }
    if (/\bWIP\b/i.test(c.subject)) fail(`WIP commit left in history: "${c.subject}"`);
  }
  if (commits.every((c) => CONVENTIONAL.test(c.subject)) && commits.length) {
    ok('all commit subjects conventional');
  }

  // 4. Logical scoping — no single monster commit.
  for (const c of commits) {
    const st = git(cwd, ['show', '--stat', '--format=', c.hash]);
    const changed = st.stdout.match(/(\d+) insertions?\(\+\)/);
    const inserted = changed ? Number(changed[1]) : 0;
    if (inserted > 2000) {
      fail(`commit ${short(c.hash)} adds ${inserted} lines — likely unscoped dump`);
    }
  }

  // 5. No conflict markers anywhere tracked.
  const grep = git(cwd, ['grep', '-lE', '^(<<<<<<<|=======|>>>>>>>)', 'HEAD']);
  if (grep.code === 0 && grep.stdout.trim()) {
    fail(`conflict markers present in: ${grep.stdout.trim().split('\n').join(', ')}`);
  } else {
    ok('no conflict markers');
  }

  // 6. No obvious secrets in the new diff.
  if (range) {
    const diff = git(cwd, ['diff', base, 'HEAD']);
    for (const re of SECRET_PATTERNS) {
      if (re.test(diff.stdout)) fail(`possible committed secret matching ${re}`);
    }
  }

  // 7. Stacked phase branches, when the scenario declares them.
  const expectStack = scenario?.expect?.stackedBranches;
  if (expectStack) {
    const branches = git(cwd, ['branch', '--list', 'plan/*']).stdout
      .split('\n').map((b) => b.replace(/^[*+]?\s*/, '').trim()).filter(Boolean);
    if (branches.length === 0) {
      fail('scenario expects stacked plan/<feature>/phase-N branches; none found');
    } else {
      ok(`stacked branches present: ${branches.join(', ')}`);
      // Each phase-N must descend from phase-(N-1) or the base — never orphaned.
      for (const b of branches) {
        const mergeBase = git(cwd, ['merge-base', b, base]);
        if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
          fail(`branch ${b} does not descend from base ${base} (base-resolution bug)`);
        }
      }
    }
  }

  return { id: 'git-tree-healthy', tier: 'deterministic', pass, details };
}

const short = (h) => (h || '').slice(0, 8);
const indent = (s) => s.split('\n').map((l) => `    ${l}`).join('\n');
