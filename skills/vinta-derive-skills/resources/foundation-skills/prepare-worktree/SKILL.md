---
name: prepare-worktree
description: Provision a fully-runnable git worktree for parallel feature work so a long-running plan (or experiment) can build, test, lint, run migrations, and hit databases without disturbing the main checkout — or other parallel worktrees. Reads the active plan (when given one) plus the project's `.gitignore`, package manifests, env templates, and docker config to decide what to symlink, what to copy, what to fork (DBs, env files, compose project names, test databases, sandboxes). Use when the user says "set up a worktree for plan X", "create an isolated env for this feature", "I want to run two plans in parallel without breaking the main checkout", or when [implement-plan](../implement-plan/SKILL.md) opts in via Step 0 question (c). NOT for one-off branch switches that don't need a separate runnable copy of the app.
---

# Prepare worktree

Provision a git worktree the agent (or human) can `cd` into and immediately `lint` / `test` / `build` / `migrate` / `run` against — without touching the main checkout, and without colliding with any other live worktree on the same machine.

A bare `git worktree add` is not enough. The runnable parts of any non-trivial app live in *ignored* files and dirs (`node_modules/`, `.env*`, `venv/`, `vendor/`, local SQLite DBs, `.localstack/`, `docker-compose.override.yml`, etc.). This skill walks those ignored paths and decides, per-path:

- **Symlink** — when the file/dir is read-only-ish from the feature's perspective (dep install with no new deps, a frozen `.envrc`, a static fixture set).
- **Copy** — when the feature mutates it (`node_modules/` for a `pnpm add`, `.env` for a new var, the migrations dir).
- **Fork** — when sharing would corrupt the main checkout's state (`db.sqlite3`, a local Postgres DB used by tests, a docker-compose project name).

The output is a worktree that is the **same shape as the main checkout** from the perspective of every dev command in the project, plus a short summary file recording every fork decision so teardown is mechanical.

## When to use

- A plan / spec that takes hours-to-days where parallel work in the main checkout would be disruptive (a long migration, a refactor, a feature you want to experiment on while still serving customer support out of `main`).
- Two-or-more concurrent plans where each needs its own running app + own DB state.
- A risky migration where the user wants the migration to run against a forked DB, then walk the diff before promoting.
- [implement-plan](../implement-plan/SKILL.md) Step 0 (c) — when the user opts in, that orchestrator runs this skill once before phase 1, captures the resulting path, and threads it through every subagent's prompt.

## When NOT to use

- A small branch switch with no dep churn / no DB writes — `git switch -c …` is enough.
- The project has no ignored runnable state (rare — usually means the project is so simple a worktree adds friction with no upside).
- The user is on a filesystem that doesn't support symlinks (Windows non-NTFS volumes, some corporate fileshares). Fall back to copy-only and warn the user up front.

## Inputs (Step 0 — interview)

Use `AskUserQuestion` for every finite-choice question. Open prose only when the answer is genuinely free-form.

### 0.1 — Scope of the worktree

1. **Plan-driven or freeform?** `AskUserQuestion`:
   - `Plan-driven — point me at a plan file` → ask for path; read it in the **Plan inspection** step below.
   - `Freeform — just isolate the env, no plan to consult` → skip **Plan inspection**; default every "does the feature do X?" question to "unsure → fork to be safe".

2. **Worktree name** (used as the dir name + as the suffix appended to DB names / docker project names). Default = kebab(plan's feature name) when plan-driven; else ask the user.

3. **Worktree root**. Default = `.claude/worktrees/<name>/` when the runtime (claude-code, codex) writes worktrees there; else `../<repo-name>-wt-<name>/` (a sibling dir of the main checkout, so relative-path tooling that walks up keeps working). Read `.vinta-ai-workflows.yaml` → `run_options.prepare-worktree.worktree_root` for a project override.

### 0.2 — Plan inspection (when plan-driven)

Read the plan once and extract (don't ask the user to repeat what's already written):

- **New dependencies?** Scan the plan's **Data Model Changes**, **Phased Rollout**, and **Guiding Decisions** sections for `pnpm add`, `npm install`, `pip install`, `poetry add`, `cargo add`, `go get`, `Gemfile` edits. If yes → record `deps_change: true`. Drives the `node_modules` / `vendor/` / `venv/` decision in the **Inventory ignored runnable state** step.
- **Migrations / data-model changes?** Look at the plan's **Data Model Changes** section, plus `alembic`, `manage.py makemigrations`, `prisma migrate`, `knex migrate`, `goose`, `sqlx migrate`, schema files (`.sql`, `schema.prisma`, `models.py`). If yes → record `schema_change: true`. Drives the DB fork decision in the **Database fork** step.
- **New env vars?** Look for `process.env.<NEW>`, `os.environ['<NEW>']`, `.env.example` edits, `config.<new>` reads. If yes → record `env_change: true`. Drives the `.env` copy-vs-symlink decision in the **Inventory ignored runnable state** step.
- **Touches test infra?** New fixtures, factories, seed scripts, a custom `pytest` plugin, a new `vitest` setup file. If yes → record `test_infra_change: true`. Drives whether the worktree gets its own per-suite scratch dir (`tmp/`, `__snapshots__/`, `playwright-report/`).
- **New services / sidecars?** New `docker-compose.yml` entries, new background workers, a new local proxy. If yes → record `compose_change: true`. Drives the compose project name / network strategy in the **Docker / compose isolation** step.

If freeform (the **Scope** step's first answer was `Freeform`): set every flag to `true` (fork everything) — the cost is wasted disk; the cost of a wrong shared-state decision is corrupted data.

### 0.3 — Sanity checks

- `git worktree list` — current worktrees + their branches. Refuse to provision a second worktree for the same branch.
- `git status` of the main checkout — refuse to provision if main has uncommitted changes on a branch you're about to fork from, **unless** the user explicitly says "use HEAD as the worktree base" (record their answer; worktree base = `head` instead of the default `origin/<default-branch>`).
- Disk space — `df -h .` of the worktree root's filesystem. Warn if `< 2 × du -sh node_modules/` (or equivalent for the project's primary dep dir).
- Filesystem symlink support — `ln -s /tmp/test-symlink /tmp/.prepare-worktree-symlink-probe && rm /tmp/.prepare-worktree-symlink-probe`. If symlinks aren't supported, flip every "symlink" decision below to "copy" and warn the user.

## Step 1 — Create the worktree

```bash
git fetch origin
git worktree add -b <branch> <worktree-path> <base-ref>
```

- `<branch>` — `<worktree-name>` (or a per-plan convention from the caller; e.g. [implement-plan](../implement-plan/SKILL.md) passes `plan/<plan-id-kebab>/wt`).
- `<base-ref>` — `origin/<default-branch>` by default; `HEAD` only when the **Sanity checks** step confirmed.
- `<worktree-path>` — from the worktree-root answer in the **Scope** step.

Confirm `git worktree list` shows the new entry. From here, every command runs **inside** the worktree (`cd <worktree-path>` or pass `-C <worktree-path>` on every git call). Don't leave the user's shell in the worktree without explicit confirmation.

## Step 2 — Inventory ignored runnable state

Walk the `.gitignore` rules + repo conventions and produce a list of every ignored path the runtime depends on. Read each `.gitignore` file in the repo (root + nested) — `.gitignore` is the closest the project has to a manifest of "things the app needs but we don't commit".

Common categories (extend per project):

| Category | Typical paths | Default decision (no plan info) |
|---|---|---|
| Dep dirs | `node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `bin/`, `obj/` | Symlink (deps_change=false) / Copy + reinstall (deps_change=true) |
| Build / cache | `dist/`, `build/`, `.next/`, `.turbo/`, `.cache/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/` | Skip (rebuilt on next run) |
| Env files | `.env`, `.env.local`, `.env.development`, `.env.test`, `.envrc` | Copy (env_change=true) / Symlink (env_change=false), then mutate per the **Database fork** + **Docker / compose isolation** steps |
| Local DBs | `db.sqlite3`, `*.sqlite`, `data/`, `pgdata/`, `.localstack/` | Fork (schema_change=true) / Symlink (schema_change=false) |
| Per-machine config | `.idea/`, `.vscode/settings.json` (when ignored), `local.settings.json`, `.tool-versions` | Copy (independent edits per worktree) |
| Test artefacts | `coverage/`, `playwright-report/`, `test-results/`, `__snapshots__/` (when ignored) | Skip; per-worktree fresh dirs |
| Tool state | `.terraform/`, `.serverless/`, `.aws-sam/`, `.gradle/` | Symlink (read-mostly) / Copy (changes per worktree) |
| Tracked-by-project AI tooling state | `.vinta-ai-workflows/` | Symlink (shared cache is fine across worktrees) |

Record every decision in `.vinta-ai-workflows/worktrees/<name>.yaml` (see the **Write the summary file** step) so teardown can reverse them mechanically.

### 2a — Dep dirs

`deps_change = false` → `ln -s <main>/node_modules <worktree>/node_modules` (and same for `vendor/`, `venv/`, …). Save disk + skip `pnpm install`.

`deps_change = true` → copy or reinstall:
- **Copy** (`cp -aR <main>/node_modules <worktree>/`) — fast, but only correct if the package manager doesn't keep absolute paths inside (pnpm's `node_modules/.pnpm/` stores relative symlinks → safe; some yarn PnP setups bake absolute paths → reinstall instead).
- **Reinstall** (`pnpm install`, `npm ci`, `pip install -r requirements.txt`, `poetry install`, `cargo build`, `go mod download`) — slow but always correct.

Default: **copy** for pnpm + npm + cargo + go; **reinstall** for poetry + venv + yarn PnP. Override per-project via `.vinta-ai-workflows.yaml` → `run_options.prepare-worktree.deps_strategy: copy | reinstall`.

### 2b — Env files

`env_change = false` → `ln -s <main>/.env <worktree>/.env`. Mutations the agent makes to `.env` would leak into main — flag this in the worktree's `README.md` (written in the **Write the summary file** step).

`env_change = true` → `cp <main>/.env <worktree>/.env`. Then mutate per the **Database fork** step (DB URL) + the **Docker / compose isolation** step (compose project name).

`.env.example` is **always** symlinked — it's committed; the worktree should keep tracking it.

### 2c — Skip rules

Build / cache dirs (`dist/`, `.next/`, `__pycache__/`) — don't copy, don't symlink. Let the next `build` / `test` populate them fresh in the worktree.

Test artefact dirs (`coverage/`, `playwright-report/`) — same.

## Step 3 — Database fork (when `schema_change = true` or test DB collision is possible)

Two distinct database axes need handling:

### 3a — Dev / app database

Whatever the app reads + writes during local dev. Detect the connection string source:

1. `.env` / `.envrc` keys: `DATABASE_URL`, `POSTGRES_URL`, `MYSQL_URL`, `MONGODB_URI`, `REDIS_URL`, …
2. Project config files: `config/database.yml` (Rails), `database.ini`, `prisma/schema.prisma`'s `datasource`, `knexfile.js`, Django `settings.py`'s `DATABASES`.
3. Docker compose service env: `services.db.environment.POSTGRES_DB`.

For each detected DB, ask the user (`AskUserQuestion`) once:

- **Fork the DB** — recommended when `schema_change = true` or when the plan's phases run destructive migrations. Strategy depends on the engine:
  - **Postgres (server-based)** — `createdb -T <main_db> <main_db>_wt_<name>` (template-clone if rights allow; else `pg_dump <main_db> | psql <main_db>_wt_<name>` after `createdb`). Update the worktree's `DATABASE_URL` to point at the forked DB. Append `?application_name=wt-<name>` so the user can grep `pg_stat_activity`.
  - **MySQL (server-based)** — `mysqldump <main_db> | mysql <main_db>_wt_<name>` after `CREATE DATABASE`.
  - **SQLite (file-based)** — `cp <main>/db.sqlite3 <worktree>/db.sqlite3`. Symlink would defeat the point.
  - **Mongo / Redis / Elasticsearch** — engine-specific clone, OR per-worktree DB name / key prefix (`REDIS_URL=redis://localhost:6379/<index>` with a free index; `MONGODB_URI=mongodb://localhost:27017/<db>_wt_<name>`).

- **Share the DB (don't fork)** — only safe when `schema_change = false` AND there's no risk of conflicting writes. Symlink the SQLite file or point the worktree's env at the same URL. Warn explicitly: "DB shared with main checkout — destructive ops here will be visible in main."

- **Stub the DB** — point the worktree at a fresh empty DB (`createdb <main_db>_wt_<name>` + run all migrations + seed if a seed exists). Best when the feature needs schema parity but no production data.

Record the chosen strategy + the forked DB name in the worktree summary (written in the **Write the summary file** step).

### 3b — Test database

A different beast — tests on the same engine but a different DB name (`<main_db>_test`, `test_<repo>`). Parallel worktrees running tests against the same `<main_db>_test` will overwrite each other's fixtures and produce flaky failures.

- **`pytest-django` / `pytest`** — set `--reuse-db` per worktree via a per-worktree `DJANGO_SETTINGS_MODULE` env, OR override `DATABASES['default']['NAME']` to `<main_db>_test_wt_<name>` in `conftest.py` when the env var `WORKTREE_NAME` is set. Drop a `conftest_worktree.py` patch in the worktree (don't edit `conftest.py` in tracked code — too easy to commit by accident).
- **`vitest` / `jest`** — set `TEST_DATABASE_URL` per worktree; ensure the test setup respects it.
- **Rails** — `DATABASE_URL` for the `test` env, `<main_db>_test_wt_<name>`.
- **Docker-compose-based test DB** — see the **Docker / compose isolation** step below; per-worktree compose project name fixes it.

If `test_infra_change = true` → fork the test DB unconditionally. If `false` and the user says "share is fine" → still flag the race risk; offer a one-line fix to switch later.

### 3c — Migrations against the forked DB

When the plan has migrations: run them once now against the forked DB so subsequent agent runs in the worktree don't surprise the user. Use the project's standard migration command (`pnpm migrate`, `python manage.py migrate`, `alembic upgrade head`, `prisma migrate dev`, `knex migrate:latest`).

Failure → surface the error, leave the DB un-migrated, ask the user how to proceed (skip, retry, drop and recreate the DB).

## Step 4 — Docker / compose isolation (when `compose_change = true` OR project uses compose)

If the project has a `docker-compose.yml` / `compose.yaml` / `docker-compose.override.yml`, every worktree needs **its own project name** so containers, networks, and volumes don't collide.

1. Set `COMPOSE_PROJECT_NAME=<repo>_<worktree-name>` in the worktree's `.env` (or in a `.envrc` if the project uses direnv). Then `docker compose up` inside the worktree spins a fresh container set.

2. **Shared network** — if the worktree's app needs to reach services running in the *main* checkout's compose stack (a queue, a cache, a search index that's expensive to spin twice), put them on an external network:

   ```yaml
   # docker-compose.override.yml in the worktree (or in main; pick one place)
   networks:
     shared:
       external: true
       name: <repo>_shared
   services:
     app:
       networks:
         - shared
   ```

   Or use `network_mode: host` if the project uses that pattern. Decide once per project and record in `.vinta-ai-workflows.yaml` → `run_options.prepare-worktree.compose_network: per-worktree | shared-external | host`.

3. **Linters / formatters / test runners that run inside docker** (a Dockerfile-based `pnpm test`, a `lint` target that mounts source into a sidecar container) — these MUST run with the worktree's `COMPOSE_PROJECT_NAME`. Otherwise concurrent runs hit the same container and one wins. The standard fix: ensure the project's lint/test scripts read `COMPOSE_PROJECT_NAME` from env instead of hard-coding it.

4. **Per-worktree volumes** — let compose auto-create volumes namespaced by project name. Don't manually `external: true` data volumes (defeats isolation).

## Step 5 — Other shared infra to fork

Quick walk-through of common gotchas. For each, follow the same fork/share pattern:

- **Redis** — pick a free DB index (`/0` … `/15`) per worktree, or per-worktree key prefix if all indices are taken.
- **Object storage / S3 / GCS** — per-worktree bucket prefix in `.env` (`S3_PREFIX=wt-<name>/`); always set, even when sharing.
- **Message queues** — per-worktree queue name suffix.
- **Search index** — per-worktree index suffix.
- **Cron / background jobs** — disable cron in the worktree's `.env` (`DISABLE_CRON=true`) unless the feature needs them. Two workers polling the same queue against a shared DB is a footgun.
- **Webhooks / dev tunnels** (ngrok, cloudflared) — each worktree needs its own tunnel hostname; if the project hard-codes one URL, document the override.

If the **Plan inspection** step inferred the plan doesn't touch any of these: symlink / share. If unsure: fork. Cheap.

## Step 5.5 — Filesystem sandbox (OS-level write guard)

Symlinking + threading the worktree path through prompts keeps *cooperative* agents in the worktree, but it's not a guarantee: a buggy agent (often a smaller model spawned for a phase) can resolve an absolute path back to the **main checkout** and silently write there. Those writes never reach the worktree's commit — they sit as uncommitted thrash in the main checkout, and the "missing" edits read as a silent agent failure. Prompt instructions don't stop it; they rely on the agent's goodwill.

The deterministic fix is to confine the *process* (not the tool) at the OS filesystem layer: make the main checkout read-only for any command run inside the sandbox, regardless of which agent CLI issues the writes. The bundled [scripts/sandbox-run.sh](scripts/sandbox-run.sh) does this — `sandbox-exec` on macOS, `bwrap` (bubblewrap) on Linux. **This process-wrapping model works for runtimes that spawn subagents as subprocesses** (`codex exec`, a `claude -p` child, a custom runner). Runtimes that run subagents **in-process** — notably claude-code's Task tool, where there's no child command to wrap — use the harness-config guard in [In-process runtimes (claude-code)](#55a--in-process-runtimes-claude-code) instead.

**Model: deny-main, allow-rest.** The whole filesystem stays writable EXCEPT the main checkout, with the worktree (and the shared `.vinta-ai-workflows` dir) punched back to writable — even though the worktree usually lives *under* the main checkout (`.claude/worktrees/<name>/`). This deliberately does **not** lock `HOME` / caches / `/tmp`, so package managers, build tools, and test runners behave exactly as unsandboxed. The only thing the cage blocks is a write to the main checkout's own tracked tree — which is exactly the bug.

Wrapper contract:

```bash
sandbox-run.sh \
  --deny  <main-checkout-root> \
  --allow <worktree-path> \
  --allow <summary_dir-and-prs-context-parent>   # the .vinta-ai-workflows dir
  -- <command> [args...]
```

The command runs with main-checkout writes blocked. A stray write fails with `Operation not permitted` (macOS) / `EROFS` (Linux) — the agent sees an ordinary error and retries against the correct path; the worktree stays the only writable copy of the repo.

**Capability probe (run here, record the result):**

```bash
command -v sandbox-exec >/dev/null && tier=enforced   # macOS
command -v bwrap        >/dev/null && tier=enforced   # Linux
# neither → tier=none (sandbox unavailable)
```

- `tier=enforced` → the OS guarantee holds. The caller ([implement-plan](../implement-plan/SKILL.md)) can downgrade its post-run stray-write check to a backstop.
- `tier=none` → no sandbox tool on this machine (locked-down CI without `bwrap`'s user-namespace support, Windows, etc.). `sandbox-run.sh` still runs the command (best-effort, unsandboxed) and prints a loud warning; prevention falls back to the caller's reactive stray-write detection. **Don't fail provisioning over this** — surface the degraded tier and continue.

Escape hatch: `VINTA_SANDBOX=off` makes the wrapper a transparent pass-through (for the rare tool that needs access the sandbox blocks). Record the achieved tier in the summary (next step) so the caller knows whether it's running guaranteed or best-effort.

**Sandbox-mode shared-state rule.** Because main is read-only inside the cage, any path the *run* writes must live in the worktree or in an `--allow`'d dir — never a symlink that resolves back into the main checkout. Two follow-ons:
- The existing `deps_change=true` → copy/reinstall logic already gives the worktree its own writable `node_modules/` when a phase installs deps; non-churn phases keep the read-only symlink (agents shouldn't write deps anyway — correct).
- The `.vinta-ai-workflows/` dir (summary YAMLs, prs-context) is shared/symlinked but **written** during a run, so it must be passed as an `--allow` path (or made a real writable dir in the worktree). Record which.

### 5.5a — In-process runtimes (claude-code)

`sandbox-run.sh` confines a **process**: it wraps the command that launches a subagent. That only works when the runtime spawns subagents as **subprocesses** (`codex exec …`, a `claude -p …` child, a custom runner) — you wrap that argv and the kernel blocks the child's main-checkout writes.

**Claude Code runs subagents in-process.** Its Task tool shares the orchestrator's OS process and tool pipeline — there's no child launch command to wrap. The guard has to live in the harness's own config instead. Two complementary layers, both bundled here, both matching the same deny-main/allow-rest model:

- **Layer A — `PreToolUse` write-guard hook** ([scripts/claude-worktree-write-guard.py](scripts/claude-worktree-write-guard.py)). A session-level `PreToolUse` hook fires for **every** tool call in the session — orchestrator **and** every in-process Task subagent — because they run through the same pipeline. This hook matches the file-editing tools (`Edit|Write|MultiEdit|NotebookEdit`), realpath-resolves the target, and blocks (exit 2 → the model gets the reason and retries) any write that escapes the worktree into the main checkout. Filesystem-only, **no network impact**. This is the load-bearing claude-code guard and the concrete form of implement-plan's "runtime pre-write guard hook" option.

- **Layer B — Claude Code's native OS sandbox** (opt-in). Claude Code has adopted the same OS model `sandbox-run.sh` implements (`sandbox-exec` / `bwrap`), configured via `sandbox.filesystem.denyWrite` / `allowWrite` in `settings.json` instead of a wrapper, and it applies to **Bash run inside subagents** too. Turning it on closes the one gap Layer A leaves — a write issued through **Bash** (`echo > <main>/f`), which a file-tool hook can't see. **Caveat: enabling the native sandbox also turns on network isolation**, so `pnpm install` / `git push` break unless you allow-list the registry + git-remote hosts. Without Layer B, Bash-issued stray writes fall back to implement-plan's post-run `git -C <main> status` backstop (Layer 1).

Generate both with [scripts/gen-claude-sandbox-settings.sh](scripts/gen-claude-sandbox-settings.sh):

```bash
# Layer A only (filesystem-only, no network config needed):
scripts/gen-claude-sandbox-settings.sh --worktree <worktree-path> --main <main-checkout-root>

# Layer A + B (also OS-block Bash writes; must allow-list network hosts):
scripts/gen-claude-sandbox-settings.sh --worktree <worktree-path> --main <main-checkout-root> \
  --os-sandbox --allow-domain <registry-host> --allow-domain <git-remote-host>
```

It writes `<worktree>/.claude/settings.json` (merging, not clobbering) with `<worktree>`, `<main>/.git` (git worktrees commit into the main repo's `.git` — **must** stay writable), and `.vinta-ai-workflows` punched back to writable.

**Two deployment models — settings are read at session start:**

1. **Worktree-rooted session (recommended).** Run the plan from inside the worktree (`cd <worktree> && claude`). The generated `<worktree>/.claude/settings.json` governs that session and all its Task subagents. As a bonus, claude-code's default working-directory boundary already discourages file writes above cwd, so this is belt-and-suspenders. Provision the worktree + settings **before** starting the plan session.
2. **Config in the invocation's project root.** If the orchestrator already runs in the main checkout (implement-plan's default topology), the hook + sandbox must instead live in the main checkout's `settings.json` / `settings.local.json` **before** that session starts — the native `sandbox` block in particular is read at launch and won't retroactively cage an already-running session. Provision first, then start the plan; don't expect a mid-run `use_worktree` opt-in to enable the OS sandbox for the session that requested it.

Record the achieved tier the same way as the subprocess path: `enforced` when Layer B is active (or Layer A alone if the team accepts hook-only), `none` when neither is wired.

## Step 6 — Write the summary file

`.vinta-ai-workflows/worktrees/<name>.yaml` (committed to `.gitignore` via the existing `.vinta-ai-workflows/` umbrella). Schema:

```yaml
name: <worktree-name>
path: <abs-path-to-worktree>
branch: <branch-name>
base_ref: <origin/main | HEAD>
created_at: <ISO 8601>
plan_path: <ai-plans/...>     # null when freeform
flags:
  deps_change: <bool>
  schema_change: <bool>
  env_change: <bool>
  test_infra_change: <bool>
  compose_change: <bool>
state:
  deps:
    strategy: symlink | copy | reinstall
    paths: [node_modules, vendor, venv, ...]
  env:
    strategy: symlink | copy
    files: [.env, .envrc, ...]
  dev_db:
    engine: postgres | mysql | sqlite | mongo | redis
    strategy: fork | share | stub
    forked_name: <forked db name>   # null when share / stub
    connection_url_var: DATABASE_URL
  test_db:
    engine: ...
    strategy: fork | share
    forked_name: ...
    connection_url_var: TEST_DATABASE_URL
  compose:
    project_name: <repo>_<worktree-name>
    network_strategy: per-worktree | shared-external | host
  other:
    redis_db_index: <int>
    s3_prefix: wt-<name>/
    cron_disabled: <bool>
  sandbox:
    tier: enforced | none          # from the Filesystem sandbox step's capability probe
    launcher: sandbox-exec | bwrap | claude-hook | claude-native-sandbox | null
    # sandbox-exec / bwrap        → subprocess runtimes via scripts/sandbox-run.sh
    # claude-hook                 → in-process (claude-code) Layer A hook only (file tools)
    # claude-native-sandbox       → in-process (claude-code) Layer A hook + Layer B OS sandbox
    # null                        → tier=none (no guard wired)
    deny: [<main-checkout-root>]   # subtree(s) made read-only inside the cage
    allow: [<worktree-path>, <main-checkout-root>/.git, <.vinta-ai-workflows-dir>]  # writable exceptions
notes: |
  <freeform — anything the user / agent should know>
```

Also drop a `WORKTREE.md` at the worktree root:

```markdown
# Worktree: <name>

Branch: `<branch>` (based on `<base-ref>`).

## What's forked vs shared
<one-line per row in `state` above>

## Write protection
Sandbox tier: `<enforced | none>` (launcher: `<sandbox-exec | bwrap | none>`).
When `enforced`, commands run via `sandbox-run.sh` cannot write to the main
checkout — only this worktree (+ `.vinta-ai-workflows`). When `none`, no OS
guard is active; the orchestrator's post-run stray-write check is the backstop.

## How to run things
- Lint: `<project lint command>` (runs inside this worktree)
- Tests: `<project test command>` (against `<test_db.forked_name>`)
- App: <`pnpm dev` / `python manage.py runserver` / …>
- DB:  <forked db name + connection url>

## Teardown
When the plan is merged / abandoned:
  git worktree remove <path>
  <drop-db command>          # if fork strategy was `fork`
  docker compose -p <project_name> down -v   # if compose was forked

The summary file at `.vinta-ai-workflows/worktrees/<name>.yaml` records every
decision for mechanical teardown.
```

## Step 7 — Report

One paragraph to the caller:

- Worktree path + branch.
- One line per fork decision (deps / env / dev DB / test DB / compose / other).
- **Sandbox tier** (`enforced` via `sandbox-exec` / `bwrap`, or `none`) — so the caller knows whether main-checkout writes are OS-blocked or only caught after the fact.
- Anything the user must do manually before running the app (`source .envrc`, `direnv allow`, login to a cloud CLI in the worktree, etc.).
- Teardown command.

When called from [implement-plan](../implement-plan/SKILL.md), this report becomes the orchestrator's confirmation that subagents can be spawned against the worktree path.

## Teardown

A sibling skill / explicit command — not auto-run by this skill. Steps:

1. Confirm no uncommitted changes in the worktree (`git -C <path> status`).
2. `git worktree remove <path>` (or `--force` after explicit confirmation if the user is fine losing work).
3. Drop the forked DB (`dropdb <forked_name>`, `DROP DATABASE`, `rm <sqlite-file>`, …) — read the strategy from the summary YAML.
4. `docker compose -p <project_name> down -v` for forked compose.
5. Remove `.vinta-ai-workflows/worktrees/<name>.yaml`.

Every step gated on user confirmation when the worktree has un-pushed branches.

## Rules

- **Symlink for reads, copy for writes, fork for state.** This is the only mental model that scales. Default to fork when unsure — disk is cheap, corrupted main-checkout DBs are not.
- **Never share a writable DB across worktrees by default.** The race conditions are subtle and the failure mode is silent data corruption.
- **Every fork decision lands in `.vinta-ai-workflows/worktrees/<name>.yaml`.** Teardown reads it; humans grep it; agents resuming a stalled plan read it. No decision lives only in conversation memory.
- **Worktree root governed by runtime conventions.** claude-code uses `.claude/worktrees/`; other harnesses use sibling dirs. Don't fight the harness — match it.
- **Don't mutate the main checkout from this skill.** Every write goes to the worktree or to `.vinta-ai-workflows/`. Forking a Postgres DB is the one exception (the new DB lives in the same server) — document it loudly in the summary.
- **Sandbox is the deterministic guard; the prompt is not.** When a sandbox tool exists, the [Filesystem sandbox](#step-55--filesystem-sandbox-os-level-write-guard) step's `sandbox-run.sh` makes the main checkout read-only for any spawned command — this is what actually *prevents* stray main-checkout writes for subprocess runtimes. For **in-process** runtimes (claude-code's Task tool) there's no subprocess to wrap: wire the `PreToolUse` hook (+ optional native OS sandbox) from [In-process runtimes (claude-code)](#55a--in-process-runtimes-claude-code) into the session's `settings.json` instead. Telling the agent "stay in the worktree" is best-effort only either way. Always probe + record the tier; never claim prevention when `tier=none`.
- **`<main>/.git` stays writable in every model.** Git worktrees store their commits in the main repo's `.git`; a deny that also blocks `<main>/.git` breaks every commit made inside the worktree. `sandbox-run.sh` callers and the generated claude-code settings must both `--allow` / `allowWrite` `<main>/.git`.
- **Deny-main, allow-rest — never allow-worktree-only.** Locking everything except the worktree breaks package managers / caches / `$HOME`. Lock only the main checkout subtree; re-allow the worktree (nested under it) and the written `.vinta-ai-workflows` dir. Don't tighten further without testing the project's real lint / test / build / migrate commands inside the cage.
- **Worktree base = `origin/<default-branch>` by default.** `HEAD` only when the user explicitly confirms; record the choice in the summary.
- **Refuse to provision a second worktree for the same branch.** Git enforces this — don't try to work around it.
- **Don't auto-install heavy deps** (e.g. `pnpm install` from scratch) without confirmation when the project's main `node_modules/` is already populated — symlink first, ask if reinstall is needed.

## Pitfalls

- **Symlinking `node_modules` for a `pnpm add` phase.** The new package writes back through the symlink into the main checkout's store. Detect dep churn in the **Plan inspection** step and copy/reinstall instead.
- **Forking the dev DB but forgetting the test DB.** Tests still hit the shared test DB and stomp on parallel worktrees' fixtures. Both axes need their own decision in the **Database fork** step.
- **Forgetting `COMPOSE_PROJECT_NAME`.** Containers from worktree-A overwrite worktree-B's containers; volumes get nuked. Set it in `.env` so every `docker compose` call inherits.
- **Sharing a Redis DB without per-worktree prefix.** Tests writing `user:123` collide across worktrees. Pick an index OR a key prefix.
- **Copying `node_modules` for yarn PnP / absolute-path setups.** The copy carries baked-in paths from the main checkout. Reinstall instead — pnpm's relative-symlink store is the safe-to-copy exception.
- **Forgetting to `--allow` the `.vinta-ai-workflows` dir under sandbox.** It's shared/symlinked but the run *writes* it (summary YAMLs, prs-context). If it's not an `--allow` exception, those writes hit the read-only main subtree and fail mid-run. Pass it alongside the worktree path.
- **Assuming the sandbox is always there.** `bwrap` needs user namespaces enabled — some hardened kernels and CI images disable them. Probe (`command -v bwrap`); on `tier=none` degrade to the post-run check, don't silently believe writes are blocked.
- **Over-tightening into an allow-worktree-only cage.** Tempting, but it breaks every tool that writes outside the repo (npm cache, `~/.config`, `$TMPDIR`). The deny-main model is the one that needs no per-stack allowlist tuning.
- **Leaving cron / background workers on in the worktree.** They poll the shared DB and double-process jobs. Default to off.
- **Provisioning a worktree, running migrations, then realizing the user wanted to share the DB.** The **Database fork** step asks BEFORE migrating; rollback of a forked-DB migration is mechanical (drop the DB), but rollback of a shared-DB migration is a half-day.
- **Symlinking `.env` and then editing it.** The edit leaks into main. Copy (not symlink) the moment `env_change = true`.

## Verification

After the **Write the summary file** step writes the summary:

1. `git worktree list` shows the new entry.
2. `cd <worktree-path>` then run the project's standard lint + test commands. Both must run clean against the worktree's forked DB / env.
3. `git -C <worktree-path> status` is clean (no accidental file additions from the prep step).
4. The summary YAML parses (`python3 -c "import yaml; yaml.safe_load(open('.vinta-ai-workflows/worktrees/<name>.yaml'))"`).
5. `WORKTREE.md` exists at the worktree root with accurate fork / share annotations.
6. Optional smoke test: run a single new-test command in the worktree (e.g. `pytest -x tests/health.py`) — confirms env vars resolved, DB reachable, deps importable.
