---
name: implement-plan
description: Execute a phased implementation plan from `{{PLAN_DIR}}/` in {{PROJECT_NAME}} by orchestrating one subagent per phase (using whatever model the plan suggests and the runtime supports), running independent phases concurrently in their own worktree lanes when the plan's dependency graph allows it, pushing one branch per phase to {{CODE_HOST}}, and tracking progress. Use when the user says "implement the plan", "execute plan X", "start implementation", "run phase N of plan Y", "implement {feature} plan", or asks to drive a `*_IMPLEMENTATION_PLAN.md` file phase-by-phase. NOT for one-off changes, single-file edits, or work that doesn't have an existing plan. {{PR_POLICY_DESCRIPTION}}
disable-model-invocation: true
---

# Implement Plan

Drive a phased plan in [`{{PLAN_DIR}}/`]({{PLAN_DIR}}/) to completion. This skill is a **thin conductor**: it parses the plan once, builds the phase dependency graph, resolves a `WORKROOT` per lane, then runs a fixed three-step pipeline per phase — **several phases at a time when the graph allows it** — delegating the real work to focused sub-skills:

1. [implement-phase](../implement-phase/SKILL.md) — compose prompt, pick model, spawn the implementer.
2. [review-phase](../review-phase/SKILL.md) — three-layer review + fix loop.
3. {{INTEGRATE_PHASE_DISPATCH}} — push the branch + open the PR via context file.

The conductor itself owns only: plan parsing, the dependency graph, phase classification, `WORKROOT` resolution, the scheduler, the progress-tracking directory, wave integration, the pause gate, and the final report. Harness-agnostic — claude-code, OpenAI Codex, Google's runtime, or any framework with a "spawn subagent with model + prompt" primitive.

**Parallel by default when the plan allows it.** The plan gives every phase a `**Depends on**:` line; phases whose dependencies are all green run **concurrently**, each in its own worktree lane. A plan whose graph is a straight chain runs exactly as it always did — one phase at a time. Sequential execution is the `max_parallel_lanes = 1` case of the same machinery, not a separate code path.

Execution counterpart to [plan-feature](../plan-feature/SKILL.md). Plan = contract; this skill = build pipeline.

<!-- include: partials/dispatched-agent.md#CONDUCTOR_ENTRY_GUARD -->

## Working assumptions

- Repo: {{PROJECT_NAME}} ({{STACK_SUMMARY}}). Conventions: [AGENTS.md](../../../AGENTS.md).
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
   - **Phased Rollout** section — parse into phase records: `{ id, title, goal, body, spec_use_case, depends_on, wave, base_branch, crew_member, crew_tier, suggested_model_tier, reviewer_model_tier, fixer_model_tier, reusable_skills, has_e2e, acceptance, is_cross_repo, is_flag_removal }`. `depends_on` comes from the phase's `**Depends on**:` line; `wave` and `base_branch` are **derived**, never read from the plan. `reviewer_model_tier` / `fixer_model_tier` come from the phase's optional `**Review models**:` line (null when the phase doesn't override — most phases). `crew_member` comes from the phase's `**Assigned to**:` line, and its role and tier from the **Crew** table row of the same id (a phase assigned to a `reviewer` row is a plan defect — the roles are disjoint); on a legacy plan with no Crew table, read `suggested_model_tier` off `**Suggested AI model**:` instead and leave `crew_member` null.
   - **Risk & Rollout Notes**, **Open Questions**, **Touch List** sections — keep available; include in phase prompts only when relevant. The **Touch List** additionally feeds the file-overlap warning in the graph step below.
3. **Classify each phase**: `is_cross_repo`, `is_flag_removal` — the conductor does NOT auto-execute these (see [Cross-repo phases](#cross-repo-phases) + [Flag-removal phase](#flag-removal-phase-always-out-of-scope)).
4. **Build the dependency graph** — see [Build the phase dependency graph](#build-the-phase-dependency-graph) below. Do this before the opt-in questions: the answer to the parallel-execution question depends on whether the graph has any wave wider than one phase.
5. **Ask the user the opt-in questions** via `AskUserQuestion`. Defaults are project-specific (see below); record every answer in tracking under `run_options`:

   a. **Pause between phases?** *"Do you want me to pause and wait for confirmation after each phase, before starting the next one? Lets you review the diff / branch / PR / tracking summary before moving on."* Options: `Auto-flow (default) — keep going phase to phase`, `Pause between phases — wait for go after each one`.

   b. **Draft inline review comments per phase?** *"On top of the standard PR description, do you want me to scan each phase's diff and add 3–10 inline comments calling out non-obvious decisions (subtle invariants, feature-flag short-circuits, cross-phase coupling, upstream-contract naming)? Off by default — say yes when reviewers will appreciate annotated diffs."* Options: `Yes — include inline comments`, `No — PR description only`.

   c. **Run phases in a worktree?** *"Do you want every phase's subagent to work inside an isolated git worktree (its own runnable copy of the app with its own dev + test DB, env files, docker-compose project name) instead of sharing your main checkout? Lets you keep using `{{DEFAULT_BRANCH}}` for unrelated work while this plan runs; survives parallel plans on the same repo without DB / port / docker collisions. Costs one extra checkout's worth of disk + the time it takes [prepare-worktree](../prepare-worktree/SKILL.md) to provision it."* Options: `No — run in current checkout`, `Yes — provision one shared worktree for the whole plan`. Default = value of `run_options.implement-plan.use_worktree` in `.vinta-ai-workflows.yaml` (`No` when unset).

      When `Yes` **and the run is sequential**: one worktree serves every executable phase — all phase branches live inside it. When `Yes` **and the run is parallel**: the conductor provisions a **pool** of worktrees, one per lane, plus one integration worktree — see [Provision the lane worktree pool](#provision-the-lane-worktree-pool). Either way the pool is sized once, at Step 0.5, and never grown mid-run.

      Skip this question entirely when `foundation_skills.prepare-worktree` is `disabled` in `.vinta-ai-workflows.yaml`: record `run_options.use_worktree = false`; surface a one-line note that worktree isolation is available if the team opts in via [vinta-sync-ai-tools](../../skills/vinta-sync-ai-tools/SKILL.md). When it is disabled, question (e) below is also skipped and the run is sequential — parallel execution has a hard worktree requirement.

   d. **Full test suite each phase?** *"Each phase's outer gate always runs the repo-wide type/build gate. For tests, do you want the quick path (run only the scoped suite covering the apps/files that phase touched — faster phases) or the full repo test suite every phase (slower, but guards against regressions in untouched code)? New tests still pass individually in the inner loop either way."* Options: `Quick — scoped tests only each phase (default)`, `Full — run the whole test suite each phase`. Default = value of `run_options.implement-plan.full_test_suite` in `.vinta-ai-workflows.yaml` (`Quick`/false when unset). Records `run_options.full_test_suite` (`true` only for the `Full` answer).

   e. **Run independent phases in parallel?** — **ask only when the graph has at least one wave wider than one phase.** *"{N} of this plan's phases have no dependency on each other, so they can be implemented at the same time — each in its own worktree with its own DB and compose stack. Widest point is {W} phases at once. Running them in parallel finishes the plan much faster; it costs one extra runnable checkout per lane and makes the run harder to watch step by step."* Options: `Yes — run up to {min(W, 3)} lanes at a time (default)`, `Yes — but cap at 2 lanes`, `No — one phase at a time`. Default = value of `run_options.implement-plan.parallel_phases` in `.vinta-ai-workflows.yaml` (**`true` when unset** — a plan that declares a parallel graph is asking to be run that way). Records `run_options.parallel_phases` + `run_options.max_parallel_lanes`.

      **Skip the question and record `parallel_phases = false`, `max_parallel_lanes = 1` when**: every wave holds exactly one phase (nothing to parallelize — say so in one line, don't ask), or `foundation_skills.prepare-worktree` is `disabled`, or the user answered `No` to question (c). In the last two cases, when the graph *was* parallelizable, tell the user what they are giving up and why: parallel execution cannot share one working tree.

      `max_parallel_lanes` is capped by the widest wave and by `run_options.implement-plan.max_parallel_lanes` (default `3`). More lanes than the graph can keep busy just burns disk.
{{E2E_RUN_OPTION_QUESTION}}
   PR opening itself is **not** asked here — it's governed by the project's PR creation policy captured at bootstrap (see `{{PR_POLICY_BLOCK}}` above). When that policy = "agents create PRs", the {{INTEGRATE_PHASE_DISPATCH}} step always opens the PR via [open-pr.sh](../open-pr-from-context/scripts/open-pr.sh) regardless of the comment opt-in.{{COMMIT_STRATEGY_STEP0_QUESTION}}

6. **Confirm with user before starting.** Show plan path, phase list (id + title + tier + cross-repo/flag-removal flags + e2e flag), phases this skill will execute vs defer, **the wave schedule** (which phases run together, and what each one waits on), {{BRANCH_NAMING_PATTERN_SUMMARY}}, captured `run_options.pause_between_phases` + `run_options.generate_inline_comments` + `run_options.use_worktree` + `run_options.full_test_suite` + `run_options.parallel_phases` + `run_options.max_parallel_lanes`{{E2E_RUN_OPTION_CONFIRM}}{{COMMIT_STRATEGY_CONFIRM_NOTE}}{{PR_REMINDER_LINE}}.

   Wait for "go". After that, the per-phase pause behavior follows `run_options.pause_between_phases`. Inline-comment drafting follows `run_options.generate_inline_comments`. Worktree isolation follows `run_options.use_worktree`. Outer-gate test scope follows `run_options.full_test_suite`. Concurrency follows `run_options.parallel_phases` + `run_options.max_parallel_lanes`.{{E2E_RUN_OPTION_TRAILER}}{{COMMIT_STRATEGY_STEP0_TRAILER}}

<!-- include: partials/parallel-lanes.md#DAG_PARSE -->

## Agent models — reviewer, fixer, and mechanical steps

The per-phase **implementer** model stays plan-owned: the plan's **Crew** table names the agents and their tiers, and each phase's `**Assigned to**:` line names which one takes it (see [implement-phase](../implement-phase/SKILL.md)). The **reviewer** is another member of the same table — a row whose role is `reviewer`, which never takes a phase — picked as the cheapest one at or above this phase's tier, and falling back to `.vinta-ai-workflows.yaml`'s `agent_models` where the roster staffs none. The mechanical-step models are `agent_models`-only and never plan-owned. Read that section once in [Step 0](#step-0--locate--parse-plan) alongside `run_options`.

<!-- include: partials/agent-models.md#TIER_RESOLVE -->

<!-- include: partials/agent-models.md#MECHANICAL_DELEGATION -->

<!-- include: partials/worktree-seam.md#WORKROOT_RESOLUTION -->

<!-- include: partials/parallel-lanes.md#LANE_WORKTREE_POOL -->

<!-- include: partials/worktree-seam.md#WORKROOT_TOPOLOGY_RULE -->

<!-- include: partials/parallel-lanes.md#LANE_TOPOLOGY -->

## Step 1 — Scheduler loop

Every phase that's `not is_cross_repo and not is_flag_removal` goes through the same three-step pipeline. **What the scheduler decides is when** — a phase becomes eligible the moment every id in its `depends_on` is green, and it runs as soon as a lane is free.

<!-- include: partials/parallel-lanes.md#LANE_SCHEDULER -->

**The per-phase pipeline.** Each dispatched lane runs the steps below for its own phase, concurrently with (and independently of) every other lane. Everywhere below, `WORKROOT` means **this lane's** workroot.

### 1a. Implement

Invoke [implement-phase](../implement-phase/SKILL.md), passing the phase record, the plan-level decisions (**Goals + Non-goals**, **Guiding Decisions**, the relevant **Data Model Changes** subsection), the **tracking summaries of this phase's transitive dependencies only** (see below), `run_options.full_test_suite`{{E2E_RUN_OPTION_TRACKING}}, and this lane's `WORKROOT` / `SANDBOX_TIER` plus the phase's computed `base_branch`. It returns the implementer's report.

**Prior-phase context is dependency-scoped, not chronological.** A lane must not be told about a sibling phase that happens to have finished first — that work is not in its base branch, so describing it as "already implemented" makes the implementer code against files it cannot see. Pass the `phase-{id}.md` summaries for the phase's **transitive dependency closure**, and nothing else. A wave-1 phase gets "Nothing yet — this phase starts from `<BASE_BRANCH>`."

**Model escalation.** implement-phase escalates one tier + retries once on a clear capability gap. After Tier 4 fails, it stops and hands back the failure — update tracking with `❌`, post the report to the user, ask how to proceed. Don't silently re-derive tier.

### 1b. Review

Invoke [review-phase](../review-phase/SKILL.md) against the phase diff, passing the phase body to walk, this lane's `WORKROOT`, `main_checkout`, **every sibling lane's workroot** (its Layer 1 stray-write check covers those too), `run_options.full_test_suite`{{E2E_RUN_OPTION_TRACKING}}, and the `reviewer` / `fixer` agent types with their `agent_models.reviewer` / `agent_models.fixer` tiers, **this phase's `reviewer_model_tier` / `fixer_model_tier` overrides (null when the phase didn't set a `**Review models**:` line)**, and **the phase's author tier plus the roster's reviewers** so a reviewer can be picked for it. review-phase prefers a phase override, then the cheapest qualified reviewer on the roster, then the `agent_models` default. It loops its three layers + fix loop until clean, then returns `PASS` (or the surfaced findings). Do not proceed to integrate while any layer is red.

### 1c. Integrate

Invoke {{INTEGRATE_PHASE_DISPATCH}}, passing this lane's `WORKROOT`, the phase's computed `base_branch` (**not** the plan-level `BASE_BRANCH` — see [Lane branch topology](#lane-branch-topology)), the `{{PR_POLICY_BLOCK}}` policy, and `run_options.generate_inline_comments`. It pushes the branch and routes the PR through the context file, returning the branch + PR-context path + status. This is a mechanical step: when `agent_models.integrate` is set, run it as a delegated subagent per the [Delegate a mechanical step to a configured model](#delegate-a-mechanical-step-to-a-configured-model) pattern (the delegate pushes + writes the PR-context file + runs `open-pr.sh`, then reports the branch / path / status back); when unset, run it inline. Either way the PR-context file + `open-pr.sh` is the only PR-creation path.

### 1d. Update tracking

<!-- include: partials/parallel-lanes.md#TRACKING_DIR -->

### 1e. Wave integration (when this phase completes a wave)

After a phase passes review + integrate, check whether **every** phase at its wave is now green. If so, build `plan/{plan-id-kebab}/wave-{N}` in the integration worktree per [Lane branch topology](#lane-branch-topology), write `waves/wave-{N}.md`, and push. If not, do nothing — the wave branch is built once, by whichever lane happens to finish last.

Wave integration runs **in the integration worktree**, never in a lane. It must not block the scheduler: dispatch it and keep filling free lanes with ready phases while it runs.

### 1f. Send brief update to user

One short paragraph: which phase finished on which lane, branch pushed{{PR_LINK_NOTE}}, what got built, and — when the [Integrate](#1c-integrate) step ran — the PR-context file path with its `status` (`published` + URL when `open-pr.sh` opened the PR; `pending` when the script wasn't run because PR policy = branches only or deps were missing). When `status: pending`, mention how to publish later (`bash ai-tools/skills/open-pr-from-context/scripts/open-pr.sh <path>`). Then what the scheduler picked up next, and what is still running on the other lanes. No long retrospective — the tracking directory is the durable record.

Under parallel execution, send **one update per phase completion**, not a merged digest — the user needs to be able to interrupt on a specific lane.

### 1g. Pause gate (opt-in)

`run_options.pause_between_phases = false` (default) → **immediately dispatch the next ready phase**. Do not wait.

`run_options.pause_between_phases = true` → stop dispatching, let every in-flight lane finish, then ask the user via `AskUserQuestion`:

- `Continue — dispatch the next ready phases`
- `Pause — stop here, I'll resume later by re-invoking the skill` (conductor exits cleanly; the tracking directory already records progress so the next invocation resumes mid-plan per [Re-running mid-plan](#re-running-mid-plan)).
- `Stop — abort the plan run` (conductor stops; user decides next steps manually).

Wait for the answer. Don't spawn anything in the meantime — with lanes idle, the pause is genuinely a stop. The pause is the user's review window; they may inspect any lane's diff, branch, PR-context file, or tracking entry before agreeing to continue.

## Cross-repo phases

Phase in another repo:
1. **Do not implement.**
2. Mark it deferred in `run.md`.
3. Keep scheduling every in-repo phase. Don't block on cross-repo work.
4. **Any phase that depends on it is deferred too**, transitively — its base branch would never exist. The [graph step](#build-the-phase-dependency-graph) already computed that closure; report the whole set together so the user sees the real cost of the cross-repo edge, not just one phase.

## Flag-removal phase (always out of scope)

Plan declared a flag → last phase is `Phase N — Remove the {flag-key} feature flag`. This skill **never** executes that phase. Flag removal is gated on real-world soak signal + is the exclusive responsibility of a dedicated flag-removal skill (separate skill).

What this skill does instead:
1. Identify the phase during Step 0; always exclude.
2. Mark in tracking as deferred.
3. End the run with a `/schedule` offer pointing at the dedicated flag-removal skill.
4. Refuse + redirect if the user asks this skill to remove the flag.

## Re-running mid-plan

User invokes the skill against a partially-done plan:

1. Read `{{PLAN_DIR}}/TRACKING_{plan-id}/run.md` plus every `phase-*.md` beside it. Extract `run_options.*` — including the lane pool and the resolved dependency graph. Never re-prompt the Step 0 opt-in questions on resume; the original answers stick. **Legacy single-file tracking** (`TRACKING_{plan-id}.md`) → migrate it into the directory first, per [Tracking directory](#1d-update-tracking).
2. **Rebuild the graph from the plan file and diff it against the recorded one.** The plan may have been edited between runs. A changed `**Depends on**:` line on a phase that is already `done` is a warning (its branch is already based on the old graph — surface it); on a pending phase it simply takes effect.
3. **Lane pool resume.** When `run_options.use_worktree = true`, for **every** lane in the pool plus the integration worktree:
   - Confirm it still exists (`git worktree list | grep <workroot>`). Missing → ask the user: `Reprovision that lane`, `Shrink the pool and carry on with fewer lanes`, `Stop`.
   - Confirm its summary file still parses; if not, regenerate from the existing worktree state.
   - **Re-probe `SANDBOX_TIER`** (`command -v sandbox-exec || command -v bwrap`) — a resume may run on a different machine than the original provisioning. Update each lane's `sandbox_tier` in `run.md` before spawning; the implement-phase spawn wrapping follows the re-probed value.
   - **Reset each lane's DB before reuse**, exactly as a mid-run reassignment would ([Resetting a lane worktree between phases](#resetting-a-lane-worktree-between-phases)). A lane resumed with a half-applied migration set is the single most likely way a resumed run goes wrong.
   - Never grow the pool on resume beyond what `run.md` recorded — a wider pool changes the schedule the user approved.
4. `git -C <integ.workroot> branch -a | grep plan/{plan-id-kebab}` to detect already-pushed phase, `integ-`, and `wave-` branches. A phase whose branch exists and whose `phase-{id}.md` says `done` is green; a phase whose branch exists without a `phase-{id}.md` was interrupted mid-flight — treat it as **not** done, delete the branch, and re-run it.
5. Cross-reference with the plan's phase list, recompute the ready set, and confirm the resumption point with the user — showing which phases are done, which are blocked by a failure, and what the scheduler will dispatch first.

## Step 2 — Final report

After the scheduler loop exits — every executable phase is `done`, `failed`, or `blocked`:

1. **Build the final wave branch** if the last completed wave has no branch yet, so one branch carries the whole plan.
2. **Delete the `TRACKING_{plan-id}/` directory** (`git rm -r`) on that final wave branch, in one commit. The plan file stays.
3. Send the user a final summary: {{FINAL_REPORT_BRANCH_SUMMARY}}; the **wave branches** in order, and which phase branches merged into each; phases that **failed** and the dependents each one **blocked**; for UI-flow phases — list of `pr-screenshots/` files (if applicable); deferred phases (cross-repo + flag-removal); next steps for the human. When `run_options.use_worktree = true`: include **every lane's** path + branch + summary file path + teardown command (`git worktree remove <path>` + the per-engine drop-db / `docker compose -p <project> down -v` lines from that lane's `<worktree_summary>`), and the integration worktree's. Do NOT auto-run teardown — the user may still want a lane to debug review feedback or land follow-ups, and a failed phase's lane is the only place its state survives.
{{FINAL_REPORT_PR_NOTE}}
4. Flag-removal phase deferred → end with `/schedule` offer for the dedicated flag-removal skill.

## Important rules

- **Read AGENTS.md** in every phase prompt.
- **Stage explicitly.** No `git add -A`.
- **Subagents work in fresh sessions.** Each phase = a new subagent. The plan file plus the phase's dependency-closure tracking files = the context handoff.
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
- **Honor opt-in flags.** `run_options.pause_between_phases` controls the [pause gate](#1g-pause-gate-opt-in); `run_options.generate_inline_comments` controls whether {{INTEGRATE_PHASE_DISPATCH}} drafts inline comments (always writes the file when that step runs at all — empty comments when off); `run_options.use_worktree` controls whether the [Resolve WORKROOT step](#step-05--resolve-workroot) provisions worktrees and thus what `WORKROOT` / `SANDBOX_TIER` resolve to; `run_options.full_test_suite` controls the outer-gate test scope ([Implement](#1a-implement) + [Review](#1b-review) Layer 1) — scoped suite by default, full repo suite when `true`; `run_options.parallel_phases` + `run_options.max_parallel_lanes` control how many phases the [scheduler](#dispatch-loop) keeps in flight.{{E2E_RUN_OPTION_RULE}}
- **The graph decides order, not the plan's numbering.** Never run a phase before every id in its `**Depends on**:` set is green, and never serialize two phases the graph says are independent just because one has a lower number.
- **A lane only ever knows its own dependencies.** Pass a phase the tracking summaries of its transitive dependency closure and nothing more. Telling a lane about a sibling's work that is not in its base branch makes it code against files it cannot see.
- **One worktree pool per plan run.** Size it once in the [pool step](#provision-the-lane-worktree-pool) and reuse each lane across phases. Never grow the pool mid-run; never silently fall back to the main checkout on prepare-worktree failure, and never fall back to sequential without asking — parallel execution requires worktrees and refusing is the correct move.
- **Reset a lane's DB before reusing it.** A lane carrying a previous phase's migrations silently invalidates the next phase's tests. No `db_reset_cmd` and a migration on either side → re-provision that lane instead.
- **Don't auto-tear-down any worktree.** Step 2 surfaces every lane's teardown command; the user runs them when ready. A failed phase's lane is the only place its state survives.
- **`WORKROOT` is resolved once per lane, used everywhere.** Every sub-skill takes `WORKROOT` / `SANDBOX_TIER` as data — no step re-derives worktree state, and no step reads another lane's. OS-level prevention (sandbox wrap in implement-phase when `SANDBOX_TIER = enforced`, denying the whole pool root) plus the review-phase stray-write backstop across the main checkout and every sibling lane keep foreign writes out; see [worktree-seam](../implement-phase/SKILL.md#3-spawn-the-subagent).
- **The orchestrator never edits code — merge conflicts included.** A conflicted wave or `integ-` merge goes to a fixer subagent in the integration worktree, then back through the outer gate.
- **A failed phase blocks its dependents, not the run.** Let in-flight lanes finish, mark the transitive dependents blocked, keep dispatching what is still reachable, and report the whole picture.
- **PR-context file + `open-pr.sh` is the only PR-creation path.** No raw `gh pr create` / `glab mr create` calls outside the bundled script.
{{DEPENDENCY_LICENSE_RULE_LINE}}
- **Never use `§N` shorthand to point at sections** — neither in this skill body nor in any rendered file (tracking, prs-context, branch description). Always use the section's full name with a markdown link when possible.

## Quick checklist (conductor — once per run, then per phase)

- [ ] Plan parsed; structured fields cached.
- [ ] Cross-repo + flag-removal phases identified + deferred, **with their transitive dependents**.
- [ ] Dependency graph built + validated (no cycles, no unknown ids, no missing `**Depends on**:` line); waves computed; file-overlap warnings resolved with the user.
- [ ] `WORKROOT` / `SANDBOX_TIER` resolved per lane ([Resolve WORKROOT step](#step-05--resolve-workroot)); lane pool + integration worktree provisioned, summaries captured, schedule confirmed by the user when `use_worktree = true`.
- [ ] This phase dispatched only after every id in its `depends_on` was green; its `base_branch` computed from that set (not from plan order).
- [ ] Lane reset before reuse: base checked out, phase branch created, DB reset via `db_reset_cmd`.
- [ ] [implement-phase](../implement-phase/SKILL.md) run: prompt composed with **Goals + Non-goals** + **Guiding Decisions** + relevant **Data Model Changes** subsection + **dependency-closure** tracking summaries + this phase's body; agent claimed off the roster and model resolved from their tier (cheapest available); implementer report received.
- [ ] [review-phase](../review-phase/SKILL.md) run: Layers 1–3 clean; BLOCKERs fixed; SHOULD-FIX fixed or noted; outer gate re-run after any fix; when worktrees are in use, `git -C <tree> status --short` clean after the implementer and after every fixing round, whoever ran it, for the main checkout **and every sibling lane**.
- [ ] {{INTEGRATE_PHASE_DISPATCH}} run: {{BRANCH_CHECKLIST_LINE}}{{PR_CHECKLIST_NOTE}}
{{COMMIT_STRATEGY_CHECKLIST_BLOCK}}
  - [ ] **Open PR via context file** decision applied per matrix (PR policy + `generate_inline_comments`): file written when at least one of policy=create / comments=true holds; `open-pr.sh` run when policy=create AND deps available (PR URL captured); per-comment failures (exit 1) and hard failures (exit 2) surfaced.
- [ ] `TRACKING_{plan-id}/phase-{id}.md` written on this phase's own branch; `run.md` updated by the conductor only; no lane touched another lane's file.
- [ ] Wave branch built + `waves/wave-{N}.md` written when this phase completed its wave; merge conflicts resolved by a fixer, never by the conductor, and the outer gate re-run on the merged tree.
- [ ] One-paragraph user update sent per phase completion (PR URL or pending-file path included; lane named; what the scheduler picked up next).
- [ ] If `run_options.pause_between_phases = true`: stopped dispatching, let in-flight lanes drain, prompted user (`Continue` / `Pause` / `Stop`); honored answer. Else: next ready phase dispatched immediately.
- [ ] On run end: final wave branch built; tracking directory deleted; final summary lists wave + phase branches{{FINAL_CHECKLIST_PR_NOTE}}, failed phases with the dependents they blocked, every lane's teardown command; any `status: pending` PR-context files listed with publish command; `/schedule` offer for flag-removal if applicable.
