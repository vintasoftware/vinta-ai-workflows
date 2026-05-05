---
name: vinta-install-ai-tools-setup
description: Install the multi-vendor `setup-ai-tools.mjs` script in the target project, wire up a `pnpm setup:ai-tools` (or equivalent) script alias, ensure the YAML parser dependency is present, then run the script to generate per-vendor AGENTS.md / skill / sub-agent files. Final step of [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md). Idempotent — safe to re-run after editing canonical sources.
---

# Install ai-tools setup

The setup script reads `ai-tools/AGENTS.md`, `ai-tools/skills/`, and `ai-tools/agents/*.yaml` (canonical sources) and emits per-vendor copies + symlinks. This skill installs the script + its package wiring + runs it for the first time.

## Output

- `ai-tools/scripts/setup-ai-tools.mjs` — copied from this skill's [resources/setup-ai-tools.mjs](resources/setup-ai-tools.mjs).
- `package.json` (or equivalent) gains a `setup:ai-tools` script alias.
- `yaml` (npm) added as a devDependency.
- Vendor symlinks + generated files materialized.

## Inputs

- `ai-tools/AGENTS.md` (from [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md))
- `ai-tools/agents/*.yaml` (from [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md))
- `ai-tools/skills/<name>/SKILL.md` (from [vinta-derive-skills](../vinta-derive-skills/SKILL.md))
- Step 0 vendor selection from [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md) §A.3

## Steps

### 1. Prerequisite check

`ai-tools/AGENTS.md` exists. `ai-tools/agents/*.yaml` has at least the foundation trio (`implementer`, `reviewer`, `fixer`). `ai-tools/skills/` is non-empty.

If any are missing → stop. Route the user back to the relevant sub-skill ([vinta-write-agents-md](../vinta-write-agents-md/SKILL.md), [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md), [vinta-derive-skills](../vinta-derive-skills/SKILL.md)).

### 2. Copy the setup script

Copy [resources/setup-ai-tools.mjs](resources/setup-ai-tools.mjs) (bundled with this skill) into the target repo at `ai-tools/scripts/setup-ai-tools.mjs`. Make it executable: `chmod +x ai-tools/scripts/setup-ai-tools.mjs`.

The script is self-contained — no project-specific edits required. It reads vendor agent paths + skill paths relative to the repo root.

### 3. Add the package script

For Node/TS projects: add `"setup:ai-tools": "node ai-tools/scripts/setup-ai-tools.mjs"` to root `package.json:scripts`.

For Python / Go / Rust / etc projects: there's no `package.json`, but Node is still required to run the script. Add a Makefile target / Justfile recipe / shell alias instead:

```makefile
setup-ai-tools:
	@node ai-tools/scripts/setup-ai-tools.mjs
.PHONY: setup-ai-tools
```

Or a `bin/setup-ai-tools` shell wrapper. Document the invocation in the project README + AGENTS.md.

### 4. Add the YAML parser dependency

The script imports `yaml` (npm). Add to devDependencies:

- pnpm: `pnpm add -D -w yaml` (root of workspace) or `pnpm add -D yaml` (single package).
- npm: `npm install --save-dev yaml`.
- yarn: `yarn add -D yaml`.

For projects without a Node toolchain (pure Python / Go / Rust / etc): the agent must still install `yaml` somewhere `node` can find it. Two options:
- (a) Add a minimal `package.json` at the repo root with just `{"devDependencies": {"yaml": "^2.8.0"}}` and run `npm install` in CI / dev setup.
- (b) Bundle `yaml` as a vendored copy under `ai-tools/scripts/node_modules/yaml/` (heavier, but no Node ecosystem footprint elsewhere).

Default to (a). Confirm with the user.

### 5. Configure vendor selection (optional)

If the user only wants a subset of vendors (per Step 0 §A.3), pass `--only` on the first run:

```bash
node ai-tools/scripts/setup-ai-tools.mjs --only claude-code,cursor
```

Or wire the alias to default to the subset:

```json
"setup:ai-tools": "node ai-tools/scripts/setup-ai-tools.mjs --only claude-code,cursor"
```

If the user wants all four vendors (default), no `--only` flag needed.

### 6. Run the script

```bash
pnpm setup:ai-tools
# or: node ai-tools/scripts/setup-ai-tools.mjs
```

Expected output: list of symlinks ensured, list of generated per-vendor files, list of agents with their access class. No errors.

### 7. Verify each selected vendor

For each vendor in the user's selection:

- **Claude Code**: `ls .claude/agents/` lists every agent's `.md`. `ls .claude/skills/` (or `ls -L`) lists every skill dir. `cat AGENTS.md` resolves to the canonical content.
- **Cursor**: `ls .cursor/agents/` + `ls .cursor/skills/`. Open Cursor and check that the agent + skill panels surface them.
- **VS Code Copilot**: `ls .github/agents/` lists `*.agent.md`. `ls .github/skills/` lists skill dirs. `cat .github/copilot-instructions.md` resolves to the canonical AGENTS.md.
- **Codex**: `ls .codex/agents/` lists `*.toml`. Each TOML opens cleanly + has `name` / `description` / `sandbox_mode` / `developer_instructions` fields.

Any mismatches → re-run the script. If still wrong → inspect the script's output for warnings (it warns when a target path exists as a non-symlink real file).

### 8. Commit

Stage:
- `ai-tools/` (canonical sources + script)
- `package.json` (script alias + yaml dep)
- `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` (after install)
- `AGENTS.md` (root symlink)
- `.claude/`, `.cursor/`, `.github/agents/`, `.github/skills/`, `.github/copilot-instructions.md`, `.codex/agents/`, `.agents/skills/` — whichever vendors selected

Commit message style matches the project's convention (Step 0 §D). Default: `Bootstrap ai-tools layout (AGENTS.md, skills, sub-agents, vendor wiring)`.

## What gets re-run vs left alone

The setup script is **selective by vendor** but **destructive within a vendor**:

- For vendors in `--only` (or all four by default): the script `rm -rf` the target dir and regenerates. Hand-edits to per-vendor files are lost.
- For vendors NOT in `--only`: the script leaves their files untouched.

**Always edit the canonical sources** (`ai-tools/agents/*.yaml`, `ai-tools/skills/`, `ai-tools/AGENTS.md`). Generated vendor files are derived; they get overwritten on the next run.

## Pitfalls

- **Skipping the prerequisite check.** Running the script on an empty `ai-tools/` produces empty output — no error, but no useful files either. Always confirm canonical sources exist first.
- **Hand-editing a generated vendor file.** The auto-generated header at the top of every output points at the YAML / canonical source. Edit there, re-run the script.
- **Adding `yaml` to dependencies (not devDependencies).** Setup is dev-time only. Putting `yaml` in production deps inflates bundles.
- **Forgetting to commit the symlinks.** Most VCS handle symlinks fine, but verify your repo's setup. `git config core.symlinks true` (default on macOS / Linux). Windows: enable Developer Mode or use `core.symlinks = true` and admin shell.
- **Using `--only` without communicating to the team.** A teammate runs `pnpm setup:ai-tools` on their machine and wipes the vendors you didn't include. Document the selection in AGENTS.md or the script alias.

## Verification

Final smoke test:

1. `pnpm setup:ai-tools` runs cleanly, no errors.
2. Spot-check one agent file in each selected vendor — content matches the canonical YAML.
3. Spot-check one skill — the skill description shows up in the vendor's UI (Claude `/help`, Cursor agent panel, Copilot chat slash menu, Codex slash menu).
4. Edit `ai-tools/AGENTS.md` (add a comment line). Confirm the change appears in `cat AGENTS.md` (root symlink) + each selected vendor's instruction-file path.
5. Edit `ai-tools/agents/implementer.yaml` (e.g. tweak description). Re-run setup. Confirm changes propagate to all selected vendor agent files.
