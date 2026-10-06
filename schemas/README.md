# Schemas

JSON Schema (Draft 2020-12) contracts for every YAML or JSON payload the vinta-ai-workflows toolchain produces or consumes. Every payload carries a `schema_version` integer at its top level; that integer matches the suffix on the schema filename.

## Inventory

| Artifact | YAML location in target project | Schema file | Authored by | Read by |
|---|---|---|---|---|
| Project config | `.vinta-ai-workflows.yaml` (repo root) | [`vinta-ai-workflows-config.v1.schema.json`](vinta-ai-workflows-config.v1.schema.json) | `vinta-bootstrap-ai-tools` (initial) → `vinta-sync-ai-tools` (updates) | every builder skill, every template render, every meta-skill ; `vinta-ai-maestro` reads `commands` + `maestro` and layers every workflow over them |
| Sub-agent definition | `ai-tools/agents/<name>.yaml` | [`sub-agent.v1.schema.json`](sub-agent.v1.schema.json) | `vinta-derive-subagents` | `setup-ai-tools.mjs` (emits per-vendor copies) |
| PR-context frontmatter | top-of-file YAML in `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md` | [`prs-context-frontmatter.v1.schema.json`](prs-context-frontmatter.v1.schema.json) | `implement-plan` / `amend-plan` | `open-pr.sh` |
| PR-context inline comments | YAML inside the ` ```yaml ... ``` ` fence under `# Comments` of the same file | [`prs-context-comments.v1.schema.json`](prs-context-comments.v1.schema.json) | `implement-plan` / `amend-plan` | `open-pr.sh` |
| MCP preflight cache | `.vinta-ai-workflows/cache.yaml` (gitignored — per-developer-machine state) | [`mcp-preflight-cache.v1.schema.json`](mcp-preflight-cache.v1.schema.json) | rendered `systematic-debugging` SKILL.md (writes during Phase 0) | rendered `systematic-debugging` SKILL.md (reads at Phase 0 start) |
| Interview round | `.vinta-ai-workflows/interviews/<slug>/rounds/round-NN.json` (gitignored working trail; JSON, not YAML) | [`interview-round.v1.schema.json`](interview-round.v1.schema.json) | the skill running the interview (`create-spec` Step 0 via `interview-ui`) | `interview-ui` server + shell (`ai-tools/skills/interview-ui/`) |
| Interview answers | `.vinta-ai-workflows/interviews/<slug>/answers/round-NN.json` (gitignored; JSON) | [`interview-answers.v1.schema.json`](interview-answers.v1.schema.json) | `interview-ui` server, on browser submit | the skill running the interview (reads answers, writes the next round) |
| AI model tier table | `ai-tools/skills/plan-feature/resources/ai-models.yaml` (shipped verbatim with the `plan-feature` foundation skill; source: `skills/vinta-derive-skills/resources/foundation-skills/plan-feature/resources/ai-models.yaml`) | [`ai-models.v1.schema.json`](ai-models.v1.schema.json) | nightly `check-ai-models` job ([`scripts/check-ai-models.mjs`](../scripts/check-ai-models.mjs)) → auto-PR | `plan-feature` (per-phase model suggestion) |
| Workflow (executable plan) | `ai-plans/YYYY-MM-DD-<feature-kebab>.workflow.json` — **JSON, not YAML** | [`workflow.v1.schema.json`](workflow.v1.schema.json) | `plan-feature` (emitted alongside the human-readable plan) | `vinta-ai-maestro` (the orchestrator daemon) |
| Plan post-mortem | `.vinta-ai-maestro/runs/<run-id>/postmortem.json` — **JSON, not YAML**; per-run state beside the frozen workflow, copied to `ai-plans/<feature-kebab>.postmortem.json` when a team wants it committed | [`postmortem.v1.schema.json`](postmortem.v1.schema.json) | `vinta-ai-maestro` (once a run has ended) | `plan-feature` (when planning the next feature in the same repo) |
| Plan review | `ai-plans/YYYY-MM-DD-<feature-kebab>.review.json` — **JSON, not YAML**; beside the plan and its workflow, committed with them | [`plan-review.v1.schema.json`](plan-review.v1.schema.json) | the `vinta-ai-maestro` review page (a person's comments, messages, approval) and `vinta-ai-maestro review reply` (the agent's answers) | `plan-feature`, through `vinta-ai-maestro review wait` |
| Monitor intervention | not a file the user writes — the document the run's monitor answers with when a watchdog wakes it, recorded per attempt at `.vinta-ai-maestro/runs/<run-id>/interventions.jsonl` | [`intervention.v1.schema.json`](intervention.v1.schema.json) | the run monitor (`vinta-ai-maestro`, when a phase or a gate crosses a threshold) | `vinta-ai-maestro` (validates it, then applies it through §9's amend path) |

> **Four of these are generated, not hand-written**: `workflow.v1`, `postmortem.v1`, `intervention.v1` and `plan-review.v1`. The workflow's source of truth is `packages/vinta-ai-maestro/src/types.ts`; regenerate with `pnpm --filter vinta-ai-maestro schema:gen` and verify with `schema:check`. The post-mortem's is `src/postmortem/postmortem.ts`, the intervention's is `src/intervention/intervention.ts` and the plan review's is `src/review/document.ts`; regenerate any of them with `pnpm --filter vinta-ai-maestro <postmortem|intervention|review>:schema:gen`, verify with `:schema:check` — `tests/postmortem.test.ts`, `tests/intervention.test.ts` and `tests/review.test.ts` run those byte comparisons too. Edit the zod schemas, never the JSON.
>
> The intervention schema is the odd one: it validates a document a *model* writes rather than one a skill or a person does, and it is the boundary that decides what an unattended run may change about itself. Its verbs are deliberately few and deliberately cannot express a change to what a phase builds — see [`docs/monitor-intervention.md`](../packages/vinta-ai-maestro/docs/monitor-intervention.md).

## Versioning rules

Each schema file carries its own major version. The major appears in the filename (`*.vN.schema.json`) and in the YAML payload's `schema_version` field.

- **Adding an optional field** → no version bump. Update the schema in place.
- **Adding a required field** → only allowed at vN+1 (breaking). Bump major, ship `vN+1.schema.json` alongside `vN.schema.json`. Both files stay in the repo so old projects can validate; `vinta-sync-ai-tools` migrates payloads forward.
- **Removing or renaming a field** → bump major. Same as above.
- **Tightening an enum** (removing a permitted value) → bump major. New enum lands in vN+1.
- **Loosening an enum / pattern** (allowing more values) → no bump.
- **Changing the meaning of a field without changing its shape** → bump major even when the shape is identical. The schema is a contract; semantics is part of it.

When you bump the major:

1. Copy `<artifact>.vN.schema.json` to `<artifact>.v(N+1).schema.json`.
2. Modify the new file. Set `schema_version.const` to `N+1`.
3. Add a migration step in `vinta-sync-ai-tools` covering the diff between vN and vN+1.
4. Document the breaking change in [CHANGELOG.md](../CHANGELOG.md).

## IDE wiring

Add the schema directive to the top of any YAML file you author by hand. Editors with the Red Hat YAML extension (VS Code, Cursor) auto-validate against the URL.

```yaml
# yaml-language-server: $schema=https://github.com/vintasoftware/vinta-ai-workflows/schemas/vinta-ai-workflows-config.v1.schema.json
schema_version: 1
vinta_ai_workflows_version: 0.1.2
# ...
```

For PR-context files (markdown with YAML frontmatter), the directive goes inside the frontmatter block:

```markdown
---
# yaml-language-server: $schema=https://github.com/vintasoftware/vinta-ai-workflows/schemas/prs-context-frontmatter.v1.schema.json
schema_version: 1
plan_id: checkout-flow
# ...
---

# Title
...
```

Local-path schemas work too if the project has the `vinta-ai-workflows` clone vendored:

```yaml
# yaml-language-server: $schema=./node_modules/vinta-ai-workflows/schemas/vinta-ai-workflows-config.v1.schema.json
```

Authoring tools (`vinta-bootstrap-ai-tools`, `vinta-derive-subagents`, `implement-plan`, `amend-plan`) embed the directive when they emit a fresh file.

## Validation in CI

Optional but recommended. Any of the standard tools work:

```bash
# Check the project config (uses ajv-cli + js-yaml)
npx -y ajv-cli validate \
  -s schemas/vinta-ai-workflows-config.v1.schema.json \
  -d .vinta-ai-workflows.yaml

# Check every sub-agent
for f in ai-tools/agents/*.yaml; do
  npx -y ajv-cli validate \
    -s schemas/sub-agent.v1.schema.json \
    -d "$f"
done
```

For PR-context frontmatter, extract the YAML block first (`yq` does this cleanly), then validate.

## Checking the schemas themselves (this repo only)

`npm run validate-schemas` (also part of `npm test`) compiles every schema here under Ajv's strict Draft 2020-12 mode and checks the fixtures in `tests/schema-fixtures/<schema-file-stem>/`: everything under `valid/` must pass, everything under `invalid/` must fail. A fixture is `.json`, `.yaml` / `.yml`, or a `.md` file whose YAML frontmatter is the payload. **A conditional rule (`if` / `then`) needs an `invalid/` fixture for each branch it enforces** — a lenient validator ignores a broken one silently. Pass file paths instead to validate payloads against the schema their `$schema` key or `yaml-language-server` comment names.
