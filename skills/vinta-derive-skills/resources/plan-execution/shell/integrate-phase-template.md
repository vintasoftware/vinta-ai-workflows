---
name: {{INTEGRATE_PHASE_NAME}}
description: Internal integration step of [implement-plan] — NOT a standalone entry point. Pushes one reviewed phase along {{PROJECT_NAME}}'s commit strategy and opens (or updates) its PR through the prs-context file + bundled open-pr.sh — the only PR-creation path. The conductor passes the resolved `WORKROOT` / `BASE_BRANCH` and the PR / inline-comment policy; do not invoke directly to push arbitrary work.
---

# Integrate one phase

Invoked by [implement-plan](../implement-plan/SKILL.md) after [review-phase](../review-phase/SKILL.md) returns clean. Pushes the phase and routes its PR through the context file. Subagents never push or open PRs — this orchestrator step does.

<!-- derive-skills note: for projects with `policies.commit_strategy` = stacked-branches or modular-commits this template renders once to `ai-tools/skills/integrate-phase/`. For `ask`, it renders TWICE — to `integrate-phase-stacked` and `integrate-phase-modular` — each with `<RESOLVED>` bound to its strategy and `{{INTEGRATE_PHASE_NAME}}` set to match its dir; the conductor dispatches to one by name on `run_options.commit_strategy_resolved`. -->

## Inputs (passed by the conductor)

- `WORKROOT`, `BASE_BRANCH` — resolved once by the conductor.
- `{{PR_POLICY_BLOCK}}` policy + `run_options.generate_inline_comments`.
- The phase record + plan-level decisions (for the PR body).

<!-- include: partials/worktree-seam.md#WORKROOT_TOPOLOGY_RULE -->

## {{BRANCH_PUSH_HEADING}}

<!-- include: partials/commit-strategy/<RESOLVED>.md#BRANCH_NAMING -->

## Open PR via context file

<!-- include: partials/pr-context.md#PR_CONTEXT -->

## Output

Return to the conductor: the branch pushed, and the PR-context file path with its `status` (`published` + `pr_url` when `open-pr.sh` ran; `pending` otherwise) plus the publish command when `pending`.
