// answers-lint.mjs — the canned-answers drift check (PLAN §6).
//
// A headless run must never stall on an interview question. Each step ships an
// answers file injected into the prompt; this grader scans the transcripts for
// evidence the agent asked a question anyway (meaning the answers file drifted
// out of sync with the interview the skill actually runs). Deterministic and
// advisory-leaning, but a hard signal that the fixture needs maintenance.

const QUESTION_SIGNALS = [
  /\bcould you (please )?(clarify|confirm|provide|specify)\b/i,
  /\bwhich (option|approach|one) (would|do) you\b/i,
  /\bplease (confirm|clarify|provide|let me know)\b/i,
  /\bwhat (should|would you like|do you want)\b.*\?/i,
  /\bI need (more information|you to)\b/i,
  /\bwaiting for (your )?(input|response|confirmation)\b/i,
  /\bshall I proceed\?/i,
];

export function answersLint(ctx) {
  const details = [];
  let asked = 0;
  for (const step of ctx.steps || []) {
    const t = step.transcript || '';
    for (const re of QUESTION_SIGNALS) {
      const m = t.match(re);
      if (m) { asked++; details.push(`✗ ${step.invoke} appears to have asked: "${m[0].trim()}"`); break; }
    }
  }
  const pass = asked === 0;
  if (pass) details.push('✓ no step appears to have asked an unanswered question');
  return { id: 'answers-lint', tier: 'deterministic', pass, details };
}
