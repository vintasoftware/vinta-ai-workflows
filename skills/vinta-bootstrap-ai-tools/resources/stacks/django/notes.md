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
- **REST-endpoint** (if the project uses Django REST Framework or django-ninja) - REST API endpoint patterns.
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

## When this stack doesn't apply cleanly

- Django REST framework but no DB (read-only API on top of an external service) → most of these skills don't apply.
- Single-tenant Django → apply but drop tenant-filter rules.
- Async-first (`asgi.py`, `django-channels`) → templates may need additional async-handling sections.
