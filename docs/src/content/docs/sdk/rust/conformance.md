---
title: Conformance (Rust)
description: Build the private Rust conformance host and run it against the shared protocol corpus.
related:
  - sdk/rust/index
  - sdk/porting
  - protocol/handshake
---

<!-- snippets from examples/todo -->

The [conformance corpus](https://github.com/eigenwise/tesseron/tree/main/conformance) is the executable half of the protocol spec. It is language-neutral. The runner plays the gateway, and the Rust host adapts each fixture into actions and resources through the public SDK API.

## Run it

From the `tesseron-rust` repository root, build the private host, then run the published runner:

```bash
cargo build --locked -p tesseron-conformance-host
TESSERON_CONFORMANCE_UNSUPPORTED=host-minted-claim,uds pnpm dlx @tesseron/conformance@1.2.1 --host "./target/debug/tesseron-conformance-host"
```

In PowerShell, set `$env:TESSERON_CONFORMANCE_UNSUPPORTED = 'host-minted-claim,uds'` before the `pnpm dlx` command instead of using the Bash environment prefix. Both tags are required on Linux and Windows. The runner uses its bundled corpus and starts a fresh host for every fixture. Use `--fixtures <path>` to test a hub checkout's current corpus.

The conformance host is private. It lives at `conformance-host/` as a workspace member and is not part of the published `tesseron` crate. It reads `TESSERON_CONFORMANCE_FIXTURE`, registers the fixture's canned actions and resources, and prints one readiness line before the runner connects. Diagnostics go to stderr.

## Expected result

The Rust host uses gateway-minted claims and WebSocket transport only. With `host-minted-claim,uds` unsupported, expect **29 passed, 10 skipped, 0 failed** on Linux and Windows.

- The nine `bind/*` fixtures skip because they require a host-minted claim. The Rust host waits for the gateway to mint the claim in the welcome.
- `uds/file-mode` skips because the Rust host currently speaks WebSocket only in the conformance path and Unix domain sockets are unavailable there.

The runner treats these as skips, not hidden failures. Every capability the Rust host declares, including streaming, subscriptions, sampling, and elicitation, must agree with the `tesseron/hello` fields and is exercised by the fixtures that run.

## Host launch contract

The runner gives each fixture a fresh temporary directory and starts one host process with `TESSERON_CONFORMANCE_FIXTURE` set to the fixture path. The host must print exactly one line in this form before any other stdout:

`tesseron-conformance-url=ws://127.0.0.1:<port>/`

The runner connects to that loopback URL, runs the fixture steps, closes the connection, and ends the child before moving to the next fixture. A crash, extra stdout line, timeout, or non-loopback URL is a fixture failure.

## When a port changes

Run the full corpus again after changing a protocol path, action registration, resource subscription, handshake, or context method. A fixture added after the last host run is the usual reason a port goes red. The runner's `--host` path handling resolves the Rust binary to an absolute native path, which keeps this command working on Windows.
