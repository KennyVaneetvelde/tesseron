# tesseron (Python)

The Python implementation of the [Tesseron](https://eigenwise.github.io/tesseron/) host
protocol. Your application listens on loopback, the MCP gateway dials in, and the agent
gets typed actions and readable resources instead of a scraper.

Speaks protocol **1.2.0**. Compatibility is decided by protocol version, never by matching
package numbers: see the
[compatibility contract](https://eigenwise.github.io/tesseron/protocol/compatibility/).

Not on PyPI yet.

## Install

```bash
uv add tesseron
```

Python 3.11 or newer. The only runtime dependencies are Pydantic v2 and `websockets`.

## A first action

```python
import asyncio

from pydantic import BaseModel, Field
from tesseron import ActionContext, TesseronApp

app = TesseronApp(id="todo", name="Todo", origin="http://127.0.0.1")


class AddTodo(BaseModel):
    text: str = Field(min_length=1)
    tag: str | None = None


@app.action("addTodo", description="Add one todo")
async def add_todo(input: AddTodo, context: ActionContext) -> dict[str, object]:
    await context.progress(percent=100, message="saved")
    return {"id": "1", "text": input.text, "done": False, "tag": input.tag}


async def main() -> None:
    host = await app.listen()
    print(host.url)
    await asyncio.Event().wait()


asyncio.run(main())
```

The input type comes from the handler annotation. Its validation-mode JSON Schema is what
the manifest publishes, and `model_validate` is what rejects bad input with `-32004` before
the handler body runs.

## What it covers

Handshake and claiming, session resume with in-memory token rotation, action invocation
with validation, cancellation, timeouts, progress, sampling, confirmation, schema-checked
elicitation, structured logs, and resources with reads, subscriptions, and pushes.

Gateway-minted claims only. WebSocket only: no Unix domain sockets and no host-minted bind
in this release, so the conformance suite skips those fixtures honestly.

## Examples

From the repo root, run the headless todo app with:

```bash
uv run --locked --directory sdks/python python -m examples.todo
```

Run the prompt library with:

```bash
uv run --locked --directory sdks/python python -m examples.prompts
```

Each prints a claim code after the gateway connects. In Claude Code with the Tesseron plugin
loaded, ask Claude to claim that code, then call the actions. The todo app includes the canonical
`todos://all` resource and the prompt app includes `library` and `lastTest` resources.

Validate both examples against the real gateway with `pnpm example:python:e2e`.

## Development

Run everything from this directory:

```bash
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run mypy --strict src tests
uv run pytest
uv build
```

The conformance host lives in `conformance_host/`, beside the package rather than inside
it, so the published wheel carries the SDK and nothing else. See
[the conformance page](https://eigenwise.github.io/tesseron/sdk/python/conformance/) for how
the runner drives it.

## Documentation

- [Python SDK](https://eigenwise.github.io/tesseron/sdk/python/)
- [Protocol specification](https://eigenwise.github.io/tesseron/protocol/)

## License

Tesseron is licensed under the [Business Source License 1.1](./LICENSE). Each
release auto-converts to Apache-2.0, the Change License, four years after
publication.
