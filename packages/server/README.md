# @tesseron/server

Node SDK for [Tesseron](../../README.md).

Same builder API as `@tesseron/web`, but for backend services that want to expose actions to AI agents without involving a browser. Exports `ServerTesseronClient`, `NodeWebSocketTransport`, the default `tesseron` singleton, and `DEFAULT_GATEWAY_URL` (`ws://localhost:7475`); re-exports the `@tesseron/core` builder and context types. Uses [`ws`](https://www.npmjs.com/package/ws) under the hood.
