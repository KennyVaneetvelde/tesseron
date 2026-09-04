---
title: Context (Python)
description: What an ActionContext tells a handler, and everything it can send back while it runs.
related:
  - sdk/python/actions
  - protocol/progress-cancellation
  - protocol/sampling
  - protocol/elicitation
---

Every handler gets `(input, context)`. The context is what the invocation knows and what it can send while it runs.

## What it knows

| Member | What it is |
| --- | --- |
| `action_name` | The name this invocation was made under. |
| `invocation_id` | The id the agent gave this invocation. Every frame the context sends carries it. |
| `agent` | `AgentIdentity(id, name)`. `pending` / `Awaiting agent` until the session is claimed. |
| `agent_capabilities` | The negotiated intersection: `streaming`, `subscriptions`, `sampling`, `elicitation`. |
| `origin` | The origin the application declared at construction. |
| `route` | Where the agent was when it invoked, when the gateway sent one. `None` otherwise. |
| `cancellation` | The shared cancellation signal. |
| `is_cancelled` | Whether cancellation has already been requested. |

The context is assembled after the handshake settles, so `agent_capabilities` is never a guess: an invocation the gateway wrote straight after the welcome waits for the welcome to be applied before the handler sees it.

## Progress

```python
await context.progress(percent=40, message="reading", data={"page": 2})
```

Percent is an integer from 0 to 100. Out-of-range values are clamped into range, and a value below one already sent for this invocation is raised back up to the running ceiling. An agent rendering a progress bar treats a backwards jump as a restart, and the message is worth more than the regression. Message and data travel unchanged.

Every argument is optional. Progress with only a message is a perfectly good frame. It is a notification, so nothing answers it and it costs the handler nothing to send.

## Cancellation

The agent cancels with a notification, so nothing answers `actions/cancel`. The invocation it names answers `-32001` instead, and its task is cancelled.

A handler that ignores the signal still gets its answer replaced, so long handlers should watch for it:

```python
@app.action("export")
async def export(input: Export, context: ActionContext) -> JsonValue:
    for index, row in enumerate(rows):
        if context.is_cancelled:
            return {"exported": index}
        await write(row)
        await context.progress(percent=index * 100 // len(rows))
    return {"exported": len(rows)}
```

`await context.cancellation.wait()` resolves as soon as cancellation is requested, immediately if it already was, which is what you race a long await against.

## Sampling

```python
summary = await context.sample("Summarise this cart", max_tokens=200)
```

`sample` asks the agent's model and answers with the content it returned. With a Pydantic model, `sample_as` derives the output schema and decodes the answer into it:

```python
class Summary(BaseModel):
    headline: str
    items: int


summary = await context.sample_as(Summary, "Summarise this cart")
```

A model asked for structured output answers with the JSON as text, so a string result is parsed before it is decoded.

An agent that never negotiated sampling gets you `-32006 SamplingNotAvailable` before a frame goes out. Sampling depth is not a field in any Tesseron frame: the gateway owns `maxSamplingDepth` and answers `-32008` itself, so the host forwards the request without counting.

## Confirmation

```python
if not await context.confirm("Delete every todo?"):
    return {"deleted": 0}
```

`True` only on an explicit accept. A decline, a cancel, and an agent that never negotiated elicitation all answer `False`, which is the safe reading for the destructive-operation gates this exists for. It never raises on the user's answer.

## Elicitation

```python
answer = await context.elicit("How many?", json_schema={
    "type": "object",
    "properties": {"count": {"type": "integer"}},
    "required": ["count"],
})
```

`None` on a decline or a cancel. Unlike `confirm`, a missing capability is an error here: structured content has no safe default, so the handler has to branch on it explicitly.

MCP renders an elicit prompt as a flat form, so the schema has to be one object of primitive leaves. The host checks that on the send path, before the frame leaves, so a bad schema fails at the `elicit` call site with `-32602 InvalidParams` instead of surfacing as a gateway rejection three hops later. Top-level `oneOf`, `anyOf`, `allOf`, `not`, and object- or array-typed properties are all refused. A property with no usable type is accepted unchanged, and a `type` array is checked on its first entry.

Leave `json_schema` off and the host sends a one-text-field schema, which is the least a client can render.

`elicit_as` derives the form schema from a Pydantic model and decodes the accepted answer into it:

```python
class Quantity(BaseModel):
    count: int


quantity = await context.elicit_as(Quantity, "How many?")
```

## Logs

```python
await context.log("saved", level=LogLevel.WARN, meta={"todoId": "t-1"})
```

Fire and forget, forwarded to the agent. Levels are `debug`, `info`, `warn`, `error`, matching the MCP levels the gateway forwards to.

## Testing a handler without a gateway

`ActionContext.detached(action_name)` builds a context with no connection behind it. Notifications go nowhere, which is what a fire-and-forget frame does on a closed socket anyway, and every request answers `-32010 TransportClosed` rather than hanging.

```python
output = await add_todo(AddTodo(text="buy milk"), ActionContext.detached("addTodo"))
```

A live invocation sees the same `-32010` if the transport drops underneath it: every request still waiting on an answer fails with it rather than hanging, and a request started after the socket is gone fails immediately. The invocation itself is cancelled at that point, so a handler that watches `cancellation` gets to unwind.
