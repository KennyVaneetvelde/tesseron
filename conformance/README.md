# Tesseron conformance

This directory contains the language-neutral fixture corpus and the executable runner for Tesseron protocol hosts. The runner plays the gateway and dials the host directly. It never starts `@tesseron/mcp`, reads discovery manifests, or touches `~/.tesseron`.

The fixture corpus is licensed CC BY 4.0, like the protocol specification. See [`LICENSE`](../docs/src/content/docs/protocol/LICENSE).

## Run it

Build your host adapter, then pass its command to the published CLI:

```bash
npx @tesseron/conformance@1.2.0 --host "./build/tesseron-conformance-host"
```

Available options:

```text
tesseron-conformance --host "<command>" [--fixtures <dir>] [--only <id glob>] [--json]
```

`--fixtures` overrides the fixture corpus shipped inside the npm package. `--only` accepts `*` and `?` in a fixture ID glob. `--json` prints one report document and no human result lines.

This repository runs its TypeScript reference host with:

```bash
pnpm -r --filter "@tesseron/*" --filter "!@tesseron/docs" build
pnpm conformance:run
```

## Host launch contract

The runner starts a fresh host process for every selected fixture:

1. It creates a private temporary directory.
2. It writes the complete fixture document to `<temp>/fixture.json` with private permissions.
3. It starts the trusted `--host` shell command with `TESSERON_CONFORMANCE_FIXTURE` set to that absolute path.
4. It waits up to 5000 ms for exactly one stdout line:
   - `tesseron-conformance-url=ws://127.0.0.1:<port>/<path>`
   - `tesseron-conformance-uds=<absolute-path>`, only for a fixture requiring `uds`
5. It dials that endpoint and plays the gateway side of the fixture.
6. It closes all connections, closes the child's stdin, and force-kills a child that does not stop after the cleanup allowance.

The endpoint must use loopback and an ephemeral port. Put diagnostics on stderr. EOF, another stdout line, malformed readiness, a non-loopback URL, timeout, or early exit fails the fixture with launch evidence. A crash after launch fails the active step.

A host adapter should stop cleanly when stdin closes and should also handle its platform's normal termination signals.

## Capabilities and skips

Set `TESSERON_CONFORMANCE_UNSUPPORTED` to a comma-separated list of tags the host cannot support. Empty or absent means every known tag is supported. Known tags are:

```text
actions, elicitation, host-minted-claim, resources, resume,
sampling, streaming, subscriptions, uds
```

Unknown and duplicate tags are runner errors. A fixture is skipped when any of its `requires` tags is unsupported, and the report names every missing tag. Windows hosts that have no POSIX Unix domain sockets should include `uds`.

For selected fixtures, the `streaming`, `subscriptions`, `sampling`, and `elicitation` fields in `tesseron/hello.params.capabilities` must agree with the unsupported list.

## Fixture document

Each JSON file under `fixtures/` has this shape:

```jsonc
{
  "id": "actions/invoke-success",
  "title": "A valid invoke returns its output",
  "spec": "/protocol/actions/",
  "requires": [],
  "fixture": {
    "actions": [
      { "name": "add", "returns": { "sum": 3 } }
    ]
  },
  "steps": [
    { "recv": { "id": "~capture:helloId", "method": "tesseron/hello" } },
    {
      "send": {
        "jsonrpc": "2.0",
        "id": "~ref:helloId",
        "result": { "sessionId": "s_test", "protocolVersion": "1.2.0" }
      }
    }
  ]
}
```

`id` must match the path below `fixtures/` without `.json`. `spec` is the absolute docs route that defines the behavior. `requires` controls honest skips. `fixture` tells the adapter which canned app to register. `steps` is the ordered gateway script.

## Fixture adapter grammar

The adapter reads the `fixture` object before opening its endpoint. Omitted `actions` and `resources` mean empty lists.

### Actions

Every action entry requires `name` and accepts:

| Field | Adapter behavior |
|---|---|
| `description` | Register this action description. The default is an empty string. |
| `returns` | Return a deep copy of this JSON value. The default is `null`. |
| `inputSchema` | Register this JSON Schema as both runtime validation and manifest schema. Invalid input must fail before the handler runs. |
| `assertHandlerNotCalled` | Throw if the handler runs. Used with input validation fixtures. |
| `blocksUntilCancelled` | Keep the handler pending until the SDK's cancellation path aborts it. |
| `progress` | Call the action context's progress method once per entry, in array order. Each entry may contain `percent`, `message`, and `data`. |
| `confirms` | Call the action context's confirm method with this question. |
| `returnsConfirmResult` | Return `{ "confirmed": <boolean> }` after `confirms`. |
| `elicits` | Call the action context's structured elicit method with `{ "question", "jsonSchema" }` and a permissive runtime validator. This lets the SDK validate the outgoing JSON Schema itself. |

An adapter applies behaviors in this order: reject unexpected handler calls, enter the cancellation wait, emit progress, confirm, elicit, then return the canned value. `returnsConfirmResult` ends the handler after confirmation.

### Resources

Every resource entry requires `name` and accepts:

| Field | Adapter behavior |
|---|---|
| `description` | Register this resource description. The default is an empty string. |
| `value` | Return a deep copy from each read. The default is `null`. |
| `subscribable` | Register the resource's subscription callback. |
| `emits` | Queue each `{ "afterStep", "value" }` update in array order after subscription setup returns. `afterStep` names the labeled runner step used as the ordering boundary; the corresponding `recv` uses `notBefore` to prove the update arrived later. Cleanup cancels every queued update. |

### Host-minted claims

`hostMintedClaim` has deterministic test data:

```json
{
  "code": "AB3X-7K",
  "sessionId": "s_conformance_bind_0001",
  "resumeToken": "rt_conformance_bind_0001"
}
```

When present, the adapter answers the app's hello locally, waits for a valid bind, then replays the cached hello to the runner. WebSocket bind protocols are exactly `tesseron-gateway` and `tesseron-bind.<code>`. UDS uses `tesseron/bind` as the first NDJSON request. A code becomes spent after the replay response.

## Step grammar

A step contains exactly one kind. Waits default to 2000 ms. `timeoutMs` overrides `recv`, `connect`, `reconnect`, and `expectClosed`. `expectSilence` requires its own `timeoutMs`. There is no sleep step.

| Step | Meaning |
|---|---|
| `recv: <matcher>` | Consume the next host envelope and partially match it. |
| `send: <envelope>` | Resolve `~ref` values and write one literal JSON-RPC 2.0 envelope. Other matchers are invalid here. |
| `connect: { bindCode?, expect? }` | Dial the ready endpoint. Fixtures without an explicit initial connect use an implicit plain WebSocket connection. |
| `reconnect: true | { bindCode?, expect? }` | Dial the same endpoint after a drop. `true` reuses the prior bind code and expects an open connection. |
| `dropTransport: true` | Close WS with code 1001 and reason `conformance drop`, or destroy UDS, then forget the connection. |
| `expectClosed: true | { code?, reason? }` | Wait for close. Code and reason checks apply only to WebSocket. |
| `expectSilence: <matcher>` | Fail if a matching frame arrives during the explicit timeout. Unrelated frames stay buffered. |
| `expectFileMode: { target, mode }` | Compare POSIX mode bits for UDS `socket` or `parent`. Modes are `0600` and `0700`. |

A connect expectation is one of:

```jsonc
"open"
{ "upgradeStatus": 403 }
{ "bindErrorCode": -32009, "closes": true }
```

WebSocket failures use `upgradeStatus`. UDS bind failures use `bindErrorCode`; `closes` defaults to `false`.

A `recv` step may have `label`. A later `recv` may use `notBefore: "<label>"`; the runner compares the frame's arrival time with the moment that labeled step completed. Labels and captures are local to one fixture and references must point backward.

## Matchers

A `recv` object names the keys it requires. Extra actual keys are allowed. Arrays must have exactly the expected length.

| Matcher | Matches |
|---|---|
| `~any` | Any present JSON value, including `null`. |
| `~string` | A string. |
| `~number` | A number. |
| `~boolean` | A boolean. |
| `~object` | A non-array object. |
| `~array` | An array. |
| `~regex:<pattern>` | A string accepted by the regular expression. |
| `~capture:<name>` | Any present value, copied into a fixture-local capture. |
| `~ref:<name>` | A deep-equal match against a prior capture. In `send`, it inserts a deep copy. |
| `~absent` | The containing object must not have this key. |

Captures commit only when the complete matcher succeeds.

## Reports and exit codes

Human output contains one line per fixture and one summary:

```text
PASS handshake/hello-minimal
SKIP uds/file-mode missing uds
FAIL actions/invoke-success step 3: expected {...}; actual {...}
summary: 1 passed, 1 skipped, 1 failed
```

`--json` writes one document:

```json
{
  "passed": ["handshake/hello-minimal"],
  "skipped": [{ "id": "uds/file-mode", "missing": ["uds"] }],
  "failed": [{ "id": "actions/invoke-success", "stepIndex": 3, "expected": {}, "actual": {} }],
  "summary": { "passed": 1, "skipped": 1, "failed": 1 },
  "exitCode": 1
}
```

Exit code `0` means no selected fixture failed, even when some were skipped. Exit code `1` means at least one fixture failed. Exit code `2` means invalid CLI usage, fixture schema, unsupported tags, or launch configuration prevented a fixture result.

## Changing the corpus

A fixture belongs here when it pins behavior that a reasonable SDK author could get wrong and the protocol already defines. Keep implementation choices out of matchers. Validate source fixtures with:

```bash
pnpm conformance:validate
```

## Coverage status

The 34 source fixtures cover:

- Minimal and manifest-bearing hellos, plus protocol-major rejection.
- Action invocation, input validation, unknown actions, cancellation, and monotonic progress.
- Resource reads and subscription updates.
- Structured elicitation confirmation, every documented schema rejection, properties without `type`, and property `type` arrays where the first entry controls acceptance.
- Resume-token rotation.
- Host-minted claim binding on WebSocket and UDS, including mismatched, spent, missing-code, and non-bind-first-frame outcomes.
- UDS parent and socket file permissions.

The TypeScript reference run reports 28 passes and 6 honest UDS skips on Windows. Linux and macOS run all 34 fixtures, including the UDS cases.

The corpus still leaves direct manifest discovery and lifecycle outside the runner because it dials each host endpoint directly. Sampling depth stays in gateway integration tests because host-wire frames carry no depth. Broader action, resource, resume, sampling, and elicitation behavior can gain fixtures when the protocol defines a distinct portable host rule worth pinning.
