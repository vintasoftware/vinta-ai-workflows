---
plan_id: <plan-id>                       # filename feature portion, kebab-case
feature_name: <FEATURE_NAME>             # UPPERCASE_WITH_UNDERSCORES, matches plan/spec
phase_id: <phase-id>                     # e.g. "1", "4a"
phase_title: <phase title>               # verbatim from plan §5
branch: plan/<feature-kebab>/phase-<id>  # branch the PR opens from
base: <main | plan/<feature-kebab>/phase-<prev-id>>  # target branch for the PR
created_at: <ISO 8601 timestamp>
status: pending                          # `pending` until published; `published` after CLI run
pr_url:                                  # set by open-pr-from-context after publishing
---

# Title

<single-line PR title — follow project commit style; keep ≤72 chars>

# Description

<Markdown body. Reference the plan + phase. Summarize what changed and why.
Do NOT restate every diff — that's what `git diff` is for. Cover:

- Phase goal in one line.
- Decisions that aren't obvious from the diff (cite plan §1, §2 entries).
- Feature-flag behavior (off-flag = pre-feature, per plan §2).
- Anything reviewers will ask about that the diff doesn't answer.

Close with the standard footer if the project uses one (test plan, screenshots, etc.).>

# Comments

The agent picks **non-obvious** spots in the diff that benefit from a one-paragraph
context note — typically 3–10 per phase. Skip everything that's already obvious
from the diff itself or from AGENTS.md conventions.

```yaml
- file: <relative path from repo root>
  start_line: <line number on the new side>
  end_line: <optional; omit for single-line>
  side: RIGHT                             # RIGHT = new code (default). LEFT = pre-change code (rare).
  body: |
    <1–3 lines. Why this code looks the way it does. Reference plan/spec section
    when the decision lives there. Don't restate the code — explain the constraint.>

- file: <relative path>
  start_line: <number>
  body: |
    <next comment...>
```

## What counts as "non-obvious"

- A subtle invariant the diff relies on (e.g. "this query is intentionally not
  inside the tenant filter — see §2.3").
- A workaround for a known framework bug or library limitation.
- A naming choice driven by an upstream contract (don't rename, will break X).
- The off-flag short-circuit when a feature flag is in §2.
- Why a seemingly-cleaner refactor wasn't made (out of scope per §1 Non-goals).
- Cross-phase coupling (this hook will be consumed by phase 3).

## What does NOT need a comment

- Lint / format changes.
- Boilerplate matching nearby files.
- Standard patterns documented in AGENTS.md.
- Test bodies whose names already describe the assertion.
