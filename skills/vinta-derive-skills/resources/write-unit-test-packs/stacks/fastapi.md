# FastAPI stack pack

FastAPI-specific testing — the test client, dependency overrides, async, DB isolation. Loaded **only when the project is FastAPI**, alongside the runner pack (usually pytest). Read with the skill's universal rules.

## Test client & dependencies

- **`TestClient(app)`** (Starlette, sync) exercises the real routing/validation/response stack. For async-native tests use **`httpx.AsyncClient(transport=ASGITransport(app=app))`**.
- **Override dependencies with `app.dependency_overrides[dep] = fake`**, not by monkeypatching internals — inject a test DB session, a stubbed auth principal, a fake external client. Clear overrides in teardown (a fixture that yields then pops).
- Don't mock the endpoint function; drive it through the client and override only what crosses the boundary.

## Async

- Use `pytest-asyncio` (`@pytest.mark.asyncio`) or `anyio`. Await the real coroutine; don't wrap sync mocks around async code. Mock async collaborators with `AsyncMock`.

## DB isolation

- Inject the DB session via a dependency and override it with a **session bound to a transaction rolled back in teardown** (SQLAlchemy: connection → `begin()` → session → rollback). Each test starts clean; no manual delete.
- Prefer a real (SQLite/Postgres) test DB over mocking the ORM — mocking the session tests the mock.

## Externals

- **HTTP:** `respx` (httpx) / `responses` (requests) — never a real outbound call.
- **Settings:** override via a `Settings` dependency or env fixture, not by mutating a global.
- **Time/randomness:** `freezegun` or an injected clock; seed `random`.

## Assertions

- Assert `response.status_code` **and** `response.json()` by full value — not just the status. Validate against the response model's shape, not a lone key.

## Pitfalls

- Forgetting to clear `app.dependency_overrides` — leaks a fake into the next test.
- Mixing sync `TestClient` with async DB drivers — use `AsyncClient` + async session instead.
- Asserting only the status code while the body is wrong.
