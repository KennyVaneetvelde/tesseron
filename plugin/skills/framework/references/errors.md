# Errors

## Contents
- Error code table
- Error classes
- Handling patterns (`instanceof`)
- Input/output validation errors
- Sampling and elicitation errors
- Cancellation and timeout
- Transport and resume errors
- Never-swallow rules
- Common mistakes

## Error code table

```ts
const TesseronErrorCode = {
  // JSON-RPC 2.0 reserved
  ParseError:          -32700,
  InvalidRequest:      -32600,
  MethodNotFound:      -32601,
  InvalidParams:       -32602,
  InternalError:       -32603,

  // Tesseron-specific
  ProtocolMismatch:    -32000, // hello with wrong protocolVersion
  Cancelled:           -32001, // gateway-initiated cancellation
  Timeout:             -32002, // action exceeded timeoutMs
  ActionNotFound:      -32003, // invoke on an unknown action
  InputValidation:     -32004, // input failed schema
  HandlerError:        -32005, // handler threw, or output failed strict validation
  SamplingNotAvailable:-32006, // ctx.sample on a non-sampling client
  ElicitationNotAvailable:-32007, // ctx.elicit on a non-elicitation client
  SamplingDepthExceeded:-32008, // recursive sampling loop
  Unauthorized:        -32009, // reserved for future auth
  TransportClosed:     -32010, // transport closed mid-request
  ResumeFailed:        -32011, // tesseron/resume couldn't rejoin the session
};
```

## Error classes

```ts
class TesseronError extends Error {
  readonly code: number;
  readonly data?: unknown; // validation issues, client name, etc.
}

// Specific subclasses — preferred for branching
class SamplingNotAvailableError extends TesseronError {
  readonly clientName?: string;
}
class ElicitationNotAvailableError extends TesseronError {
  readonly clientName?: string;
}
class SamplingDepthExceededError extends TesseronError {
  readonly depth: number;
}
class CancelledError extends TesseronError {}
class TimeoutError extends TesseronError {
  readonly timeoutMs: number;
}
class TransportClosedError extends TesseronError {
  readonly reason?: string;
}
class ResumeFailedError extends TesseronError {}
```

All of these extend `TesseronError`, which extends the standard `Error`. `error.name` matches the class; `error.code` maps to the table above; `error.data` carries structured metadata when relevant.

Exported from both `@tesseron/core` and each SDK package (`@tesseron/web`, `/server`, `/react`).

## Handling patterns (`instanceof`)

Prefer `instanceof` over inspecting `error.code`:

```ts
import {
  TesseronError,
  SamplingNotAvailableError,
  ElicitationNotAvailableError,
  TimeoutError,
  CancelledError,
  ResumeFailedError,
} from '@tesseron/core';

try {
  await doSomething(ctx);
} catch (e) {
  if (e instanceof SamplingNotAvailableError) {
    // Fallback path — no LLM available
  } else if (e instanceof CancelledError) {
    // User cancelled; clean up partial work
  } else if (e instanceof TimeoutError) {
    // Handler exceeded timeout; log and rethrow for the agent
    throw e;
  } else {
    throw e;
  }
}
```

Magic-number checks (`error.code === -32006`) work but silently decay as codes shift; `instanceof` stays correct even if error codes are re-numbered.

## Input/output validation errors

`InputValidation` (`-32004`) fires *before* the handler runs. The `error.data` field is the array of Standard Schema issues:

```ts
{
  code: -32004,
  message: 'Invalid input',
  data: [
    { path: ['text'], message: 'String must contain at least 1 character' },
    { path: ['tag'], message: 'Invalid enum value' }
  ]
}
```

Handlers cannot catch `InputValidation` — it's raised by the dispatcher, not thrown inside the handler. If you need to accept more permissive input, loosen the schema.

`HandlerError` (`-32005`) fires when:
- The handler throws any uncaught error, or
- `.strictOutput()` is set and the output fails validation.

In both cases, the original error is preserved in `error.data` (when serializable) for debugging.

## Sampling and elicitation errors

```ts
// Capability-check first — don't rely on the catch
if (ctx.agentCapabilities.sampling) {
  try {
    return await ctx.sample({ prompt: '...' });
  } catch (e) {
    if (e instanceof SamplingDepthExceededError) {
      // A recursive sample chain hit the cap — degrade to a cheaper path
    }
    throw e;
  }
}
return fallbackSuggestion();
```

`SamplingNotAvailableError` and `ElicitationNotAvailableError` carry an optional `clientName` (the MCP client id) in `error.data.clientName` / `.clientName`, useful for surfacing a targeted error message ("Sampling is not supported by Cursor, try Claude Code instead.").

`SamplingDepthExceededError` has a `depth` field equal to the depth at which the cap triggered. Use it to log recursive sampling bugs.

## Cancellation and timeout

`CancelledError` fires after the gateway sends `actions/cancel` and the handler completes (or aborts). It's the *promise rejection* that the handler call ultimately produces; the handler itself sees `ctx.signal.aborted` becoming true.

`TimeoutError` has a `timeoutMs` field. The handler is **not** automatically aborted by the timeout — the gateway fires `actions/cancel`, which flips `ctx.signal`. If the handler ignores `ctx.signal`, it keeps running; the invocation still reports `TimeoutError` to the agent.

Graceful-cleanup pattern:

```ts
.handler(async ({ file }, ctx) => {
  const tmpPath = await startDownload(file, { signal: ctx.signal });
  try {
    return await finish(tmpPath, { signal: ctx.signal });
  } catch (e) {
    if (ctx.signal.aborted) {
      await cleanupTmp(tmpPath); // partial work; remove it
    }
    throw e;
  }
});
```

## Transport and resume errors

`TransportClosedError` fires when the transport (usually WebSocket) closes mid-request. `error.reason` is the close reason if the underlying transport reported one. All pending requests reject with this error at once.

`ResumeFailedError` is raised when `tesseron/resume` fails — expired session, token mismatch, protocol version drift. The fallback is a fresh `connect()` without resume options:

```ts
async function connectWithResume(storedCredentials: ResumeCredentials | undefined) {
  try {
    return await tesseron.connect(undefined, { resume: storedCredentials });
  } catch (e) {
    if (e instanceof ResumeFailedError) {
      clearStoredCredentials();
      return await tesseron.connect(); // fresh claim-code flow
    }
    throw e;
  }
}
```

Never retry resume with the same stale credentials on a failure — the token is gone.

## Never-swallow rules

Certain errors should never be caught-and-hidden from the agent:

- `CancelledError` — the user asked to stop; rethrow so the agent sees the cancellation.
- `TimeoutError` — the user's deadline passed; don't pretend the call succeeded.
- `InputValidation` — the input was wrong; the agent needs to know so it can rephrase.
- `HandlerError` — something real went wrong; silent success returns incorrect state.

Catch them only to clean up and rethrow.

## Common mistakes

- **`error.code === -32006` magic-number checks.** Use `instanceof SamplingNotAvailableError` — resilient to code renumbering.
- **Catching `CancelledError` and returning a "default" success response.** The agent believes the work finished; it didn't. Let cancellation propagate.
- **Calling `ctx.sample(...)` without `agentCapabilities.sampling`.** Don't rely on catching `SamplingNotAvailableError` as flow control; check the capability up front.
- **Retrying on `TransportClosedError` in a tight loop.** The transport is dead; reconnect with exponential backoff, don't spam `send(...)`.
- **Persisting a stale `resumeToken` after a `ResumeFailedError`.** Clear the credentials and fall back to a fresh connect.
- **Using `throw` inside a handler to signal "not a real error, just a business outcome".** The agent sees `HandlerError` for any throw. Return a typed output shape instead (`{ ok: false, reason: '...' }`).
- **Leaking raw errors into the agent's view.** `HandlerError.message` is visible to the agent and often the end user. Sanitize before throwing — no stack traces, no internal IDs, no secrets.
