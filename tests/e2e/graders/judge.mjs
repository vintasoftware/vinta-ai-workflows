// judge.mjs — LLM-judge grader (PLAN §7). STRICTLY ADVISORY.
//
// Scores fuzzy quality dimensions regex can't judge (does AGENTS.md reflect
// *this* stack? is the spec faithful to the request? is the fix real vs a hack?)
// using a fixed judge model with a structured rubric. Its scores are a
// trend/quality signal in the report — they NEVER decide pass/fail (§13.5).
// Deterministic graders alone gate.
//
// Enabled only with `--judge` (it costs tokens). Uses an adapter (default the
// Claude Code adapter) so the judge model is pinned and swappable.

import { makeAdapter } from '../runner/adapters/index.mjs';

const RUBRICS = {
  'spec-fidelity': 'How faithfully does the produced *_SPEC.md capture the task request and its canned answers? 1=ignores it, 5=captures every stated requirement.',
  'plan-quality': 'Is the *_PLAN.md a real, buildable plan (phased, testable, risks noted) vs a stub? 1=stub, 5=excellent.',
  'fix-is-real': 'Is the bug fix a genuine root-cause fix vs a hack that games the test? 1=hack, 5=real fix.',
  'agents-md-relevance': 'Does AGENTS.md reflect *this* fixture stack specifically vs generic boilerplate? 1=generic, 5=stack-specific.',
};

export async function runJudge(ctx, dimensions, { model, adapter = 'claude-code' } = {}) {
  const results = {};
  const ad = makeAdapter(adapter);
  const avail = ad.available();
  if (!avail.available) {
    return { skipped: true, reason: avail.reason, scores: {} };
  }

  for (const dim of dimensions) {
    const rubric = RUBRICS[dim];
    if (!rubric) continue;
    const prompt = [
      'You are an impartial code-quality judge. Score the following on a 1.0–5.0 scale.',
      `Rubric — ${dim}: ${rubric}`,
      '',
      'Context to judge (files + transcript excerpts):',
      summarizeContext(ctx),
      '',
      'Respond with ONLY a JSON object: {"score": <number 1-5>, "reason": "<one sentence>"}.',
    ].join('\n');

    try {
      const res = await ad.run({ prompt }, { model, cwd: ctx.cwd, timeoutMs: 120000, tasksDir: ctx.tasksDir });
      const m = res.transcript.match(/\{[\s\S]*"score"[\s\S]*\}/);
      results[dim] = m ? JSON.parse(m[0]) : { score: null, reason: 'unparseable judge output' };
    } catch (e) {
      results[dim] = { score: null, reason: `judge error: ${e.message}` };
    }
  }
  return { skipped: false, scores: results };
}

function summarizeContext(ctx) {
  const bits = [];
  for (const step of ctx.steps || []) {
    bits.push(`### ${step.invoke}\n${(step.transcript || '').slice(0, 2000)}`);
  }
  return bits.join('\n\n').slice(0, 8000);
}

export { RUBRICS };
