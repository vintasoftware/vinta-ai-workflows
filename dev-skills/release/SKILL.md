---
name: release
description: Cut a release of `vinta-ai-workflows` — pick patch / minor / major / alpha bump, close the in-progress CHANGELOG section (stable only — alpha keeps it open), bump `package.json.version`, commit, tag, push. Asserts pre-flight conditions (clean working tree, on `main`, fetched, CHANGELOG section non-empty, schema enums match every shipped foundation skill, version bump matches the kind of change). Surfaces the npm publish command for the user to run manually — never auto-publishes. Alpha releases use `--tag alpha` dist-tag. Use when the user says "release", "cut a release", "tag 0.1.4", "alpha release", "0.2.0-alpha1", "publish".
---

# Release

This repo ships as a private npm package. Stable releases are: bump version + close CHANGELOG section + tag + push. Alpha pre-releases are: bump version (with `-alphaN` suffix) + tag + push, leaving the CHANGELOG section open so bullets accumulate across the alpha series until the stable graduates. No CI auto-publish today; the user runs `npm publish` (alpha: `npm publish --tag alpha`) once the tag is up.

## Step 0 — Pre-flight checks (NON-NEGOTIABLE)

Run all in parallel via `Bash`:

1. `git status --porcelain` → empty (clean working tree). Non-empty → stop, ask user to commit / stash.
2. `git rev-parse --abbrev-ref HEAD` → `main`. Otherwise → stop, ask user to switch.
3. `git fetch origin` then `git rev-list --left-right --count origin/main...HEAD` → `0\t0`. Behind → stop, ask user to pull. Ahead → fine, those are the unreleased commits.
4. `python3 -c "import json; print(json.load(open('package.json'))['version'])"` → record current version.
5. `git tag --sort=-v:refname | head -5` → recent tags (alpha + stable). Compare top tag against `package.json` — they should match (= last release). Mismatch is a sign someone bumped without tagging; surface before continuing. Note whether the top tag is **stable** (`X.Y.Z`) or **alpha** (`X.Y.Z-alphaN`) — Step 1 branches on this.
6. `git log <last-tag>..HEAD --oneline` → list of commits since last release. Show to user.

Any check failing = stop. Don't try to "fix" the working tree from inside this skill.

## Step 1 — Pick bump kind

Read the unreleased CHANGELOG section + the commit list from Step 0.6. Use `AskUserQuestion`:

- **patch** — bug fixes, doc fixes, internal refactors invisible to consumers.
- **minor** — new skills, additive schema fields, new CLI flags with backward-compatible defaults.
- **major** — removed skill, breaking schema change (new `<N+1>` schema file), CLI flag rename without alias, default-behavior flip.
- **alpha** — pre-release for an upcoming stable. Tag format `X.Y.Z-alphaN`. Use when shipping work-in-progress to early consumers before locking the stable. Does NOT close the CHANGELOG section.
- **graduate** — only if last tag is `X.Y.Z-alphaN`: cut the stable `X.Y.Z` that the alpha series targeted. Behaves like a normal stable release (closes CHANGELOG section).

Read the rule from `AGENTS.md` `## CHANGELOG + version policy` if uncertain — quote it back to the user.

If the CHANGELOG section's content disagrees with the chosen bump kind (e.g. user picked `patch` but the section has `### Added` for a new skill), surface the contradiction. Don't paper over it.

### Alpha sub-prompt

If user picks `alpha`, branch on the most recent tag from Step 0.5:

- **Last tag is stable `X.Y.Z`** (or no tags exist): user is starting a fresh alpha series. Ask which target stable bump (patch / minor / major) the alpha precedes. New version = `<bumped>-alpha1`. Example: stable `0.1.7` + minor target = `0.2.0-alpha1`.
- **Last tag is alpha `X.Y.Z-alphaN`**: default action is increment → `X.Y.Z-alpha(N+1)`. Also offer "switch target series" (re-ask patch/minor/major, reset to `-alpha1`) for the rare case the maintainer changed scope mid-series. Note: bumping `alphaN` is only valid if the in-progress CHANGELOG section still targets the same `X.Y.Z` — if the section header changed, refuse and ask user to reconcile.

## Step 2 — Validate the in-progress CHANGELOG section

Read [CHANGELOG.md](../../CHANGELOG.md). The top section should be either:

- `## [<current-version>] — <date>` — already dated AND matches `package.json`; means a previous release run partially completed. Stop, ask user.
- `## [<next-stable>] — YYYY-MM-DD` placeholder — date will be filled in Step 4 for stable / graduate, left as-is for alpha. `<next-stable>` is always the **stable** target (e.g. `0.2.0`), never an alpha label.
- `## [<some-version>] — <date>` (already-released) followed by no in-progress draft — means there are commits since last release but no CHANGELOG entries. **Refuse to release.** Ask user to draft entries first.

Validate non-empty: section must have at least one bullet under `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, or `### Security`. Empty section = no release-worthy change = nothing to release; surface and stop.

**Alpha-specific validation**: the placeholder `<next-stable>` must match the alpha's stable target. If user picks `alpha` increment and last tag is `0.2.0-alpha2`, the placeholder must read `## [0.2.0] — YYYY-MM-DD`. Mismatch = refuse (the maintainer either changed scope without re-targeting alpha, or the placeholder is stale).

Validate schema-skill alignment: `grep -E '"(plan-feature|create-spec|...)"' schemas/vinta-ai-workflows-config.v1.schema.json` — every foundation skill referenced in the schema's `foundation_skills.properties` must have a corresponding dir under `skills/vinta-derive-skills/resources/foundation-skills/`. Mismatch = orphan; refuse to release until fixed (route to `add-foundation-skill`).

## Step 3 — Compute the new version

Parse last tag → `<major>.<minor>.<patch>` and optional `-alpha<N>` suffix.

```
patch     → bump <patch>                                            → X.Y.(Z+1)
minor     → bump <minor>, reset <patch> to 0                        → X.(Y+1).0
major     → bump <major>, reset <minor> + <patch> to 0              → (X+1).0.0
alpha (fresh series, last tag stable) → apply target bump, append -alpha1
                                                                    → X'.Y'.Z'-alpha1
alpha (increment, last tag is X.Y.Z-alphaN) → X.Y.Z-alpha(N+1)
graduate  → strip -alphaN from last tag                             → X.Y.Z
```

Examples:
- last `0.1.7` (stable) + alpha+minor → `0.2.0-alpha1`
- last `0.2.0-alpha1` + alpha → `0.2.0-alpha2`
- last `0.2.0-alpha3` + graduate → `0.2.0`
- last `0.2.0-alpha2` + alpha (switch target to major) → `1.0.0-alpha1`

Surface the new version to user via `AskUserQuestion`: `Confirm v<X.Y.Z[-alphaN]>`, `Pick a different version (I'll list)`, `Stop`.

## Step 4 — Apply the bump

In a single change set:

1. Edit [package.json](../../package.json): `"version": "<new>"`. For alpha, `<new>` includes the `-alphaN` suffix.
2. Edit [CHANGELOG.md](../../CHANGELOG.md):
   - **stable / graduate**: change the in-progress section header to `## [<new>] — <today's ISO date>`. Today = `date -u +%Y-%m-%d` UTC.
   - **alpha**: do NOT close the placeholder. Leave header as `## [<next-stable>] — YYYY-MM-DD`. Bullets stay where they are — they accumulate across alphas and ship under the eventual stable. Optionally add a one-line note under the section recording the alpha tag (`<!-- pre-release: <new> on <date> -->`) so reviewers can correlate tags ↔ bullets; omit if the team prefers a clean CHANGELOG.
3. Sanity-check no `## [unreleased]` placeholder lingers anywhere (stable / graduate only — alpha intentionally keeps the dated placeholder open).

## Step 5 — Commit + tag

Use a HEREDOC commit message. No co-author trailer on release commits unless the user opts in (releases are typically authored by humans even when an agent prepared the bump).

```bash
git add package.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore(release): v<new>

<one-paragraph summary pulled from the CHANGELOG section's lead bullet>
EOF
)"
git tag -a "<new>" -m "Release <new>"
```

Confirm with the user before pushing.

## Step 6 — Push

```bash
git push origin main
git push origin "<new>"
```

If the team uses signed tags + a tag-protection rule, surface the failure and ask the user to push manually with their key.

## Step 7 — Surface publish command

Print but do **NOT** run. Stable / graduate releases publish under the default `latest` dist-tag; alpha releases MUST use `--tag alpha` so they don't override `latest` for consumers running `npm install vinta-ai-workflows`.

**Stable / graduate:**

```
Release v<new> committed + tagged + pushed.

To publish to the registry:
  npm publish

To publish from a fresh clone (no node_modules side-effects):
  npm pack
  npm publish vinta-ai-workflows-<new>.tgz

The user owns this step. Don't auto-publish.
```

**Alpha:**

```
Pre-release v<new> committed + tagged + pushed.

To publish under the alpha dist-tag (does NOT affect `latest`):
  npm publish --tag alpha

Fresh-clone flow:
  npm pack
  npm publish vinta-ai-workflows-<new>.tgz --tag alpha

Consumers opt in with:
  npm install vinta-ai-workflows@alpha
  # or pin exact: npm install vinta-ai-workflows@<new>

The user owns this step. Don't auto-publish.
```

## Verification

1. `python3 -c "import json; print(json.load(open('package.json'))['version'])"` → matches the new version (incl. `-alphaN` suffix for alpha).
2. `git tag --sort=-v:refname | head -1` → `<new>`.
3. `git log -1 --oneline` → `chore(release): <new>`.
4. `head -20 CHANGELOG.md`:
   - **stable / graduate**: top section header dated today, version matches `<new>`.
   - **alpha**: top section header still `## [<next-stable>] — YYYY-MM-DD` (placeholder intentionally open), bullets unchanged from pre-bump.
5. `git status --porcelain` → empty.
6. `git rev-list --left-right --count origin/main...HEAD` → `0\t0` (pushed).

## Pitfalls

- **Releasing a section that wasn't actually authored.** If commits landed without CHANGELOG updates (someone forgot), you'll release a "Added: " entry that doesn't reflect the diff. Cross-check `git log <last-tag>..HEAD` against the section's bullets before bumping.
- **Patch-bumping a minor change.** A new schema field is minor, not patch — even if it looks small. The schema is a public contract.
- **Forgetting to push the tag.** `git push origin main` doesn't carry tags; need the explicit `git push origin <tag>` (or `git push --follow-tags`).
- **Auto-publishing.** Don't. The user's npm credentials + 2FA flow are not your business; surface the command and stop.
- **Dating the CHANGELOG with local time.** Use UTC ISO date — the team is distributed.
- **Tagging without signing when the repo expects signed tags.** `git config tag.gpgsign` set to true → `git tag` without `-s` fails or warns. Detect via `git config --get tag.gpgsign` in pre-flight; if true, use `-s`.
- **Releasing while another `release` skill run is in flight.** The pre-flight clean-working-tree check catches this incidentally.
- **Publishing alpha without `--tag alpha`.** Default dist-tag is `latest` — an alpha published as `latest` becomes the install-by-default version and breaks every consumer doing `npm install vinta-ai-workflows`. Always `--tag alpha` for pre-releases.
- **Closing the CHANGELOG placeholder on an alpha.** Alpha is a pre-release; the section header stays open as `## [<next-stable>] — YYYY-MM-DD` so later alphas + the eventual stable / graduate all share the accumulating bullet list. Closing it early forces the stable release to invent a duplicate section.
- **`alpha10` vs `alpha2` ordering.** The format `X.Y.Z-alphaN` (no dot) is one semver identifier; `alpha10 < alpha2` lexicographically. Fine for N=1..9; if a series exceeds 9, surface to user and switch to `-alpha.10` (with dot) — semver does numeric compare on dotted numeric identifiers. Do NOT silently mix formats.
- **Bumping alpha when the placeholder target moved.** If last tag is `0.2.0-alpha2` but the placeholder now reads `## [0.3.0]`, the alpha series no longer aligns with what'll ship. Refuse and ask the user to either re-target alpha (`alpha` + switch to major/minor, reset to `-alpha1`) or revert the placeholder.
- **Tag list ordering.** `git tag --sort=-v:refname` understands semver pre-release suffixes — `0.2.0` sorts AFTER `0.2.0-alpha3`, as expected. Don't fall back to `--sort=-creatordate` (manual re-tags break order) or plain `git tag | tail` (lexicographic, wrong).
- **Graduating an alpha series with stale CHANGELOG header.** `graduate` expects the placeholder `<next-stable>` to match the alpha's stable target. Skipping versions (alpha2 of `0.2.0` → graduate to `0.2.1`) is not supported by this skill — cut a fresh `patch` instead.
