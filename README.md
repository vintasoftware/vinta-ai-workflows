# vinta-ai-workflows

Private collection of **one-shot bootstrap skills** that scaffold AI tooling
inside any project: AGENTS.md, sub-agents, project-specific skills, and the
multi-vendor wiring that exposes them to Claude Code, Codex, Cursor, and
VS Code + GitHub Copilot.

Distributed as a private npm package (`@vinta/ai-workflows`). The bundled
CLI (`vinta-ai-workflow`) installs / updates / uninstalls the skills into
the target project's vendor-specific skill directories.

> "Skills" here = the [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
> format: a folder containing a `SKILL.md` (with YAML frontmatter) plus
> referenced resources/scripts. Recognized natively by Claude Code, Codex,
> Cursor, and VS Code Copilot.

## What's in here

```
vinta-ai-workflows/
├── package.json             # @vinta/ai-workflows — exposes vinta-ai-workflow bin
├── vinta-ai-workflow.mjs    # CLI: install / update / uninstall / list
├── README.md
└── skills/
    ├── vinta-analyze-codebase/
    ├── vinta-bootstrap-ai-tools/   # orchestrator — calls the others
    ├── vinta-derive-skills/
    ├── vinta-derive-subagents/
    ├── vinta-install-ai-tools-setup/
    ├── vinta-update-project-skills/
    └── vinta-write-agents-md/
```

`vinta-bootstrap-ai-tools` is the entry point — walks a fresh repo, runs the
others in order. The rest can also be invoked individually to refresh a
single artifact.

### Why the `vinta-` prefix?

Once installed, these skills sit alongside the user's own project skills in
the same `.<vendor>/skills/` directory. The prefix makes ownership obvious
in slash menus and on disk: anything under `vinta-*` is managed by this
package and gets removed by `uninstall`; anything else belongs to the
project.

## Why one-shot

The `vinta-` skills **bootstrap** a project's AI tooling. Once the project
has its own `ai-tools/` layout, AGENTS.md, sub-agents, and per-vendor
wiring, they have nothing left to do. Leaving them installed pollutes the
slash-command menu and risks a future re-run overwriting hand-tuned output.

→ Install, run once via `/vinta-bootstrap-ai-tools` (or whatever invocation
your tool uses), commit the generated `ai-tools/` layout, then `uninstall`.

When this package gains new versions later, `vinta-update-project-skills`
diffs the project's `ai-tools/skills/` against the latest source and only
applies changes the user explicitly accepts.

## Prerequisites

- **Node.js ≥ 18.** No runtime deps — CLI is dependency-free.
- **SSH access to the private repo** (for `git+ssh://` install) **or** a
  registry token if your team mirrors the package somewhere.

## Install (npm package)

The package is private. Two install paths:

### A. From git+ssh (no registry needed)

Each developer's GitHub SSH key needs read access to the repo. Then:

```bash
# inside the target project
npm  install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git
pnpm add  -D   git+ssh://git@github.com:vinta/vinta-ai-workflows.git
yarn add  -D   git+ssh://git@github.com:vinta/vinta-ai-workflows.git
bun  add  -d   git+ssh://git@github.com:vinta/vinta-ai-workflows.git
```

Pin a tag/commit when you want determinism:

```bash
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git#v0.1.0
```

### B. From GitHub Packages (if/when published)

In the project root, add `.npmrc`:

```ini
@vinta:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Export `GITHUB_TOKEN` (a Personal Access Token with `read:packages` and the
`repo` scope for private repos), then:

```bash
npm install -D @vinta/ai-workflows
```

### One-shot via npx (no install)

If you don't want the dep tracked in `package.json`:

```bash
npx -y -p git+ssh://git@github.com:vinta/vinta-ai-workflows.git \
  vinta-ai-workflow install --tool all
```

## Run the CLI

After install, the bin is available at `node_modules/.bin/vinta-ai-workflow`:

```bash
# inside the target project
npx vinta-ai-workflow install --tool all
# pnpm:
pnpm vinta-ai-workflow install --tool all
# or directly:
./node_modules/.bin/vinta-ai-workflow install --tool all
```

Pick a single tool:

```bash
npx vinta-ai-workflow install --tool claude-code
```

`--tool` accepts: `claude-code`, `codex`, `cursor`, `copilot`, `agents`, `all`.

### Universal install (covers Codex + Cursor + Copilot)

`.agents/skills/` is recognized by Codex, Cursor, **and** Copilot. A single
`--tool agents` install covers them:

```bash
# One install, three tools.
npx vinta-ai-workflow install --tool agents

# Pair with Claude Code (which only reads .claude/skills/).
npx vinta-ai-workflow install --tool claude-code
```

### Copy instead of symlink

By default the CLI symlinks each skill into the vendor path back to the
package's installed location under `node_modules/`. Use `--copy` if your
build pipeline doesn't preserve symlinks, or if other contributors check
out the project without this dep installed (e.g. you commit `.claude/`):

```bash
npx vinta-ai-workflow install --tool all --copy
```

Each copied skill gets a `.installed-by-vinta-ai-workflows` marker file
used by `uninstall` and `update` to recognize what the script owns.

### Subset of skills

```bash
npx vinta-ai-workflow install --tool claude-code \
  --skills vinta-bootstrap-ai-tools,vinta-write-agents-md
```

`npx vinta-ai-workflow list` prints all available skills.

### Dry run

```bash
npx vinta-ai-workflow install --tool all --dry-run
```

Prints planned actions, touches nothing.

## Update

Refresh installed skills against the latest package version:

```bash
# 1. Pull the new package version.
npm  update @vinta/ai-workflows
pnpm update @vinta/ai-workflows
# Or for git+ssh, just re-install with the new ref:
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git#v0.2.0

# 2. Re-link / re-copy skills.
npx vinta-ai-workflow update --tool all
```

`update` is sugar for `uninstall` followed by `install` with the same flags.
Symlink installs pick up package updates automatically without step 2 —
step 2 is only needed for `--copy` installs.

> **Note:** `update` refreshes the **builder skills themselves** (`vinta-*`)
> in `.<vendor>/skills/`. To refresh the **project's `ai-tools/skills/`**
> generated by a previous bootstrap run, use the
> [`vinta-update-project-skills`](skills/vinta-update-project-skills/SKILL.md)
> skill — invoke it via the AI tool, not the CLI. It diffs each project
> skill against current source and only applies changes the user accepts.

## Per-tool paths

Verified against official docs as of 2026-05.

| Tool | Project path | Source |
|---|---|---|
| Claude Code | `.claude/skills/` | native |
| OpenAI Codex | `.agents/skills/` | [docs](https://developers.openai.com/codex/skills) |
| Cursor | `.cursor/skills/` (also `.agents/skills/`) | [docs](https://cursor.com/docs/skills) |
| VS Code + Copilot | `.github/skills/` (also `.claude/skills/`, `.agents/skills/`) | [docs](https://code.visualstudio.com/docs/copilot/customization/agent-skills) |

Codex walks `.agents/skills/` from cwd up to the repo root, so an install
at the project root covers nested working directories too.

## Running the skills

Skills are discovered automatically by name + description. Trigger one in
plain language ("bootstrap ai-tools for this repo") or invoke explicitly
via slash command. The `vinta-` prefix is part of the slash name:

| Tool | Invocation |
|---|---|
| Claude Code | `/vinta-bootstrap-ai-tools` (in chat) |
| OpenAI Codex | `/skills` then pick, or `$vinta-bootstrap-ai-tools` mention |
| Cursor | `/vinta-bootstrap-ai-tools` in Agent chat |
| VS Code + Copilot | `/vinta-bootstrap-ai-tools` in Copilot Chat |

Start with `vinta-bootstrap-ai-tools` — it orchestrates the others.

To refresh project-generated skills after pulling a new package version:
invoke `vinta-update-project-skills`. It analyzes `ai-tools/skills/`,
proposes per-skill changes with diffs, and only applies what the user
accepts. See [its SKILL.md](skills/vinta-update-project-skills/SKILL.md)
for details.

## Uninstall

After the bootstrap is committed, remove the skills:

```bash
npx vinta-ai-workflow uninstall --tool all
```

Then drop the package itself:

```bash
npm  uninstall @vinta/ai-workflows
pnpm remove    @vinta/ai-workflows
```

### What `uninstall` removes

The uninstaller is conservative on purpose:

- **Symlinks** are removed only if their target points back into the
  package's `skills/` directory (or the link is dangling).
- **Copied directories** are removed only if they contain the
  `.installed-by-vinta-ai-workflows` marker file.
- **Anything else** (hand-authored skills, third-party skills, files
  lacking the marker) is left in place with a warning.

Empty `.<vendor>/skills/` directories are removed after the last managed
entry leaves; the parent `.claude/`, `.agents/`, etc. are left alone since
they likely hold other content.

### Manual uninstall (no Node available)

```bash
SKILLS="vinta-analyze-codebase vinta-bootstrap-ai-tools vinta-derive-skills \
        vinta-derive-subagents vinta-install-ai-tools-setup \
        vinta-update-project-skills vinta-write-agents-md"

for vendor in .claude/skills .agents/skills .cursor/skills .github/skills; do
  for skill in $SKILLS; do
    rm -rf "$vendor/$skill"
  done
  rmdir "$vendor" 2>/dev/null
done
```

## Workflow recap

```bash
# 1. Add the package to the target project.
cd ~/code/my-new-project
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git

# 2. Install the skills your tool reads.
npx vinta-ai-workflow install --tool claude-code

# 3. Open the project in the AI tool. Run the bootstrap.
#    Claude Code → /vinta-bootstrap-ai-tools

# 4. Review and commit the generated ai-tools/ layout.
git add ai-tools/ AGENTS.md .claude/ .codex/ .cursor/ .github/ .agents/
git commit -m "Bootstrap ai-tools layout"

# 5. Uninstall the builder skills (one-shot done).
npx vinta-ai-workflow uninstall --tool claude-code
npm uninstall @vinta/ai-workflows

# Later, when this package gains new versions:
# 6. (optional) Re-install + run vinta-update-project-skills to refresh
#    the project's generated skills against the latest source.
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git
npx vinta-ai-workflow install --tool claude-code \
  --skills vinta-update-project-skills
# Then in Claude Code: /vinta-update-project-skills
```

## Updating skills in this repo

If you modify a `vinta-*` skill source under `skills/`:

- **Symlink installs** (default): consumers get updates as soon as their
  `node_modules/@vinta/ai-workflows/` refreshes (next `npm install` /
  `git+ssh` re-pull).
- **Copy installs** (`--copy`): consumers must re-run `vinta-ai-workflow update`
  with the same flags. The CLI removes the previous copy and writes fresh
  content + marker.

To refresh **project-generated** skills (the ones under the project's
`ai-tools/skills/` produced by `vinta-derive-skills`), use
`vinta-update-project-skills` from the AI tool.

## CLI reference

```
vinta-ai-workflow <command> [options]

Commands:
  install     Place skills under <target>/.<vendor>/skills/
  update      Re-install (uninstall + install) so latest source content lands
  uninstall   Remove skills (only artifacts created by this CLI)
  list        List available skills

Options:
  --tool <name>       claude-code | codex | cursor | copilot | agents | all
                      Aliases: claude, openai-codex, vscode, vscode-copilot,
                               github-copilot, universal
  --target <dir>      Project root (default: cwd)
  --skills <a,b,c>    Subset of skills (default: all)
  --copy              Copy instead of symlink
  --dry-run, -n       Plan only
  --help, -h          Help
```

Project scope only — there is no user-scope mode. The `vinta-` skills are
intended to bootstrap a single project at a time and then come back out.
