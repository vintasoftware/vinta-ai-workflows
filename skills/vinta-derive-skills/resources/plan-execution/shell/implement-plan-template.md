---
name: implement-plan
description: Execute a phased implementation plan from `{{PLAN_DIR}}/` in {{PROJECT_NAME}} by orchestrating one subagent per phase (using whatever model the plan suggests and the runtime supports), pushing one stacked branch per phase to {{CODE_HOST}}, and tracking progress. Use when the user says "implement the plan", "execute plan X", "start implementation", "run phase N of plan Y", "implement {feature} plan", or asks to drive a `*_IMPLEMENTATION_PLAN.md` file phase-by-phase. NOT for one-off changes, single-file edits, or work that doesn't have an existing plan. {{PR_POLICY_DESCRIPTION}}
---

# Implement Plan

Drive a phased plan in [`{{PLAN_DIR}}/`]({{PLAN_DIR}}/) to completion. This skill is a **thin conductor**: it parses the plan once, resolves one `WORKROOT`, then runs a fixed three-step pipeline per phase, delegating the real work to focused sub-skills:

1. [implement-phase](../implement-phase/SKILL.md) — compose prompt, pick model, spawn the implementer.
2. [review-phase](../review-phase/SKILL.md) — three-layer review + fix loop.
3. {{INTEGRATE_PHASE_DISPATCH}} — push the branch + open the PR via context file.

The conductor itself owns only: plan parsing, phase classification, `WORKROOT` resolution, the loop, the progress-tracking file, the pause gate, and the final report. Harness-agnostic — claude-code, OpenAI Codex, Google's runtime, or any framework with a "spawn subagent with model + prompt" primitive.

Execution counterpart to [plan-feature](../plan-feature/SKILL.md). Plan = contract; this skill = build pipeline.

## Working assumptions

- Repo: {{PROJECT_NAME}} ({{STACK_SUMMARY}}). Conventions: [AGENTS.md](AGENTS.md).
- Plan files: [`{{PLAN_DIR}}/YYYY-MM-DD-FEATURE_NAME_IMPLEMENTATION_PLAN.md`]({{PLAN_DIR}}/).
- Lint: `{{LINT_CMD}}`. Format: `{{FORMAT_CMD}}`.
- Type / build gate: `{{BUILD_CMD}}`{{TYPECHECK_NOTE}}.
- Unit / integration tests: `{{TEST_CMD}}` (everything){{SCOPED_TEST_NOTE}}.
{{E2E_BLOCK}}
{{STACK_SPECIFIC_DEPLOY_BLOCK}}
- Code host: **{{CODE_HOST}}**. {{PR_POLICY_BLOCK}}
- {{COAUTHOR_POLICY_BLOCK}}

## Step 0 — Locate + parse plan

Parse once, reuse for every phase:

1. **Identify plan file.** Ask user which plan (path or feature name). Feature name: `ls {{PLAN_DIR}}/` + grep; confirm before proceeding.
2. **Extract structured fields**, in order:
   - **Feature name** + **plan id** — derived from filename's `FEATURE_NAME` portion only: strip `YYYY-MM-DD-` prefix + `_IMPLEMENTATION_PLAN.md` suffix. Kebab variant for branch names.
   - **Goals + Non-goals** section — verbatim, used in every phase prompt.
   - **Guiding Decisions** section — verbatim. Pay attention to: feature flag (key, scope, default, flip-on criterion), storage shape, tenant scoping, API contract decisions.
   - **Data Model Changes** section — keep full body; later phases reference earlier subsections.
   - **Phased Rollout** section — parse into phase records: `{ id, title, goal, body, spec_use_case, suggested_model_tier, reviewer_model_tier, fixer_model_tier, reusable_skills, has_e2e, acceptance, is_cross_repo, is_flag_removal }`. `reviewer_model_tier` / `fixer_model_tier` come from the phase's optional `**Review models**:` line (null when the phase doesn't override — most phases).
   - **Risk & Rollout Notes**, **Open Questions**, **Touch List** sections — keep available; include in phase prompts only when relevant.
3. **Classify each phase**: `is_cross_repo`, `is_flag_removal` — the conductor does NOT auto-execute these (see [Cross-repo phases](#cross-repo-phases) + [Flag-removal phase](#flag-removal-phase-always-out-of-scope)).
4. **Ask the user three opt-in questions** via `AskUserQuestion`. Defaults are project-specific (see below); record every answer in tracking under `run_options`:

   a. **Pause between phases?** *"Do you want me to pause and wait for confirmation after each phase, before starting the next one? Lets you review the diff / branch / PR / tracking summary before moving on."* Options: `Auto-flow (default) — keep going phase to phase`, `Pause between phases — wait for go after each one`.

   b. **Draft inline review comments per phase?** *"On top of the standard PR description, do you want me to scan each phase's diff and add 3–10 inline comments calling out non-obvious decisions (subtle invariants, feature-flag short-circuits, cross-phase coupling, upstream-contract naming)? Off by default — say yes when reviewers will appreciate annotated diffs."* Options: `Yes — include inline comments`, `No — PR description only`.

   c. **Run phases in a worktree?** *"Do you want every phase's subagent to work inside an isolated git worktree (its own runnable copy of the app with its own dev + test DB, env files, docker-compose project name) instead of sharing your main checkout? Lets you keep using `{{DEFAULT_BRANCH}}` for unrelated work while this plan runs; survives parallel plans on the same repo without DB / port / docker collisions. Costs one extra checkout's worth of disk + the time it takes [prepare-worktree](../prepare-worktree/SKILL.md) to provision it."* Options: `No — run in current checkout`, `Yes — provision one shared worktree for the whole plan`. Default = value of `run_options.implement-plan.use_worktree` in `.vinta-ai-workflows.yaml` (`No` when unset).

      When `Yes`: **the same worktree is used for every executable phase** — all phase branches stack inside it. The skill never provisions a second worktree mid-plan. If the user wants per-phase worktrees, that's a different workflow (split the plan into independent plans).

      Skip this question entirely when `foundation_skills.prepare-worktree` is `disabled` in `.vinta-ai-workflows.yaml`: record `run_options.use_worktree = false`; surface a one-line note that worktree isolation is available if the team opts in via [vinta-sync-ai-tools](../../skills/vinta-sync-ai-tools/SKILL.md).

   d. **Full test suite each phase?** *"Each phase's outer gate always runs the repo-wide type/build gate. For tests, do you want the quick path (run only the scoped suite covering the apps/files that phase touched — faster phases) or the full repo test suite every phase (slower, but guards against regressions in untouched code)? New tests still pass individually in the inner loop either way."* Options: `Quick — scoped tests only each phase (default)`, `Full — run the whole test suite each phase`. Default = value of `run_options.implement-plan.full_test_suite` in `.vinta-ai-workflows.yaml` (`Quick`/false when unset). Records `run_options.full_test_suite` (`true` only for the `Full` answer).
{{E2E_RUN_OPTION_QUESTION}}
   PR opening itself is **not** asked here — it's governed by the project's PR creation policy captured at bootstrap (see `{{PR_POLICY_BLOCK}}` above). When that policy = "agents create PRs", the {{INTEGRATE_PHASE_DISPATCH}} step always opens the PR via [open-pr.sh](../open-pr-from-context/scripts/open-pr.sh) regardless of the comment opt-in.{{COMMIT_STRATEGY_STEP0_QUESTION}}

5. **Confirm with user before starting.** Show plan path, phase list (id + title + tier + cross-repo/flag-removal flags + e2e flag), phases this skill will execute vs defer, {{BRANCH_NAMING_PATTERN_SUMMARY}}, captured `run_options.pause_between_phases` + `run_options.generate_inline_comments` + `run_options.use_worktree` + `run_options.full_test_suite`{{E2E_RUN_OPTION_CONFIRM}}{{COMMIT_STRATEGY_CONFIRM_NOTE}}{{PR_REMINDER_LINE}}.

   Wait for "go". After that, the per-phase pause behavior follows `run_options.pause_between_phases`. Inline-comment drafting follows `run_options.generate_inline_comments`. Worktree isolation follows `run_options.use_worktree`. Outer-gate test scope follows `run_options.full_test_suite`.{{E2E_RUN_OPTION_TRAILER}}{{COMMIT_STRATEGY_STEP0_TRAILER}}

## Agent models — reviewer, fixer, and mechanical steps

The per-phase **implementer** model stays plan-owned (each phase's `**Suggested AI model**:` line — see [implement-phase](../implement-phase/SKILL.md)). Every *other* model this conductor spawns — the review sub-agents and the mechanical steps — is chosen from `.vinta-ai-workflows.yaml`'s `agent_models` section, never from the plan. Read that section once in [Step 0](#step-0--locate--parse-plan) alongside `run_options`.

<!-- include: partials/agent-models.md#TIER_RESOLVE -->

<!-- include: partials/agent-models.md#MECHANICAL_DELEGATION -->

<!-- include: partials/worktree-seam.md#WORKROOT_RESOLUTION -->

<!-- include: partials/worktree-seam.md#WORKROOT_TOPOLOGY_RULE -->

## Step 1 — Per-phase loop

For each phase that's `not is_cross_repo and not is_flag_removal`, in plan order, run the pipeline:

### 1a. Implement

Invoke [implement-phase](../implement-phase/SKILL.md), passing the phase record, the plan-level decisions (**Goals + Non-goals**, **Guiding Decisions**, the relevant **Data Model Changes** subsection), the prior-phase tracking summaries, `run_options.full_test_suite`{{E2E_RUN_OPTION_TRACKING}}, and `WORKROOT` / `BASE_BRANCH` / `SANDBOX_TIER`. It returns the implementer's report.

**Model escalation.** implement-phase escalates one tier + retries once on a clear capability gap. After Tier 4 fails, it stops and hands back the failure — update tracking with `❌`, post the report to the user, ask how to proceed. Don't silently re-derive tier.

### 1b. Review

Invoke [review-phase](../review-phase/SKILL.md) against the phase diff, passing the phase body to walk, `WORKROOT`, `main_checkout`, `run_options.full_test_suite`{{E2E_RUN_OPTION_TRACKING}}, and the `reviewer` / `fixer` agent types with their `agent_models.reviewer` / `agent_models.fixer` tiers **plus this phase's `reviewer_model_tier` / `fixer_model_tier` overrides (null when the phase didn't set a `**Review models**:` line)**. review-phase prefers a phase override over the `agent_models` default. It loops its three layers + fix loop until clean, then returns `PASS` (or the surfaced findings). Do not proceed to integrate while any layer is red.

### 1c. Integrate

Invoke {{INTEGRATE_PHASE_DISPATCH}}, passing `WORKROOT` / `BASE_BRANCH`, the `{{PR_POLICY_BLOCK}}` policy, and `run_options.generate_inline_comments`. It pushes the branch and routes the PR through the context file, returning the branch + PR-context path + status. This is a mechanical step: when `agent_models.integrate` is set, run it as a delegated subagent per the [Delegate a mechanical step to a configured model](#delegate-a-mechanical-step-to-a-configured-model) pattern (the delegate pushes + writes the PR-context file + runs `open-pr.sh`, then reports the branch / path / status back); when unset, run it inline. Either way the PR-context file + `open-pr.sh` is the only PR-creation path.

### 1d. Update tracking file

Tracking lives at `{{PLAN_DIR}}/TRACKING_{plan-id}.md`. Commit on the **current** phase's branch — deletion in [Step 2](#step-2--final-report).

Schema: feature-name, plan path, started/last-updated dates, optional feature-flag info, **run options** (`pause_between_phases`, `generate_inline_comments`, `full_test_suite`{{E2E_RUN_OPTION_TRACKING}}, `use_worktree`, `worktree_path`, `worktree_branch`, `worktree_summary`, `sandbox_tier` — last four only when `use_worktree = true`), {{TRACKING_BRANCH_FIELD}}, completed-phases (with status, model{{TRACKING_PHASE_BRANCH_FIELD}}, e2e+screenshots if any, 5–15 line summary), current phase, remaining phases, deferred phases.

The conductor writes this from the git diff + the agent's summary — not from the agent's narration.

### 1e. Send brief update to user

One short paragraph: phase N done, branch pushed{{PR_LINK_NOTE}}, what got built, and — when the [Integrate](#1c-integrate) step ran — the PR-context file path with its `status` (`published` + URL when `open-pr.sh` opened the PR; `pending` when the script wasn't run because PR policy = branches only or deps were missing). When `status: pending`, mention how to publish later (`bash ai-tools/skills/open-pr-from-context/scripts/open-pr.sh <path>`). Moving to phase N+1. No long retrospective — the tracking file is the durable record.

### 1f. Per-phase pause gate (opt-in)

`run_options.pause_between_phases = false` (default) → **immediately start the next phase**. Do not wait.

`run_options.pause_between_phases = true` → ask the user via `AskUserQuestion`:

- `Continue — start phase N+1`
- `Pause — stop here, I'll resume later by re-invoking the skill` (conductor exits cleanly; tracking file already records progress so the next invocation resumes mid-plan per [Re-running mid-plan](#re-running-mid-plan)).
- `Stop — abort the plan run` (conductor stops; user decides next steps manually).

Wait for the answer. Don't spawn anything in the meantime. The pause is the user's review window — they may inspect the diff, the branch, the PR-context file, or the tracking file before agreeing to continue.

## Cross-repo phases

Phase in another repo:
1. **Do not implement.**
2. Mark in tracking under "Deferred Phases".
3. Continue to the next in-repo phase. Don't block on cross-repo work.

## Flag-removal phase (always out of scope)

Plan declared a flag → last phase is `Phase N — Remove the {flag-key} feature flag`. This skill **never** executes that phase. Flag removal is gated on real-world soak signal + is the exclusive responsibility of a dedicated flag-removal skill (separate skill).

What this skill does instead:
1. Identify the phase during Step 0; always exclude.
2. Mark in tracking as deferred.
3. End the run with a `/schedule` offer pointing at the dedicated flag-removal skill.
4. Refuse + redirect if the user asks this skill to remove the flag.

## Re-running mid-plan

User invokes the skill against a partially-done plan:

1. Read `{{PLAN_DIR}}/TRACKING_{plan-id}.md` if present. Extract `run_options.*` — including `worktree_path` / `worktree_branch` / `worktree_summary` when set. Never re-prompt the Step 0 opt-in questions on resume; the original answers stick.
2. **Worktree resume.** When `run_options.use_worktree = true`:
   - Confirm the worktree still exists (`git worktree list | grep <worktree_path>`). Missing → ask user: `Reprovision (run prepare-worktree again with the same name)`, `Switch to main checkout (flip use_worktree to false for the rest of the run)`, `Stop`.
   - Confirm the worktree summary file still parses; if not, regenerate from the existing worktree state.
   - **Re-probe `SANDBOX_TIER`** (`command -v sandbox-exec || command -v bwrap`) — a resume may run on a different machine than the original provisioning. Update `run_options.sandbox_tier` in tracking before spawning; the implement-phase spawn wrapping follows the re-probed value.
   - All resumed phases use the existing worktree — do not provision a second one.
3. `git -C <WORKROOT> branch -a | grep plan/{plan-id-kebab}` to detect already-pushed phase branches.
4. Cross-reference with the plan's phase list.
5. Confirm the resumption point with the user.

## Step 2 — Final report

After all executable phases complete:

1. **Delete `TRACKING_{plan-id}.md`** on the last phase's branch. Commit. The plan file stays.
2. Send the user a final summary: {{FINAL_REPORT_BRANCH_SUMMARY}}; for UI-flow phases — list of `pr-screenshots/` files (if applicable); deferred phases (cross-repo + flag-removal); next steps for the human. When `run_options.use_worktree = true`: include the worktree path + branch + summary file path + the teardown command (`git worktree remove <path>` + the per-engine drop-db / `docker compose -p <project> down -v` lines from `<worktree_summary>`). Do NOT auto-run teardown — the user may still want the worktree to debug review feedback or land follow-ups.
{{FINAL_REPORT_PR_NOTE}}
3. Flag-removal phase deferred → end with `/schedule` offer for the dedicated flag-removal skill.

## Important rules

- **Read AGENTS.md** in every phase prompt.
- **Stage explicitly.** No `git add -A`.
- **Subagents work in fresh sessions.** Each phase = a new subagent. Tracking + plan files = the context handoff.
- **Conductor owns git topology.** Phase-work subagents (implementer / reviewer / fixer) commit but never branch, push, {{PR_RULE_TAIL}}. The one exception is a **mechanical `integrate` delegate** spawned per `agent_models.integrate` — it exists precisely to run the conductor's integrate step (push + PR via `open-pr.sh`) on a cheaper model, and the conductor still dictates the branch/base topology it uses.
{{COAUTHOR_RULE_LINE}}
- **Trust the plan's per-phase model suggestion.** Implementer model selection lives in [implement-phase](../implement-phase/SKILL.md); the conductor never re-derives tiers.
- **Reviewer / fixer / mechanical-step models come from `agent_models`, not the plan.** Resolve each configured tier via the [Agent models](#agent-models--reviewer-fixer-and-mechanical-steps) step; an unset key means the spawn uses the runtime default. The plan never names these models.
- **Don't re-implement what a project skill encodes.**
{{UI_E2E_RULE_LINE}}
- **Two-tier verification, in order, every phase.** Inner scoped, then the outer gate — enforced inside [implement-phase](../implement-phase/SKILL.md). The outer gate always runs the repo-wide type/build gate; its test scope follows `run_options.full_test_suite` (scoped suite by default, full repo suite when opted in).
- **Three-layer review, every phase, no exceptions** — [review-phase](../review-phase/SKILL.md) is not optional and not inlined here.
- **Orchestrator never edits code.**
- **Feature flags = gates, not toggles for tests.**
- **Never remove a feature flag from this skill.**
- **Stop on Tier-4 failure.**
- **Honor opt-in flags.** `run_options.pause_between_phases` controls the [Per-phase pause gate](#1f-per-phase-pause-gate-opt-in); `run_options.generate_inline_comments` controls whether {{INTEGRATE_PHASE_DISPATCH}} drafts inline comments (always writes the file when that step runs at all — empty comments when off); `run_options.use_worktree` controls whether the [Resolve WORKROOT step](#step-05--resolve-workroot) provisions a worktree and thus what `WORKROOT` / `BASE_BRANCH` / `SANDBOX_TIER` resolve to; `run_options.full_test_suite` controls the outer-gate test scope ([Implement](#1a-implement) + [Review](#1b-review) Layer 1) — scoped suite by default, full repo suite when `true`.{{E2E_RUN_OPTION_RULE}}
- **One worktree per plan run.** When `use_worktree = true`, provision once in the [Resolve WORKROOT step](#step-05--resolve-workroot) and reuse for every phase. Never spawn a second worktree mid-plan; never silently fall back to the main checkout on prepare-worktree failure (ask the user).
- **Don't auto-tear-down the worktree.** Step 2 surfaces the teardown command; the user runs it when ready.
- **`WORKROOT` is resolved once, used everywhere.** Every sub-skill takes `WORKROOT` / `BASE_BRANCH` / `SANDBOX_TIER` as data — no step re-derives worktree state. OS-level prevention (sandbox wrap in implement-phase when `SANDBOX_TIER = enforced`) plus the review-phase stray-write backstop keep main-checkout writes out; see [worktree-seam](../implement-phase/SKILL.md#3-spawn-the-subagent).
- **PR-context file + `open-pr.sh` is the only PR-creation path.** No raw `gh pr create` / `glab mr create` calls outside the bundled script.
{{DEPENDENCY_LICENSE_RULE_LINE}}
- **Never use `§N` shorthand to point at sections** — neither in this skill body nor in any rendered file (tracking, prs-context, branch description). Always use the section's full name with a markdown link when possible.

## Quick checklist (conductor, per phase)

- [ ] Plan parsed; structured fields cached.
- [ ] Cross-repo + flag-removal phases identified + deferred.
- [ ] `WORKROOT` / `BASE_BRANCH` / `SANDBOX_TIER` resolved once ([Resolve WORKROOT step](#step-05--resolve-workroot)); worktree provisioned + summary captured + user confirmed when `use_worktree = true`.
- [ ] [implement-phase](../implement-phase/SKILL.md) run: prompt composed with **Goals + Non-goals** + **Guiding Decisions** + relevant **Data Model Changes** subsection + tracking summaries + this phase's body; model picked from `**Suggested AI model**:` (cheapest available); implementer report received.
- [ ] [review-phase](../review-phase/SKILL.md) run: Layers 1–3 clean; BLOCKERs fixed; SHOULD-FIX fixed or noted; outer gate re-run after any fix; when a worktree is in use, `git -C <main_checkout> status --short` clean after the implementer and after every fixer.
- [ ] {{INTEGRATE_PHASE_DISPATCH}} run: {{BRANCH_CHECKLIST_LINE}}{{PR_CHECKLIST_NOTE}}
{{COMMIT_STRATEGY_CHECKLIST_BLOCK}}
  - [ ] **Open PR via context file** decision applied per matrix (PR policy + `generate_inline_comments`): file written when at least one of policy=create / comments=true holds; `open-pr.sh` run when policy=create AND deps available (PR URL captured); per-comment failures (exit 1) and hard failures (exit 2) surfaced.
- [ ] `TRACKING_{plan-id}.md` updated.
- [ ] One-paragraph user update sent (PR URL or pending-file path included).
- [ ] If `run_options.pause_between_phases = true`: prompted user (`Continue` / `Pause` / `Stop`); honored answer. Else: next phase started immediately.
- [ ] On final phase: tracking file deleted; final summary lists branches{{FINAL_CHECKLIST_PR_NOTE}}; any `status: pending` PR-context files listed with publish command; `/schedule` offer for flag-removal if applicable.
