<div align="center">
  <a href="https://github.com/eigenwise/tesseron">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-dark.png">
      <img src="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="380">
    </picture>
  </a>
</div>

# @tesseron/core

Protocol types and action builder for [Tesseron](https://github.com/eigenwise/tesseron) — a protocol + TypeScript SDK + MCP gateway that exposes the typed actions a live app already has to MCP-compatible AI agents (Claude Code, Claude Desktop, Cursor, Copilot, Codex, ...) over a local WebSocket.

> **Most users don't install `@tesseron/core` directly.** Reach for one of the framework-targeted packages instead:
>
> | Package | Use when |
> |---|---|
> | [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web) | You're in a browser app (any framework) |
> | [`@tesseron/server`](https://www.npmjs.com/package/@tesseron/server) | You're in Node (CLI, daemon, Express, Fastify, ...) |
> | [`@tesseron/react`](https://www.npmjs.com/package/@tesseron/react) | You want hook-based React integration |
>
> Install `@tesseron/core` directly only if you're **building a custom transport**, a third-party framework adapter, or a **compatible Tesseron SDK in another language** — the protocol spec is [CC BY 4.0](https://github.com/eigenwise/tesseron/blob/main/docs/src/content/docs/protocol/LICENSE), reimplementations are explicitly encouraged.

## What's inside

- **Protocol types** — JSON-RPC 2.0 wire shapes (`HelloParams`, `WelcomeResult`, `ActionInvokeParams`, etc.), method and notification names, `TesseronCapabilities`, the discriminated `TransportSpec` + `InstanceManifest` types for the multi-binding discovery format, and the versioned `PROTOCOL_VERSION` constant (currently `1.1.0`).
- **Action builder** — the fluent, typed `.action(name).input(schema).handler(fn)` API that the framework packages wrap.
- **Resource builder** — subscribable or read-only resources with the same fluent ergonomics.
- **Handler context** — `ActionContext` with `ctx.confirm`, `ctx.elicit`, `ctx.sample`, `ctx.progress`, `ctx.log`, cancellation via `ctx.signal`, and the negotiated `ctx.agentCapabilities`.
- **Typed error hierarchy** — `TesseronError` + `SamplingNotAvailableError`, `ElicitationNotAvailableError`, `SamplingDepthExceededError`, `TimeoutError`, `CancelledError`, `TransportClosedError`, all with MCP-mapped error codes in `TesseronErrorCode`.
- **`Transport` interface** — the four-method contract a custom transport must implement.

## Install

```bash
npm install @tesseron/core
```

Zero runtime dependencies beyond [`@standard-schema/spec`](https://standardschema.dev) (types only).

## Example — custom transport

```ts
import { TesseronClient, type Transport } from '@tesseron/core';
import { z } from 'zod';

class InMemoryTransport implements Transport {
  send(message: unknown) { /* ... */ }
  onMessage(handler: (m: unknown) => void) { /* ... */ }
  onClose(handler: (reason?: string) => void) { /* ... */ }
  close(reason?: string) { /* ... */ }
}

const client = new TesseronClient();
client.app({ id: 'shop', name: 'Shop' });

client
  .action('addItem')
  .input(z.object({ sku: z.string() }))
  .handler(({ sku }, ctx) => {
    ctx.log({ level: 'info', message: `adding ${sku}` });
    return { ok: true };
  });

await client.connect(new InMemoryTransport());
```

For the real browser and Node transports, see [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web) and [`@tesseron/server`](https://www.npmjs.com/package/@tesseron/server).

## Docs

| | |
|---|---|
| Main repo | <https://github.com/eigenwise/tesseron> |
| SDK reference | <https://eigenwise.github.io/tesseron/sdk/typescript/core/> |
| Protocol spec | <https://eigenwise.github.io/tesseron/protocol/> |
| Examples | <https://github.com/eigenwise/tesseron/tree/main/examples> |

## License

Reference implementation — [Business Source License 1.1](https://github.com/eigenwise/tesseron/blob/main/LICENSE) (source-available). Each release auto-converts to Apache-2.0 four years after publication. Protocol specification — [CC BY 4.0](https://github.com/eigenwise/tesseron/blob/main/docs/src/content/docs/protocol/LICENSE).

<p align="center">Built and maintained by <a href="https://eigenwise.io/"><b>Eigenwise</b></a>.</p>
