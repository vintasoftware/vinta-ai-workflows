---
name: create-qa-use-cases
description: Bootstrap a project's `QA_USE_CASES.md` from scratch using the canonical pattern (immutable PA###/PR### ids, role table, per-app numbered sections with role-tagged checklists). Invoked from inside [plan-feature](../plan-feature/SKILL.md) when the project has no `QA_USE_CASES.md` yet — the active feature's spec + plan are already in hand. Seeds the file with use cases from those two documents only; does not sweep prior plans. Asks the user for the few gaps spec/plan don't answer (app boundaries, role list, prefix conventions). Project-agnostic — works in any repo that adopts this skill set.
---

# Bootstrap `QA_USE_CASES.md`

The doc maps 1:1 to e2e test specs by an immutable id. It's the QA team's manual-test checklist and the spec filename source of truth. [add-e2e-test](../add-e2e-test/SKILL.md) appends entries; this skill creates the file the first time, **seeded from the active feature** that triggered the bootstrap.

## When to use

- Project has no `QA_USE_CASES.md` at the repo root.
- [plan-feature](../plan-feature/SKILL.md) is in flight for a specific feature — its spec + plan are the seed material.
- A UI-flow phase in that plan needs an e2e id but the file doesn't exist yet.

If `QA_USE_CASES.md` already exists, **do not overwrite**. Stop and route the user to [add-e2e-test](../add-e2e-test/SKILL.md) for appending entries. Bootstrap is one-shot.

## Source: the active feature only

This skill runs **inside** the plan-feature flow, so the active spec + plan are already loaded into the conversation. Seed the file from those two documents — **do not** sweep `ai-plans/` for prior specs. Older features that pre-date this doc will be added later via [add-e2e-test](../add-e2e-test/SKILL.md) as they need test coverage; bootstrapping with the entire history is noise.

Extract from the active feature's docs:

1. **Use cases** from the spec's **Decisions → Use-cases** section (one PA/PR entry per user-facing flow). UI-affecting phases from the plan's **Phased Rollout** that aren't already in the spec's **Use-cases** get an entry too.
2. **Role list** from the spec's **Business Context** / **Decisions → Use-cases** actors + the plan's **Guiding Decisions**.
3. **App boundaries** if the spec/plan name them; otherwise ask.

If invoked standalone (not from plan-feature), ask the user *"Which spec + plan should I seed from?"* via `AskUserQuestion` and load only those two files. Don't go fishing.

## Decision questions

For everything **not** answered by the active spec/plan, ask via `AskUserQuestion`. Closed-form questions go through the tool; open narrative questions iterate one at a time. Same convention as [plan-feature](../plan-feature/SKILL.md) and [create-spec](../create-spec/SKILL.md).

### Questions to ask (skip when source docs answer)

**A. App boundaries**
1. How many apps does this project have, and what are their names? (e.g. `Patient App`, `Provider App`, `Admin Console`, single SaaS app named `<Product>`.)
2. ID prefix per app — typically a 2-letter abbreviation. Defaults: `PA` for "patient/public app", `PR` for "provider/admin app". Confirm or override.
3. Does any app have unauthenticated routes that need use-case entries (registration, public referral, marketing landing)? Those entries note `(unauthenticated)` in the role.

**B. Roles**
1. List of roles that perform actions in any app. Each role: name + which app(s) it logs into + one-sentence description.
2. Is there an "Admin" or "Super-Admin" role distinct from regular users? Many projects' permission docs distinguish project-admin (`ProjectMembership.admin === true`) from role-coded admins — both belong in the table if both exist.
3. Are external actors (referring providers, integration partners) ever actors in a use case? Note as `(unauthenticated)` or `(external — no login)`.

**C. Active-feature coverage**
1. From the active spec + plan, here's the use-case list I extracted: `<list>`. Anything missing or mis-scoped? (`AskUserQuestion` with `Looks good` / `Some corrections (I'll list)` / `More to add` / `Stop, rethink`.)
2. For each use case, who's the role? If the source says "Care Coordinator, Physician" pick one default and note the others. Multi-role use cases are normal — comma-separate them in the entry.

**D. ID assignment**
1. Order: append in the order use cases appear in the active spec (**Decisions → Use-cases** first, then any plan-only phases). Don't reshuffle.
2. Default starting numbers `PA001` / `PR001`. Confirm or override.

### Clarity loop

Same as the other interview skills. After each `AskUserQuestion` round, re-scan: did the answer reveal a new role? A use case that needs splitting? An app boundary I missed? Open another batch. Exit conditions:

- Every app named + prefix assigned.
- Every role listed with app + description.
- Every spec use case mapped to one or more roles + assigned an id.
- No "we'll figure that out later" in the role table — that's a live ambiguity, ask now.

Final read-back via `AskUserQuestion`: *"Anything I got wrong before I write the file?"* with `Looks good` / `Some corrections (I'll list)` / `More to clarify` / `Stop, rethink`. Only write on `Looks good`.

## File structure (canonical)

```markdown
# {Project Name} Use Cases

IDs (`PA###` for {patient app name}, `PR###` for {provider app name}) are immutable. When
adding a new use case, pick the next unused number — never reshuffle, renumber,
or reuse a retired ID. The e2e spec filenames mirror these IDs one-to-one.

## Roles

| Role | App | Description |
|------|-----|-------------|
| **{Role 1}** | {App} | {One-sentence description} |
| **{Role 2}** | {App} | {…} |
| …

---

## {Patient / First App}

### PA001. {Use Case Title}

**Role:** {Role(s) — comma-separated if multi-role; add `(unauthenticated)` for public flows}

- [ ] {First step the user takes}
- [ ] {Next step}
- [ ] {Verify {observable outcome}}
  - {Sub-bullet for branched outcomes — e.g. eligible vs ineligible paths}

### PA002. {…}

…

---

## {Provider / Second App}

### PR001. …

…
```

### Step-list rules per entry

- **Verb-led, present tense.** "Navigate to /settings", "Click Save", "Verify the success toast appears". Not "User navigates", not "Should click".
- **Checkboxes (`- [ ]`)** because the doc doubles as a manual-test checklist. QA ticks them off in PRs.
- **One observable assertion per branch.** "Verify eligibility result: If eligible → redirected to /onboarding. If ineligible → error message shown." Mirrors how the e2e spec is structured.
- **Reference URL paths exactly** as the app routes them (`/settings`, `/onboarding/{uniqueId}`). Reviewer can follow without context.
- **Never include implementation details.** No domain model names, API endpoints, table names, or library specifics. Doc is read by QA, product, support — keep it user-language.

### Multi-app projects

- One `## ` section per app, separated by `---`.
- Section heading = exact app name as it appears in the role table.
- Prefix per app is consistent within the section: PA-section uses `PA001…`, PR-section uses `PR001…`.
- Don't interleave apps under one section.

### Single-app projects

Skip the `---`-separated sections. Single `## Use Cases` heading, one prefix (e.g. `UC001`).

## Checklist

### 1. Confirm no existing file

If `QA_USE_CASES.md` exists at repo root, **stop**. Tell the user the file already exists and route them to [add-e2e-test](../add-e2e-test/SKILL.md) for appending. Bootstrap doesn't merge or migrate — that's manual work, not a skill output.

### 2. Pull from the active spec + plan only

The active feature's spec + plan are already in the conversation (handed in by [plan-feature](../plan-feature/SKILL.md), or pointed to by the user when invoked standalone). Extract:
- Use cases from the active spec's **Decisions → Use-cases**.
- UI-facing phases from the active plan's **Phased Rollout** that aren't already in the spec's **Use-cases**.
- Roles from the active spec's **Business Context** / **Decisions → Use-cases** actors.

**Do not** sweep `ai-plans/` for older specs. Pre-existing features that pre-date the doc get added later via [add-e2e-test](../add-e2e-test/SKILL.md) when they need test coverage.

### 3. Run the interview

Ask only for what the source docs don't already answer. Closed-form via `AskUserQuestion` (batched per group). Open-ended (extra context, narrative) iterate one at a time. Read back, confirm, loop until stable.

### 4. Write the file

Output to repo root: `QA_USE_CASES.md`. Use the canonical structure above. Plug in:
- Project name in the title.
- App names in the section headings + the immutable-ids note.
- Role table with every role from the interview.
- Numbered entries, ids in source-doc order, role line, step checklist.

### 5. Tell the user what's next

After writing:
- Point to [add-e2e-test](../add-e2e-test/SKILL.md) for adding e2e specs that mirror these ids.
- If [plan-feature](../plan-feature/SKILL.md) is in flight, remind the user that each UI-flow phase needs an entry here matched 1:1 to the spec it ships.
- If new use cases come up later, append — never insert in the middle, never renumber.

## Worked example (for shape only — not actual content)

```markdown
# Acme Sleep Use Cases

IDs (`PA###` for Patient App, `PR###` for Provider App) are immutable. When
adding a new use case, pick the next unused number — never reshuffle, renumber,
or reuse a retired ID. The e2e spec filenames mirror these IDs one-to-one.

## Roles

| Role | App | Description |
|------|-----|-------------|
| **Patient** | Patient App | End-user receiving sleep care services |
| **Provider: Care Coordinator (RN)** | Provider App | Coordination + admin |
| **Provider: Physician (MD)** | Provider App | Clinical authority |
| **Provider: Clinical Ops (Admin)** | Provider App | System administrator |

---

## Patient App

### PA001. Self-Referral Registration

**Role:** Patient (unauthenticated)

- [ ] Navigate to the landing page
- [ ] Click "Register"
- [ ] Fill out the self-referral intake form
- [ ] Submit
- [ ] Verify eligibility:
  - If eligible: redirected to `/onboarding/{uniqueId}`
  - If ineligible: error message shown with "Go Back" option

### PA002. …

---

## Provider App

### PR001. Provider Sign In

**Role:** All Providers

- [ ] Navigate to the provider app landing page
- [ ] Click "Sign In"
- [ ] Enter credentials
- [ ] Verify redirect to the patient list
```

## Pitfalls

- **Overwriting an existing file.** Bootstrap is one-shot. If the file exists, append via add-e2e-test, don't regenerate — existing ids are referenced by spec filenames + bug tickets and can't move.
- **Inventing use cases from project name alone.** If the spec/plan doesn't describe a flow, don't add a stub. Empty checklist + no real flow = noise. Ask the user; if they don't have one, leave it out.
- **Mixing role-coded admin with project-admin.** Many systems have both (a "Clinical Ops" role + a flag like `ProjectMembership.admin === true`). List both rows in the role table if both apply — they map to different storage states / permission paths in tests.
- **Putting implementation details in steps.** "Create QuestionnaireResponse with linkId=first-name" reads to QA as gibberish. "Fill out the intake form" is the right level. Implementation details belong in the e2e spec or seed helper, not here.
- **Numbering by importance.** Numbers reflect order of arrival, not priority. PA047 isn't more important than PA003 — it just came later. Don't try to keep "core" use cases at low numbers; that path leads to renumbering.
- **Skipping the `(unauthenticated)` annotation.** Public flows (registration, password reset, public referral) need it explicitly so reviewers know which storage state the e2e spec uses.
- **Sweeping `ai-plans/` for older specs.** This skill seeds from the **active feature only**. Backfilling the doc with every historical feature creates phantom test obligations. Pre-existing features get added later via [add-e2e-test](../add-e2e-test/SKILL.md) when they actually need coverage.
- **Generating without reading the active spec/plan.** The whole point is to inherit decisions, not re-derive them. If the active spec/plan are visible, read them. If they aren't, ask the user to point at them — don't guess.

## Verification

After writing the file:

1. Open it. Render in a markdown previewer — table renders, sections appear in order, no broken markdown.
2. Cross-check: every use case from every spec's **Decisions → Use-cases** appears as a numbered entry. None missing.
3. Cross-check: every role mentioned anywhere in the entries appears in the role table.
4. Cross-check: ids start at `001` per app prefix, ascend with no gaps.
5. Run `grep -c '^### P[AR][0-9]' QA_USE_CASES.md` — count matches your interview tally.

If [plan-feature](../plan-feature/SKILL.md) is in flight, the next step is creating one e2e spec per UI-flow phase — see [add-e2e-test](../add-e2e-test/SKILL.md). Each spec filename mirrors the id you just assigned.
