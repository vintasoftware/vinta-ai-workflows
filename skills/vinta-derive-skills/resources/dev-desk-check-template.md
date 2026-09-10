---
name: dev-desk-check
description: Drive a real browser through {{PROJECT_NAME}} as a user and report what actually renders — the manual pass that complements automated e2e. Takes a plan from the branch diff, from QA use-case ids, or from a ticket; preflights services, frontend and backend for the chosen environment ({{QA_ENVIRONMENT_NAMES}}); walks the flows; and writes an evidence-backed report to {{QA_REPORT_DIR}} plus a Q.A. section on the PR. Enforces this project's per-environment write policy and data-sensitivity rules before it opens the browser. Use when the user says "desk check this branch", "QA this branch", "check this in the browser", "does this actually work", "walk through the new flow", or before handing a UI change to review.
---

# Dev desk check

{{PROJECT_NAME}} ({{STACK_SUMMARY}}) ships UI changes that nothing walks end to end. This skill drives a real
browser through the running app the way a user would, judges what actually renders, and leaves evidence
someone who wasn't in the session can trust. It is the manual counterpart to automated e2e, not a substitute:
[add-e2e-test](../add-e2e-test/SKILL.md) owns automation, this owns the human-eye pass.

It exists because the manual checklist has no tooling. [create-qa-use-cases](../create-qa-use-cases/SKILL.md)
writes flows in user language specifically so a person can walk them, and then nothing executes them; the
automated suite that would cover the same ground is opt-in and usually skipped. So the whole job is to judge
**what renders, not what exists**. A component that compiles, a route that is registered, a query that returns
200 and a passing unit test are all evidence about code — none of them is evidence that a user can complete
the flow.

This skill is invoked deliberately. It is **not wired into `implement-plan`'s phase gate**: a browser pass per
phase is too slow to sit in a loop, the same reasoning that keeps `run_options.run_e2e` off by default. Run it
when a UI change is ready to be believed.

## Before anything else — browser tooling

Enumerate the browser-driving tools this harness actually exposes right now — a Playwright MCP server, a
Chrome DevTools MCP server, a browser or computer-use tool the runtime ships, a browser skill installed
alongside this one. Pick by preference:

1. The tool named in `run_options.dev-desk-check.browser`, if it is present and responding.
2. Otherwise any other browser-driving tool the harness exposes. Say which one you fell back to, and why, in
   the report's **Run** line — a reader comparing two runs needs to know they used different eyes.

**If no browser skill and no browser MCP server is available, this skill cannot run.** Say exactly that, name
what you looked for, and stop. Do **not** hand-roll Playwright, Puppeteer, Selenium or a headless-Chrome
script to get around it: writing automation is another skill's job, an unreviewed throwaway harness produces
evidence nobody can reproduce, and a browser pass this skill did not actually drive is worse than no pass.

## Step 0 — Resolve the run

Use `AskUserQuestion` for the finite choices, in **one batch**, and ask only what is still unresolved — if the
invoking message already named the environment or the plan source, take it and don't re-ask:

- **Environment** — options are exactly the declared environment names from the table below. Never invent one,
  never point the browser at a URL that is not in the table.
- **Plan source** — `Branch diff`, `QA use-case ids`, `Ticket / description`. Default the highlighted option
  to `run_options.dev-desk-check.scope`.
- **Screenshots** — `On` / `Off`, defaulting to `run_options.dev-desk-check.screenshots`. Always asked, even when
  the default is obvious (see Phase 2).

Anything genuinely free-form — which ticket, which use-case ids, which account role — is asked as open prose,
not squeezed into fixed options.

{{QA_ENVIRONMENTS_TABLE}}

## Phase 1 — Choose the plan source and build the plan

The plan is a numbered list of surfaces to reach and, for each, the **expected** result stated before the
browser opens. Writing "expected" after seeing the screen is how a run confirms whatever it happens to find.

### From the branch diff

{{QA_BASE_BRANCH_DETECTION_BLOCK}}

With the base resolved, list the changed files and map each to a **reachable surface** — a route, a modal, a
wizard step, a table column, a gated action, an empty state, an error state. One changed file can produce
several surfaces, and several files can collapse into one.

A changed file with **no reachable surface** is recorded, not walked: a migration, a management command, a CI
config, a type-only refactor. List those in the report's *Not tested* section with "no user-reachable surface"
as the reason, so a reader can see the diff was fully considered rather than partially read.

Surfaces the diff reaches only indirectly still count. If a shared component changed, walk at least one other
place it is used — the regression risk of a UI change lives mostly outside the feature it was written for.

### From QA use-case ids

{{QA_USE_CASES_BLOCK}}

This is the **strongest** plan source. The document already states the steps and the expected outcome, so
"expected vs actual" is read off rather than inferred. Quote each use case's id and title into the plan and
keep its wording; paraphrasing a checklist step is how its intent gets lost.

### From a ticket or description

The **weakest** source, because "expected" is being inferred rather than read. Derive concrete steps and a
concrete expected result for each, then **state the derived plan back to the operator and wait for a yes**
before opening the browser. Say plainly which parts you inferred. A plan built on a guessed expectation
produces a report that looks authoritative and tests the wrong thing.

{{QA_E2E_IMPACT_BLOCK}}

## Phase 2 — Resolve the run flags

Resolve everything Step 0 left open, and state the resolved set back in one line before Phase 3:

- **`--screenshots`** — resolved **explicitly, every run**, never assumed. Defaults come from
  `run_options.dev-desk-check.screenshots`, but a default is not a decision: a run that silently captured nothing
  leaves a report a reader cannot check, and a run that silently captured everything can put restricted
  records on disk. Whatever the answer, screenshot handling stays bounded by the environment's
  `data_sensitivity`. Captures land under `{{QA_REPORT_DIR}}`, alongside the report and the write ledger.
  Under `data_sensitivity` of `client` or `phi` that location is **required, not conventional** — that
  directory is gitignored, which is the whole reason it exists: a capture written anywhere else can be
  committed, uploaded to a PR or attached to a design tool by someone who never saw this run. Never write a
  capture to the repo root, a temp directory or a path of your own choosing.
- **`--scope`** — the plan source chosen in Phase 1.
- **`--browser`** — the tool actually selected above, not the configured preference.
- **`--writes`** — may only relax **within** the environment's declared `writes` policy, never upgrade past
  it. `--writes=allow` against a `forbidden` environment is refused, not honoured.
- **`--dry_run`** — from `run_options.dev-desk-check.dry_run` unless the operator overrode it. See the end of
  Phase 3b for where a dry run stops.

## Phase 3 — Preflight

Fixed order: **services → frontend → backend → data preconditions**. The order is not cosmetic. A dependency
that is down produces failures indistinguishable from product bugs, and a run that reaches the browser with a
dead queue spends its findings section describing the outage.

<!-- rendering note: {{QA_SERVICES_BLOCK}} owns its own `### Services pre-check` heading (h3 — it nests inside
this phase). Do not add a literal heading above it. When `skills.dev-desk-check.services` is absent or empty the
placeholder renders to the empty string and the whole region disappears, heading and all. -->

{{QA_SERVICES_BLOCK}}

### Frontend and backend

{{QA_PREFLIGHT_BLOCK}}

<!-- rendering note: {{QA_FEATURE_FLAGS_BLOCK}} owns its own `### Feature flags` heading. Do not add a literal
heading above it. When `skills.dev-desk-check.feature_flags` is absent or its `system` is `none`, the placeholder
renders to the empty string and the whole region disappears, heading and all — the alternative ships dead
advice about a flag system this project does not use. -->

{{QA_FEATURE_FLAGS_BLOCK}}

### Authentication

{{QA_AUTH_BLOCK}}

### Data preconditions

State, per planned surface, what data must already exist for the expected result to be meaningful: a record in
a particular state, a user with a particular role, a non-empty list to test pagination against. Check each
through the UI or a read-only query **before** walking, and treat a missing precondition as a write request —
it goes through Phase 3b like any other, and creating one is never a silent side effect of "just setting up".

A surface whose precondition cannot be satisfied is *Not tested* with that reason. It is not a Blocker: the
feature was never exercised, so there is nothing to call broken.

### When the preflight blocks the run

When a required service, the backend, or a feature flag blocks the run, **stop and name who to ask —
{{QA_ESCALATION_CONTACT}} — rather than testing around it.** A run that works around a blocker reports on
something other than the feature: a mocked response, a second dev server, a flag you flipped yourself, or a
switch to a different environment all produce a green report about a system nobody is going to ship. Record
what blocked it, what you tried, and what you need.

Proposing the fix is not working around it. Rule 7 in Phase 3b still applies: hand the operator the
ready-to-run command plus its reverse — the flag flip, the seed, the service start — and **wait**. What
invalidates a run is flipping the flag yourself and walking on, not offering the command and letting the
operator decide. Escalating without also proposing the change leaves them with a blocker and no next step.

## Phase 3b — Write authorization

{{QA_WRITE_POLICY_BLOCK}}

{{QA_DATA_SENSITIVITY_BLOCK}}

Before the browser opens, enumerate every write the plan requires. Each entry states what changes, how it will be identifiable afterwards, and its exact reversal:

```
PRODUCTION — app.acme.com — 1 write required:

  CREATE  draft invoice, title "QA 2026-09-09 — do not process"
  REVERSE delete draft #<id> (captured at creation)

Nothing else in the plan mutates. Confirm the environment and scope to proceed.
```

1. **The confirmation must name the environment.** A "go ahead" from earlier in the conversation, or approval of a different run, does not carry. Approving a staging write and approving a production write read identically in a transcript.
2. **`free` still keeps the ledger.** Authorisation to write is not a reason to stop tracking what was written. Ledger plus end-of-run revert offer apply in every environment.
3. **The ledger is written incrementally** to `{{QA_REPORT_DIR}}`, so a run that dies halfway still leaves a record.
4. **An unlisted write stops the run** for its own confirmation. Reversals are pre-authorised — they were named in the approved block.
5. **`forbidden` refuses and proposes.** State what would be required, record it, let the operator decide.
6. **Writes carry synthetic values only.** Never real client or patient data as input. Under `phi`, the ledger records opaque IDs, not field values.
7. **Setup writes stay propose-only in every environment.** Feature flags, seeds and migrations have a blast radius unrelated to the test — flipping a flag in production turns a feature on for every user it applies to, which is a release decision, not a QA step. Hand the operator a ready-to-run command plus its reverse and wait. App-data writes relax; setup writes do not.

When `run_options.dev-desk-check.dry_run` is true, print this block — the full plan, the resolved flags, the
preflight results and every write the run would require, with its reversal — and **stop here**. Do not open
the browser. A dry run's whole value is that it shows what a real run would touch while nothing has been
touched yet, so say explicitly that nothing was walked and nothing was written.

## Phase 4 — Open the browser

Open the selected tool at the chosen environment's `base_url`. Then, before walking anything:

- Confirm you are on the expected origin and the app has actually booted — a framework error page, a proxy
  interstitial and a blank white body all return quickly and all look like "the page loaded".
- Set a viewport wide enough for the layout the change targets, and say which viewport the run used. A
  responsive bug and a wrong-viewport bug are indistinguishable in a screenshot with no stated width.
- If the tool cannot reach `base_url`, retry once, then stop and report. Do not switch environments to get a
  page to load — an environment change makes the whole plan a different run and it must go back to Step 0.

When the preferred tool starts and then misbehaves, fall back per the rules in **Before anything else**, and
restart the walk from step 1 rather than stitching one plan across two tools.

## Phase 5 — Walk it as a user

Walk the plan in order, one numbered step at a time. For each step record: what you did, what you expected,
what you actually saw, and the result. Never batch several clicks and then interpret one screenshot.

### When the browser half-works

Browser tooling fails partially far more often than it fails cleanly, and a partial failure is
indistinguishable from a product bug unless you are looking for it.

- **A stale screenshot means blind clicks.** If the capture you are reading predates your last action, every
  coordinate you derive from it is a guess about a page that has moved on.
- **Confirm every state change you depend on.** After a navigation, a submit, a modal open or a tab switch,
  verify the new state before acting on it. Assume nothing landed because a click reported success.
- **Retire a sub-tool that fails twice.** One flake is noise; two is a broken sub-tool. Switch to another way
  of getting the same evidence — a different capture mode, reading the DOM, a fresh page load — instead of
  retrying the same call and accumulating uncertainty.
- **A stalled capture is not a stalled page.** The screenshot pipeline hanging says nothing about the app.
  Establish whether the page is alive by another route before reporting it as hung.

### Judge what renders, not what exists

- **Suspect your own tooling before filing a layout bug.** Overlap, clipping, zero-height containers,
  missing images and unstyled text are all classic artefacts of a partial or mid-paint capture. Reproduce the
  symptom — reload, re-capture, resize, read the computed geometry — before it becomes a finding.
- **Read the tool's evidence, not its generated description.** A summary, alt text, an accessibility tree
  label or a snapshot title is the tool's account of the page, not the page. Base every finding on what you
  can see or query directly, and quote that in the report.
- **Code is not a result.** Do not resolve a step by reading the component, the route table or the API
  response. If the flow could not be completed on screen, the step failed regardless of what the source says.

### Manual login

**The agent can never type a password, in any environment** — not local, not a throwaway staging account, not
one whose credential is sitting in a file it can read. When a step reaches a login form, or a session
expires mid-walk, **stop before the form**, name the account role the plan needs, and ask the operator to log
in. Resume only once they confirm. Never read a credential out of a `.env`, a vault export, a password
manager, a fixture or the operator's earlier messages, and never echo one anywhere.

<!-- rendering note: {{QA_DESIGN_SOURCE_BLOCK}} owns its own `### The design pass` heading. Do not add a
literal heading above it. When `skills.dev-desk-check.design_source` is absent or its `type` is `none`, the
placeholder renders to the empty string and the whole region disappears, heading and all. The rule that a
skipped design pass is recorded under *Not tested* with its reason and never silently dropped is therefore
also guaranteed from outside this region, by the Verification section's requirement that every planned surface
and pass land in **Walked** or in **Not tested** with a reason. -->

{{QA_DESIGN_SOURCE_BLOCK}}

## Phase 6 — Findings

Every finding gets a severity and an attribution. Both are judgements a reader will act on, so make them
explicit rather than implied by tone.

| Severity | Means |
|---|---|
| **Blocker** | The flow cannot be completed. Data loss, a hard error, an unreachable primary action. |
| **Major** | The flow completes but the outcome is wrong, or a supported path is broken. |
| **Minor** | Correct outcome, degraded experience — a bad message, a missing state, an awkward edge case. |
| **Cosmetic** | Visual or copy defect with no functional impact. |

Every finding carries **introduced by this change: yes | no | unknown**.

- **yes** — you have evidence it is new: the diff explains it, or you reproduced its absence on the base.
- **no** — you reproduced it on the base branch or in an untouched environment.
- **unknown** — you did not check. This is an honest, useful answer; a guessed **yes** turns a pre-existing
  bug into a review blocker for the wrong author, and a guessed **no** ships a regression.

Uncertainty belongs in the finding, not in a hedge around it: state what you saw, what you checked, and what
you could not check.

## Phase 7 — PR deliverable

Add or update a `## Q.A.` section on the PR, using `{{CODE_HOST}}`'s CLI or API. Update the existing section in
place on a re-run rather than appending a second one — two Q.A. sections make the reader guess which is
current.

The section carries a checkbox list of what was walked (checked = passed, unchecked = failed or not tested,
each with a one-line result), the findings by severity with their *introduced by this change* verdict, the
environment and plan source, and a link to the full report.

Under `data_sensitivity` of `client` or `phi`, **screenshots are not attached to the PR** and record contents
are not pasted into it. Link the gitignored report path instead, and say in the section that evidence is held
there because of this environment's data sensitivity — a reader who cannot find the screenshots must be able
to see why they are absent rather than conclude the run captured nothing. Under `phi`, the PR section and the
report both refer to records by opaque id only.

If there is no PR for this branch, say so and stop after Phase 8 — do not open one.

## Phase 8 — Report

Write to `{{QA_REPORT_DIR}}/<YYYY-MM-DD>-<slug>.md`, creating the directory if missing, using exactly this
skeleton:

```markdown
# QA report — <plan source> — <environment> — <YYYY-MM-DD HH:MM TZ>

**Run**: dev-desk-check · **Browser**: <tool> · **Screenshots**: <on | off> · **Dry run**: <yes | no>
**Plan source**: <diff vs <base> | use cases <ids> | ticket/description>
**Environment**: <name> — <base_url> · writes: <free | confirm | forbidden> · data sensitivity: <none | client | phi>
**Services**: <name: up | down | unknown>, … (omit this line when no services are declared)

## Walked

| # | Step | Expected | Actual | Result |
|---|---|---|---|---|

## Findings

### Blocker
### Major
### Minor
### Cosmetic

One bullet each: **<one-line title>** — what you saw and where. Introduced by this change: yes | no | unknown.

## Not tested

- <what> — <why>

## Writes performed

| # | Environment | What changed | Identifier | Reversal | Reverted? |
|---|---|---|---|---|---|

## Evidence

- <screenshot path, or "not captured — <reason>">
```

**A report listing only what passed is indistinguishable from one where nothing was tested. The *Not tested*
section is never omitted, and never empty when something was skipped.** Keep the empty severity headings too:
"no Blockers found" and "Blockers were never looked for" must not render the same way.

The *Writes performed* table is the ledger from Phase 3b, carried through — appended as each write happens,
not reconstructed at the end. Offer to reverse everything still unreverted before closing the run, and record
the verdict per row either way.

## Pitfalls

- **Reading an edge-proxy 403 as downtime.** A WAF or edge proxy answers non-browser traffic with 403 or 503
  by design. Behind one, `curl` says nothing about the app's health and the browser is the preflight. Killing
  a healthy run on that evidence is the same mistake as the next bullet, in a different costume.
- **Treating a missing probe binary as `down`.** A probe that cannot execute is **`unknown`**. A missing
  client binary is a fact about this machine, not about the service.
- **Starting a second dev server on an occupied port.** It binds a different port, or silently loses to the
  running one, and the whole run then tests a build nobody asked about. Probe first. Starting anything is
  **local-only and asks first**: only in an environment named `local`, only where that environment declares a
  start command, only with the operator's approval, and never a second copy. Everywhere else — and for a
  non-local environment that happens to declare one — propose the command and wait.
- **Letting an earlier "go ahead" carry into a production write.** Approval is per environment and per scope.
  Re-confirm, naming the environment, every time the write set changes.
- **Filing a layout bug that is really a stale screenshot.** Reproduce every visual defect on a fresh capture
  before it becomes a finding. This is the single most common false positive in a browser pass.
- **Falling back to `{{DEFAULT_BRANCH}}` when the PR CLI errored** rather than when there is genuinely no PR.
  "No PR exists" and "the CLI is broken or the token expired" are different answers, and only the first may
  fall back. A blanket fallback builds the plan from the wrong diff with nothing on screen saying so.
- **Reporting the environment you meant instead of the one you used.** Every header line, every finding and
  every ledger row names the environment actually driven.
- **Transcribing records into the report.** Under `client`, describe the shape of a record; under `phi`, use
  opaque ids only. Never paste field values into a report, a PR comment, a commit message or a log line.

## Verification

The run is complete when:

- **Every planned surface is either in *Walked* or in *Not tested* with a reason.** This covers passes as well
  as surfaces: a design pass that was skipped, or that this project declares no source for, is a *Not tested*
  entry with its reason — never silently dropped.
- **Every write in the ledger has a reversal recorded and a reverted verdict** (`yes`, `no — <reason>`, or
  `n/a`). No write appears in the report that was not in an approved authorization block, and no approved
  write is missing from the report.
- **The report exists** at `{{QA_REPORT_DIR}}`, follows the skeleton, and states the browser tool, viewport
  and environment actually used.
- **The PR carries a `## Q.A.` section** reflecting this run — or the report says explicitly that no PR
  exists.
- **Every finding carries a severity and an *introduced by this change* verdict**, and every visual finding
  was reproduced on a fresh capture.
