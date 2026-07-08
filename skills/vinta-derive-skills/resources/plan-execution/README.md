# `plan-execution/` — shell templates + shared partials

Source-of-truth fragments for the **plan-execution skill family** that
`vinta-derive-skills` renders into a target project's `ai-tools/skills/`:

- `implement-plan` (conductor) — parse → classify → resolve `WORKROOT` → per-phase loop → track → report.
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

The conductor resolves three values **once** (see `partials/worktree-seam.md#WORKROOT_RESOLUTION`) and passes them to every sub-skill as data:

| Value | `use_worktree = false` | `use_worktree = true` |
|---|---|---|
| `WORKROOT` | `<main_checkout>` | `<worktree_path>` |
| `BASE_BRANCH` | `{{DEFAULT_BRANCH}}` | `<worktree_branch>` |
| `SANDBOX_TIER` | `none` | `enforced` \| `none` (probed by prepare-worktree) |

Every `git` / lint / test / build call in every sub-skill uses `git -C <WORKROOT>` **uniformly** — no `if use_worktree` inside them. Only two genuine conditionals remain, each local and data-driven: the `SANDBOX_TIER`-gated spawn wrap in `implement-phase`, and the `WORKROOT != main_checkout`-gated stray-write check in `review-phase`.
