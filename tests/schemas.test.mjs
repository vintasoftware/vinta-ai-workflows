import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('every schema compiles and every fixture validates as its directory says', () => {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/validate-schemas.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
