---
name: amend-plan
description: Adjust an existing implementation plan in `{{PLAN_DIR}}/` after implementation has started or finished. Updates the plan file (revising existing phases or appending new ones), then for each affected phase that was already implemented adjusts its commits (`git commit --amend` or new commits) on the phase branch, force-pushes the rewritten branch, rebases every downstream stacked phase branch, force-pushes each, and refreshes the PR-context files. Use when the user says "amend the plan", "update phase N", "add a phase to plan X", "the spec changed, fix the plan", or "rewrite the implementation for phase N". NOT for one-off changes to a single file unrelated to a plan; use the regular implement skill for that. {{PR_POLICY_DESCRIPTION}}
---

# Amend Plan

Revise a plan in [`{{PLAN_DIR}}/`]({{PLAN_DIR}}/) after work has begun. Companion conductor to [implement-plan](../implement-plan/SKILL.md): it reuses the same sub-skills ([implement-phase](../implement-phase/SKILL.md) for the body change, [review-phase](../review-phase/SKILL.md) for the gates) — but the orchestrator's job here is **history rewriting** instead of forward execution.

The flow is destructive (force-push). Every modification is gated on user confirmation. Default disposition for any ambiguous case is "stop and ask" — never force-push without an explicit per-branch `Confirm` from the user.{{COMMIT_STRATEGY_REFUSAL_BLOCK}}

## Working assumptions

- Repo: {{PROJECT_NAME}} ({{STACK_SUMMARY}}). Conventions: [AGENTS.md](AGENTS.md).
- Plan files: [`{{PLAN_DIR}}/YYYY-MM-DD-FEATURE_NAME_PLAN.md`]({{PLAN_DIR}}/).
- Lint: `{{LINT_CMD}}`. Format: `{{FORMAT_CMD}}`.
- Type / build gate: `{{BUILD_CMD}}`{{TYPECHECK_NOTE}}.
- Unit / integration tests: `{{TEST_CMD}}`{{SCOPED_TEST_NOTE}}.
{{E2E_BLOCK}}
{{STACK_SPECIFIC_DEPLOY_BLOCK}}
- Code host: **{{CODE_HOST}}**. {{PR_POLICY_BLOCK}}
- {{COAUTHOR_POLICY_BLOCK}}
- Default branch: `{{DEFAULT_BRANCH}}`.
- Branch naming convention (set by [implement-plan](../implement-plan/SKILL.md)): `plan/{plan-id-kebab}/phase-{phase.id}`.
- **`WORKROOT`.** Resolve once, same as the [implement-plan Resolve WORKROOT step](../implement-plan/SKILL.md#step-05--resolve-workroot): the main checkout by default, or the plan's worktree when `run_options.use_worktree = true` in the tracking file. Every `git` call below runs with `git -C <WORKROOT>`; when no worktree is in play, `WORKROOT` is the main checkout and the commands read exactly as in-place git.

## When to use

- A spec change forces a phase body rewrite (different acceptance, different decisions in the plan's **Guiding Decisions**).
- A phase was implemented but the resulting diff is wrong / incomplete (caught post-merge to the phase branch but pre-merge to `{{DEFAULT_BRANCH}}`).
- A new phase needs to slot in between two existing ones, or be appended.
- A guiding decision in **Guiding Decisions** changed and it cascades into multiple phases.

## When NOT to use

- **Phase already merged to `{{DEFAULT_BRANCH}}`.** History cannot be retroactively rewritten on `{{DEFAULT_BRANCH}}`. The change must go in as a new phase appended to the plan, implemented forward via [implement-plan](../implement-plan/SKILL.md). This skill detects this case and refuses to force-push a merged branch.
- **Single-file change unrelated to a plan.** Use the regular implement skill / direct edit.
- **The plan never started.** No commits to amend; just edit the plan file and run [implement-plan](../implement-plan/SKILL.md) normally.

## Step 0 — Understand the change + parse the plan

1. **Identify the plan file.** Same logic as the [implement-plan "Locate + parse plan" step](../implement-plan/SKILL.md#step-0--locate--parse-plan): ask the user (path or feature name); `ls {{PLAN_DIR}}/` + grep; confirm before proceeding.

2. **Capture the requested change.** The user's prompt is the source. If vague, interview via `AskUserQuestion`:
   - *"Which phases are affected?"* — enumerate phase ids from the plan's **Phased Rollout** section.
   - *"Is this a body rewrite of an existing phase, a new phase to slot in, or a **Guiding Decisions** change that cascades?"*
   - *"What's the new acceptance criterion / change list?"* — verbatim.
   Don't infer scope. The plan-amend is the user's contract, not yours.

3. **Parse the plan.** Same structured fields as [implement-plan's "Extract structured fields" step](../implement-plan/SKILL.md#step-0--locate--parse-plan): plan id, **Goals + Non-goals** / **Guiding Decisions** / **Data Model Changes** / phase records from **Phased Rollout** / **Risk & Rollout Notes** through **Touch List**.

4. **Read the tracking file** `{{PLAN_DIR}}/TRACKING_{plan-id}.md` if present. Its `Completed Phases` section tells you which phase branches were pushed, which model + base were used, and the `run_options` (including worktree state → `WORKROOT`). If absent → `git -C <WORKROOT> branch -a | grep plan/{plan-id-kebab}` to enumerate pushed phase branches.

5. **Build a per-phase state map.** For every phase in the plan, record:

   | Field | Source |
   |---|---|
   | `phase.id`, `phase.title` | plan's **Phased Rollout** section |
   | `state` | one of `not-started` / `in-progress` / `implemented-not-merged` / `merged-to-default` |
   | `branch` | tracking file or git, pattern `plan/{plan-id-kebab}/phase-{id}` |
   | `base` | tracking file or `git -C <WORKROOT> merge-base origin/<branch> <prev-branch>`; root phase bases on `{{DEFAULT_BRANCH}}` |
   | `pr_status` | `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{id}.md` frontmatter (`pending` / `published`) when the file exists |
   | `merged_to_default` | `git -C <WORKROOT> branch --merged origin/{{DEFAULT_BRANCH}} | grep` against the branch |

   `merged-to-default = true` blocks any commit rewrite for that phase — see [Step 3 — Refuse force-pushes that can't work](#step-3--refuse-force-pushes-that-cant-work) below.

6. **Classify the requested change** by phase impact, in priority order:

   - **`body-rewrite`** — existing phase keeps its id; body changes. Cascades downstream because rewritten commits get new SHAs.
   - **`insert-new`** — new phase between existing ones. Cascades downstream because every later phase rebases onto the new branch.
   - **`append-new`** — new phase tacked on after the last one. No downstream cascade. Implementation runs forward via [implement-plan](../implement-plan/SKILL.md) — this skill hands off after editing the plan file.
   - **`guiding-decisions-change`** — change inside the plan's **Guiding Decisions** section. Cascades into every phase that referenced the decision.

7. **Evaluate amendment blast radius — recommend restart when too big.** Amending in place stops being a good deal once the rewrite work approaches re-implementation. Compute these signals from the per-phase state map + the requested change:

   | Signal | Threshold suggesting RESTART |
   |---|---|
   | Phases needing `body-rewrite` ÷ total implemented phases | ≥ 50% |
   | `guiding-decisions-change` cascading into | ≥ 50% of implemented phases |
   | Phases in `merged-to-default` (immutable, must be `append-new`) | ≥ 2, AND remaining work also rewrites earlier phases |
   | New body materially changes the data-model contract from **Data Model Changes** | rewrite of >2 phases hinges on it |
   | Estimated touched LoC across rewrites | ≥ 70% of original implementation diff size (rough estimate via `git -C <WORKROOT> diff --stat <base>..<branch>` summed across affected branches) |
   | Multi-author phase branches in the rewrite queue | ≥ 1 (force-push erases collaborator local state) |
   | Approved PRs in the rewrite queue | ≥ 2 (re-review burden becomes non-trivial) |

   Any **two** signals tripping → mark the amendment as `high-blast-radius`. **Three or more** → mark as `restart-recommended`.

   When `high-blast-radius` or `restart-recommended`, surface to the user via `AskUserQuestion` **before** showing the standard step-8 confirmation:

   - *"This amendment looks large enough that restarting from scratch may cost less than rewriting in place. Tripping signals: <list>. Restarting means: rewrite the plan as a fresh `YYYY-MM-DD-FEATURE_NAME_PLAN.md` (today's date), abandon the current phase branches (leave them in place for audit), run [implement-plan](../implement-plan/SKILL.md) on the new plan from scratch. Amending in place keeps history but force-pushes <N> branches and re-spawns implementer/reviewer/fixer agents per phase."*

   Options:

   - `Restart — draft a new plan, abandon current branches`
   - `Amend in place — proceed knowing the cost (you'll show me the force-push plan next)`
   - `Stop — let me think / talk to the team first`

   On `Restart`:

   1. Help the user draft a new `YYYY-MM-DD-FEATURE_NAME_PLAN.md` with today's date (paired with the spec, same `FEATURE_NAME`). This skill does not write the new plan body — point at [plan-feature](../plan-feature/SKILL.md) (or [create-spec](../create-spec/SKILL.md) first if the spec also changed).
   2. Annotate the **old** plan: at the top, add `**Superseded YYYY-MM-DD by ../YYYY-MM-DD-FEATURE_NAME_PLAN.md** — reason: <one line>`. Append the same line under `## Amendments`.
   3. Leave the old phase branches alone — useful audit trail, no force-push needed.
   4. Update `TRACKING_{plan-id}.md` to mark the plan superseded; preserve all completed-phase entries.
   5. Hand off to [plan-feature](../plan-feature/SKILL.md). This skill exits.

   On `Amend in place`: proceed to step 8 (the original confirmation gate, renumbered). On `Stop`: exit cleanly; nothing written.

   When the signals show `low-blast-radius` (≤1 tripping), skip the recommendation entirely and go straight to step 8. Don't pad easy amendments with restart questions.

8. **Confirm with user before any write.** Show: requested change, classified type, list of affected phase branches with their state + merge status, downstream branches that will be rebased, the force-push plan. Use `AskUserQuestion`:

   - `Proceed — I authorize the force-pushes listed`
   - `Refine — let me adjust scope` (loop back to step 2)
   - `Stop`

   Anything in `merged-to-default` state shown explicitly with a warning. **Do not** include those in the force-push list — user must convert those to `append-new` phases instead.

## Step 1 — Edit the plan file

Always the first write. Plan file is durable; commits get rewritten next.

1. **Body rewrites** — replace the affected `## Phase {id}` block inside **Phased Rollout** verbatim with the new body. Keep `phase.id` stable so branch naming stays valid.

2. **Inserts** — choose a new id. Two conventions are common:
   - Decimal: `1.5` between `1` and `2` (matches existing patterns in some Vinta plans). Branch becomes `plan/{plan-id-kebab}/phase-1.5`.
   - Letter: `1b` between `1` (relabeled `1a`) and `2`. Requires renaming `1` → `1a` inside **Phased Rollout** + updating downstream references.
   Ask the user. Default: decimal — no rename of existing ids.

3. **Appends** — new `## Phase N+1` block at end of **Phased Rollout**. Same shape as siblings: Goal, Suggested AI model, optional Review models, reusable_skills, Changes, Tests, Acceptance.

4. **Guiding Decisions changes** — rewrite the affected row. Add a one-line note at the top of **Guiding Decisions** ("**Amended YYYY-MM-DD**: replaced storage shape from X to Y; affects phases 2, 3, 4.") so reviewers see what shifted. Reference the changed row by its **Decision** column name, not by a `§N.M` shorthand.

5. **Bump the amendment log.** At the bottom of the plan, under `## Amendments`, append:

   ```markdown
   - **YYYY-MM-DD** — <one-line summary of change>. Affected phases: <ids>. Branches force-pushed: <branch-list>.
   ```

   Create the section if it doesn't exist. This is the audit trail; preserve every entry.

6. Commit the plan edit on `{{DEFAULT_BRANCH}}` (or wherever the plan file lives — the plan file itself is not branched per phase). Commit message: `Amend plan: <summary>`. {{COMMIT_STYLE_LINE}}.

## Step 2 — Build the rewrite queue

For each phase classified as needing commit rewrites (`body-rewrite` for already-implemented phases, downstream phases for `insert-new` / `body-rewrite` / `guiding-decisions-change`), build a queue ordered by branch stack depth: parent first, children after.

For each entry record:

- `branch`, `base` (parent in the stack — may be `{{DEFAULT_BRANCH}}` or another phase branch).
- `change_kind`: `amend-existing` (modify the phase body's effect on the diff) or `rebase-only` (parent moved, no body change for this phase).
- `commits_to_amend`: list of SHAs the orchestrator may rewrite (look at `git -C <WORKROOT> log <base>..<branch>`).

Phases in `not-started` state are deferred to [implement-plan](../implement-plan/SKILL.md) — not rewritten here.

## Step 3 — Refuse force-pushes that can't work

Before any write to remote, **block on these conditions**:

1. **Phase merged to `{{DEFAULT_BRANCH}}`.** History on `{{DEFAULT_BRANCH}}` is immutable in practice. Tell the user: "Phase X already merged to `{{DEFAULT_BRANCH}}`. The amendment must be a new phase appended to the plan, not a rewrite. Re-run with classification `append-new` and execute via [implement-plan](../implement-plan/SKILL.md)."

2. **Branch's PR was reviewed and approved.** Force-pushing destroys reviewer context. Surface: list approved PRs by URL, ask `AskUserQuestion`:
   - `Proceed — I'll re-request review after force-push`
   - `Stop — too disruptive, redesign as forward phase`

3. **Branch protection rules block force-push.** `gh api repos/{owner}/{repo}/branches/{branch}/protection` (or `glab` equivalent). If the branch is protected, force-push will fail noisily — surface the rule, stop.

4. **Multiple authors on the branch.** `git -C <WORKROOT> log --pretty=format:%ae <base>..<branch> | sort -u | wc -l` > 1 → other developers committed too. Force-push erases their local state. Surface, require explicit `Yes, I've coordinated with <names>` confirmation.

If any block triggers and the user can't dismiss it: stop. Don't proceed further. Tell the user the rewrite path is unavailable; suggest an `append-new` phase as the fallback.

## Step 4 — Per-phase rewrite loop

For each entry in the rewrite queue, in stack order:

### 4a. Check out the branch

```bash
git -C <WORKROOT> fetch origin
git -C <WORKROOT> checkout {branch}
git -C <WORKROOT> reset --hard origin/{branch}
```

### 4b. For `change_kind = amend-existing` only — apply the body change

Spawn an implementer subagent. The prompt mirrors [implement-phase](../implement-phase/SKILL.md#1-compose-the-agent-prompt-token-efficient) but records the change differently (new commit on top by default, never a push). Compose:

```
You are amending {phase.id}: {phase.title} of plan {plan.id}.

## Repo
{{PROJECT_NAME}} ({{STACK_SUMMARY}}).

## Working location
Work inside `<WORKROOT>`. `cd` into it before any command.

## Read first
1. AGENTS.md — repo conventions.
2. {{PLAN_DIR}}/{plan-filename}, the **Goals + Non-goals**, **Guiding Decisions**, and **Data Model Changes** sections, plus the rewritten phase body inside **Phased Rollout**.
3. The current diff: `git -C <WORKROOT> diff {base}...HEAD` — what's already on this branch.

## What changed in the plan (verbatim)
{Diff between old phase body and new — produce via `diff <(old-body) <(new-body)`. Or, if the plan was rewritten in place, the new body verbatim with a note "this replaces what was here before".}

## Your task
Bring the diff on this branch into compliance with the new phase body. You may:
- Edit existing files this branch already modified.
- Add new files when the new body requires them.
- Remove files this branch added that the new body no longer needs.

## How to record the change
Default: ADD A NEW COMMIT on top of the existing branch. Title: "Amend phase {phase.id}: <summary>". This preserves the original implementation as a separate commit and makes the amendment auditable in `git log`.

Use `git commit --amend` ONLY when:
- The branch has exactly one commit, AND
- The amendment is small (≤30% of the original diff size), AND
- The user explicitly authorized amend in Step 0.

{{DEPENDENCY_LICENSE_BLOCK}}
```

Then splice in the shared inner/outer verification loop verbatim:

<!-- include: partials/implementer-prompt.md#INNER_OUTER_LOOP -->

…and close the prompt with the amend-specific staging tail:

```
7. Stage explicitly: `git add {{STAGE_PATTERN}}`.
8. Commit. {{COMMIT_STYLE_LINE}}.
9. {{COAUTHOR_INSTRUCTION_LINE}}
10. **Do NOT push. Do NOT force-push.** The orchestrator owns the remote.

## Required output
- Status: SUCCESS or FAILURE.
- New commit SHA(s) added (or amended SHA).
- 5–15 line summary.
- Deviations from new body + reasoning.
```

For `change_kind = rebase-only` (downstream phase whose parent moved): skip the agent. The work is purely git topology.

### 4c. Run the three-layer review

Invoke [review-phase](../review-phase/SKILL.md) against the rewritten branch, passing the **new** phase body to walk against, `WORKROOT`, and the `reviewer` / `fixer` agent types with their `agent_models` tiers plus this phase's `reviewer_model_tier` / `fixer_model_tier` overrides (parsed from the rewritten body's `**Review models**:` line, null when absent). Layer 2 walks: every "Changes" item in the new body, every "Tests" entry, the new acceptance line.

Skip this step only when `change_kind = rebase-only` (no body change → no compliance walk). Even then, spot-run review-phase's Layer 1 mechanical checks to verify the rebase didn't lose unrelated work.

### 4d. Rebase onto the (possibly-rewritten) parent

```bash
# parent's tip may have moved if it was rewritten earlier in the queue.
git -C <WORKROOT> fetch origin
PARENT_TIP=$(git -C <WORKROOT> rev-parse origin/{base})
git -C <WORKROOT> rebase $PARENT_TIP
```

Conflicts:

1. **Spawn a fixer subagent** with the conflict body + new phase body + parent's tip diff. Same fixer agent type as [review-phase](../review-phase/SKILL.md#fix-loop).
2. Fixer resolves, runs inner + outer gate (in `<WORKROOT>`).
3. Orchestrator continues the rebase: `git -C <WORKROOT> rebase --continue`.

Repeat until the rebase finishes clean. If the fixer can't resolve after one retry → stop. Surface to user; do not push a half-rebased branch.

### 4e. Force-push (with confirmation)

`AskUserQuestion`:

- `Force-push <branch> now (was authorized in Step 0)`
- `Pause — let me look at the local state first`

On confirm:

```bash
git -C <WORKROOT> push --force-with-lease origin {branch}
```

**Use `--force-with-lease`, not `--force`.** It refuses to overwrite if the remote moved since the last fetch — protects against another developer's pushes the orchestrator didn't see.

If `--force-with-lease` rejects: another developer pushed. Stop. Re-fetch, re-apply, re-confirm.

### 4f. Refresh the PR-context file (when present)

For the rewritten branch, look for `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md`:

- **File missing** — skip; nothing to refresh.
- **File `status: pending`** — rewrite the file to reflect new title / description / comments per the [prs-context-template](../../prs-context-template.md). Status stays `pending`. The user will publish later via [open-pr-from-context](../open-pr-from-context/SKILL.md).
- **File `status: published`** — the existing PR is auto-updated by the force-push (GitHub/GitLab pick up the new tip). But:
  - Inline comments may now reference SHAs that no longer exist. They'll appear as "outdated" in the PR UI.
  - If the new diff has materially different comment-worthy spots, regenerate the `# Comments` block, set `status: pending`, and re-run [open-pr.sh](../open-pr-from-context/scripts/open-pr.sh) on the file. The script reuses the existing PR, posts new comments. Old "outdated" comments stay visible in the PR for audit; that's the platform's behavior.

When rewriting the `# Description` body, **honor `project.pr_template_paths`** from `.vinta-ai-workflows.yaml` — same rule as [integrate-phase]({{INTEGRATE_PHASE_LINK}})'s **Open PR via context file** step: follow the project's PR template structure, fill new sections with phase-specific content from the rewritten body, leave un-fillable placeholders untouched. If the prior file used a different template than the project now declares, prefer the current `pr_template_paths` choice — surface the change to the user when the body shape shifts visibly.

Always include in the publish-log block at the bottom of the file:

```markdown
- YYYY-MM-DDThh:mm:ssZ — branch force-pushed (amend-plan); old SHA <x>, new SHA <y>
```

### 4g. Update tracking file

Update `{{PLAN_DIR}}/TRACKING_{plan-id}.md` for the rewritten phase:
- Append to its `Completed Phases` entry: `Amended YYYY-MM-DD: <summary>; new SHA <x>; force-pushed`.
- Don't remove the original summary — keep history.

## Step 5 — Final report

After every queue entry processes:

1. Print a per-branch summary:

   ```
   plan/{plan-id-kebab}/phase-1   amended  (commits added: 1; force-pushed)
   plan/{plan-id-kebab}/phase-2   rebased  (no body change; force-pushed)
   plan/{plan-id-kebab}/phase-3   rebased  (no body change; force-pushed)
   plan/{plan-id-kebab}/phase-4   pending  (not yet implemented; will use new parent next implement-plan run)
   ```

2. List any PR-context files now at `status: pending` that need re-publishing.
3. List any phases blocked from rewrite (Step 3 refusals) with the recommended forward path.
4. Reminder: reviewers on existing PRs need a re-review request — force-push erases context. Send a short comment on each affected PR (the orchestrator can do this via the PR CLI if the project's PR policy = "agents create PRs"; otherwise hand off to the human).

## Important rules

- **Never `--force`. Always `--force-with-lease`.** Protects against silent overwrites.
- **Plan file edit is the first write.** Commit the new plan body before any branch rewrite. The plan is the contract; the branches are the artifact.
- **Recommend restart when blast radius is high.** The blast-radius step inside Step 0 evaluates signals; ≥2 tripping signals → surface a restart option to the user before any force-push plan is shown. Don't quietly amend a half-rewrite of the whole plan.
- **Never use `§N` shorthand to point at sections** — neither in this skill body, the rewritten plan body, the amendment log entry, nor any prs-context refresh. Always use the section's full name (and link when possible).
- **Phases merged to `{{DEFAULT_BRANCH}}` are immutable.** Convert to `append-new` phases. Refuse to attempt rewrites.
- **Confirm every force-push individually.** No batch "confirm all".
- **`WORKROOT` is resolved once, used everywhere.** Every `git` call takes `git -C <WORKROOT>`; no per-step worktree branching.
- **Three-layer review on every rewritten branch.** Same standard as [implement-plan](../implement-plan/SKILL.md) — via [review-phase](../review-phase/SKILL.md). The amendment isn't done until Layer 3 passes.
- **PR-context file is a derived artifact.** Refresh it after the rewrite; never edit the file as a substitute for fixing the diff.
- **Subagents commit but never push.** Orchestrator owns force-push. {{PR_RULE_TAIL}}.
{{COAUTHOR_RULE_LINE}}
{{DEPENDENCY_LICENSE_RULE_LINE}}
- **Stop on Tier-4 failure** (model escalation, same rules as [implement-phase](../implement-phase/SKILL.md#pick-the-model-from-the-plans-per-phase-suggestion)).
- **Stop on rebase failure** the fixer can't resolve in one retry. Don't ship half-rebased branches.

## Quick checklist (orchestrator, per amendment run)

- [ ] User-requested change captured verbatim; classification determined (`body-rewrite` / `insert-new` / `append-new` / `guiding-decisions-change`).
- [ ] Plan parsed; per-phase state map built (state, branch, base, pr_status, merged_to_default); `WORKROOT` resolved from tracking `run_options`.
- [ ] Blast-radius signals computed; `low` → straight to confirmation, `high-blast-radius` / `restart-recommended` → user offered `Restart` / `Amend in place` / `Stop` before the force-push plan is shown.
- [ ] On `Restart` choice: new plan drafted (or hand-off to [plan-feature](../plan-feature/SKILL.md)); old plan annotated `Superseded`; tracking marked; this skill exits.
- [ ] Step 3 refusals surfaced; force-push plan confirmed by user.
- [ ] Plan file edited; amendment log entry appended; committed on `{{DEFAULT_BRANCH}}`.
- [ ] Rewrite queue ordered by stack depth (parent first).
- [ ] For each entry: body change applied (when `amend-existing`); inner + outer gate green.
- [ ] [review-phase](../review-phase/SKILL.md) run on each rewritten branch; BLOCKERs fixed; SHOULD-FIX noted.
- [ ] Rebase onto rewritten parent; conflicts resolved via fixer; tests re-run.
- [ ] `--force-with-lease` push confirmed and executed per branch.
- [ ] PR-context file refreshed (pending or republished).
- [ ] Tracking file updated with amendment notes.
- [ ] Final summary lists every branch state, all `pending` PR-context files, all blocked rewrites with forward-phase suggestions, and a reviewer re-request reminder.
- [ ] If any phase was `append-new`: hand off to [implement-plan](../implement-plan/SKILL.md) for forward execution. This skill does NOT execute new phases.

## What this skill does NOT do

- **Does not execute new (`not-started`) phases.** That's [implement-plan](../implement-plan/SKILL.md)'s job. Edit the plan, then hand off.
- **Does not rewrite history on `{{DEFAULT_BRANCH}}`.** Refuses up front.
- **Does not auto-bypass branch protection.** Surface the rule, stop.
- **Does not amend commits made by humans on the branch unless explicitly authorized.** Multi-author branches require explicit confirmation.
- **Does not delete the plan file or its branches** even when an amendment makes some phases obsolete. Mark obsolete phases in the plan body with `**Superseded YYYY-MM-DD by phase {new-id}**`; leave their branches alone (or let the user delete manually).
