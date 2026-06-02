---
name: bump-schema-major
description: Cut a new major version of a JSON Schema under `schemas/<name>.v<N>.schema.json` → `<name>.v<N+1>.schema.json` for a breaking change (removed required field, narrowed enum, type change). Copies the file, applies the breaking diff to v<N+1>, leaves v<N> in place during the deprecation window, and walks every consumer (skills bodies, `# yaml-language-server: $schema=...` directives, validators, sample payloads) to read both versions or migrate to v<N+1>. Updates `schemas/README.md` inventory and the package SemVer (major bump). Use only for genuinely breaking changes — additive fields and optional new properties belong in v<N> patch / minor releases.
---

# Bump schema major

Schema files are versioned in the filename: `<name>.v<N>.schema.json`. Major bumps are reserved for **breaking** changes:

- Removing a required field.
- Renaming a field without a migration alias.
- Narrowing an enum (removing a previously valid value).
- Changing a field's type (`string` → `array<string>`).
- Tightening `additionalProperties` from `true` to `false` when previously emitted YAML used unknown keys.

Anything additive — new optional field, new enum value, new sub-object with `additionalProperties` permissive enough — belongs in the existing `v<N>` and ships as a minor package release.

## Step 0 — Confirm the change is genuinely breaking

Use `AskUserQuestion`:

- `Yes — fits the breaking-change list above`.
- `Maybe — let me describe; you decide`.
- `No — it's additive` → exit; this skill doesn't apply.

For `Maybe`, prompt for a one-paragraph description and apply the rules above. If the change is additive (new optional field, new enum value), refuse the bump and route the user to the additive-change flow.

If clearly breaking, continue.

## Step 1 — Plan the deprecation window

Use `AskUserQuestion`:

- **Hard cut (no window)**: v<N> deleted in the same release. Pick when v<N> is unreleased or has zero known consumers.
- **One-release window**: v<N> stays, v<N+1> ships, consumers migrate, v<N> deleted next major. Default.
- **Indefinite**: v<N> + v<N+1> coexist forever. Pick only when migration is genuinely impractical (rare).

Hard cut + indefinite both skip the dual-read consumer logic in Step 5. The default (one-release window) requires it.

## Step 2 — Catalogue consumers

Find every file that references `<name>.v<N>.schema.json`:

```bash
grep -rn "<name>.v<N>.schema.json" skills schemas vinta-ai-workflows.mjs README.md CHANGELOG.md
```

Categorise hits:

- **`# yaml-language-server: $schema=...`** lines — IDE directives in skill bodies + sample YAML. Update each to point at v<N+1> when the producer skill writes payloads compliant with v<N+1>.
- **Skill bodies** (`SKILL.md`) describing the schema fields — update language to reflect new contract.
- **CLI / runtime references** (`vinta-ai-workflows.mjs`, foundation-skill templates) — update reads and writes.
- **CI validation snippets** in `schemas/README.md` — update version reference.

Persist this list — Step 5 walks every entry.

## Step 3 — Copy v<N> → v<N+1>

```bash
cp schemas/<name>.v<N>.schema.json schemas/<name>.v<N+1>.schema.json
```

Edit the copy:

- `$id`: change `<name>.v<N>.schema.json` → `<name>.v<N+1>.schema.json`.
- Top-level `description`: append a one-line note pointing at the breaking change.
- `properties.schema_version.const`: bump to `<N+1>`.

Do **not** touch v<N> yet.

## Step 4 — Apply the breaking diff to v<N+1>

Make the breaking changes only in v<N+1>. Document each one in a short comment block at the top of the file (use `description` fields — JSON Schema doesn't support comments, but the top-level `description` field can absorb a multiline string).

Validate:

```bash
python3 -c "import json; json.load(open('schemas/<name>.v<N+1>.schema.json'))"
```

Should parse cleanly. If `ajv-cli` is available locally, validate a known-good v<N+1> payload:

```bash
ajv validate -s schemas/<name>.v<N+1>.schema.json -d /tmp/sample.yaml
```

(Sample payloads usually live next to the schema or inside the consuming skill — find one to use as a regression test.)

## Step 5 — Walk every consumer

For each entry from Step 2:

### 5a. `$schema` directives in skill bodies

Update to point at v<N+1>:

```diff
-# yaml-language-server: $schema=./node_modules/vinta-ai-workflows/schemas/<name>.v<N>.schema.json
+# yaml-language-server: $schema=./node_modules/vinta-ai-workflows/schemas/<name>.v<N+1>.schema.json
```

Any project that has not migrated yet keeps using v<N>; their existing local files are unaffected. New bootstraps emit v<N+1>-compatible YAML.

### 5b. Producer skills

The skill that writes the YAML payload (e.g. `vinta-bootstrap-ai-tools` Step 0.5 emits `.vinta-ai-workflows.yaml`) must:

- Set `schema_version: <N+1>` in the emitted payload.
- Update sample YAML in the SKILL.md body to v<N+1> shape.
- For any field renamed / removed: ensure the bootstrap interview captures the new field, not the old one.

### 5c. Reader code

The CLI (`vinta-ai-workflows.mjs`) and `vinta-sync-ai-tools` skill read these payloads. Update them to:

- Accept either `schema_version: <N>` or `schema_version: <N+1>` during the deprecation window.
- Translate v<N> payloads to the v<N+1> in-memory shape (a `migrateV<N>ToV<N+1>(payload)` helper, near where the payload is loaded).
- Refuse `schema_version` outside `{<N>, <N+1>}` with a clear error.

If hard cut: only v<N+1>; refuse v<N>.

### 5d. CI validation

`schemas/README.md` documents the validation snippets. Update the example commands to reference v<N+1>; keep v<N> mentioned as deprecated until the cut.

## Step 6 — Update `schemas/README.md` inventory

The README has a per-schema table. Add the v<N+1> row; mark v<N> as `(deprecated; remove in vX.0)`.

## Step 7 — CHANGELOG entry

Major package bump (`X.Y.Z` → `X+1.0.0`). Use `### Changed` and `### Removed` (when hard cut) sections.

```markdown
### Changed

- **Schema bump: `<name>` v<N> → v<N+1>.** <one-line of the breaking change>.
  Producers (`<list>`) emit v<N+1>; readers (`<list>`) accept both v<N>
  and v<N+1> through this release and translate on load. v<N> deletion
  scheduled for v<X+2.0.0>. Migration: <one paragraph or pointer>.

### Deprecated

- **`<name>.v<N>.schema.json`** — superseded by v<N+1>. Removal in v<X+2.0.0>.
```

For hard cut: replace `### Deprecated` with `### Removed`, and the consumer-acceptance language with "v<N> is no longer accepted".

## Step 8 — `package.json.version` major bump

Hand off to [release](../release/SKILL.md) — pick `major`. Schema breaks always major.

## Verification

1. Both schema files exist + parse: `python3 -c "import json; [json.load(open(f'schemas/<name>.v{n}.schema.json')) for n in (<N>, <N+1>)]"`.
2. `grep -rn "<name>.v<N>.schema.json" skills` returns only intentional dual-read sites + the deprecation note in `schemas/README.md`.
3. `grep -rn "<name>.v<N+1>.schema.json" skills` returns every producer skill's `$schema` directive + the new READMEs row.
4. A known-good v<N> payload validated under v<N> still parses (backward integrity).
5. A known-good v<N+1> payload validated under v<N+1> parses cleanly.
6. The CLI (or sync skill) loaded against a v<N> payload still works (translation layer present).
7. CHANGELOG entry under the major-bump section, both `### Changed` and `### Deprecated` (or `### Removed`) populated.

## Pitfalls

- **Bumping major for a non-breaking change.** Adds noise to consumers. Use minor for additive fields, even ones that look "big".
- **Forgetting the `properties.schema_version.const` bump.** v<N+1> file still claims to be v<N> — every payload validator instantly mis-routes.
- **Skipping the translation layer.** Dual-read consumers must actually translate v<N> → v<N+1> in memory, not just accept v<N> and pass it through. Otherwise downstream code fails on missing fields.
- **Updating `$schema` directives without bumping the producer's emitted `schema_version`.** YAML claims v<N>, IDE validates against v<N+1> → IDE errors on every file. Keep the two in lockstep.
- **Forgetting `schemas/README.md`.** Inventory drift; future agents reading the README don't know v<N+1> exists.
- **Hard-cutting v<N> on the same release as v<N+1> ships.** Guarantees breakage for any project mid-bootstrap. Default is a one-release window.
- **Doing this without consensus.** A schema major affects every consumer of the package. Confirm with the team before starting; an undo is itself a major bump.
