---
title: Python SDK (planned)
description: Status and intended shape of a Python implementation of the Tesseron SDK.
related:
  - sdk/index
  - sdk/porting
---

A Python SDK is on the roadmap but **not yet shipped**.

When it lands, it will implement the same [portable SDK contract](/sdk/#the-portable-sdk-contract) as `@tesseron/core`:

- An action builder that accepts any Python validator (Pydantic v2, `msgspec`, `attrs`+`cattrs`) and produces JSON Schema.
- An invocation context object with `progress`, `sample`, `confirm`, `elicit`, `log`, and an `asyncio.CancelledError`-based cancellation contract.
- A resource builder with `.read()` and `.subscribe()`.
- A WebSocket transport using `websockets` or `aiohttp`.
- A CLI and an optional `FastAPI` integration helper.

## Why Python at all

Two use cases we hear most:

1. **Backend services already written in Python.** You have a Flask / FastAPI / Django app and don't want to proxy everything through a Node service just to expose it to Claude.
2. **Local Python tooling.** Jupyter notebooks, data-analysis scripts, personal CLIs - all things where exposing half a dozen actions to Claude adds real leverage.

Both are better served by a native Python SDK than by shelling out to Node.

## Design notes

Rough shape, subject to change:

```python
from tesseron import Tesseron
from pydantic import BaseModel

tesseron = Tesseron(app={"id": "notes", "name": "Notes"})

class CreateNoteInput(BaseModel):
    title: str
    body: str = ""

@tesseron.action("createNote", input=CreateNoteInput)
async def create_note(input: CreateNoteInput, ctx):
    note = {"id": new_id(), "title": input.title, "body": input.body}
    store.add(note)
    ctx.progress(message="saved", percent=100)
    return note

await tesseron.connect()
```

Decorator-flavoured where it fits the ecosystem better than the fluent builder. The wire contract is identical - any Tesseron SDK must produce the same `tesseron/hello` envelope and respond to the same `actions/invoke` request.

## Roadmap

- Early spike: TBD, tracked in the [Tesseron repo](https://github.com/BrainBlend-AI/tesseron).
- 1.0 target: feature-parity with `@tesseron/core` + `@tesseron/server`.

If you want to contribute or help shape the API, open a discussion on GitHub.
