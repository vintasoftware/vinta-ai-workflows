# `plan-execution/` — shell templates + shared partials

Source-of-truth fragments for the **plan-execution skill family** that
`vinta-derive-skills` renders into a target project's `ai-tools/skills/`:

- `implement-plan` (conductor) — parse → classify → build the dependency graph → resolve a `WORKROOT` per lane → scheduler loop (several phases at a time) → wave integration → track → report.
- `implement-phase` — compose prompt + pick model + spawn implementer (one phase).
- `review-phase` — three-layer review + fix loop (shared by all three conductors).
- `integrate-phase` — push + open PR via context file (commit-strategy-resolved).
- `amend-plan` (conductor) — history-rewriting topology; reuses `review-phase` + the implementer-prompt partial.

## Layout

```
plan-execution/
├─ shell/       one *-template.md per rendered SKILL.md (thin; mostly includes)
└─ partials/    shared bodies authored once, included by multiple shells
```

## Assembly mechanism (executed by the `vinta-derive-skills` agent)

Each shell carries include directives. The derive-skills agent, per skill:

1. **Expand includes.**
   - `<!-- include: partials/<file>.md -->` — splice the whole partial body in place of the marker.
   - `<!-- include: partials/<file>.md#BLOCK -->` — splice only the block between `<!-- block-begin: BLOCK -->` and `<!-- block-end: BLOCK -->` inside that partial (markers themselves excluded).
2. **Substitute `{{PLACEHOLDER}}`** using the inventory + Step 0 interview answers (same substitution table as every other Bucket B template — see [../../SKILL.md](../../SKILL.md)).
3. **Write** the assembled, fully-substituted body to `ai-tools/skills/<name>/SKILL.md`.

Partials and shells are **not** `SKILL.md` files, so they legitimately keep `{{...}}` and `<!-- include -->` markers; `validate-skill-md` never walks them. The **shipped** SKILL.md must have every include expanded and every placeholder substituted — validate that before saving.

## The `WORKROOT` seam (why worktree branching is gone)

The conductor resolves three values **once per lane** (see `partials/worktree-seam.md#WORKROOT_RESOLUTION`) and passes them to every sub-skill as data:

| Value | `use_worktree = false` | `use_worktree = true` |
|---|---|---|
| `WORKROOT` | `<main_checkout>` | `<worktree_path>` — this lane's, when a pool is provisioned |
| `BASE_BRANCH` | `{{DEFAULT_BRANCH}}` | `<worktree_branch>` |
| `SANDBOX_TIER` | `none` | `enforced` \| `none` (probed by prepare-worktree, per lane) |

Every `git` / lint / test / build call in every sub-skill uses `git -C <WORKROOT>` **uniformly** — no `if use_worktree` inside them. Only two genuine conditionals remain, each local and data-driven: the `SANDBOX_TIER`-gated spawn wrap in `implement-phase`, and the `WORKROOT != main_checkout`-gated stray-write check in `review-phase`.

## The parallel-lanes seam (`partials/parallel-lanes.md`)

The plan gives every phase a `**Depends on**:` line. The conductor turns those into a DAG and dispatches a phase the moment its dependencies are green and a lane is free. Six blocks:

| Block | Consumed by | What it owns |
|---|---|---|
| `DAG_PARSE` | `implement-plan` Step 0 | graph build, wave derivation, cycle / unknown-id / file-overlap validation |
| `LANE_WORKTREE_POOL` | `implement-plan` Step 0.5 | pool sizing + provisioning, lane reuse + DB reset, teardown; the hard refusal when worktrees are unavailable |
| `LANE_TOPOLOGY` | `implement-plan` (linked, not included, from `integrate-phase`) | per-phase base branch from `depends_on`, `integ-{id}` merge bases, `wave-{N}` integration branches, merge-conflict handling |
| `LANE_SCHEDULER` | `implement-plan` Step 1 | the dispatch loop, tie-breaking, failure containment, the pause gate under concurrency |
| `TRACKING_DIR` | `implement-plan` | the `TRACKING_{plan-id}/` directory + its ownership rules |
| `SIBLING_LANE_ISOLATION` | `worktree-seam.md#STRAY_WRITE_CHECK` → `review-phase` | the stray-write guard extended across sibling lanes |

**Sequential execution is `max_parallel_lanes = 1`**, running the same blocks — there is no separate sequential code path to keep in sync.

**Why tracking is a directory.** Lanes commit on branches that later merge. One shared file would conflict at every wave merge for no reason. `run.md` is conductor-owned, `phase-{id}.md` is written only by the lane that ran that phase, on that phase's own branch — so no two branches ever touch the same path and the merges are clean by construction.
