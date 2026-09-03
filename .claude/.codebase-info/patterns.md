# Patterns

*Last Updated: 2026-09-03*

## Reconnection is the recurring problem

A surprising amount of this codebase exists because browsers refresh, HMR fires, and React
StrictMode double-invokes. The guards are load-bearing and each traces to an issue:

| Issue | Guard | Where |
|---|---|---|
| tesseron#88 | `connectVersion` counter, sync supersede-close, await prior chain, bail if superseded | `sdks/typescript/core/src/client.ts:273-342` |
| tesseron#88 | URL-form connect de-duplication via `inFlightUrlConnect` | `sdks/typescript/web/src/index.ts:97` |
| tesseron#92 | `isClosed()` liveness probe, so dead sessions lose the tiebreak | `gateway/src/mcp-bridge.ts:541` |
| tesseron#60 | host-minted claims, gateway does not auto-dial | `gateway/src/gateway.ts:540` |
| tesseron#69 | pending-claim recovery across gateway restarts | `~/.tesseron/claims/` breadcrumbs |

The Vite plugin's `Session` (`sdks/typescript/vite/src/index.ts:85`) is deliberately decoupled from the
browser socket for the same reason: a refresh detaches and re-attaches without the gateway ever
seeing a disconnect.

Before you "simplify" any of this, read the referenced test.

## Extract shared logic to one home, adapt thinly

`sdks/typescript/web/src/reactive-core.ts` exists because react, svelte, and vue had drifted byte-for-byte
copies (`:1-19`). The adapters are now ~120 lines each and hold only lifecycle binding. **Any new
behavior belongs in `reactive-core.ts`, not in three places.** A fourth adapter should be about 120
lines too; if it isn't, something leaked.

## Two-tier export surface

Public (`index.ts`) versus un-versioned sibling surface (`internal.ts`). Things sibling packages need
but users should not touch go through `@tesseron/core/internal`: the dispatcher, builder impls,
schema helpers, `constantTimeEqual`, the bind-subprotocol trio, `validateAppId`. Node-only code gets
a third entry (`node.ts`) purely to keep the main entry browser-safe.

## Cancellation and timeouts are enforced, not requested

`handleInvoke` arms an `AbortController` plus a timeout, then races the handler against an abort
reaper (`sdks/typescript/core/src/client.ts:697`, reaper at `:776`) so a handler that ignores `ctx.signal`
cannot pin the wire. Aborted state maps to `TimeoutError` or `CancelledError` (`:716`); `finally`
always clears the timer and the invocation entry (`:721`).

Default action timeout is 60 s (`builder-impl.ts:34`). `ctx.withTimeout` races an inner promise
against both a local deadline and `ctx.signal` (`client.ts:797`).

## Errors carry structure across three protocols

`TesseronError` holds `{code, data}`. The dispatcher converts a throw to a JSON-RPC error payload
preserving both (`dispatcher.ts:204`) and rehydrates on the way back (`:171`). The MCP bridge
projects that into `structuredContent` (`mcp-bridge.ts:911`). MCP `MethodNotFound` coming back from
the agent is translated into `SamplingNotAvailableError` / `ElicitationNotAvailableError`
(`:221`, `:245`). Keep the chain intact: throw `TesseronError` with a real code, not a bare `Error`.

## Security posture

- CSPRNG only. Two tests scan source for `Math.random` and fail on it.
- Constant-time compare for the resume token (`gateway.ts:1451`) and host-side bind codes
  (`sdks/typescript/server/src/transport.ts:174`). The legacy claim-code lookup is **not** timing-safe
  (`gateway.ts:780`) — a known asymmetry.
- Claim codes use a 31-char confusable-free alphabet, `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  (`node/claim-mint.ts:17`).
- Files under `~/.tesseron/` are written atomically: temp with `O_EXCL` at `0o600`, then rename
  (`node/fs-hygiene.ts:96`), in a `0o700` dir. Windows `EPERM` on chmod is suppressed, not fatal
  (`:54`).
- Bind subprotocol parsing rejects multiple bind elements as header injection
  (`bind-subprotocol.ts:65`).
- Resume tokens rotate on use. One-shot.

## Validation happens at the boundary

`standardValidate` on action input, always (`client.ts:553`), producing `InputValidation` with the
raw issues. Output validation is opt-in via `.strictOutput()`. Elicit schemas are checked against
MCP's constraints before sending (`assertValidElicitSchema`, `client.ts:659`).

## Configuration by environment, not flags

The gateway reads env vars and has no argv parsing at all. Follow that if you add knobs there.
