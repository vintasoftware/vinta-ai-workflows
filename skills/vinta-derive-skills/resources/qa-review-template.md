---
name: qa-review
description: Walk a feature in {{PROJECT_NAME}} in a real browser and write up what you find, for product managers and designers who have no code checkout. Takes a use case, a ticket, or a plain description — never a diff. Covers {{QA_ENVIRONMENT_NAMES}}. Confirms the app is reachable, walks the flow as a real user would, compares against the design where one exists, and produces a shareable report of what worked, what did not, and what could not be tested. Use when someone says "check the new flow works", "QA this before we announce it", "does this match the design", or "walk through this feature and tell me what's broken".
---

# QA review

Someone needs to know whether a feature in {{PROJECT_NAME}} actually works before it is announced, demoed or
put in front of a client. This skill walks the app in a real browser the way a person would, one step at a
time, and writes up what happened: what worked, what did not, and what could not be checked. It is for the
people who judge the product by using it — product managers, designers, support leads — not for the people
who read its code.

The job is to report, never to fix. A finding that lands in a ticket with what was seen, where, and what was
expected is worth more than a guess at the cause.

## What this file is

This file is self-contained. Everything it needs is written into it: which environments exist, where they
are, which account to use, what may be changed and what may not, and what to compare against. There is
**nothing here that needs a code checkout, a terminal, or access to the project's code**, and nothing to install.

Some of what is written below is a snapshot taken on the day this file was generated. When a fact in it looks
wrong — an address that has moved, an account that no longer exists — do not work around it. Ask
{{QA_ESCALATION_CONTACT}}, who is also who to ask whenever a review is blocked, and see **Where this file
came from** at the end for how to get a fresh copy. Being blocked is a normal outcome: it gets recorded.

## Before you start

You need three things and only three:

1. A browser.
2. An account on the environment you are going to test. **You sign in yourself** — see Step 3.
3. The thing you are checking: a use case, a ticket, or a description of the feature in your own words.

## Step 0 — What are you checking, and where

Use `AskUserQuestion` for the fixed choices, in **one batch**, and ask only what is still open — if the
person already named the environment or handed over a ticket, take it and do not ask again.

- **Environment** — the options are exactly the names in the table below. Never invent one, and never point
  the browser at an address that is not in the table.
- **What to check** — `A use case`, `A ticket`, `A description of the feature`.
- **Screenshots** — `On` / `Off`. **Always asked**, even when the answer seems obvious. A review that
  silently captured nothing leaves a report nobody else can check, and one that silently captured everything
  can put real records into a picture that then gets shared. Whichever it is, the rules in Step 4 about what
  may appear in a report still apply to every capture.

Anything genuinely open — which ticket, which account, which part of the flow matters most — ask as plain
prose rather than squeezing it into fixed options.

{{QA_ENVIRONMENTS_TABLE}}

## Step 1 — Get the steps

{{QA_USE_CASES_BLOCK}}

Then, whatever the source: **state the steps and the expected outcome back before walking.** A numbered list,
one line per step, each with what should happen if the feature works. Wait for a yes before opening anything.

When the steps came from a description rather than a written use case, that restatement is the only place
"expected" ever gets pinned down, so say plainly which parts you worked out yourself. A review that decides
what "expected" meant after seeing the screen confirms whatever it happens to find.

## Step 2 — Check the app is up

**Browser only. There is nothing here to start, and nothing to install.**

Open the chosen environment's address from the table above. Before walking anything, confirm the app really
loaded: an error page, a holding page from whatever sits in front of the app, and a blank white page all
arrive quickly and all look like "the page loaded".

If the page does not load, **that is the result.** Write down the address you opened, the time, and what
appeared instead, then stop and tell {{QA_ESCALATION_CONTACT}}. Do not move to a different environment to get
something on screen — that makes it a different review, and it goes back to Step 0.

## Step 3 — Sign in

{{QA_AUTH_BLOCK}}

**You sign in yourself.** It is your own account, so this is simple: when a step reaches a sign-in screen, or
the app signs you out partway through, the agent stops before the form and waits for you. It never types a
password, in any environment, and never reads one out of a file, a note or an earlier message.

<!-- rendering note: {{QA_FEATURE_FLAGS_BLOCK}} brings its own h3 heading, in reviewer language (e.g.
`### Settings that turn features on`), and renders to the **empty string** when
`skills.qa-frontend.feature_flags` is absent or its `system` is `none`.
That is safe here: it is the trailing block of a step that has other content, so nothing is orphaned and no
numbered heading disappears. The qa-review variant names the *setting* in the words a reviewer would use and
never the name of the system behind it. -->

{{QA_FEATURE_FLAGS_BLOCK}}

## Step 4 — Before you change anything

{{QA_WRITE_POLICY_BLOCK}}

{{QA_DATA_SENSITIVITY_BLOCK}}

Before anything is saved, created, sent or deleted, list every such action the walk needs. Each entry says
what it changes, how you will find it again afterwards, and exactly how it gets undone. Then get a yes that
**names the environment** — an approval given earlier, or for a different environment, does not carry.

- **Only make a change you can undo yourself, through the app.** The full write policy above still applies, but a reviewer cannot run a revert script. Anything you cannot undo through the screen in front of you is not yours to authorise — write it down as "this needs an engineer" and move on.
- **Blocked is a result, not a failure.** You cannot turn a feature on. "Blocked by the <name> setting — ask an engineer to enable it" is the correct outcome, recorded under *Not tested*, not reported as broken.
- **Use obviously fake values.** Never a real person's details as input. Name test records so anyone finding them later knows what they are — for example, a title ending in "— QA, do not process".

Keep the list as you go, not at the end — a review that stops halfway should still say what it changed.

## Step 5 — Walk it as a user

Walk the steps in order, one at a time. For each one, record what you did, what you expected, what actually
happened, and the result. Never click through five things and then read a single screenshot backwards.

### When the browser only half-works

Browser tooling goes wrong partly far more often than it goes wrong cleanly, and a partial failure looks
exactly like a bug in the product unless you are watching for it.

- **If the screen you are looking at might be out of date, refresh and confirm before you click on.** A
  picture taken before your last action tells you where things used to be, and every click aimed from it is a
  guess about a page that has moved on.
- **Confirm every change of state you then rely on.** After moving to a new page, saving, opening a dialog or
  switching tabs, check the new state is really there before acting on it. A click that reported success is
  not proof that anything landed.
- **If a tool fails twice, stop using it rather than fighting it.** One glitch is noise; twice is broken. Get
  the same evidence another way — reload the page, capture it differently, read the screen yourself. Retrying
  the same failing thing only piles up uncertainty about what you are looking at.
- **A capture that will not finish is not a page that has stopped.** When taking a picture hangs, that says
  nothing about the app. Find out another way whether the page is still alive before reporting it as stuck.

### Judge what you can see

- **Rule out your own screen or connection before filing something as broken.** Overlapping text, cut-off
  boxes, zero-height gaps, missing images and unstyled text are the classic marks of a picture taken while
  the page was still drawing. Reproduce it — reload, resize, capture again — before it becomes a finding.
- **Trust the screen, not a description of it.** A summary or a label attached to a capture is somebody's
  account of the page, not the page. Base findings on what you can see, and quote it in the report.
- **"It is there" is not "it works".** If the flow could not be completed on screen, the step failed.
- **Say which window size you used.** A layout that breaks only at one width and a layout that is simply
  broken look identical in a picture with no stated size.

## Step 6 — Compare against the design

<!-- rendering note: unlike the qa-frontend variant, the qa-review variant of {{QA_DESIGN_SOURCE_BLOCK}} is
**never** the empty string, because the heading above it is a numbered step and a vanished heading would leave
a hole in the sequence the reader is following. When the project declares no design source it renders the
single line: `There is no design to compare against on this project. Note that under *Not tested* and move
on.` This variant also carries **no heading of its own** — Step 6's heading above is the literal one. And it
never names the tooling behind a design file; it says to open the file and compare side by side. -->

{{QA_DESIGN_SOURCE_BLOCK}}

When you compared against exported images rather than the live design file, **say so in the report** —
exports can be older than the design, so a difference may mean the export is out of date rather than the app
being wrong.

If there was no comparison — no design, no access, no time — that goes under *Not tested* with the reason. A
missing design comparison is never silently dropped.

## Step 7 — What you found

Every finding gets a severity and a design verdict. Both are judgements someone will act on, so state them
rather than leaving them to the tone of the writing.

| Severity | Means |
|---|---|
| **Blocker** | The flow cannot be finished. Lost work, a hard error, a main action you cannot reach. |
| **Major** | The flow finishes but the outcome is wrong, or a supported path is broken. |
| **Minor** | Right outcome, worse experience — a confusing message, a missing state, an awkward edge case. |
| **Cosmetic** | It looks or reads wrong, and nothing is broken. |

Every finding also carries **matches design: yes | no | n/a**.

- **yes** — you compared it against the design and it matches.
- **no** — you compared it and it does not. Name the part that differs.
- **n/a** — there was nothing to compare against, or you did not compare. Honest and useful; a guessed
  **no** sends someone to change a screen nobody asked about, a guessed **yes** lets a real difference through.

Uncertainty goes inside the finding, not in a hedge wrapped around it: what you saw, what you checked, and
what you could not check.

## Step 8 — Share it

{{QA_ARTIFACT_DELIVERABLE_BLOCK}}

**This never touches a pull request. The report goes wherever the team reads it — a ticket, a channel, a
shared link.**

## Step 9 — The report

Write it for someone who was not there and who will read it a week later. Use exactly this skeleton:

```markdown
# QA review — <what you checked> — <environment> — <YYYY-MM-DD HH:MM TZ>

**Checked by**: <name> · **Screenshots**: <on | off>
**What was checked**: <use case id and title | ticket | description>
**Environment**: <name> — <address>

## Walked

| # | Step | Expected | What actually happened | Result |
|---|---|---|---|---|

## Findings

### Blocker
### Major
### Minor
### Cosmetic

One bullet each: **<one-line title>** — what you saw and where. Matches design: yes | no | n/a.

## Not tested

- <what> — <why>

## Changes made

| # | What changed | How to find it | Undone? |
|---|---|---|---|

## Evidence

- <screenshot, or "not captured — <reason>">
```

**A report listing only what worked is indistinguishable from one where nothing was tested. The *Not tested*
section is never omitted.** Keep the empty severity headings too: "no Blockers found" and "Blockers were
never looked for" must not read the same way.

When a report is kept as a file rather than shared as a link, it belongs at `{{QA_REPORT_DIR}}`.

## Pitfalls

- **Filing a layout bug that is really an out-of-date picture.** Reproduce it on a fresh capture first — the
  single most common false alarm in a browser pass.
- **Letting an earlier "go ahead" carry into a change somewhere real.** Approval is per environment and per
  list of changes — ask again, naming the environment, whenever either changes.
- **Reporting the environment you meant instead of the one you used.** Name the one actually opened.
- **Copying record contents into the report.** Describe the shape of what you saw — "a client record with
  no billing address" — rather than pasting field values into a report, a ticket or a message.
- **Calling something broken because you could not switch it on.** That is *Not tested*, with who to ask.
- **Working around a blocker to keep the review moving.** A different environment, a different account, or a
  setting somebody switched on for you produces a clean report about something nobody will ship. Record what
  blocked it, what you tried, and what you need.

## Verification

The review is finished when:

- **Every step is either in *Walked* or in *Not tested* with a reason** — including the design comparison.
- **Every finding carries a severity and a matches-design verdict**, visual ones re-checked on a fresh capture.
- **Every change you made is listed** with how to find it and whether it was undone.
- **The report follows the skeleton** and names the environment and window size actually used.
- **Nothing in the report is a real person's details** or the contents of a real record.

## Where this file came from

{{QA_REVIEW_PROVENANCE_BLOCK}}
