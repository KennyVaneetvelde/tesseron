---
'@tesseron/core': minor
---

Resource reads now have a default 30s wall-clock cap (`DEFAULT_RESOURCE_READ_TIMEOUT_MS`). A `.read()` handler that hangs - stuck promise, awaited state setter that never settles, slow IPC - rejects with a typed `TesseronError` of code `Timeout` instead of parking the gateway, the bridge, the MCP tool call, and the agent indefinitely. Synchronous and quick async reads are unaffected.

`TimeoutError` now accepts an optional `subject` argument so the message points at the actual operation (`Resource read "compositions" timed out after 30000ms.` rather than always saying "Action"). The single-arg form is preserved for backwards compatibility - existing call sites that throw `new TimeoutError(ms)` keep working unchanged.
