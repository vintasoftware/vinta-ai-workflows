// outcome.mjs — outcome graders (PLAN §7): the app actually works.
//
//   app-tests-pass — run the fixture's test command; all pass. For medplum this
//                    is `vitest` against MockClient, fully offline (§4).
//   script-output  — S4: the produced one-off script exists, runs
//                    non-interactively, and emits its expected artifact.
//   bug-fixed      — S3: the previously-failing target test flips red→green with
//                    no new regressions, and the fix touches the planted region.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, git, walk } from '../runner/lib.mjs';

// Split a "cmd arg arg" string into argv (fixtures declare commands as strings).
function argv(cmd) {
  return cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g).map((s) => s.replace(/^["']|["']$/g, ''));
}

export function appTestsPass(ctx) {
  const cmd = ctx.fixture?.commands?.test;
  if (!cmd) {
    return { id: 'app-tests-pass', tier: 'deterministic', pass: false,
      details: ['✗ fixture.json declares no `commands.test`'] };
  }
  const [bin, ...args] = argv(cmd);
  const res = run(bin, args, { cwd: ctx.cwd, timeoutMs: (ctx.timeoutMs || 1800000) });
  const pass = res.code === 0;
  return {
    id: 'app-tests-pass',
    tier: 'deterministic',
    pass,
    details: [
      pass ? `✓ \`${cmd}\` passed (${res.wallSec}s)` : `✗ \`${cmd}\` exited ${res.code}`,
      ...(pass ? [] : [tail(res.stdout + res.stderr, 40)]),
    ],
  };
}

export function scriptOutput(ctx) {
  const spec = ctx.scenario?.expect?.script;
  if (!spec) {
    return { id: 'script-output', tier: 'deterministic', pass: false,
      details: ['✗ scenario declares no expect.script { run, artifact }'] };
  }
  const details = [];
  let pass = true;
  const fail = (m) => { pass = false; details.push(`✗ ${m}`); };

  // The script should have landed *somewhere* under the scripts dir.
  const scriptsDir = ctx.fixture?.commands?.scripts_dir || 'scripts';
  const found = walk(join(ctx.cwd, scriptsDir));
  if (found.length === 0) fail(`no script created under ${scriptsDir}/`);
  else details.push(`✓ script(s) present under ${scriptsDir}/`);

  // Run it non-interactively and check the expected artifact appears.
  if (spec.run) {
    const [bin, ...args] = argv(spec.run);
    const res = run(bin, args, { cwd: ctx.cwd, timeoutMs: 300000, input: '' });
    if (res.code !== 0) fail(`\`${spec.run}\` exited ${res.code}: ${tail(res.stderr, 10)}`);
    else details.push(`✓ \`${spec.run}\` ran clean`);
  }
  if (spec.artifact) {
    if (existsSync(join(ctx.cwd, spec.artifact))) details.push(`✓ produced ${spec.artifact}`);
    else fail(`expected artifact ${spec.artifact} not produced`);
  }
  return { id: 'script-output', tier: 'deterministic', pass, details };
}

export function bugFixed(ctx) {
  const spec = ctx.scenario?.expect?.bug;
  if (!spec) {
    return { id: 'bug-fixed', tier: 'deterministic', pass: false,
      details: ['✗ scenario declares no expect.bug { testCmd, region }'] };
  }
  const details = [];
  let pass = true;
  const fail = (m) => { pass = false; details.push(`✗ ${m}`); };
  const ok = (m) => details.push(`✓ ${m}`);

  // 1. The full suite passes now (target test green + no regressions).
  const cmd = spec.testCmd || ctx.fixture?.commands?.test;
  const [bin, ...args] = argv(cmd);
  const res = run(bin, args, { cwd: ctx.cwd, timeoutMs: (ctx.timeoutMs || 1800000) });
  if (res.code === 0) ok(`test suite green after fix (\`${cmd}\`)`);
  else fail(`test suite still failing:\n${tail(res.stdout + res.stderr, 30)}`);

  // 2. The fix touched the planted-bug region (guard against "deleted the test").
  if (spec.region) {
    const base = ctx.baseRef || 'HEAD~1';
    const diff = git(ctx.cwd, ['diff', '--name-only', base, 'HEAD']);
    const touched = diff.stdout.split('\n').filter(Boolean);
    if (touched.some((f) => f.includes(spec.region))) ok(`fix touched planted region ${spec.region}`);
    else fail(`fix did not touch planted region ${spec.region} (touched: ${touched.join(', ') || 'nothing'})`);

    // Sanity: the target test file must still exist and not be gutted.
    if (spec.testFile) {
      const tf = join(ctx.cwd, spec.testFile);
      if (!existsSync(tf)) fail(`target test file ${spec.testFile} was deleted`);
      else if ((readFileSync(tf, 'utf8').match(/\b(it|test)\s*\(/g) || []).length === 0) {
        fail(`target test file ${spec.testFile} has no tests left — gutted?`);
      } else ok('target test file intact');
    }
  }

  return { id: 'bug-fixed', tier: 'deterministic', pass, details };
}

const tail = (s, n) => (s || '').split('\n').slice(-n).join('\n');
