# Fixtures

Seeded, reproducible repos the scenarios run against. Each fixture is a real app
(not a toy) so the workflows are exercised on representative code.

## Contents of a fixture

```
<fixture>/
  fixture.json         # metadata: stack, run/test commands, per-state git refs,
                       #   the version `stale/` was bootstrapped from
  vendor.mjs           # builds the clean/stale/current states on demand
  tasks/               # seeded task inputs + their canned answers (ground truth)
    feature.md   feature.answers.md
    bug.md       bug.answers.md
    script.md    script.answers.md
    bootstrap.md bootstrap.answers.md
    sync.md      sync.answers.md
  states/              # (gitignored) built by vendor.mjs — each is its own git repo
    clean/    stale/    current/
```

## Three committed states (PLAN §4)

- **`clean/`** — app with no `ai-tools/` / `AGENTS.md` / vendor dirs → drives **S0**.
- **`stale/`** — app bootstrapped against an **older** package version → drives **S1**.
- **`current/`** — app bootstrapped against the **current** version → drives **S2–S4**.

States are **not committed** to this repo — they're built by `vendor.mjs` and
gitignored. Each state is materialized as its own git repo so the runner can
clone it into an isolated copy and the git-tree grader has a real base to diff.

## Design rules

- Fixture states are **frozen** (pinned upstream commit + committed state).
- Every run operates on an **isolated copy** — never the vendored fixture in place.
- Every task has a **machine-checkable** success signal so grading isn't subjective.

## Maintenance

- Re-base `stale/` to "current minus one meaningful change" each release so the
  sync scenario keeps testing a real upgrade (see `fixture.json.maintenance`).
- Keep the pinned upstream commit current enough that the app still builds on the
  supported Node version.

## `medplum-provider` (primary)

Real React + Vite + TS Medplum app; tests run offline against `MockClient`.
Requirements captured in `medplum-provider/fixture.json.medplum`: wire the two
Vitest setup files, keep `@medplum/*` versions matched, Node ≥ 22.4. A live
Medplum stack (Docker) is opt-in and off by default — reserve it for contracts
`MockClient` can't prove.
