# Security Policy

## Supported versions

Only the latest `1.x` release line receives security fixes while the project
is pre-2.0. Pin to `^1.0.0` and we'll keep you covered.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Instead, email `kenny@eigenwise.io` with the subject prefix
`[tesseron-security]` and a description of:

- The affected package(s) and version(s).
- A minimal reproduction (or at least a clear threat model).
- The impact you can demonstrate.

You'll get an acknowledgement within 72 hours. Once the issue is confirmed,
we aim to ship a patched release within 14 days for high-severity issues and
publish a coordinated advisory. Reporters are credited in the advisory unless
they ask to stay anonymous.

## Scope

Tesseron is a local-first SDK + gateway. Reports about the following are in scope:

- Authentication/authorization bypass on the gateway (claim-code flow, session
  scoping, cross-session data leaks).
- WebSocket origin-allowlist bypass.
- MCP protocol parsing / handshake issues (malformed JSON-RPC causing DoS,
  memory exhaustion, RCE).
- Schema-validation bypass that lets unvetted input reach handlers.
- Secret leakage via logs, error messages, or the resource manifest.
- Vulnerabilities in the published npm tarballs themselves (e.g. malicious
  postinstall scripts — we don't ship any).

Out of scope:

- Vulnerabilities in third-party dependencies unless Tesseron's usage makes
  them exploitable. File those upstream and let us know so we can bump.
- Denial-of-service via obviously pathological inputs (e.g. 100 MB JSON bodies
  on localhost). The gateway is a local-machine process; abuse of it requires
  local execution, which is an outside-scope threat model.
- Attacks that require the user to install a malicious MCP client.
