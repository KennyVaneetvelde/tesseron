---
'@tesseron/mcp': patch
'@tesseron/core': patch
'@tesseron/server': patch
'@tesseron/vite': patch
---

Cross-gateway claim-code disambiguation + stale-manifest tombstoning. Two layers, both addressing concerns left open in tesseron#53 after the single-owner binding fix landed in #54:

**Stale instance manifests are now skipped and tombstoned.** The SDK side (`@tesseron/server`'s WS and UDS transports, `@tesseron/vite`) now stamps `pid: process.pid` on every `~/.tesseron/instances/<id>.json` it writes. The MCP gateway probes `process.kill(pid, 0)` on each manifest before dialing. Manifests whose owning process is gone get unlinked instead of dialed, so a long-running gateway no longer pays a connection-refused round-trip every poll tick for browser tabs whose Vite server died without a clean shutdown. Older SDKs without `pid` are still trusted (no regression for in-flight upgrades). The `InstanceManifest` type in `@tesseron/core` gains an optional `pid?: number` field.

**Claim codes now carry a cross-gateway ownership breadcrumb.** When the gateway mints a claim code, it writes `~/.tesseron/claims/<CODE>.json` with `{ sessionId, appId, appName, gatewayPid, mintedAt }`. The breadcrumb is removed atomically when the owning gateway claims the session, when an unclaimed session closes, and when the gateway shuts down. When `tesseron__claim_session` is called on a gateway that doesn't own the code locally, it now reads the breadcrumb and surfaces a useful error: `"Claim code XYZ-12 belongs to a different Tesseron gateway (pid 12345, app \"My App\", minted 2026-04-26T15:16:09Z). Switch to the Claude session that opened this connection..."` instead of the previous opaque "No pending session found". If the breadcrumb's gatewayPid is dead, the error reports a stale claim and tombstones the file. This solves the "guess which Claude window owns this code" problem on multi-session developer machines without introducing a cross-process rendezvous protocol.

`TesseronGateway` exposes a new `describeForeignClaim(code)` method returning `{ kind: 'foreign' | 'stale' | 'unknown', ... }` for embedders that build their own claim UIs, and a new `isPidAlive(pid)` helper export.
