---
name: handoff
description: Write or consume a session-continuation handoff document under `.vinta-ai-workflows/handoffs/` so a fresh agent session (or a different agent / teammate) can resume in-flight work without re-deriving context. Use when the user says "hand this off", "write a handoff", "wrap this up for another agent", "prepare a handoff doc", or — in resume mode — "pick up from the handoff", "resume from handoff", or points at a handoff file. Captures goal, current state, decisions with rationale, files touched, verification status, and the exact next step.
---

# Handoff

Context dies with the session. A handoff document is the bridge: everything a fresh agent needs to continue the work, written down while the outgoing agent still knows it. The reader has none of your conversation history — write for someone who knows the codebase conventions but nothing about this task.

Two modes. Pick by what the user asked for:

- **Write mode** — capture the current task into a handoff doc. Trigger: "hand this off", "wrap up for another agent", "write a handoff before we stop".
- **Resume mode** — start from an existing handoff doc. Trigger: "resume from the handoff", "pick up where the last session left off", or the user pastes/points at a handoff file.

## Write mode

### 1. Gather real state — never from memory alone

Collect each of these from the repo, not from what you recall doing:

1. `git status --short` + `git diff --stat` — uncommitted work.
2. `git log --oneline <default-branch>..HEAD` — commits this task produced (skip if on the default branch).
3. Current branch name and its upstream/base.
4. Any in-flight plan or tracking artifacts: `ai-plans/*_IMPLEMENTATION_PLAN.md`, `TRACKING_*.md`, `.vinta-ai-workflows/prs-context/` files with `status: pending`.
5. Open PRs for this branch, if a PR CLI is available (`gh pr view` / `glab mr view`).
6. Test / lint / build status: what was last run, and did it pass? If you don't know, say "not verified" — do not guess.

### 2. Write the document

Path: `.vinta-ai-workflows/handoffs/{YYYY-MM-DD}-{task-slug}.md` (e.g. `2026-07-11-fix-invoice-rounding.md`). Create the directory if missing. If a handoff for the same task slug already exists, supersede it: write the new file with today's date and add a `supersedes:` line pointing at the old one — never silently overwrite.

Structure:

```markdown
# Handoff: {one-line task title}

- **Date:** {YYYY-MM-DD}
- **Branch:** {branch} (base: {base-branch})
- **Status:** {in-progress | blocked | ready-for-review}
- **Supersedes:** {path to previous handoff, or omit}

## Goal
What the task is trying to achieve and why — the original ask, plus any scope changes agreed with the user since.

## Current state
What is DONE and verified, what is done but NOT verified, what is not started.
Cite commits (`abc1234`) and files. Include the exact uncommitted-work summary
from `git status` if anything is uncommitted.

## Decisions made
Each decision the next agent must not accidentally relitigate:
- **{decision}** — {rationale}. Alternatives considered: {…, and why rejected}.

## Landmines
Gotchas discovered the hard way: flaky tests, misleading names, code that looks
wrong but is correct (and why), env quirks, anything you'd warn a teammate about.

## Next step
The SINGLE most important next action, concrete enough to start immediately
(file, command, expected outcome). Then the rest of the remaining work as an
ordered list.

## Verification
How to confirm the finished work is correct: commands to run, flows to exercise,
what "passing" looks like.
```

### 3. Quality gate before saving

- Every claim of "done" is backed by a commit hash or a passing command you actually ran this session. Anything else is labeled "not verified".
- No references to "the conversation", "as discussed above", or "earlier" — the reader has no conversation.
- A stranger could execute **Next step** without asking a question.

### 4. Tell the user where it landed

Report the file path. Note that `.vinta-ai-workflows/` is typically gitignored — if the handoff must reach another machine or teammate, they should share the file explicitly or commit it deliberately.

## Resume mode

1. **Read the handoff doc** in full. If the user didn't name one, list `.vinta-ai-workflows/handoffs/` and pick the most recent that isn't superseded; confirm the pick with the user if more than one task is plausible.
2. **Verify its claims against the repo before trusting them.** The repo may have moved since the handoff was written:
   - Named branch exists and you're on it (or switch after confirming with the user).
   - Cited commits exist (`git log`), cited files exist, `git status` matches the described uncommitted state.
   - Re-run the cheapest verification command from the **Verification** section to confirm the "done" claims still hold.
3. **On mismatch, stop and reconcile** — tell the user what the handoff claims vs. what the repo shows. Never continue from stale premises.
4. **Adopt the decisions.** Treat **Decisions made** as settled unless the user reopens one; do not re-explore rejected alternatives.
5. **Continue from Next step.** When the work later stops again unfinished, write a fresh handoff (write mode) superseding this one.

## Pitfalls

- **Writing the handoff from memory.** The doc says "tests pass" but they were never run after the last edit. Gather state from the repo (step 1) — every time.
- **Recording what happened instead of what's next.** A chronological diary of the session is not a handoff. The reader needs current state + next action, not the journey.
- **Omitting rejected alternatives.** The next agent re-derives the rejected approach, spends an hour, and hits the same wall. One line per rejection prevents this.
- **Vague next step.** "Continue the refactor" is useless. "Extract the retry logic in `client.py` into `retry.py`, then make `test_client.py` pass again" is a handoff.
- **Resume mode trusting the doc blindly.** Handoffs go stale — a teammate may have pushed to the branch since. Verify (resume step 2) before building on it.

## Verification

- Write mode: the file exists at the reported path, follows the structure above, and contains no unverified "done" claims.
- Resume mode: repo state matched the doc (or mismatches were surfaced), and work continued from the doc's **Next step** — not from a fresh re-derivation.
