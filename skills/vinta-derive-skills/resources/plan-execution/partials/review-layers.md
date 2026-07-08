<!-- Partial: review-layers — the three-layer review + fix loop. Included by review-phase. amend-plan and systematic-debugging reuse it by INVOKING review-phase (not by including this partial). The orchestrator running review-phase never edits code itself — every issue surfaces as a fix-up subagent task. -->

<!-- block-begin: LAYERS -->
Three layers, all required, in order. The reviewing orchestrator never edits — every issue surfaces as a fix-up subagent task.

## Layer 1 — Mechanical checks

1. `git -C <WORKROOT> status` + `git -C <WORKROOT> diff --stat`: confirm the file list matches the agent's report.
2. **Read the full diff** for every changed file using `git -C <WORKROOT> diff`. Spot-checking is not enough.
3. **Verify the outer gate** ran + green. Look in the report for explicit confirmation that `{{BUILD_CMD}}` AND `{{TEST_CMD}}` were executed + passed{{E2E_LAYER1_NOTE}}. Vague confirmation → **re-run yourself** (in `<WORKROOT>`).
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

## Layer 3 — Independent reviewer subagent

After Layers 1–2 pass, spawn a **separate** subagent (different session, no implementation context) using the project's `reviewer` agent type ([ai-tools/agents/reviewer.md](ai-tools/agents/reviewer.md)). Read-only by design.

Reviewer prompt template — see the reviewer agent's body for the standard form. Triage findings:
- **BLOCKER**: must fix before the phase is pushed (the conductor's integrate step).
- **SHOULD-FIX**: fix in-phase if cheap; else follow-up issue + tracking note.
- **NIT**: ignore unless trivially cheap.

The reviewer finds nothing on a >300-LoC multi-file phase → suspicious. Read once more.

## Fix loop

1. Spawn a **new** subagent — the project's `fixer` agent type ([ai-tools/agents/fixer.md](ai-tools/agents/fixer.md)). The fix prompt quotes the finding verbatim.
2. The `fixer`'s system prompt mandates re-running the inner loop + outer gate (in `<WORKROOT>`).
3. After the fixer returns, redo Layer 1 in full + the affected portion of Layer 2.
4. Loop until Layers 1, 2, 3 are all clean.
<!-- block-end: LAYERS -->
