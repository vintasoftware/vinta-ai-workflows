<!-- Partial: commit-strategy / stacked-branches. Blocks consumed by implement-phase (PER_PHASE_COMMIT) + integrate-phase (BRANCH_NAMING, PR_OPEN_TIMING) + conductor (CHECKLIST). All git calls use `git -C <WORKROOT>`; the first executed phase branches off `<BASE_BRANCH>` — both resolved once by the conductor (see worktree-seam.md#WORKROOT_RESOLUTION). -->

<!-- block-begin: BRANCH_NAMING -->
Branch naming: `plan/{plan-id-kebab}/phase-{phase.id}` (one branch + one PR per phase, stacked).

**First executed phase** (branches from `<BASE_BRANCH>`, already made current by the conductor):

```bash
git -C <WORKROOT> checkout <BASE_BRANCH>
git -C <WORKROOT> checkout -b plan/{plan-id-kebab}/phase-{phase.id}
# subagent's commits land on this branch
git -C <WORKROOT> push -u origin plan/{plan-id-kebab}/phase-{phase.id}
```

**Subsequent phases** (stacked on the previous phase's branch):

```bash
git -C <WORKROOT> checkout plan/{plan-id-kebab}/phase-{prev.id}
git -C <WORKROOT> checkout -b plan/{plan-id-kebab}/phase-{phase.id}
git -C <WORKROOT> push -u origin plan/{plan-id-kebab}/phase-{phase.id}
```
<!-- block-end: BRANCH_NAMING -->

<!-- block-begin: PER_PHASE_COMMIT -->
7. Stage the right files (NEVER `git add -A` — {{ANTI_GIT_ADD_ALL_REASON}}). Stage explicitly: `git add {{STAGE_PATTERN}}`.
8. Commit with the repo's style — look at `git log -10 --oneline` first. {{COMMIT_STYLE_LINE}}.
9. {{COAUTHOR_INSTRUCTION_LINE}}
10. {{PUSH_INSTRUCTION_LINE}}
<!-- block-end: PER_PHASE_COMMIT -->

<!-- block-begin: PR_OPEN_TIMING -->
One PR per phase — the [Open PR via context file](#open-pr-via-context-file) step runs after this phase passes review, writing `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md`.
<!-- block-end: PR_OPEN_TIMING -->

<!-- block-begin: CHECKLIST -->
<!-- stacked adds no extra commit-discipline checklist items beyond the branch line -->
<!-- block-end: CHECKLIST -->

<!-- Single-line values (derive-skills substitutes these into the shells directly):
     BRANCH_PUSH_HEADING            = Push stacked branch
     BRANCH_NAMING_PATTERN_SUMMARY  = branch naming pattern (default: `plan/{plan-id-kebab}/phase-{phase-id}`)
     PRS_CONTEXT_FILE_PATH          = `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md`
     TRACKING_BRANCH_FIELD          = (empty — per-phase branch lives inline under TRACKING_PHASE_BRANCH_FIELD)
     TRACKING_PHASE_BRANCH_FIELD    = , branch, base
     FINAL_REPORT_BRANCH_SUMMARY    = branches pushed (with bases, in stack order)
     BRANCH_CHECKLIST_LINE          = Stacked branch created; pushed. -->
