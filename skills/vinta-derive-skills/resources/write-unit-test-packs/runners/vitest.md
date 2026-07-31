# Vitest runner pack

Test-runner idioms for Vitest. Stack-agnostic — framework-client and domain-mock specifics (e.g. Medplum's `MockClient`) live in the **stack pack**, loaded alongside this one. The Testing Library / DOM notes apply only when the project renders UI. Read with the skill's universal rules.

## Structure & style

- **`describe` / `it` (or `test`) with the behavior in the name.** `it("returns zero for an empty cart")`. The string is the spec; the failure line should read as a sentence.
- **Assert full values with the right matcher.** `expect(result).toEqual(expected)` for deep value equality (objects/arrays), `toBe` for primitives/identity, `toStrictEqual` when `undefined` fields and class identity matter. Avoid `toBeTruthy()` / `toBeDefined()` as the *only* assertion — a wrong-but-truthy value passes. For arrays assert contents (and order when it matters), not just `.toHaveLength(n)`.
- Use `expect(fn).toThrow(Message)` for error paths; assert the error, not just that it threw.

## Table-drive instead of looping

- Use `it.each([...])` / `describe.each` to cover many cases — each row is its own test with a literal expected value. Never `for`-loop inside one test recomputing the expectation.

## Test data

- **Prefer small factory/builder helpers over inline object literals** when the project has them — `makeUser({ email })` returns a valid object with only the relevant field overridden, and survives new required fields on the type. Keep overrides minimal: set only what the assertion depends on.
- When there's no factory convention, a local `const base = {...}` with per-test spread (`{ ...base, qty: 2 }`) beats copy-pasting full literals across tests.

## Mocking & externals

- **Mock only genuine externals, at the boundary.** `vi.mock("./module")` for a whole module, `vi.fn()` for a passed-in callback, `vi.spyOn(obj, "method")` for one method. Don't mock the unit under test or pure helpers that run fine.
- **Reset between tests.** Set `test: { clearMocks: true }` (or `restoreMocks: true`) in the Vitest config, or `afterEach(() => vi.restoreAllMocks())` — stale mock state leaking between tests is a top flake source.
- **HTTP:** use **MSW** (`setupServer`) to intercept at the network layer and return canned responses — the code under test runs its real fetch/axios path. Never let a real request out. Prefer MSW over mocking `fetch` directly (which couples to the client).
- **Complex APIs (e.g. LLM endpoints):** when hand-writing responses is impractical, record real traffic once and replay it from a committed cassette — [PollyJS](https://github.com/Netflix/pollyjs) or `nock`'s `nock.back`. Scrub secrets/PII from the recording, commit it, and never re-hit the live API in CI. Re-record deliberately when the contract changes.
- **Time:** `vi.useFakeTimers()` + `vi.setSystemTime(...)`, and `vi.useRealTimers()` in teardown. Don't assert on `Date.now()` live.
- **Modules with side effects on import:** prefer dependency injection over `vi.mock` when you can — fewer module-graph surprises.

## UI / component tests

- When the project renders UI, the component-testing idioms (Testing Library queries, `user-event`, asserting output not internals) live in the **React stack pack** — follow it there. Pure-logic units don't need it.

## Isolation

- Vitest isolates test files by default; keep it. Don't share mutable module-level state between tests. Clean up any DOM/global you touched in `afterEach`.
- For DB-backed integration tests, wrap each test in a transaction rolled back in `afterEach`, or reset to a known seed — never leave rows behind.

## Pitfalls

- Asserting on a mock's return you just configured — tests the mock, not the code.
- `vi.mock` factory hoisting surprises: `vi.mock` is hoisted above imports; reference values via the factory, not outer closures, or use `vi.hoisted`.
- Forgetting `await` on async expectations (`expect(promise).resolves...`) — the assertion never runs and the test passes hollow.
- Snapshot sprawl: giant `toMatchSnapshot()` blobs get blindly re-recorded. Assert the fields that matter by value.
