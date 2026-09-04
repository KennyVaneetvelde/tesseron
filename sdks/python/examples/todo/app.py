from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field

from tesseron import (
    ActionContext,
    ActionError,
    HostEvent,
    JsonObject,
    JsonValue,
    TesseronApp,
)
from tesseron.host import WelcomeEvent


class AddTodoInput(BaseModel):
    text: str = Field(min_length=1)
    tag: str | None = None


class TodoIdentifierInput(BaseModel):
    id: str


class ListTodosInput(BaseModel):
    filter: Literal["all", "active", "completed"] | None = None


class EmptyInput(BaseModel):
    pass


class RenameTodoAnswer(BaseModel):
    new_name: str = Field(alias="newName", min_length=1)


class ImportTodosInput(BaseModel):
    items: list[str] = Field(min_length=1, max_length=50)
    tag: str | None = None


class SuggestTodosInput(BaseModel):
    theme: str = Field(min_length=1)
    count: int | None = Field(default=None, ge=1, le=10)


class SuggestedTodos(BaseModel):
    items: list[str]


@dataclass
class Todo:
    id: str
    text: str
    done: bool
    tag: str | None


@dataclass
class TodoStore:
    next_identifier: int = 1
    todos: list[Todo] = field(default_factory=list)

    def create(self, text: str, tag: str | None) -> Todo:
        todo = Todo(id=f"t{self.next_identifier}", text=text, done=False, tag=tag)
        self.next_identifier += 1
        self.todos.append(todo)
        return todo


def todo_payload(todo: Todo) -> JsonObject:
    payload: JsonObject = {"id": todo.id, "text": todo.text, "done": todo.done}
    if todo.tag is not None:
        payload["tag"] = todo.tag
    return payload


def json_string_array(values: list[str]) -> list[JsonValue]:
    result: list[JsonValue] = []
    for value in values:
        result.append(value)
    return result


def todo_not_found() -> ActionError:
    return ActionError.handler("Todo not found", {"kind": "not_found"})


def create_app() -> TesseronApp:
    app = TesseronApp(id="python_todo", name="Python Todo")
    store = TodoStore()

    async def read_todos() -> JsonValue:
        return [todo_payload(todo) for todo in store.todos]

    todos_resource = app.resource(
        "todos://all",
        description="The complete todo list. Pushed on every mutation.",
        read=read_todos,
        subscribable=True,
    )

    async def publish_todos() -> None:
        await todos_resource.publish(await read_todos())

    @app.action("addTodo", description="Add one todo")
    async def add_todo(input_data: AddTodoInput, context: ActionContext) -> JsonObject:
        del context
        todo = store.create(input_data.text, input_data.tag)
        await publish_todos()
        return todo_payload(todo)

    @app.action("toggleTodo", description="Toggle one todo")
    async def toggle_todo(input_data: TodoIdentifierInput, context: ActionContext) -> JsonObject:
        del context
        todo = next((item for item in store.todos if item.id == input_data.id), None)
        if todo is None:
            raise todo_not_found()
        todo.done = not todo.done
        await publish_todos()
        return todo_payload(todo)

    @app.action("deleteTodo", description="Delete one todo")
    async def delete_todo(input_data: TodoIdentifierInput, context: ActionContext) -> JsonObject:
        del context
        original_length = len(store.todos)
        store.todos[:] = [todo for todo in store.todos if todo.id != input_data.id]
        if len(store.todos) == original_length:
            raise todo_not_found()
        await publish_todos()
        return {"id": input_data.id, "removed": True}

    @app.action("listTodos", description="List todos")
    async def list_todos(input_data: ListTodosInput, context: ActionContext) -> list[JsonObject]:
        del context
        filter_name = input_data.filter or "all"
        if filter_name == "all":
            return [todo_payload(todo) for todo in store.todos]
        expected_done = filter_name == "completed"
        return [todo_payload(todo) for todo in store.todos if todo.done is expected_done]

    @app.action("clearCompleted", description="Delete completed todos")
    async def clear_completed(input_data: EmptyInput, context: ActionContext) -> JsonObject:
        del input_data, context
        original_length = len(store.todos)
        store.todos[:] = [todo for todo in store.todos if not todo.done]
        removed = original_length - len(store.todos)
        if removed > 0:
            await publish_todos()
        return {"removed": removed}

    @app.action("renameTodo", description="Rename one todo")
    async def rename_todo(input_data: TodoIdentifierInput, context: ActionContext) -> JsonObject:
        todo = next((item for item in store.todos if item.id == input_data.id), None)
        if todo is None:
            raise todo_not_found()
        answer = await context.elicit_as(RenameTodoAnswer, f'Rename "{todo.text}" to?')
        if answer is None:
            return {"id": input_data.id, "renamed": False, "cancelled": True}
        todo.text = answer.new_name
        await publish_todos()
        return {"id": input_data.id, "renamed": True, "newName": answer.new_name}

    @app.action("importTodos", description="Import several todos")
    async def import_todos(input_data: ImportTodosInput, context: ActionContext) -> JsonObject:
        identifiers: list[str] = []
        item_count = len(input_data.items)
        for index, text in enumerate(input_data.items, start=1):
            todo = store.create(text, input_data.tag)
            identifiers.append(todo.id)
            await context.progress(
                message=f"{index}/{item_count} imported", percent=index * 100 // item_count
            )
        await publish_todos()
        return {"added": len(identifiers), "ids": json_string_array(identifiers)}

    @app.action("suggestTodos", description="Suggest todos for a theme")
    async def suggest_todos(input_data: SuggestTodosInput, context: ActionContext) -> JsonObject:
        count = input_data.count or 5
        await context.progress(message="asking LLM...", percent=25)
        suggested = await context.sample_as(
            SuggestedTodos,
            (
                f'Produce exactly {count} concrete todo items for the theme "{input_data.theme}". '
                "Return JSON matching { items: string[] }. Items should be short, imperative, "
                "and user-friendly. No numbering."
            ),
            max_tokens=400,
        )
        await context.progress(message="adding to list...", percent=80)
        todos = [store.create(text, input_data.theme) for text in suggested.items]
        await publish_todos()
        return {"theme": input_data.theme, "added": len(todos), "ids": [todo.id for todo in todos]}

    return app


async def main() -> None:
    app = create_app()

    def show_claim_code(event: HostEvent) -> None:
        if isinstance(event, WelcomeEvent) and event.welcome.claim_code is not None:
            print(f"Claim code: {event.welcome.claim_code}", flush=True)

    app.add_event_listener(show_claim_code)
    host = await app.listen()
    try:
        await asyncio.Event().wait()
    finally:
        await host.shutdown()
