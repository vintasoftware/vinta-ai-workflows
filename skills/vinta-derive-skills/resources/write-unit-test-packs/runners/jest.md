# Jest runner pack

Test-runner idioms for Jest. Stack-agnostic — framework-client and domain-mock specifics live in the **stack pack**, loaded alongside this one. The Testing Library / DOM notes apply only when the project renders UI. Read with the skill's universal rules. (Jest and Vitest share most idioms; the differences are noted.)

## Structure & style

- **`describe` / `it` (or `test`) with the behavior in the name.** `it("returns zero for an empty cart")`. The string is the spec.
- **Assert full values with the right matcher.** `expect(result).toEqual(expected)` for deep value equality, `toBe` for primitives/identity, `toStrictEqual` when `undefined` fields / class identity matter. Avoid `toBeTruthy()` / `toBeDefined()` as the *only* assertion. For arrays assert contents (and order when it matters), not just `.toHaveLength(n)`.
- Error paths: `expect(fn).toThrow(Message)` — assert the error, not just that it threw.

## Table-drive instead of looping

- Use `it.each([...])` / `describe.each` — each row is its own test with a literal expected value. Never loop inside one test recomputing the expectation.

## Test data

- **Prefer small factory/builder helpers over inline object literals** when the project has them — `makeUser({ email })` returns a valid object with only the relevant field overridden. Keep overrides minimal.
- No factory convention → a local `base` object with per-test spread beats copy-pasted full literals.

## Mocking & externals

- **Mock only genuine externals, at the boundary.** `jest.mock("./module")`, `jest.fn()` for callbacks, `jest.spyOn(obj, "method")` for one method. Don't mock the unit under test or pure helpers.
- **Reset between tests.** Set `clearMocks: true` (and consider `restoreMocks: true`) in the Jest config, or `afterEach(() => jest.restoreAllMocks())`. Stale mock state between tests is a top flake source.
- **HTTP:** use **MSW** (`setupServer`) to intercept at the network layer and return canned responses — the real client path runs. Never let a real request out. Prefer MSW over hand-mocking `fetch`/`axios`.
- **Complex APIs (e.g. LLM endpoints):** when hand-writing responses is impractical, record real traffic once and replay it from a committed cassette — [PollyJS](https://github.com/Netflix/pollyjs) or `nock`'s `nock.back`. Scrub secrets/PII from the recording, commit it, and never re-hit the live API in CI. Re-record deliberately when the contract changes.
- **Time:** `jest.useFakeTimers()` + `jest.setSystemTime(...)`, `jest.useRealTimers()` in teardown. Don't assert on `Date.now()` live.
- Prefer dependency injection over `jest.mock` when practical — fewer module-graph surprises.

## UI / component tests

- When the project renders UI, the component-testing idioms (Testing Library queries, `user-event`, asserting output not internals) live in the **React stack pack** — follow it there. Pure-logic units don't need it.

## Isolation

- Keep test files independent; don't share mutable module-level state. Clean up any DOM/global you touched in `afterEach`.
- DB-backed tests: wrap each in a transaction rolled back in `afterEach`, or reset to a known seed. Never leave rows behind.

## Jest-specific notes

- `jest.mock(...)` is **hoisted** above imports; a mock factory can't reference outer variables unless they're prefixed `mock`. Return values from inside the factory.
- Automock is off by default — keep it off; explicit mocks are clearer.
- `jest.mock("module")` replaces the whole module for the file; use `jest.requireActual` to keep the real parts you don't mean to stub.

## Pitfalls

- Asserting on a mock's return you just configured — tests the mock, not the code.
- Forgetting `await` on async expectations (`await expect(p).resolves...`) — the assertion never runs; the test passes hollow.
- Snapshot sprawl: giant `toMatchSnapshot()` blobs get blindly re-recorded. Assert the fields that matter by value.
- `toEqual` ignores `undefined` properties — use `toStrictEqual` when their presence/absence is part of the contract.
