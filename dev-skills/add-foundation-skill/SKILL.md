---
name: add-foundation-skill
description: Author a new foundation skill under `skills/vinta-derive-skills/resources/foundation-skills/<name>/` and wire it through every place the orphan-prevention contract requires (schema enum, bootstrap interview, derive-skills bucket, foundation-shape lists, outputs tree, CHANGELOG). Use when the user wants to add a project-agnostic skill that ships verbatim into target projects' `ai-tools/skills/` (or a template-rendered one, or an opt-in ask-first one). Walks the full schema-ripple checklist from `AGENTS.md` so no consumer is left half-wired.
---

# Add a foundation skill

Foundation skills are the project-agnostic skills `vinta-derive-skills` copies (or renders) into every target project's `ai-tools/skills/`. Adding one is a multi-file ripple — easy to half-finish.

This skill enforces the full ripple. Output: a new dir under `skills/vinta-derive-skills/resources/foundation-skills/<name>/` plus updates to four other files plus a CHANGELOG entry.

## Step 0 — Decide the bucket (NON-NEGOTIABLE)

Use `AskUserQuestion`:

- **Bucket A — Copy verbatim**: project-agnostic body that ships as-is. Examples: `plan-feature`, `create-spec`, `create-qa-use-cases`, `open-pr-from-context`, `add-one-off-script`. Pick when the body has no project-specific commands or paths that need substitution.
- **Bucket B — Template-rendered**: body has placeholders (`{{LINT_CMD}}`, `{{TEST_CMD}}`, …) substituted from inventory + interview answers. Examples: `implement-plan`, `amend-plan`, `systematic-debugging`. Pick when project-specific commands or conventions appear in the body.
- **Bucket C — Optional, ask-first**: only ships when the user opts in. Examples: `add-e2e-test`, `add-env-var`, `systematic-debugging`, `add-one-off-script`. Pick when the skill applies to *some* projects (e.g. those with e2e tests).

Buckets compose — `systematic-debugging` is bucket B *and* bucket C.

## Step 1 — Interview the user

Open prose:

1. **What does the skill do?** One paragraph. Becomes the SKILL.md `description:` plus the body's framing section.
2. **When should it trigger?** List the user prompts that should fire it.
3. **What's the output?** What artefact does the skill produce — a doc under `ai-plans/`, a code change, a generated file under `<project>/scripts/`, …
4. **Does the body cite project-specific commands or paths?** Drives bucket A vs B.
5. **Does the body reference other skills?** Cross-link list.

For bucket B: also list every placeholder + its source (inventory field, interview answer, derived).
For bucket C: also draft the bootstrap §D question and follow-up (if any).

## Step 2 — Author the SKILL.md

Path: `skills/vinta-derive-skills/resources/foundation-skills/<name>/SKILL.md`.

Required frontmatter:

```yaml
---
name: <kebab-case>          # MUST match dir name
description: <dense one-liner of what + when, ~3–6 sentences>
---
```

Body structure (~100–300 lines):

```markdown
# <Skill name>

Short framing — what + why.

## Decision questions / Step 0 (when applicable)
Closed-form questions via `AskUserQuestion`; open prose only when free-form.

## Steps (or Checklist)
Numbered, name files + commands.

## Pitfalls
"We got burned by this" list.

## Verification
How to confirm the work is done correctly.
```

For bucket A: scan body for source-repo paths (`<source-repo>/`, `apps/<service>/`, hard-coded tenant column names) — scrub before saving. The body must read cleanly when pasted into an unrelated repo.

## Step 3 — Bundle resources (if any)

If the skill ships templates / scripts, put them under `skills/vinta-derive-skills/resources/foundation-skills/<name>/resources/`. Reference from the SKILL.md via relative links: `[resources/foo.py](resources/foo.py)`.

For language-specific templates that ship to consumer projects: TS files carry `// @ts-nocheck` (consumer compiles, this repo doesn't); Python files start with `from __future__ import annotations` and only depend on stdlib unless the docstring explicitly justifies a runtime dep.

## Step 4 — Wire the schema (always)

Edit [schemas/vinta-ai-workflows-config.v1.schema.json](../../schemas/vinta-ai-workflows-config.v1.schema.json):

1. Add the enum entry under `foundation_skills.properties`:

   ```json
   "<name>": {
     "description": "<one-liner — what the skill does + how it ships>",
     "type": "string",
     "enum": ["enabled", "disabled"]
   }
   ```

2. **Bucket B / C only**: add the per-skill config block under `skills.properties.<name>` if the skill takes project-level configuration:

   ```json
   "<name>": {
     "description": "Configuration for the `<name>` foundation skill. Required when `foundation_skills.<name>` is `enabled`; ignored otherwise.",
     "type": "object",
     "additionalProperties": false,
     "properties": { ... }
   }
   ```

Validate with `python3 -c "import json; json.load(open('schemas/vinta-ai-workflows-config.v1.schema.json'))"`.

## Step 5 — Wire `vinta-derive-skills`

Edit [skills/vinta-derive-skills/SKILL.md](../../skills/vinta-derive-skills/SKILL.md):

- **Bucket A**: add a row to the bucket-A table.
- **Bucket B**: add a row to the bucket-B list AND add any new placeholders to the placeholder table. Place the rendered template at `skills/vinta-derive-skills/resources/<name>-template.md`.
- **Bucket C**: add a row to the bucket-C table.

Also add `<name>` to:
- The `foundation-shape` skill name list under "Reconcile against existing skills" (Replace-with-Vinta-foundation-version option gates on this list).
- The "Optional skills … gated by user answer" rule under Rules (bucket C only).

## Step 6 — Wire `vinta-bootstrap-ai-tools`

Edit [skills/vinta-bootstrap-ai-tools/SKILL.md](../../skills/vinta-bootstrap-ai-tools/SKILL.md):

- **Bucket C**: add a §D question. Numbering matters — append after the last existing question, increment the "Four skills are part of the foundation set" header count if needed. Document any follow-up questions that capture per-skill config.
- **All buckets**: update the `foundation_skills:` block in the Step 0.5 YAML example (add `<name>: <enabled | disabled>`).
- **Bucket C with config**: also extend the `skills:` block in the Step 0.5 YAML example.
- **Outputs tree**: append `│   ├── <name>/SKILL.md` (and `│   │   └── resources/...` if applicable) to the `ai-tools/skills/` listing.
- **Foundation skills break into three buckets** paragraph: add `<name>` to the appropriate bucket's name list.
- **§E foundation-shape list** in the `Replace with Vinta foundation version` option: add `<name>`.

## Step 7 — CHANGELOG entry

Append under the current in-progress version section (or open a new `[unreleased]` if none exists). Use `### Added` for the new skill. Cross-link the SKILL.md path and any bundled resources. Document the new schema fields explicitly so downstream sync runs notice them. Mention bootstrap interview question additions.

## Verification

1. `python3 -c "import json; json.load(open('schemas/vinta-ai-workflows-config.v1.schema.json'))"` — schema parses.
2. `grep -rn "<name>" skills schemas CHANGELOG.md | wc -l` — counts > 6 (new dir + schema + derive-skills + bootstrap + foundation-shape lists + CHANGELOG).
3. SKILL.md frontmatter `name:` equals dir name.
4. No surviving `{{PLACEHOLDER}}` in bucket A bodies; bucket B placeholders all listed in the derive-skills placeholder table.
5. Every `$schema=...` directive in any sample YAML in the new SKILL.md resolves.
6. Body has no source-repo paths (`<source-repo>/`, `apps/<service>/`).

## Pitfalls

- **Adding the SKILL.md but forgetting the schema enum.** Project bootstrap with the new skill enabled fails schema validation. Catch via Step 4.
- **Adding the schema enum but forgetting the derive-skills bucket entry.** `vinta-derive-skills` runs and silently doesn't ship the skill. Catch via Step 5.
- **Bucket B without extending the placeholder table.** A surviving `{{PLACEHOLDER}}` ships to the target project. Catch via grep on the rendered output before commit.
- **Adding to the `foundation-shape` list in only one of the two places** (derive-skills + bootstrap). The "Replace with Vinta foundation version" option then either appears or doesn't, inconsistently. Update both.
- **Forgetting the outputs tree update in bootstrap.** Cosmetic but signals the skill exists; users reading bootstrap docs miss it.
- **Bucket C with no follow-up question for required config.** The schema has the config block, but bootstrap never populates it — projects start with an empty `skills.<name>: {}`.
