---
'@tesseron/core': minor
'@tesseron/mcp': minor
'@tesseron/react': minor
---

Add `tesseron/claimed` notification (gateway → SDK) so apps can clear the spent claim code from their UI once an agent has redeemed it.

Previously, `useTesseronConnection`'s `claimCode` field reflected whatever was in the welcome forever - the SDK had no way to learn that the code had been consumed. Apps rendering a "Connect Claude" banner would keep showing a dead string, and users would keep trying to type it at the agent (which would correctly reject it as "already claimed", but only after a confusing round-trip).

The gateway now emits a `tesseron/claimed` notification carrying `{ agent, claimedAt }` when `tesseron__claim_session` succeeds. The SDK patches the cached `WelcomeResult` in place (clearing `claimCode`, updating `agent`) and fires any listener registered via the new `client.onWelcomeChange(...)` API. `@tesseron/react`'s `useTesseronConnection` propagates the change so `connection.claimCode` becomes `undefined` and `connection.welcome.agent` reflects the claiming agent's identity.

Resolves concern (5) from tesseron#53. No protocol-version bump - this is a new optional notification that older SDKs simply ignore.
