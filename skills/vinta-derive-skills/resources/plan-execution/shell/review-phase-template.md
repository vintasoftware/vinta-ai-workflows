---
name: review-phase
description: Internal review gate of [implement-plan] / [amend-plan] / [systematic-debugging] — NOT a standalone entry point. Runs the thermo-nuclear review loop over one phase's diff in {{PROJECT_NAME}}, with this skill as the loop's host: it spawns one reviewer sub-agent one tier above the phase's implementer, hands each round of findings to the phase's own implementer to verify, fix or reject with evidence, puts the questions only a person can settle to the human, and loops until the reviewer explicitly approves. The invoking conductor passes the diff, the phase body (the stated requirement) and the resolved `WORKROOT`; do not invoke directly to "review my code" — use the `thermo-nuclear-review-loop` skill for that.
disable-model-invocation: true
---

# Review one phase

The single review implementation shared by every plan-execution conductor: [implement-plan](../implement-plan/SKILL.md) (after an implementer runs), [amend-plan](../amend-plan/SKILL.md) (after a rewrite), and [systematic-debugging](../systematic-debugging/SKILL.md) (against the fix diff). It runs the [thermo-nuclear-review-loop](../thermo-nuclear-review-loop/SKILL.md) skill. Read-only orchestration: this skill **never edits code** — the reviewer reports, and the phase's own implementer fixes. (The one exception is a change systematic-debugging wrote in its own session: there the conductor is the fixer, as the skill is written.)

<!-- include: partials/dispatched-agent.md#CONDUCTOR_ENTRY_GUARD -->

## Inputs (passed by the conductor)

- The phase diff (on the current branch inside `WORKROOT`) and the phase's `base_branch`, which is the loop's baseline.
- The phase body — the loop's **stated requirement** (the **new** body when invoked by amend-plan; the bug report and the fix's intent when invoked by systematic-debugging).
- The plan's **Goals + Non-goals** and **Guiding Decisions**, when the conductor has a plan.
- `WORKROOT`, `SANDBOX_TIER` — **this lane's**, resolved by the conductor. `main_checkout` and `sibling_workroots`, for the stray-write check after each fix round.
- The phase's implementer sub-agent, to continue, and `author_tier` — the tier it actually ran at. systematic-debugging passes neither: it wrote the fix itself.

## Resolve the reviewer model

The reviewer runs **one tier above the implementer**: `min(author_tier + 1, 4)`.

`author_tier` is the tier the implementer **actually ran at** — after implement-phase's escalation, and the covering crew member's tier when a peer took the phase — not the tier the plan wrote down. The review is a judgement of the work, and it should come from a model at least as capable as the one that did it. A Tier 4 implementer is reviewed at Tier 4, since nothing sits above it; the reviewer's independence then comes from being a separate agent with no implementation context, which it always is. When the conductor cannot say which tier the implementer ran at, review at Tier 4.

The fix does not take the reviewer's tier: the phase's own implementer fixes, at its own tier, because it is the agent that knows why the code is the way it is.

Feed that tier into the resolution below, which turns a tier into the model the spawn uses.

<!-- include: partials/agent-models.md#TIER_RESOLVE -->

## Review

<!-- include: partials/review-loop.md#LOOP -->

<!-- include: partials/relay-questions.md#RELAY -->

## Output

Return to the conductor `PASS` — the reviewer explicitly approved — with the approval line, the iteration commits, the `--shortstat` at the start and the end, the rejected findings and the settled decisions; or `STOPPED`, with the blockers that remain and why the loop stopped. The conductor owns branch / push / PR — this skill hands back a working tree in `WORKROOT` whose fixes are committed.
