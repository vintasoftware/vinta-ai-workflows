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
   - **§1 Goals + Non-goals** — verbatim, used in every phase prompt.
   - **§2 Guiding Decisions** — verbatim. Pay attention to: feature flag (key, scope, default, flip-on criterion), storage shape, tenant scoping, API contract decisions.
   - **§3 Data Model Changes** — keep full body; later phases reference earlier subsections.
   - **§5 Phased Rollout** — parse into phase records: `{ id, title, goal, body, spec_use_case, suggested_model_tier, reusable_skills, has_e2e, acceptance, is_cross_repo, is_flag_removal }`.
   - **§6 Risk & Rollout Notes**, **§7 Open Questions**, **§8 Touch List** — keep available; include in phase prompts only when relevant.
3. **Classify each phase**: `is_cross_repo`, `is_flag_removal` — orchestrator does NOT auto-execute these.
4. **Confirm with user before starting.** Show plan path, phase list (id + title + tier + cross-repo/flag-removal flags + e2e flag), phases this skill will execute vs defer, branch naming pattern (default: `plan/{plan-id-kebab}/phase-{phase-id}`){{PR_REMINDER_LINE}}.

   Wait for "go". After that, **do not pause between phases** unless a phase fails after retry escalation.

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
2. {{PLAN_DIR}}/{plan-filename}, sections §1, §2, §3 and YOUR phase body in §5.

## Plan-level decisions (from §1 + §2)
{Goals + Non-goals verbatim}
{Guiding Decisions table verbatim}
{If feature flag declared:}
  Feature flag: `{flag-key}` — scope `{per-tenant|per-request}`, default `{false|true}`.
  Wire reads + writes per the plan's §2 entry. Off-flag path = byte-for-byte pre-feature behavior.

## What was already implemented in prior phases
{Tracking file "Completed Phases" section. First executed phase: "Nothing yet — this is the first phase."}

## Your tasks (Phase {id} only)
{phase.body verbatim, including Goal / Spec use-case / Feature flag / Changes / Tests / Acceptance lines}

## Reusable skills you SHOULD invoke
{phase.reusable_skills — for each, instruct the agent to first read ai-tools/skills/{name}/SKILL.md, then follow that pattern.}

Project skills available: {{PROJECT_SKILLS_LIST}}

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

**Don't** dump the full plan into every prompt. Tracking summaries replace prior phases as context. Always include §1 + §2 + relevant §3 — load-bearing decisions; phases reach back frequently.

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
- Model from §1b, translated.
- Phase prompt from §1a.
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
{{COAUTHOR_LAYER1_CHECK}}

#### Layer 2 — Plan compliance walkthrough

Open phase body alongside diff and walk:

1. **Every numbered "Changes" item implemented.**
2. **Every "Tests" entry materialized**, with assertions actually exercising the called-out behavior.
3. **Acceptance line satisfiable** by the diff.
4. **Repo conventions** from AGENTS.md.
5. **Reusable-skill compliance.**
{{E2E_LAYER2_CHECK}}
6. **Feature-flag wiring** if §2 declared a flag — flag-OFF byte-for-byte pre-feature behavior, ≥1 test asserts.
7. **Cross-phase consistency** with prior tracking summaries.

#### Layer 3 — Independent reviewer subagent

After Layers 1–2 pass, spawn a **separate** subagent (different session, no implementation context) using the project's `reviewer` agent type ([ai-tools/agents/reviewer.md](ai-tools/agents/reviewer.md)). Read-only by design.

Reviewer prompt template — see the reviewer agent's body for the standard form. Triage findings:
- **BLOCKER**: must fix before §1e.
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

{{PR_CREATION_INSTRUCTION_BLOCK}}

### 1f. Update tracking file

Tracking lives at `{{PLAN_DIR}}/TRACKING_{plan-id}.md`. Commit on the **current** phase's branch — deletion in Step 3.

Schema: feature-name, plan path, started/last-updated dates, optional feature-flag info, completed-phases (with status, model, branch, base, e2e+screenshots if any, 5–15 line summary), current phase, remaining phases, deferred phases.

The orchestrator writes this from the git diff + the agent's summary — not from the agent's narration.

### 1g. Send brief update to user

One short paragraph: phase N done, branch pushed{{PR_LINK_NOTE}}, what got built, moving to phase N+1. No long retrospective — tracking file is the durable record.

Then **immediately spawn the next phase**. Do not wait.

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

## Quick checklist (orchestrator, per phase)

- [ ] Plan parsed; structured fields cached.
- [ ] Cross-repo + flag-removal phases identified + deferred.
- [ ] Current phase: prompt composed with §1 + §2 + relevant §3 + tracking summaries + this phase's body.
- [ ] Model picked from `**Suggested AI model**:` line (cheapest available); plan tier recorded.
- [ ] Subagent spawned, report received.
- [ ] Inner loop green: scoped lint + new tests individually + scoped suite.
- [ ] **Outer gate green:** `{{BUILD_CMD}}` AND `{{TEST_CMD}}`{{E2E_OUTER_GATE_CHECKLIST}} both passed.
- [ ] Layer 1 review: full diff read; no scope creep; no secrets; outer gate confirmed{{COAUTHOR_CHECKLIST_NOTE}}.
- [ ] Layer 2 review: every "Changes" ticked; every "Tests" materialized; acceptance line satisfiable; conventions, reusable skills, e2e + screenshot compliance (if applicable), flag wiring all checked.
- [ ] Layer 3 review: adversarial review run; BLOCKERs fixed; SHOULD-FIX either fixed or noted.
- [ ] After any fix-up: Layers 1 + 2 + outer gate re-run.
- [ ] Stacked branch created; pushed.{{PR_CHECKLIST_NOTE}}
- [ ] `TRACKING_{plan-id}.md` updated.
- [ ] One-paragraph user update sent.
- [ ] Next phase started immediately.
- [ ] On final phase: tracking file deleted; final summary lists branches{{FINAL_CHECKLIST_PR_NOTE}}; `/schedule` offer for flag-removal if applicable.
