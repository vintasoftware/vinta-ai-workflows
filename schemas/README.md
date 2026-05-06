# Schemas

JSON Schema (Draft 2020-12) contracts for every YAML file the vinta-ai-workflows toolchain produces or consumes. Every YAML file carries a `schema_version` integer at its top level; that integer matches the suffix on the schema filename.

## Inventory

| Artifact | YAML location in target project | Schema file | Authored by | Read by |
|---|---|---|---|---|
| Project config | `.vinta-ai-workflows.yaml` (repo root) | [`vinta-ai-workflows-config.v1.schema.json`](vinta-ai-workflows-config.v1.schema.json) | `vinta-bootstrap-ai-tools` (initial) → `vinta-ai-workflows-sync` (updates) | every builder skill, every template render, every meta-skill |
| Sub-agent definition | `ai-tools/agents/<name>.yaml` | [`sub-agent.v1.schema.json`](sub-agent.v1.schema.json) | `vinta-derive-subagents` | `setup-ai-tools.mjs` (emits per-vendor copies) |
| PR-context frontmatter | top-of-file YAML in `.vinta-ai-workflows/prs-context/{feature-kebab}/phase-{phase.id}.md` | [`prs-context-frontmatter.v1.schema.json`](prs-context-frontmatter.v1.schema.json) | `implement-plan` / `amend-plan` | `open-pr.sh` |
| PR-context inline comments | YAML inside the ` ```yaml ... ``` ` fence under `# Comments` of the same file | [`prs-context-comments.v1.schema.json`](prs-context-comments.v1.schema.json) | `implement-plan` / `amend-plan` | `open-pr.sh` |
| MCP preflight cache | `.vinta-ai-workflows/cache.yaml` (gitignored — per-developer-machine state) | [`mcp-preflight-cache.v1.schema.json`](mcp-preflight-cache.v1.schema.json) | rendered `systematic-debugging` SKILL.md (writes during Phase 0) | rendered `systematic-debugging` SKILL.md (reads at Phase 0 start) |

## Versioning rules

Each schema file carries its own major version. The major appears in the filename (`*.vN.schema.json`) and in the YAML payload's `schema_version` field.

- **Adding an optional field** → no version bump. Update the schema in place.
- **Adding a required field** → only allowed at vN+1 (breaking). Bump major, ship `vN+1.schema.json` alongside `vN.schema.json`. Both files stay in the repo so old projects can validate; `vinta-ai-workflows-sync` migrates payloads forward.
- **Removing or renaming a field** → bump major. Same as above.
- **Tightening an enum** (removing a permitted value) → bump major. New enum lands in vN+1.
- **Loosening an enum / pattern** (allowing more values) → no bump.
- **Changing the meaning of a field without changing its shape** → bump major even when the shape is identical. The schema is a contract; semantics is part of it.

When you bump the major:

1. Copy `<artifact>.vN.schema.json` to `<artifact>.v(N+1).schema.json`.
2. Modify the new file. Set `schema_version.const` to `N+1`.
3. Add a migration step in `vinta-ai-workflows-sync` covering the diff between vN and vN+1.
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
# yaml-language-server: $schema=./node_modules/@vinta/ai-workflows/schemas/vinta-ai-workflows-config.v1.schema.json
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
