<!-- Partial: review-layers — the three-layer review + fix loop. Included by review-phase. amend-plan and systematic-debugging reuse it by INVOKING review-phase (not by including this partial). The orchestrator running review-phase never edits code itself — every issue surfaces as a fix-up subagent task. -->

<!-- block-begin: LAYERS -->
Three layers, all required, in order. The reviewing orchestrator never edits — every issue surfaces as a fix-up subagent task.

## Layer 1 — Mechanical checks

**Against the working tree, before the commit.** The phase's changes are still uncommitted in `<WORKROOT>`, and that is what every command here reads. It is why review sits before integrate rather than after: a finding is fixed in the tree, so the branch never records the mistake and a correction on top of it.

1. `git -C <WORKROOT> status` + `git -C <WORKROOT> diff --stat`: confirm the file list matches the agent's report.
2. **Read the full diff** for every changed file using `git -C <WORKROOT> diff`. Spot-checking is not enough.
3. **Verify the outer gate** ran + green. By default that is `{{BUILD_CMD}}` (repo-wide) AND the scoped suite `{{SCOPED_TEST_PATTERN}}` covering the touched apps. {If run_options.full_test_suite = true:} the outer gate runs `{{BUILD_CMD}}` AND the full `{{TEST_CMD}}` instead — verify that. Look in the report for explicit confirmation the applicable gate was executed + passed{{E2E_LAYER1_NOTE}}. Vague confirmation → **re-run yourself** (in `<WORKROOT>`).
4. **Scope creep**: file touched outside the expected surface area? Unrelated formatting churn? Surface it.
5. **No-secrets scan**: `git -C <WORKROOT> diff` for `password|secret|token|api_key|AKIA|BEGIN [A-Z]+ KEY`.
6. <!-- include: partials/worktree-seam.md#STRAY_WRITE_CHECK -->
{{DEPENDENCY_LICENSE_LAYER1_CHECK}}
{{COAUTHOR_LAYER1_CHECK}}

## Layer 2 — Plan compliance walkthrough

Open the phase body alongside the diff and walk:

1. **Every numbered "Changes" item implemented.**
2. **Every "Tests" entry materialized**, with assertions actually exercising the called-out behavior.
3. **Acceptance line satisfiable** by the diff.
4. **Repo conventions** from AGENTS.md.
5. **Reusable-skill compliance.**
{{E2E_LAYER2_CHECK}}
6. **Feature-flag wiring** if the plan's **Guiding Decisions** declared a flag — flag-OFF is byte-for-byte pre-feature behavior, ≥1 test asserts it.
7. **Cross-phase consistency** with prior tracking summaries.
8. **Comment hygiene** — new or changed comments and doc blocks in the diff read as Simple English, one idea per sentence, no AI-slop vocabulary or negative framing, per the `deslop-comments` skill ([ai-tools/skills/deslop-comments/SKILL.md](ai-tools/skills/deslop-comments/SKILL.md)). Flag any that need rewriting; the fix loop dispatches a fixer to run `deslop-comments` on the phase's touched files.

## Layer 3 — Independent reviewer subagent

After Layers 1–2 pass, hand the diff to a **reviewer from the plan's Crew table** — a member whose role is `reviewer`, which is never a member that writes code — using the project's `reviewer` agent type ([ai-tools/agents/reviewer.md](ai-tools/agents/reviewer.md)) at the model resolved by the [Resolve the reviewer + fixer model](#resolve-the-reviewer--fixer-model) step. Where the roster staffs no reviewer, spawn a **separate** subagent at `agent_models.reviewer` with no implementation context, as before. Read-only by design, either way.

Reviewer prompt template — see the reviewer agent's body for the standard form. Triage findings:
- **BLOCKER**: must fix before the phase is pushed (the conductor's integrate step).
- **SHOULD-FIX**: fix in-phase if cheap; else follow-up issue + tracking note.
- **NIT**: ignore unless trivially cheap.

The reviewer also applies a condensed **structural-simplification lens** — one question: is there an obvious "code-judo" reframe that would make whole branches, helpers, modes, or layers disappear, rather than polishing what's there? Routine phases stop at that one question. When the phase touched core architecture, pushed a file past ~1,000 lines, or the lens surfaces a structural smell too big to resolve inline, escalate to the full [thermo-nuclear-code-quality-review](ai-tools/skills/thermo-nuclear-code-quality-review/SKILL.md) skill against the phase diff — an opt-in deep audit, run deliberately, never on every phase.

The reviewer finds nothing on a >300-LoC multi-file phase → suspicious. Read once more.

## Fix loop

**The implementer fixes its own findings.** The agent that wrote the code still
holds the phase brief, the plan's bounds, the dependency context and its own
reasoning; a fresh fixer holds a quoted finding and has to rediscover the rest —
slower, dearer, and more likely to "fix" the symptom by changing something the
phase deliberately chose. Continuing the implementer is the default, and the
message it gets is a **delta**: the findings and what to do about them, never
the brief again.

1. **Continue the phase's implementer sub-agent** with the findings. Quote each
   one verbatim, say nothing else about the phase — it was told all of that when
   it started, and repeating it invites a re-implementation rather than a fix.
   Do not re-send the plan sections, the dependency summaries, or the phase body.
   For comment-hygiene findings (Layer 2 item 8), tell it to run the
   `deslop-comments` skill ([ai-tools/skills/deslop-comments/SKILL.md](ai-tools/skills/deslop-comments/SKILL.md))
   scoped to the phase's touched files — comment-only edits, no behavior change.
   Whether continued or fresh, the fixing agent re-runs the inner loop + outer
   gate in `<WORKROOT>` before reporting.
2. **Where the runtime cannot continue a finished sub-agent**, spawn a fresh one
   — the project's `fixer` agent type ([ai-tools/agents/fixer.md](ai-tools/agents/fixer.md))
   at the model resolved from `agent_models.fixer` — and give it the phase
   context the implementer would have had, because it has none. Note in the
   phase's tracking record that the fix was a cold hand-off, so a slow phase can
   be read later without guessing.
3. **The last round before you would give up goes to a fresh fixer, always.**
   Reusing the implementer means the agent that wrote the bug is fixing it,
   which is usually the point — it knows why the code is that way — and
   occasionally exactly wrong, because that assumption *was* the bug. When a
   finding has survived the implementer's own attempts, hand it to an agent that
   has not seen the work before escalating a tier or stopping.
4. After the fixer returns, redo Layer 1 in full + the affected portion of Layer 2.
5. Loop until Layers 1, 2, 3 are all clean.

**The reviewer is never the implementer.** Continuing the *reviewer* across
rounds — and across phases — is fine and remembers what it flagged, but the
review itself must come from an agent that did not write the code. An
implementer asked to review its own phase grades its own work from inside its
own reasoning, which is the one thing the layers exist to prevent. On a plan
with a **Crew** table this is structural rather than a rule to follow: reviewers
and implementers are disjoint sets, and no phase can be assigned to a reviewer.

**Which model fixes.** A continued implementer fixes at its own crew member's
tier, because it *is* that member. `agent_models.fixer` therefore governs the
cold cases only — the runtime fallback in step 2 and the escalation in step 3. A
project that set `fixer` to a cheaper tier to save money should know it now
applies to fewer rounds than before.

**The fix does not take the reviewer's tier.** The review runs a tier above the
author deliberately, and it would be easy to carry that tier into the fix on the
grounds that the finding was hard enough to need it. Don't: the review is a
judgement about the code and the fix is a change to it, and the agent best
placed to make that change is still the one that knows why the code is that way.
A finding that genuinely needs a more capable hand is what step 3's escalation is
for.
<!-- block-end: LAYERS -->
