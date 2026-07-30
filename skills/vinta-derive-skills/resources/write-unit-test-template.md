---
name: write-unit-test
description: Write a unit test for a function, method, class, or module in {{PROJECT_NAME}} ({{STACK_SUMMARY}}) — mock only genuine externals, assert the full output (not counts/truthiness), clean up created data or roll back the transaction, never hit a service unavailable in dev/test, keep test logic literal, stay decoupled from internals. Applies this project's test preferences and the runner + stack packs for {{FRAMEWORK_PACKS_LIST}}. Use on "add a test", "write a unit test", "cover this with tests", or when new behavior lands uncovered.
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
2. **Assert the full value**, not counts or truthiness. `assert result`, `toBeTruthy()`, `len(x) == 3` are too weak. Assert contents and order for collections.
3. **Leave no trace** — transaction-rollback harness where available; else clean up in teardown, and make teardown run on failure. Never depend on another test's data.
4. **No external service** that can't run in dev/test. Stub at the boundary.
5. **Test logic stays literal** — no loops/conditionals computing the expected value. Parametrize to cover cases; keep each expectation a literal.
6. **Decouple from internals** — assert observable state/output, not private methods or call counts. The test survives a behavior-preserving rewrite.
7. **One behavior per test**, named for what it pins (`returns_zero_for_empty_cart`).

## Project preferences

Apply these; `framework-default` defers to the pack. If the existing suite contradicts a preference, follow the preference for new tests and flag it — don't rewrite old tests.

{{PROJECT_TEST_PREFERENCES_BLOCK}}
{{ADDITIONAL_CONVENTIONS_BLOCK}}

## Pitfalls

- Asserting on a mock you set up — tests the mock, not the code.
- Giant snapshots as a substitute for asserting the fields that matter.
- `delete all rows` in setup instead of rollback — masks leaked state, races other tests.
- Testing the framework/ORM/language instead of your behavior on top of it.
