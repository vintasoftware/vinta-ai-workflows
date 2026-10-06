<!-- Partial: worktree-seam — the WORKROOT abstraction. Collapses the former scattered `if use_worktree` conditionals into one resolution (conductor) + two local, data-driven checks (implement-phase spawn wrap, implement-phase stray-write, which review-phase re-runs after each fix round). Blocks: WORKROOT_RESOLUTION (conductors), WORKROOT_TOPOLOGY_RULE (conductors + integrate-phase), SANDBOX_WRAP (implement-phase), STRAY_WRITE_CHECK (implement-phase). Under parallel execution `WORKROOT` becomes per-lane — the pool lives in parallel-lanes.md#LANE_WORKTREE_POOL and every downstream step still reads exactly one `WORKROOT`, the one for its own lane. -->

<!-- block-begin: WORKROOT_RESOLUTION -->
## Step 0.5 — Resolve `WORKROOT`

Resolve three values **once per lane**, before any phase runs, and record them in tracking. Every later step uses them as data — no step re-derives worktree state. A sequential run has exactly one lane, so "once per lane" and "once" are the same thing.

| Value | `run_options.use_worktree = false` | `run_options.use_worktree = true` |
|---|---|---|
| `WORKROOT` | the main checkout root (the repo the skill was invoked from) | `<worktree_path>` returned by the provisioner — **this lane's** path under parallel execution |
| `BASE_BRANCH` | `{{DEFAULT_BRANCH}}` | `<worktree_branch>` the provisioner created |
| `SANDBOX_TIER` | `none` | `enforced` or `none` (probed per lane) |

**Pick the provisioner once.** `.vinta-ai-workflows.yaml` decides how a worktree gets made:

| Config | Provisioner |
|---|---|
| `commands.worktree_prepare` set | **The project's own command** — see [Provisioning with the project's command](#provisioning-with-the-projects-command). It wins even when the skill is also enabled; the skill is then only offered as a fallback when the command fails. |
| `commands.worktree_prepare` unset, `foundation_skills.prepare-worktree: enabled` | **The [prepare-worktree](../prepare-worktree/SKILL.md) skill.** |
| neither | None — worktrees are unavailable, and Step 0 already recorded `use_worktree = false`. |

Record the choice as `run_options.worktree_provisioner: command | skill` in tracking. Both provisioners hand back the same four values (`worktree_path`, `worktree_branch`, `worktree_summary`, `sandbox_tier`), so no later step checks which one ran.

**When `run_options.parallel_phases = true`:** skip the single-worktree path below entirely and provision the pool per [Provision the lane worktree pool](#provision-the-lane-worktree-pool). That step resolves one `WORKROOT` / `SANDBOX_TIER` per lane plus one integration worktree, and refuses the run outright when worktrees are unavailable. `BASE_BRANCH` stays plan-level (`{{DEFAULT_BRANCH}}`, or the worktree base when the whole plan hangs off one); each phase's *own* base is derived from its dependencies, not from `BASE_BRANCH` — see [Lane branch topology](#lane-branch-topology).

**When `use_worktree = false`:** set `WORKROOT` = main checkout, `BASE_BRANCH = {{DEFAULT_BRANCH}}`, `SANDBOX_TIER = none`. Make `BASE_BRANCH` current + up to date: `git -C <WORKROOT> checkout {{DEFAULT_BRANCH}} && git -C <WORKROOT> pull --ff-only`. Jump to Step 1.

**When `use_worktree = true`:** provision **once**, with the provisioner picked above.

- **Skill.** This is a mechanical step: when `agent_models.worktree_prep` is set, **delegate it to a subagent** per the [Delegate a mechanical step to a configured model](#delegate-a-mechanical-step-to-a-configured-model) pattern (hand the subagent prepare-worktree's SKILL.md + the inputs below; consume its returned `worktree_path` / `worktree_branch` / `worktree_summary` / `sandbox_tier` report). When the tier is unset, run it inline.
- **Command.** Run it inline, always. It is a shell command, so there is nothing for a model to do, and `agent_models.worktree_prep` is ignored.

The steps below read the same either way:

1. **Inputs.** Plan path (so the provisioner can read it for deps / migrations / env / compose churn — see prepare-worktree's **Plan inspection** step), suggested worktree name = `plan-{plan-id-kebab}`, plan-driven mode. The command receives these as `VINTA_*` environment variables.
2. **Pre-run sanity.** Confirm no existing worktree at the target path (`git worktree list | grep <name>` — refuse if collision). Confirm `git -C <main_checkout> status` of the main checkout (warn if dirty; with the skill, defer to prepare-worktree's **Sanity checks** step for the call).
3. **Run the provisioner.** The skill gets the plan file + worktree name; the command gets [its contract](#provisioning-with-the-projects-command). Either one yields:
   - `worktree_path` → `WORKROOT`.
   - `worktree_branch` → `BASE_BRANCH` (based on `origin/{{DEFAULT_BRANCH}}`, so it is already current).
   - `worktree_summary` — `<summary_dir>/<name>.yaml` (read by teardown and lane reset). `null` when the project's command wrote none.
   - `sandbox_tier` → `SANDBOX_TIER`: `enforced` (`sandbox-exec` / `bwrap` was found and the [Filesystem sandbox](../prepare-worktree/SKILL.md#step-55--filesystem-sandbox-os-level-write-guard) wrapper will OS-block main-checkout writes) or `none` (no sandbox tool — prevention degrades to the review-phase stray-write backstop).
4. **Persist to tracking.** Write `run_options.worktree_provisioner`, `run_options.worktree_path`, `run_options.worktree_branch`, `run_options.worktree_summary`, `run_options.sandbox_tier` into `{{PLAN_DIR}}/TRACKING_{plan-id}/run.md`. All later phases read them — never re-provision mid-plan.
5. **Report to user.** With the skill, quote its summary back: which dirs copied vs reinstalled vs forked (dependency dirs are always copied or reinstalled, never symlinked); which DB(s) forked + their names; compose project name; teardown command. With the command, quote the last ~20 lines of its output, the summary YAML when it wrote one, and the teardown command. Hold here until the user confirms (`AskUserQuestion`: `Looks good — start phase 1 (Recommended)`, `Stop — let me adjust`).

Failure modes:
- **The provisioner fails** (disk full, branch exists, DB clone failed, the command exited non-zero or failed its post-checks) → surface to the user; do NOT fall back to "just run in the main checkout" silently — that defeats the opt-in. Ask via `AskUserQuestion` (header `Worktree`), quoting the error line: `Retry (Recommended)`, `Run in main checkout instead (flip use_worktree to false)`, `Stop`. When the failed provisioner was the command **and** `foundation_skills.prepare-worktree` is `enabled`, add `Provision with the prepare-worktree skill instead` as the second option. Before a retry or the skill fallback, tear down whatever the command left behind (see [Teardown with the project's command](#teardown-with-the-projects-command)).
- **User cancels at the confirmation gate** → tear the worktree down (the skill's reported teardown command, or [the command teardown](#teardown-with-the-projects-command)) before exiting, so the next run starts clean.

### Provisioning with the project's command

`commands.worktree_prepare` is a shell command the team owns. The conductor runs it once per worktree, from `<main_checkout>`, with stdin closed, through `sh -c '<commands.worktree_prepare>'`, and with these variables set in its environment:

| Variable | Value |
|---|---|
| `VINTA_WORKTREE_NAME` | The worktree name: `plan-{plan-id-kebab}` for a single worktree, or the lane / integration name from the [pool step](#provision-the-lane-worktree-pool). Distinct per worktree, so the command should derive every DB name, compose project name, cache key and port from it. |
| `VINTA_WORKTREE_PATH` | Absolute path to create the worktree at: `skills.prepare-worktree.worktree_root` (default `.claude/worktrees`) resolved against `<main_checkout>`, then `/<name>`. A root that ends in `-` (the `../<repo>-wt-` sibling convention) takes `<name>` with no slash. |
| `VINTA_WORKTREE_BRANCH` | The new branch to create: `plan/{plan-id-kebab}/wt` for a single worktree, `plan/{plan-id-kebab}/wt-<name>` for a pool lane or the integration worktree. Phase branches are cut inside the worktree later. |
| `VINTA_WORKTREE_BASE_REF` | `origin/{{DEFAULT_BRANCH}}`. |
| `VINTA_WORKTREE_KIND` | `single`, `lane` or `integration`. |
| `VINTA_MAIN_CHECKOUT` | Absolute path of `<main_checkout>`. |
| `VINTA_PLAN_PATH` | Absolute path of the plan file. |
| `VINTA_WORKTREE_SUMMARY` | Absolute path `<main_checkout>/<summary_dir>/<name>.yaml` (`summary_dir` from `skills.prepare-worktree.summary_dir`, default `.vinta-ai-workflows/worktrees`). |

**The command must:**

- Create a git worktree at `VINTA_WORKTREE_PATH`, on a new branch `VINTA_WORKTREE_BRANCH` based on `VINTA_WORKTREE_BASE_REF`. Fetching first is its call.
- Leave it runnable. The project's lint, test, build and migrate commands must work inside it without sharing writable state with the main checkout or with another worktree: its own dependency dirs, env files, databases and compose project, whatever the project needs.
- Exit non-zero on any failure. Never report success for a half-made worktree.
- Never write to the main checkout's tracked files, and never prompt for input.
- Succeed when run again for the same name after its teardown ran. Re-provisioning a lane depends on this.

**The command may** write a summary YAML at `VINTA_WORKTREE_SUMMARY`. If it does, the file must follow the summary shape in prepare-worktree's [Write the summary file](../prepare-worktree/SKILL.md#step-6--write-the-summary-file) step in full: every key present, `null` for "none", and only the listed values for each closed set. Other tools parse this file, so a partial summary is worse than none. When the skill is not installed, the shape is documented in the [vinta-ai-workflows source](https://github.com/vintasoftware/vinta-ai-workflows/blob/main/skills/vinta-derive-skills/resources/foundation-skills/prepare-worktree/SKILL.md#step-6--write-the-summary-file). The conductor reads `state.dev_db.reset_cmd` / `state.test_db.reset_cmd` from it for lane reuse. Without a summary, the lane has no reset command, and the [lane reset](#re-orienting-a-member-after-the-reset) re-provisions it instead of reusing it across a migration boundary.

**Check the result. Never trust the exit code alone.** Capture `git -C <main_checkout> status --short` before the command runs; after it exits 0, all three checks must hold:

```bash
git -C "$VINTA_WORKTREE_PATH" rev-parse --abbrev-ref HEAD                       # prints $VINTA_WORKTREE_BRANCH
wt_real="$(cd "$VINTA_WORKTREE_PATH" && pwd -P)"                                # git lists resolved paths
git -C <main_checkout> worktree list --porcelain | grep -Fx "worktree $wt_real"
git -C <main_checkout> status --short                                           # identical to the capture taken before the command
```

If any check fails, the provisioning failed; handle it with the failure modes above. Fill the four values:

- `worktree_path` = `VINTA_WORKTREE_PATH`; `worktree_branch` = `VINTA_WORKTREE_BRANCH`.
- `worktree_summary` = `VINTA_WORKTREE_SUMMARY` when the file exists, else `null`.
- `sandbox_tier`: probe it yourself, because the sandbox governs how agents are spawned, not how the worktree was made. It is `enforced` when `ai-tools/skills/prepare-worktree/scripts/sandbox-run.sh` exists in the main checkout **and** `sandbox-exec` (macOS) or `bwrap` (Linux) is on `PATH`. Otherwise it is `none`. With the skill disabled, the sandbox scripts are not installed, so the tier is `none` and the review-phase stray-write check is the only guard. Say so once in the report.

**Pools run the command one lane at a time.** The command runs `git worktree add` itself, and concurrent adds against one repository corrupt `.git/worktrees/`. The skill path can overlap the expensive per-lane work. The command path cannot, because the add and the rest of the work happen inside one opaque command.

### Teardown with the project's command

Run `commands.worktree_teardown` from `<main_checkout>` with the same `VINTA_*` environment the worktree was provisioned with. When it is unset, teardown is `git -C <main_checkout> worktree remove <worktree_path>`. That removes only the checkout, so say in the report that anything the prepare command created outside it (forked DBs, compose volumes) is left behind.

**Re-provisioning a lane** runs teardown, then the prepare command with the same `VINTA_WORKTREE_NAME` and `VINTA_WORKTREE_PATH` and a fresh `VINTA_WORKTREE_BRANCH` (`<branch>-r<n>`): the old branch outlives `git worktree remove`, and `git worktree add -b` refuses an existing branch.

The final report prints each worktree's teardown as one ready-to-run line, with the environment inline:

```bash
VINTA_WORKTREE_NAME=<name> VINTA_WORKTREE_PATH=<path> VINTA_WORKTREE_BRANCH=<branch> VINTA_WORKTREE_KIND=<kind> VINTA_MAIN_CHECKOUT=<main_checkout> VINTA_PLAN_PATH=<plan> VINTA_WORKTREE_SUMMARY=<summary> sh -c '<commands.worktree_teardown>'
```
<!-- block-end: WORKROOT_RESOLUTION -->

<!-- block-begin: WORKROOT_TOPOLOGY_RULE -->
**`WORKROOT` topology rule.** Every phase branches off **its own computed base** — the branch derived from that phase's `**Depends on**:` set, which is `<BASE_BRANCH>` for a phase with no dependencies (see [Lane branch topology](../implement-plan/SKILL.md#lane-branch-topology)) — and **every** `git` / lint / test / build / migrate call runs with `git -C <WORKROOT>` (or after `cd <WORKROOT>`). When `use_worktree = false`, `WORKROOT` is the main checkout and phases run one at a time in place; when `true`, `WORKROOT` is a worktree and branches / commits live inside it, never touching the main checkout's working tree. Under parallel execution `WORKROOT` is **this lane's** worktree and nothing else — a lane never reads or writes a sibling lane's tree. One uniform path — no per-step worktree branching.
<!-- block-end: WORKROOT_TOPOLOGY_RULE -->

<!-- block-begin: SANDBOX_WRAP -->
**Sandbox the spawn — only when `SANDBOX_TIER = enforced`.** The prompt tells the subagent to stay in `WORKROOT`, but that's cooperative — a smaller model can resolve a path back to the main checkout and silently write there (the implement-phase stray-write check catches this reactively). When `SANDBOX_TIER = enforced` **and** the runtime spawns subagents as **subprocesses** (it shells out to an agent CLI — e.g. `codex exec …`, a `claude -p …` child, a custom runner), wrap that launch command in the worktree's bundled guard so the OS blocks main-checkout writes regardless of harness:

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
- **`SANDBOX_TIER = none`** (no sandbox tool, or `use_worktree = false`) → skip wrapping; prevention falls back entirely to the implement-phase stray-write check. Surface this once to the user when a worktree run is unsandboxed so the weaker guarantee is explicit.
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
