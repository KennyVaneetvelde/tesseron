# @tesseron/react

React hooks adapter for [Tesseron](../../README.md).

Thin wrapper around `@tesseron/web` that lets components register actions and resources with hooks (`useTesseronAction`, `useTesseronResource`) so they're cleaned up automatically when the component unmounts. Also exports `useTesseronConnection` for opening the MCP gateway WebSocket and tracking its state. Re-exports `@tesseron/web`.

Peer deps: `react >= 18`, `@standard-schema/spec ^1.0.0`.
