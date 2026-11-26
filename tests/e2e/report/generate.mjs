// generate.mjs — human + machine reporting (PLAN §9).
//
// Emits summary.json (rolled-up cells + baseline diff) and REPORT.md (the
// comparison matrix + per-scenario drill-down + links to failing transcripts).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, pct, round } from '../runner/lib.mjs';

export function writeSummary(resultsDir, { version, gitSha, cells, baseline }) {
  const summary = { version, gitSha, generatedFrom: 'tests/e2e/runner', cells, baseline };
  writeJson(join(resultsDir, 'summary.json'), summary);
  return summary;
}

export function writeReport(resultsDir, summary) {
  const { version, gitSha, cells, baseline } = summary;
  const lines = [];
  lines.push(`# E2E Report — vinta-ai-workflows \`${version}\``);
  lines.push('');
  lines.push(`- Harness commit: \`${gitSha || 'unknown'}\``);
  lines.push(`- Cells: ${cells.length}`);
  if (baseline?.baselineVersion) lines.push(`- Compared against baseline: \`${baseline.baselineVersion}\``);
  lines.push('');

  if (baseline?.flags?.length) {
    lines.push('## ⚠️ Regression flags');
    lines.push('');
    for (const f of baseline.flags) lines.push(`- **${f}**`);
    lines.push('');
  }

  lines.push('## Comparison matrix');
  lines.push('');
  lines.push('| Scenario | Vendor / Model | Pass-rate | Median tokens | Median cost | Δ tokens vs baseline |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of cells) {
    const cmp = baseline?.comparisons?.find((x) => x.key === `${c.scenario}|${c.vendor}|${c.model}`);
    const delta = cmp && cmp.tokDelta != null ? `${cmp.tokDelta > 0 ? '+' : ''}${round(cmp.tokDelta * 100, 1)}%` : '—';
    lines.push(
      `| ${c.scenario} | ${c.vendor} / ${c.model} | ${pct(c.passRate)} | `
      + `${fmt(c.tokens.median)} | $${round(c.costUsd.median, 4)} | ${delta} |`,
    );
  }
  lines.push('');

  lines.push('## Per-scenario drill-down');
  lines.push('');
  for (const c of cells) {
    lines.push(`### ${c.scenario} — ${c.vendor} / ${c.model}`);
    lines.push('');
    lines.push(`- Runs: ${c.runs}, pass-rate ${pct(c.passRate)}`);
    lines.push(`- Tokens: mean ${fmt(c.tokens.mean)}, median ${fmt(c.tokens.median)}, p95 ${fmt(c.tokens.p95)}, variance ${fmt(c.tokens.variance)}`);
    lines.push(`- Cost: mean $${round(c.costUsd.mean, 4)}, wall mean ${round(c.wallSec.mean, 1)}s`);
    if (c.failures?.length) {
      lines.push('- Failing runs:');
      for (const f of c.failures) {
        lines.push(`  - run ${f.run}: ${f.failedGraders.join(', ')} — \`${f.transcriptPath}\``);
      }
    }
    lines.push('');
  }

  const md = lines.join('\n');
  writeFileSync(join(resultsDir, 'REPORT.md'), `${md}\n`);
  return md;
}

const fmt = (n) => (n >= 1000 ? `${round(n / 1000, 1)}k` : `${round(n, 0)}`);
