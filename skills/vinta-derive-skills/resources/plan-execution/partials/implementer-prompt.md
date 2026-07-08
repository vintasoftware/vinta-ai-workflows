<!-- Partial: implementer-prompt — the token-efficient per-phase prompt. FULL = the forward-implementation prompt used by implement-phase. INNER_OUTER_LOOP = the read→edit→inner→outer verification steps (1–6), reused verbatim by amend-plan's 4b (which appends its own amend-specific commit / no-push tail instead of the commit-strategy block). The {If run_options.use_worktree = true:} markers are runtime gates the agent reads at execution time; derive-skills strips them entirely when foundation_skills.prepare-worktree is disabled (use_worktree can only ever be false). -->

<!-- block-begin: FULL -->
```
You are implementing {phase.id}: {phase.title} of plan {plan.id}.

## Repo
{{PROJECT_NAME}} ({{STACK_SUMMARY}}).

## Working location
Work entirely inside `<WORKROOT>`. `cd` into it before any command. Every `git`,
every lint / test / build / migrate call runs there.
{If run_options.use_worktree = true:}
  `<WORKROOT>` is an isolated git worktree — do NOT touch the main checkout; its DB,
  env, and compose stack are intentionally separated. See `<WORKROOT>/WORKTREE.md` for
  what's forked vs shared (deps, dev DB, test DB, compose project name, env file).
  {If run_options.sandbox_tier = enforced:} Writes to the main checkout are OS-blocked —
  if you see `Operation not permitted` / `EROFS` on a write, you used a main-checkout
  path by mistake; redo it against this worktree path.
Branch base for this phase: `<phase-specific base>` — the orchestrator already created
your phase branch there; commit straight to it.

## Read first
1. AGENTS.md — repo conventions.
2. {{PLAN_DIR}}/{plan-filename}, the **Goals + Non-goals**, **Guiding Decisions**, **Data Model Changes** sections and YOUR phase body inside **Phased Rollout**.
{If run_options.use_worktree = true:} 3. `WORKTREE.md` at the worktree root — fork map (which dirs symlink to main vs are independent copies).

## Plan-level decisions (from Goals + Non-goals + Guiding Decisions)
{Goals + Non-goals verbatim}
{Guiding Decisions table verbatim}
{If feature flag declared:}
  Feature flag: `{flag-key}` — scope `{per-tenant|per-request}`, default `{false|true}`.
  Wire reads + writes per the plan's **Guiding Decisions** entry. Off-flag path = byte-for-byte pre-feature behavior.

## What was already implemented in prior phases
{Tracking file "Completed Phases" section. First executed phase: "Nothing yet — this is the first phase."}

## Your tasks (Phase {id} only)
{phase.body verbatim, including Goal / Spec use-case / Feature flag / Changes / Tests / Acceptance lines}

## Reusable skills you SHOULD invoke
{phase.reusable_skills — for each, instruct the agent to first read ai-tools/skills/{name}/SKILL.md, then follow that pattern.}

Project skills available: {{PROJECT_SKILLS_LIST}}

{{DEPENDENCY_LICENSE_BLOCK}}

<!-- include: partials/implementer-prompt.md#INNER_OUTER_LOOP -->
{{PER_PHASE_COMMIT_BLOCK}}

## Required output (single final report)
- Status: SUCCESS or FAILURE (and why).
- Files created/modified (paths only).
- 5–15 line summary of what you implemented and key decisions.
{{E2E_REPORT_FIELD}}
- Deviations from the plan body and reasoning.
- Anything you couldn't do (with explanation).
```

**Don't** dump the full plan into every prompt. Tracking summaries replace prior phases as context. Always include the **Goals + Non-goals** and **Guiding Decisions** sections plus the relevant **Data Model Changes** subsection — load-bearing decisions; phases reach back frequently.
<!-- block-end: FULL -->

<!-- block-begin: INNER_OUTER_LOOP -->
## Working instructions
1. Read existing code paths your changes touch — do not write before reading.
2. Implement using Read/Edit/Write. Match existing patterns.
3. **Inner loop — fast iteration.** Scoped to files/apps you touched:
   a. `{{LINT_CMD}}` until clean.
   b. {{NEW_TEST_CMD_PATTERN}} for new tests individually.
   c. Scoped suite: {{SCOPED_TEST_PATTERN}}.
4. Iterate 2–3 until **new tests pass individually** and the scoped suite is green. Do **not** advance to step 5 with red scoped tests.
5. **Outer gate — full local verification, only after step 4 is green.** All MUST pass before staging:
   a. **Type / build:** `{{BUILD_CMD}}`.
   b. **Full test suite:** `{{TEST_CMD}}`.
   {{E2E_OUTER_GATE_LINE}}
6. Outer gate fails → return step 2 (fix regression), re-run inner loop, then 5a/5b/5c. **Never** commit, push, or proceed while any gate is red.
<!-- block-end: INNER_OUTER_LOOP -->
