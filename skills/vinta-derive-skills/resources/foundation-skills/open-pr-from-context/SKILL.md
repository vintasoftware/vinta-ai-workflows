---
name: open-pr-from-context
description: Publish one `.vinta-ai-workflows/prs-context/{feature-name}/{phase-name}.md` file as a real PR + inline review comments by invoking the bundled [open-pr.sh](scripts/open-pr.sh) shell script. The script handles all parsing + CLI calls (`gh` for GitHub, `glab` for GitLab); this skill is a thin wrapper that picks the file, runs the script, and reports the result. Use after `implement-plan` has pushed a phase branch + written the context file, or any time afterwards to publish a `status: pending` file. Does nothing else — no diff editing, no extra checks, no skill-side parsing.
---

# Open PR from context

[implement-plan](../implement-plan/SKILL.md) writes per-phase PR drafts to `.vinta-ai-workflows/prs-context/{feature-name}/{phase-name}.md` ([template](../../prs-context-template.md)) and (when a PR CLI is detected) calls this skill to publish them. When the runtime had no PR CLI at write time, the file sits as `status: pending` until someone runs this skill in an environment with the CLI.

The mechanical work — parse frontmatter, detect CLI, open PR, post each inline comment, rewrite frontmatter to `published`, append publish log — lives in [`scripts/open-pr.sh`](scripts/open-pr.sh). This SKILL.md just wires the agent to it.

## Dependencies

The script needs: `bash 4+`, `git`, `yq` (Mike Farah's), `jq`, and one of `gh` / `glab`. Install via the project's package manager / Homebrew / apt:

- macOS: `brew install yq jq gh` (or `glab`).
- Debian/Ubuntu: `apt install yq jq` + `gh` from cli.github.com (or `glab` from gitlab.com).
- Inside CI runners: ensure these are present in the image.

The script bails early with `missing dependency: <name>` if any are absent. Surface the install command — don't auto-install.

## Steps

### 1. Pick the file

If the user passed a file path → use it.

Otherwise list candidates: `find .vinta-ai-workflows/prs-context -type f -name '*.md'`, read each one's frontmatter `status` field, prefer `status: pending`. Use `AskUserQuestion` to confirm if more than one is pending.

### 2. Run the script

```bash
bash ai-tools/skills/open-pr-from-context/scripts/open-pr.sh <file>
```

(The script has the executable bit set, so `./ai-tools/skills/open-pr-from-context/scripts/open-pr.sh <file>` also works.)

Optional flags:

- `--cli gh|glab` — force a specific PR CLI. Default: auto-detect (`gh` first, then `glab`).
- `--dry-run` / `-n` — print what would be posted; touch nothing remote and don't rewrite the file.

Pass through whatever the user explicitly asked for; otherwise no flags.

### 3. Report the result

Read the script's stdout + exit code:

- **Exit 0** — PR opened (or pre-existing detected); all comments posted. File rewritten to `status: published` + `pr_url`. Surface the URL to the user; you're done.
- **Exit 1** — PR opened, but one or more inline comments failed. The script's stderr lists which `(file:line)` failed. Forward the failures verbatim. Most common cause: a force-push between branch push and now invalidated the line position — re-run after pushing.
- **Exit 2** — Hard failure (file invalid, branch not pushed, CLI missing/unauthed, missing dependency). Forward the script's error message; do **not** improvise (don't push the branch, don't install CLIs, don't auth on the user's behalf).

## Inputs the script expects

The bundled [prs-context-template.md](../../prs-context-template.md) documents the file shape. The script verifies:

- Frontmatter: `branch`, `base` (required); `status`, `pr_url` (read + written).
- `# Title` section: single line, non-empty.
- `# Description` section: markdown, non-empty.
- `# Comments` section: a single fenced ```yaml list (may be empty — clean phases are valid).

A file at `status: published` with a populated `pr_url` is a no-op — the script prints the URL and exits 0 without touching anything.

## What this skill / script do NOT do

- **Do not push the branch.** `implement-plan` already pushed it. If the script reports `branch not pushed`, that's a setup bug — surface it.
- **Do not edit the diff.** Comment placement is informational only.
- **Do not re-run tests / lint.** Those happened in `implement-plan` before push.
- **Do not draft new descriptions or comments.** The file is the source of truth — edit the file (or re-run `implement-plan` for that phase) before re-invoking.
- **Do not install or authenticate CLIs.** Surfaces the gap, stops.
- **Do not delete the PR-context file.** `implement-plan` cleans up at plan end; until then the file is durable history.

## Pitfalls

- **Stacked phases.** PR base is the previous phase's branch, not `main`. The file's `base` field has the right value; the script trusts it. Don't override.
- **Force-pushed branch.** Inline comments target a SHA. If the branch was force-pushed between PR open and comment posting, GitHub/GitLab may reject specific lines as "no longer in the diff". Per-comment failures are reported but don't abort the run — the surviving comments still post. Re-run after pushing if you want the failed ones.
- **Empty `# Comments`.** Valid; clean phases produce few or zero comments. Script no-ops the comment loop, still rewrites status to `published`.
- **Missing `yq` / `jq`.** Script bails with `missing dependency: yq` (or `jq`) before doing anything. Install the missing tool, re-run.
