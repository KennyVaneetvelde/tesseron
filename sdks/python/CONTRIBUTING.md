# Contributing

Run the gate from the repository root:

```bash
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked mypy --strict src tests
uv run --locked pytest
uv build
```

Keep `uv.lock` committed. Public symbols need docstrings.

Do not use `Any`, `cast()`, bare `# type: ignore`, or abbreviated names. Keep `conformance_host/` outside `src/tesseron/` so it stays out of the wheel.

Sign every commit with DCO:

```bash
git commit -s
```

An SDK release PR is complete only after its required hub docs PR has merged.

The docs live in the [Tesseron hub](https://github.com/Eigenwise/tesseron) under `docs/src/content/docs/sdk/python`.
