# TypeScript package (library) stack pack

Testing a pure TypeScript library/package — no framework, no app DB, shipped to consumers (npm package, workspace lib). Loaded **only when the project is a standalone package**, alongside the runner pack (Vitest / Jest). Read with the skill's universal rules.

## Test the public API

- Import from the package **entry point** (`exports` / `main` / the package name in a monorepo), the way a consumer does — not deep relative paths into `src/internal`. That's what pins the published contract; a green suite that imports internals can still ship a broken public API.
- If a private helper needs its own test, consider whether it should be exported, or cover it through the public path.

## Types are part of the contract

- Type-level behavior (generics, inference, conditional types) won't be caught by value assertions. When it matters, add compile-time type tests with **`tsd`** / `expectTypeOf` (Vitest) / `vitest`'s type-testing — assert that a call *doesn't* compile when it shouldn't and infers the right type when it should.

## Keep it dependency-light & deterministic

- A library test needs only the package + the runner. Don't pull a DB/network in; test integration seams with an in-memory fake the consumer could also use.
- Reset any module-level singleton/cache the package exposes between tests; don't rely on import order.

## Build outputs (when relevant)

- If the package ships both ESM and CJS, a small smoke test that imports the built entry in each format catches packaging/`exports`-map breakage that source-only tests miss.

## Data & purity

- Most of a library is pure — literal inputs, assert literal outputs with `toEqual` / `toStrictEqual` (use `toStrictEqual` when `undefined` fields / class identity are part of the contract). Table-drive edge cases (empty, boundary, unicode).
- Inject clock/rng/env for anything ambient so tests pass a fake.

## Pitfalls

- Testing via deep `src/...` imports — green tests, broken published `exports`.
- Only value tests on a type-heavy API — the type regressions ship silently. Add type tests.
- `toEqual` when `undefined`-property presence matters — use `toStrictEqual`.
