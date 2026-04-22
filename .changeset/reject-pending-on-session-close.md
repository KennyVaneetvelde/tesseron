---
"@tesseron/mcp": patch
---

Fix hang on session WebSocket disconnect: the gateway now rejects all pending
dispatcher requests (`actions/invoke`, `resources/read`, `resources/subscribe`,
`resources/unsubscribe`) with a `TransportClosedError` when a session's socket
closes, mirroring the SDK-side behaviour. Previously, in-flight requests
abandoned by a disappearing SDK would hang until the MCP client's own timeout
kicked in.
