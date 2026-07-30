# Python package (library) stack pack

Testing a pure Python library/package — no web framework, no app DB, shipped to consumers (e.g. an open-source package). Loaded **only when the project is a standalone package**, alongside the pytest runner pack. Read with the skill's universal rules.

## Test the public API

- Test the package's **public surface** — the names in `__init__.py` / documented exports — the way a consumer imports and calls them. Don't reach into private modules (`_internal`) to test them directly; if a private helper needs its own test, that's a hint it should be public or covered through the public path.
- Backward compatibility is the contract: a test pinning documented behavior is what stops a refactor from breaking downstream users.

## Keep it dependency-light & deterministic

- A library test should need only the package + `pytest` (+ its declared test extras). Don't pull a DB, a broker, or network into a unit test — if a feature integrates with those, test the seam with a fake/in-memory double the consumer could also use.
- No hidden global state between tests: reset module-level singletons/caches your code exposes; don't rely on import order.

## Data & purity

- Most of a library is pure functions — arrange literal inputs, assert literal outputs by full value. Parametrize to cover edge cases (empty, boundary, unicode, `None`).
- For anything time/random/env-dependent, inject the dependency (clock, rng, `os.environ` reader) so tests pass a fake — libraries especially should not read ambient globals.

## Version / matrix awareness

- If the package supports multiple Python versions or an optional-dependency matrix (`tox` / `nox`), write tests that don't assume the newest syntax/behavior, and guard optional-dependency paths with `pytest.importorskip` so the suite runs in every configured environment.

## Pitfalls

- Testing `_private` internals — couples the test to today's structure and breaks on refactor.
- A unit test that imports a heavy optional dependency unconditionally — fails in the minimal matrix env.
- Asserting truthiness of a returned object instead of its value/shape.
