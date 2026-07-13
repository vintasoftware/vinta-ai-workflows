---
# yaml-language-server: $schema=./node_modules/vinta-ai-workflows/schemas/prs-context-frontmatter.v1.schema.json
schema_version: 1                        # see schemas/prs-context-frontmatter.v1.schema.json
plan_id: <plan-id>                       # filename feature portion, kebab-case
feature_name: <FEATURE_NAME>             # UPPERCASE_WITH_UNDERSCORES, matches plan/spec
phase_id: <phase-id>                     # e.g. "1", "4a"
phase_title: <phase title>               # verbatim from the plan's Phased Rollout section
branch: plan/<feature-kebab>/phase-<id>  # branch the PR opens from
base: <main | plan/<feature-kebab>/phase-<prev-id>>  # PR target branch. Stacked: FIRST phase = default branch; every LATER phase = the PREVIOUS phase's branch (not the default branch). Modular / single-PR: default branch.
created_at: <ISO 8601 timestamp>
status: pending                          # `pending` until published; `published` after CLI run
pr_url:                                  # set by open-pr-from-context after publishing
---

# Title

<single-line PR title — follow project commit style; keep ≤72 chars>

# Description

<Markdown body. **Body shape is dictated by `project.pr_template_paths` in
`.vinta-ai-workflows.yaml`:**

- **One template path** → follow that template's section structure verbatim.
  Fill each section with phase-specific content. Preserve every
  `<!-- HTML comment -->` placeholder. Tick checklist items the diff actually
  satisfies; leave the rest unticked. Don't strip sections you can't fill —
  leave the template's prompt untouched.
- **Multiple template paths** (project has a `PULL_REQUEST_TEMPLATE/` directory
  on GitHub or `merge_request_templates/` on GitLab) → the orchestrator picks
  one (cached in tracking under `run_options.pr_template_used`) and uses its
  structure here.
- **Empty array** (no project template) → free-form. Default sections:
  - `## Summary` (1–3 sentences).
  - `## Plan reference` (link to `{{PLAN_DIR}}/<plan-file>` + phase id).
  - `## Test plan` (commands the reviewer can run).

In every case, cover:

- Phase goal in one line.
- Decisions that aren't obvious from the diff (cite the plan's **Goals + Non-goals** / **Guiding Decisions** entries — by name, never with `§` shorthand).
- Feature-flag behavior (off-flag = pre-feature, per the plan's **Guiding Decisions** entry).
- Anything reviewers will ask about that the diff doesn't answer.

Don't restate every diff — that's what `git diff` is for.>

# Comments

The agent picks **non-obvious** spots in the diff that benefit from a one-paragraph
context note — typically 3–10 per phase. Skip everything that's already obvious
from the diff itself or from AGENTS.md conventions.

YAML inside this fence is validated against
[`schemas/prs-context-comments.v1.schema.json`](../../../../schemas/prs-context-comments.v1.schema.json).

```yaml
# yaml-language-server: $schema=../../../../node_modules/vinta-ai-workflows/schemas/prs-context-comments.v1.schema.json
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
  inside the tenant filter — see the **Guiding Decisions** row on tenant scoping").
- A workaround for a known framework bug or library limitation.
- A naming choice driven by an upstream contract (don't rename, will break X).
- The off-flag short-circuit when a feature flag is in **Guiding Decisions**.
- Why a seemingly-cleaner refactor wasn't made (out of scope per **Goals + Non-goals**).
- Cross-phase coupling (this hook will be consumed by phase 3).

## Never use `§N` shorthand

Plan sections have **names** (`Goals + Non-goals`, `Guiding Decisions`, `Data Model Changes`, `Phased Rollout`, `Risk & Rollout Notes`, `Open Questions`, `Touch List`). Use the names. `§1`, `§2.3`, `§5` etc. force the reader to flip back to the plan and count headings — that's friction. Title + section name is unambiguous and survives renumbering.

## What does NOT need a comment

- Lint / format changes.
- Boilerplate matching nearby files.
- Standard patterns documented in AGENTS.md.
- Test bodies whose names already describe the assertion.
