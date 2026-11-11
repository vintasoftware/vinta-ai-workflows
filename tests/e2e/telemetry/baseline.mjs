// baseline.mjs — version-over-version regression flags (PLAN §8).
//
// A run compares its aggregated cells against the previous released baseline
// (tests/e2e/baselines/<version>.json) and flags: pass-rate drops, or a
// token/cost increase beyond a threshold (default 20% per scenario).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadJson, writeJson, E2E_DIR, round } from '../runner/lib.mjs';

const BASELINES_DIR = join(E2E_DIR, 'baselines');
const THRESHOLD = 0.2; // 20%

function cellKey(c) { return `${c.scenario}|${c.vendor}|${c.model}`; }

// Pick the most recent baseline that isn't the current version.
export function previousBaseline(currentVersion) {
  if (!existsSync(BASELINES_DIR)) return null;
  const files = readdirSync(BASELINES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((v) => v !== currentVersion)
    .sort(semverCompare);
  const chosen = files[files.length - 1];
  return chosen ? { version: chosen, data: loadJson(join(BASELINES_DIR, `${chosen}.json`)) } : null;
}

export function diffAgainstBaseline(cells, currentVersion) {
  const prev = previousBaseline(currentVersion);
  if (!prev) return { baselineVersion: null, flags: [], comparisons: [] };

  const prevCells = new Map((prev.data.cells || []).map((c) => [cellKey(c), c]));
  const flags = [];
  const comparisons = [];

  for (const c of cells) {
    const p = prevCells.get(cellKey(c));
    if (!p) { comparisons.push({ ...c, baseline: null, note: 'new cell (no baseline)' }); continue; }
    const passDrop = c.passRate < p.passRate;
    const tokMean = c.tokens.mean;
    const tokDelta = p.tokens.mean ? (tokMean - p.tokens.mean) / p.tokens.mean : 0;
    const costDelta = p.costUsd.mean ? (c.costUsd.mean - p.costUsd.mean) / p.costUsd.mean : 0;

    const cmp = {
      key: cellKey(c),
      passRate: c.passRate, basePassRate: p.passRate,
      tokDelta: round(tokDelta, 3), costDelta: round(costDelta, 3),
    };
    comparisons.push(cmp);

    if (passDrop) flags.push(`PASS-RATE DROP ${cellKey(c)}: ${p.passRate} → ${c.passRate}`);
    if (tokDelta > THRESHOLD) flags.push(`TOKENS +${round(tokDelta * 100, 1)}% ${cellKey(c)} (>${THRESHOLD * 100}%)`);
    if (costDelta > THRESHOLD) flags.push(`COST +${round(costDelta * 100, 1)}% ${cellKey(c)} (>${THRESHOLD * 100}%)`);
  }

  return { baselineVersion: prev.version, flags, comparisons };
}

// Write/refresh the baseline for a version (used before a release to capture a
// new reference). Committed under tests/e2e/baselines/.
export function saveBaseline(version, cells) {
  writeJson(join(BASELINES_DIR, `${version}.json`), { version, cells });
}

function semverCompare(a, b) {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
