---
name: implement-plan
description: Execute a phased implementation plan from `{{PLAN_DIR}}/` in {{PROJECT_NAME}} by orchestrating one subagent per phase (using whatever model the plan suggests and the runtime supports), pushing one stacked branch per phase to {{CODE_HOST}}, and tracking progress. Use when the user says "implement the plan", "execute plan X", "start implementation", "run phase N of plan Y", "implement {feature} plan", or asks to drive a `*_IMPLEMENTATION_PLAN.md` file phase-by-phase. NOT for one-off changes, single-file edits, or work that doesn't have an existing plan. {{PR_POLICY_DESCRIPTION}}
---

# Implement Plan

Drive a phased plan in [`{{PLAN_DIR}}/`]({{PLAN_DIR}}/) to completion: spawn one subagent per phase (whichever model plan recommends + runtime can run), run lint / typecheck / unit / e2e (where applicable), push one stacked {{CODE_HOST}} branch per phase, keep a progress tracking file as context handoff between phases. Harness-agnostic — claude-code, OpenAI Codex, Google's runtime, or any framework with a "spawn subagent with model + prompt" primitive.

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
   - **Phased Rollout** section — parse into phase records: `{ id, title, goal, body, spec_use_case, suggested_model_tier, reusable_skills, has_e2e, acceptance, is_cross_repo, is_flag_removal }`.
   - **Risk & Rollout Notes**, **Open Questions**, **Touch List** sections — keep available; include in phase prompts only when relevant.
3. **Classify each phase**: `is_cross_repo`, `is_flag_removal` — orchestrator does NOT auto-execute these.
4. **Ask the user two opt-in questions** via `AskUserQuestion`. Both default to off; record both answers in tracking under `run_options`:

   a. **Pause between phases?** *"Do you want me to pause and wait for confirmation after each phase, before starting the next one? Lets you review the diff / branch / PR / tracking summary before moving on."* Options: `Auto-flow (default) — keep going phase to phase`, `Pause between phases — wait for go after each one`.

   b. **Draft inline review comments per phase?** *"On top of the standard PR description, do you want me to scan each phase's diff and add 3–10 inline comments calling out non-obvious decisions (subtle invariants, feature-flag short-circuits, cross-phase coupling, upstream-contract naming)? Off by default — say yes when reviewers will appreciate annotated diffs."* Options: `Yes — include inline comments`, `No — PR description only`.

   PR opening itself is **not** asked here — it's governed by the project's PR creation policy captured at bootstrap (see `{{PR_POLICY_BLOCK}}` above). When that policy = "agents create PRs", the [Open PR via context file](#1f-open-pr-via-context-file) step always opens the PR via [open-pr.sh](../foundation-skills/open-pr-from-context/scripts/open-pr.sh) regardless of the comment opt-in.

5. **Confirm with user before starting.** Show plan path, phase list (id + title + tier + cross-repo/flag-removal flags + e2e flag), phases this skill will execute vs defer, branch naming pattern (default: `plan/{plan-id-kebab}/phase-{phase-id}`), captured `run_options.pause_between_phases` + `run_options.generate_inline_comments`{{PR_REMINDER_LINE}}.

   Wait for "go". After that, the per-phase pause behavior follows `run_options.pause_between_phases`. Inline-comment drafting follows `run_options.generate_inline_comments`.

## Step 1 — Per-phase loop

For each phase that's `not is_cross_repo and not is_flag_removal`, in plan order:

### 1a. Prepare agent prompt (token-efficient)

Compose with **only what the agent needs**:

```
You are implementing {phase.id}: {phase.title} of plan {plan.id}.

## Repo
{{PROJECT_NAME}} ({{STACK_SUMMARY}}).

## Read first
1. AGENTS.md — repo conventions.
2. {{PLAN_DIR}}/{plan-filename}, the **Goals + Non-goals**, **Guiding Decisions**, **Data Model Changes** sections and YOUR phase body inside **Phased Rollout**.

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
7. Stage right files (NEVER `git add -A` — {{ANTI_GIT_ADD_ALL_REASON}}). Stage explicitly: `git add {{STAGE_PATTERN}}`.
8. Commit with the repo's style — look at `git log -10 --oneline` first. {{COMMIT_STYLE_LINE}}.
9. {{COAUTHOR_INSTRUCTION_LINE}}
10. {{PUSH_INSTRUCTION_LINE}}

## Required output (single final report)
- Status: SUCCESS or FAILURE (and why).
- Files created/modified (paths only).
- 5–15 line summary of what you implemented and key decisions.
{{E2E_REPORT_FIELD}}
- Deviations from the plan body and reasoning.
- Anything you couldn't do (with explanation).
```

**Don't** dump the full plan into every prompt. Tracking summaries replace prior phases as context. Always include the **Goals + Non-goals** and **Guiding Decisions** sections plus the relevant **Data Model Changes** subsection — load-bearing decisions; phases reach back frequently.

### 1b. Pick model from plan's per-phase suggestion

**Plan owns model selection — this skill does not re-derive tiers, doesn't assume vendor.** Each phase carries `**Suggested AI model**:` listing one model per vendor.

Pick:

1. Read line, parse out **all** vendor suggestions.
2. **Filter to what's actually available in the runtime.** Different harnesses expose different sets.
3. From surviving suggestions, **pick the cheapest / fastest** the runner can use.
4. Translate the chosen model to whatever form the runner's spawning tool expects.
5. Phase suggestion straddles tiers → pick the higher-tier suggestion.
6. Line missing / malformed → **ask the user**. Don't silently re-derive tier.

**Retry escalation (no user prompt):** picked model fails on a clear capability gap → step **one tier up** + retry once. After Tier 4 fails, STOP. Update tracking with `❌`, post the agent's report to the user, ask how to proceed.

Record the **model actually used** + the **plan's suggested tier** in tracking.

### 1c. Spawn subagent

Use whatever agent-spawning primitive the runtime exposes. Pass:

- Descriptive label (e.g. `"{plan.id} {phase.id}: {phase.title}"`).
- Model from the [Pick model from plan's per-phase suggestion](#1b-pick-model-from-plans-per-phase-suggestion) step, translated.
- Phase prompt from the [Prepare agent prompt](#1a-prepare-agent-prompt-token-efficient) step.
- The right **agent type**.

**Agent type per phase.** Project agents in [`ai-tools/agents/`](ai-tools/agents/) (exposed to claude-code via `.claude/agents` symlink):

{{AGENT_DISPATCH_TABLE}}

Phase combines shapes → agent type stays `implementer`, prompt lists every relevant SKILL.md. Agent type changes only when a stack-specialist's risk is the primary one.

**Avoid bouncing the same phase between multiple agents.** Wanting to "hand off" mid-phase → the plan should have split into sub-phases instead.

### 1d. Thorough review

Three layers, all required, in order. The orchestrator never edits — every issue surfaces as a fix-up subagent task.

#### Layer 1 — Mechanical checks

1. `git status` + `git diff --stat`: confirm file list matches the agent's report.
2. **Read the full diff** for every changed file using `git diff`. Spot-checking is not enough.
3. **Verify the outer gate** ran + green. Look in the report for explicit confirmation that `{{BUILD_CMD}}` AND `{{TEST_CMD}}` were executed + passed{{E2E_LAYER1_NOTE}}. Vague confirmation → **re-run yourself**.
4. **Scope creep**: file touched outside expected surface area? Unrelated formatting churn? Surface it.
5. **No-secrets scan**: `git diff` for `password|secret|token|api_key|AKIA|BEGIN [A-Z]+ KEY`.
{{DEPENDENCY_LICENSE_LAYER1_CHECK}}
{{COAUTHOR_LAYER1_CHECK}}

#### Layer 2 — Plan compliance walkthrough

Open phase body alongside diff and walk:

1. **Every numbered "Changes" item implemented.**
2. **Every "Tests" entry materialized**, with assertions actually exercising the called-out behavior.
3. **Acceptance line satisfiable** by the diff.
4. **Repo conventions** from AGENTS.md.
5. **Reusable-skill compliance.**
{{E2E_LAYER2_CHECK}}
6. **Feature-flag wiring** if the plan's **Guiding Decisions** declared a flag — flag-OFF byte-for-byte pre-feature behavior, ≥1 test asserts.
7. **Cross-phase consistency** with prior tracking summaries.

#### Layer 3 — Independent reviewer subagent

After Layers 1–2 pass, spawn a **separate** subagent (different session, no implementation context) using the project's `reviewer` agent type ([ai-tools/agents/reviewer.md](ai-tools/agents/reviewer.md)). Read-only by design.

Reviewer prompt template — see the reviewer agent's body for the standard form. Triage findings:
- **BLOCKER**: must fix before the **{{BRANCH_PUSH_HEADING}}** step below.
- **SHOULD-FIX**: fix in-phase if cheap; else follow-up issue + tracking note.
- **NIT**: ignore unless trivially cheap.

Reviewer finds nothing on a >300-LoC multi-file phase → suspicious. Read once more.

#### Fix loop

1. Spawn a **new** subagent — project's `fixer` agent type ([ai-tools/agents/fixer.md](ai-tools/agents/fixer.md)). Fix prompt quotes the finding verbatim.
2. The `fixer`'s system prompt mandates re-running the inner loop + outer gate.
3. After fixer returns, redo Layer 1 in full + the affected portion of Layer 2.
4. Loop until Layers 1, 2, 3 are clean.

### 1e. {{BRANCH_PUSH_HEADING}}

Branch naming: `plan/{plan-id-kebab}/phase-{phase.id}`.

**First executed phase** (branches from `{{DEFAULT_BRANCH}}`):
```bash
git checkout {{DEFAULT_BRANCH}}
git pull --ff-only
git checkout -b plan/{plan-id-kebab}/phase-{phase.id}
# subagent's commits land on this branch
git push -u origin plan/{plan-id-kebab}/phase-{phase.id}
```

**Subsequent phases** (stacked on the previous phase's branch):
```bash
git checkout plan/{plan-id-kebab}/phase-{prev.id}
git checkout -b plan/{plan-id-kebab}/phase-{phase.id}
git push -u origin plan/{plan-id-kebab}/phase-{phase.id}
```

PR opening lives in the [Open PR via context file](#1f-open-pr-via-context-file) step below (single flow — context file + `open-pr.sh`). Subagents never open PRs themselves; the orchestrator does, after review passes.

### 1f. Open PR via context file

This is the **only** PR-creation path. PRs always go through a `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md` file + the bundled [open-pr.sh](../foundation-skills/open-pr-from-context/scripts/open-pr.sh) script — even when inline comments are not requested. The file is the durable record; the script is the publisher.

Two project-level signals decide the actual behavior:

| `{{PR_POLICY_BLOCK}}` policy | `run_options.generate_inline_comments` | What this **Open PR via context file** step does |
|---|---|---|
| agents create PRs | false | Write minimal context file (`# Title`, `# Description`, empty `# Comments`). Run `open-pr.sh` → PR opened, no inline comments. |
| agents create PRs | true  | Write full context file (title + description + 3–10 inline comments). Run `open-pr.sh` → PR opened, all comments posted. |
| branches only     | false | **Skip this step entirely.** Human will open PR manually from the pushed branch. |
| branches only     | true  | Write full context file (durable record). **Don't run `open-pr.sh`.** Human can publish later from a CLI-equipped session via [open-pr-from-context](../foundation-skills/open-pr-from-context/SKILL.md). Surface this in the [Send brief update](#1h-send-brief-update-to-user) step. |

#### Steps

1. **Skip if neither column applies** (policy = branches only AND `generate_inline_comments = false`). Jump to the [Update tracking file](#1g-update-tracking-file) step.

2. **Honor existing PR / MR templates.** Read `project.pr_template_paths` from `.vinta-ai-workflows.yaml`. For each entry:
   - **One template** → load it; the prs-context `# Description` body must follow that template's section structure verbatim. Fill each section with phase-specific content drawn from the plan's **Goals + Non-goals**, **Guiding Decisions**, and the phase body. Preserve any `<!-- HTML comments -->` placeholders; do not strip the template's checklists. Sections you can't fill from phase data → leave the template's placeholder/prompt untouched (don't fabricate).
   - **Multiple templates** (`PULL_REQUEST_TEMPLATE/` directory) → ask once via `AskUserQuestion`: list each template + its filename, ask which to use for this run. Cache the choice in tracking under `run_options.pr_template_used` so subsequent phases of the same plan use the same one without re-asking.
   - **Empty array** → free-form description. Default sections: `## Summary` (1–3 sentences), `## Plan reference` (link / phase id), `## Test plan` (commands the reviewer can run).

   When the project's PR template includes a checkbox checklist (e.g. `- [ ] Tests added`, `- [ ] Docs updated`), tick the boxes the phase's diff actually satisfies and leave unsatisfied ones unticked — never auto-tick everything.

   GitHub also honors `?template=<name>` in the PR-create URL when the project has a multi-template directory. `gh pr create --body-file` writes the body directly so the URL trick isn't needed; the body must match the chosen template's structure regardless.

3. **Pick comment targets** (only when `generate_inline_comments = true`). Read the phase diff via `git diff {{DEFAULT_BRANCH}}...HEAD` (or the previous phase branch for stacked phases). Select 3–10 spots that benefit from a one-paragraph context note — typically:
   - A subtle invariant the diff relies on (cite the plan's **Goals + Non-goals** / **Guiding Decisions** entries — by name, never use `§` shorthand).
   - A workaround for a known framework / library limitation.
   - A naming choice driven by an upstream contract.
   - The off-flag short-circuit when a feature flag is in **Guiding Decisions**.
   - Why a seemingly-cleaner refactor wasn't made (out of scope per **Goals + Non-goals**).
   - Cross-phase coupling (this hook is consumed by phase N+k).

   Skip lint/format churn, boilerplate matching nearby files, standard patterns from AGENTS.md, and self-explanatory test names. **A clean phase produces few comments — that's fine. Don't pad.**

   When `generate_inline_comments = false`: skip this step. The file's `# Comments` block stays empty.

4. **Write `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md`** following [resources/prs-context-template.md](../prs-context-template.md). Frontmatter: `plan_id`, `feature_name`, `phase_id`, `phase_title`, `branch`, `base`, `created_at`, `status: pending`, empty `pr_url`. Body sections: `# Title` (single-line PR title), `# Description` (Markdown body — uses the project's PR template structure from step 2 when one exists), `# Comments` (YAML list of `{file, start_line, end_line?, side, body}` — empty list when comments are off).

5. **Confirm `.vinta-ai-workflows/prs-context/` is in `.gitignore`.** [vinta-install-ai-tools-setup](../../../vinta-install-ai-tools-setup/SKILL.md) runs the multi-vendor setup script which appends `.vinta-ai-workflows/prs-context/` on its first invocation. If an older bootstrap missed it, append it now.

6. **Run `open-pr.sh`** (only when policy = agents create PRs). Detect a usable CLI (`gh` for GitHub, `glab` for GitLab) plus the script's other deps (`yq`, `jq`):

   ```bash
   bash ai-tools/skills/open-pr-from-context/scripts/open-pr.sh .vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md
   ```

   Script opens the PR (or detects an existing one), posts each inline comment, rewrites the file's frontmatter to `status: published` + populated `pr_url`, appends a publish log. Exit codes:

   - `0` — PR up, all comments (if any) posted. Capture `pr_url` for the [Send brief update](#1h-send-brief-update-to-user) step.
   - `1` — PR up, ≥1 comment failed. Surface the failed `(file:line)` list to the user; continue to the [Update tracking file](#1g-update-tracking-file) step.
   - `2` — Hard failure (deps missing, branch not pushed, CLI unauthed, file invalid). Surface the script's stderr; treat the phase as having no PR. The file stays `status: pending` so the user can re-run after fixing the gap.

   When policy = "branches only": **don't run the script.** File stays `status: pending`.

7. **Skill wrapper** — [open-pr-from-context](../foundation-skills/open-pr-from-context/SKILL.md) is available for ad-hoc invocation (after the run, on a different machine, etc.). The orchestrator can call the script directly here; the skill is for humans.

### 1g. Update tracking file

Tracking lives at `{{PLAN_DIR}}/TRACKING_{plan-id}.md`. Commit on the **current** phase's branch — deletion in Step 3.

Schema: feature-name, plan path, started/last-updated dates, optional feature-flag info, completed-phases (with status, model, branch, base, e2e+screenshots if any, 5–15 line summary), current phase, remaining phases, deferred phases.

The orchestrator writes this from the git diff + the agent's summary — not from the agent's narration.

### 1h. Send brief update to user

One short paragraph: phase N done, branch pushed{{PR_LINK_NOTE}}, what got built, and — when the [Open PR via context file](#1f-open-pr-via-context-file) step ran — the PR-context file path with its `status` (`published` + URL when `open-pr.sh` opened the PR; `pending` when the script wasn't run because PR policy = branches only or deps were missing). When `status: pending`, mention how to publish later (`bash ai-tools/skills/open-pr-from-context/scripts/open-pr.sh <path>`). Moving to phase N+1. No long retrospective — tracking file is the durable record.

### 1i. Per-phase pause gate (opt-in)

`run_options.pause_between_phases = false` (default) → **immediately spawn the next phase**. Do not wait.

`run_options.pause_between_phases = true` → ask the user via `AskUserQuestion`:

- `Continue — start phase N+1`
- `Pause — stop here, I'll resume later by re-invoking the skill` (orchestrator exits cleanly; tracking file already records progress so the next invocation resumes mid-plan per the "Re-running mid-plan" section).
- `Stop — abort the plan run` (orchestrator stops; user decides next steps manually).

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
4. Refuse + redirect if user asks this skill to remove the flag.

## Re-running mid-plan

User invokes the skill against a partially-done plan:

1. Read `{{PLAN_DIR}}/TRACKING_{plan-id}.md` if present.
2. `git branch -a | grep plan/{plan-id-kebab}` to detect already-pushed phase branches.
3. Cross-reference with the plan's phase list.
4. Confirm resumption point with the user.

## Step 2 — Final report

After all executable phases complete:

1. **Delete `TRACKING_{plan-id}.md`** on the last phase's branch. Commit. The plan file stays.
2. Send the user a final summary: branches pushed (with bases, in stack order); for UI-flow phases — list of `pr-screenshots/` files (if applicable); deferred phases (cross-repo + flag-removal); next steps for the human.
{{FINAL_REPORT_PR_NOTE}}
3. Flag-removal phase deferred → end with `/schedule` offer for the dedicated flag-removal skill.

## Important rules

- **Read AGENTS.md** in every phase prompt.
- **Stage explicitly.** No `git add -A`.
- **Subagents work in fresh sessions.** Each phase = a new subagent. Tracking + plan files = the context handoff.
- **Orchestrator owns git topology.** Subagents commit but never branch, push, {{PR_RULE_TAIL}}.
{{COAUTHOR_RULE_LINE}}
- **Trust the plan's per-phase model suggestion.**
- **Don't re-implement what a project skill encodes.**
{{UI_E2E_RULE_LINE}}
- **Two-tier verification, in order, every phase.** Inner scoped, outer full repo.
- **Three-layer review, every phase, no exceptions.**
- **Orchestrator never edits code.**
- **Feature flags = gates, not toggles for tests.**
- **Never remove a feature flag from this skill.**
- **Stop on Tier-4 failure.**
- **Honor opt-in flags.** `run_options.pause_between_phases` controls the [Per-phase pause gate](#1i-per-phase-pause-gate-opt-in); `run_options.generate_inline_comments` controls whether the [Open PR via context file](#1f-open-pr-via-context-file) step drafts inline comments (always writes the file when that step runs at all — empty comments when off).
- **PR-context file + `open-pr.sh` is the only PR-creation path.** No raw `gh pr create` / `glab mr create` calls outside the bundled script. The file is durable; the script is the publisher.
{{DEPENDENCY_LICENSE_RULE_LINE}}
- **[Open PR via context file](#1f-open-pr-via-context-file) gating** = combination of project PR policy ({{PR_POLICY_BLOCK}}) and `generate_inline_comments`. See the matrix in that step. Skip it entirely only when policy = branches only AND comments = off.
- **Never use `§N` shorthand to point at sections** — neither in this skill body nor in any rendered file (tracking, prs-context, branch description). Always use the section's full name with a markdown link when possible. `§N` references are hard to read for humans and brittle when section numbering shifts.

## Quick checklist (orchestrator, per phase)

- [ ] Plan parsed; structured fields cached.
- [ ] Cross-repo + flag-removal phases identified + deferred.
- [ ] Current phase: prompt composed with **Goals + Non-goals** + **Guiding Decisions** + relevant **Data Model Changes** subsection + tracking summaries + this phase's body.
- [ ] Model picked from `**Suggested AI model**:` line (cheapest available); plan tier recorded.
- [ ] Subagent spawned, report received.
- [ ] Inner loop green: scoped lint + new tests individually + scoped suite.
- [ ] **Outer gate green:** `{{BUILD_CMD}}` AND `{{TEST_CMD}}`{{E2E_OUTER_GATE_CHECKLIST}} both passed.
- [ ] Layer 1 review: full diff read; no scope creep; no secrets; outer gate confirmed{{COAUTHOR_CHECKLIST_NOTE}}.
- [ ] Layer 2 review: every "Changes" ticked; every "Tests" materialized; acceptance line satisfiable; conventions, reusable skills, e2e + screenshot compliance (if applicable), flag wiring all checked.
- [ ] Layer 3 review: adversarial review run; BLOCKERs fixed; SHOULD-FIX either fixed or noted.
- [ ] After any fix-up: Layers 1 + 2 + outer gate re-run.
- [ ] Stacked branch created; pushed.{{PR_CHECKLIST_NOTE}}
- [ ] **Open PR via context file** decision applied per matrix (PR policy + `generate_inline_comments`):
  - [ ] PR-context file written when at least one of policy=create / comments=true holds.
  - [ ] `open-pr.sh` run when policy=create AND deps available; PR URL captured.
  - [ ] Per-comment failures (exit 1) surfaced with `(file:line)` list.
  - [ ] Hard failure (exit 2) surfaced; file left `status: pending`.
- [ ] `TRACKING_{plan-id}.md` updated.
- [ ] One-paragraph user update sent (PR URL or pending-file path included).
- [ ] If `run_options.pause_between_phases = true`: prompted user (`Continue` / `Pause` / `Stop`); honored answer.
- [ ] If `run_options.pause_between_phases = false`: next phase started immediately.
- [ ] On final phase: tracking file deleted; final summary lists branches{{FINAL_CHECKLIST_PR_NOTE}}; any `status: pending` PR-context files listed with publish command; `/schedule` offer for flag-removal if applicable.
