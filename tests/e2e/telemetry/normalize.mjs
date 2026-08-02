// normalize.mjs — the per-run result envelope (PLAN §8).
//
// Every run emits one normalized record with usage, wall-time, grader outcomes,
// judge scores, and a per-step usage breakdown so we can see *where* tokens go.

import { round } from '../runner/lib.mjs';

export function buildRecord({
  pkgVersion, gitSha, vendor, model, scenario, run,
  graderResults, judge, steps, wallSec,
}) {
  const usage = sumUsage(steps.map((s) => s.usage));
  const graders = {};
  for (const g of graderResults) graders[g.id] = g.pass;
  const pass = graderResults.filter((g) => g.tier === 'deterministic').every((g) => g.pass)
    && graderResults.some((g) => g.tier === 'deterministic');

  return {
    pkgVersion,
    gitSha,
    vendor,
    model,
    scenario,
    run,
    pass,
    graders,
    graderDetails: graderResults.map((g) => ({ id: g.id, pass: g.pass, details: g.details })),
    judge: judge?.scores
      ? Object.fromEntries(Object.entries(judge.scores).map(([k, v]) => [k, v.score]))
      : {},
    usage,
    wallSec: round(wallSec, 1),
    steps: steps.map((s) => ({
      invoke: s.invoke,
      usage: s.usage,
      wallSec: round(s.wallSec, 1),
      exitCode: s.exitCode,
      timedOut: !!s.timedOut,
      usageEstimated: !!s.usageEstimated,
    })),
  };
}

export function sumUsage(list) {
  const acc = { inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 };
  for (const u of list) {
    if (!u) continue;
    acc.inTok += u.inTok || 0;
    acc.outTok += u.outTok || 0;
    acc.cacheTok += u.cacheTok || 0;
    acc.costUsd += u.costUsd || 0;
  }
  acc.costUsd = round(acc.costUsd, 4);
  return acc;
}

// Aggregate the N runs of one (scenario × vendor × model) cell.
export function aggregateCell(records) {
  const n = records.length;
  const passes = records.filter((r) => r.pass).length;
  const totalToks = records.map((r) => r.usage.inTok + r.usage.outTok);
  const costs = records.map((r) => r.usage.costUsd);
  return {
    scenario: records[0].scenario,
    vendor: records[0].vendor,
    model: records[0].model,
    runs: n,
    passRate: round(passes / n, 3),
    tokens: stats(totalToks),
    costUsd: stats(costs),
    wallSec: stats(records.map((r) => r.wallSec)),
  };
}

function stats(nums) {
  if (nums.length === 0) return { mean: 0, median: 0, p95: 0, min: 0, max: 0, variance: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return {
    mean: round(mean, 2),
    median: round(sorted[Math.floor((sorted.length - 1) / 2)], 2),
    p95: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)], 2),
    min: round(sorted[0], 2),
    max: round(sorted[sorted.length - 1], 2),
    variance: round(variance, 2),
  };
}
