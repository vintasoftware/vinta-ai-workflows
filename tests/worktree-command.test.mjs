import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATES = join(REPO_ROOT, 'skills/vinta-bootstrap-ai-tools/resources/worktree-command');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// The generated scripts with no PROJECT STEPS filled in: the contract plumbing
// alone, rendered the way the bootstrap renders it.
function makeProject() {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-cmd-'));
  const origin = join(tmp, 'origin.git');
  const main = join(tmp, 'demo');
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '--quiet', origin, main);
  git(main, 'config', 'user.email', 'test@example.com');
  git(main, 'config', 'user.name', 'Test');
  writeFileSync(join(main, '.gitignore'), '.claude/\n.vinta-ai-workflows/\n');
  const dir = join(main, 'scripts/worktree');
  mkdirSync(dir, { recursive: true });
  for (const name of ['lib', 'prepare', 'teardown']) {
    const body = readFileSync(join(TEMPLATES, `${name}-template.sh`), 'utf8')
      .replaceAll('{{WORKTREE_ROOT}}', '.claude/worktrees')
      .replaceAll('{{DEFAULT_BRANCH}}', 'main')
      .replaceAll('{{SUMMARY_DIR}}', '.vinta-ai-workflows/worktrees')
      .replaceAll('{{PROJECT_NAME}}', 'demo')
      .replaceAll('{{SCRIPT_DIR}}', 'scripts/worktree');
    assert.doesNotMatch(body, /\{\{[A-Z_]+\}\}/, `${name}: a placeholder survived`);
    writeFileSync(join(dir, `${name}.sh`), body);
    chmodSync(join(dir, `${name}.sh`), 0o755);
  }
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'init');
  git(main, 'push', '--quiet', 'origin', 'main');
  return { tmp, main, dir };
}

function envFor(main, name, extra = {}) {
  return {
    ...process.env,
    VINTA_WORKTREE_NAME: name,
    VINTA_WORKTREE_PATH: join(main, '.claude/worktrees', name),
    VINTA_WORKTREE_BRANCH: `plan/demo/wt-${name}`,
    VINTA_WORKTREE_BASE_REF: 'origin/main',
    VINTA_WORKTREE_KIND: 'lane',
    VINTA_MAIN_CHECKOUT: main,
    VINTA_PLAN_PATH: join(main, 'ai-plans/demo_PLAN.md'),
    VINTA_WORKTREE_SUMMARY: join(main, '.vinta-ai-workflows/worktrees', `${name}.yaml`),
    ...extra,
  };
}

const sh = (main, script, env, args = []) =>
  spawnSync(join(main, 'scripts/worktree', script), args, { cwd: main, env, encoding: 'utf8' });

test('generated scripts parse as bash', () => {
  const { tmp, dir } = makeProject();
  try {
    for (const name of ['lib', 'prepare', 'teardown']) {
      const r = spawnSync('bash', ['-n', join(dir, `${name}.sh`)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dry run writes nothing', () => {
  const { tmp, main } = makeProject();
  try {
    const env = envFor(main, 'lane-1', { VINTA_WORKTREE_DRY_RUN: '1' });
    const r = sh(main, 'prepare.sh', env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\+ git -C .* worktree add/);
    assert.equal(existsSync(env.VINTA_WORKTREE_PATH), false);
    assert.equal(existsSync(env.VINTA_WORKTREE_SUMMARY), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepare meets the conductor checks, teardown undoes it, and the name can be reused', () => {
  const { tmp, main } = makeProject();
  try {
    const env = envFor(main, 'lane-1');
    const before = git(main, 'status', '--short');

    const r = sh(main, 'prepare.sh', env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(env.VINTA_WORKTREE_PATH, 'rev-parse', '--abbrev-ref', 'HEAD'), env.VINTA_WORKTREE_BRANCH);
    assert.ok(git(main, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${realpathSync(env.VINTA_WORKTREE_PATH)}`));
    assert.equal(git(main, 'status', '--short'), before);

    const summary = parseYaml(readFileSync(env.VINTA_WORKTREE_SUMMARY, 'utf8'));
    assert.equal(summary.name, 'lane-1');
    assert.equal(summary.branch, env.VINTA_WORKTREE_BRANCH);
    assert.equal(summary.state.dev_db, null);
    assert.equal(summary.state.compose, null);
    assert.deepEqual(Object.keys(summary.state).sort(), ['compose', 'deps', 'dev_db', 'env', 'other', 'sandbox', 'test_db']);

    // A second prepare for the same name refuses rather than clobbering.
    assert.notEqual(sh(main, 'prepare.sh', env).status, 0);

    const t = sh(main, 'teardown.sh', env);
    assert.equal(t.status, 0, t.stderr);
    assert.equal(existsSync(env.VINTA_WORKTREE_PATH), false);
    assert.equal(existsSync(env.VINTA_WORKTREE_SUMMARY), false);
    assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${env.VINTA_WORKTREE_BRANCH}`], { cwd: main }).status, 1);

    // Teardown is idempotent, and the name provisions again afterwards.
    assert.equal(sh(main, 'teardown.sh', env).status, 0);
    assert.equal(sh(main, 'prepare.sh', env).status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('teardown keeps a worktree with uncommitted changes unless forced', () => {
  const { tmp, main } = makeProject();
  try {
    const env = envFor(main, 'lane-2');
    assert.equal(sh(main, 'prepare.sh', env).status, 0);
    writeFileSync(join(env.VINTA_WORKTREE_PATH, 'wip.txt'), 'work in progress\n');

    const refused = sh(main, 'teardown.sh', env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /uncommitted changes/);
    assert.ok(existsSync(join(env.VINTA_WORKTREE_PATH, 'wip.txt')));

    assert.equal(sh(main, 'teardown.sh', env, ['--force']).status, 0);
    assert.equal(existsSync(env.VINTA_WORKTREE_PATH), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the database guards refuse remote hosts and foreign names without leaking the URL', () => {
  const { tmp, main, dir } = makeProject();
  try {
    const probe = (snippet) =>
      spawnSync('bash', ['-c', `set -euo pipefail; . "${dir}/lib.sh" lane-3; ${snippet}`], { cwd: main, encoding: 'utf8' });

    const remote = probe('require_local_url "postgres://app:s3cret@db.prod.example.com:5432/app"');
    assert.notEqual(remote.status, 0);
    assert.doesNotMatch(remote.stderr, /s3cret/);

    assert.equal(probe('require_local_url "postgres://app:pw@localhost:5432/app"').status, 0);
    assert.equal(probe('require_local_url "postgres://app:pw@[::1]:5432/app"').status, 0);
    assert.notEqual(probe('require_forked_name app_dev').status, 0);
    assert.equal(probe('require_forked_name "$(forked_db_name app_dev)"').status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a filled database region lands in the summary as valid YAML', () => {
  const { tmp, main, dir } = makeProject();
  try {
    const prepare = join(dir, 'prepare.sh');
    const filled = readFileSync(prepare, 'utf8').replace(
      '# <<< dev_db',
      [
        'DEV_DB_ENGINE=postgres DEV_DB_URL_VAR=DATABASE_URL',
        'DEV_DB_FORKED="$(forked_db_name app_dev)"',
        `DEV_DB_RESET="dropdb --if-exists $DEV_DB_FORKED && createdb -T 'app_dev' $DEV_DB_FORKED"`,
        '# <<< dev_db',
      ].join('\n')
    );
    writeFileSync(prepare, filled);
    const env = envFor(main, 'lane-4');
    const r = sh(main, 'prepare.sh', env);
    assert.equal(r.status, 0, r.stderr);
    const db = parseYaml(readFileSync(env.VINTA_WORKTREE_SUMMARY, 'utf8')).state.dev_db;
    assert.deepEqual(db, {
      engine: 'postgres',
      strategy: 'fork',
      forked_name: 'app_dev_wt_lane_4',
      connection_url_var: 'DATABASE_URL',
      reset_cmd: "dropdb --if-exists app_dev_wt_lane_4 && createdb -T 'app_dev' app_dev_wt_lane_4",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
