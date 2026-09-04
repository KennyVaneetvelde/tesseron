---
title: Resources (Python)
description: Readable and optionally subscribable application state, with pushes and cleanup.
related:
  - sdk/python/index
  - sdk/python/actions
  - protocol/resources
---

A resource is named application state the agent can read, and optionally follow. Actions change things; resources report them.

## Registering one

```python
from tesseron import JsonValue, TesseronApp

app = TesseronApp(id="todo", name="Todo")


async def read_cart() -> JsonValue:
    return {"items": store.items(), "total": store.total()}


cart = app.resource("cart", read=read_cart, description="Current cart", subscribable=True)
```

`app.resource` answers with the `Resource` handle, which is what you push updates through. The reader is `async` and runs on every `resources/read`, so it always reports the current value rather than a snapshot taken at registration.

Registering one name twice raises `DuplicateNameError`.

## Pushing updates

```python
await cart.publish({"items": store.items(), "total": store.total()})
```

`publish` goes to every agent currently subscribed to that resource, and does nothing when nobody is. Call it from wherever the state actually changes.

## Subscribing with your own source

Some state has a natural event source: a file watcher, a database listener, a queue. Hand `subscribe` a callback that starts it and answers with the cleanup that stops again:

```python
def follow(emit: Emit) -> Unsubscribe:
    watcher = start_watching(lambda value: emit(value))
    return watcher.stop


cart = app.resource("cart", read=read_cart, subscribable=True, subscribe=follow)
```

The callback is synchronous and runs inside the session's read loop, so start your work and return promptly rather than awaiting in it. The cleanup runs when the agent unsubscribes, and again when the connection drops: a subscriber still holding a listener would emit into a closed socket for as long as the application runs.

Passing `subscribe` implies `subscribable=True`. A resource is also subscribable on `subscribable=True` alone, because `publish` is enough on its own to push updates.

## What the wire does

`resources/subscribe` and `resources/unsubscribe` both acknowledge with `result: null`. The acknowledgement goes out **before** the subscriber runs, so a value the subscriber emits immediately cannot overtake the response the agent is still waiting on.

Unsubscribing an id nobody registered is not an error. The agent and the transport can race, and there is nothing left to tear down either way.

Reading a resource that was never declared answers `-32003` with `Resource not readable: <name>`. Subscribing to one that was never declared, or to one that is not subscribable, answers `-32003` with `Resource not subscribable: <name>`. That is the same answer `@tesseron/core` gives.

A reader that raises `ActionError` sends that failure to the agent. A reader that raises anything else answers a bare `-32603`, with the cause kept on your side.
