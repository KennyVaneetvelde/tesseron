---
title: Python SDK
description: The Python implementation of the Tesseron host protocol, built on asyncio and Pydantic v2.
related:
  - sdk/index
  - sdk/python/actions
  - sdk/python/conformance
  - protocol/compatibility
---

`tesseron` is the Python host SDK. Your application listens on loopback, the MCP gateway dials in, and the agent gets typed actions and readable resources.

It speaks protocol [**1.2.0**](/protocol/), the same version the TypeScript packages speak. Compatibility is decided by protocol version, never by matching package numbers: see the [compatibility contract](/protocol/compatibility/).

Not on PyPI yet. It lives in the monorepo at [`sdks/python/`](https://github.com/eigenwise/tesseron/tree/main/sdks/python) and versions independently of the TypeScript group.

## Requirements

Python 3.11 or newer. Two runtime dependencies: Pydantic v2 and `websockets`. Everything else is stdlib asyncio.

## A first host

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

`app.listen()` binds `127.0.0.1` on a port the OS picks, writes the instance manifest the gateway watches for, and answers with a `TesseronHost` carrying the URL and the manifest path. Nothing dials out.

The application id has to match `^[a-z][a-z0-9_]*$` and cannot be `tesseron`, `mcp`, or `system`: the gateway uses it as an MCP tool prefix. An id that fails either rule raises `InvalidApplicationIdError` from `listen()` rather than binding a socket nobody can use.

## What it covers

Handshake and claiming, session resume with in-memory token rotation, action invocation with input validation, cancellation, per-action timeouts, streaming progress, sampling, confirmation, schema-checked elicitation, structured logs, and resources with reads, subscriptions, and pushes. All four capability flags are declared true.

Gateway-minted claims only, and WebSocket only. There is no Unix domain socket transport and no host-minted bind in this release, so the [conformance suite](/sdk/python/conformance/) skips those fixtures rather than pretending.

## The manifest

`listen()` publishes a v2 instance manifest into `~/.tesseron/instances/` once the URL is known: `0700` on the directory, `0600` on the file, removed again on `shutdown()`. POSIX modes are advisory on Windows, where the user account is the gate.

Point it somewhere else, or switch it off, with `ManifestPublication`:

```python
from pathlib import Path

from tesseron import ManifestPublication, TesseronApp

TesseronApp(id="todo", name="Todo", manifest=ManifestPublication.in_directory(Path("/tmp/x")))
TesseronApp(id="todo", name="Todo", manifest=ManifestPublication.disabled())
```

Disabling it is what a test harness wants. The conformance host does exactly that, because the runner dials an endpoint it was told about and should never touch a developer's `~/.tesseron`.

## Session events

`app.add_event_listener(listener)` takes a plain callable and gets `WelcomeEvent`, `ClaimedEvent`, `HandshakeFailedEvent`, and `DisconnectedEvent`. A listener that raises is logged and skipped: one bad listener must not break the session it was told about.

```python
from tesseron import ClaimedEvent, HostEvent


def watch(event: HostEvent) -> None:
    if isinstance(event, ClaimedEvent):
        print("claimed by", event.claimed.agent.name)


app.add_event_listener(watch)
```

## Development

Run everything from the repo root with uv, the way CI does:

```bash
uv sync --locked --directory sdks/python
uv run --locked --directory sdks/python ruff check .
uv run --locked --directory sdks/python ruff format --check .
uv run --locked --directory sdks/python mypy --strict src tests
uv run --locked --directory sdks/python pytest
uv build --directory sdks/python
pnpm conformance:run:python
```

## Next

- [Actions](/sdk/python/actions/): the decorator, input inference, and what a handler may return.
- [Resources](/sdk/python/resources/): reads, subscriptions, and pushes.
- [Context](/sdk/python/context/): progress, sampling, confirmation, elicitation, logs, cancellation.
- [Errors](/sdk/python/errors/): the code catalog and the three ways a handler fails.
- [Conformance](/sdk/python/conformance/): how the runner drives the host, and what it skips.
