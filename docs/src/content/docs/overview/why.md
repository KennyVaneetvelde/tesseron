---
title: Why Tesseron?
description: The problem Tesseron solves, and where it fits relative to browser automation, chat widgets, and custom APIs.
related:
  - overview/architecture
  - protocol/index
---

Agents are great at reasoning about what to do. They're bad at reaching into your app to do it.

The agent doesn't need to click a button - it needs to *do the thing the button does*. Tesseron is the layer that lets it: you instrument your app once, the way you'd add ARIA to a web page, and any MCP-compatible agent can call the typed actions you expose. An accessibility layer for AI agents, in other words - or an API for agents, written by the people who built the app.

There are three common ways to close that gap. Tesseron is a fourth.

## 1. Browser automation (Playwright, Selenium, Computer Use)

The agent drives a pixel-level browser. Conceptually powerful, practically fragile: every layout tweak breaks selectors, every modal needs bespoke handling, every authentication flow is re-solved from scratch. Token-heavy. Slow.

## 2. Chat widget embedded in the app

You bolt an AI sidebar into your UI and wire up tool calls manually. The agent can talk to your backend, but it can't touch the running UI state the user is looking at. Two worlds that never meet.

## 3. A bespoke MCP server for your backend

Great for headless automation. Useless for "put this in the user's cart on the page they're already viewing." The user's session, their open tab, their in-memory draft - all invisible to a backend MCP server.

## 4. Tesseron

The running app opens a WebSocket to a local MCP gateway and declares its actions:

```ts
tesseron.action('addToCart').input(...).handler(...);
```

The gateway exposes those actions as MCP tools over stdio. Any MCP-capable agent - Claude Code, Cursor, Claude Desktop, any other - sees them and calls them. The handler runs inside the user's real app, with their real state, their real auth.

### Not just for the web

Tesseron is a protocol, not a web framework. The shipped SDKs cover TypeScript, Python, Rust, and C++. The Python, Rust, and C++ SDKs are unpublished and live in the hub repository under `sdks/python/`, `sdks/rust/`, and `sdks/cpp/`. Any process that can open a WebSocket and speak JSON-RPC 2.0 can host actions, including a Python daemon, a Rust desktop app, a C++ service, or a .NET line-of-business tool. See [Porting Tesseron](/sdk/porting/), the [Python SDK](/sdk/python/), the [Rust SDK](/sdk/rust/), and the [C++ SDK](/sdk/cpp/).

## 5. Tesseron and WebMCP

The [W3C WebMCP draft](https://webmachinelearning.github.io/webmcp/) is a W3C Community Group draft co-authored by Google and Microsoft. It lets a website expose tools to the browser's own agent. Chrome put it behind a flag in Chrome 146 in February 2026, and the [Chrome origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial) is ongoing. The July 2026 draft moved the API from `navigator.modelContext` to `document.modelContext`. Chrome 150 deprecated the old name. `provideContext()` was removed in March 2026. Only Chromium implements WebMCP today. It exposes tools through `registerTool()` with a JSON schema or through annotated forms. Those tools run in the page as the logged-in user. The agent has to live in the browser, either built in or installed as an extension. A public website that wants the browser's own assistant to fill forms is the right fit.

- **Any process, not a page.** Tesseron can expose actions from a Tauri app, Python daemon, CLI, or game, and a Python daemon can expose `importTodos` while a Tauri app uses system webviews that cannot reach WebMCP through its own UI.
- **The agent is outside, and it is the one you already use.** Claude Code, Cursor, or Claude Desktop can build, run, and drive the app through Tesseron, while a coding agent cannot reach `document.modelContext`, so Claude Code can call `addTodo` after editing its handler.
- **One gateway sees every running app.** Tesseron can expose a browser tab and a desktop app together, so a cross-app flow is built in; for example, it can read an invoice from a web app and post it into a local accounting app.
- **The app can talk back.** Tesseron supports sampling, elicitation, `confirm`, resources with subscriptions, progress, cancellation, and resume; for example, `importTodos` can report each added item while a subscribed resource updates.
- **Loopback plus an explicit claim.** Tesseron stays on loopback and requires the user's claim code, so a third-party script on the page cannot register a tool; for example, an unrelated analytics script cannot expose `deleteAccount` through the gateway.
- **One CC BY spec, several languages, conformance-tested.** The protocol is CC BY 4.0, SDKs can be written in several languages, and the conformance suite checks them; for example, the same `addTodo` action can run in TypeScript, Python, Rust, or C++.

Tesseron does not build on WebMCP and does not publish into it. Use WebMCP for browser-native agents and Tesseron for the wider set of processes and agents.

## Tradeoffs (be honest)

- **Localhost by default.** Tesseron is a local-first developer tool. Apps bind to `127.0.0.1`; the gateway only dials loopback URLs. Nothing leaks off the machine.
- **Bound to a running app.** The agent can only act while your app is running. A refresh or reload keeps the same session (resume is on by default); fully closing the app ends it. This is a feature - it keeps the agent bound to what the user can actually see.
- **Not a replacement for a headless API.** If you need scheduled or unattended automation, you want a server-side MCP. Tesseron complements it - it doesn't replace it.

## When Tesseron is the right fit

- Internal tools where power users want to drive the UI via chat.
- Complex workflows that already exist as UI actions - search, filter, create, approve - and shouldn't be duplicated on the backend.
- Product demos and prototypes where "the agent actually does what the user sees" is the whole point.
- Personal dashboards, admin panels, CMS editors, developer tooling.
- Desktop and back-end apps too - an Electron editor, a Node daemon, a CLI - that want an agent-callable surface without standing up a separate MCP server.

If you're shipping one of those, keep reading.
