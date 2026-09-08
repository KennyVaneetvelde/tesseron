---
title: Port Tesseron to your language
description: Step-by-step guide to writing a new Tesseron SDK and a conformance checklist for testing it.
related:
  - sdk/index
  - protocol/index
  - protocol/wire-format
  - sdk/typescript/core
  - sdk/python/index
  - sdk/rust/index
  - sdk/cpp/index
---

Tesseron already has [Rust](/sdk/rust/), [Python](/sdk/python/), and [C++](/sdk/cpp/) SDKs in their own language repositories. All three are working references for a new port.

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

You're picking a **binding** (which wire format) and writing the SDK-side host. Tesseron's protocol layer is binding-neutral; pick from the [documented bindings](/protocol/transport/) or design a new one.

For a WebSocket binding:

- Bind `127.0.0.1` on an OS-picked port.
- Write `~/.tesseron/instances/<instanceId>.json` with `{ version: 2, instanceId, appName, addedAt, transport: { kind: 'ws', url } }` where `url` is the URL just bound.
- Accept exactly one upgrade request that advertises the `tesseron-gateway` WebSocket subprotocol; reject every other attempt.
- Serialise outgoing objects with the language's standard JSON library and parse incoming text frames as JSON.
- Delete the manifest on close.

For a UDS binding (Linux / macOS):

- Create a private (mode `0700`) directory under `os.tmpdir()`-equivalent. Bind a socket inside it, `chmod 0600` the socket file.
- Write `~/.tesseron/instances/<instanceId>.json` with `{ version: 2, instanceId, appName, addedAt, transport: { kind: 'uds', path } }`.
- Accept exactly one connection; reject subsequent connect attempts.
- Frame messages as NDJSON (`JSON.stringify(msg) + '\n'`); split incoming bytes on `\n`.
- Delete the manifest, the socket file, and the temp dir on close.

The gateway is always the **client** - it watches `~/.tesseron/instances/`, picks a dialer matching `transport.kind`, and connects. Your runtime never opens an outbound connection; it binds, announces, and waits.

To add a binding the gateway doesn't yet know about, you also need to ship a `GatewayDialer` for the new `kind` (in TypeScript: `gateway/src/dialer.ts`) and document the wire format under `/protocol/transport-bindings/<kind>/`.

Don't reinvent backoff or reconnect inside the transport - that's the user's job.

## Step 5 - builder DSL

Whatever shape is idiomatic. TypeScript uses a fluent builder (`action(...).describe(...).input(...).handler(...)`), Python uses decorators, and Rust uses a method chain on `TesseronHostBuilder`. What matters is that it ultimately produces an `ActionDefinition`:

```
ActionDefinition {
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

Same for `ResourceDefinition`.

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

Part of this list is executable. Build a small host adapter that reads `TESSERON_CONFORMANCE_FIXTURE`, registers its canned actions and resources, and prints the readiness line described in the [fixture adapter contract](https://github.com/eigenwise/tesseron/blob/main/conformance/README.md). Then run the shipped protocol 1.2 suite:

```bash
pnpm dlx @tesseron/conformance@1.2.1 --host "./build/tesseron-conformance-host"
```

Use `TESSERON_CONFORMANCE_UNSUPPORTED=uds` on platforms without POSIX Unix domain sockets. The package carries the fixture corpus, reports skips separately, and runs each fixture against a fresh host process. Every language repository uses this published runner with its own host adapter. Docs and fixtures stay in the hub; an SDK release PR is complete only after its corresponding hub docs PR has merged. The prose list below remains the wider implementation checklist.

**Handshake**
- [ ] Sends `tesseron/hello` immediately after the binding's connection becomes ready.
- [ ] Sends `protocolVersion = "1.2.0"`. The gateway compares `major.minor`: a major mismatch is rejected with `-32000`, a minor mismatch is accepted with a warning.
- [ ] Sends `app.id` that matches `/^[a-z][a-z0-9_]*$/`.
- [ ] Surfaces `welcome.claimCode` to the caller (stdout, event, return value - your choice).
- [ ] Surfaces `welcome.capabilities` as the authoritative agent capability set to handlers.

**Claim minting** — pick one of the two flows. Gateway-minted is the simpler port and stays supported.

*Gateway-minted (default).* Omit `helloHandledByHost` from the manifest. The gateway auto-dials, mints the code, and returns it in the welcome. Nothing extra to implement.

- [ ] Manifest omits `helloHandledByHost` (or sets it `false`) and carries no `hostMintedClaim`.

*Host-minted (opt-in, [tesseron#60](https://github.com/eigenwise/tesseron/issues/60)).* The host mints the code so the user's paste deterministically picks one agent session instead of racing. Adds the [bind handshake](/protocol/handshake/#host-minted-claims-and-the-bind-handshake) as a hard requirement.

- [ ] Mints `code`, `sessionId`, and `resumeToken` at instance creation; writes them into `hostMintedClaim` and sets `helloHandledByHost: true`.
- [ ] Answers the app's own `tesseron/hello` locally with a synthesized welcome; does not forward it until a gateway binds.
- [ ] Sets `hostMintedClaim.expiresAt = mintedAt + 10 min` and refreshes both every 5 min by rewriting the manifest, stopping once `boundAgent` is non-null.
- [ ] Validates the bind code in **constant time**. A short-circuiting string compare leaks the code one character at a time.
- [ ] Rate-limits mismatches: 5 within a 60 s rolling window trips a 60 s lockout; a successful bind resets the window.
- [ ] Accepts exactly one bind. A second attempt against a spent claim is rejected, never re-bound.
- [ ] Rejects a dial that skips the bind step (a pre-1.2 gateway). Letting it through produces a second, conflicting welcome against an already-resolved hello.
- [ ] Replays the cached hello to the gateway after a successful bind, and drops the gateway's id-matched reply so the app never sees two welcomes.

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
- [ ] Forwards `sampling/request` without counting sampling depth. The gateway enforces the depth cap of 3; no Tesseron frame carries depth.

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

Open a PR against the main Tesseron repo adding your SDK to the README. Add a page to this docs site under `/sdk/<your-language>/` following the [Rust](/sdk/rust/), [Python](/sdk/python/), and [C++](/sdk/cpp/) section structures.

Once your SDK has shipped a 1.0 that passes the checklist on real agents, we'll happily link it as a first-class implementation.
