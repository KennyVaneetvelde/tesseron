# ActionContext

## Contents
- Shape of `ActionContext`
- `signal` — cancellation
- `agent` and `client` — identity
- `agentCapabilities` — feature detection
- `progress` and `log` — streaming updates
- `sample` — ask the LLM mid-handler
- `confirm` — safe yes/no
- `elicit` — structured input
- Capability-check patterns
- Common mistakes

## Shape of `ActionContext`

Every handler receives a second argument of type `ActionContext`:

```ts
interface ActionContext {
  signal: AbortSignal;
  agentCapabilities: AgentCapabilities;
  agent: InvokingAgent;
  client: ClientContext;
  progress(update: ProgressUpdate): void;
  sample<T = string>(req: SampleRequest<T>): Promise<T>;
  confirm(req: ConfirmRequest): Promise<boolean>;
  elicit<T>(req: ElicitRequest<T>): Promise<T | null>;
  log(entry: LogEntry): void;
}

interface AgentCapabilities {
  sampling: boolean;
  elicitation: boolean;
  subscriptions: boolean;
}

interface InvokingAgent {
  id: string;  // e.g. 'claude-ai'
  name: string; // e.g. 'Claude'
}

interface ClientContext {
  origin: string;
  route?: string;
  userAgent?: string;
}

interface ProgressUpdate {
  message?: string;
  percent?: number;
  data?: unknown;
}

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}
```

## `signal` — cancellation

`ctx.signal` is the `AbortSignal` for this invocation. It fires when:
- The gateway sends `actions/cancel` (agent cancelled the request, user hit escape).
- The per-action timeout expires.
- The session disconnects.

Forward `signal` to every cancellable async operation:

```ts
.handler(async ({ query }, ctx) => {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
    signal: ctx.signal,
  });
  return await res.json();
});
```

For operations without native `AbortSignal` support, poll `ctx.signal.aborted` inside loops:

```ts
.handler(async ({ items }, ctx) => {
  const results: Result[] = [];
  for (const item of items) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('cancelled');
    results.push(await processItem(item));
  }
  return results;
});
```

Handlers that ignore `ctx.signal` continue running after cancellation — wasting work and potentially writing stale state.

## `agent` and `client` — identity

`ctx.agent.id` / `.name` identify which MCP client is invoking (e.g. `claude-ai` / `Claude`). Use for:
- Audit logging (`ctx.log({ level: 'info', message: 'action invoked', meta: { agent: ctx.agent.id } })`).
- Permission checks on privileged actions.

`ctx.client.origin` / `.route` / `.userAgent` describe the *Tesseron-connected app* (where the action is running). Use for:
- Multi-app deployments that branch handler logic by origin.
- Routing contextual hints into resources.

## `agentCapabilities` — feature detection

MCP clients advertise which capabilities they support. Before calling `ctx.sample(...)` or `ctx.elicit(...)`, check the flag:

```ts
if (!ctx.agentCapabilities.sampling) {
  return defaultValue();
}
const suggestion = await ctx.sample({ prompt: '...' });
```

`ctx.confirm(...)` does not need a capability check — it collapses to `false` when elicitation is unavailable (safe default for destructive ops; see below).

Common capability patterns per client (subject to change):

| Client | sampling | elicitation | subscriptions |
|---|---|---|---|
| Claude Code | ✅ | ✅ | ✅ |
| Claude Desktop | ✅ | ✅ | ✅ |
| Cursor | ❌ | ❌ | ✅ |
| VS Code Copilot | ❌ | ❌ | ✅ |

Write handlers that degrade gracefully when a capability is missing.

## `progress` — streaming updates

Call `ctx.progress(...)` for operations longer than ~1–2 seconds so the agent can surface progress:

```ts
.handler(async ({ items }, ctx) => {
  ctx.progress({ message: 'Processing items', percent: 0 });
  for (const [i, item] of items.entries()) {
    await processItem(item);
    ctx.progress({
      message: `Processed ${i + 1} of ${items.length}`,
      percent: Math.round(((i + 1) / items.length) * 100),
    });
  }
  return { processed: items.length };
});
```

`ProgressUpdate` fields are all optional — emit `{ percent }` alone if you have a determinate progress bar, `{ message }` alone for indeterminate steps.

## `log` — structured logs

`ctx.log(...)` delivers log entries to the agent, which typically surfaces them in the MCP transcript for debugging:

```ts
ctx.log({ level: 'info', message: 'cache miss', meta: { key: id } });
ctx.log({ level: 'error', message: 'upstream failure', meta: { status: res.status } });
```

Prefer `ctx.log` over `console.log` inside handlers — logs reach the agent and are associated with the invocation.

**Do not log secrets, PII, or full user payloads.** Log entries are visible to the agent and often to the end user.

## `sample` — ask the LLM mid-handler

`ctx.sample(...)` asks the agent's LLM to generate a response, optionally constrained by a schema:

```ts
.handler(async ({ topic }, ctx) => {
  if (!ctx.agentCapabilities.sampling) {
    return { suggestion: defaultTitle(topic) };
  }
  const title = await ctx.sample<string>({
    prompt: `Generate a concise, engaging title for a blog post about: ${topic}`,
    maxTokens: 40,
  });
  return { suggestion: title };
});
```

With a schema, the result is validated:

```ts
const schema = z.object({
  titles: z.array(z.string()).min(3).max(5),
  summary: z.string(),
});

const result = await ctx.sample({
  prompt: `Suggest 3–5 titles and a summary for: ${topic}`,
  schema,
  jsonSchema: z.toJSONSchema(schema),
});
// result is { titles: string[]; summary: string }
```

Returns the validated value. Throws if:
- `agentCapabilities.sampling` is false → `SamplingNotAvailableError`.
- Schema validation fails → `HandlerError`.
- Sampling depth exceeds limit (recursive sampling loops) → `SamplingDepthExceededError`.

## `confirm` — safe yes/no

`ctx.confirm(...)` asks the user a yes/no question through the agent:

```ts
const ok = await ctx.confirm({
  question: 'Delete all completed todos? This cannot be undone.',
});
if (!ok) return { deleted: 0 };
```

Returns `true` only on explicit accept. All other outcomes — decline, cancel, dismissed dialog, missing elicitation capability — collapse to `false`. This is the safe default for destructive operations: **no capability check required**.

## `elicit` — structured input

`ctx.elicit(...)` asks for structured input from the user:

```ts
if (!ctx.agentCapabilities.elicitation) {
  throw new Error('Cannot prompt for input: client does not support elicitation.');
}
const choice = await ctx.elicit({
  question: 'Which tag should this todo have?',
  schema: z.object({ tag: z.enum(['work', 'personal', 'urgent']) }),
});
if (choice === null) return { cancelled: true };
// choice is { tag: 'work' | 'personal' | 'urgent' }
```

Returns the validated value, or `null` if the user cancels. Throws `ElicitationNotAvailableError` if the client does not support elicitation — **must capability-check first**.

Unlike `confirm`, `elicit` cannot safely default (structured input has no sensible fallback), which is why it throws instead of returning `null` when unsupported.

## Capability-check patterns

```ts
// sample — capability check + graceful fallback
const summary = ctx.agentCapabilities.sampling
  ? await ctx.sample({ prompt: `Summarize: ${text}`, maxTokens: 100 })
  : text.slice(0, 100) + '…';

// confirm — safe to call without check
if (!(await ctx.confirm({ question: 'Really delete?' }))) return;

// elicit — must capability-check or handle the throw
let tag: string;
if (ctx.agentCapabilities.elicitation) {
  const r = await ctx.elicit({
    question: 'Tag for this todo?',
    schema: z.object({ tag: z.string() }),
  });
  tag = r?.tag ?? 'untagged';
} else {
  tag = 'untagged';
}
```

## Common mistakes

- **Not forwarding `ctx.signal` to `fetch` / child processes / timers.** Cancellation cannot propagate through the call stack.
- **Calling `ctx.sample(...)` without a `ctx.agentCapabilities.sampling` check.** Throws `SamplingNotAvailableError` on clients that don't support sampling.
- **Calling `ctx.elicit(...)` without a `ctx.agentCapabilities.elicitation` check.** Throws `ElicitationNotAvailableError`.
- **Treating `ctx.confirm(...) === false` as "user declined".** It also means "dialog was dismissed" or "elicitation unavailable". If you need to distinguish, use `elicit` with a boolean-shaped schema.
- **Using `console.log` inside handlers.** Logs don't reach the agent. Use `ctx.log({...})`.
- **Logging secrets or PII in `ctx.log(...)`.** Log entries are visible to the agent and surfaced in the MCP transcript.
- **Infinite sampling loops.** Handlers that call `ctx.sample(...)` → recurse are capped by `SamplingDepthExceededError`. Add explicit termination conditions.
- **Treating `ctx.client` as agent identity.** `ctx.client` describes the *Tesseron-connected app*; `ctx.agent` is the invoking MCP client.
