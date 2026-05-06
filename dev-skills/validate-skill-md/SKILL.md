---
name: validate-skill-md
description: Lint every `SKILL.md` under `skills/` (and optionally `dev-skills/`) for the contract any agent runtime expects — frontmatter `name:` matches dir name, `description:` exists and is dense, no surviving `{{PLACEHOLDER}}` strings (except in declared template files), every relative markdown link resolves, every declared `resources/` / `scripts/` path actually exists. Pure read-only — reports findings, exits 1 on errors. Use before committing changes that touched a skill body, or as a quick repo-wide health check. Faster + cheaper than the broader `vinta-update-project-skills` flow.
---

# Validate SKILL.md

Skills are loaded by Claude Code, Codex, Cursor, and Copilot from frontmatter alone — `name:` + `description:` decide whether the skill triggers. Body content is parsed loosely (markdown), but a few invariants exist:

- `name:` must match the directory name (Cursor + Copilot constraint).
- `description:` must be present + non-empty.
- `{{PLACEHOLDER}}` strings should only survive in `*-template.md` files (which `vinta-derive-skills` renders before shipping).
- Relative links should resolve (`[text](relative/path.md)`).
- Bundled resources referenced from the body should exist.

This skill checks all of the above repo-wide.

## Step 0 — Confirm scope

Use `AskUserQuestion`:

- `Skills only (skills/**)` — default; the user-facing surface.
- `Skills + dev-skills (skills/**, dev-skills/**)` — also lint maintenance skills (`add-foundation-skill`, `release`, etc.).
- `One skill (path/to/SKILL.md)` — single-file mode for tight loops.

## Step 1 — Walk the tree

```bash
find skills dev-skills -name SKILL.md -type f 2>/dev/null
```

For each file, read frontmatter + body.

## Step 2 — Per-file checks

For each `SKILL.md`:

### 2a. Frontmatter

Parse the YAML between the first two `---` lines. Required fields:

- `name`: kebab-case string. **Must equal the dir name** (`basename(dirname(path))`).
- `description`: non-empty string. Warn (not error) if shorter than 80 chars or longer than 1500 chars.

Optional but recognised:

- `version`, `tags`, `license` — pass through, don't validate.

Anything else under frontmatter → warn (unknown key).

### 2b. `{{PLACEHOLDER}}` strings

Allowlist: any file whose path matches `*-template.md` is allowed to contain `{{...}}` strings. Specifically:

- `skills/vinta-derive-skills/resources/implement-plan-template.md`
- `skills/vinta-derive-skills/resources/amend-plan-template.md`
- `skills/vinta-derive-skills/resources/systematic-debugging-template.md`
- `skills/vinta-derive-skills/resources/prs-context-template.md`

These are *not* SKILL.md files — they're templates rendered by `vinta-derive-skills`. The lint walker skips them entirely.

For everything else: any string matching `\{\{[A-Z_][A-Z0-9_]*\}\}` is an error. Report file + line.

### 2c. Relative links

Find every `[text](target)` in the body. Skip:

- `http://`, `https://`, `mailto:` — external.
- Anchor-only `(#section)` — same-doc.

For each remaining target:

- Resolve relative to the SKILL.md's dir.
- `existsSync(resolved)` — must be true. Otherwise → error.
- If target ends in `.md`, optionally check that the linked file's frontmatter `name:` matches what's referenced (skill cross-link integrity). Warn if mismatch.

### 2d. Bundled resources

Grep the body for path-shaped strings under `resources/` or `scripts/`:

```
resources/<filename>
scripts/<filename>
```

For each, check the file exists relative to the SKILL.md's dir.

### 2e. Dir name vs frontmatter `name`

Already covered in 2a but called out separately because it's the most common drift.

## Step 3 — Aggregate + report

Collect findings as `(severity, path, line, message)` tuples. Severities:

- `ERROR` — frontmatter malformed, name mismatch, broken link, surviving placeholder, missing declared resource.
- `WARN` — description out of length range, unknown frontmatter key, cross-link `name:` mismatch.

Print grouped by file. Example:

```
skills/vinta-bootstrap-ai-tools/SKILL.md
  ERROR  line 245: link target ../vinta-derive-skills/SKILL.foo (does not exist)
  WARN   description too short (62 chars; recommended 80–1500)

skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/SKILL.md
  ERROR  line 13: surviving placeholder {{TEST_CMD}} (allowlist applies only to *-template.md)
```

Final line:

```
N files checked — E errors, W warnings.
```

Exit 0 if `E == 0`, exit 1 otherwise.

## Step 4 — Suggest fixes

For each ERROR, surface the fix inline:

- **Frontmatter `name` mismatch** → "rename dir or update `name:` to `<expected>`".
- **Broken link** → "did you mean `<closest-existing-path>`?" (compute via simple basename match against repo).
- **Surviving placeholder in non-template file** → "add `<file>` to the template allowlist (Step 2b) if intended, otherwise substitute the placeholder before commit".
- **Missing resource** → "create `<path>` or remove the reference".

Don't apply fixes automatically — this skill is read-only by contract. The user fixes; re-run validates.

## Pitfalls

- **Treating template files as SKILL.md.** `*-template.md` files are NOT skills; they're rendered by `vinta-derive-skills`. The walker skips them.
- **False-positive placeholders.** Strings like `{{ user_input }}` in a code-fence example are still placeholders by the regex. Either rephrase the example or escape the braces (`\{\{...\}\}` reads fine in markdown).
- **Anchor-only links not checked.** `(#section)` is intentionally skipped — anchor verification is fragile and not worth the noise.
- **Resource grep over-matching.** A regex looking for `resources/<name>` might catch unrelated mentions (e.g. "the `resources/` dir under …"). Tighten to bullet-list / link-context only if false positives accumulate.
- **Running this on every save is overkill.** Run before commit, before release, after a multi-file edit. Not on every keystroke.

## Verification

1. Run on a known-clean repo state — should report 0 errors.
2. Manually break one SKILL.md (rename a link target to a typo) — re-run should report exactly that error.
3. Restore the file — re-run reports 0 errors again.
4. Exit code: 0 on clean, 1 on error. CI-friendly.
