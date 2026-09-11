<!-- Partial: commit-strategy / stacked-branches. Blocks consumed by implement-phase (PER_PHASE_COMMIT) + integrate-phase (BRANCH_NAMING, PR_OPEN_TIMING) + conductor (CHECKLIST). All git calls use `git -C <WORKROOT>`; each phase branches off its own dependency-derived `<phase.base_branch>` — all resolved by the conductor (see worktree-seam.md#WORKROOT_RESOLUTION + parallel-lanes.md#LANE_TOPOLOGY). -->

<!-- block-begin: BRANCH_NAMING -->
Branch naming: `plan/{plan-id-kebab}/phase-{phase.id}` (one branch + one PR per phase, stacked on its **dependencies** rather than on plan order).

Each phase branches from `<phase.base_branch>` — the branch the conductor computed from that phase's `**Depends on**:` set (see [Lane branch topology](../implement-plan/SKILL.md#lane-branch-topology)): `<BASE_BRANCH>` for a phase with no dependencies, the single dependency's phase branch for one, `plan/{plan-id-kebab}/integ-{phase.id}` for several. The conductor creates the branch when it assigns the phase to a lane:

```bash
git -C <WORKROOT> checkout <phase.base_branch>
git -C <WORKROOT> checkout -b plan/{plan-id-kebab}/phase-{phase.id}
# subagent's commits land on this branch
git -C <WORKROOT> push -u origin plan/{plan-id-kebab}/phase-{phase.id}
```

A chain-shaped plan reproduces the classic stack exactly — each phase depends on the one before it, so `<phase.base_branch>` *is* the previous phase's branch. A plan with independent phases produces several stacks rooted at `<BASE_BRANCH>`, reunited by the wave integration branches.

**PR base per phase** (the `base` field written into the prs-context frontmatter — this is what `gh pr create --base` / `glab mr create --target-branch` opens the PR against; getting it wrong makes the PR diff include every upstream phase and the review unusable):

- `base = <phase.base_branch>`, always. Never `<BASE_BRANCH>` for a phase that has dependencies.
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
- [ ] Phase branch created from `<phase.base_branch>` (dependency-derived), not from plan order.
- [ ] PR `base` in the prs-context frontmatter equals `<phase.base_branch>`.
<!-- block-end: CHECKLIST -->

<!-- Single-line values (derive-skills substitutes these into the shells directly):
     BRANCH_PUSH_HEADING            = Push stacked branch
     BRANCH_NAMING_PATTERN_SUMMARY  = branch naming pattern (default: `plan/{plan-id-kebab}/phase-{phase-id}`, each based on its dependencies; wave integration branches `plan/{plan-id-kebab}/wave-{N}`)
     PRS_CONTEXT_FILE_PATH          = `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md`
     TRACKING_BRANCH_FIELD          = (empty — per-phase branch lives inline under TRACKING_PHASE_BRANCH_FIELD)
     TRACKING_PHASE_BRANCH_FIELD    = , branch, base
     FINAL_REPORT_BRANCH_SUMMARY    = branches pushed (with bases, grouped by wave)
     BRANCH_CHECKLIST_LINE          = Phase branch created from its dependency-derived base; pushed. -->
