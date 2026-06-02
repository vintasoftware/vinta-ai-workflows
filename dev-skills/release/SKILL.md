---
name: release
description: Cut a release of `@vinta/ai-workflows` — pick patch / minor / major bump, close the in-progress CHANGELOG section, bump `package.json.version`, commit, tag, push. Asserts pre-flight conditions (clean working tree, on `main`, fetched, CHANGELOG section non-empty, schema enums match every shipped foundation skill, version bump matches the kind of change). Surfaces the npm publish command for the user to run manually — never auto-publishes. Use when the user says "release", "cut a release", "tag 0.1.4", "publish".
---

# Release

This repo ships as a private npm package. Releases are: bump version + close CHANGELOG section + tag + push. No CI auto-publish today; the user runs `npm publish` (or the team's mirror flow) once the tag is up.

## Step 0 — Pre-flight checks (NON-NEGOTIABLE)

Run all in parallel via `Bash`:

1. `git status --porcelain` → empty (clean working tree). Non-empty → stop, ask user to commit / stash.
2. `git rev-parse --abbrev-ref HEAD` → `main`. Otherwise → stop, ask user to switch.
3. `git fetch origin` then `git rev-list --left-right --count origin/main...HEAD` → `0\t0`. Behind → stop, ask user to pull. Ahead → fine, those are the unreleased commits.
4. `python3 -c "import json; print(json.load(open('package.json'))['version'])"` → record current version.
5. `git tag --sort=-v:refname | head -1` → most recent tag. Compare against package.json — they should match (= last release). Mismatch is a sign someone bumped the version without tagging; surface to user before continuing.
6. `git log <last-tag>..HEAD --oneline` → list of commits since last release. Show to user.

Any check failing = stop. Don't try to "fix" the working tree from inside this skill.

## Step 1 — Pick bump kind

Read the unreleased CHANGELOG section + the commit list from Step 0.6. Use `AskUserQuestion`:

- **patch** — bug fixes, doc fixes, internal refactors invisible to consumers.
- **minor** — new skills, additive schema fields, new CLI flags with backward-compatible defaults.
- **major** — removed skill, breaking schema change (new `<N+1>` schema file), CLI flag rename without alias, default-behavior flip.

Read the rule from `AGENTS.md` `## CHANGELOG + version policy` if uncertain — quote it back to the user.

If the CHANGELOG section's content disagrees with the chosen bump kind (e.g. user picked `patch` but the section has `### Added` for a new skill), surface the contradiction. Don't paper over it.

## Step 2 — Validate the in-progress CHANGELOG section

Read [CHANGELOG.md](../../CHANGELOG.md). The top section should be either:

- `## [<current-version>] — <date>` — already dated; means a previous release run partially completed. Stop, ask user.
- `## [<next-version>] — YYYY-MM-DD` placeholder — date will be filled in Step 4.
- `## [<some-version>] — <date>` (already-released) followed by no in-progress draft — means there are commits since last release but no CHANGELOG entries. **Refuse to release.** Ask user to draft entries first.

Validate non-empty: section must have at least one bullet under `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, or `### Security`. Empty section = no release-worthy change = nothing to release; surface and stop.

Validate schema-skill alignment: `grep -E '"(plan-feature|create-spec|...)"' schemas/vinta-ai-workflows-config.v1.schema.json` — every foundation skill referenced in the schema's `foundation_skills.properties` must have a corresponding dir under `skills/vinta-derive-skills/resources/foundation-skills/`. Mismatch = orphan; refuse to release until fixed (route to `add-foundation-skill`).

## Step 3 — Compute the new version

```
<major>.<minor>.<patch>
patch  → bump <patch>
minor  → bump <minor>, reset <patch> to 0
major  → bump <major>, reset <minor> + <patch> to 0
```

Surface the new version to user via `AskUserQuestion`: `Confirm v<X.Y.Z>`, `Pick a different version (I'll list)`, `Stop`.

## Step 4 — Apply the bump

In a single change set:

1. Edit [package.json](../../package.json): `"version": "<new>"`.
2. Edit [CHANGELOG.md](../../CHANGELOG.md): change the in-progress section header to `## [<new>] — <today's ISO date>`. Today = `date -u +%Y-%m-%d` UTC.
3. Sanity-check no `## [unreleased]` placeholder lingers anywhere.

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

Print but do **NOT** run:

```
Release v<new> committed + tagged + pushed.

To publish to the registry (private):
  npm publish

To publish from a fresh clone (no node_modules side-effects):
  npm pack
  npm publish vinta-ai-workflows-<new>.tgz

The user owns this step. Don't auto-publish.
```

## Verification

1. `python3 -c "import json; print(json.load(open('package.json'))['version'])"` → matches the new version.
2. `git tag --sort=-v:refname | head -1` → `<new>`.
3. `git log -1 --oneline` → `chore(release): <new>`.
4. `head -20 CHANGELOG.md` → top section header dated today, version matches.
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
