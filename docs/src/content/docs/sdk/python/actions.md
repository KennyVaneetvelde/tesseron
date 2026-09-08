---
title: Actions (Python)
description: The @app.action decorator, input inference from the handler annotation, and what a handler may return.
related:
  - sdk/python/index
  - sdk/python/context
  - sdk/python/errors
  - protocol/actions
---

An action is a named, typed, handler-backed operation the agent can invoke. The gateway projects each one into an MCP tool.

## The decorator

```python
from pydantic import BaseModel, Field
from tesseron import ActionContext, JsonObject, TesseronApp


class AddTodoInput(BaseModel):
    text: str = Field(min_length=1)
    tag: str | None = None


def create_app() -> TesseronApp:
    app = TesseronApp(id="python_todo", name="Python Todo")

    @app.action("addTodo", description="Add one todo")
    async def add_todo(input_data: AddTodoInput, context: ActionContext) -> JsonObject:
        del context
        todo = store.create(input_data.text, input_data.tag)
        await publish_todos()
        return todo_payload(todo)

    return app
```

The `store`, `publish_todos`, and `todo_payload` names above come directly from the canonical [`examples/todo/app.py`](https://github.com/Eigenwise/tesseron-python/blob/main/examples/todo/app.py) host.

Every handler is `async def` and takes `(input_data, context)`. A handler that is not a coroutine function, or that does not take two parameters, raises `HostError` at registration. Registering one name twice raises `DuplicateNameError`, because the manifest has to stay unambiguous for the gateway to project it.

## Input comes from the annotation

If the first parameter is annotated with a Pydantic `BaseModel`, that model is the input contract. Two things follow from it:

1. The manifest publishes `model_json_schema(mode="validation")`, unchanged. Validation mode is the right one here: the agent is producing input, not reading output, so aliases and defaults have to be described the way the model will accept them.
2. Dispatch runs `model_validate` before the handler body. Input that does not fit is refused with [`-32004 InputValidation`](/protocol/errors/), and the handler never runs.

The refusal carries every problem Pydantic found, not just the first:

```json
{
  "code": -32004,
  "message": "Invalid input",
  "data": [
    { "message": "String should have at least 1 character", "path": ["text"] },
    { "message": "Input should be a valid string", "path": ["tag"] }
  ]
}
```

## Raw JSON input

Annotate the first parameter with anything else and the handler takes the invocation input as raw JSON. Then `input_schema` is what the manifest publishes and `validate` is what enforces it:

```python
from tesseron import ActionContext, JsonValue, ValidationIssue


def positive_amount(raw_input: JsonValue) -> list[ValidationIssue]:
    if isinstance(raw_input, dict) and isinstance(raw_input.get("amount"), int | float):
        return []
    return [ValidationIssue(message="amount must be a number", path=["amount"])]


@app.action(
    "charge",
    description="Charge the saved card",
    input_schema={"type": "object", "properties": {"amount": {"type": "number"}}},
    validate=positive_amount,
)
async def charge(raw_input: JsonValue, context: ActionContext) -> JsonValue:
    return {"charged": True}
```

A non-empty issue list becomes the same `-32004` failure, with the same `data` shape. Leave `validate` off and nothing is checked: the schema is then documentation for the agent and nothing more.

## The other options

| Argument | What it does |
| --- | --- |
| `description` | Published in the manifest. The gateway uses it as the MCP tool description, so write it for the agent. |
| `input_schema` | Overrides the schema derived from the model, or supplies one for a raw handler. |
| `output_schema` | Published when set. Nothing validates output against it; it tells the agent what to expect. |
| `timeout_ms` | Per-action deadline. Past it the invocation answers [`-32002 Timeout`](/protocol/errors/) and the handler task is cancelled. The default is 60 seconds. |
| `validate` | Extra input check for a raw handler. Ignored when the input type comes from a model. |

## What a handler may return

Output is converted to JSON before it leaves. Pydantic models go through `model_dump(mode="json")`, enums through their value, mappings and sequences recursively, and `None`, `bool`, `int`, `float`, `str` as they are.

Anything else has no defined wire shape, so it fails as an internal error rather than reaching the agent as the string of a repr. Return a model or a dict.

## Failing on purpose

Raise `ActionError` when the handler cannot produce its output:

```python
from pydantic import BaseModel
from tesseron import ActionContext, ActionError, JsonObject


class TodoIdentifierInput(BaseModel):
    id: str


@app.action("deleteTodo", description="Delete one todo")
async def delete_todo(input_data: TodoIdentifierInput, context: ActionContext) -> JsonObject:
    del context
    original_length = len(store.todos)
    store.todos[:] = [todo for todo in store.todos if todo.id != input_data.id]
    if len(store.todos) == original_length:
        raise ActionError.handler("Todo not found", {"kind": "not_found"})
    await publish_todos()
    return {"id": input_data.id, "removed": True}
```

This is the canonical `deleteTodo` shape from [`examples/todo/app.py`](https://github.com/Eigenwise/tesseron-python/blob/main/examples/todo/app.py).

`ActionError.handler` sends its message and data to the agent as `-32005`. `ActionError.protocol(code, message, data)` does the same under a code you pick. `ActionError.internal(cause)` keeps the cause on your side and answers with a bare `-32603 Internal error`, which is what an unhandled exception in a handler is turned into too. See [errors](/sdk/python/errors/).
