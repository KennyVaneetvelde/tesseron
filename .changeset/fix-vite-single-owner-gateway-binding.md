---
'@tesseron/vite': patch
---

The Vite plugin's gateway-to-instance bridge now rejects a second gateway upgrade with `HTTP 409 Conflict` instead of silently overwriting `entry.gatewayWs`. When more than one Tesseron MCP gateway process was alive on the same machine (e.g. multiple Claude Code sessions), all of them poll `~/.tesseron/instances/` and race to upgrade the bridge for each instance. The previous last-writer-wins behaviour split the welcome+claim code from the live message routing across two processes, so the user-visible claim code became silently unclaimable. First-gateway-wins is now deterministic per process; race-losers see a 409 and their poll loop moves on. See tesseron#53 for the full diagnosis.

Also adds a `[tesseron-vite]` stderr log when a second-gateway upgrade is rejected, so the multi-gateway scenario is visible during dev.
