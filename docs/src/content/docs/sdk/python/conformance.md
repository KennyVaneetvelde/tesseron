---
title: Conformance (Python)
description: How the language-neutral runner drives the Python host, what passes, and what it skips.
related:
  - sdk/python/index
  - sdk/porting
  - protocol/handshake
---

The [conformance corpus](https://github.com/eigenwise/tesseron/tree/main/conformance) is the executable half of the protocol spec. It is language-neutral: the runner plays the gateway, and any SDK that can stand up a host from a fixture document can be checked against it.

## Running it

From the `tesseron-python` repository root:

```bash
uv sync --locked
TESSERON_CONFORMANCE_UNSUPPORTED=host-minted-claim,uds pnpm dlx @tesseron/conformance@1.2.1 --host "uv run --locked python -m conformance_host"
```

In PowerShell, set `$env:TESSERON_CONFORMANCE_UNSUPPORTED = 'host-minted-claim,uds'` before the `pnpm dlx` command instead of using the Bash environment prefix. The runner uses its bundled corpus; pass `--fixtures <path>` to test a hub checkout's current fixtures.

The current result on both Linux and Windows is **29 passed, 10 skipped, 0 failed** across the 39-fixture corpus.

## What it skips, and why

The runner cross-checks the unsupported list against the four capability flags the host declares in `tesseron/hello`. A capability declared `true` in the SDK and named as unsupported fails the run, so this list cannot be used to hide a gap in something the host claims to do.

- `host-minted-claim` skips the nine `bind/*` fixtures. This host takes gateway-minted claims only.
- `uds` skips `uds/file-mode`. This host speaks WebSocket only. Set this tag on both platforms.

Those are the only ten skips. WebSocket-only is by design for this release. The [canonical examples](https://github.com/Eigenwise/tesseron-python/tree/main/examples) exercise the same actions through the real gateway.

Neither transport is a negotiated capability, so neither is covered by the four flags. Everything the host declares, streaming, subscriptions, sampling, and elicitation, is exercised by the fixtures that run.

## The host adapter

`conformance_host/` reads a fixture document and registers what it declares. It sits **beside** `src/tesseron` rather than inside it and imports the published package like any other consumer, so `uv build` produces a wheel with the SDK and nothing else.

The runner starts one host process per fixture with `TESSERON_CONFORMANCE_FIXTURE` pointing at the document, waits for a single readiness line on stdout, then plays the gateway against the endpoint that line names:

```text
tesseron-conformance-url=ws://127.0.0.1:62454/
```

Exactly one stdout line. Every diagnostic goes to stderr, because a second stdout line fails the fixture. The process ends when the runner closes its stdin.

Anything in the fixture grammar the host cannot serve is refused at launch rather than ignored. A fixture requiring `uds`, a fixture that mints its own claim, a fixture member the adapter does not know, and an `inputSchema` using a JSON Schema keyword the adapter cannot enforce all fail the launch. A fixture that would otherwise pass because a keyword was silently dropped fails the run instead.

## Writing a port of your own

The [porting guide](/sdk/porting/) covers the contract. The Python adapter is a reasonable second reference next to the Rust one. It uses no test framework and touches nothing private: the fixture document goes in, and the same public API an application would call comes out.
