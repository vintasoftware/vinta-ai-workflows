<!-- Partial: worktree-seam — the WORKROOT abstraction. Collapses the former scattered `if use_worktree` conditionals into one resolution (conductor) + two local, data-driven checks (implement-phase spawn wrap, review-phase stray-write). Blocks: WORKROOT_RESOLUTION (conductors), WORKROOT_TOPOLOGY_RULE (conductors + integrate-phase), SANDBOX_WRAP (implement-phase), STRAY_WRITE_CHECK (review-phase). Under parallel execution `WORKROOT` becomes per-lane — the pool lives in parallel-lanes.md#LANE_WORKTREE_POOL and every downstream step still reads exactly one `WORKROOT`, the one for its own lane. -->

<!-- block-begin: WORKROOT_RESOLUTION -->
## Step 0.5 — Resolve `WORKROOT`

Resolve three values **once per lane**, before any phase runs, and record them in tracking. Every later step uses them as data — no step re-derives worktree state. A sequential run has exactly one lane, so "once per lane" and "once" are the same thing.

| Value | `run_options.use_worktree = false` | `run_options.use_worktree = true` |
|---|---|---|
| `WORKROOT` | the main checkout root (the repo the skill was invoked from) | `<worktree_path>` returned by prepare-worktree — **this lane's** path under parallel execution |
| `BASE_BRANCH` | `{{DEFAULT_BRANCH}}` | `<worktree_branch>` prepare-worktree created |
| `SANDBOX_TIER` | `none` | `enforced` or `none` (probed by prepare-worktree, per lane) |

**When `run_options.parallel_phases = true`:** skip the single-worktree path below entirely and provision the pool per [Provision the lane worktree pool](#provision-the-lane-worktree-pool). That step resolves one `WORKROOT` / `SANDBOX_TIER` per lane plus one integration worktree, and refuses the run outright when worktrees are unavailable. `BASE_BRANCH` stays plan-level (`{{DEFAULT_BRANCH}}`, or the worktree base when the whole plan hangs off one); each phase's *own* base is derived from its dependencies, not from `BASE_BRANCH` — see [Lane branch topology](#lane-branch-topology).

**When `use_worktree = false`:** set `WORKROOT` = main checkout, `BASE_BRANCH = {{DEFAULT_BRANCH}}`, `SANDBOX_TIER = none`. Make `BASE_BRANCH` current + up to date: `git -C <WORKROOT> checkout {{DEFAULT_BRANCH}} && git -C <WORKROOT> pull --ff-only`. Jump to Step 1.

**When `use_worktree = true`:** run [prepare-worktree](../prepare-worktree/SKILL.md) **once**. This is a mechanical step: when `agent_models.worktree_prep` is set, **delegate it to a subagent** per the [Delegate a mechanical step to a configured model](#delegate-a-mechanical-step-to-a-configured-model) pattern (hand the subagent prepare-worktree's SKILL.md + the inputs below; consume its returned `worktree_path` / `worktree_branch` / `worktree_summary` / `sandbox_tier` report). When the tier is unset, run it inline — the steps below read the same either way:

1. **Inputs.** Plan path (so prepare-worktree can read it for deps / migrations / env / compose churn — see prepare-worktree's **Plan inspection** step), suggested worktree name = `plan-{plan-id-kebab}`, plan-driven mode.
2. **Pre-run sanity.** Confirm no existing worktree at the target path (`git worktree list | grep <name>` — refuse if collision). Confirm `git -C <main_checkout> status` of the main checkout (warn if dirty; defer to prepare-worktree's **Sanity checks** step for the call).
3. **Run prepare-worktree.** Pass the plan file + worktree name. It returns:
   - `worktree_path` → `WORKROOT`.
   - `worktree_branch` → `BASE_BRANCH` (prepare-worktree based it on `origin/{{DEFAULT_BRANCH}}`, so it is already current).
   - `worktree_summary` — `.vinta-ai-workflows/worktrees/<name>.yaml` (read by teardown).
   - `sandbox_tier` → `SANDBOX_TIER`: `enforced` (the [Filesystem sandbox](../prepare-worktree/SKILL.md#step-55--filesystem-sandbox-os-level-write-guard) step found `sandbox-exec` / `bwrap` and will OS-block main-checkout writes) or `none` (no sandbox tool — prevention degrades to the review-phase stray-write backstop).
4. **Persist to tracking.** Write `run_options.worktree_path`, `run_options.worktree_branch`, `run_options.worktree_summary`, `run_options.sandbox_tier` into `{{PLAN_DIR}}/TRACKING_{plan-id}/run.md`. All later phases read them — never re-provision mid-plan.
5. **Report to user.** Quote the prepare-worktree summary back: which dirs symlinked vs copied vs forked; which DB(s) forked + their names; compose project name; teardown command. Hold here until the user confirms (`AskUserQuestion`: `Looks good — start phase 1`, `Stop — let me adjust`).

Failure modes:
- **prepare-worktree returns an error** (disk full, branch exists, DB clone failed) → surface to the user; do NOT fall back to "just run in the main checkout" silently — that defeats the opt-in. Ask: `Retry`, `Run in main checkout instead (flip use_worktree to false)`, `Stop`.
- **User cancels at the confirmation gate** → tear the worktree down (run the teardown command from prepare-worktree's report) before exiting, so the next run starts clean.
<!-- block-end: WORKROOT_RESOLUTION -->

<!-- block-begin: WORKROOT_TOPOLOGY_RULE -->
**`WORKROOT` topology rule.** Every phase branches off **its own computed base** — the branch derived from that phase's `**Depends on**:` set, which is `<BASE_BRANCH>` for a phase with no dependencies (see [Lane branch topology](../implement-plan/SKILL.md#lane-branch-topology)) — and **every** `git` / lint / test / build / migrate call runs with `git -C <WORKROOT>` (or after `cd <WORKROOT>`). When `use_worktree = false`, `WORKROOT` is the main checkout and phases run one at a time in place; when `true`, `WORKROOT` is a worktree and branches / commits live inside it, never touching the main checkout's working tree. Under parallel execution `WORKROOT` is **this lane's** worktree and nothing else — a lane never reads or writes a sibling lane's tree. One uniform path — no per-step worktree branching.
<!-- block-end: WORKROOT_TOPOLOGY_RULE -->

<!-- block-begin: SANDBOX_WRAP -->
**Sandbox the spawn — only when `SANDBOX_TIER = enforced`.** The prompt tells the subagent to stay in `WORKROOT`, but that's cooperative — a smaller model can resolve a path back to the main checkout and silently write there (the review-phase stray-write check catches this reactively). When `SANDBOX_TIER = enforced` **and** the runtime spawns subagents as **subprocesses** (it shells out to an agent CLI — e.g. `codex exec …`, a `claude -p …` child, a custom runner), wrap that launch command in the worktree's bundled guard so the OS blocks main-checkout writes regardless of harness:

```bash
ai-tools/skills/prepare-worktree/scripts/sandbox-run.sh \
  --deny  <main_checkout> \
  --deny  <pool_root> \
  --allow <WORKROOT> \
  --allow <main_checkout>/.vinta-ai-workflows \
  --allow <main_checkout>/.git \
  -- <the agent spawn command>
```

`<main_checkout>` is the repo root the skill was invoked from (never `WORKROOT` when a worktree is in use). A stray write then fails with `Operation not permitted` / `EROFS`; the subagent retries against the worktree. `<main_checkout>/.git` must be allowed because git worktrees write commits into the main repo's `.git` (shared objects/refs, `.git/worktrees/<name>/index.lock`); omitting it makes the subagent's own `git commit` fail.

`<pool_root>` is the directory that holds the lane worktrees (the worktree root prepare-worktree provisioned into). Denying it and allowing back only this lane's `WORKROOT` blocks writes into **sibling lanes** — under parallel execution the more dangerous stray write, because a sibling's tree is being edited and tested at that moment. Omit the `--deny <pool_root>` line only when the run has a single lane and no pool exists.

- **In-process subagent runtimes** (orchestrator and subagent share one OS process — e.g. claude-code's Task tool) can't wrap a single spawn. Two options: (a) install a runtime pre-write guard hook scoped to `WORKROOT` (prepare-worktree ships `scripts/claude-worktree-write-guard.py` + `scripts/gen-claude-sandbox-settings.sh` for claude-code); or (b) run the **entire** invocation under `sandbox-run.sh` with the same `--deny` / `--allow` set. Pick whichever the runtime supports.
- **`SANDBOX_TIER = none`** (no sandbox tool, or `use_worktree = false`) → skip wrapping; prevention falls back entirely to the review-phase stray-write check. Surface this once to the user when a worktree run is unsandboxed so the weaker guarantee is explicit.
<!-- block-end: SANDBOX_WRAP -->

<!-- block-begin: STRAY_WRITE_CHECK -->
**Stray main-checkout writes — only when `WORKROOT != <main_checkout>` (i.e. a worktree run).** A subagent told to work inside the worktree can resolve an absolute path back to the **main checkout** and silently edit files there; because worktrees have independent working trees, those edits never reach the phase commit — they sit as uncommitted thrash in the main checkout and read as a silent implementer/fixer failure. **When `SANDBOX_TIER = enforced`, the OS sandbox already blocks these writes and this becomes a cheap backstop (a clean `git status` is the expected result). When `SANDBOX_TIER = none`, it is the *only* defense — run it religiously.** After **every** implementer **and** fixer subagent returns, run:

```bash
git -C <main_checkout> status --short | grep -vE '^\?\?'   # tracked modifications only
```

Any output is a BLOCKER for this phase:
- Diff the stray files (`git -C <main_checkout> diff -- <path>`) to recover intent.
- If the edit belongs in the worktree, re-dispatch the fixer/implementer with an explicit instruction to write to `WORKROOT` (the change is missing from the phase commit until it does).
- Once recovered (or confirmed superseded by the correctly-committed worktree version), discard the stray edits with `git -C <main_checkout> restore -- <path>` so the main checkout returns clean. Never leave the main checkout dirty between phases — a later phase can't tell new thrash from old.

`<main_checkout>` is the repo root the skill was invoked from (NOT `WORKROOT`). When `WORKROOT == <main_checkout>` (`use_worktree = false`), skip this check entirely — your work legitimately lives in that tree.

<!-- include: partials/parallel-lanes.md#SIBLING_LANE_ISOLATION -->
<!-- block-end: STRAY_WRITE_CHECK -->
