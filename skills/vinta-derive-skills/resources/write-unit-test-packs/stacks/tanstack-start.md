# TanStack Start stack pack

TanStack Start testing — server functions, route loaders, and isomorphic logic. Loaded **only when the project uses TanStack Start** (`@tanstack/react-start`), alongside the runner pack (Vitest) and, for UI, the React stack pack. Read with the skill's universal rules.

## Test the logic, not the framework

- **Unit-test the units the framework calls**, not the full route/SSR render: server functions, route `loader` / `beforeLoad` functions, and pure components. Full-page rendering, streaming, hydration, and navigation are e2e territory (Playwright) — don't fake the Start runtime to force them into a unit test.

## Server functions (`createServerFn`)

- A server function's **handler is a plain async function** — export it (or the plain function it wraps) and call it directly with constructed input; assert the returned value by full shape. Don't spin up the server to test it.
- Mock what the handler calls at the boundary (DB, upstream APIs) with a fake client / MSW, not the `createServerFn` machinery.
- Validate the input-validator (`.validator(...)`) separately with valid + invalid inputs — it's a pure function.

## Route loaders & context

- A route's `loader` / `beforeLoad` is a plain async function receiving `{ context, params, ... }` — call it with a constructed argument and assert what it returns / throws (e.g. a `redirect()`), passing a fake `context` (auth principal, injected client). Don't assert on router internals; assert the returned data or the thrown redirect's target.

## Client components & router hooks

- Test client components with the React stack pack (Testing Library). For components using router hooks (`useLoaderData`, `useNavigate`, `useParams`), render them under a **test router** built with `createRouter` + a `createMemoryHistory({ initialEntries: [...] })` and `RouterProvider`, seeding the route with the data the component reads. Assert the visible result, not that `navigate` was called (unless navigation *is* the contract).

## Externals & isolation

- Stub HTTP at the network layer with MSW; never a real outbound call in a unit test.
- Fresh router/history per test — don't share navigation state between tests.

## Pitfalls

- Booting the Start server or rendering a whole route in a unit test and mocking half the framework — brittle; use e2e.
- Asserting a `redirect()` / `navigate()` happened instead of the observable outcome (the data, the rendered target).
- Leaving a real `fetch` in a server-function or loader test — stub at the boundary or test the extracted function.
