# Flask stack pack

Flask-specific testing — the test client, app/request context, DB isolation. Loaded **only when the project is Flask**, alongside the runner pack (usually pytest). Read with the skill's universal rules.

## App, client & context

- Build the app from an **app factory** with a test config (`create_app({"TESTING": True, ...})`) so each test gets a clean instance; expose it as a fixture.
- **`app.test_client()`** exercises the real routing/blueprint/error-handler stack — drive endpoints through it, don't call view functions directly.
- Code that touches `current_app` / `g` / `session` needs an active context — use `with app.app_context():` / `with app.test_request_context():` in the fixture. Don't fake the context.

## DB isolation

- **SQLAlchemy:** bind the session to a connection-level transaction rolled back in teardown (connection → `begin()` → scoped session → `rollback` + `close`). Each test starts clean; no manual delete.
- Prefer a real test DB over mocking the ORM.

## Externals

- **Auth:** log in through the client (post to the login route or set the session via `client.session_transaction()`), not by patching the auth check.
- **HTTP:** `responses` / `respx` — never a real outbound call.
- **Extensions (mail, tasks):** use the extension's test/suppress mode (`mail.record_messages()`, eager Celery) and assert on what it captured, rather than mocking send.
- **Time/randomness:** `freezegun` or an injected clock; seed `random`.

## Assertions

- Assert `response.status_code` **and** the body (`response.get_json()` / rendered content) by full value. For JSON APIs assert the whole payload, not one key.

## Pitfalls

- Working outside an app/request context and getting `RuntimeError: working outside of ...` — push the right context in the fixture.
- Reusing one app instance with mutable global state across tests — the factory per test avoids it.
- Asserting only the status code while the body is wrong.
