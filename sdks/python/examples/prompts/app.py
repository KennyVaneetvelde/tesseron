from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from tesseron import ActionContext, ActionError, HostEvent, JsonObject, JsonValue, TesseronApp
from tesseron.host import WelcomeEvent


class AddPromptInput(BaseModel):
    name: str = Field(min_length=1)
    template: str = Field(min_length=1)
    tags: list[str] | None = None


class ListPromptsInput(BaseModel):
    tag: str | None = None


class PromptIdentifierInput(BaseModel):
    id: str


class TestPromptInput(BaseModel):
    id: str
    variables: dict[str, str] | None = None


class RefinePromptAnswer(BaseModel):
    instruction: str = Field(min_length=1)


class GenerateVariantsInput(BaseModel):
    id: str
    count: int | None = Field(default=None, ge=1, le=10)


class VariantResponse(BaseModel):
    variants: list[str]


class ImportedPrompt(BaseModel):
    name: str = Field(min_length=1)
    template: str = Field(min_length=1)
    tags: list[str] | None = None


class ImportPromptsInput(BaseModel):
    items: list[ImportedPrompt] = Field(min_length=1, max_length=50)


class EmptyInput(BaseModel):
    pass


class PurgeAnswer(BaseModel):
    confirmation: str


@dataclass
class Prompt:
    id: str
    name: str
    template: str
    tags: list[str]
    created_at: int
    last_tested_at: int | None = None
    times_tested: int = 0


@dataclass
class TestResult:
    prompt_id: str
    prompt_name: str
    input: dict[str, str]
    response: str
    tested_at: int


@dataclass
class PromptStore:
    next_identifier: int = 1
    prompts: dict[str, Prompt] = field(default_factory=dict)
    last_test: TestResult | None = None

    def create(self, name: str, template: str, tags: list[str]) -> Prompt:
        prompt = Prompt(
            id=f"p{self.next_identifier}",
            name=name,
            template=template,
            tags=tags,
            created_at=timestamp(),
        )
        self.next_identifier += 1
        self.prompts[prompt.id] = prompt
        return prompt

    def library(self) -> list[Prompt]:
        return [self.prompts[prompt_id] for prompt_id in sorted(self.prompts)]


def timestamp() -> int:
    return time.time_ns() // 1_000_000


def json_string_array(values: list[str]) -> list[JsonValue]:
    result: list[JsonValue] = []
    for value in values:
        result.append(value)
    return result


def json_string_object(values: dict[str, str]) -> JsonObject:
    result: JsonObject = {}
    for key, value in values.items():
        result[key] = value
    return result


def prompt_payload(prompt: Prompt) -> JsonObject:
    payload: JsonObject = {
        "id": prompt.id,
        "name": prompt.name,
        "template": prompt.template,
        "tags": json_string_array(prompt.tags),
        "createdAt": prompt.created_at,
        "timesTested": prompt.times_tested,
    }
    if prompt.last_tested_at is not None:
        payload["lastTestedAt"] = prompt.last_tested_at
    return payload


def test_result_payload(result: TestResult) -> JsonObject:
    return {
        "promptId": result.prompt_id,
        "promptName": result.prompt_name,
        "input": json_string_object(result.input),
        "response": result.response,
        "testedAt": result.tested_at,
    }


def prompt_not_found() -> ActionError:
    return ActionError.handler("Prompt not found", {"kind": "not_found"})


def sampled_text(value: JsonValue) -> str:
    if isinstance(value, str):
        return value
    raise ActionError.handler("The sampling result was not text", {"content": value})


def fill_template(template: str, variables: dict[str, str]) -> str:
    rendered = ""
    remainder = template
    while "{{" in remainder:
        before, after_open = remainder.split("{{", maxsplit=1)
        rendered += before
        if "}}" not in after_open:
            return rendered + "{{" + after_open
        variable, remainder = after_open.split("}}", maxsplit=1)
        key = variable.strip()
        value = variables.get(key)
        if value is None:
            raise ActionError.handler(f'Missing variable "{key}" for prompt template')
        rendered += value
    return rendered + remainder


def create_app() -> TesseronApp:
    app = TesseronApp(id="python_prompts", name="Python Prompts")
    store = PromptStore()

    async def read_library() -> JsonValue:
        return [prompt_payload(prompt) for prompt in store.library()]

    async def read_last_test() -> JsonValue:
        if store.last_test is None:
            return None
        return test_result_payload(store.last_test)

    library_resource = app.resource(
        "library",
        description="Live snapshot of every prompt in the library. Pushed on every change.",
        read=read_library,
        subscribable=True,
    )
    last_test_resource = app.resource(
        "lastTest",
        description=(
            "The most recent test result from testPrompt, or null if no prompt has been tested."
        ),
        read=read_last_test,
        subscribable=True,
    )

    async def publish_library() -> None:
        await library_resource.publish(await read_library())

    async def publish_last_test() -> None:
        await last_test_resource.publish(await read_last_test())

    @app.action("addPrompt", description="Add a prompt to the library")
    async def add_prompt(input_data: AddPromptInput, context: ActionContext) -> JsonObject:
        del context
        prompt = store.create(input_data.name, input_data.template, input_data.tags or [])
        await publish_library()
        return prompt_payload(prompt)

    @app.action("listPrompts", description="List prompts in the library")
    async def list_prompts(
        input_data: ListPromptsInput, context: ActionContext
    ) -> list[JsonObject]:
        del context
        prompts = store.library()
        if input_data.tag is not None:
            prompts = [prompt for prompt in prompts if input_data.tag in prompt.tags]
        return [prompt_payload(prompt) for prompt in prompts]

    @app.action("deletePrompt", description="Delete a prompt after confirmation")
    async def delete_prompt(
        input_data: PromptIdentifierInput, context: ActionContext
    ) -> JsonObject:
        prompt = store.prompts.get(input_data.id)
        if prompt is None:
            raise prompt_not_found()
        confirmed = await context.confirm(
            f'Delete prompt "{prompt.name}" (tested {prompt.times_tested}x)? This cannot be undone.'
        )
        if not confirmed:
            return {"id": input_data.id, "deleted": False, "cancelled": True}
        del store.prompts[input_data.id]
        await publish_library()
        return {"id": input_data.id, "deleted": True}

    @app.action("testPrompt", description="Run a prompt through sampling")
    async def test_prompt(input_data: TestPromptInput, context: ActionContext) -> JsonObject:
        prompt = store.prompts.get(input_data.id)
        if prompt is None:
            raise prompt_not_found()
        variables = input_data.variables or {}
        filled = fill_template(prompt.template, variables)
        await context.progress(message="asking LLM...", percent=25)
        response = sampled_text(await context.sample(filled, max_tokens=512))
        await context.progress(message="storing result...", percent=90)
        prompt.last_tested_at = timestamp()
        prompt.times_tested += 1
        store.last_test = TestResult(
            prompt_id=prompt.id,
            prompt_name=prompt.name,
            input=variables,
            response=response,
            tested_at=timestamp(),
        )
        await publish_library()
        await publish_last_test()
        return {"id": input_data.id, "response": response, "timesTested": prompt.times_tested}

    @app.action("refinePrompt", description="Refine a prompt with elicitation and sampling")
    async def refine_prompt(
        input_data: PromptIdentifierInput, context: ActionContext
    ) -> JsonObject:
        prompt = store.prompts.get(input_data.id)
        if prompt is None:
            raise prompt_not_found()
        answer = await context.elicit_as(
            RefinePromptAnswer,
            (
                f'Refining "{prompt.name}". What should change? '
                '(e.g. "make it more concise", "demand JSON output", "add a role")'
            ),
        )
        if answer is None:
            return {"id": input_data.id, "refined": False, "cancelled": True}
        await context.progress(message="applying refinement...", percent=40)
        rewritten = sampled_text(
            await context.sample(
                (
                    "You rewrite prompt templates. Return the new template only, no prose.\n\n"
                    f"Original template:\n{prompt.template}\n\nInstruction: {answer.instruction}"
                ),
                max_tokens=800,
            )
        )
        previous_template = prompt.template
        prompt.template = rewritten.strip()
        await publish_library()
        return {
            "id": input_data.id,
            "refined": True,
            "instruction": answer.instruction,
            "previousTemplate": previous_template,
            "newTemplate": prompt.template,
        }

    @app.action("generateVariants", description="Generate prompt variations")
    async def generate_variants(
        input_data: GenerateVariantsInput, context: ActionContext
    ) -> JsonObject:
        source = store.prompts.get(input_data.id)
        if source is None:
            raise prompt_not_found()
        count = input_data.count or 3
        await context.progress(message="requesting variants...", percent=10)
        response = await context.sample_as(
            VariantResponse,
            (
                f"Produce exactly {count} distinct variations of the prompt below. "
                "Vary the phrasing, tone, or structure, but preserve the intent. "
                "Return JSON: { variants: string[] }.\n\n"
                f"Prompt:\n{source.template}"
            ),
            max_tokens=1200,
        )
        identifiers: list[str] = []
        for index, template in enumerate(response.variants, start=1):
            prompt = store.create(
                f"{source.name} (variant {index})", template, [*source.tags, "variant"]
            )
            identifiers.append(prompt.id)
            await context.progress(
                message=f"variant {index}/{count} stored", percent=index * 100 // count
            )
        await publish_library()
        return {
            "sourceId": input_data.id,
            "added": len(identifiers),
            "ids": json_string_array(identifiers),
        }

    @app.action("importPrompts", description="Import several prompts")
    async def import_prompts(input_data: ImportPromptsInput, context: ActionContext) -> JsonObject:
        identifiers: list[str] = []
        item_count = len(input_data.items)
        for index, item in enumerate(input_data.items, start=1):
            prompt = store.create(item.name, item.template, item.tags or [])
            identifiers.append(prompt.id)
            await context.progress(
                message=f"{index}/{item_count} imported", percent=index * 100 // item_count
            )
        await publish_library()
        return {"added": len(identifiers), "ids": json_string_array(identifiers)}

    @app.action("purgeAll", description="Delete every prompt after confirmation")
    async def purge_all(input_data: EmptyInput, context: ActionContext) -> JsonObject:
        del input_data
        prompt_count = len(store.prompts)
        if prompt_count == 0:
            return {"removed": 0}
        answer = await context.elicit_as(
            PurgeAnswer, f'Permanently delete ALL {prompt_count} prompts? Type "DELETE" to confirm.'
        )
        if answer is None or answer.confirmation.strip() != "DELETE":
            return {"removed": 0, "cancelled": True}
        store.prompts.clear()
        store.last_test = None
        await publish_library()
        await publish_last_test()
        return {"removed": prompt_count}

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
