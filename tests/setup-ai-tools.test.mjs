import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SETUP_SCRIPT = join(
  REPO_ROOT,
  'skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs'
);

test('Codex agent descriptions escape TOML control characters', () => {
  const fixtureRoot = mkdtempSync(join(REPO_ROOT, '.setup-ai-tools-test-'));
  const description = 'first line\nsecond\t"quoted"\\path';

  try {
    mkdirSync(join(fixtureRoot, 'ai-tools/agents'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'ai-tools/scripts'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'ai-tools/skills'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(fixtureRoot, 'ai-tools/scripts/setup-ai-tools.mjs'));
    writeFileSync(join(fixtureRoot, '.gitignore'), '');
    writeFileSync(
      join(fixtureRoot, 'ai-tools/agents/fixture.yaml'),
      [
        'schema_version: 1',
        'name: fixture',
        `description: ${JSON.stringify(description)}`,
        'access: read-only',
        'body: |',
        '  # Fixture agent',
        '',
      ].join('\n')
    );

    execFileSync(process.execPath, ['ai-tools/scripts/setup-ai-tools.mjs', '--only', 'codex'], {
      cwd: fixtureRoot,
      stdio: 'pipe',
    });

    const generated = readFileSync(join(fixtureRoot, '.codex/agents/fixture.toml'), 'utf8');
    const descriptionLine = generated.split('\n').find((line) => line.startsWith('description = '));
    assert.equal(descriptionLine, `description = ${JSON.stringify(description)}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
