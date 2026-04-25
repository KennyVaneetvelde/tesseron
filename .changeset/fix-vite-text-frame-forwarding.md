---
'@tesseron/vite': patch
---

Fix `@tesseron/vite` forwarding text frames as binary frames so the browser
SDK silently dropped every gateway message and the connection hung at
`status: 'connecting'`.

The `ws` library hands handlers a `Buffer` for both text and binary frames
and `Buffer` arguments to `send()` are forwarded as binary, which the
browser receives as a `Blob`. `BrowserWebSocketTransport` in `@tesseron/web`
only handles `string` frames, so the `tesseron/welcome`, action results,
progress, and every other gateway message were discarded.

The bridge now reads the `isBinary` flag both directions, decodes text
frames back to UTF-8 strings before re-emitting them, and queues frames in
their original form so re-`send()` after the gateway connects produces the
correct frame type.

Fixes #27.
