---
name: deslop-comments
description: Rewrite code comments and docs touched during the current conversation into Simple English, stripping AI-slop / AI-lingo vocabulary and negative framing, and delete the ones that should not be there at all. Use when the user says "deslop these comments", "clean up the comments we just wrote", "rewrite this in plain English", or after a review flags comments as convoluted/AI-sounding. Comment-only - never changes function names, APIs, or behavior.
---

# Deslop comments

Rewrites comments and doc blocks into short, direct Simple English, and deletes the ones that should not be there. This is a comment-only pass: no renames, no logic changes, no behavior changes.

Prefer fewer and shorter comments. Deleting one is a normal result, not a last resort. Default to one line, and add more only when the extra lines say something the code cannot.

Some comments only need rewording. Others should not exist at all, whatever the wording - a list of call sites, another module's internals, a plan that never shipped. Delete those; making them shorter does not help.

## Scope

Default scope is **files the current task actually created or edited** - find the candidate set with `git diff --name-only` / `git status --short` against the base the conversation started from. If the user names specific files, a directory, or a Pull Request instead, use that scope.

Do not expand scope to a file just because the agent `Read` it or reviewed it in passing - a debugging or review session routinely reads many unrelated files, and reading one is not authorization to rewrite its comments. If there is no edited-file set and no explicit scope from the user, ask which files to cover.

## What counts as slop

Rules 1-5 are usually reworded. Rules 6-12 are usually deleted.

1. **Dense, multi-clause sentences** that try to explain everything at once instead of one idea per sentence. Split a sentence that adds a second thought.
2. **Negative / before-state framing** - describing removed code, or leading with "not X" when X was never the point. Keep "not X, it's Y" only for a genuine edge case or a non-obvious gotcha.
3. **AI buzzwords** in place of plain software engineering vocabulary. Common offenders and their replacements:
   - `gate` / `gates` / `gating` → "check", "decides whether to show...", "authentication check", "feature check"
   - `guard` → "check" / "prevent"
   - `backstop` → "handles the case where..." / "protects us either way"
   - `load-bearing` → "useful"
   - `predicate` → "helper"
   - `presentational` (component) → "this component only displays the result"
   - "flattens to a bare new Error" → "turns into a plain new Error"
   - `harness` → name the concrete thing: "test setup", "test wrapper", "fixture", "mock server", or "runner"
   - `realm` → "environment", "runtime", or "context" (unless it's the precise JS-realm technical term)
   - `landed` → "implemented"
   - `mint` → "created"
   - `leverage` → "use"
   - `utilize` → "use"
   - `surface` → "show" / "return" / "report"
   - `plumb` / `wire` → "pass" / "connect" / "call"
   - `broker` → "handle" / "route" / name the service/helper (keep broker if that's the concept name in some architecture, library, service, etc.)
   - `canonical` → "shared" / "standard"
   - `churn` → "unnecessary changes"
   - `invariant` → "rule" / "condition" / "constraint" / or something like "state that must stay true"
   - `gloss` → "explanation" / "note"
   - `roll-call` → "list of call sites"
   - `signal` (meaning a hint) → "sign", or drop the word and say what to check
   - `the tell` → "to tell them apart, ask whether..."
   - `unpick` → "work out" / "read twice"
   - `papering over` → "hiding", or name the real fix ("fix the type instead")
   - `strictly worse` → "worse", and say why
   - `earns its place` → say what to do instead: "delete it unless it explains X"
   - "asks nicely" (for something that isn't enforced) → name the mechanism: "a comment does not fail when the code changes; a test does"
   - "prefers X over Y" → "uses X, or Y when there is no X"
   - `failure` for a wording problem → name the problem: "this is the part to fix"

     Do not apply this as a blind blacklist. Keep the original word when it is the precise domain term, especially for security, type-system, React, database, FHIR, or JavaScript runtime concepts. For example, `opaque` is a precise security/API term for an id, token, or string whose structure and meaning a caller must not depend on ("recipient is an opaque viewer-supplied string; never log it"); it is not on the replacement list above, so leave it — "generic" would drop that contract.
4. **Essay voice.** Write plain statements a reader can check, not persuasion. No sayings ("most do not clear that bar"), no "it looks like X but is really Y", no treating code as if it wants things ("the ideas want to be separate sentences"), and no metaphor where an instruction fits ("earn its place" → "delete it").
5. **Undocumented return shapes.** A function returning an object or union should say what each field or variant means, not just that it "returns a result". TypeScript covers most of this, so raise a missing type in the conversation as a code fix instead of describing the shape in a comment. This is the one rule that can make a comment longer, so apply it only where the field names do not already answer it: `{ ready, missingSteps }` needs no explanation, `{ status, mode }` does.
6. **Where-used lists.** Naming the call sites of a helper, type, or constant, or the features that use it. Call sites move, get added, and get deleted, and the comment does not follow them - so it is wrong the first time someone adds a second caller, and the editor already answers the question with "find all references". Say what the thing is and why it exists. Keeping a *reason* that happens to involve other code is fine ("shared, so the count and the list cannot disagree"); listing *which* code is not ("shared by the list, the count and the latest scan").
7. **Another module's internals, explained from here.** A comment on A that explains how B works behind its own API. Nobody editing B will think to update it, so it goes stale silently. Say what this code needs, and let B's own comment explain B. The same applies downward: do not explain a caller's behaviour from inside the thing being called.
8. **One decision explained in several places.** Three sites explaining the same design decision give three wordings that drift apart, and a reader cannot tell which is current. Which way to fix it depends on the code:
   - **The code is duplicated too** (two apps with the same database setup). Repeat the comment in full at each copy. Each file has to be readable on its own, so do not shorten one copy to a link pointing at the other.
   - **One decision shows up in several places.** Say a mapper leaves `documentUrl` out of the rows it returns, the row type leaves it out to match, and the app fills it in later. That is one decision seen from three files. Write the reason once at the place that makes it - the mapper that leaves the field out - and at the other two say only what a reader there needs. See the `documentUrl` example below.

   A link is fine for extra depth ("more info in `x.ts`"). A link is not enough when the reader needs it to understand the line in front of them - inline that sentence instead.
9. **Restating the code.** A comment that is just explaining what is already written in code: a visible fallback chain, the steps of a loop, or a parameter's name and its type in prose ("`reportsByOrderId` holds the report for each order, keyed by the order's id" for `reportsByOrderId: Map<string, DiagnosticReport>`). Comment the part that is *not* on screen: why this order, why this default, what breaks otherwise.
10. **A comment standing in for a name.** When the comment exists to explain what a condition or a function means, the name is the fix: `shouldSendErrorToSentry(error)` instead of a note above a negated two-part condition. Renaming is out of scope for this pass, so report it and leave the comment alone - see "When the fix is not a comment edit".
11. **Plans, deferred work, and requests.** "Once X is supported we can drop this", "temporary until Y", "as requested in review". None of it is verifiable from the code, most of it never happens, and it outlives the conversation that produced it. Real follow-up work belongs in a tracked ticket, and the comment should link that ticket or say nothing.
12. **Paths not taken.** "Tried X, settled on Y", "started with a Map, an array was simpler". If X was never committed it was a draft, and drafts are not part of the code's history. If X was committed, git and the PR record it better than a comment can. Cut the alternative and keep what the code has to do now.

    One thing this is not: a fact about an external system, even when you found it by trying the other thing first. `PUT Binary/<id>` returning 404 is Medplum's behaviour, so write it that way - a property of the API, with no author and no alternative in it.
13. **Any other AI-slop or AI-lingo words, framing, structure.**

## What to leave alone

- Function, type, and API names - this is a comment-only pass.
- Log strings and error messages shown to users.
- Generated files (e.g. `*.gen.ts`, Prisma client output).
- Genuine security markers or contracts written as caps-negatives (`NEVER log PHI`, `Does NOT upsert`) - these are useful warnings, not slop.
- User-facing UI copy (JSX text nodes rendered to the browser) - that's product copy, not a code comment.
- Already-clear one-liners that don't exhibit any of the problems above. Don't rewrite for the sake of rewriting.
- **The reason a non-obvious line exists** - why this order, why this default, what an external system does, what breaks without the line. This pass removes noise, not knowledge, so keep the reason and shorten the wording instead.
- **A comment repeated because the code is repeated.** Two apps with the same setup step each keep their own copy. See rule 8.

## Process

1. Build the file list per Scope above.
2. Read every comment/doc block in each file (`//`, `/* */`, `/** */`, `#`, `%`, depending on the language) and check it against "What counts as slop". Skip anything under "What to leave alone".
3. Check every comment next to changed code for claims that are no longer true, including comments this task did not write. A comment goes wrong when the code under it moves, and nothing fails: no test, no type error, no lint rule. This is the one check a reader cannot make from the comment alone.
4. Decide **delete or reword** before editing. Rules 1-5 are rewordings. Rules 6-12 are usually deletions - cut the comment, or cut the offending part and keep the rest.
5. Find the duplicates across the whole file set before editing anything. Rule 8 needs the full set to decide which copy stays; one file at a time leaves the same reason in three places, each slightly reworded.
6. Rewrite in place with `Edit`. One idea per sentence.
7. Grep the edited files for every word listed in rule 3, including comments this pass just wrote. Reading for them does not work: they get written and then skimmed past, in the same file that lists them. A hit is not automatically wrong - rule 3 keeps the precise domain term, `signal` is right for `AbortSignal`, and a function genuinely named `isGated` matches - so check each one. This covers rule 3 only; the other rules need judgement.
8. Confirm the diff is comment-only: `git diff -- <files>` should show no code-line changes.
9. Run the project's lint/typecheck on touched files (e.g. `pnpm biome check <files>`, `pnpm --filter <pkg> typecheck`).
10. Summarize in 1-2 sentences, with the comment-line count before and after. List separately, since neither is a style note: any comment that was **factually wrong**, and anything left in place per the next section.

## When the fix is not a comment edit

This pass edits comments and nothing else. When the right fix is a test, a rename, or splitting a function, leave the comment alone and report it, naming the file and what has to exist first: "`use-lab-results.ts:44` - this note can go once a regression test covers the sort flip. Left in place; that test does not exist yet." Never delete a comment whose knowledge has nowhere else to live yet.

## Examples: what a comment says

Bad (rule 6, a list of today's three callers):
```ts
/** Shared by the list, the count and the latest scan, so the tile cannot count a row the list omits. */
const LAB_ORDER_SEARCH = { category: LAB_ORDER_CATEGORY }
```

Good (keeps the reason, drops the list):
```ts
/** Narrows a `ServiceRequest` search to lab orders. Every read here shares it, so none can disagree. */
const LAB_ORDER_SEARCH = { category: LAB_ORDER_CATEGORY }
```

Bad (rule 8, first case - this file cannot be read without opening another app):
```ts
// Remove sslmode from the URL so it does not conflict with the ssl object above.
// More info on shl-server/src/db.ts
```

Good (the same explanation in full at each copy):
```ts
// Remove sslmode from the URL so it does not conflict with the ssl object above: node-postgres
// rejects the connection when both are set.
```

Bad (rule 8, second case - one decision about `documentUrl`, repeated in all three files):
```ts
// types.ts
/** A mapped lab row. The mapper knows whether a document exists; only the app knows its url. */
export interface LabResultRow extends Omit<LabResultView, 'documentUrl'> { ... }

// mappers.ts
/** Maps lab orders to rows. No `documentUrl`: the mapper knows a document exists; only the app knows its url. */
export function mapLabResults(...)

// use-lab-results.ts
/** Adds `documentUrl`. The mapper knows whether a document exists; only the app knows its url. */
function withDocumentUrl(row: LabResultRow): LabResultView
```

Good (the reason sits with the mapper, since that is what leaves the field out; the other two say only what a reader there needs):
```ts
// types.ts
/** A mapped lab row, before the app fills in `documentUrl`. */
export interface LabResultRow extends Omit<LabResultView, 'documentUrl'> { ... }

// mappers.ts
/** Maps lab orders to rows. Leaves out `documentUrl` because the url depends on how the app serves binaries; each row carries `reportId` instead. */
export function mapLabResults(...)

// use-lab-results.ts
/** Serves the row's PDF through this app's `/api/binary` route. */
function withDocumentUrl(row: LabResultRow): LabResultView
```

Bad (rule 2 - explains why a check that used to be here is gone; the comment never mentions the removal, so it reads as rationale):
```ts
// Report only unexpected failures to Sentry, tagged with the resource. A missing session is
// routine, since cookies expire, so it stays out of Sentry. A not-provisioned patient is
// reported like any other unexpected error: login already rejects that state, so a signed-in
// patient who hits it had their membership revoked mid-session, which is worth seeing.
if (!isPatientSessionUnauthorizedError(error)) { ... }
```

Good (what the line does now; the deleted check is not a reader's problem):
```ts
// Report only unexpected failures to Sentry
if (!isPatientSessionUnauthorizedError(error)) { ... }
```

Bad (rule 9, restating a fallback chain that is on screen):
```ts
/**
 * The badge for a report: its interpretation when it carries one ("Abnormal", flagged), otherwise its
 * workflow status ("Preliminary"), otherwise a bare "Result". A workflow status never flags - only an
 * out-of-range interpretation does.
 */
function reportBadge(report: DiagnosticReport): LabBadge {
  return interpretation ?? (statusMeta ? { ...statusMeta, flagged: false } : UNKNOWN_RESULT_BADGE)
}
```

Good (the order is visible in the code; the flagging rule is not):
```ts
/** The badge for a report. Only an out-of-range interpretation sets `flagged`. */
```

## Examples: how a comment is written

Bad (dense, negative framing, buzzwords):
```
// Server-to-server auth gate. Fail closed if the token is unconfigured.
try {
   if (!verifyServiceAuth(request)) { ... }
}
```

Good (Simple English, positive framing, no AI-lingo structure):
```
// Server-to-server authentication check. Deny the request if the token is unconfigured.
try {
   if (!verifyServiceAuth(request)) { ... }
}
```

Bad:
```
// NOTE: this forward-block is a UI courtesy only, not a per-step gate.
// `currentStepIndex` derives from the current URL path — not from saved
// progress — so navigating to a later step's URL directly bypasses it
// entirely. The template deliberately ships no per-step route guards
// (forks may want different ordering/skipping rules); the integrity
// backstop is the server-side readiness check at intake completion,
// which refuses to finalize while any step is missing.
const canNavigateToStep = useCallback(...)
```

Good:
```
// This limits forward navigation in the UI only. `currentStepIndex` comes from
// the current URL path, not from saved progress, so visiting a later step's URL
// directly still works. The template intentionally ships no per-step route
// checks, since forks may want different ordering or skipping rules. The real
// safeguard is the server-side check at intake completion, which refuses to
// finalize while any step is missing.
const canNavigateToStep = useCallback(...)
```

Bad:
```
// Throttle first — cheapest gate. Bounds Argon2 CPU amplification and
// request flooding on this public endpoint (best-effort, per-instance).
const rate = await checkRateLimit(getClientKey(request))
```

Good:
```
// Check the rate limit first, since it's the cheapest check to run. Bounds
// Argon2 CPU amplification and request flooding on this public endpoint.
const rate = await checkRateLimit(getClientKey(request))
```

Bad:
```
/**
 * Whether the patient may finalize their intake: every required step must be
 * validly filled and one of the payment steps must have a saved response.
 * Server-authoritative — `completeIntake` enforces the same rule, so a client
 * skipping this check cannot complete a partial intake.
 *
 * Required steps are validated (not presence-checked) so a Save-for-later draft
 * counts as still-missing: the patient is sent back to the earliest unfinished
 * step (e.g. Demographics) rather than skipped past it to a later one.
 */
export async function getIntakeReadiness(headers: Headers): Promise<IntakeReadiness> { ... }
```

Good:
```
/**
 * Returns whether the patient can finalize their intake: every required step must pass its schema,
 * and one of the payment steps must have a saved response.
 *
 * A Save-for-later draft counts as missing, so the patient goes back to the earliest unfinished step
 * instead of past it. `completeIntake` applies the same rule on the server.
 */
export async function getIntakeReadiness(headers: Headers): Promise<IntakeReadiness> { ... }
```

`ready` and `missingSteps` are not explained, because their names already say it - see rule 5.