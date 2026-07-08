---
name: thermo-nuclear-code-quality-review
description: Run an extremely strict maintainability review of a diff — abstraction quality, giant files, and spaghetti-condition growth. This is a deep, on-demand structural audit, harsher than the normal per-phase review: it hunts for "code judo" reframes that make whole branches, helpers, modes, or layers disappear rather than polishing what's there. Use when the user asks for a "thermo-nuclear code quality review", "thermonuclear review", "deep code quality audit", or "harsh maintainability review", or when the standard review flow escalates a structural concern. Opt-in only — do not auto-run it on every diff; it is meant to be invoked deliberately. Read-only: it reports findings and hands each fix to a fixer, it does not edit code itself.
disable-model-invocation: true
---

# Thermo-nuclear code quality review

An intentionally severe maintainability audit. The normal review checks that a change is correct, tested, and in-convention. This review asks a harder question: **is the change structured as well as it could be, or did it grow complexity that a better framing would have avoided?**

The mindset is **ambitious structural simplification**, not incremental cleanup. Look for reframes that make whole branches, helpers, modes, conditionals, or layers disappear entirely — a "code judo" move that preserves behavior while collapsing the structure. Do not approve a change merely because it works.

This is a heavy, deliberate pass. It is **not** part of the automatic per-phase review — run it when asked, or when the standard `review-phase` review escalates a structural concern it can't fully resolve. (See "Relationship to the standard review flow" below.)

## When to use / when to skip

Use it when:
- The user explicitly asks for a thermo-nuclear / deep / harsh maintainability review.
- A phase touched core architecture, added a large file, or introduced branching that "smells" — and the standard reviewer flagged it for a deeper look.
- Before merging something large or long-lived where structure matters more than speed.

Skip it when:
- The diff is a small, self-contained fix, a docs/comment change, or generated output. Running a thermo-nuclear pass on a two-line change wastes effort and produces noise.
- Correctness is the open question, not structure — use the standard review or the `systematic-debugging` skill for that.

## Scope

Default scope is the current change set: find it with `git diff --stat` / `git status --short` against the base the work started from (or the phase diff, when a review conductor passes one). If the user names a PR, a directory, or specific files, use that scope instead.

Read the **full diff** of every file in scope, plus enough of each touched file's surroundings to judge structure — a diff line looks innocent until you see the 1,200-line file it lands in.

## The standards (all non-negotiable)

0. **Ambitious structural simplification.** Look for opportunities to reframe the change so that whole branches, helpers, modes, conditionals, or layers disappear entirely. This is the primary lens; the rest are specific ways it shows up.
1. **File-size boundary.** Do not let a change push a file from under ~1,000 lines to over ~1,000 lines without a very strong reason, especially when the added code is extractable.
2. **Spaghetti growth.** Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows.
3. **Design-first bias.** If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version.
4. **Direct code preference.** Treat brittle, ad-hoc, or "magic" behavior as a code-quality problem, not a clever solution.
5. **Type and boundary cleanliness.** Question unnecessary optionality, `unknown`, `any`, or cast-heavy code when a clearer type boundary could exist. (Apply the equivalent in the project's language — loose typing, stringly-typed data, escape hatches.)
6. **Canonical layer logic.** Call out feature logic leaking into shared paths, or implementation details leaking through an API boundary. Reuse existing canonical utilities instead of bespoke duplicates.
7. **Sequential orchestration.** If independent work is serialized for no good reason, ask whether the flow should run in parallel, and whether partial-update logic leaves state less atomic than it should be.

## Primary review questions

Apply these systematically to the diff:

1. Is there a "code judo" move that would make this dramatically simpler?
2. Can this change be reframed so fewer concepts, branches, or helper layers are needed?
3. Does this improve or worsen the local architecture?
4. Did the diff add branching complexity where a better abstraction should exist?
5. Did a previously cohesive module become more coupled, more stateful, or harder to scan?
6. Is this logic living in the right file and layer?
7. Did this change enlarge a file or component past a healthy size boundary?
8. Are there repeated conditionals that signal a missing model or missing helper?
9. Is the implementation direct and legible, or does it rely on special cases and incidental control flow?
10. Is this abstraction actually earning its keep, or is it just a wrapper?
11. Did the diff introduce casts, optionality, or ad-hoc object shapes that obscure the real invariant?
12. Is this logic in the canonical layer, or did the diff leak details across a boundary?
13. Is this orchestration more sequential or less atomic than it needs to be?

## Flag aggressively

- A complicated implementation where a cleaner reframe could eliminate whole categories of complexity.
- Refactors that move code without reducing conceptual overhead for readers.
- Files crossing ~1,000 lines because of this change, especially when the added code is extractable.
- New conditionals bolted onto unrelated code paths.
- One-off booleans, nullable modes, or flags complicating existing control flow.
- Feature-specific logic leaking into general-purpose modules.
- Generic "magic" handling that obscures a simple structure.
- Thin wrappers or identity abstractions adding indirection without clarity.
- Unnecessary casts, `any` / `unknown`, or optional params muddying contracts.
- Copy-pasted logic instead of an extracted helper.
- Narrow edge-case handling wedged into the middle of already-busy functions.
- Refactors that technically pass tests but reduce modularity or readability.
- "Temporary" branching that is likely to become permanent debt.
- Bespoke helpers duplicating existing canonical utilities.
- Logic placed in the wrong layer/package when more central ownership exists.
- Sequential async flow where independent work could run in parallel.
- Partial-update logic that leaves state less atomic than necessary.

## Approval bar

Treat these as blockers unless there is a strong, stated justification:

- Plausible code-judo moves exist but were left unexplored.
- A file crosses ~1,000 lines because of this change without a compelling reason.
- Ad-hoc branching tangles an existing flow.
- Feature checks scatter across shared code to solve a local problem.
- Unnecessary abstractions, wrappers, or cast-heavy contracts increase indirection.
- Existing helpers are duplicated, or logic lands in the wrong canonical layer.

Do not approve merely because behavior seems correct.

## Output format

Report findings prioritized in this order:

1. Structural code-quality regressions.
2. Missed opportunities for dramatic simplification / code-judo restructuring.
3. Spaghetti / branching complexity increases.
4. File-size and layering violations.
5. Type / boundary and duplication issues.

For each finding: name the file and lines, state the concrete regression, and — this is the point of the review — describe the reframe that removes it, not just "this is complex." Do not flood the review with low-value nits when larger structural issues exist; a page of naming quibbles buries the one restructuring that matters.

Triage each finding like the standard review does:
- **BLOCKER** — must fix before merge (matches the approval-bar list above).
- **SHOULD-FIX** — fix now if cheap, otherwise a tracked follow-up.
- **NIT** — mention only if trivially cheap.

## Relationship to the standard review flow

This skill is read-only, like the project's normal review. It does not edit code. When a finding warrants a change, hand it to the project's `fixer` agent ([ai-tools/agents/fixer.md](ai-tools/agents/fixer.md)) with the finding quoted verbatim, exactly as the standard fix loop does.

The per-phase review (the `reviewer` agent, [ai-tools/agents/reviewer.md](ai-tools/agents/reviewer.md)) applies a condensed version of standard 0 on every phase — "is there an obvious code-judo reframe?" When that lens surfaces something structural that deserves a full audit, the reviewer escalates by invoking this skill against the phase diff. Reserve the full pass for when it earns its cost; the condensed lens is enough for routine phases.

## Pitfalls

- **Nit flooding.** The failure mode of a harsh review is a wall of trivial comments that hides the one finding that matters. Lead with structure; drop the nits.
- **"Cleaner" that is not.** A reframe that trades one form of complexity for another, or that hurts readability to save lines, is not a win. Only push a change when it genuinely reduces conceptual overhead.
- **Rewriting for taste.** Behavior must be preserved. This is a review, not a redesign mandate — propose reframes, quote them as findings, and let the fixer and conductor decide.
- **Running it everywhere.** It is opt-in for a reason. Auto-running it on every small diff produces noise and slows the flow.

## Verification

- Every finding names a concrete file/line and a specific reframe, not a vague "too complex."
- Findings are ordered by the priority list above, BLOCKER first.
- The pass edited no code directly — any change went through a fixer.
- If nothing structural was found on a large, multi-file diff, you looked again before saying so.
