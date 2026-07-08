---
name: review-phase
description: Internal review gate of [implement-plan] / [amend-plan] / [systematic-debugging] — NOT a standalone entry point. Runs the mandatory three-layer review (mechanical checks, plan-compliance walkthrough, independent reviewer subagent) plus the fix loop against one phase's diff in {{PROJECT_NAME}}, spawning reviewer + fixer subagents and looping until all three layers are clean. The invoking conductor passes the diff, the phase body to walk against, and the resolved `WORKROOT`; do not invoke directly to "review my code" — use the project's standard code-review path for that.
---

# Review one phase

The single review implementation shared by every plan-execution conductor: [implement-plan](../implement-plan/SKILL.md) (after an implementer runs), [amend-plan](../amend-plan/SKILL.md) (after a rewrite), and [systematic-debugging](../systematic-debugging/SKILL.md) (against the fix diff). Read-only orchestration: this skill **never edits code** — every issue becomes a fix-up subagent task.

## Inputs (passed by the conductor)

- The phase diff (on the current branch inside `WORKROOT`).
- The phase body to walk against (the **new** body when invoked by amend-plan).
- `WORKROOT`, `SANDBOX_TIER` — resolved once by the conductor.
- `main_checkout` — the repo root the run was invoked from (equals `WORKROOT` when no worktree).
- `run_options.full_test_suite` — resolves which outer gate Layer 1 item 3 verifies ran (false = scoped suite; true = full repo suite).
- The project's `reviewer` + `fixer` agent types.

## Review

<!-- include: partials/review-layers.md#LAYERS -->

## Output

Return to the conductor: `PASS` (all three layers clean) with a one-line note, or the list of BLOCKER / SHOULD-FIX findings and what the fix loop applied. The conductor owns branch / push / PR — this skill hands back a clean (or annotated) working tree in `WORKROOT`.
