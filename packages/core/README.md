# @tesseron/core

Protocol types and action builder for [Tesseron](../../README.md).

Transport-agnostic, validator-agnostic. Defines the JSON-RPC 2.0 wire protocol (version `1.0.0`) between the SDK and the MCP gateway, the action/resource builder API, the handler context (`ctx.confirm`, `ctx.elicit`, `ctx.sample`, `ctx.progress`, `ctx.log`), subscribable resources, and the typed error hierarchy (`SamplingNotAvailableError`, `ElicitationNotAvailableError`, `TimeoutError`, `CancelledError`, `TesseronError`).

Zero runtime dependencies beyond [`@standard-schema/spec`](https://standardschema.dev) (types-only).
