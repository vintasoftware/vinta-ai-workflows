# Python package stack

## Detection signals

- `pyproject.toml` at root with `[project]` or `[tool.poetry]` (or `[tool.hatch]`, `[tool.uv]`, etc).
- `src/<pkg>/` or `<pkg>/` layout (no Django).
- `manage.py` absent (rules out Django — that's a separate stack).

## Skill categories typically needed

- **Add-module** (sometimes) — when the team has conventions for new modules: file layout, `__all__` exports, entry-point registration in `pyproject.toml`, test file pairing.
- **Add-cli-command** (if the package ships a CLI via `[project.scripts]` or click/typer) — register entry point, argument schema, test pattern.
- **Release-package** (if PyPI publishing is part of the flow) — versioning, changelog, `python -m build`, `twine upload` (or trusted publisher), tag conventions.

## Agent categories typically needed

None specific — foundation trio is enough for most Python packages.

## Placeholders the orchestrator should ask about

- Package manager (`poetry`, `uv`, `pip + pip-tools`, `hatch`, plain `pip`)
- Source layout (`src/<pkg>/` vs flat `<pkg>/`)
- Test runner (`pytest`, `unittest`)
- Lint+format (`ruff`, `black`, `pylint`, `flake8`)
- Type check (`mypy`, `pyright`, none)
- Distribution target (PyPI, internal index, GitHub Releases, none)

## When this stack doesn't apply

- Library + Django co-exist → use `django/` stack (which handles the migration + multi-tenant pieces).
- Pure scripting collection without packaging → foundation is sufficient.
