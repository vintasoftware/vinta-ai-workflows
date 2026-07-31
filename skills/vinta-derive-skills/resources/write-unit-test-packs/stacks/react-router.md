# React Router stack pack

React Router testing — data-router loaders/actions and routing-aware components. Loaded **only when the project uses React Router** (`react-router` / `react-router-dom` / `@react-router/*`), alongside the runner pack and, for UI, the React stack pack. Read with the skill's universal rules.

## Loaders & actions are plain functions

- In data-router / framework mode, a route's **`loader` and `action` are plain async functions** receiving `{ request, params, context }`. Export and call them directly; assert what they return / throw. A thrown `redirect(...)` is part of the contract — assert its `Location`, don't assert on router internals.
- Mock the boundary the loader/action hits (DB, upstream API) with a fake client / MSW. Build the `request` with `new Request(url, { method, body })` for actions.

## Routing-aware components

- Components that call routing hooks (`useNavigate`, `useParams`, `useLoaderData`, `<Link>`) need a router in the test. Use **`createMemoryRouter([...routes], { initialEntries: [...] })` + `<RouterProvider>`** (data router), seeding the route with `loader: () => data` so `useLoaderData` returns what the component reads. For simple hook-only components, wrapping in **`<MemoryRouter initialEntries={[...]}>`** is enough.
- Assert the **visible result** of navigation (the destination content rendered, the URL via the test router), not that `navigate` was called — unless firing navigation *is* the unit's whole job.

## Externals & isolation

- Stub HTTP at the network layer with MSW; never a real outbound call.
- Build a **fresh memory router/history per test** — a shared router leaks navigation/loader state and causes order-dependence.

## Pitfalls

- Rendering a component that uses `useNavigate` / `<Link>` without a router wrapper → it throws; wrap it in a memory router.
- Asserting `navigate("/x")` was called instead of asserting the `/x` content rendered.
- Testing loaders by rendering the whole route tree instead of calling the loader function directly.
- Reusing one router across tests — stale location/loader data flips results by order.
