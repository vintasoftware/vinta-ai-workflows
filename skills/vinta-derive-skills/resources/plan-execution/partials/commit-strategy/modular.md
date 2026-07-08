<!-- Partial: commit-strategy / modular-commits. Folds in the former implement-plan-template-modular-substitutions.md. Blocks consumed by implement-phase (PER_PHASE_COMMIT) + integrate-phase (BRANCH_NAMING, PR_OPEN_TIMING) + conductor (CHECKLIST). All git calls use `git -C <WORKROOT>`; the first executed phase branches off `<BASE_BRANCH>` — both resolved once by the conductor (see worktree-seam.md#WORKROOT_RESOLUTION). The rendering-guidance appendix at the bottom is read by derive-skills to resolve the {{MODULAR_*}} placeholders; it is NOT part of any shipped block. -->

<!-- block-begin: BRANCH_NAMING -->
Branch naming: `plan/{plan-id-kebab}` (one branch for the whole plan — no per-phase suffix).

**First executed phase** (branches from `<BASE_BRANCH>`, already made current by the conductor):

```bash
git -C <WORKROOT> checkout <BASE_BRANCH>
git -C <WORKROOT> checkout -b plan/{plan-id-kebab}
# subagent's atomic unit commits land on this branch
git -C <WORKROOT> push -u origin plan/{plan-id-kebab}
```

**Subsequent phases** (stay on the same plan branch — no new branch):

```bash
git -C <WORKROOT> checkout plan/{plan-id-kebab}
# subagent's atomic unit commits land on this branch
git -C <WORKROOT> push origin plan/{plan-id-kebab}
```

The branch carries every phase's commits in plan order. Reviewers read the commit log top-to-bottom as a table of contents of the implementation.
<!-- block-end: BRANCH_NAMING -->

<!-- block-begin: PER_PHASE_COMMIT -->
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
<!-- block-end: PER_PHASE_COMMIT -->

<!-- block-begin: PR_OPEN_TIMING -->
**PR opens once — after Phase 1 passes review.** Subsequent phases push their atomic unit commits to the same plan branch (`plan/{plan-id-kebab}`); the orchestrator re-runs [open-pr.sh](../open-pr-from-context/scripts/open-pr.sh) against the same plan-level prs-context file at `.vinta-ai-workflows/prs-context/{feature-kebab}/plan.md`. The script is idempotent for already-open PRs — it updates the body, appends new inline comments, and posts a `Phase {N} complete — pushed M commits` PR comment.
<!-- block-end: PR_OPEN_TIMING -->

<!-- block-begin: CHECKLIST -->
- [ ] Commit units listed upfront before any staging.
- [ ] Each commit covers exactly one logical unit (no "and" in commit messages).
- [ ] Tests landed in the same commit as the code they cover (never a separate test-only commit).
- [ ] All unit commits pushed to `plan/{plan-id-kebab}` at end of phase.
<!-- block-end: CHECKLIST -->

<!-- Single-line values (derive-skills substitutes these into the shells directly):
     BRANCH_PUSH_HEADING            = Push to plan branch
     BRANCH_NAMING_PATTERN_SUMMARY  = plan branch (one branch for whole plan: `plan/{plan-id-kebab}`)
     PRS_CONTEXT_FILE_PATH          = a single `.vinta-ai-workflows/prs-context/{feature-kebab}/plan.md` file (one PR per plan, not per phase)
     TRACKING_BRANCH_FIELD          = top-level `plan_branch:` field
     TRACKING_PHASE_BRANCH_FIELD    = (empty — no per-phase branch under modular)
     FINAL_REPORT_BRANCH_SUMMARY    = single plan branch `plan/{plan-id-kebab}` with commit log organized by phase
     BRANCH_CHECKLIST_LINE          = Plan branch updated with phase commits; pushed. -->

<!-- ===================================================================== -->
<!-- rendering-guidance (read by derive-skills; NOT shipped in any block)  -->
<!-- ===================================================================== -->

### Conditional example messages (driven by `policies.commit_style`)

derive-skills resolves the six `{{MODULAR_EXAMPLE_*}}` placeholders + the `{{MODULAR_COMMIT_MESSAGE_FORMAT_BLOCK}}` from this table when rendering the `PER_PHASE_COMMIT` block above:

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
