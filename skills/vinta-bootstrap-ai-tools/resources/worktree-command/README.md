# Generating the project's worktree command

How [vinta-bootstrap-ai-tools](../../SKILL.md) writes a `prepare.sh` / `teardown.sh` pair into a target project. Once written, the pair is the project's `commands.worktree_prepare` / `commands.worktree_teardown`, and `implement-plan` runs it instead of the `prepare-worktree` skill. It runs only when the user answered **`Yes — generate a provisioning script for this project`** to the bootstrap's `prepare-worktree` question.

The point is that provisioning becomes deterministic. The decisions the `prepare-worktree` skill makes on every run (what to copy, what to fork, how to isolate compose) are made **once**, here, with the user, and frozen into a script the team owns, reviews and edits.

## What ships

| Template | Becomes | Contents |
|---|---|---|
| [lib-template.sh](lib-template.sh) | `<dir>/lib.sh` | Resolves the worktree from the `VINTA_WORKTREE_*` environment (or a name given on the command line), plus helpers: `run` (honors `--dry-run`), `clone_dir`, `copy_file`, `set_env`, `forked_db_name`, `require_local_url`, `require_forked_name`, and YAML quoting. |
| [prepare-template.sh](prepare-template.sh) | `<dir>/prepare.sh` | Sanity checks, `git worktree add`, the **PROJECT STEPS** regions, generic compose isolation, the summary YAML, and the report. On failure it removes the half-made worktree. |
| [teardown-template.sh](teardown-template.sh) | `<dir>/teardown.sh` | Refuses a dirty worktree without `--force`, runs the **PROJECT STEPS** regions in reverse, stops compose (never `down -v`), removes the worktree, its branch when that branch holds no commits of its own, and the summary. |
| [gen-compose-worktree-override.sh](../../../vinta-derive-skills/resources/foundation-skills/prepare-worktree/scripts/gen-compose-worktree-override.sh) | `<dir>/gen-compose-worktree-override.sh` | Copied **only when the project uses docker compose**. `prepare.sh` calls it to fork leaky volumes and strip fixed host ports. |

Everything outside the PROJECT STEPS regions is contract plumbing. It is tested in this repo (`tests/worktree-command.test.mjs`), so leave it alone. The regions are where the project lives.

## Steps

### 1. Location

The directory was chosen in the bootstrap interview (the `prepare-worktree` generate follow-up) and is already in `.vinta-ai-workflows.yaml` as the parent of `commands.worktree_prepare`. When this step runs standalone and that key is unset, ask now (header `Script dir`): `scripts/worktree (Recommended)`, `bin/worktree`, plus any existing scripts directory the inventory found. Free text covers other paths.

**Read before write.** If `prepare.sh`, `teardown.sh` or `lib.sh` already exists there, show the first lines of each and ask (header `Overwrite?`): `Pick another directory (Recommended)`, `Overwrite them`, `Stop — keep my scripts and use them as the command`. The last option records the existing files as `commands.worktree_prepare` / `commands.worktree_teardown` and skips generation.

### 2. Render

Copy the three templates (and the compose generator, when compose is in use) and substitute:

| Placeholder | Value |
|---|---|
| `{{WORKTREE_ROOT}}` | `skills.prepare-worktree.worktree_root` (`.claude/worktrees` or `../<repo>-wt-`) |
| `{{DEFAULT_BRANCH}}` | `project.default_branch` |
| `{{SUMMARY_DIR}}` | `skills.prepare-worktree.summary_dir` (default `.vinta-ai-workflows/worktrees`) |
| `{{PROJECT_NAME}}` | `project.name` |
| `{{SCRIPT_DIR}}` | the chosen directory, repo-relative |

Then `chmod +x` all of them. No `{{…}}` may survive in the written files.

### 3. Fill the PROJECT STEPS regions

Each region in `prepare.sh` sits between `# >>> <region>` and `# <<< <region>`, with commented examples. Replace the examples with this project's real commands, and set the state variables at the top of `prepare.sh` that the summary reads. Then write the **matching** inverse region in `teardown.sh`. A prepare step whose teardown is missing leaks state on every lane recycle.

The decisions are the same ones the `prepare-worktree` skill makes. Read [its body](../../../vinta-derive-skills/resources/foundation-skills/prepare-worktree/SKILL.md) for the reasoning; the short version for each region:

| Region | Decide from | Rules that stay non-negotiable |
|---|---|---|
| `deps` | inventory package managers + lockfiles | Every dependency dir is the worktree's own: `clone_dir` it, or reinstall. **Never symlink.** Virtualenvs and yarn PnP always reinstall, because they store absolute paths into main. In a workspace, clone every member's `node_modules`, not only the root's. Set `DEPS_STRATEGY` / `DEPS_PATHS`. |
| `env` | inventory env model (`.env*`, `.envrc`) | `copy_file`, never symlink, because later regions and compose isolation append to it. Set `ENV_FILES`. Never print an env file's contents. |
| `dev_db` | inventory DB engine + how it is delivered | Fork with `forked_db_name`, and call `require_local_url` first, every time. A compose-delivered DB is forked by compose isolation (its volume), so the region only points the env at it. Set `DEV_DB_*`, including `DEV_DB_RESET`: a lane with no reset command cannot be reused across a migration. Add compose DB service names to `LOCAL_DB_HOSTS` in `lib.sh`. |
| `test_db` | inventory test runner | Give the runner its own DB name through the env channel it already reads. Never edit tracked test config. Set `TEST_DB_*` and `TEST_DB_RESET`. |
| `compose` | a compose file in the repo | `USES_COMPOSE=1`. List in `SHARED_VOLUMES` only read-only caches the user confirms, **never** a data volume. Step 4 of `prepare.sh` does the rest generically. |
| `other` | Redis / S3 / queues / search / cron / tunnels in the env model | Per-worktree Redis index or key prefix, `S3_PREFIX=wt-$NAME/`, queue and index suffixes, cron off. Run migrations against the forked DB last. |

Ask the user only about what the inventory cannot settle, through `AskUserQuestion` with the candidates found: which DBs to fork vs stub, which compose volumes are safe to share, whether cron must stay on. Don't ask about anything the table above already decides.

Teardown regions drop only what `prepare.sh` created: call `require_forked_name` before every `dropdb` / `DROP DATABASE`, and make every step tolerate state that is already gone.

### 4. Verify

1. `bash -n` on all three files. Also run `shellcheck` when it is installed.
2. Dry run, and show the user the output:

   ```bash
   <dir>/prepare.sh vinta-smoke --dry-run
   ```

3. Ask (header `Smoke test`): `Dry run is enough (Recommended)`, `Run a real smoke test now`, `Skip`. The real smoke test creates a worktree named `vinta-smoke-<yyyymmdd>`, really forking the local databases the script forks. It then runs the project's lint command inside the worktree and tears it down. When it runs:
   - `prepare.sh` exits 0, and the three conductor checks from the `commands.worktree_prepare` contract hold: the branch, the registered worktree, and main's `git status` unchanged.
   - The summary YAML parses.
   - `teardown.sh` exits 0, and `git worktree list` no longer shows it.

   On failure, show the failing step's output, run `teardown.sh` with the same name, and ask (header `Fix`): `Let me fix the region and retry (Recommended)`, `Keep the scripts as they are — I'll fix them later`, `Drop the scripts — use the prepare-worktree skill instead`. The last option deletes the generated files, and flips `foundation_skills.prepare-worktree` to `enabled` and the two `commands.worktree_*` keys off.

### 5. Record

Set `commands.worktree_prepare: <dir>/prepare.sh` and `commands.worktree_teardown: <dir>/teardown.sh` in `.vinta-ai-workflows.yaml` (Step 0.5 already wrote them from the chosen directory; confirm they match). Tell the user the scripts are theirs to commit and edit, and that `teardown.sh <name>` is also how a human removes a worktree they made by hand with `prepare.sh <name>`.

## Pitfalls

- **Hard-coding the main checkout's path, a branch or a DB name.** Everything per-worktree derives from `$NAME` through `forked_db_name` / `COMPOSE_PROJECT`, so lanes never collide.
- **Writing outside `$WT_PATH`.** The conductor fails provisioning when main's `git status` changes. The only out-of-tree writes allowed are forked databases, compose volumes, and files under the summary dir.
- **Forgetting `run`.** A bare command executes under `--dry-run` too. Wrap pipes and redirections as `run sh -c '…'`.
- **A partial summary.** `prepare.sh` writes every key. When you add state, add it to the variables at the top rather than appending keys to the heredoc.
- **Logging secrets.** Connection strings carry passwords. `require_local_url` never prints the URL; keep it that way in any message you add.
