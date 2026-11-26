// index.mjs — grader registry + orchestration (PLAN §7).
//
// A scenario passes when ALL its deterministic graders pass. Judge scores are
// attached to the report as advisory signal only.

import { gitTreeHealthy } from './git-tree.mjs';
import { artifactsSpec, artifactsPlan, artifactsBootstrap } from './artifacts.mjs';
import { appTestsPass, scriptOutput, bugFixed } from './outcome.mjs';
import { syncConvergence } from './sync-convergence.mjs';
import { answersLint } from './answers-lint.mjs';

// id → grader fn. All deterministic graders are synchronous (git/fs/spawn).
export const GRADERS = {
  'git-tree-healthy': gitTreeHealthy,
  'artifacts-spec': artifactsSpec,
  'artifacts-plan': artifactsPlan,
  'artifacts-bootstrap': artifactsBootstrap,
  'app-tests-pass': appTestsPass,
  'script-output': scriptOutput,
  'bug-fixed': bugFixed,
  'sync-convergence': syncConvergence,
  'answers-lint': answersLint,
};

export function runGraders(graderIds, ctx) {
  const results = [];
  for (const id of graderIds) {
    const fn = GRADERS[id];
    if (!fn) {
      results.push({ id, tier: 'deterministic', pass: false, details: [`✗ unknown grader "${id}"`] });
      continue;
    }
    try {
      results.push(fn(ctx));
    } catch (e) {
      results.push({ id, tier: 'deterministic', pass: false, details: [`✗ grader threw: ${e.message}`] });
    }
  }
  return results;
}

export function scenarioPassed(graderResults) {
  const deterministic = graderResults.filter((g) => g.tier === 'deterministic');
  // A scenario with no deterministic graders can't pass — that's a spec error.
  if (deterministic.length === 0) return false;
  return deterministic.every((g) => g.pass);
}

export function knownGraders() {
  return Object.keys(GRADERS);
}
