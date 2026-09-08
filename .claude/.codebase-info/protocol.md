# Protocol

*Last Updated: 2026-09-08*

Source of truth: `tesseron-typescript/core/src/protocol.ts`. `PROTOCOL_VERSION = '1.2.0'` (`:11`).

The envelope is plain **JSON-RPC 2.0**. `JSONRPC_VERSION = '2.0'` (`:13`); request `:17`,
notification `:24`, success `:30`, error `:36`, error payload `{code, message, data?}` `:44`.

## Requests

Authoritative map: `TesseronMethods` (`protocol.ts:308-318`).

| Method | Params | Result |
|---|---|---|
| `tesseron/hello` | `HelloParams` `:131` — `{protocolVersion, app, actions[], resources[], capabilities}` | `WelcomeResult` `:147` — `{sessionId, protocolVersion, capabilities, agent, claimCode?, resumeToken?}` |
| `tesseron/resume` | `ResumeParams` `:188` — HelloParams + `sessionId`, `resumeToken` | `ResumeResult = WelcomeResult` `:205` |
| `tesseron/bind` | `{code}` `:299` | `{ok: true}` `:304` |
| `sampling/request` | `{invocationId, prompt, schema?, maxTokens?}` `:252` | `{content}` `:259` |
| `elicitation/request` | `{invocationId, question, schema}` `:263` | `{action: 'accept'\|'decline'\|'cancel', value?}` `:269` |
| `actions/invoke` | `{name, input, invocationId, client?}` `:207` | `{invocationId, output}` `:221` |
| `resources/read` | `{name}` `:230` | `{value}` `:234` |
| `resources/subscribe` | `{name, subscriptionId}` `:238` | `undefined` |
| `resources/unsubscribe` | `{subscriptionId}` `:243` | `undefined` |

**There is no `tesseron/welcome` wire message.** "Welcome" is the *result type* of `tesseron/hello`
and `tesseron/resume`. If you are looking for it as a method, you will not find it.

## Notifications

`TesseronNotifications` (`protocol.ts:351-359`):

- `actions/progress` `{invocationId, message?, percent?, data?}` `:214` — percent must increase monotonically
- `actions/cancel` `{invocationId}` `:226`
- `actions/list_changed` `{actions}` / `resources/list_changed` `{resources}`
- `resources/updated` `{subscriptionId, value}` `:247`
- `tesseron/claimed` `{agent, claimedAt, agentCapabilities?}` `:327`
- `log` `{invocationId?, level, message, meta?}` `:281` — the literal is bare `log`, **not** `tesseron/log`

## Error codes

Codes live in `protocol.ts:60-78`, not in `errors.ts`:

| Code | Name | Code | Name |
|---|---|---|---|
| -32700 | ParseError | -32005 | HandlerError |
| -32600 | InvalidRequest | -32006 | SamplingNotAvailable |
| -32601 | MethodNotFound | -32007 | ElicitationNotAvailable |
| -32602 | InvalidParams | -32008 | SamplingDepthExceeded |
| -32603 | InternalError | -32009 | Unauthorized |
| -32000 | ProtocolMismatch | -32010 | TransportClosed |
| -32001 | Cancelled | -32011 | ResumeFailed |
| -32002 | Timeout | -32003 | ActionNotFound |
| -32004 | InputValidation | | |

Classes in `tesseron-typescript/core/src/errors.ts`: `TesseronError` base `:20`, `SamplingNotAvailableError`
`:51`, `ElicitationNotAvailableError` `:78`, `SamplingDepthExceededError` `:97`, `CancelledError`
`:109`, `TimeoutError` `:120`.

Two traps: **there is no `ResumeFailedError` class** (ResumeFailed is code-only, thrown as a bare
`TesseronError` at `gateway/src/gateway.ts:1386` and matched by code at
`tesseron-typescript/web/src/reactive-core.ts:369`), and **`TransportClosedError` lives in `transport.ts:50`**,
not `errors.ts`.

## Handshake and resume

Hello carries the full manifest. The gateway mints `sessionId`, `claimCode`, and `resumeToken`
(`gateway.ts:1298`) and returns them in the welcome. On the host-minted path, identity comes *from
the manifest* instead so both ledgers agree for a later resume (`gateway.ts:1195`).

On the app side (every SDK, pinned by `conformance/fixtures/handshake/*`): requests that arrive
before the welcome queue behind it; a welcome result the client cannot read (wrong shape, major
version mismatch) ends that connection and nothing queued runs; a hello answered with a JSON-RPC
error rejects `connect()` with the gateway's message while the listener and manifest stay up for the
next dial. An envelope without `jsonrpc: "2.0"` is answered with -32600 (id carried through, or
null); a request with `id: null` is a request, answered with `id: null`, only an absent `id` makes a
notification.

`tesseron/resume` validation order (`gateway.ts:1356-1518`): not already attached → shape →
protocol major/minor → app id → zombie exists → same app id (no cross-app hijack) → zombie was
actually claimed → `constantTimeEqual` on the token. Then it clears the evict timer, promotes to
live, and rotates the token. No new `claimCode` is issued on resume (`:1513`).

## Transport

`Transport` (`tesseron-typescript/core/src/transport.ts:21`): `send`, `onMessage`, `onClose`, `close`, optional
`isClosed?()`. The optional probe is what lets the gateway skip dead sessions (tesseron#92).

**`transport-spec.ts` is addressing, not a conformance suite** despite the name. It defines
`TransportSpec = {kind:'ws', url} | {kind:'uds', path}` (`:11`) and the on-disk `InstanceManifest`
(`:42`) written to `~/.tesseron/instances/<id>.json`, version 2. Core ships no third-party transport
test harness; the fixture corpus for ports lives at the repo root in `conformance/` and has no
runner yet.

`bind-subprotocol.ts` owns the `tesseron-bind.<code>` element. `formatBindSubprotocol` throws
`RangeError` on grammar violations (`:36`); `parseBindSubprotocol` rejects *multiple* bind elements
as a header-injection signal (`:65`). Grammar: `[A-Za-z0-9_-]{1,64}` (`:87`).

## App ids

`tesseron-typescript/core/src/app-id.ts` — `APP_ID_RE = /^[a-z][a-z0-9_]*$/` (`:11`), reserved:
`tesseron`, `mcp`, `system` (`:10`). `validateAppId` throws a plain `Error`, not a `TesseronError`,
and is **not called inside core**: hosts and the gateway apply it
(`tesseron-typescript/server/src/transport.ts:429`, `tesseron-typescript/vite/src/index.ts:666`,
`gateway/src/gateway.ts:1158`, `:1412`). The payoff is that the id becomes the MCP tool prefix,
`${app.id}__${action.name}` (`gateway/src/mcp-bridge.ts:828`).
