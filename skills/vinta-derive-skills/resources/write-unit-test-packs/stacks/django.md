# Django stack pack

Django-specific testing — DB isolation, ORM data, settings, the test client, external boundaries. Loaded **only when the project is Django**, alongside the runner pack (pytest or unittest). Read with the skill's universal rules.

## DB isolation & base class

- **`TestCase` (or pytest-django's `db` fixture) wraps each test in a transaction rolled back at teardown** — the default, fast path, zero manual cleanup.
- **`TransactionTestCase` / `@pytest.mark.django_db(transaction=True)`** truncates instead of rolling back — use **only** when the code commits its own transactions, tests `on_commit` hooks, or uses `select_for_update`. Markedly slower; not the default.
- **`SimpleTestCase`** forbids DB access — use it to prove a unit is DB-free.
- Never `Model.objects.all().delete()` in setup as a cleanup crutch; rely on rollback.

## Test data

- **Prefer `factory_boy` or `model_bakery` recipes over fixture files or inline `Model.objects.create(...)` walls** — `UserFactory(is_staff=True)` builds a valid instance spelling out only the relevant field. Fixture files drift from the schema silently.
- With `TestCase`, put shared read-only data in **`setUpTestData(cls)`** (runs once per class inside the outer transaction), not `setUp` (per test). Only the fields the assertion needs.

## Assertions

- `self.assertEqual(response.json(), {...})` / `assertEqual(obj.status, "paid")` — full value, not `assertTrue(obj)` or a lone `Model.objects.count()`.
- Use the specific ones for signal: `assertQuerySetEqual`, `assertContains`/`assertNotContains` (body + status), `assertRaisesMessage`, `assertNumQueries` (guard a hot path).
- **`obj.refresh_from_db()` before asserting persisted state** — the in-memory instance hides DB defaults, signals, `auto_now`.

## Externals

- **`unittest.mock.patch`** where the name is *used* (`patch("myapp.services.stripe_client")`), not where defined.
- **Email:** assert on `django.core.mail.outbox` (the test runner's `locmem` backend), don't mock `send`.
- **HTTP:** `responses` / `respx` — never a real outbound call.
- **Settings/time:** `@override_settings(...)` / `self.settings(...)`; `freezegun` or an injected clock.
- **Test client:** `self.client` exercises the real URL/middleware/view stack — good. Mock only the external service the view calls, not the view.

## Pitfalls

- `TransactionTestCase` "to be safe" — slower for no reason. Default to `TestCase`.
- `on_commit` hooks never fire under `TestCase` (the transaction rolls back) — use `TestCase.captureOnCommitCallbacks(execute=True)` or `TransactionTestCase`.
- A lone `assertEqual(Model.objects.count(), 1)` — asserts a count, not that the right object with the right fields exists.
- Asserting on `obj` after `save()` without `refresh_from_db()`.
