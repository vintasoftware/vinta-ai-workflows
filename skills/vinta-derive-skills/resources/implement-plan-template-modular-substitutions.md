# Modular-commits substitutions for `implement-plan-template.md`

This file holds the substitution bodies for the `{{COMMIT_STRATEGY_*}}` placeholder family when `policies.commit_strategy = modular-commits`. The `stacked-branches` substitutions are inline in the parent placeholder table in [SKILL.md](../SKILL.md). The `ask` variant emits **both** the stacked and the modular bodies gated by inline runtime markers — see [Phase 4 ask-mode substitutions](#ask-mode-substitutions) at the bottom.

Each section below is delimited by `<!-- substitution: {{PLACEHOLDER}} -->` markers so derive-skills can extract the block by name. The block's content is everything between the open and close markers, **excluding** the markers themselves.

## `{{BRANCH_NAMING_BLOCK}}` (modular)

<!-- substitution-begin: BRANCH_NAMING_BLOCK -->
Branch naming: `plan/{plan-id-kebab}` (one branch for the whole plan — no per-phase suffix).

**First executed phase** (branches from `{{DEFAULT_BRANCH}}`):
```bash
git checkout {{DEFAULT_BRANCH}}
git pull --ff-only
git checkout -b plan/{plan-id-kebab}
# subagent's atomic unit commits land on this branch
git push -u origin plan/{plan-id-kebab}
```

**Subsequent phases** (stay on the same plan branch — no new branch):
```bash
git checkout plan/{plan-id-kebab}
# subagent's atomic unit commits land on this branch
git push origin plan/{plan-id-kebab}
```

The branch carries every phase's commits in plan order. Reviewers read the commit log top-to-bottom as a table of contents of the implementation.
<!-- substitution-end: BRANCH_NAMING_BLOCK -->

## `{{PER_PHASE_COMMIT_BLOCK}}` (modular)

<!-- substitution-begin: PER_PHASE_COMMIT_BLOCK -->
7. **Plan commit units before staging.** List the logical units this phase produces (e.g. `3 services + 1 use case update + 1 init export`). Each unit = **one** commit. Tests for that unit travel **in the same commit** as the code they test — never a separate commit.
8. For each unit, in order:
   a. Stage exactly that unit's files: `git add <explicit paths>` (NEVER `git add -A` — {{ANTI_GIT_ADD_ALL_REASON}}). Tests for the unit go in the same `git add`.
   b. Commit with the repo's commit_style — see the **Commit Boundaries** + **Commit Message Format** tables below.
   c. Don't bundle two units in one commit. If the commit message needs the word "and" to cover the diff, **split** — see **Red Flags** below.
9. {{COAUTHOR_INSTRUCTION_LINE}}
10. {{PUSH_INSTRUCTION_LINE}} — push all unit commits at once at end of phase.

### Modular-commits discipline (load-bearing — re-read every phase)

Commit each logical unit independently as you complete it. One service = one commit. One use-case update = one commit. Tests travel with the code they test.

The commit list becomes a **table of contents** for reviewers — they can read the commit titles before touching any code and already understand the shape and sequence of the implementation.

#### Commit Boundaries

| Unit | When to commit | Example commit message |
|------|---------------|------------------------|
| New service | Service + its unit tests complete | {{MODULAR_EXAMPLE_NEW_SERVICE}} |
| Use case update | Use case wires in new services, with integration tests | {{MODULAR_EXAMPLE_USE_CASE}} |
| Init / exports | After exposing new symbols | {{MODULAR_EXAMPLE_INIT}} |
| Serializer field | Field + validation + tests | {{MODULAR_EXAMPLE_SERIALIZER}} |
| Refactor / cleanup | Standalone cleanup pass only | {{MODULAR_EXAMPLE_REFACTOR}} |
| Bug fix | Fix + regression test | {{MODULAR_EXAMPLE_BUGFIX}} |

Tests for a unit belong **in the same commit** as that unit. Never commit tests separately.

#### Commit Message Format

{{MODULAR_COMMIT_MESSAGE_FORMAT_BLOCK}}

#### Red Flags — Split the Commit

- Commit message needs "and" to cover everything in it.
- You are staging files from two different units.
- A reviewer cannot understand the diff without seeing the other commits first.

#### Common Rationalizations

| Rationalization | Reality |
|----------------|---------|
| "I'll commit everything at the end" | Reviewers read commit-by-commit; one giant diff hides intent. |
| "The user can squash later" | Squashing destroys the logical history this discipline exists to preserve. |
| "It's faster to do one commit" | Planning units takes 2 minutes; reviewing a 2000-line blob takes much longer. |
| "The changes are all related" | Related ≠ same unit. Services that depend on each other still get separate commits. |
<!-- substitution-end: PER_PHASE_COMMIT_BLOCK -->

### Conditional example messages (driven by `policies.commit_style`)

derive-skills resolves the six `{{MODULAR_EXAMPLE_*}}` placeholders + the `{{MODULAR_COMMIT_MESSAGE_FORMAT_BLOCK}}` from this table when rendering `{{PER_PHASE_COMMIT_BLOCK}}`:

| Placeholder | `commit_style = conventional` | `commit_style = imperative` | `commit_style = other` |
|---|---|---|---|
| `{{MODULAR_EXAMPLE_NEW_SERVICE}}` | `` `feat(record-copy): add service to copy files between records` `` | `Created service to copy files between records` | both — `` `feat(record-copy): add service to copy files between records` `` (Conventional) or `Created service to copy files between records` (imperative) |
| `{{MODULAR_EXAMPLE_USE_CASE}}` | `` `feat(record-copy): wire optional fields into record copy use case` `` | `Updated record copy use case to call optional fields services` | both |
| `{{MODULAR_EXAMPLE_INIT}}` | `` `chore(record-copy): expose new services in init file` `` | `Updated init file to expose new copy services` | both |
| `{{MODULAR_EXAMPLE_SERIALIZER}}` | `` `feat(record-copy): add copy flag for tags to serializer` `` | `Added copy flag for tags to serializer` | both |
| `{{MODULAR_EXAMPLE_REFACTOR}}` | `` `refactor(record-copy): apply shared batch size to copy services` `` | `Applied batch size constant to all copy services` | both |
| `{{MODULAR_EXAMPLE_BUGFIX}}` | `` `fix(reports): include archived rows in summary section` `` | `Fixed missing archived rows in summary section` | both |
| `{{MODULAR_COMMIT_MESSAGE_FORMAT_BLOCK}}` | the **Conventional Commits** block below | the **Verb-first imperative** block below | both blocks under `### Option A` / `### Option B` headings + a `Pick one style and use it consistently within the plan branch` lead-in |

#### Conventional Commits block (used when `commit_style = conventional` or `other`)

Spec: [conventionalcommits.org](https://www.conventionalcommits.org/en/v1.0.0/)

```
<type>(<scope>): <description>

[optional body: non-obvious why, constraints, or side effects — omit if obvious]
```

| Type | Use for |
|------|---------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code restructuring without behavior change |
| `chore` | Maintenance — init files, exports, config |
| `docs` | Documentation only |

**Scope:** the feature area or module (e.g. `reports`, `record-copy`). Optional but recommended.

**Breaking changes:** append `!` before the colon — `feat(auth)!: replace session tokens`.

```
feat(record-copy): add service to copy files between records
feat(record-copy): add service to copy tags between records
feat(record-copy): wire optional fields into record copy use case
chore(record-copy): expose new services in init file
refactor(record-copy): apply shared batch size to copy services
```

#### Verb-first imperative block (used when `commit_style = imperative` or `other`)

```
<Verb> <what was done> [for/to/between <context>]

[optional body: non-obvious why, constraints, or side effects — omit if obvious]
```

**Preferred verbs:** Created, Updated, Added, Removed, Fixed, Refactored.

```
Created service to copy files between records
Created service to copy tags between records
Updated record copy use case to call optional fields services
Updated init file to expose new copy services
Applied batch size constant to all copy services
```

#### Bad (both styles)

```
WIP
add stuff
Implement full record copy feature   ← too broad, should be split
```

## `{{PR_OPEN_TIMING_BLOCK}}` (modular)

<!-- substitution-begin: PR_OPEN_TIMING_BLOCK -->
**PR opens once — after Phase 1 passes review.** Subsequent phases push their atomic unit commits to the same plan branch (`plan/{plan-id-kebab}`); the orchestrator re-runs [open-pr.sh](../foundation-skills/open-pr-from-context/scripts/open-pr.sh) against the same plan-level prs-context file at `.vinta-ai-workflows/prs-context/{feature-kebab}/plan.md`. The script is idempotent for already-open PRs — it updates the body, appends new inline comments, and posts an `Phase {N} complete — pushed M commits` PR comment.

<!-- substitution-end: PR_OPEN_TIMING_BLOCK -->

## `{{COMMIT_STRATEGY_CHECKLIST_BLOCK}}` (modular)

<!-- substitution-begin: COMMIT_STRATEGY_CHECKLIST_BLOCK -->
- [ ] Commit units listed upfront before any staging.
- [ ] Each commit covers exactly one logical unit (no "and" in commit messages).
- [ ] Tests landed in the same commit as the code they cover (never a separate test-only commit).
- [ ] All unit commits pushed to `plan/{plan-id-kebab}` at end of phase.
<!-- substitution-end: COMMIT_STRATEGY_CHECKLIST_BLOCK -->

## Other modular substitutions (single-line — listed for completeness)

| Placeholder | Modular substitution |
|---|---|
| `{{BRANCH_PUSH_HEADING}}` | `Push to plan branch` |
| `{{BRANCH_NAMING_PATTERN_SUMMARY}}` | ``plan branch (one branch for whole plan: `plan/{plan-id-kebab}`)`` |
| `{{PRS_CONTEXT_FILE_PATH_DESCRIPTION}}` | `` a single `.vinta-ai-workflows/prs-context/{feature-kebab}/plan.md` file (one PR per plan, not per phase) `` |
| `{{TRACKING_BRANCH_FIELD}}` | `top-level \`plan_branch:\` field` |
| `{{TRACKING_PHASE_BRANCH_FIELD}}` | empty string (no per-phase branch under modular) |
| `{{FINAL_REPORT_BRANCH_SUMMARY}}` | ``single plan branch `plan/{plan-id-kebab}` with commit log organized by phase`` |
| `{{BRANCH_CHECKLIST_LINE}}` | `Plan branch updated with phase commits; pushed.` |
| `{{COMMIT_STRATEGY_STEP0_QUESTION}}` | empty string (modular is set as the project default; nothing to ask) |
| `{{COMMIT_STRATEGY_STEP0_TRAILER}}` | empty string |
| `{{COMMIT_STRATEGY_CONFIRM_NOTE}}` | empty string |

## Ask-mode substitutions

When `policies.commit_strategy = ask`, derive-skills renders **both** the stacked-branches and the modular-commits bodies for each multi-line placeholder, gated by inline runtime markers the agent reads at execution time:

```markdown
**If `run_options.commit_strategy_resolved = "modular-commits"`:**

<modular substitution body here>

**Else (`run_options.commit_strategy_resolved = "stacked-branches"`):**

<stacked substitution body here>
```

Single-line placeholders under ask use the same gating pattern but inline (`If modular: <a> · Else (stacked): <b>`).

For the Step 0 question itself (`{{COMMIT_STRATEGY_STEP0_QUESTION}}`), the ask substitution is the AskUserQuestion block documented in the parent placeholder table in [SKILL.md](../SKILL.md) — same content used to populate the resolved value.
