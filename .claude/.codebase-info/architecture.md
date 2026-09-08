# Architecture

*Last Updated: 2026-09-08*

Tesseron is an accessibility layer for AI agents. An app declares typed actions and resources; an
MCP gateway projects them to an agent as MCP tools. No browser automation, no scraping.

## The three moving parts

```
   your app                    the gateway                     the agent
┌──────────────┐            ┌─────────────────┐            ┌──────────────┐
│ @tesseron/   │            │ @tesseron/mcp   │            │ Claude, or   │
│ web│server│  │◄───────────┤ (tesseron-mcp)  │◄──────────►│ any MCP      │
│ react│vue│…  │  WS / UDS  │                 │   stdio    │ client       │
│              │  JSON-RPC  │ dials OUT to    │    MCP     │              │
│ LISTENS      │            │ the app         │            │              │
└──────────────┘            └─────────────────┘            └──────────────┘
       │                            │
       │ writes                     │ watches
       ▼                            ▼
   ~/.tesseron/instances/<id>.json  (discovery)
```

**The direction is the thing people get wrong.** The app binds and announces; the gateway is a
transport *client* that dials in. `gateway/src/gateway.ts:230` says so outright, and the
gateway has no port and no `start()`. What passes for "start" is `watchInstances()`
(`gateway/src/gateway.ts:471`), which watches `~/.tesseron/instances/` for manifests the app
dropped there.

Who does the listening depends on the consumer package:

| App side | Listener | Manifest written by |
|---|---|---|
| Browser in Vite dev | the Vite dev server, at `/@tesseron/ws` | `tesseron-typescript/vite/src/index.ts:239` |
| Node | `NodeWebSocketServerTransport` or `UnixSocketServerTransport` | `tesseron-typescript/server/src/transport.ts:79`, `uds-transport.ts:24` |
| Browser, non-Vite | dials a gateway URL instead (`@tesseron/web`) | n/a |

## One action invocation, end to end

1. Agent calls MCP tool `<app_id>__<action>` (or the meta tool `tesseron__invoke_action`).
2. `McpAgentBridge` splits on the first `__`, resolves the session via `latestClaimedByApp`
   (`gateway/src/mcp-bridge.ts:391`), which filters dead transports with `isClosed()` and
   picks the largest `claimedAt` (`:541`).
3. Gateway sends JSON-RPC `actions/invoke` `{name, input, invocationId}` over the dialed transport.
4. `TesseronClient.handleInvoke` (`tesseron-typescript/core/src/client.ts:546`) looks up the action, validates
   input through Standard Schema, arms an `AbortController` plus a timeout, and builds the
   `ActionContext`.
5. Your handler runs as `(input, ctx) => O`. It can call `ctx.progress`, `ctx.sample`,
   `ctx.confirm`, `ctx.elicit`, `ctx.log`, and must respect `ctx.signal`.
6. Result returns as `{invocationId, output}`. Errors become `TesseronError` codes and reach the
   agent as MCP `structuredContent` (`gateway/src/mcp-bridge.ts:911`).

Sampling and elicitation run the *other* way: `ctx.sample` becomes a `sampling/request` back to the
gateway, which calls `server.createMessage` on the MCP client (`mcp-bridge.ts:203`). Same for
`ctx.elicit` → `server.elicitInput` (`:228`).

A handler that ignores `ctx.signal` cannot pin the wire: `client.ts:697` races the handler against
an abort reaper (`:776`).

## Claiming: why an agent can't just connect

A session starts unclaimed. Two paths get it claimed:

- **Gateway-minted (legacy).** Gateway mints a claim code (`gateway.ts:1299`), the app shows it, the
  user reads it to the agent, the agent calls `tesseron__claim_session`. The lookup is a plain
  uppercased map lookup, not a timing-safe compare (`gateway.ts:780`).
- **Host-minted (tesseron#60).** The app mints the claim itself and sets `helloHandledByHost: true`
  in its manifest. The gateway does not auto-dial (`gateway.ts:540`); on claim it dials carrying the
  code as a `tesseron-bind.<code>` WS subprotocol or a `tesseron/bind` first frame
  (`gateway/src/dialer.ts:77`, `:247`). The constant-time compare happens **host-side**
  (`tesseron-typescript/server/src/transport.ts:174`, `tesseron-typescript/vite/src/index.ts:838`).

There is **no origin allowlist in `@tesseron/mcp`**. `handleConnection` takes an `origin` but only
records it (`gateway.ts:1177`), and the sole in-package caller passes `undefined` (`gateway.ts:444`).
Origin checking is a host-side concern, done during the WS upgrade.

## Sessions and resume

A closed transport does not destroy the session. It becomes a *zombie* with an evict timer
(`gateway.ts:1114`), default TTL 4 h (`gateway.ts:115`), capped at 100 with LRU eviction (`:122`,
`:1102`). `tesseron/resume` validates eight things in order and finishes with a `constantTimeEqual`
on the resume token (`gateway.ts:1451`), then **rotates the token** (`:1475`). Resume is one-shot.

See [protocol.md](protocol.md) for the wire detail, [gateway.md](gateway.md) for the gateway
internals, and [modules.md](modules.md) for what each package owns.
