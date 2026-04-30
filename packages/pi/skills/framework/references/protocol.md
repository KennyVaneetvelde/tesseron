# Protocol (JSON-RPC 2.0 wire format)

## Contents
- Protocol version
- Envelope
- Handshake: `tesseron/hello` and `tesseron/resume`
- Action methods: `actions/invoke`, `actions/cancel`
- Notifications: `actions/progress`, `log`
- Sampling and elicitation: `sampling/request`, `elicitation/request`
- Resource methods: `resources/read`, `resources/subscribe`, `resources/updated`, `resources/unsubscribe`
- Manifest changes: `actions/list_changed`, `resources/list_changed`
- Error envelopes

Most developers do not read this file — the SDK hides the protocol. Open it when debugging over the wire, writing a custom SDK in another language, or implementing a custom gateway.

## Protocol version

```ts
PROTOCOL_VERSION = '1.0.0';
JSONRPC_VERSION  = '2.0';
```

Every message is a JSON-RPC 2.0 envelope. The SDK and gateway both send and receive; methods are prefixed (`tesseron/*`, `actions/*`, `resources/*`, `sampling/*`, `elicitation/*`, `log`) to keep the surface clean.

## Envelope

```jsonc
// Request (has "id", expects a reply)
{ "jsonrpc": "2.0", "id": 1, "method": "tesseron/hello", "params": {...} }

// Response (success)
{ "jsonrpc": "2.0", "id": 1, "result": {...} }

// Response (error)
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32004, "message": "Invalid input", "data": [...] } }

// Notification (no "id", no reply)
{ "jsonrpc": "2.0", "method": "actions/progress", "params": {...} }
```

## Handshake

### `tesseron/hello` (SDK → Gateway)

Sent once after the transport opens. Announces the app, its actions, its resources, and the SDK's capabilities.

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tesseron/hello",
  "params": {
    "protocolVersion": "1.0.0",
    "app": {
      "id": "todos",
      "name": "Todo App",
      "description": "A todo app driven by Claude.",
      "origin": "http://localhost:5173",
      "iconUrl": "https://example.com/icon.png",
      "version": "1.2.0"
    },
    "actions": [
      {
        "name": "addTodo",
        "description": "Add a new todo item.",
        "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
        "outputSchema": { "type": "object", "properties": { "id": { "type": "string" } } },
        "annotations": { "readOnly": false, "destructive": false },
        "timeoutMs": 60000
      }
    ],
    "resources": [
      { "name": "stats", "description": "Todo stats", "outputSchema": {...}, "subscribable": true }
    ],
    "capabilities": { "streaming": true, "subscriptions": true, "sampling": true, "elicitation": true }
  }
}
```

Response:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess_abc123",
    "protocolVersion": "1.0.0",
    "capabilities": {
      "streaming": true, "subscriptions": true, "sampling": true, "elicitation": true
    },
    "agent": { "id": "claude-ai", "name": "Claude" },
    "claimCode": "ABCD-EF",
    "resumeToken": "token_xyz789"
  }
}
```

`claimCode` is the 6-character pairing code the user pastes into the agent (`claim session ABCD-EF`). It is one-shot — don't persist it.

`resumeToken` should be persisted alongside `sessionId` for later resume.

### `tesseron/resume` (SDK → Gateway)

Sent in place of `tesseron/hello` when reconnecting with credentials. Payload is the same as `hello`, plus the stored credentials:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tesseron/resume",
  "params": {
    "sessionId": "sess_abc123",
    "resumeToken": "token_xyz789",
    "protocolVersion": "1.0.0",
    "app": {...},
    "actions": [...],
    "resources": [...],
    "capabilities": {...}
  }
}
```

On success, the response mirrors the `hello` result, with a **freshly rotated** `resumeToken` — persist the new one. On failure (expired session, token mismatch), the response is an error with code `-32011` (`ResumeFailed`). On failure, fall back to a fresh `tesseron/hello` without resume credentials.

Zombie sessions — closed-but-not-yet-cleaned-up sessions retained so reconnecting SDKs can rejoin — are held for `resumeTtlMs` milliseconds (gateway default: 90s).

## Action methods

### `actions/invoke` (Gateway → SDK)

The agent calls a tool; the gateway forwards to the SDK:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "actions/invoke",
  "params": {
    "name": "addTodo",
    "input": { "text": "Buy milk" },
    "invocationId": "inv_12345",
    "client": { "route": "/todos", "origin": "http://localhost:5173" }
  }
}
```

Response (success):

```jsonc
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": {
    "invocationId": "inv_12345",
    "output": { "id": "t1", "text": "Buy milk", "done": false }
  }
}
```

Response (error, e.g. input validation failure): see **Error envelopes** below.

### `actions/cancel` (Gateway → SDK, notification)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "actions/cancel",
  "params": { "invocationId": "inv_12345" }
}
```

Fires `ctx.signal` in the handler. The SDK also responds to the original invocation with a `-32001` (`Cancelled`) error once the handler completes (or is aborted).

## Notifications

### `actions/progress` (SDK → Gateway)

Emitted by `ctx.progress(...)`:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "actions/progress",
  "params": {
    "invocationId": "inv_12345",
    "message": "Processing...",
    "percent": 50,
    "data": { "itemsProcessed": 5 }
  }
}
```

### `log` (SDK → Gateway)

Emitted by `ctx.log(...)`:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "log",
  "params": {
    "invocationId": "inv_12345",
    "level": "info",
    "message": "Todo added",
    "meta": { "count": 3 }
  }
}
```

## Sampling and elicitation

### `sampling/request` (SDK → Gateway)

Emitted by `ctx.sample(...)`:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "sampling/request",
  "params": {
    "invocationId": "inv_12345",
    "prompt": "Suggest a title for this article.",
    "schema": { "type": "object", "properties": {...} },
    "maxTokens": 1024
  }
}
```

Response:

```jsonc
{ "jsonrpc": "2.0", "id": 20, "result": { "content": "..." } }
```

Error `-32006` (`SamplingNotAvailable`) when the MCP client does not advertise sampling capability.

### `elicitation/request` (SDK → Gateway)

Emitted by `ctx.elicit(...)` or `ctx.confirm(...)`:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "elicitation/request",
  "params": {
    "invocationId": "inv_12345",
    "question": "Which tag?",
    "schema": { "type": "object", "properties": { "tag": { "type": "string" } }, "required": ["tag"] }
  }
}
```

Response:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 21,
  "result": { "action": "accept", "value": { "tag": "work" } }
}
```

`action` is `"accept"` | `"decline"` | `"cancel"`. `ctx.confirm` collapses any non-accept to `false`. `ctx.elicit` returns `null` on decline/cancel.

Error `-32007` (`ElicitationNotAvailable`) when the client does not advertise elicitation.

## Resource methods

### `resources/read` (Gateway → SDK)

```jsonc
{ "jsonrpc": "2.0", "id": 30, "method": "resources/read", "params": { "name": "stats" } }
```

Response:

```jsonc
{ "jsonrpc": "2.0", "id": 30, "result": { "value": { "total": 3, "completed": 1, "pending": 2 } } }
```

### `resources/subscribe` (Gateway → SDK)

```jsonc
{
  "jsonrpc": "2.0",
  "id": 31,
  "method": "resources/subscribe",
  "params": { "name": "stats", "subscriptionId": "sub_789" }
}
```

Response is empty. The SDK starts emitting updates.

### `resources/updated` (SDK → Gateway, notification)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "resources/updated",
  "params": { "subscriptionId": "sub_789", "value": {...} }
}
```

### `resources/unsubscribe` (Gateway → SDK)

```jsonc
{
  "jsonrpc": "2.0",
  "id": 32,
  "method": "resources/unsubscribe",
  "params": { "subscriptionId": "sub_789" }
}
```

Triggers the subscriber's cleanup function.

## Manifest change notifications

When actions or resources are added or removed at runtime, the SDK notifies the gateway:

### `actions/list_changed`

```jsonc
{
  "jsonrpc": "2.0",
  "method": "actions/list_changed",
  "params": { "actions": [ /* ActionManifestEntry[] */ ] }
}
```

### `resources/list_changed`

```jsonc
{
  "jsonrpc": "2.0",
  "method": "resources/list_changed",
  "params": { "resources": [ /* ResourceManifestEntry[] */ ] }
}
```

The gateway re-announces to the agent via MCP's `notifications/tools/list_changed` / `notifications/resources/list_changed`. Agents that honor these (Claude) pick up the changes live; agents that freeze their tool list at startup do not.

## Error envelopes

Every error is a JSON-RPC error response:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 10,
  "error": {
    "code": -32004,
    "message": "Invalid input",
    "data": [
      { "path": ["text"], "message": "String must contain at least 1 character" }
    ]
  }
}
```

See `errors.md` for the full code table and subclass mapping.

## Non-misuses worth remembering

- **`tesseron/hello` after `tesseron/resume` succeeds** — if resume succeeds, do NOT re-send `tesseron/hello`. The session is already in a stateful resumed state.
- **`resources/list_changed` with the same entries as before** — emitting the notification with identical entries is a no-op; harmless, not a bug.
- **Mixing request and notification shapes** — a request without `id` is a notification (no response), a response never has `method`. The SDK rejects malformed envelopes; don't hand-roll them unless you're writing a custom transport.
