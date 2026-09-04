# Modules

*Last Updated: 2026-09-04*

Nine published packages, all at **2.10.1**. Eight are in one changesets `fixed` group;
`@tesseron/docs-mcp` releases on its own. See [release-and-plugin.md](release-and-plugin.md).

Every package points `types` at `./src/index.ts` for workspace resolution and swaps to
`./dist/index.d.ts` via `publishConfig` on publish (e.g. `sdks/typescript/web/package.json:34` vs `:62`).
All build with tsup, ESM+CJS.

## `@tesseron/core` — the whole protocol

19 `.ts` files under `src/` (16 top-level, 3 in `node/`), 8 test files. Only runtime dependency:
`@standard-schema/spec`.

**Five entry points** (`package.json:34-60`, built at `tsup.config.ts:4-10`): `.`, `./protocol`,
`./errors`, `./internal`, `./node`.

| File | Owns |
|---|---|
| `protocol.ts` | wire format, methods, notifications, error codes |
| `builder.ts` / `builder-impl.ts` | types / runtime for the action + resource builders |
| `context.ts` | `ActionContext` |
| `dispatcher.ts` | `JsonRpcDispatcher`, transport-agnostic |
| `client.ts` | `TesseronClient`, the invoke path, connect re-entry guards |
| `transport.ts`, `transport-spec.ts`, `bind-subprotocol.ts` | transport interface, addressing, bind subprotocol |
| `errors.ts` | error classes |
| `schema-helpers.ts` | Standard Schema validation + JSON Schema derivation |
| `app-id.ts`, `timing-safe.ts` | namespacing, constant-time compare |
| `node/*` | claim minting, host bind gating, private-file hygiene |

`index.ts` deliberately does **not** export `dispatcher`, `builder-impl`, `schema-helpers`,
`timing-safe`, `bind-subprotocol`, or `app-id`. Those go out through `/internal` (`internal.ts:10`),
the un-versioned sibling-package surface. `node.ts` is separate because it imports `node:fs` and
`node:buffer` and would break browser builds (`node.ts:7`).

### Builders

`ActionBuilder` (`builder.ts:31`): `describe`, `input`, `output`, `annotate`, `timeout`,
`strictOutput`, `handler`. **No ordering constraint** — everything except `handler` returns the
builder, and `handler()` is the terminal call that registers (`builder-impl.ts:78`). Defaults:
description `''`, timeout `60_000` ms, `strictOutput` false (`builder-impl.ts:15`, `:34`).

`ResourceBuilder` (`builder.ts:97`) behaves differently and it bites: **`read()` and `subscribe()`
each commit** (`builder-impl.ts:121-131`), so chaining both registers the resource twice. Documented
at `builder.ts:92`. `ResourceSubscriber` must return a cleanup function (`builder.ts:88`).

### ActionContext (`context.ts:81`)

`signal` `:83`, `agentCapabilities` `:85`, `agent` `:87`, `client` `:89`, and methods `progress`
`:91`, `sample` `:97`, `confirm` `:103`, `elicit` `:110`, `log` `:112`, `withTimeout` `:132`.

`confirm` returns **`true` only on explicit accept** — decline, cancel, and no-capability all give
`false` (`client.ts:634`). `elicit` returns `null` on decline/cancel but **throws**
`ElicitationNotAvailableError` when unsupported (`client.ts:652`). There is no `ctx.invocationId`.

### Schema integration

`standardValidate` (`schema-helpers.ts:17`) is the only validation entry point. `deriveJsonSchema`
(`:61`) duck-types an exporter and never throws: **Zod 4** via `toJSONSchema()`, **ArkType** via
`toJsonSchema()`, **TypeBox** by vendor detection. **Zod ≤3, Valibot, and Effect Schema have no
auto-derivation path** (`:56`) — those callers must pass the JSON Schema as the second argument to
`.input()` / `.output()`.

## `@tesseron/web` — the browser SDK and the shared reactive core

3 src files. `index.ts` re-exports all of core plus `reactive-core.js` wholesale.

`reactive-core.ts` (453 lines) is the real payload and the reason the three framework adapters are
each about 120 lines. It holds resume storage, `registerAction` `:162`, `registerResource` `:188`,
`TesseronConnectionState` `:258`, and `createConnectionController` `:321`. Its header (`:1-19`) says
it was extracted because the adapters had drifted byte-for-byte copies.

Package-specific: `DEFAULT_GATEWAY_URL` derived from `location.origin` (`index.ts:31`), a connect
overload taking a URL string, resume auto-persistence to `localStorage` (`:252`), URL-form connect
de-duplication for StrictMode/HMR (tesseron#88, `:97`), and a ResumeFailed → fresh-hello fallback
(`:206`).

## `@tesseron/server` — Node, and it listens

3 src files. Inverted from `web`: `connect()` creates a host transport, `ready()`s it, and hands it
to core (`index.ts:52`); the gateway dials in. Announces itself by writing
`~/.tesseron/instances/<id>.json`.

Two transports: loopback WS (`node:http` + `ws`, `transport.ts:142`) or Unix domain socket
(`node:net` under `mkdtemp`, `uds-transport.ts:112`), selected with `{transport: 'uds'}`. Uses
`constantTimeEqual`, `parseBindSubprotocol`, and `validateAppId` from `@tesseron/core/internal`
(`transport.ts:8`). Builds for `node20`. No resume auto-persistence.

## The three framework adapters

All thin, all the same three concepts, differing only in lifecycle binding:

| | react (115 lines) | svelte (118) | vue (128) |
|---|---|---|---|
| register action | `useTesseronAction` `:43` | `tesseronAction` `:41` | `tesseronAction` `:41` |
| register resource | `useTesseronResource` `:66` | `tesseronResource` `:64` | `tesseronResource` `:65` |
| connection | `useTesseronConnection` `:87` | `tesseronConnection` `:101` | `tesseronConnection` `:105` |
| teardown | effect cleanup | `onDestroy` | `onUnmounted` |
| returns | `TesseronConnectionState` | `Readable<…>` | `Ref<…>` |
| peer | `react >=18` | `svelte >=4.0.0` | `vue >=3.0.0` |

**`useTesseronAction` and `useTesseronResource` return `void`.** They are registration
side-effects, not data hooks. Only the connection hook returns state.

React's one genuine extra is holding options in a `useRef` so a fresh handler closure each render is
picked up without re-registering (`:48`); Svelte and Vue capture the options in a closure instead
and rely on reads being current at invocation time (`svelte/src/index.ts:22`).

Two range mismatches worth knowing: the Svelte peer admits 4.x but only 5 is installed and the docs
assume runes; the React peer admits 19 but devDeps pin 18 and nothing in CI tests 19.

## `@tesseron/vite` — dev-server only

1 src file, 959 lines, the largest of the consumer packages. It implements exactly **one** hook,
`configureServer` (`index.ts:487`). No `transform`, no `buildStart`. It contributes nothing to a
production `vite build`.

At dev time it hijacks the HTTP `upgrade` event (`:500`), serves browser tabs at `/@tesseron/ws` and
the gateway at `/@tesseron/ws/:instanceId` with the `tesseron-gateway` subprotocol (`:144`), writes
and heartbeats per-tab instance manifests (`:239`, `:754`), and mints host claim codes on a
10-minute sliding TTL (`:55`). Its `Session` abstraction (`:85`) is decoupled from the browser
socket so a refresh or HMR detaches and re-attaches without the gateway seeing a disconnect.

It is also the odd one out structurally: no `exports` field in package.json, does not re-export
core, and its `tsconfig.json` is the only one that **does not extend `tsconfig.base.json`**.

## `@tesseron/mcp` and `@tesseron/docs-mcp`

See [gateway.md](gateway.md). `gateway/src/index.ts` re-exports all of core plus the gateway,
bridge, and session types, so it is a superset of core's public surface.

## `@tesseron/conformance` and the reference host

`conformance/runner/` is the language-neutral suite runner (`ws` only, no core dependency; see
[testing.md](testing.md)). `sdks/typescript/conformance-host/` is a private package that stands up
`@tesseron/server` with the canned actions and resources a fixture asks for; it exists so the
corpus is proven runnable before any port vendors it.

## `tesseron` (Rust, `sdks/rust/`)

The application half of the protocol in Rust, written from the spec pages with the TypeScript core
as reference only where the spec is silent. `Tesseron::builder().application(..).action(..)
.listen().await` binds a loopback WebSocket on port 0, writes the v2 instance manifest (`0600` in a
`0700` dir, advisory on Windows), and the gateway dials in; `HostEvent::Welcome` carries the
gateway-minted claim code. `error.rs` holds all 17 protocol codes as one enum. `Action::typed` inputs must derive an
object-root schema (a struct, an empty one for no-input actions); scalars, enums, and `Vec<T>` are
refused at `listen()` with `HostError::InvalidTypedActionInputSchema`. Output schemas are opt-in
(`.output_schema_from_type::<T>()` or `.output_schema(Value)`). `README.md` is the crate doc via
`include_str!`, so its code blocks run as doctests. Covers handshake,
claiming, resume with in-memory token rotation, invoke with validation and cancel, `ActionContext`
with `progress` (percent clamped to 0..=100 and never below the ceiling already sent), `confirm`,
`elicit`/`elicit_as` (schema rejection matrix in `elicit_schema.rs`, checked before the wire),
`sample`/`sample_as`, `log`, and resources with subscribe/unsubscribe and `resources/updated`
pushes. Only host-minted claims are missing, by design. A per-connection handshake gate in
`session.rs` holds invocations and claims that arrive before the welcome is applied.
`conformance-host/` is the fixture adapter the runner drives. `examples/todo` and `examples/prompts` are
the canonical example pair (same action names and schemas as the TypeScript `vanilla-todo` and
`node-prompts`, minus the UI-only `setFilter`); `examples/validate-e2e.mjs` proves them through the
real gateway. `examples/tauri-todo` is the desktop variant: `examples/todo/src/lib.rs` holds the store,
the action registrations, and the `todos://all` resource, and both binaries import it, so the schemas
cannot drift. The Tauri app holds the host in `tauri::State` and emits a Tauri event from the action
handlers so the window re-renders after an agent mutation.

## `tesseron` (Python, `sdks/python/`)

The same application half in asyncio Python. `TesseronApp(id, name)` with `@app.action(name)`
decorators that read the input type from the handler annotation (a Pydantic model; the
validation-mode JSON Schema is published unchanged, no adapter, or pass `input_schema=` raw),
`app.resource(name, read=...)` for reads and subscriptions, `await app.listen()` returning a
`TesseronHost` bound on loopback port 0 with the v2 manifest written, and an `ActionContext` with the same progress, confirm, elicit, sample, and log surface as
Rust. `jsonrpc.py` classifies frames, `session.py` runs the handshake gate and dispatch, `errors.py`
carries the 17 codes. `conformance_host/` sits beside `src/tesseron`, drives the fixture DSL, and
stays out of the wheel. `examples/todo` and `examples/prompts` are the canonical pair with the same
action names and schemas as the Rust and TypeScript examples; `examples/validate-e2e.mjs` proves them
through the real gateway. Docs live at `docs/src/content/docs/sdk/python/`.

## Not packages

`packages/` and `examples/` no longer exist in git. If they are on disk they are untracked
`.turbo/` and `node_modules/` leftovers from before the 2026-09-03 move to `sdks/typescript/`,
`gateway/`, and `docs-mcp/`. Delete them.
