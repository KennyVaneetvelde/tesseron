# Tesseron — Requirements (PRD)

> **Project:** Tesseron
> **Repo:** `bridge-sdk` (rename pending — see §10)
> **Version:** 0.2 — Decisions folded in
> **Last updated:** 2026-04-18
> **Author:** Kenny Vaneetvelde (with Claude)
> **Status:** Draft for review

---

## 1. Overview

Tesseron is a TypeScript SDK + matching MCP gateway that lets a web application expose **typed, predefined actions** to MCP-compatible AI agents (Claude Code, Claude Desktop, etc.) over **WebSockets** — without browser automation.

A web app developer declares actions with a Zod-style builder; an end user runs the Tesseron MCP gateway locally and points their agent at it. When the user opens the web app, the Tesseron SDK in the page (or backend) connects to the local gateway over WebSocket and registers its actions. The MCP gateway then dynamically exposes those actions as MCP tools to the agent (using `notifications/tools/list_changed`).

### 1.1 Why now

- The MCP spec is stable; Claude Code and most major clients support `list_changed`, dynamic tools, progress, and resource subscriptions.
- The browser-automation pattern (Playwright, chrome-devtools-mcp) is fragile, slow, expensive in tokens, and forces agents to reverse-engineer the UI on every run. Web apps already know what they can do — let them say so directly.
- No mature framework occupies this slot for *external* agents. CopilotKit's AG-UI protocol is the closest analogue but targets *in-app* copilots, not external MCP clients.

### 1.2 Atomic philosophy

This SDK follows the same design ethos as Atomic Agents and Atomic Forge:

- **Minimal core, dependency-light** (only `zod` as a hard runtime dep)
- **Composable Lego blocks** — every capability is its own opt-in package
- **Lightweight runtime, full TypeScript inference**
- **No magic, no framework lock-in** — developers wire it up themselves

---

## 2. Vision & Non-Goals

### 2.1 In scope (v1)

- Core protocol: typed actions over WebSocket between web app and a local MCP gateway
- SDK in two flavors sharing one core: **browser** (`@tesseron/web`) and **server-side Node** (`@tesseron/server`)
- Framework adapters as thin wrappers (React first; others later)
- An MCP gateway CLI (`@tesseron/mcp`) installable via `npx`
- Multiple connection/addressing methods (click-to-connect handshake primary; pre-config and origin-routing as alternatives)
- Multi-app coexistence with prefixed tool names

### 2.2 Explicit non-goals (v1)

We are **not**:
- Running any hosted relay, cloud, or SaaS infrastructure
- Providing authentication, session management, abuse protection, rate limiting, or user identity. Those are app-level concerns and intentionally out of frame.
- Shipping inline UI widgets or generative components (MCP UI / Apps SDK pattern). Possible v2.
- Implementing browser automation, DOM scraping, or screenshot diffing
- Building a debugger, inspector, or observability stack (separate tool)
- Targeting non-TypeScript ecosystems in v1 (Python/Go/Rust ports are protocol-conformant exercises later)

---

## 3. Success Criteria

The v1 release is successful when:

- [ ] A developer can add `@tesseron/web` to a React app, declare 3 actions in <20 lines of code, and have Claude Code call them within 5 minutes of `npx @tesseron/mcp`.
- [ ] The same actions can be declared in a NestJS / Express backend with `@tesseron/server` using the same builder API.
- [ ] An action with `ctx.progress()` streams updates that show up live in Claude.
- [ ] Claude can subscribe to a resource (e.g., `currentRoute`) and receive update notifications when the web app pushes them.
- [ ] An action handler can call `ctx.sample({ prompt: '…' })` and get back a Claude completion (bidirectional sampling).
- [ ] An action handler can call `ctx.elicit({ question: '…' })` and pause until the user responds via Claude.
- [ ] Two web apps connected simultaneously to one gateway expose tools as `app1__action` and `app2__action` without collision.
- [ ] The `@tesseron/core` package has zero runtime deps besides `zod`. Bundle size for `@tesseron/web` is <15KB min+gzip.
- [ ] The wire protocol is documented with a JSON-RPC 2.0 spec sufficient to implement a conformant SDK in another language.

---

## 4. Personas

### 4.1 Web App Developer (primary)
Owns a TypeScript web app (React, Next.js, NestJS, Express, vanilla, etc.). Wants to expose specific app actions to AI agents without writing an MCP server from scratch. Cares about: type safety, DX, bundle size, framework freedom.

### 4.2 End User (secondary)
Runs Claude Code or Claude Desktop. Has installed the Tesseron MCP gateway. Opens a web app that ships with the SDK, clicks "Connect Claude," pastes a code, and starts asking the agent to do things.

### 4.3 Agent (Claude / other MCP client)
A first-class consumer. The protocol must be ergonomic for agents: predictable tool names, clear descriptions, structured outputs, side-effect annotations.

---

## 5. Architecture

### 5.1 Topology

```
┌────────────────────────────┐         ┌────────────────────────────┐
│ Web App                    │         │ User's machine             │
│ ┌────────────────────────┐ │   WS    │ ┌────────────────────────┐ │
│ │ @tesseron/web    │ │◄───────►│ │ @tesseron/mcp    │ │
│ │  - actions registry    │ │         │ │  (gateway, local CLI)  │ │
│ │  - resources           │ │         │ │  - WS server (:7475)   │ │
│ │  - ctx (sample,elicit) │ │         │ │  - dynamic MCP tools   │ │
│ └────────────────────────┘ │         │ │  - per-app prefixing   │ │
└────────────────────────────┘         │ └─────────┬──────────────┘ │
                                       │           │ stdio MCP      │
                                       │           ▼                │
                                       │   ┌──────────────┐         │
                                       │   │ Claude Code  │         │
                                       │   └──────────────┘         │
                                       └────────────────────────────┘
```

Server-side flavor (`@tesseron/server`) is identical except the WebSocket client lives in Node, not the browser.

### 5.2 Connection lifecycle

1. User runs `npx @tesseron/mcp` (or it's auto-started by Claude Code's MCP config). Gateway listens on `ws://localhost:7475` (default; configurable).
2. Web app loads in browser; SDK opens WebSocket to the gateway.
3. SDK sends `tesseron/hello` with: protocol version, app metadata (name, origin, icon), action manifest, resource manifest.
4. Gateway acks, assigns a session ID, registers the actions as MCP tools (prefixed by app id), and emits `notifications/tools/list_changed` to Claude.
5. Claude calls a tool → gateway routes to the right session via WebSocket → SDK invokes handler → response streams back.
6. SDK disconnects (page close / explicit `bridge.disconnect()`) → gateway removes those tools and emits `list_changed`.

### 5.3 Addressing methods (v1, all supported)

| Method | UX | When to use |
|---|---|---|
| **Click-to-connect** | App shows a "Connect Claude" button. SDK opens session, gateway prints a 6-digit code in its CLI / surfaces in Claude. User pastes code into Claude, which calls a `tesseron__claim_session` tool. | Default for live websites where multiple users could connect |
| **Pre-configured app id** | Developer hardcodes an `appId` in the SDK; gateway config has an allowlist. SDK auto-claims on connect. | Personal / dev-tooling setups |
| **Origin auto-routing** | Gateway accepts any same-machine connection and exposes tools with origin-prefixed names. Claude picks by name. | Trusted local-only setups |

All three must be supported. The active method is a developer (and gateway) configuration choice.

### 5.4 Protocol versioning

`tesseron/hello` includes a SemVer-style protocol version. Gateway and SDK negotiate a common version. Reserved capability flags allow future features without a major bump.

---

## 6. Wire Protocol

### 6.1 Transport

**SDK ↔ Gateway:** WebSocket (`ws://` to localhost; modern browsers treat localhost as a secure context, allowing connection from HTTPS pages — see §12 R-02 for Safari caveats). Bidirectional JSON-RPC 2.0. Both peers can issue requests.

**Gateway ↔ Agent:** Both transports are first-class:
- **stdio MCP** (default for Claude Code, Claude Desktop) — gateway is auto-spawned by the agent's MCP config.
- **Streamable HTTP MCP** (per the 2025-11 MCP spec) — gateway also exposes an HTTP endpoint with SSE streaming. Enables remote agent clients, browser-based agents, and (future) cross-machine relay topologies. Default bind is `127.0.0.1`; explicit opt-in for `0.0.0.0`.

**Format everywhere:** JSON-RPC 2.0 (mirrors MCP itself; trivial to implement manually in any language).

**Direction:** SDK→gateway carries action manifests, results, progress, resource pushes. Gateway→SDK carries action invocations, cancellations, sampling/elicitation responses.

### 6.2 Method namespace

| Method | Direction | Purpose |
|---|---|---|
| `tesseron/hello` | SDK→GW | Handshake: protocol version, app metadata, manifests |
| `tesseron/welcome` | GW→SDK | Ack: session id, negotiated version, capability flags |
| `actions/list` | GW→SDK | Refresh action list (rare; usually pushed) |
| `actions/list_changed` | SDK→GW (notif) | Action manifest changed; gateway re-registers |
| `actions/invoke` | GW→SDK | Execute an action with args |
| `actions/progress` | SDK→GW (notif) | Streaming progress for in-flight invocation |
| `actions/result` | SDK→GW | Action complete, return value |
| `actions/cancel` | GW→SDK | Cancel an in-flight invocation |
| `resources/list` | GW→SDK | Refresh resource list |
| `resources/read` | GW→SDK | Read named resource |
| `resources/subscribe` | GW→SDK | Subscribe to resource updates |
| `resources/updated` | SDK→GW (notif) | Resource value changed |
| `sampling/request` | SDK→GW | Action handler asks Claude to reason |
| `sampling/result` | GW→SDK | Claude's response |
| `elicitation/request` | SDK→GW | Action handler asks user a question |
| `elicitation/result` | GW→SDK | User's answer |
| `log` | SDK→GW (notif) | Structured log line for debug pane |

### 6.3 Capability negotiation

Capabilities are flags in `tesseron/hello`:
- `streaming` — supports `actions/progress`
- `subscriptions` — supports `resources/subscribe`
- `sampling` — supports `sampling/request`
- `elicitation` — supports `elicitation/request`

Gateway downgrades gracefully if an SDK or agent client doesn't support a capability.

---

## 7. SDK API Surface

### 7.1 Core builder (works in browser and server)

The builder accepts any [Standard Schema](https://standardschema.dev)-compliant validator (Zod, Valibot, ArkType, Effect Schema, …). Examples below use Zod because it's the most common, but no validator is hard-required.

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({
  id: 'shop',                  // tool prefix
  name: 'Acme Shop',
  description: 'E-commerce admin',
});

tesseron
  .action('searchProducts')
  .describe('Search the product catalog by free-text query.')
  .input(z.object({
    query: z.string().describe('Free-text search'),
    limit: z.number().int().positive().default(20),
  }))
  .output(z.object({
    items: z.array(z.object({ id: z.string(), name: z.string(), price: z.number() })),
    total: z.number(),
  }))
  .annotate({ readOnly: true })
  .handler(async ({ query, limit }, ctx) => {
    return await db.products.search(query, limit);
  });

tesseron
  .action('refundOrder')
  .describe('Refund a paid order. Destructive.')
  .input(z.object({ orderId: z.string(), reason: z.string() }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async ({ orderId, reason }, ctx) => {
    ctx.progress({ message: 'Verifying eligibility' });
    // …
    ctx.progress({ message: 'Processing refund', percent: 60 });
    // …
    return { refundId: 'rf_…' };
  });

tesseron
  .resource('currentRoute')
  .describe('The route the user is currently viewing')
  .read(() => router.currentPath)
  .subscribe((emit) => router.on('change', () => emit(router.currentPath)));

tesseron.connect(); // opens WS to ws://localhost:7475
```

### 7.2 Handler context (`ctx`)

```ts
type ActionContext = {
  /** Stream progress updates to the agent during execution. */
  progress(update: { message?: string; percent?: number; data?: unknown }): void;
  /** Cooperative cancellation. Aborted on timeout, agent cancel, or session close. */
  signal: AbortSignal;
  /** Ask the agent's LLM to reason. Counts against the agent's token budget.
   *  Throws SamplingNotAvailableError if agent client doesn't support sampling. */
  sample<T = string>(req: { prompt: string; schema?: StandardSchemaV1<T>; maxTokens?: number }): Promise<T>;
  /** Pause and ask the user a question via the agent.
   *  Throws ElicitationNotAvailableError if agent client doesn't support elicitation. */
  elicit<T>(req: { question: string; schema: StandardSchemaV1<T> }): Promise<T>;
  /** Structured log emitted to gateway debug pane and devtools. */
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: object): void;
  /** Capability flags negotiated with the agent client connected for THIS invocation.
   *  Use these to gate optional codepaths instead of try/catching. */
  agentCapabilities: { sampling: boolean; elicitation: boolean; subscriptions: boolean };
  /** Identity of the agent client that invoked this action. Routing / multi-agent telemetry. */
  agent: { id: string; name: string };
  /** Auto-attached context: page URL, route, user agent (browser flavor only). */
  client: { origin: string; route?: string; userAgent?: string };
};
```

### 7.3 Re-entrancy and depth limits

`ctx.sample()` re-enters the agent loop, which could call another action that calls `sample()`, etc. The gateway enforces a hard **depth limit of 3** by default (configurable). At the limit, `sample()` throws `SamplingDepthExceededError`. Sampling tokens count against the originating agent's quota — Tesseron cannot make agent inference free.

### 7.4 Validation policy

- **Inputs:** strict by default — unknown fields are rejected. Catches agent hallucinations early with clear errors.
- **Outputs:** passthrough by default — the schema documents the shape and gives the agent type info, but extra fields don't error. Allows handler evolution without breaking the wire contract.
- **Override:** `.strictOutput()` on the action builder if you want full reject-extras on outputs too.

### 7.5 Timeouts and concurrency

- **Default action timeout:** 60 seconds. Enforced via `ctx.signal`. Override per-action with `.timeout(ms)`.
- **Concurrency:** action invocations run concurrently across the SDK. No global serialization. Developers serialize at the handler level if needed (queue, mutex, per-row lock).

### 7.6 React adapter

```tsx
import { useTesseronAction, useTesseronResource } from '@tesseron/react';

function ProductPage({ productId }) {
  useTesseronAction('addToCart', {
    description: 'Add the currently-viewed product to the cart',
    input: z.object({ quantity: z.number().int().positive().default(1) }),
    handler: async ({ quantity }) => cart.add(productId, quantity),
  });

  useTesseronResource('selectedProduct', () => product);
}
```

### 7.7 Server-side flavor (NestJS / Express / plain Node)

Identical API. The SDK opens the WebSocket from Node instead of the browser. Useful for backend-side actions that don't need a UI session (cron-like agent control, server admin).

---

## 8. Capability Matrix

| Capability | v1.0 | v1.x | v2 |
|---|---|---|---|
| Typed RPC actions (Zod in/out) | ✅ | | |
| Action annotations (read / write / destructive / requiresConfirmation) | ✅ | | |
| Auto-attached client context (origin, route) | ✅ | | |
| Streaming progress | ✅ | | |
| Cancellation / abort signal | ✅ | | |
| Resources (typed read) | ✅ | | |
| Resource subscriptions (push) | ✅ | | |
| Bidirectional sampling (`ctx.sample`) | ✅ | | |
| Elicitation (`ctx.elicit`) | ✅ | | |
| Structured log streaming | ✅ | | |
| Multi-app coexistence with name prefixing | ✅ | | |
| React adapter | ✅ | | |
| NestJS adapter | | ✅ | |
| Next.js adapter | | ✅ | |
| Suggested follow-ups | | ✅ | |
| Schema versioning per action | | ✅ | |
| Composite / batch actions | | | ✅ |
| File / binary attachments | | | ✅ |
| Inline UI widgets (MCP UI / Apps SDK) | | | ✅ |
| Non-TS ports (Python, Go) | | | ✅ |

---

## 9. Package Layout

Single pnpm workspace monorepo with Turborepo for task orchestration (lean alternative to Nx; matches the Atomic philosophy).

```
tesseron/
├── packages/
│   ├── core/                    @tesseron/core
│   │   └── types, builder, protocol, transport-agnostic. Zero runtime deps;
│   │     accepts any Standard Schema-compliant validator.
│   ├── web/                     @tesseron/web
│   │   └── browser SDK; WebSocket client; uses core
│   ├── server/                  @tesseron/server
│   │   └── Node SDK; WebSocket client; uses core
│   ├── mcp/                     @tesseron/mcp
│   │   └── MCP gateway; CLI; WebSocket server; speaks stdio MCP +
│   │     Streamable HTTP MCP. Multi-agent-client capable.
│   ├── react/                   @tesseron/react
│   │   └── React hooks; peer deps on react + @tesseron/web
│   ├── devtools/                @tesseron/devtools
│   │   └── In-browser debug UI served by the gateway at
│   │     http://localhost:7475/__devtools — live invocations, timing,
│   │     errors, sample/elicit traces. Lazy-loaded; dev-only by default.
│   └── create-tesseron/   create-tesseron
│       └── npm-init scaffolder. `npm create tesseron@latest`
│         produces a working React + Express demo with 3 actions.
├── examples/
│   ├── react-shop/              demo React app
│   ├── nextjs-blog/             demo Next.js app
│   └── nestjs-admin/            demo NestJS backend
├── docs/                        Astro Starlight site
├── turbo.json
└── pnpm-workspace.yaml
```

**Tooling:** TypeScript 5.x · Vitest · tsup for bundling · Changesets for versioning · Biome for lint+format · Turborepo for caching/parallel builds.

**License:** MIT (consistent with Atomic Agents).

---

## 10. Naming & Branding

- **Project name:** Tesseron
- **npm scope:** `@tesseron/*`
- **Primary repo:** `tesseron/tesseron` (monorepo)
- **Working directory:** rename `C:\dev\bridge-sdk` → `C:\dev\tesseron` after PRD approval
- **Domain (suggested):** `tesseron.dev`
- **Logo / brand:** match the Atomic Agents / Atomic Forge family (atomic motif)

**Open:** verify `@tesseron` scope is available on npm before publishing (R-09).

---

## 11. Assumptions

| ID | Assumption | If wrong |
|---|---|---|
| A-01 | Modern Chrome / Firefox / Edge allow `ws://localhost` connections from HTTPS pages without mixed-content errors. | Need wss:// + self-signed cert flow; significant DX regression |
| A-02 | Safari treats localhost as a secure origin in modern versions (Safari 17+). | Safari users need a fallback (loopback IP, helper extension, or wss with mkcert) |
| A-03 | Claude Code (and Claude Desktop) handle `notifications/tools/list_changed` correctly when many tools come and go. | Need a "stable union" mode where tools are batch-flushed only at session boundaries |
| A-04 | A single shared gateway port (default `7475`) is acceptable; one gateway process per user is enough. | Per-app gateways or port discovery needed |
| A-05 | Standard Schema is stable enough in 2026 that we can rely on it as the validator interop layer. | Fall back to a thin internal interface (`{ parse, safeParse }`) and adapters for popular validators. |
| A-06 | The user's agent will run on the same machine as the web app's browser. | Cross-machine relay needed; out of scope for v1 |

---

## 12. Risk Register

| ID | Risk | Cat | Likelihood | Impact | Priority | Mitigation |
|---|---|---|---|---|---|---|
| R-01 | Tool count explodes when many apps connect; agent context bloats | Tech | Med | High | High | Hard cap per session, "active app" focus mode in v1.x, name prefixing always on |
| R-02 | Safari blocks ws://localhost from HTTPS pages | Tech | Med | High | High | Document loopback-IP fallback; ship optional `mkcert`-style helper; consider browser-extension bridge as escape hatch |
| R-03 | Multiple browser tabs of the same app create N sessions, N tool sets | Tech | High | Med | High | Per-tab session id always; provide `singleton: true` flag to force one tab as canonical |
| R-04 | Bidirectional sampling re-enters the agent loop (handler asks Claude → Claude calls handler → loops) | Tech | Med | High | High | Per-invocation depth limit; sampling counted against parent invocation budget |
| R-05 | Web app misbehaves (slow handler, never returns) blocking agent | Tech | High | Med | High | Per-action timeout default (30s); cancellation; gateway-side circuit breaker |
| R-06 | Untrusted third-party site connects to gateway and registers malicious tools | Sec | Med | High | High | Origin allowlist in gateway config; click-to-connect handshake required by default; never expose dangerous tools by origin alone |
| R-07 | Protocol designed wrong for v1, painful breaking changes later | Req | Med | High | High | SemVer protocol negotiation in `tesseron/hello`; reserved capability flags; ship a conformance test suite alongside v1 |
| R-08 | Bundle size creep on `@tesseron/web` (target <15KB) | Tech | High | Low | Med | Bundle size budget enforced in CI; tree-shake aggressively; keep adapters separate packages |
| R-09 | `@tesseron` npm scope is taken | Req | Low | Med | Med | Verify before publishing; fallback names: `@atomictesseron`, `@atomic-cnd`, `@a-tesseron` |
| R-10 | MCP spec evolves and breaks gateway compatibility | Ext | Med | Med | Med | Pin to a spec version in gateway; release notes track upstream |
| R-11 | No clear differentiator vs CopilotKit AG-UI confuses adopters | Ext | Med | Med | Med | Position clearly: AG-UI is for in-app copilots; Tesseron is for *external* MCP agents (Claude Code, etc.) |
| R-12 | Developers expect us to handle auth and are surprised when we don't | Req | High | Low | Med | Strong docs section on "Auth is your job"; example pattern using app's existing session cookie |

---

## 13. Decision Log

Decisions made on a *best-not-easiest* basis. Each is overridable later — the rationale is captured so future-Kenny can re-evaluate.

| ID | Decision | Rationale |
|---|---|---|
| D-01 | **Multi-agent gateway.** One gateway accepts many concurrent agent clients (Claude Code + Claude Desktop + Cursor + …). Each agent connection is a tenant. Action invocations are tagged with originating agent id; sampling/elicitation responses route back to the caller. | Real users will run multiple agents in parallel. One-gateway-per-client would force N processes and break the "single localhost port" model. |
| D-02 | **Sampling counts against host agent budget.** `ctx.sample()` re-enters the host agent's LLM and consumes its tokens — we cannot pretend otherwise. SDK gets `agentCapabilities.sampling` to gate codepaths; `maxTokens` cap and depth-limit-3 enforced. | Honesty. The alternative (silent token consumption) is a footgun. |
| D-03 | **Devtools is a first-class package** (`@tesseron/devtools`). Lazy-loaded browser UI served by the gateway at `/__devtools`. Live invocations, timing, sample/elicit traces, error inspector. Dev-only by default. | Apollo / Redux DevTools precedent — converts evaluators into adopters. Separate package keeps core lean. |
| D-04 | **Default action timeout 60s, per-action overridable.** AbortSignal always available regardless of timeout. | 30s clips legitimate work (refunds, complex queries). 60s balances. Per-action override handles outliers. |
| D-05 | **Click-to-connect is agent-first, CLI-fallback.** Web app shows the code prominently; user tells the agent ("claim session ABCD-1234"); agent calls a `tesseron__claim_session` meta-tool. Gateway also prints to its CLI for headless setups. | Live-website use case demands no terminal context-switch. CLI fallback covers headless servers and edge cases. |
| D-06 | **Hosted relay is out-of-scope for v1, but the protocol is transport-agnostic.** WebSocket is one of N possible transports. v2 can ship a wss:// relay over the same wire format with no protocol bump. | Cross-machine is a real future need; baking transport assumptions in now would be a one-way door. |
| D-07 | **Gateway speaks stdio MCP + Streamable HTTP MCP.** Both first-class. Default bind `127.0.0.1`; explicit opt-in for `0.0.0.0`. (Per user.) | Stdio for Claude Code/Desktop default; Streamable HTTP unlocks remote agent clients and the v2 relay path. |
| D-08 | **Strict input validation, passthrough output validation.** Inputs reject unknown fields (catches agent hallucinations early). Outputs are documented but not field-rejected (lets handlers evolve without wire breakage). `.strictOutput()` opt-in. | Best-of-both: tight contract on the way in, room to evolve on the way out. |
| D-09 | **pnpm workspaces + Turborepo.** Not Nx. | Matches the Atomic philosophy: lean tooling, fast caching, no ceremony. Nx is heavyweight for a single-purpose SDK monorepo. |
| D-10 | **`create-tesseron` ships in v1.** `npm create tesseron@latest` produces a working React + Express demo with 3 example actions in 30 seconds. | First-impression UX is table stakes for adoption. Atomic Forge precedent — scaffolders convert intent into adoption. |
| D-11 | **Schema validators: any Standard Schema-compliant.** Not Zod-locked. Examples use Zod for familiarity. | Avoids forcing a validator choice; respects the modern TS validator ecosystem (Zod, Valibot, ArkType, …). |
| D-12 | **Origin allowlist on by default.** Gateway only accepts SDK connections from origins matching localhost / 127.0.0.1 / explicit allowlist. Web apps on arbitrary HTTPS origins must be added to the user's gateway config (or, with click-to-connect, get a one-shot allowlist via the user's claim action). | Defence in depth against drive-by sites that try to register tools. The protocol cost of being permissive is a real attack surface. |

---

## 14. Phased Delivery

**Phase 1 — Spec & Skeleton (week 1–2)**
- Lock the wire protocol; publish JSON-RPC method spec doc
- Monorepo scaffold with `core`, `web`, `server`, `mcp`, `react` packages
- Conformance test fixture: a recorded protocol session both peers must replay correctly

**Phase 2 — RPC + Resources (week 3–5)**
- `core` builder API (Zod-based)
- `web` and `server` SDKs with WS transport
- `mcp` gateway with stdio MCP transport, dynamic tool registration via `list_changed`
- Click-to-connect handshake working end-to-end
- React adapter
- Example: react-shop demo

**Phase 3 — Streaming, Subs, Bidirectional (week 6–8)**
- `actions/progress` streaming end-to-end
- `resources/subscribe` push
- `sampling/request` and `elicitation/request` round-trip
- Cancellation and timeouts
- Example: nextjs-blog with subscriptions

**Phase 4 — Devtools, Streamable HTTP, Scaffolder (week 9–11)**
- `@tesseron/devtools` browser UI shipped with the gateway
- Streamable HTTP MCP transport for the gateway (in addition to stdio)
- `create-tesseron` scaffolder package
- Multi-agent-client routing (D-01) tested end-to-end

**Phase 5 — Hardening & Docs (week 12–13)**
- Browser compatibility matrix tested (Chrome / Firefox / Safari / Edge)
- Bundle size budget enforced in CI
- Origin allowlist enforcement audited
- Docs site (Astro Starlight)
- NestJS adapter, Express integration example
- Public alpha release on npm

**Phase 6 — Post-v1 polish**
- Suggested follow-ups, per-action schema versioning
- Cross-machine relay (wss://) using the same protocol — promote v1 transport-agnostic design into a real product

---

## 15. Appendix

### 15.1 Glossary

| Term | Definition |
|---|---|
| **Tesseron** | The Tesseron project as a whole |
| **SDK** | The `@tesseron/web` or `/server` library that lives in a developer's app |
| **Gateway** | The `@tesseron/mcp` process the user runs locally; bridges WebSocket SDK ↔ stdio MCP |
| **Action** | A typed function the web app exposes; surfaces to Claude as an MCP tool |
| **Resource** | A typed, readable (and optionally subscribable) piece of state the web app exposes |
| **App id** | Short identifier the SDK declares; used to prefix tool names |
| **Session** | One live WebSocket connection from one SDK instance to the gateway |
| **Sampling** | Action handler asks the agent to reason on something (`ctx.sample`) |
| **Elicitation** | Action handler pauses to ask the user a question via the agent (`ctx.elicit`) |

### 15.2 References

- [Model Context Protocol — Tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [CopilotKit AG-UI Protocol](https://github.com/CopilotKit/CopilotKit) — closest analogue; for in-app copilots
- [MCP Bridge (yonaka)](https://www.pulsemcp.com/servers/yonaka-websocket-mcp-bridge) — WebSocket transport precedent
- [MDN: Mixed content & secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
- [Atomic Agents](https://github.com/BrainBlend-AI/atomic-agents) — sibling project, philosophy lineage

### 15.3 Revision history

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-04-18 | Initial discovery draft |
| 0.2 | 2026-04-18 | Open questions Q-01..Q-10 resolved into Decision Log (D-01..D-12). Added Streamable HTTP transport, devtools package, scaffolder package, Standard Schema support, depth limits, validation policy, timeout/concurrency rules, origin allowlist default. |
