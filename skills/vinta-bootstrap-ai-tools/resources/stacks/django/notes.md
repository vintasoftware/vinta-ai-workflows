# Django + Postgres stack

## Detection signals

Repo matches when:

- `pyproject.toml` (or `requirements*.txt`) lists `django` (any version).
- `manage.py` exists at root or in a `<project>/` subdir.
- At least one `<app>/migrations/` directory is present.

Multi-tenancy variant signals (any one triggers the multi-tenant flavor of skill prompts):

- `psqlextra` or `django-postgres-extra` in deps → likely LIST partitioning by tenant key.
- `tenant_id` (or `organization_id`, `account_id`) `UUIDField` / `ForeignKey` on hot-table models.
- A custom `Manager` / `QuerySet` with `for_tenant(...)` / `filter_tenant(...)` methods.
- Middleware that injects `request.tenant`.

If no multi-tenancy signals → single-tenant Django; the team's templates may still apply, just without the per-tenant filter rules.

## Skill categories typically needed

- **Add-model** — base class, custom QuerySet + Manager (`from_queryset`), `db_table` explicit, `__all__` exports, admin registration, tenant column + index if multi-tenant, tests.
- **Add-migration** — naming, dependencies, `db_default` for non-null new columns, hot-table operations (CONCURRENTLY indexes, avoiding rewrites), `psqlextra` partitioned tables, view-version migrations (`vw_*`), HStore extensions, deferred constraints, the reverse path.
- **Create-postgres-view** (if the project uses versioned `vw_*` / `mv_*` views via a schema framework) — versioned SQL files, `MigrationSchemaView`, `Schema.Apply(N)` pattern.
- **Create-postgres-function** (if the project ships custom `CREATE FUNCTION` / aggregates) — versioned function migrations.
- **Create-data-import / create-data-export** — async import/export commands feeding integrations.
- **GraphQL-public-query** (if the project uses Strawberry or Graphene) — public-API mutation/query patterns.
- **REST-endpoint** (if the project uses Django REST Framework or django-ninja) - REST API endpoint patterns. With drf-spectacular, ask whether the team's endpoint template requires every new `choices` field the API exposes to add its `ENUM_NAME_OVERRIDES` entry in the same change. Parallel phases that each add a `status` field with different choices otherwise collide on the generated enum name (`StatusEnum`), and the collision only shows at integration, in the schema test.
- **Run-one-off-script-django** — sister to the universal `add-one-off-script` foundation skill. Authors the *runner* artefact in the per-script folder (Jupyter notebook in `notebooks/` is the typical Vinta default; a thin `BaseCommand` under `<app>/management/commands/<name>.py` is the alternative for headless / cron / CI invocation) and ships the matching `Runtime` adapter at `<scripts_dir>/_runtime_django.py` (`JupyterRuntime` and/or `DjangoMgmtRuntime`). Adapter responsibilities: hook `BaseCommand.handle()` into `BaseOneOffScript.execute()`; respect `python manage.py <name> --apply` / `--resume` / `--status` / `--restore` flags; load Django settings + DB connection before the engine starts iterating; for the Jupyter variant, swap signal handlers for kernel-interrupt and skip the PID-file lease (notebook = single instance by construction). README in the per-script folder spells out `python manage.py shell < script.py`, `jupyter lab notebooks/<name>/runner.ipynb`, and `python manage.py <name> --apply` as the three legitimate entry points.

## Agent categories typically needed

- **Migration-author** — specialist for high-stakes Django migrations (partitioned tables, view bumps, lock-aware ops on hot tables, deferred constraints, HStore). Treats every operation as a forward contract; audits the reverse path explicitly.

## Placeholders the orchestrator should ask about

- Apps directory (e.g. `apps/`, `<project>/app/core/`, `<project>/`)
- Test directory layout (`tests/unit/`, `tests/integration/`, in-app `tests/`)
- Test command (`pytest`, `make all-tests`, `python manage.py test`)
- Lint command (`pre-commit run --files <changed>`, `ruff check`, `make lint`)
- Type check command (`mypy app/`, `make typecheck`, none)
- Tenant column name (`tenant_id`, `organization_id`, `account_id`)
- Hot tables list (the high-traffic models that need migration safety)
- Migration command (`make migrations`, `python manage.py makemigrations`, `poetry run python manage.py makemigrations`)
- One-off script invocation surface (Jupyter notebook in `notebooks/<name>/`, Django management command, both) — drives the `run-one-off-script-django` skill's runner artefact + which `Runtime` adapter ships
- Notebook directory path (`notebooks/`, `<project>/notebooks/`) — only when Jupyter is selected as a runner surface

## Gates that should mirror CI

Ask which of these CI runs, and suggest each one it runs as a gate, so a phase cannot pass every gate and still fail CI. Declare each once, project-wide, as a custom gate under `maestro.gates.<id>` in `.vinta-ai-workflows.yaml` (e.g. `django-check: { cmd: ... }`, `api-client-fresh: { cmd: ... }`) and add its id to `maestro.defaults.gates` — every plan then runs it as its own gate, with its own verdict. Don't chain these onto the `typecheck` / `test` lines in `commands`: one verdict for several unrelated checks tells a fixer nothing about which one failed.

- **Deploy check at warning level** — `python manage.py check --deploy --fail-level WARNING` (with the CI settings module). Catches what `check` alone passes: URL patterns Django warns about (e.g. a `path()` route that looks like a regex), security settings, model warnings. One observed run added regex-style routes that passed every gate and failed this check in CI.
- **Migrations complete** — `python manage.py makemigrations --check --dry-run`.
- **Generated client / schema up to date** — when the project generates an OpenAPI/GraphQL schema or a typed frontend client from the Django API (drf-spectacular, Strawberry, django-ninja + an openapi codegen), a gate that regenerates it and fails on a diff (`<generate command> && git diff --exit-code <schema/client paths>`).

Placeholders to ask about: the settings module CI runs checks with, and the schema/client generate command and its output paths.

## Test commands in lanes

Ask how the suite runs, because maestro runs it in many worktrees at once, one merged tree after another in its integration worktree:

- **Database reuse.** With `pytest --reuse-db` (or `--keepdb`), a database a test run left behind applies forward migrations and never removes ones the current tree lacks. The integration worktree switches branches between merges, so its test gate needs a fresh-database form (`--create-db`, `make test_reset test`) — bootstrap emits it as `maestro.gates.test.fresh_cmd`.
- **Scoped runs with testmon.** `pytest --testmon` without a `.testmondata` runs every test, serially. A `test_changed` target should fall back to the full parallel run when the file is missing, and bootstrap declares the cache as `scope_cache` / `lane_seed`. `--testmon` with `-n` trades correctness for speed: testmon cannot attribute what an xdist worker ran.
- **One run at a time per lane.** A DB-backed suite shares its lane's test databases with any other run in that lane. Ask about the test-suite pool, and tell agents to check `docker ps` for a leftover `<lane>-api-run-*` container before starting another run.

Placeholders to ask about: the fresh-database form of the test command, the testmon cache path, the full parallel command.

## The dev container and the worktree

When `docker-compose.yml` bind-mounts the repository into the dev container, anything the container writes into the mount belongs to the container's user — root by default — and a lane whose `apps/api/.venv` is root-owned cannot be cleaned or recycled from the host (one observed phase failed six times on such a lane). Ask whether the compose file already keeps these out of the mount, and suggest, as changes the team makes to its own compose file:

- the virtual environment outside the mounted tree: `UV_PROJECT_ENVIRONMENT=/opt/venv` (uv), or a named volume over the `.venv` path;
- the dev service running as the host user: `user: "${UID}:${GID}"`, with `UID`/`GID` exported in the project's env file.

## Registries every phase appends to

URL route lists (`routes.py`), DI containers (`containers.py`), task packages (`tasks/__init__.py`) and drf-spectacular's `ENUM_NAME_OVERRIDES` are edited by nearly every phase of a plan, and they cause most of its merge work — including auto-merges git accepts that leave two list openers or a duplicated import. Ask which the project has, and suggest either a registry per feature module (`routes/<feature>.py` gathered by a loader, tasks found by autodiscovery), or listing them under `maestro.append_only` so maestro merges them with git's union driver. Either way the merged tree is gated.

## Test determinism

Tests that touch dates freeze the clock and set the timezone explicitly (`freezegun` / `time-machine` + `override_settings(TIME_ZONE=...)`), and schema generation reads no host state — timezone choices come from a pinned `tzdata`, not the OS tz database. Ask whether the project already has `freezegun`/`time-machine` and `tzdata` in its dev/lock dependencies; the `write-unit-test` Django pack assumes them.

## When this stack doesn't apply cleanly

- Django REST framework but no DB (read-only API on top of an external service) → most of these skills don't apply.
- Single-tenant Django → apply but drop tenant-filter rules.
- Async-first (`asgi.py`, `django-channels`) → templates may need additional async-handling sections.
