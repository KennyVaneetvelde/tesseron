---
title: Context (Rust)
description: Progress, cancellation, confirmation, elicitation, sampling, and logs available to every Rust handler.
related:
  - sdk/rust/actions
  - sdk/rust/errors
  - protocol/progress-cancellation
  - protocol/sampling
  - protocol/elicitation
---

<!-- snippets from sdks/rust/examples/todo -->
<!-- snippets from sdks/rust/examples/prompts -->

Every handler receives an `ActionContext` after the gateway handshake. It identifies the action and invocation, exposes the negotiated `Capabilities`, and carries the connection used for requests and notifications. It is cheap to clone, and clones share the progress ceiling.

## Progress

`ProgressUpdate::new()` builds an update. Add `.message(...)`, `.percent(...)`, and `.data(Value)` as needed, then call `context.progress(update)`.

The protocol progress value is an integer from `0` through `100`. Pass integer-valued percentages. Values below `0` clamp to `0`, values above `100` clamp to `100`, and a value below the highest value already sent for this invocation is raised to that value. The message and data still go out. Progress is fire-and-forget.

The todo example sends one update per imported item:

```rust
context.progress(
    ProgressUpdate::new()
        .message(format!("{}/{} imported", index + 1, item_count))
        .percent(((index + 1) * 100 / item_count) as f64),
);
```

The shared ceiling applies to cloned contexts too. A handler can report `55`, then `10`, and the second frame carries `55`.

## Cancellation

The gateway cancels with an `actions/cancel` notification. The invocation answers with `TesseronErrorCode::Cancelled`, and the running handler should unwind. Check `context.is_cancelled()` between units of work, or await `context.cancellation().cancelled()` beside a long operation. The cancellation future resolves immediately when cancellation was already requested.

A handler that ignores cancellation may keep running after the invocation response has been replaced. The host does not turn a late handler result into another response.

## Sampling

`context.sample(SampleRequest::new(prompt))` asks the agent's model and returns a `Value`. `SampleRequest::for_type::<Output>(prompt)` derives a JSON Schema for structured output, and `context.sample_as::<Output>(request)` decodes the result. Add `.max_tokens(...)` to cap the request.

The todo example asks for structured suggestions:

```rust
let suggested = context
    .sample_as::<SuggestedTodos>(
        SampleRequest::for_type::<SuggestedTodos>(format!(
            "Produce exactly {count} concrete todo items for the theme \"{}\". Return JSON matching {{ items: string[] }}. Items should be short, imperative, and user-friendly. No numbering.",
            input.theme
        ))
        .max_tokens(400),
    )
    .await?;
```

When sampling was not negotiated, the call returns `ActionError` with `TesseronErrorCode::SamplingNotAvailable` and sends nothing. Sampling depth is enforced by the gateway with `TesseronErrorCode::SamplingDepthExceeded`; the host does not count nested requests.

## Confirmation

`context.confirm(question)` asks a yes-or-no question through elicitation and returns `Result<bool, ActionError>`. It returns `true` only for an explicit accept. Decline, cancel, and missing elicitation capability return `false`.

The prompt example uses it before deleting a prompt:

```rust
let confirmed = context
    .confirm(format!(
        "Delete prompt \"{}\" (tested {}x)? This cannot be undone.",
        prompt.name, prompt.times_tested
    ))
    .await?;
```

## Elicitation

`ElicitRequest::new(question)` uses a permissive single-text-field schema. `ElicitRequest::for_type::<Answer>(question)` derives a form schema from a `JsonSchema` type. Pass either request to `context.elicit(...)`, or use `context.elicit_as::<Answer>(request)` to decode accepted content.

The todo example derives its answer schema:

```rust
let answer = context
    .elicit_as::<RenameTodoAnswer>(ElicitRequest::for_type::<RenameTodoAnswer>(
        format!("Rename \"{previous_text}\" to?"),
    ))
    .await?;
```

An accepted answer is `Some(Value)`, or `Some(Answer)` with `elicit_as`. Decline and cancel return `None`. Missing elicitation capability returns `TesseronErrorCode::ElicitationNotAvailable`. The host validates the JSON Schema before sending; an unsupported schema returns `InvalidParams` (`-32602`) at the call site, and no request reaches the agent. Top-level `oneOf`, `anyOf`, `allOf`, `not`, and object- or array-typed properties are refused.

## Logs

`context.log(LogEntry::info(message))` forwards a fire-and-forget log entry. Use `LogEntry::debug`, `LogEntry::warn`, or `LogEntry::error` for the other levels, and `.meta(...)` for structured metadata.

The session tests exercise the ordinary info level:

```rust
context.log(LogEntry::info("halfway"));
```

## Capability checks and dropped transports

`context.agent_capabilities()` is the negotiated capability set. Check it when a handler has a useful fallback. `context.agent()` identifies the caller, while `context.action_name()`, `context.invocation_id()`, `context.origin()`, and `context.route()` identify the running invocation.

Progress and logs after a transport drop are discarded. Request methods such as `sample`, `confirm`, and `elicit` return an `ActionError` carrying `TesseronErrorCode::TransportClosed`, including when a cloned context is used after the connection has gone away. They fail instead of hanging.
