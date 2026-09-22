---
name: implement-phase
description: Internal execution step of [implement-plan] / [amend-plan] — NOT a standalone entry point. Given one already-classified plan phase plus the resolved `WORKROOT` / `BASE_BRANCH` / `SANDBOX_TIER`, it composes a token-efficient implementer prompt, picks the model from the phase's own suggestion, and spawns exactly one implementer subagent, returning that agent's report. Do not invoke directly for ad-hoc edits or in response to a user's raw feature request; the conductor invokes it once per executable phase in {{PROJECT_NAME}}.
---

# Implement one phase

Execution unit invoked by [implement-plan](../implement-plan/SKILL.md) (and by [amend-plan](../amend-plan/SKILL.md) for `amend-existing` rewrites). One phase in → one implementer report out. This skill does **not** review, branch, push, or open PRs — those are [review-phase](../review-phase/SKILL.md) and [integrate-phase](../integrate-phase/SKILL.md). It also does **not** decide whether a phase runs — the conductor already filtered cross-repo / flag-removal phases.

<!-- include: partials/dispatched-agent.md#CONDUCTOR_ENTRY_GUARD -->

## Inputs (passed by the conductor as data — this skill re-derives none of them)

- `phase` record: `{ id, title, goal, body, spec_use_case, depends_on, wave, base_branch, crew_member, crew_tier, suggested_model_tier, reusable_skills, has_e2e, acceptance }`. `crew_member` / `crew_tier` come from the phase's `**Assigned to**:` line and the plan's **Crew** table; `suggested_model_tier` is the legacy path and is set only on a plan with no roster. Exactly one of the two is populated.
- Plan-level decisions: **Goals + Non-goals**, **Guiding Decisions**, the relevant **Data Model Changes** subsection.
- **Dependency-closure summaries** — the `phase-{id}.md` tracking entries for this phase's transitive dependencies, and only those. Not "everything finished so far": under parallel execution a sibling lane's work is not in this phase's base branch, and describing it as done makes the implementer code against files it cannot see.
- `WORKROOT`, `SANDBOX_TIER` — **this lane's**, resolved by the conductor ([Resolve WORKROOT step](../implement-plan/SKILL.md#step-05--resolve-workroot)). `phase.base_branch` — the branch the conductor already created this phase's branch from, derived from `depends_on`.
- `run_options.full_test_suite` — resolves the outer gate's test scope in the composed prompt's `{If run_options.full_test_suite = true:}` marker (false = scoped suite only; true = full repo suite).

## 1. Compose the agent prompt (token-efficient)

Compose with **only what the agent needs**:

<!-- include: partials/implementer-prompt.md#FULL -->

<!-- include: partials/model-pick.md#MODEL_PICK -->

## 3. Spawn the subagent

Use whatever agent-spawning primitive the runtime exposes. Pass:

- A descriptive label (e.g. `"{plan.id} {phase.id}: {phase.title}"`).
- The model from the [Pick the model](#pick-the-model-from-the-plans-per-phase-suggestion) step, translated to the runner's form.
- The phase prompt from the [Compose the agent prompt](#1-compose-the-agent-prompt-token-efficient) step.
- The right **agent type** (below).

<!-- include: partials/worktree-seam.md#SANDBOX_WRAP -->

**Agent type per phase.** Project agents in [`ai-tools/agents/`](ai-tools/agents/) (exposed to claude-code via `.claude/agents` symlink):

{{AGENT_DISPATCH_TABLE}}

A phase that combines shapes → the agent type stays `implementer`, and the prompt lists every relevant SKILL.md. The agent type changes only when a stack-specialist's risk is the primary one.

**Avoid bouncing the same phase between multiple agents.** Wanting to "hand off" mid-phase → the plan should have split into sub-phases instead.

**Concurrent invocations are expected.** The conductor may have several lanes in flight, each running its own copy of this skill against a different phase. Nothing here is shared: the prompt, the model pick, the spawn, and the returned report all belong to one phase in one `WORKROOT`. Never read another lane's worktree, branch, or tracking entry — if this phase needs something from another phase, that is a dependency edge the plan should have declared.

## Output

Return the implementer's single final report verbatim to the conductor (status, files, summary, deviations, blockers). The conductor — not this skill — writes tracking from the git diff + the report.
