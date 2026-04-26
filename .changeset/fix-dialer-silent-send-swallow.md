---
'@tesseron/mcp': patch
---

Stop swallowing `transport.send` failures inside `WsDialer` and `UdsDialer`. Both dialer transports had a bare `catch {}` around `ws.send` / `socket.write` with the comment "socket likely closed; ignore". That defeated the cascade-on-send-failure fix in 2.2.1: the session-dispatcher wrapper in `gateway.ts` was supposed to close the channel when send threw, but the wrapper never saw a throw because the dialer ate it first. The user-visible symptom was `tesseron__read_resource` (and `tesseron__invoke_action`) hanging indefinitely after a Vite HMR cycle that left the gateway-side socket in a `CLOSING` / `CLOSED` state that silently no-op'd subsequent sends.

Both dialers now let `ws.send` / `socket.write` throws propagate to the dispatcher wrapper, which closes the channel, fires `transport.onClose`, and `rejectAllPending` rejects every outstanding request with `TransportClosedError`.
