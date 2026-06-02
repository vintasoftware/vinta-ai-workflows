# Canonical `{{DEPENDENCY_LICENSE_BLOCK}}` body

Rendered into `implement-plan` / `amend-plan` / `systematic-debugging` SKILL.md by [vinta-derive-skills](../SKILL.md) when `policies.dependency_licenses.enforcement` is `block` or `warn`. Empty string when `off` or the block is absent.

The rendered section sits **directly before** `## Working instructions` so subagents see it before they start coding.

## Variants

### `enforcement: block`

```markdown
## Adding new third-party dependencies

Before running any install command (`npm add`, `pnpm add`, `yarn add`, `pip install`, `poetry add`, `uv add`, `cargo add`, `go get`, `gem install`, equivalents), check the package's SPDX license against the project's forbidden list — see the **Dependency licenses** section in [AGENTS.md](AGENTS.md) for the full list, the per-package overrides, and any project-specific notes.

Quick lookup:

- **npm / pnpm / yarn**: `npm view <pkg> license`.
- **PyPI**: `pip index versions <pkg>` then read the project metadata, or open `https://pypi.org/project/<pkg>/`.
- **Cargo**: `cargo metadata --format-version 1 | jq '.packages[] | select(.name=="<pkg>") | .license'` (after a temporary `cargo add` in a scratch dir, or read `Cargo.toml` upstream).
- **Go**: open the module's repo `LICENSE` file directly.
- **Gem**: `gem specification <pkg> licenses`.

If the license is in the forbidden list AND the `(package, license)` pair is **not** listed under **Approved overrides** in AGENTS.md:

1. Stop. Do not run the install command.
2. Surface the violation to the user with: package name, SPDX identifier, why it's forbidden, link to the upstream license.
3. Offer alternatives (search the ecosystem for an MIT / Apache-2.0 / BSD-licensed equivalent) before asking for an override.
4. If the user grants a one-off override, the orchestrator must record it in `policies.dependency_licenses.allowed_overrides[]` of `.vinta-ai-workflows.yaml` (package + SPDX + one-line reason) before re-running the install. Undocumented overrides leak into the diff and the reviewer agent will flag them.

Transitive deps follow the same rule, but checking every transitive license at install time is impractical — the project's CI (or a separate license-audit run) handles the deep walk. The subagent's responsibility is the **direct** add.
```

### `enforcement: warn`

Identical body, with two edits:

- Step 1 changes to: *"Proceed with the install, but record the violation."*
- Step 4 reframes the override entry as *"the team should still review and either record an `allowed_overrides` entry or remove the dep."*

### `enforcement: off`

Empty string. No section emitted.

## Why a top-level section, not a sub-step

The numbered list under `## Working instructions` describes the inner-loop / outer-gate / commit / push cadence. A license-check inserted mid-list would either renumber every downstream step (churn in the rendered diff) or appear as an unnumbered orphan (broken markdown numbering). A separate `## Adding new third-party dependencies` section keeps the policy visible while leaving the existing flow untouched.

## Why repeat the SPDX list in AGENTS.md, not inline

The skill body cites AGENTS.md so a single change (new forbidden license, new override, edited notes) doesn't require regenerating every skill. AGENTS.md is the source of truth; the skill is the *pointer*. [vinta-write-agents-md](../../vinta-write-agents-md/SKILL.md) renders the full table from `policies.dependency_licenses`.
