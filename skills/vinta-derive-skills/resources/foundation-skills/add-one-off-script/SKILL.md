---
name: add-one-off-script
description: Author a safe operational one-off script (data backfill, ad-hoc cleanup, schema fixup, tenant migration outside the regular migration pipeline). Enforces a strict contract every script must follow — dry-run by default, idempotent on re-run, batched DB operations, streamed reads, segmented CSV backups before destructive writes, interruption-safe, and console + filesystem + S3 logging that survives the interruption. Generates a per-script folder (`<scripts_dir>/<YYYY-MM-DD>-<name>/`) containing the subclass + tests + (when a sister `run-one-off-script-<stack>` skill is invoked) the stack-specific runner artefact (Django mgmt command, Jupyter notebook, Medplum bot, Vercel Function, Lambda, K8s Job). The bundled `BaseOneOffScript` class delegates every runtime-specific concern (logging sink, lease, stop signal, artifact upload) to a pluggable `Runtime` interface — `LocalRuntime` is the default for plain CLI invocation; stack runner skills ship their own adapters. Use whenever the user asks for a one-off script, backfill, cleanup, data fix, or any imperative operation that mutates data outside the normal migration / ETL / cron paths.
---

# Add a one-off script

One-off scripts are the operations that *don't* belong in the regular migration / ETL / Celery / cron path: a 30k-row backfill triggered by a customer escalation, a tenant re-keying after a botched import, a quick fix to bad rows from a deploy that already shipped. They run once, on demand, by an engineer who knows what they're doing — but they still touch production data, and they still have to be safe.

## Sister skills — runner is stack-specific

This skill authors the **script class** — the language-level subclass of `BaseOneOffScript` that defines `iter_targets` + `process` + the safety contract. It does **not** decide *how* the script gets invoked in this project. That's a stack-specific concern (a Django project runs scripts in `manage.py shell` or a Jupyter notebook; a Medplum project ships them as bots; a Next.js / Vercel project wraps them in a Function or Cron; a K8s shop deploys them as Jobs).

The invocation surface is the job of a sister skill: `run-one-off-script-<stack>` (e.g. `run-one-off-script-django`, `run-one-off-script-medplum`, `run-one-off-script-nextjs`). Each sister skill:

- Authors the runner artefact (notebook / bot file / route handler / mgmt command) **inside the same per-script folder** this skill generates.
- Picks the matching `Runtime` adapter (e.g. `JupyterRuntime`, `MedplumBotRuntime`, `VercelFunctionRuntime`) — see "Runtime adapters" below.
- Documents the project-specific launch / monitor / interrupt commands.

If the project has no sister skill yet, fall back to the bundled `LocalRuntime` invoked via `python script.py` / `node script.ts` from a shell. The script still runs; it just lacks the integration the stack-specific skill would add.

When this skill runs and detects a stack with a sister skill installed, ask the user via `AskUserQuestion` whether to dispatch the sister skill after the class is generated. Default `Yes`.

This skill exists because every team has been burned by the same family of mistakes:

- "It already ran halfway and crashed; now I don't know what's done and what isn't."
- "I locked the table for 40 minutes and woke the on-call."
- "I overwrote the column before realising I needed the old values."
- "I OOMed the box because I loaded 4M rows into a list."
- "I lost the logs because I tailed them in a tmux that died with the SSH session."

The contract below + the bundled `BaseOneOffScript` class fix all of these by construction. Follow the skill — don't reinvent it per script.

## When to use this skill

Trigger on any prompt of the shape:

- "write a one-off script that …"
- "backfill column X for rows where …"
- "clean up orphan / duplicate / orphaned-foreign-key rows in …"
- "fix tenant Y's data — they have …"
- "we shipped a bug that miswrote data; write a script to repair …"

**Don't** use this skill for:

- Schema changes that belong in the regular migration tool (Django migrations, Alembic, Knex, Prisma migrate, Liquibase). Those have their own contract.
- Recurring jobs — those go to Celery / cron / Vercel Cron / queues.
- ETL pipelines — those go to dbt / Airflow / whatever the project uses.

If the user asks for a "script" but the operation is recurring, push back: "this should be a scheduled job, not a one-off".

## The contract every one-off script MUST satisfy

Each rule below is enforced by the bundled `BaseOneOffScript` template. The skill's job is to make sure the new script actually uses the template instead of bypassing it.

### 1. Dry-run is the default

`execute(dry_run=True)` (or `execute({ dryRun: true })` in TS). Default `True`. **Every** write path checks the flag and logs `[dry-run] would …` instead of writing. The script must be runnable safely against production by anyone who hasn't read it.

A `--apply` flag (or `dry_run=False` argument) is the only way to flip the switch. Don't accept truthy strings, env vars, or "set this constant to False at the top". One explicit CLI flag, every time.

### 2. Idempotent — safe to re-run

Re-running the script after a partial success (network blip, OOM, signal, deploy, anything) processes only the items that didn't complete. Two implementation patterns are acceptable; pick one per script:

- **State-based** — the operation is a no-op when already applied (e.g. `UPDATE … WHERE flag IS NULL`; `INSERT … ON CONFLICT DO NOTHING`; `if obj.tenant_id is None: obj.tenant_id = …`). Preferred when feasible.
- **Resume log** — the active runtime persists each completed item id (default `LocalRuntime` writes it to `<log_dir>/<script_name>/processed.txt`, fsync'd per item). On the next run with `--resume` (or sister-skill equivalent), items in that file are skipped. Use when the underlying operation isn't naturally idempotent.

Never trust "I tested it locally on 100 rows" as proof of idempotency. The contract holds across runs from different machines, different days, different shells.

### 3. Batched DB operations — no full-table locks

The target query and the per-item write must both work in batches. The bundled template enforces this by:

- `iter_targets()` yielding from a chunked, ordered query (`pk > last_seen_pk LIMIT batch_size`, or Django's `iterator(chunk_size=…)`, or a server-side cursor for psycopg). **Never** `.all()`, never an unbounded `SELECT *`, never `OFFSET` (degrades quadratically on big tables).
- The per-item write touching one row, or one bounded set of rows, at a time. Bulk updates are allowed as long as they're WHERE-clause-bounded to the current batch.
- No `LOCK TABLE`, no `ALTER TABLE`, no operations that require an `ACCESS EXCLUSIVE` lock. Those belong in real migrations with proper review.

If the operation genuinely needs a table lock, stop and route the user to the migration tool — this skill is the wrong tool for that job.

### 4. Streamed reads + writes — bounded memory

Memory must stay flat regardless of dataset size. The template enforces this by typing `iter_targets()` as a generator (`Iterator[T]` / `AsyncIterable<T>`) and refusing to materialize. CSV writers stream too.

Rules of thumb for the new script:

- Never `list(queryset)` / `Array.from(asyncIter)` / `cursor.fetchall()`.
- Never accumulate a per-script collection of "all the things I touched"; if you need it, write to a CSV chunk file as you go.
- Buffers (e.g. `bulk_update` batches) are allowed but capped at `batch_size`.

### 5. Backups before destructive writes — segmented CSV per table

If the script overwrites or deletes data that **cannot be recovered from elsewhere** (i.e. not idempotent state changes — actual destructive writes), the template writes a CSV backup of the affected rows *before* the write, with these guarantees:

- **One CSV per table.** Multiple tables → multiple files. Never nest table data inside a CSV cell — the requirement is "different table = different set of files".
- **Max 1,000,000 cells per file.** When a file approaches the limit (rows × columns > 1M), the writer rolls over to the next chunk: `<script>.<table>.001.csv`, `<script>.<table>.002.csv`, …
- **Header on every chunk** so each file is self-contained.
- **fsync per chunk close** so the backup survives a crash.
- **Restore path** — the template ships a `restore_from_backup(backup_dir)` method that reads every `<script>.<table>.NNN.csv` and applies the recorded rows back to their source tables. Subclasses override `apply_restore_row(table, row)` to define how a row is restored (usually `UPDATE … WHERE pk = …`).

Subclasses opt into backups by overriding `tables_touched()` + `snapshot(item)`. Skip the override only when the operation is genuinely non-destructive (additive flags, `INSERT` only, idempotent flips). If unsure, back up.

**Information loss is not acceptable.** If a script can't safely back up the data it's about to mutate (e.g. the column it's about to overwrite is already destroyed by the previous half-run), stop and surface the problem to the user before continuing.

### 6. Background-runnable + interruption-safe

Scripts run for hours. Users tail them, walk away, lose SSH, hit Ctrl-C, get OOM-killed. The template handles all of these — but *how* it handles them depends on the active `Runtime` adapter (see "Runtime adapters" below).

The default `LocalRuntime` (plain CLI invocation) provides:

- A lease file at `<log_dir>/<script_name>/lease.pid` so the user can `nohup` / `&` / `tmux` / `systemd-run` and a second invocation refuses to start while the first is alive.
- SIGINT + SIGTERM handlers that set a stop flag — the main loop finishes the current item, flushes CSV writers + log handlers + uploads, releases the lease, then exits 0. **No partial writes left in flight.** A second signal during shutdown force-exits.
- A `--status` mode that reads the lease + processed-items log + tail of the run log and prints a summary, so a second shell can monitor without disturbing the runner.

Stack-specific runtimes (Medplum bot, Vercel Function, Lambda, K8s Job) replace these mechanisms with the equivalents their surface provides — bot cancellation token, function abort signal, pod termination handler. The contract — "stop must finish current item then flush + upload" — is enforced regardless of surface.

Document the actual launch invocation in the script's `README.md` (auto-generated in the per-script folder) so the operator doesn't have to figure it out from memory. Example for `LocalRuntime`:

```bash
# Typical background launch
nohup python scripts/one_off/2026-05-06-backfill-tenant-flag/script.py --apply > /dev/null 2>&1 &

# Monitor from another shell
python scripts/one_off/2026-05-06-backfill-tenant-flag/script.py --status
tail -f .vinta-ai-workflows/one-off-runs/2026-05-06-backfill-tenant-flag/run.log

# Interrupt safely
kill -TERM "$(cat .vinta-ai-workflows/one-off-runs/2026-05-06-backfill-tenant-flag/lease.pid)"
```

### 7. Logs everywhere — console + filesystem + remote sink

The template wires a single logger through the runtime's log sink. For `LocalRuntime`:

- **Console** (stdout) for live tailing.
- **Filesystem** at `<log_dir>/<script_name>/run.log` (line-buffered, fsync'd every `fsync_every` items). Survives interruption — that's the recovery target if remote upload fails.
- **Remote (S3 by default)** under `s3://<bucket>/<prefix>/<script_name>/`, covering `run.log` + `processed.txt` + every CSV backup chunk. Uploaded on clean exit AND on signal-driven shutdown (the engine calls `runtime.upload_run_artifacts()` from the `finally` block). Bucket + prefix come from env vars (`ONE_OFF_S3_BUCKET`, `ONE_OFF_S3_PREFIX`) or `.vinta-ai-workflows.yaml` — never hardcoded.

If remote upload isn't configured or fails, the upload is logged and skipped — the filesystem copy is still authoritative. Don't fail the script just because the bucket is unreachable. The whole point of the on-disk copy is that it's the ground truth.

Stack-specific runtimes can swap the remote sink (Vercel Blob, GCS, Azure Blob, none) — the contract stays the same: at-least-once durable upload of every artifact in the run dir, on any kind of exit.

## Authoring a new script — the canonical flow

### Step 1 — Interrogate the user (NON-NEGOTIABLE)

Use `AskUserQuestion` for the closed-form questions; iterate plain prose for the open ones.

1. **What does the script do, in one paragraph?** Open prose. The output is the `describe()` body.
2. **Target rows — what's the SELECT?** Concrete: table, filter predicate, ordering. The agent translates this into the `iter_targets()` body. If the user can't write the SELECT confidently, push back — they don't have a clear enough picture to safely run the script yet.
3. **Per-item action — destructive or additive?** `AskUserQuestion`:
   - `Additive only (INSERT new rows / set previously-NULL column / no overwrite)` → no backup needed.
   - `Destructive (UPDATE overwriting an existing value, DELETE, column type change)` → backup required.
   - `Mixed` → treat as destructive, ask for the columns being overwritten.
4. **Idempotency strategy?** `AskUserQuestion`:
   - `State-based (the WHERE clause naturally excludes already-done rows)`.
   - `Resume log (track processed item ids; skip on rerun)`.
   - `Both`.
5. **Batch size?** `AskUserQuestion` — typical: `100`, `500`, `1000`, `5000`. Default 500. Smaller for wide rows / contended tables; larger for narrow rows / off-peak runs.
6. **Concurrency?** `AskUserQuestion`:
   - `Single-process (default)`.
   - `Multi-worker (pool of N workers reading the same queue)` — only when the user says so. Adds locking + "claim" semantics; many scripts don't need it. Default no.
7. **Expected runtime + when?** Open prose. If "off-peak only", note it in the script header and refuse to start if `--apply` is invoked during the project's defined peak window (when known).
8. **Rollback expectation?** `AskUserQuestion`:
   - `No rollback — backup is the safety net (default for one-off scripts)`.
   - `Custom rollback path — describe`.

After answers stabilize, read back the plan in 5–10 lines and confirm with one final `AskUserQuestion`: `Looks good — write it`, `Some corrections (I'll list)`, `Stop, rethink`. Only proceed on `Looks good`.

### Step 2 — Pick the language template

The skill ships these `BaseOneOffScript` templates under [resources/](resources/):

- [resources/one_off_script_base.py](resources/one_off_script_base.py) — Python (Django, plain SQLAlchemy, raw psycopg). Pick this for any Django / Python repo.
- [resources/one_off_script_base.ts](resources/one_off_script_base.ts) — TypeScript (Node 20+, works with Prisma, Drizzle, Knex, raw `pg`). Pick this for TS / Node repos.

Use the project's actual language. If both apply (polyglot monorepo), pick the one that owns the target table.

The base class is staged once per project at `<scripts_dir>/_base.py` (or `.ts`) — default `<scripts_dir>` is `scripts/one_off/`. The skill checks for it and prompts to copy if missing. Re-copy is allowed (and idempotent) when the base class has been updated by a `vinta-sync-ai-tools` run.

### Step 3 — Generate the per-script folder

Folder name: `<YYYY-MM-DD>-<descriptive-kebab>/`

- Date prefix is the day the script is *authored*, not the day it runs. Don't backdate, don't post-date.
- Description is verb-led, kebab-case, says what the script does — not why. `2026-05-06-backfill-tenant-flag/`, not `2026-05-06-customer-X-fix/` (which rots — who's customer X in 6 months?).
- Lives at `<scripts_dir>/<folder>/` (default `scripts/one_off/<folder>/`; override via `skills.add-one-off-script.scripts_dir` in `.vinta-ai-workflows.yaml`).
- **Must** be checked into git on its own branch + committed alongside any related plan / spec doc. The folder is documentation; it's the only record of what was actually done to production data.

Folder layout this skill produces:

```
<scripts_dir>/<YYYY-MM-DD>-<name>/
├── script.{py,ts}       ← the BaseOneOffScript subclass — this skill writes it
├── test_script.{py,ts}  ← unit test exercising dry-run / apply / idempotency / restore — this skill writes it
└── README.md            ← run / monitor / interrupt / restore commands — this skill writes it
```

A sister `run-one-off-script-<stack>` skill, when invoked next, adds the runner artefact in the same folder — `runner.ipynb` (Jupyter), `bot.ts` (Medplum), `route.ts` (Vercel Function), `management/commands/<name>.py` (Django mgmt command), etc. Run logs + CSV backups land separately under `<log_dir>/<name>/` (default `.vinta-ai-workflows/one-off-runs/<name>/`, gitignored) so an interrupted run never pollutes the source folder.

The new script subclasses `BaseOneOffScript` and overrides only:

- `describe(self) -> str` — one-paragraph why + what.
- `iter_targets(self) -> Iterator[T]` — chunked, generator-only.
- `process(self, item: T) -> None` — the per-item action. Uses `self.dry_run` before any write.
- `item_id(self, item: T) -> str` — the resume key.
- `tables_touched(self) -> list[str]` + `snapshot(self, item: T) -> dict[str, dict]` — only when destructive.
- `apply_restore_row(self, table, row)` — only when restore is wanted (most scripts skip this; users invoke restore manually if needed).

Don't override the engine methods (`run`, `execute`, `_safe_process`, `_write_backup`). They're the contract. **Don't** subclass to swap signal handlers / log sinks / upload paths either — that's what the `Runtime` interface is for (next section).

### Step 4 — Write the unit test

Every one-off script ships with at least one test (`test_script.{py,ts}` in the same per-script folder) that:

1. Runs `execute(dry_run=True)` against a fixture and asserts no DB writes happened (count rows, snapshot table state, compare).
2. Runs `execute(dry_run=False)` and asserts the expected mutation.
3. Runs `execute(dry_run=False)` **twice** and asserts the second run is a no-op (idempotency).
4. For destructive scripts: simulates a mid-run interrupt, then `restore_from_backup()` and asserts state matches pre-run.

Tests should construct the script with an in-memory test runtime (a `Runtime` subclass that uses tmpfs paths + `noop` for upload) so the test suite doesn't write to the project's real `<log_dir>`. Most projects already have a fixture for this — derive-skills will draft one in [resources/foundation-skills/add-one-off-script/resources/test_runtime.py](resources/) when teams ask for it.

### Step 5 — Write the per-folder `README.md`

The folder's `README.md` carries everything the operator needs to run the script without reading the body:

- One-paragraph description (same as `describe()`).
- Author + date + linked spec / plan / ticket.
- Active `Runtime` adapter (LocalRuntime, JupyterRuntime, MedplumBotRuntime, …) — and therefore which sister skill manages the runner artefact.
- Exact launch + monitor + interrupt + restore commands (see [Background-runnable + interruption-safe](#6-background-runnable--interruption-safe) above; sister skill replaces these with surface-specific commands).
- Expected runtime + safe time-of-day.
- What "done" looks like — the SELECT that returns 0 rows when the script has finished.

### Step 6 — Dispatch the sister `run-one-off-script-<stack>` skill (optional)

If the project has a sister skill for the active stack and the user opted in at Step 0, dispatch it now. It runs in the same per-script folder and adds the runner artefact + (if applicable) a stack-specific `Runtime` adapter at `<scripts_dir>/_runtime_<stack>.{py,ts}`. The sister skill returns its own status report — surface that to the user before exiting.

If no sister skill exists for the stack, fall back to `LocalRuntime` (already wired in by Step 3) and document the plain-CLI launch in the README.

## Runtime adapters

`BaseOneOffScript` is runtime-agnostic by design. Every concern that depends on *where* the script runs goes through a `Runtime` interface:

| Concern | `Runtime` method | What it does |
|---|---|---|
| Single-instance lease | `acquire_lease()` / `release_lease()` | Refuse to start while another run holds the lease; release on exit. |
| Stop signal | `install_stop_handler(on_stop)` / `should_stop()` | Wire the runtime's interrupt source (POSIX signal, bot cancel, function abort) so the engine breaks the loop cleanly. |
| Logging | `log(level, message)` / `fsync_log()` | Emit one structured line; durable flush on demand. |
| Resume tracking | `load_processed_ids()` / `mark_processed(id)` | Persist completed item ids so re-runs skip them. Crash-safe. |
| Backup artifacts | `artifact_path(name)` / `list_run_artifacts()` | Where CSV chunks land; what the engine considers "this run's output". |
| Final upload | `upload_run_artifacts()` | Copy run dir to durable storage (S3, Blob, GCS, none). Failure logged but not fatal. |

The skill ships **`LocalRuntime`** as the default, suitable for any plain CLI invocation: filesystem run dir, PID-file lease, `SIGINT` / `SIGTERM` stop handlers, optional S3 upload via `boto3` / `@aws-sdk/client-s3`. It's what every script gets out of the box; sister skills override only the methods their surface needs to change.

Stack runner skills typically ship one of:

- **`JupyterRuntime`** (Django + Jupyter) — overrides `install_stop_handler` to listen on `IPython.kernel.interrupt`; `acquire_lease` is a no-op (notebook = single instance by construction); logs to a notebook output cell + the same filesystem run dir.
- **`DjangoMgmtRuntime`** (Django + `manage.py`) — same as `LocalRuntime` but the runner artefact is a `BaseCommand` subclass + the script runs inside the management-command's `handle()`. Lease + signals work as in `LocalRuntime`.
- **`MedplumBotRuntime`** (Medplum) — runs inside a Medplum bot. `acquire_lease` is a no-op (Medplum guarantees single instance). `install_stop_handler` listens for the bot's cancellation token. `log` writes to `bot.log()` + an in-memory buffer that uploads to Medplum Binary on exit. CSV backups uploaded to Medplum Binary too — no FS access from inside a bot.
- **`VercelFunctionRuntime`** (Next.js / Vercel) — runs inside a Function or Cron. `install_stop_handler` listens for the function abort signal. `log` writes to stdout (Vercel collects automatically). Backups upload to Vercel Blob. Watch the timeout — long backfills must chunk into multiple Function invocations driven by Vercel Queues, not one giant run.
- **`K8sJobRuntime`** — runs as a Job. `install_stop_handler` listens for SIGTERM (Kubernetes sends it on pod termination, then SIGKILL after `terminationGracePeriodSeconds`). Uploads to the project's object store.

Sister skills are responsible for documenting their adapter's limits — e.g. "VercelFunctionRuntime has a 300s timeout; jobs longer than that must be chunked".

When in doubt, start with `LocalRuntime`. It's the lowest-common-denominator and works on any developer machine.

## Pitfalls

- **"I'll just run it once, the dry-run is overkill."** No. Dry-run also documents intent — the operator can read the dry-run output and decide whether the script's plan matches what they thought it would do. Keep it.
- **"I'll skip the backup, the operation is reversible."** Reversible *if you wrote the rollback*. The CSV backup IS the rollback. Don't skip.
- **"I'll just `psql -c 'UPDATE …'` instead of writing a script."** Loses logs, loses backup, can't be reviewed in PR, can't be re-run. Push back.
- **"Backup file got too big, let me gzip it."** Don't compress on the fly — restoration becomes a new failure mode. The 1M-cell chunking exists so individual files stay under sane sizes. If the user really needs gzip, gzip the backup *directory* after the run completes successfully, separately.
- **Forgetting to commit the script.** It's the only audit trail. Even when the script is "done", commit it. Future-you needs to be able to git blame the row that's now wrong.
- **Backdating filenames to make them sort earlier.** Sort order isn't worth lying about authorship date. Use today's date.
- **Multiple scripts touching the same rows in the same run.** Coordinate or stop. The template doesn't enforce cross-script ordering; that's the operator's job.
- **Reusing the same script name across runs ("I'll just rerun it next week with different params").** Make a new dated script. The old one's logs + backups are evidence of what happened on day X; don't overwrite them.

## Verification

After the skill produces a new script folder:

1. Folder lives at `<scripts_dir>/<YYYY-MM-DD>-<name>/` and starts with the authoring date. Folder contains `script.{py,ts}` + `test_script.{py,ts}` + `README.md`.
2. `README.md` lists: description, owner, active `Runtime` adapter, launch + monitor + interrupt + restore commands, expected runtime + safe time-of-day, "done" SELECT.
3. The class subclasses `BaseOneOffScript` and overrides only the documented hook methods. No engine method is overridden.
4. `execute(dry_run=True)` is the default; `--apply` (or stack-specific equivalent the sister skill chose) is the only switch to disable it.
5. `iter_targets()` returns a generator (Python) / `AsyncIterable` (TS) — no `.all()`, no `cursor.fetchall()`.
6. Destructive scripts override `tables_touched()` + `snapshot()`; additive scripts explicitly comment why no backup is needed.
7. `test_script.{py,ts}` exercises all four cases from Step 4 and constructs the script with a test runtime, never the real `LocalRuntime`.
8. Base class file (`<scripts_dir>/_base.py` / `.ts`) exists in the repo. If missing, the skill copied it from [resources/](resources/) before generating the script.
9. If a sister `run-one-off-script-<stack>` skill ran, the per-script folder also contains the runner artefact (notebook / bot / route / mgmt command) and the project's stack-specific `Runtime` adapter (if any) lives at `<scripts_dir>/_runtime_<stack>.{py,ts}`.
10. CI lint + type-check pass on every new file.
11. A quick dry-run on a small fixture prints the planned operations; a quick apply on the same fixture mutates as expected; a second apply is a no-op. Run dir under `<log_dir>/<name>/` contains `run.log`, `processed.txt`, and (for destructive scripts) `<table>.NNN.csv` chunks.
