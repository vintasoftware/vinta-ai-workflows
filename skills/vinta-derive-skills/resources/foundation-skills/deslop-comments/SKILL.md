---
name: deslop-comments
description: Rewrite code comments and docs touched during the current conversation into Simple English, stripping AI-slop / AI-lingo vocabulary and negative framing. Use when the user says "deslop these comments", "clean up the comments we just wrote", "rewrite this in plain English", or after a review flags comments as convoluted/AI-sounding. Comment-only - never changes function names, APIs, or behavior.
---

# Deslop comments

Rewrites comments and doc blocks into short, direct Simple English. This is a comment-only pass: no renames, no logic changes, no behavior changes.

## Scope

Default scope is **files the current task actually created or edited** - find the candidate set with `git diff --name-only` / `git status --short` against the base the conversation started from. If the user names specific files, a directory, or a Pull Request instead, use that scope.

Do not expand scope to a file just because the agent `Read` it or reviewed it in passing - a debugging or review session routinely reads many unrelated files, and reading one is not authorization to rewrite its comments. If there is no edited-file set and no explicit scope from the user, ask which files to cover.

## What counts as slop

Rewrite a comment if it has any of:

1. **Dense, multi-clause sentences** that try to explain everything at once instead of one idea per sentence.
2. **Negative / before-state framing** - describing removed code, or leading with "not X" when X was never the point. Keep "not X, it's Y" only for a genuine edge case, a non-obvious gotcha, or bug-fix rationale worth flagging; otherwise state the current behavior directly.
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

     Do not apply this as a blind blacklist. Keep the original word when it is the precise domain term, especially for security, type-system, React, database, FHIR, or JavaScript runtime concepts. For example, `opaque` is a precise security/API term for an id, token, or string whose structure and meaning a caller must not depend on ("recipient is an opaque viewer-supplied string; never log it"); it is not on the replacement list above, so leave it — "generic" would drop that contract.
4. **Undocumented return shapes.** A function returning an object or union should say what each field/variant means, not just that it "returns a result."
5. **Any other AI-slop or AI-lingo words, framing, structure.**

## What to leave alone

- Function, type, and API names - this is a comment-only pass.
- Log strings and error messages shown to users.
- Generated files (e.g. `*.gen.ts`, Prisma client output).
- Genuine security markers or contracts written as caps-negatives (`NEVER log PHI`, `Does NOT upsert`) - these are useful warnings, not slop.
- User-facing UI copy (JSX text nodes rendered to the browser) - that's product copy, not a code comment.
- Already-clear one-liners that don't exhibit any of the problems above. Don't rewrite for the sake of rewriting.

## Process

1. Build the file list per Scope above.
2. For each file, read every comment/doc block (`//`, `/* */`, `/** */`, `#`, `%`, depending on the language) and check it against "What counts as slop." Skip anything covered by "What to leave alone."
3. Rewrite in place with `Edit`. Prefer one idea per sentence. When a function's return type is a union or object with meaningful fields, spell out what each branch/field means using the comment body or JSDoc (or similar) if it's a project pattern.
4. After editing, confirm the diff is comment-only: `git diff -- <files>` should show no code-line changes, only comment text.
5. Run the project's lint/typecheck on touched files (e.g. `pnpm biome check <files>`, `pnpm --filter <pkg> typecheck`) to confirm nothing broke.
6. Summarize what changed in 1-2 sentences - don't restate every line edited.

## Example

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
 * Returns whether the patient can finalize their intake: every required step
 * must pass its schema, and one of the payment steps must have a saved
 * response. `completeIntake` enforces the same rule on the server, so a
 * client cannot complete a partial intake by skipping this check. A
 * Save-for-later draft counts as missing, which sends the patient back to
 * the earliest unfinished step (e.g. Demographics) instead of skipping past
 * it. In the returned object, `ready` tells whether the intake can be
 * completed, and `missingSteps` lists the keys of the steps still missing.
 */
export async function getIntakeReadiness(headers: Headers): Promise<IntakeReadiness> { ... }
```
