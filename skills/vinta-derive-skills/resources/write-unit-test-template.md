---
name: write-unit-test
description: Write a unit test for a function, method, class, or module in {{PROJECT_NAME}} ({{STACK_SUMMARY}}) — mock only genuine externals, assert the full output (not counts/truthiness), clean up created data or roll back the transaction, never hit a service unavailable in dev/test, keep test logic literal, stay decoupled from internals. Applies this project's test preferences and the runner + stack packs for {{FRAMEWORK_PACKS_LIST}}. A bug fix gets a regression test that fails without the fix. Use on "add a test", "write a unit test", "cover this with tests", "add a regression test", or when new behavior lands uncovered.
---

# Write a unit test

A test should fail when the behavior breaks and pass when it's correct — nothing more.

## Steps

1. **Read the unit's contract** — inputs, outputs, side effects, error paths. Test the contract, not the implementation.
2. **Match the nearest existing tests** — location, naming, helpers — unless they break a rule below.
3. **Load the packs** that shipped for this project — the test-**runner** pack (how to structure/assert/mock) plus the **stack** pack(s) matching what you're testing (DB isolation, framework client, domain mocks). Follow them alongside the rules:

{{FRAMEWORK_PACK_LOADER_BLOCK}}

4. **Write it, then prove it.** Run in isolation (`{{NEW_TEST_CMD_PATTERN}}`) — green. Break the code (or invert an assertion), re-run — red for the right reason. Revert. Run the suite (`{{TEST_CMD}}`){{SCOPED_TEST_NOTE}} — still green.

## Rules

1. **Mock only genuine externals** (third-party HTTP, payment/email/SMS, clock, randomness). Never mock the unit under test, its local collaborators, the DB, or your own pure functions.
2. **Assert the full value**, not counts or truthiness. `assert result`, `toBeTruthy()`, `len(x) == 3` are too weak. Assert contents and order for collections. **But don't over-fit brittle text** — for human-facing strings (error messages, UI copy, i18n) assert a stable anchor (an error code/type, a role, an i18n key, a substring), not the exact prose that churns.
3. **Leave no trace** — transaction-rollback harness where available; else clean up in teardown, and make teardown run on failure. Never depend on another test's data.
4. **No external service** that can't run in dev/test. Stub at the boundary.
5. **Test logic stays literal** — no loops/conditionals computing the expected value. Parametrize to cover cases; keep each expectation a literal.
6. **Decouple from internals** — assert observable state/output, not private methods or call counts. The test survives a behavior-preserving rewrite.
7. **One behavior per test**, named for what it pins (`returns_zero_for_empty_cart`).
8. **Kill nondeterminism** — control every entropy source (clock, randomness, timezone/locale, iteration/DB order, concurrency). Freeze/inject them; a test that passes only sometimes is worse than none.
9. **Cover the branches, not just the happy path** — aim high (95%+ branch coverage): each error path, guard, and edge (empty, boundary, null) gets a case. Coverage is the floor, correct assertions are the point.

## Regression tests

A test that exists because of a bug has a second job: fail again if the bug comes back. A comment does not fail when the code changes; a test does.

- **Check that it fails without the fix.** Write the test first and watch it fail. If the fix came first, revert the fix, run the test, confirm it fails, then restore the fix. A test that passes with and without the fix protects nothing. This goes wrong most often with timing and cache-key bugs, where the assertion can run too early to see the broken state.
- **Name it for what must not happen**, in behavior terms, so the failure line reads as a description of the bug: `keeps the rows on screen across a sort flip instead of falling back to the skeleton`, not `sorts the ids`.
- **Assert the cause too, when the visible symptom can look right while the bug is still there.** For a cache-key bug, assert that the query ran once, not only that the screen showed the right rows. Keep the assertion on what the user sees and add the one about the cause next to it. This is the only exception to rule 6.
- **Watch states that settle.** When the bug is a wrong intermediate state that ends up correct, asserting the final state passes even with the bug present. Record the value on every update and assert the whole sequence instead. The stack pack shows how to do this for this project's framework.
- **When no test can cover the regression**, or the test would cost far more than it protects, say so in the PR and leave a comment with the reason. This is the only case where a comment stands in for a test.

## Project preferences

Apply these; `framework-default` defers to the pack. If the existing suite contradicts a preference, follow the preference for new tests and flag it — don't rewrite old tests.

{{PROJECT_TEST_PREFERENCES_BLOCK}}
{{ADDITIONAL_CONVENTIONS_BLOCK}}

## Pitfalls

- Asserting on a mock you set up — tests the mock, not the code.
- Giant snapshots as a substitute for asserting the fields that matter.
- `delete all rows` in setup instead of rollback — masks leaked state, races other tests.
- Testing the framework/ORM/language instead of your behavior on top of it.
