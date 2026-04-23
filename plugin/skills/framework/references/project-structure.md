# Project structure

Scoped to **Tesseron-specific** structural decisions only. Project scaffolding (`package.json`, `tsconfig.json`, bundler config, `.gitignore`, package-manager choice, framework version pins, and any framework-specific idioms) is outside Tesseron's scope — those decisions belong to the upstream scaffolder for the framework, or to a skill that specializes in that framework.

For integrating Tesseron into a project, see the sibling `tesseron-dev` skill.

## Contents

- The three consumer packages
- Where `tesseron.app(...)` goes
- `app.id` rules
- `@tesseron/*` version lockstep
- Multi-app projects and tool-name collisions
- Monorepo layout for shared schemas

## The three consumer packages

Tesseron ships three consumer packages (plus `@tesseron/core` for protocol types — not a consumer surface — and `@tesseron/mcp` for the bundled gateway binary — also not a consumer surface).

| Package | Scope |
|---|---|
| `@tesseron/react` | React projects. Exports the hook API (`useTesseronAction`, `useTesseronResource`, `useTesseronConnection`) alongside the singleton. Tesseron ships framework-specific ergonomics here because React's hook model warrants them. |
| `@tesseron/server` | Node processes — headless services, CLIs, long-running backends. |
| `@tesseron/web` | Any other browser context. A framework-neutral singleton — the same API serves vanilla JS and any browser framework without a Tesseron-specific adapter. Tesseron does not ship framework-specific code for these; the singleton is called from whatever module scope or startup hook the framework provides. |

Pick exactly one `@tesseron/*` package per process. They are singletons.

## Where `tesseron.app(...)` goes

`tesseron.app(...)` must run exactly once, at module scope, before the first `tesseron.action(...)` / `tesseron.resource(...)` / `tesseron.connect()` call. Beyond that, *which file* is the project's entry point is the framework's convention, not Tesseron's — Tesseron only asks that the call is at module scope so it runs once per process.

- **React** (`@tesseron/react`): put `tesseron.app(...)` at module scope in the main entry file that bootstraps the React tree. Do not call it inside a component — re-mounting would re-register the manifest.
- **Server** (`@tesseron/server`): put `tesseron.app(...)` at module scope in the Node entry file.
- **Browser-non-React** (`@tesseron/web`): put `tesseron.app(...)` at module scope in whichever file the framework bootstraps from. The singleton is framework-neutral; the call runs at import time. `tesseron.connect()` can be awaited at module scope or scheduled inside whatever startup hook the framework exposes.

## `app.id` rules

- **Always `snake_case`** — lowercase letters, digits, and underscores. No spaces, dashes, slashes, dots.
- **Stable.** The MCP gateway prefixes every action with `<app_id>__<action_name>` (e.g. `todos__addTodo`). Changing `app.id` breaks any saved tool lists or agent prompts that reference the prefix.
- **Unique per connected app.** In a multi-app gateway session, two apps with the same `app.id` produce colliding tool names.
- Derive a default from `package.json` `name`, normalized to `snake_case`.

## `@tesseron/*` version lockstep

All `@tesseron/*` packages — `core`, `web`, `server`, `react`, `mcp` — are released together. Within a single project, pin them to the **same minor version** or to a `^1.0.0`-style range that resolves them together. Mismatched minor versions cause subtle protocol drift:

- A `@tesseron/web@^1.1.0` client speaking to a `@tesseron/mcp@^1.0.x` gateway may use protocol methods the gateway doesn't route.
- The SDK's TypeScript types come from `@tesseron/core`, so if `@tesseron/core` resolves to a different version than the transport package, types can mismatch runtime behavior.

`@tesseron/core` is not a direct dependency — the other packages re-export from it. Do not install `@tesseron/core` explicitly unless you need the low-level protocol types for a custom transport or test harness.

## Multi-app projects and tool-name collisions

One process, one `app.id`. If an application needs to expose multiple "surfaces" to the agent (e.g. an admin surface and a customer surface), that's two separate processes with two separate `app.id` values, each calling `tesseron.connect()` independently.

When two apps connect to the same gateway session, their tools are prefixed independently: `shop_web__refundOrder` and `shop_admin__refundOrder` coexist without clashing. But if both use `app.id = "shop"`, the gateway's tool list has two `shop__refundOrder` entries and routing becomes undefined.

## Monorepo layout for shared schemas

Splitting a Tesseron-using project into multiple workspaces is worth doing only for these reasons:

- **Shared schemas.** A frontend and a backend both need the same Zod/Valibot/Typebox input definitions. Extract them into a shared workspace package; both apps import from it.
- **Shared handlers.** Handler logic lives in a domain package that both the HTTP API and the Tesseron surface call into.
- **Multiple Tesseron apps** that ship independently but talk to the same gateway during development.

A minimal shape:

```
my-product/
├── apps/
│   ├── web/              # one Tesseron app, app.id: "product_web"
│   └── service/          # another Tesseron app, app.id: "product_service"
└── packages/
    └── shared/           # shared schemas, domain types, pure handlers
```

The Tesseron-specific rule is the `app.id` split (to avoid tool-name collisions) and the shared-package boundary for schemas. Workspace tooling, `tsconfig` inheritance, build orchestration, and package-manager choice are all outside Tesseron's scope.

## Tesseron-specific anti-patterns

- **Two `@tesseron/*` packages in the same process.** Only one singleton should register actions and connect.
- **`tesseron.app(...)` inside a component or inside a function called per request.** It must run exactly once at module scope.
- **`tesseron.connect()` before `tesseron.app(...)`.** Connect throws without an app manifest.
- **Sharing `app.id` across two surfaces.** Tool-name collisions at the gateway.
- **Pinning `@tesseron/*` packages to different minor versions.** Protocol drift.
- **Importing from package internals (`@tesseron/core/dist/...`).** Not public API.
- **Hardcoding `ws://127.0.0.1:7475`.** Use `DEFAULT_GATEWAY_URL` from the transport package.

Beyond these, Tesseron has no opinion on project structure.
