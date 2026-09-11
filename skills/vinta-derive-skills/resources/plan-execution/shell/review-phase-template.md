---
name: review-phase
description: Internal review gate of [implement-plan] / [amend-plan] / [systematic-debugging] — NOT a standalone entry point. Runs the mandatory three-layer review (mechanical checks, plan-compliance walkthrough, independent reviewer subagent) plus the fix loop against one phase's diff in {{PROJECT_NAME}}, spawning an independent reviewer, sending findings back to the phase's own implementer to fix, and looping until all three layers are clean. The invoking conductor passes the diff, the phase body to walk against, and the resolved `WORKROOT`; do not invoke directly to "review my code" — use the project's standard code-review path for that.
---

# Review one phase

The single review implementation shared by every plan-execution conductor: [implement-plan](../implement-plan/SKILL.md) (after an implementer runs), [amend-plan](../amend-plan/SKILL.md) (after a rewrite), and [systematic-debugging](../systematic-debugging/SKILL.md) (against the fix diff). Read-only orchestration: this skill **never edits code** — every issue becomes a fix-up subagent task.

## Inputs (passed by the conductor)

- The phase diff (on the current branch inside `WORKROOT`).
- The phase body to walk against (the **new** body when invoked by amend-plan).
- `WORKROOT`, `SANDBOX_TIER` — **this lane's**, resolved by the conductor.
- `main_checkout` — the repo root the run was invoked from (equals `WORKROOT` when no worktree).
- `sibling_workroots` — every other lane's workroot in the pool (empty for a sequential run). The stray-write check covers these too: a write into a lane that is actively implementing another phase is worse than a stray main-checkout write.
- `run_options.full_test_suite` — resolves which outer gate Layer 1 item 3 verifies ran (false = scoped suite; true = full repo suite).
- The project's `reviewer` + `fixer` agent types, plus their `agent_models.reviewer` / `agent_models.fixer` tiers (when set in `.vinta-ai-workflows.yaml`).
- Optional per-phase `reviewer_model_tier` / `fixer_model_tier` overrides — the tiers parsed from this phase's `**Review models**:` line in the plan (null when the phase didn't set one, which is the common case).
- `author_tier` and `crew_tiers` — the tier of the crew member that implemented this phase, and the tiers on the plan's **Crew** table. Both null for a legacy plan with no roster.

## Resolve the reviewer + fixer model

Each of `reviewer` and `fixer` spawns at an **effective tier**, resolved per role with this precedence:

1. The phase's `reviewer_model_tier` / `fixer_model_tier` override, when the conductor passed one (the plan chose a non-default review model for this critical phase).
2. Else, **for `reviewer` only: one tier above the phase's author** — the lowest tier in `crew_tiers` strictly greater than `author_tier`. A team has seniors read juniors' work, and a flat project default cannot say that: it puts the cheapest agent on the plan under review by its own tier. Step to the *next* tier up, never to the top of the roster, or every cheap phase carries the plan's priciest review.
3. Else the project-wide `agent_models.reviewer` / `agent_models.fixer` tier from `.vinta-ai-workflows.yaml`.
4. Else unset → the runtime default model.

Step 2 is skipped when there is nobody above the author — a single-tier roster, a Tier 4 phase, or a legacy plan with no **Crew** table — and the resolution falls through to the project default, which is the behaviour every plan had before rosters existed.

**It does not apply to `fixer`.** The fix goes back to the agent that wrote the code, at its own tier; see the fix loop. A review is a judgement about the code and a fix is a change to it, and the tier that earned the first does not follow the second.

Feed that effective tier into the resolution below (it turns a tier into a concrete spawn model). A phase override applies to that phase only; the next phase falls back to its own author's tier unless it too overrides.

<!-- include: partials/agent-models.md#TIER_RESOLVE -->

## Review

<!-- include: partials/review-layers.md#LAYERS -->

## Output

Return to the conductor: `PASS` (all three layers clean) with a one-line note, or the list of BLOCKER / SHOULD-FIX findings and what the fix loop applied. The conductor owns branch / push / PR — this skill hands back a clean (or annotated) working tree in `WORKROOT`.
