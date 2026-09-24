---
name: review-phase
description: Internal review gate of [implement-plan] / [amend-plan] / [systematic-debugging] — NOT a standalone entry point. Runs the mandatory three-layer review (mechanical checks, plan-compliance walkthrough, independent reviewer subagent) plus the fix loop against one phase's diff in {{PROJECT_NAME}}, spawning an independent reviewer, sending findings back to the phase's own implementer to fix, and looping until all three layers are clean. The invoking conductor passes the diff, the phase body to walk against, and the resolved `WORKROOT`; do not invoke directly to "review my code" — use the project's standard code-review path for that.
disable-model-invocation: true
---

# Review one phase

The single review implementation shared by every plan-execution conductor: [implement-plan](../implement-plan/SKILL.md) (after an implementer runs), [amend-plan](../amend-plan/SKILL.md) (after a rewrite), and [systematic-debugging](../systematic-debugging/SKILL.md) (against the fix diff). Read-only orchestration: this skill **never edits code** — every issue becomes a fix-up subagent task.

<!-- include: partials/dispatched-agent.md#CONDUCTOR_ENTRY_GUARD -->

## Inputs (passed by the conductor)

- The phase diff (on the current branch inside `WORKROOT`).
- The phase body to walk against (the **new** body when invoked by amend-plan).
- `WORKROOT`, `SANDBOX_TIER` — **this lane's**, resolved by the conductor.
- `main_checkout` — the repo root the run was invoked from (equals `WORKROOT` when no worktree).
- `sibling_workroots` — every other lane's workroot in the pool (empty for a sequential run). The stray-write check covers these too: a write into a lane that is actively implementing another phase is worse than a stray main-checkout write.
- `run_options.full_test_suite` — resolves which outer gate Layer 1 item 3 verifies ran (false = scoped suite; true = full repo suite).
- The project's `reviewer` + `fixer` agent types, plus their `agent_models.reviewer` / `agent_models.fixer` tiers (when set in `.vinta-ai-workflows.yaml`).
- Optional per-phase `reviewer_model_tier` / `fixer_model_tier` overrides — the tiers parsed from this phase's `**Review models**:` line in the plan (null when the phase didn't set one, which is the common case).
- `author_tier` and `crew_reviewers` — the tier of the crew member that implemented this phase, and the plan's **Crew** table rows whose role is `reviewer` (id + tier). Both null for a legacy plan with no roster. Reviewers carry no `WORKROOT` of their own: they use the one above.

## Resolve the reviewer + fixer model

Each of `reviewer` and `fixer` spawns at an **effective tier**, resolved per role with this precedence:

1. The phase's `reviewer_model_tier` / `fixer_model_tier` override, when the conductor passed one (the plan chose a non-default review model for this critical phase).
2. Else, **for `reviewer` only: the cheapest member in `crew_reviewers` whose tier is at or above `author_tier`.** Reviewers are their own members and never write code, so the independence comes from the role rather than from a tier gap — which means a peer-tier review is a genuine second pair of eyes, not an agent grading itself. A reviewer's tier is a floor in the same way an implementer's is: it reads work at or below its own capability.
3. Else the project-wide `agent_models.reviewer` / `agent_models.fixer` tier from `.vinta-ai-workflows.yaml`.
4. Else unset → the runtime default model.

Step 2 is skipped when the roster staffs no qualified reviewer — no reviewers at all, or none at or above this phase's tier, or a legacy plan with no **Crew** table — and the resolution falls through to the project default, which is the behaviour every plan had before rosters existed.

**A claimed reviewer is a running agent, not just a model.** It has one session ledger, so two reviews as the same reviewer would collide over it: if the reviewer this phase needs is mid-review elsewhere, wait for it rather than picking another. The wait is safe — reviewers never take phases, so it is always waiting on a review already in flight.

**It reviews in this phase's `WORKROOT`.** A reviewer has no worktree of its own; it reads the implementer's, with the phase's changes still uncommitted in it. Every Layer 1 command below is therefore a `git -C <WORKROOT>` against a **dirty tree**, and that is the intent — the fix loop corrects the working tree before anything is committed, so a finding never becomes a mistake recorded on the branch plus a correction after it. Continue the reviewer's session when its previous review was in this same lane; otherwise it starts cold, because a session cannot follow an agent into a different directory.

**It does not apply to `fixer`.** The fix goes back to the agent that wrote the code, at its own tier; see the fix loop. A review is a judgement about the code and a fix is a change to it, and the tier that earned the first does not follow the second.

Feed that effective tier into the resolution below (it turns a tier into a concrete spawn model). A phase override applies to that phase only; the next phase falls back to its own author's tier unless it too overrides.

<!-- include: partials/agent-models.md#TIER_RESOLVE -->

## Review

<!-- include: partials/review-layers.md#LAYERS -->

## Output

Return to the conductor: `PASS` (all three layers clean) with a one-line note, or the list of BLOCKER / SHOULD-FIX findings and what the fix loop applied. The conductor owns branch / push / PR — this skill hands back a clean (or annotated) working tree in `WORKROOT`.
