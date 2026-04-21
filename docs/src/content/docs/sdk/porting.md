---
title: Port Tesseron to your language
description: Step-by-step guide to writing a new Tesseron SDK and a conformance checklist for testing it.
---

Tesseron's wire protocol is small enough that a competent engineer can implement an SDK for a new language in a couple of days. This page is your map.

## What you're actually building

A Tesseron SDK is three things glued together:

1. **A WebSocket client** that speaks JSON-RPC 2.0.
2. **A builder DSL** for declaring actions and resources.
3. **A bridge** between the JSON-RPC dispatcher and the builder's registered handlers.

The full [protocol spec](/protocol/) is the source of truth. If anything on this page contradicts it, the protocol wins.

## Step 1 - pick a runtime model

Two choices decide the shape of everything that follows.

- **Async model.** Native `async`/`await` / futures / goroutines - whatever your language uses for concurrency. All SDK methods that may block (connect, sample, elicit, progress-waiting action handlers) should be async. Synchronous handlers are fine, but the client's I/O loop must not be.
- **Schema library.** You need a way for users to express typed inputs. Pick one well-known library (Pydantic in Python, `go-playground/validator` in Go, Serde+schemars in Rust), and accept any user-provided schema that can round-trip to JSON Schema.

## Step 2 - model the protocol types

Port these from the [wire format page](/protocol/wire-format/):

- JSON-RPC 2.0 request / notification / success / error envelopes.
- `HelloParams`, `WelcomeResult`, `ActionAnnotations`, `InvokeParams`, `ProgressParams`, `CancelParams`, `SampleParams`, `ElicitParams`, `ReadParams`, `SubscribeParams`, `UpdatedParams`.
- The error-code enum from the [errors page](/protocol/errors/).

Give the error codes first-class names. Don't pass bare integers around - they accumulate magic.

## Step 3 - write the dispatcher

A bidirectional JSON-RPC dispatcher with:

- `on(method, handler)` - respond to incoming requests.
- `onNotification(method, handler)` - respond to incoming notifications.
- `request(method, params, { timeoutMs })` - send a request, await the response. ID generation, timeout handling, rejection on close.
- `notify(method, params)` - send a fire-and-forget notification.
- `receive(message)` - given a parsed JSON-RPC envelope, dispatch to a handler or resolve a pending request.

Test this in isolation against a pair of in-memory dispatchers. No networking yet.

## Step 4 - write the transport

A WebSocket client that:

- Connects to `ws://127.0.0.1:7475` (configurable).
- Serialises objects with the language's standard JSON library.
- Exposes `send`, `onMessage`, `onClose`, `close`.
- Parses incoming text frames as JSON and calls the `onMessage` handler.

Don't reinvent backoff or reconnect inside the transport - that's the user's job.

## Step 5 - builder DSL

Whatever shape is idiomatic. In TypeScript we use a fluent builder (`action(...).describe(...).input(...).handler(...)`). In Python, decorators. In Rust, probably a struct with a method-chain pattern. What matters is that it ultimately produces a `RegisteredAction`:

```
RegisteredAction {
  name: string;
  description?: string;
  inputSchema?: StandardJsonSchema;
  outputSchema?: StandardJsonSchema;
  annotations?: ActionAnnotations;
  timeoutMs?: number;
  strictOutput: boolean;
  handler: (input, ctx) => output;
}
```

Same for `RegisteredResource`.

## Step 6 - bind it together

```
class TesseronClient {
  constructor(transport, dispatcher) { … }
  app(info) { … }                   // records app manifest for hello
  action(name) { return new Builder(this, name) }
  resource(name) { return new ResBuilder(this, name) }
  async connect() {
    await transport.open();
    dispatcher.on('actions/invoke', this._onInvoke);
    dispatcher.onNotification('actions/cancel', this._onCancel);
    dispatcher.on('resources/read', this._onRead);
    dispatcher.on('resources/subscribe', this._onSub);
    dispatcher.on('resources/unsubscribe', this._onUnsub);
    return await dispatcher.request('tesseron/hello', this._manifest());
  }
}
```

Each `on(...)` handler maps to the corresponding builder. Implement progress / sample / elicit / log on the `ActionContext` the same way.

## Step 7 - conformance checklist

Before you ship, make sure the SDK passes every line of this list. An SDK that fails any line is not Tesseron-compliant.

**Handshake**
- [ ] Sends `tesseron/hello` immediately after WebSocket open.
- [ ] Sends `protocolVersion = "1.0.0"` exactly.
- [ ] Sends `app.id` that matches `/^[a-z][a-z0-9_]*$/`.
- [ ] Surfaces `welcome.claimCode` to the caller (stdout, event, return value - your choice).
- [ ] Surfaces `welcome.capabilities` as the authoritative agent capability set to handlers.

**Actions**
- [ ] Validates action input against the Standard-Schema-equivalent schema before the handler runs.
- [ ] Returns `-32004 InputValidation` with issues on failure.
- [ ] Passes output through unchanged by default; validates and returns `-32005` when strict output is enabled and validation fails.
- [ ] Supports per-invocation timeouts, default 60 000 ms, configurable per action.
- [ ] Aborts via idiomatic cancellation primitive when the MCP gateway sends `actions/cancel`.
- [ ] Returns `-32001 Cancelled` on explicit cancel; `-32002 Timeout` on timer.
- [ ] Emits `actions/progress` notifications from `ctx.progress(...)`.

**Sampling / Confirmation / Elicitation**
- [ ] Sends `sampling/request` / `elicitation/request` as requests (not notifications).
- [ ] `ctx.confirm` sends an elicit with an empty-properties object schema and collapses decline / cancel / missing-capability to `false`.
- [ ] `ctx.elicit` validates the response against the supplied Standard Schema and returns `null` on decline / cancel.
- [ ] Raises a typed error (`SamplingNotAvailable`, `ElicitationNotAvailable`) when capabilities don't include them - except `ctx.confirm`, which swallows missing elicitation and returns `false`.
- [ ] Rejects top-level non-object / `oneOf` / `anyOf` / nested-object elicit schemas with `-32602 InvalidParams` at the call site.
- [ ] Caps sampling depth at 3 (or honours the gateway's cap).

**Resources**
- [ ] Responds to `resources/read` with `{ value }`.
- [ ] Accepts `resources/subscribe` and returns the emitter callback's unsubscribe.
- [ ] Sends `resources/updated` notifications on change.
- [ ] Cleans up subscriptions on `resources/unsubscribe` and on transport close.

**Lifecycle**
- [ ] On transport close: rejects all pending outbound requests, aborts all in-flight invocations, clears all subscriptions.
- [ ] Does not auto-reconnect silently.

**Error model**
- [ ] Uses exactly the Tesseron error codes from [the errors catalog](/protocol/errors/).
- [ ] Preserves `error.data` verbatim when surfacing errors to handlers / users.

**Interop**
- [ ] Round-trips with the reference `@tesseron/mcp` gateway against at least one real MCP client (Claude Code, Cursor, Claude Desktop).

## Step 8 - publish + link

Open a PR against the main Tesseron repo adding your SDK to the README. Add a page to this docs site under `/sdk/<your-language>/` mirroring the Python skeleton.

Once your SDK has shipped a 1.0 that passes the checklist on real agents, we'll happily link it as a first-class implementation.
