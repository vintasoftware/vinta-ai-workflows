# Next.js stack pack

Next.js (App Router) testing — what to unit-test vs leave to e2e, route handlers, server code. Loaded **only when the project uses Next.js**, alongside the runner pack (Vitest / Jest) and, for UI, the React stack pack. Read with the skill's universal rules.

## Test the logic, not the framework

- **Unit-test the units the framework calls**, not the framework's rendering: route-handler functions, server actions, data-loading helpers, and pure client components. Full-page rendering, navigation, streaming, and middleware are e2e territory (Playwright) — don't fake the Next runtime to force them into a unit test.

## Route handlers & server actions

- A **Route Handler** (`GET`/`POST` in `route.ts`) is a plain async function taking a `Request` — call it directly with a constructed `new Request(url, { method, body })` and assert the returned `Response` (`await res.json()` + `res.status`) by full value. No server boot needed.
- A **Server Action** is a plain async function — call it with its args and assert what it returned / wrote (mock the DB/service boundary, not the action). Don't assert on `revalidatePath`/`redirect` internals; assert the effect.
- Inject or mock external services (DB, upstream APIs) at the boundary with MSW / a fake client, not by faking `next/*` internals.

## Client components & hooks

- Test client components with the React stack pack (Testing Library). Mock `next/navigation` (`useRouter`, `useSearchParams`, `usePathname`) with light fakes when a component reads them — assert the visible result, not that `router.push` was called, unless navigation *is* the contract.

## Server components

- Async Server Components that just fetch + compose are thin — extract the data logic into a plain function and unit-test that. Rendering the RSC tree itself is not well-served by unit tests today; cover it with e2e.

## Pitfalls

- Trying to render a whole App-Router page in a unit test and mocking half of Next to do it — brittle; use e2e.
- Asserting `redirect()` / `revalidatePath()` were called instead of the observable outcome.
- Leaving real `fetch` calls in a Server Component test — stub at the network layer (MSW) or test the extracted function.
