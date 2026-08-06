# React stack pack

Component-testing idioms with React Testing Library. Loaded **only when the project renders React UI**, alongside the runner pack (Vitest / Jest). Read with the skill's universal rules.

## Query & interact like a user

- **Query by role/label/text**, not test-ids or class names: `getByRole("button", { name: /save/i })`. Test-ids couple the test to markup. Reserve `data-testid` for the rare element with no accessible handle.
- **`getBy`** (must exist) vs **`queryBy`** (assert absence) vs **`findBy`** (async, awaited). Use the right one — `getBy` throwing is a clearer failure than a null deref.
- Drive interactions with **`user-event`** (`await userEvent.click(...)`), not raw `fireEvent` — it models real focus/typing.

## Assert output, not internals

- Assert what the user sees (rendered text, presence/absence, disabled state), not component state, not that a hook or handler ran, not render counts. The test should survive a refactor that preserves behavior.
- Don't reach into instance internals or snapshot the whole tree as the only assertion — assert the elements that matter.

## Data & async

- Mock HTTP at the network layer with **MSW** (see the runner pack), so components run their real fetch path. For a component that loads data, `await screen.findBy...` the settled UI rather than mocking the fetching hook.
- Pure logic (reducers, formatters, custom hooks without UI) — test directly, no render. Hooks: `renderHook` + `act`.

## Regression tests on state that settles

- When the bug is a wrong intermediate state that ends up correct, asserting the final UI passes even with the bug present. Record the value on every render instead: push it to an array inside the `renderHook` callback, or from a test-only child in a rendered tree. Then assert the whole sequence — `expect(states).toEqual(["loading", "ready"])` catches the extra skeleton that `findByText` never sees.
- `await waitFor` hides the same bug. It retries until the assertion passes, so it cannot see a state that was wrong and then corrected.

## Isolation

- Clean up is automatic per test with the Testing Library auto-cleanup; don't share rendered state between tests. Reset mocks in `afterEach` (see runner pack).

## Pitfalls

- `getByTestId` everywhere — brittle, and hides accessibility gaps. Prefer role/label.
- Asserting a handler prop was called instead of the visible result of calling it.
- Missing `await` on `findBy` / `userEvent` — the assertion runs before the UI settles and passes hollow.
