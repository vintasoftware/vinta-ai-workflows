---
name: vinta-analyze-codebase
description: Walk a repository and produce a structured inventory of its languages, frameworks, build tools, test setups, deploy targets, monorepo shape, env model, multi-tenancy patterns, and CI providers. Used by [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md) as the first step before drafting AGENTS.md / sub-agents / skills, but also runnable standalone when you want a quick "what is this codebase made of" report. Produces an in-memory inventory that downstream skills consume; does not write files.
---

# Analyze codebase

Build an inventory of what's in the repo so other skills don't have to re-discover it. The output is a structured summary, **not** a written file — the orchestrator passes it as context to the next sub-skill.

## What to scan, in order

Stop at the first finding for each section unless the section says otherwise. Don't recurse into `node_modules/`, `.git/`, `dist/`, `build/`, `.turbo/`, `.next/`, `__pycache__/`, `.venv/`, `target/`.

### 1. Top-level fingerprint

`ls -la` at repo root + `git log --oneline -10`. Capture:
- Repo name (from `package.json:name`, `pyproject.toml:[project].name`, `Cargo.toml:[package].name`, or git remote).
- Default branch (`git symbolic-ref refs/remotes/origin/HEAD` or fall back to `main`/`master`).
- Code host (parse `git remote get-url origin` — github.com / gitlab / bitbucket / self-hosted).
- Existing `AGENTS.md` / `CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md` / `CONTRIBUTING.md` — read these in full. Existing conventions are gospel.

### 2. Languages + package managers

| Signal file | Language / package manager |
|---|---|
| `package.json` | JavaScript / TypeScript |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | pnpm + (likely) workspaces |
| `yarn.lock` | yarn |
| `package-lock.json` | npm |
| `tsconfig.json` (one or many) | TypeScript |
| `pyproject.toml` | Python (modern) |
| `requirements*.txt`, `setup.py`, `setup.cfg` | Python (legacy) |
| `Cargo.toml` | Rust |
| `go.mod` | Go |
| `Gemfile` | Ruby |
| `pom.xml`, `build.gradle*` | Java / Kotlin |
| `composer.json` | PHP |

Capture every match — many repos are polyglot. Read each lockfile / `package.json` / `pyproject.toml` to extract direct dependencies (skip transitive).

### 3. Frameworks (from dependencies)

Match top-level deps against this table:

| Dep / signal | Framework |
|---|---|
| `react`, `react-dom` | React |
| `next` | Next.js (check `next.config.*` for App Router signals: `app/` directory) |
| `vite`, `@vitejs/*` | Vite |
| `@medplum/core`, `@medplum/fhirtypes`, `@medplum/react` | **Medplum** (FHIR backend) |
| `mantine`, `@mantine/*` | Mantine UI |
| `tailwindcss` | Tailwind |
| `@vercel/*` | Vercel platform / SDKs |
| `playwright`, `@playwright/test` | Playwright e2e |
| `vitest`, `jest` | Vitest / Jest |
| `biome`, `@biomejs/biome` | Biome lint+format |
| `eslint`, `prettier` | ESLint / Prettier |
| `Django` (in pyproject / requirements) | **Django** |
| `psqlextra`, `django-postgres-extra` | Django + PG partitioning |
| `strawberry-graphql` | Strawberry GraphQL |
| `fastapi` | FastAPI |
| `flask` | Flask |
| `pytest` | pytest |
| `mypy`, `ruff`, `black` | Python lint/type tools |
| `tRPC`, `@trpc/*` | tRPC |
| `prisma`, `@prisma/client` | Prisma |
| `drizzle-orm` | Drizzle |
| `mongoose` | Mongoose / MongoDB |

Record stack matches — these drive which template directories `vinta-bootstrap-ai-tools` copies from.

### 4. Build / dev / lint / test commands

For Node/TS: read `package.json:scripts`. Capture: `dev`, `build`, `test`, `test:*`, `lint`, `lint:fix`, `format`, `typecheck`. Also: workspace tasks (`turbo run …`, `pnpm --filter …`).

For Python: read `pyproject.toml:[tool.poetry.scripts]` / `[project.scripts]` + `Makefile` + `tox.ini` + `noxfile.py`. Capture: test runner command, lint command, type-check command, dev server command.

For other languages: read `Makefile` + `justfile` + language-specific files (`Cargo.toml:[bin]`, etc).

Note: many repos have the test command in CI config but not surfaced as a top-level script. Read `.github/workflows/*.yml` / `.gitlab-ci.yml` / `.circleci/config.yml` / `Jenkinsfile` to confirm.

### 5. Monorepo shape

- `pnpm-workspace.yaml` → list workspaces.
- `turbo.json` → tasks + pipeline graph.
- `nx.json` / `lerna.json` → Nx / Lerna.
- `apps/` + `lib/` (or `apps/` + `packages/`) directory pattern → conventional monorepo layout.
- Single-package repos: report as such; downstream skills need to know.

For each app/package: name + path + framework (cross-ref the [Frameworks (from dependencies)](#3-frameworks-from-dependencies) scan above) + entry point.

### 6. Tests

- Unit / integration: where are they? `apps/*/src/**/*.test.ts`, `tests/`, `__tests__/`, `<pkg>/tests/unit`, `<pkg>/tests/integration`. Glob.
- E2E: `e2e/`, `playwright/`, `cypress/`. Read fixtures + setup files for: auth strategy, seed helpers, tenant scoping in seeds.
- Test data: factories, fixtures, mocks. Note conventions (`@medplum/mock`, `factory_boy`, MSW, etc).

### 7. Deploy / release model

- `.github/workflows/deploy*.yml` / `.gitlab-ci.yml` deploy stages — capture target (Vercel, AWS, Heroku, K8s, custom), trigger (push to main vs release tag vs manual), environments named (`staging`, `production`, `preview`).
- `vercel.json` / `vercel.ts` → Vercel project config.
- `Dockerfile` + `docker-compose*.yml` → containerized.
- `helm/`, `k8s/`, `kustomize/` → Kubernetes.
- `scripts/deploy*` / `scripts/release*` → manual deploy paths.
- For Medplum repos: look for `pnpm bots:deploy`, `deploy-bots.ts`, AccessPolicy seed scripts.

### 8. Environments + multi-tenancy

- `.env.example` files at root + per-app — list var names (not values), note prefix patterns (`VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`).
- Vite `envPrefix` allowlist (`vite.config.ts`).
- Turbo `tasks.<name>.env` arrays (cache hash inputs).
- Multi-tenancy signals:
  - `tenant_id` columns in models / SQL schemas → row-level multi-tenancy.
  - `meta.account` references in FHIR resource creation → Medplum tenant compartmenting.
  - `Organization` resource + `_compartment=Organization/<id>` queries → Medplum org-scoped.
  - `<env>__<name>` prefix patterns in deploy scripts → per-env isolation in shared backend.
  - `psqlextra` partitioning by tenant key → partition-based isolation.
  - Single-tenant: explicitly note absence of these signals.

### 9. CI / CD

- CI provider: GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite, custom.
- Workflow files, named jobs, on-which-events (push, pull_request, schedule, release).
- Required checks (branch protection if visible via `.github/branch-protection.yml` or surfaced in CONTRIBUTING).
- Pre-commit hooks: `.pre-commit-config.yaml`, `.husky/`, `lefthook.yml`.

### 10. Documentation already present

- `README.md` at root + per-app.
- `docs/` directory.
- Architecture decision records (`docs/adr/`, `docs/architecture/`).

### 11. Existing AI-tooling artifacts

This is a load-bearing input for the rest of the bootstrap flow — surface every artifact found, even partial/legacy ones. Read each in full; they tell you what conventions already exist so the downstream `vinta-write-agents-md` / `vinta-derive-subagents` / `vinta-derive-skills` steps can **preserve, merge, or migrate** rather than overwrite.

**Instruction documents** — search for any of these and capture their content:

- `AGENTS.md` (root + per-app in monorepos).
- `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`.
- Codex / Cursor / Copilot instructions inside vendor dirs (`.codex/AGENTS.md`, etc.).
- Anything tagged "AI conventions" / "Coding agent guide" / "LLM rules" in CONTRIBUTING / docs.

**Skills** — for each vendor path, list every skill found with its `name` + `description` (from frontmatter):

| Path | What lives there |
|---|---|
| `.claude/skills/<name>/SKILL.md` | Claude Code project skills |
| `.cursor/skills/<name>/SKILL.md` | Cursor project skills |
| `.codex/skills/<name>/SKILL.md` | Codex project skills (legacy path) |
| `.github/skills/<name>/SKILL.md` | Copilot project skills |
| `.agents/skills/<name>/SKILL.md` | Universal skills (Codex/Cursor/Copilot) |
| `ai-tools/skills/<name>/SKILL.md` | Vinta canonical layout (already-bootstrapped) |

For each skill, also classify:

- `vinta-managed` — directory name starts with `vinta-` (installed by `@vinta/ai-workflows`; can be left alone or refreshed via that CLI).
- `foundation-shape` — name matches the Vinta foundation set (`plan-feature`, `create-spec`, `create-qa-use-cases`, `implement-plan`, `add-e2e-test`, `add-env-var`).
- `project-custom` — anything else; written by the team.

**Sub-agents** — list every agent file with its name + description:

| Path | Format | Purpose |
|---|---|---|
| `.claude/agents/<name>.md` | markdown + frontmatter | Claude Code |
| `.cursor/agents/<name>.md` | markdown + frontmatter | Cursor |
| `.codex/agents/<name>.toml` | TOML | Codex |
| `.github/agents/<name>.agent.md` | markdown + frontmatter | Copilot |
| `ai-tools/agents/<name>.yaml` | YAML | Vinta canonical |

For each agent, also classify:

- `foundation-shape` — name matches `implementer` / `reviewer` / `fixer`.
- `stack-specialist` — recognizable stack agent (e.g. `migration-author`, `deploy-author`).
- `project-custom` — anything else.

**Setup wiring** — note presence of:

- `ai-tools/scripts/setup-ai-tools.mjs` (Vinta canonical multi-vendor setup).
- `package.json#scripts.setup:ai-tools` or similar alias.
- Symlinks: `AGENTS.md → ai-tools/AGENTS.md`, `.claude/skills → ../ai-tools/skills`, etc.

**Plan/spec docs** — flag presence (full inventory comes later from [vinta-migrate-plans-specs](../vinta-migrate-plans-specs/SKILL.md)):

- `ai-plans/` directory contents.
- Loose `IMPLEMENTATION_PLAN.md`, `SPEC.md`, `RFC.md` at root or under `docs/`.

**PR / MR templates** — list every existing template file (case-insensitive). Used by `implement-plan` / `amend-plan` to scaffold the prs-context `# Description` so generated PRs match the project's existing convention. Search:

- GitHub:
  - `.github/pull_request_template.md` (and `PULL_REQUEST_TEMPLATE.md` casing).
  - `.github/PULL_REQUEST_TEMPLATE/*.md` (multi-template directory).
  - `pull_request_template.md` and `PULL_REQUEST_TEMPLATE.md` at repo root.
  - `docs/pull_request_template.md` and `docs/PULL_REQUEST_TEMPLATE.md`.
- GitLab:
  - `.gitlab/merge_request_templates/*.md`.
- Bitbucket / others: typically configured server-side, no file convention. Note in inventory if user-supplied.

For each template found, capture:
- Path (relative to repo root).
- A one-line summary of the section structure (`## Summary`, `## Test plan`, `## Screenshots`, `<!-- comments -->`, etc.) so downstream skills know how to fill it.

Output goes into `existing_ai_artifacts.pr_templates` (see schema below). The full content is read on demand by `implement-plan` / `amend-plan` when drafting prs-context files; analyze-codebase only enumerates.

If anything is found, **do NOT overwrite** — the downstream skills will read this section and decide preserve / merge / migrate per artifact, gated on user confirmation in [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md#e-existing-ai-artifacts-per-artifact-disposition)'s **Existing AI artifacts (per-artifact disposition)** interview group.

## Output: structured inventory

Return a single structured object (in conversation, as a tool result, or just printed for the user / orchestrator to read). Shape:

```yaml
repo:
  name: <string>
  default_branch: <string>
  code_host: github | gitlab | bitbucket | self-hosted | unknown
  existing_ai_artifacts:
    instructions:
      - { path: AGENTS.md, content: <full text> }
      - { path: .github/copilot-instructions.md, content: <full text> }
      - ...
    skills:
      - { path: .claude/skills/checkout-flow/SKILL.md, name: checkout-flow,
          description: <from frontmatter>, classification: project-custom }
      - { path: ai-tools/skills/plan-feature/SKILL.md, name: plan-feature,
          description: <...>, classification: foundation-shape }
      - ...
    agents:
      - { path: .claude/agents/migration-author.md, name: migration-author,
          description: <...>, classification: stack-specialist }
      - ...
    setup:
      - ai-tools/scripts/setup-ai-tools.mjs
      - package.json#scripts.setup:ai-tools
    pr_templates:
      - { path: .github/pull_request_template.md, sections: [Summary, Test plan, Screenshots] }
      - { path: .github/PULL_REQUEST_TEMPLATE/feature.md, sections: [...] }
    plans_dir_present: true | false   # full migration list comes from vinta-migrate-plans-specs
  # downstream skills MUST read existing_ai_artifacts before drafting anything new.

languages:
  - typescript | python | rust | go | ...

package_managers:
  - pnpm | npm | yarn | poetry | pip | cargo | ...

frameworks:
  # each with version range + path of signal file
  - { name: react, version: "^19", signal: package.json }
  - { name: medplum, version: "^5", signal: package.json }
  - { name: django, version: "^5.1", signal: pyproject.toml }
  - ...

monorepo:
  type: turbo | pnpm-workspaces | nx | lerna | none
  apps:
    - { name: <string>, path: <string>, framework: <string>, port: <int|null> }
  packages:
    - { name: <string>, path: <string>, role: shared-lib | sdk | ... }

commands:
  install: <e.g. pnpm install>
  dev: <e.g. pnpm dev>
  build: <e.g. pnpm build>
  test_unit: <e.g. pnpm test>
  test_e2e: <e.g. pnpm test:e2e>
  lint: <e.g. pnpm lint>
  format: <e.g. pnpm format>
  typecheck: <e.g. pnpm build (tsc) — or null if no separate command>

tests:
  unit_framework: vitest | jest | pytest | ...
  unit_paths: [<glob>]
  e2e_framework: playwright | cypress | none
  e2e_paths: [<path>]
  test_data_helpers: [<file>]   # factories, mock clients, seed scripts

deploy:
  targets: [vercel, aws-ecs, heroku, k8s, medplum-bots, npm-publish, ...]
  envs: [staging, production, preview, dev-<handle>, ...]
  ci_provider: github-actions | gitlab-ci | circleci | jenkins | none
  workflow_files: [<path>]
  triggers: [push:main, release, manual, ...]
  manual_deploy_paths: [<script paths that humans run by hand, e.g. npx medplum post Bundle ...>]

env_model:
  example_files: [<.env.example paths>]
  vars_count: <int>
  vite_envprefix: [<list>] | null
  turbo_env_lists: { <task>: [<vars>] } | null
  multi_tenancy:
    pattern: row-level | medplum-compartment | partitioned | per-env-prefix | none
    evidence: [<file:line refs>]

ci:
  provider: github-actions | gitlab-ci | ...
  jobs: [<name>]
  pre_commit: husky | pre-commit | lefthook | none

docs:
  readme: present | absent
  docs_dir: <path or null>
  adrs: <path or null>

stacks_matched:
  # cross-ref to bootstrap-ai-tools/resources/stacks/<name>
  - medplum
  - typescript-monorepo
  - django
  - ...
```

## Rules

- **Read, don't guess.** Every claim in the inventory cites a file. If you can't find the signal, the field is `null` or `unknown`, not a guess.
- **Don't run code.** No `pnpm install`, no `pytest`, no shell commands beyond `ls`, `cat`, `grep`, `git log`. Pure read.
- **Stop at the first match per section unless the section says otherwise.** A repo is a TypeScript repo if `package.json` + `tsconfig.json` exist; you don't need to grep every `.ts` file to confirm.
- **Existing AI artifacts override stack defaults.** If `AGENTS.md` exists, its content beats your detection. Surface conflicts (e.g. AGENTS.md says "use yarn" but lockfile is `pnpm-lock.yaml`) as findings, don't silently pick one.
- **Never use `§N` shorthand in any inventory output, summary, or downstream prompt.** Reference sections by their full heading name. `§N` references break when the source's section numbering changes.

## Pitfalls

- **Treating dev-deps as framework signals.** A repo with `playwright` in `devDependencies` doesn't necessarily have e2e tests — confirm by checking for `playwright.config.*` + `e2e/` or equivalent.
- **Inferring multi-tenancy from a `tenant_id` column on one model.** Check that the column is on the hot tables and that queries actually filter by it. A vestigial column is not a tenancy pattern.
- **Reporting `medplum-bots` as a deploy target without verifying.** `@medplum/core` in deps → SDK usage. A `bots/` directory + `deploy-bots.ts` script → actual bot deploy path. Different things.
- **Polyglot repos with mismatched conventions per language.** Report each language's conventions separately if they diverge (e.g. JS uses Biome, Python uses ruff). Don't average.
