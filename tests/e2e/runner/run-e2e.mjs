#!/usr/bin/env node
// run-e2e.mjs — the e2e harness runner CLI (PLAN §6, §11).
//
// Drives S0–S4 scenarios across the vendor × model matrix against isolated
// fixture copies, grades the outcome + git shape, captures telemetry, and
// writes a report. L2 is manual/human-triggered — this CLI is how a human
// initiates it (§11). Individual runnability is first-class: filter to one
// scenario / vendor / model and only that runs.
//
//   node tests/e2e/runner/run-e2e.mjs \
//     --scenario S3-bug --vendor claude-code --model claude-opus-4-8 \
//     --fixture medplum-provider --runs 1
//
// No --scenario/--vendor filter ⇒ the FULL matrix (an explicit, deliberate
// pre-release sweep). Use --list to see what's available; --dry-run to preview
// the matrix without spending; --vendor mock to self-test the plumbing for free.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  E2E_DIR, REPO_ROOT, loadJson, loadJsonc, writeJson, git,
  log, warn, err, C, round, pct,
} from './lib.mjs';
import { makeAdapter, resolveVendor, MATRIX_VENDORS, knownVendors } from './adapters/index.mjs';
import { isolate } from './isolation.mjs';
import { runGraders, scenarioPassed, knownGraders } from '../graders/index.mjs';
import { runJudge } from '../graders/judge.mjs';
import { answersLint } from '../graders/answers-lint.mjs';
import { buildRecord, aggregateCell } from '../telemetry/normalize.mjs';
import { diffAgainstBaseline, saveBaseline } from '../telemetry/baseline.mjs';
import { writeSummary, writeReport } from '../report/generate.mjs';

const SCENARIOS_DIR = join(E2E_DIR, 'scenarios');
const FIXTURES_DIR = join(E2E_DIR, 'fixtures');

// Default model per vendor when --model is omitted. Override on the CLI.
const DEFAULT_MODELS = {
  'claude-code': ['claude-opus-4-8'],
  codex: ['gpt-5-codex'],
  mock: ['mock'],
};

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    scenarios: [], vendors: [], models: [], fixture: null,
    runs: 1, resultsDir: null, judge: null, keep: false,
    dryRun: false, list: false, saveBaseline: false, failOnRegression: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    const csv = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
    if (a === '--scenario' || a === '-s') o.scenarios.push(...csv(next()));
    else if (a === '--vendor' || a === '-v') o.vendors.push(...csv(next()));
    else if (a === '--model' || a === '-m') o.models.push(...csv(next()));
    else if (a === '--fixture' || a === '-f') o.fixture = next();
    else if (a === '--runs' || a === '-n') o.runs = Number(next());
    else if (a === '--results-dir') o.resultsDir = next();
    else if (a === '--judge') o.judge = csv(next());
    else if (a === '--keep') o.keep = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--list') o.list = true;
    else if (a === '--save-baseline') o.saveBaseline = true;
    else if (a === '--no-fail-on-regression') o.failOnRegression = false;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { err(`unknown arg: ${a}`); printHelp(); process.exit(2); }
  }
  return o;
}

function printHelp() {
  log(`run-e2e — vinta-ai-workflows agentic E2E harness (manual, human-triggered)

Usage:
  run-e2e [filters] [options]

Filters (no filter ⇒ full matrix — a deliberate pre-release sweep):
  -s, --scenario <ids>   e.g. S3-bug  (comma-separated)
  -v, --vendor <names>   claude-code | codex | mock
  -m, --model <ids>      pin model(s); default per-vendor if omitted
  -f, --fixture <name>   restrict to scenarios using this fixture

Options:
  -n, --runs <N>         repeat each cell N times for pass-rate (default 1)
      --judge <dims>     also run advisory LLM-judge dims (spec-fidelity,...)
      --results-dir <d>  output root (default tests/e2e/../../results)
      --keep             keep isolated fixture copies (debug)
      --dry-run          print the matrix; run nothing
      --list             list scenarios / vendors / graders and exit
      --save-baseline    write this run's aggregate as the version baseline
      --no-fail-on-regression   exit 0 even if regression flags fire
  -h, --help

Examples:
  run-e2e --list
  run-e2e -s S2-feature -v mock --dry-run          # free plumbing check
  run-e2e -s S3-bug -v claude-code -m claude-opus-4-8 -n 1
`);
}

// ── discovery ─────────────────────────────────────────────────────────────────

function loadScenarios(filterIds) {
  if (!existsSync(SCENARIOS_DIR)) return [];
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.jsonc') || f.endsWith('.json'))
    .map((f) => loadJsonc(join(SCENARIOS_DIR, f)))
    .filter((s) => filterIds.length === 0 || filterIds.includes(s.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function loadFixture(name) {
  const dir = join(FIXTURES_DIR, name);
  const meta = join(dir, 'fixture.json');
  if (!existsSync(meta)) throw new Error(`fixture "${name}" has no fixture.json at ${meta}`);
  return { dir, tasksDir: join(dir, 'tasks'), meta: loadJson(meta) };
}

function pkgVersion() {
  return loadJson(join(REPO_ROOT, 'package.json')).version;
}

function gitSha() {
  return git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']).stdout.trim() || 'unknown';
}

// ── run one cell (scenario × vendor × model × run index) ──────────────────────

async function runCell({ scenario, vendor, model, runIndex, fixture, adapter, o }) {
  const { dir: cwd, baseRef, cleanup } = isolate(fixture.meta, fixture.dir, scenario.state, { keep: o.keep });
  const timeoutMs = (scenario.budget?.maxWallSec || 1800) * 1000;
  const steps = [];
  const cellStart = Date.now();
  try {
    for (const step of scenario.steps) {
      const res = await adapter.run(step, {
        model, cwd, timeoutMs,
        tasksDir: fixture.tasksDir, fixture: fixture.meta, scenario,
      });
      steps.push({ invoke: step.invoke, ...res });
      if (res.timedOut) { warn(`    ${step.invoke} hit maxWallSec — hard-stopped`); break; }
      if (res.exitCode !== 0) warn(`    ${step.invoke} exited ${res.exitCode}`);
    }

    const ctx = {
      cwd, baseRef, timeoutMs,
      fixture: fixture.meta, scenario, tasksDir: fixture.tasksDir, steps,
      resolveFixturePath: (p) => join(fixture.dir, p),
    };
    // answers-lint is implicit on every scenario (§6) unless already listed.
    const graderIds = scenario.graders.includes('answers-lint')
      ? scenario.graders : [...scenario.graders, 'answers-lint'];
    const graderResults = runGraders(graderIds, ctx);

    let judge = null;
    if (o.judge?.length) {
      judge = await runJudge(ctx, o.judge, { model: DEFAULT_MODELS['claude-code'][0] });
    }

    const record = buildRecord({
      pkgVersion: pkgVersion(), gitSha: gitSha(),
      vendor, model, scenario: scenario.id, run: runIndex,
      graderResults, judge, steps, wallSec: (Date.now() - cellStart) / 1000,
    });

    const outDir = join(resultsRoot(o), pkgVersion(), vendor, model, scenario.id);
    const outPath = join(outDir, `run-${runIndex}.json`);
    writeJson(outPath, { ...record, baseRef, transcripts: steps.map((s) => ({ invoke: s.invoke, transcript: s.transcript })) });

    return { record, outPath, graderResults };
  } finally {
    cleanup();
  }
}

function resultsRoot(o) {
  return o.resultsDir || join(REPO_ROOT, 'results');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.list) {
    const scenarios = loadScenarios([]);
    log(`${C.bold}Scenarios:${C.reset}`);
    for (const s of scenarios) log(`  ${s.id}  (fixture=${s.fixture}, state=${s.state}, graders=${s.graders.join('+')})`);
    log(`\n${C.bold}Vendors:${C.reset} ${knownVendors().join(', ')}  (matrix default: ${MATRIX_VENDORS.join(', ')})`);
    log(`${C.bold}Graders:${C.reset} ${knownGraders().join(', ')}`);
    return 0;
  }

  let scenarios = loadScenarios(o.scenarios);
  if (o.fixture) scenarios = scenarios.filter((s) => s.fixture === o.fixture);
  if (scenarios.length === 0) { err('no scenarios matched the filters'); return 2; }

  const vendors = (o.vendors.length ? o.vendors.map(resolveVendor) : MATRIX_VENDORS);
  if (vendors.some((v) => !v)) { err(`unknown vendor in ${o.vendors.join(',')}`); return 2; }

  // Build & print the matrix.
  const matrix = [];
  for (const scenario of scenarios) {
    for (const vendor of vendors) {
      const models = o.models.length ? o.models : (DEFAULT_MODELS[vendor] || []);
      if (models.length === 0) { warn(`no model for vendor ${vendor}; pass --model`); continue; }
      for (const model of models) matrix.push({ scenario, vendor, model });
    }
  }

  log(`${C.bold}Matrix:${C.reset} ${matrix.length} cell(s) × ${o.runs} run(s) = ${matrix.length * o.runs} run(s)`);
  for (const c of matrix) log(`  ${C.dim}${c.scenario.id} · ${c.vendor} · ${c.model}${C.reset}`);
  if (o.dryRun) { log('\n(dry-run — nothing executed)'); return 0; }

  // Group records per cell for aggregation.
  const cellRecords = new Map();
  const cellFailures = new Map();

  for (const cell of matrix) {
    const adapter = makeAdapter(cell.vendor);
    const avail = adapter.available();
    const key = `${cell.scenario.id}|${cell.vendor}|${cell.model}`;
    if (!avail.available) {
      warn(`SKIP ${key} — ${avail.reason}`); // §11: skipped, never passed
      continue;
    }
    let fixture;
    try { fixture = loadFixture(cell.scenario.fixture); }
    catch (e) { err(`SKIP ${key} — ${e.message}`); continue; }

    for (let r = 1; r <= o.runs; r++) {
      log(`\n${C.cyan}▶ ${key} — run ${r}/${o.runs}${C.reset}`);
      let result;
      try {
        result = await runCell({ ...cell, scenario: cell.scenario, runIndex: r, fixture, adapter, o });
      } catch (e) {
        err(`  run failed: ${e.message}`);
        continue;
      }
      const passed = scenarioPassed(result.graderResults);
      for (const g of result.graderResults) {
        const mark = g.pass ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        log(`  ${mark} ${g.id}`);
        if (!g.pass) for (const d of g.details.filter((x) => x.startsWith('✗'))) log(`      ${C.dim}${d}${C.reset}`);
      }
      log(`  ${passed ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ` +
        `tokens=${result.record.usage.inTok + result.record.usage.outTok} cost=$${result.record.usage.costUsd} wall=${result.record.wallSec}s`);

      if (!cellRecords.has(key)) cellRecords.set(key, []);
      cellRecords.get(key).push(result.record);
      if (!passed) {
        if (!cellFailures.has(key)) cellFailures.set(key, []);
        cellFailures.get(key).push({
          run: r,
          failedGraders: result.graderResults.filter((g) => !g.pass).map((g) => g.id),
          transcriptPath: result.outPath,
        });
      }
    }
  }

  if (cellRecords.size === 0) { warn('\nno cells ran (all skipped?)'); return 0; }

  // Aggregate + baseline diff + report.
  const cells = [...cellRecords.values()].map((records) => {
    const agg = aggregateCell(records);
    agg.failures = cellFailures.get(`${agg.scenario}|${agg.vendor}|${agg.model}`) || [];
    return agg;
  });

  const baseline = diffAgainstBaseline(cells, pkgVersion());
  const resDir = join(resultsRoot(o), pkgVersion());
  const summary = writeSummary(resDir, { version: pkgVersion(), gitSha: gitSha(), cells, baseline });
  writeReport(resDir, summary);

  if (o.saveBaseline) { saveBaseline(pkgVersion(), cells); log(`\nsaved baseline for ${pkgVersion()}`); }

  // Console summary.
  log(`\n${C.bold}── Summary ──${C.reset}`);
  for (const c of cells) {
    log(`  ${c.scenario} · ${c.vendor} · ${c.model}: pass-rate ${pct(c.passRate)}, median ${round((c.tokens.median) / 1000, 1)}k tok`);
  }
  if (baseline.flags.length) {
    warn(`\n${baseline.flags.length} regression flag(s) vs baseline ${baseline.baselineVersion}:`);
    for (const f of baseline.flags) warn(`  - ${f}`);
  }
  log(`\nReport: ${join(resDir, 'REPORT.md')}`);

  const anyFail = cells.some((c) => c.passRate < 1);
  if (baseline.flags.length && o.failOnRegression) return 1;
  return anyFail ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { err(e.stack || e.message); process.exit(1); });
