# pytest runner pack

Test-runner idioms for pytest. Stack-agnostic — DB isolation and framework-client/mock specifics live in the **stack pack** (Django / FastAPI / Flask / …), loaded alongside this one. Read with the skill's universal rules.

## Structure & style

- **Plain functions + fixtures, not `unittest.TestCase`.** `def test_x():` with fixtures is the idiomatic form. Use a plain `class TestThing:` only when it genuinely groups (shared parametrization, a natural noun) — never subclass `TestCase` in new pytest code.
- **Fixtures over `setUp`/`tearDown`.** Fixtures compose, scope (`function`/`module`/`session`), and `yield` for teardown. Put shared ones in `conftest.py`.
- **Plain `assert`, not `self.assertEqual`.** pytest rewrites `assert` to show both sides. `assert result == expected`. Unordered collections: compare `sorted(...)` or sets. Approximate floats: `pytest.approx`.

## Parametrize instead of looping

- `@pytest.mark.parametrize("input,expected", [...])` — each row is its own test with a **literal** expected value. Add `ids=` when the repr is opaque. Never loop inside one test recomputing the expectation.

## Test data

- **Prefer `factory_boy` factories over inline dicts** when the project has them — `UserFactory(email="x@y.z")` spells out only the relevant field and stays correct as the model grows. `Factory.build()` (no persistence) vs `Factory.create()` (persisted). Override only the fields the assertion depends on.
- No factories → a small local constructor/helper beats hand-assembled deep dicts repeated across tests.

## Mocking & externals

- **`mocker` (`pytest-mock`)** — `mocker.patch("module.where_its_used.thing")`, patching where the name is *looked up*, not where it's defined. Auto-undone at teardown.
- **HTTP:** `responses` (requests) / `respx` (httpx) — assert the outbound request, return a canned response. `pytest-socket` (`--disable-socket`) is a good CI guard against stray real calls.
- **Time/randomness:** `freezegun` (`@freeze_time`) or inject a clock; seed or patch `random`.
- Don't patch your own pure functions or the unit under test — that tests the mock.

## DB isolation

- Wrap each DB-touching test in a transaction rolled back at teardown, via a fixture — the exact mechanism is stack-specific (see the stack pack). Never `DELETE FROM` in setup as a cleanup crutch, and never depend on test ordering.

## Pitfalls

- Patching the definition site instead of the SUT's namespace (`from lib import thing` → patch `sut.thing`) — the patch silently does nothing.
- `assert mock.called` as the only assertion — asserts an interaction, not a result.
- Comparing objects without value equality — give them a dataclass `__eq__` or assert the fields you mean.
