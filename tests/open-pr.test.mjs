import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OPEN_PR = join(
  REPO_ROOT,
  'skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh'
);

// The script needs Mike Farah's yq and jq; skip rather than fail where they're absent.
function missingDeps() {
  for (const [cmd, args] of [['jq', ['--version']], ['git', ['--version']], ['yq', ['--version']]]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status !== 0) return `${cmd} not installed`;
    if (cmd === 'yq' && !r.stdout.includes('mikefarah')) return 'yq is not mikefarah/yq';
  }
  return false;
}

const CONTEXT = `---
plan_id: demo
phase_id: p1
branch: feat/demo
base: main
status: draft
pr_url: null
---

# Title

Add the demo thing


# Description

First paragraph.

Second paragraph.


# Comments

\`\`\`yaml
- file: src/a.py
  start_line: 3
  side: right
  body: lowercase side
- file: src/b.py
  start_line: 10
  end_line: 14
  body: |
    multi-line
    comment
\`\`\`

## Publish log

- 2026-01-01T00:00:00Z — earlier entry
`;

// A `gh` that is authed, has no PR for the branch yet, and 422s every comment.
const GH_STUB = `#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")/.." && pwd)"
case "$1 $2" in
  "auth status") exit 0 ;;
  "pr view") exit 1 ;;
  "pr create")
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --title) printf '%s' "$2" > "$dir/title.txt"; shift ;;
        --body) printf '%s' "$2" > "$dir/body.txt"; shift ;;
      esac
      shift
    done
    echo "https://github.com/o/r/pull/7" ;;
  "repo view") echo "o/r" ;;
  "api --method")
    printf '%s\\n' "$@" >> "$dir/api-calls.txt"
    echo "gh: Validation Failed (HTTP 422)" >&2
    echo '{"message":"Validation Failed"}' >&2
    exit 1 ;;
  *) exit 1 ;;
esac
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'open-pr-test-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(root, 'init', '-q', '--bare', 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', '../origin.git');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/demo');
  git(repo, 'fetch', '-q', 'origin');
  writeFileSync(join(repo, 'ctx.md'), CONTEXT);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/gh'), GH_STUB);
  chmodSync(join(root, 'bin/gh'), 0o755);
  // System dirs first so macOS runs pick up BSD sed/awk over any Homebrew GNU ones.
  const PATH = ['/usr/bin', '/bin', join(root, 'bin'), process.env.PATH].join(delimiter);
  const run = (...args) =>
    spawnSync('bash', [OPEN_PR, 'ctx.md', '--cli', 'gh', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH },
    });
  return { root, repo, run };
}

test('dry run parses sections without sed/awk errors', { skip: missingDeps() }, () => {
  const { root, run } = setup();
  try {
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /sed:|awk:|unused label|newline in string/);
    assert.match(r.stdout, /would post 2 comment\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish surfaces API errors, upper-cases side, appends to an existing publish log', { skip: missingDeps() }, () => {
  const { root, repo, run } = setup();
  try {
    const r = run();
    assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /sed:|awk:|unused label|newline in string/);

    const errorLines = r.stderr.split('\n').filter((l) => l.includes('gh error:'));
    assert.equal(errorLines.length, 2);
    assert.match(errorLines[0], /gh error: gh: Validation Failed \(HTTP 422\) \{"message":"Validation Failed"\}$/);

    assert.equal(readFileSync(join(root, 'title.txt'), 'utf8'), 'Add the demo thing');
    // Trailing blank lines are trimmed; leading ones are left for the CLI to ignore.
    const body = readFileSync(join(root, 'body.txt'), 'utf8');
    assert.equal(body.replace(/^\n+/, ''), 'First paragraph.\n\nSecond paragraph.');

    const api = readFileSync(join(root, 'api-calls.txt'), 'utf8').split('\n');
    assert.equal(api.filter((a) => a === 'side=RIGHT').length, 2);
    assert.ok(api.includes('start_side=RIGHT'));
    assert.ok(api.includes('start_line=10'));
    assert.ok(api.includes('line=14'));
    assert.ok(!api.some((a) => /side=right/.test(a)));

    const out = readFileSync(join(repo, 'ctx.md'), 'utf8');
    assert.match(out, /^status: published$/m);
    assert.match(out, /^pr_url: https:\/\/github\.com\/o\/r\/pull\/7$/m);
    assert.equal(out.match(/^## Publish log$/gm).length, 1);
    const log = out.slice(out.indexOf('## Publish log')).split('\n').filter((l) => l.startsWith('- '));
    assert.equal(log.length, 4);
    assert.match(log[0], /earlier entry$/);
    assert.match(log[1], /— opened: https:\/\/github\.com\/o\/r\/pull\/7$/);
    assert.match(log[2], /comment 1\/2 FAILED \(src\/a\.py:3\)$/);
    assert.match(log[3], /comment 2\/2 FAILED \(src\/b\.py:10-14\)$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
