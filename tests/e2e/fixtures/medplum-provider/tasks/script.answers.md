# Canned answers — script (add-one-off-script interview)

Answer every question with the following; do not ask for anything else.

- **Location**: `scripts/one_off_2026_08_01_export_observations/` (dated one-off
  folder per the foundation skill convention).
- **Entry point**: `run.ts`, runnable via `npx tsx scripts/one_off_2026_08_01_export_observations/run.ts`.
- **Data source**: a seeded `MockClient` (in-memory FHIR store) or a bundled
  fixture bundle — never a live server.
- **Default patient**: use a seeded fixture patient when no id is passed.
- **Output**: `out/observations.csv` under the script folder, columns
  `code,value,unit,effectiveDateTime`.
- **Non-interactive**: no prompts; read config from args/env with sane defaults.
- **Commit**: its own `chore(script): ...` conventional commit — do not mix into
  app code.
- **Idempotency/cleanup**: overwrite the CSV on re-run; no external side effects.
