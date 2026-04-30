# Testing

## Contents
- Test framework (Vitest)
- Testing action handlers directly
- Mocking `ActionContext`
- The capturing-registry pattern for builder tests
- In-memory transport for round-trip tests
- Testing resources (read + subscribe)
- Testing session resume
- Testing React hooks
- Common mistakes

## Test framework

Tesseron itself is tested with [Vitest](https://vitest.dev). Consumer projects can use any test framework — Vitest, Jest, Node's built-in `node:test` — because the SDK does not depend on a test runner. The patterns below use Vitest syntax (`describe` / `it` / `expect` / `vi`) but port directly.

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

## Testing action handlers directly

The fastest and highest-leverage tests are direct handler invocations. Build the action, pull `handler` off the resulting `ActionDefinition`, and call it with a mocked `ActionContext`.

```ts
import { describe, it, expect } from 'vitest';
import { tesseron } from '@tesseron/web';
import { z } from 'zod';
import type { ActionContext } from '@tesseron/core';

describe('addTodo action', () => {
  it('adds a todo with the given text', async () => {
    const todos: Todo[] = [];

    const def = tesseron
      .action('addTodo')
      .describe('...')
      .input(z.object({ text: z.string() }))
      .handler(({ text }) => {
        const todo = { id: '1', text, done: false };
        todos.push(todo);
        return todo;
      });

    const ctx: ActionContext = makeMockContext();

    const result = await def.handler({ text: 'Buy milk' }, ctx);

    expect(result).toEqual({ id: '1', text: 'Buy milk', done: false });
    expect(todos).toHaveLength(1);
  });
});
```

Handlers are invoked with `await` regardless of whether they're sync or async, so the test always awaits the return value.

## Mocking `ActionContext`

A reusable helper keeps tests short:

```ts
import type { ActionContext } from '@tesseron/core';
import { vi } from 'vitest';

export function makeMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    signal: new AbortController().signal,
    agentCapabilities: { sampling: true, elicitation: true, subscriptions: true },
    agent: { id: 'test-agent', name: 'Test Agent' },
    client: { origin: 'http://localhost' },
    progress: vi.fn(),
    log: vi.fn(),
    sample: vi.fn().mockResolvedValue('mocked sample'),
    confirm: vi.fn().mockResolvedValue(true),
    elicit: vi.fn().mockResolvedValue({ tag: 'test' }),
    ...overrides,
  };
}
```

Then override only what the specific test cares about:

```ts
it('returns the default when sampling is unavailable', async () => {
  const ctx = makeMockContext({
    agentCapabilities: { sampling: false, elicitation: false, subscriptions: true },
  });
  const result = await def.handler({ topic: 'AI' }, ctx);
  expect(result.suggestion).toBe('AI'); // fallback path
});

it('cancels cleanly when the signal aborts', async () => {
  const ac = new AbortController();
  const ctx = makeMockContext({ signal: ac.signal });
  const p = def.handler({ items: [1, 2, 3] }, ctx);
  ac.abort();
  await expect(p).rejects.toThrow(/cancel/i);
});
```

## The capturing-registry pattern for builder tests

To test the builder chain itself (not the handler), use a capturing registry — a lightweight stand-in for the client that records what gets registered. This is what `@tesseron/core`'s own tests do:

```ts
import type { ActionDefinition, ResourceDefinition } from '@tesseron/core';

class CapturingRegistry {
  actions: ActionDefinition[] = [];
  resources: ResourceDefinition[] = [];

  registerAction(a: ActionDefinition): void { this.actions.push(a); }
  registerResource(r: ResourceDefinition): void { this.resources.push(r); }
}

it('records description and annotations', () => {
  const registry = new CapturingRegistry();
  // (In production code, ActionBuilderImpl is internal; here illustrative.)
  const builder = /* build with registry */;

  builder
    .describe('Hello')
    .annotate({ readOnly: true })
    .handler(() => 'hi');

  const [action] = registry.actions;
  expect(action.name).toBe('myAction');
  expect(action.description).toBe('Hello');
  expect(action.annotations.readOnly).toBe(true);
});
```

This is lower-level than most consumer projects need — typically direct handler tests (above) are enough.

## In-memory transport for round-trip tests

For integration tests that exercise the full handshake and message flow without a real WebSocket, pair two `InMemoryTransport` instances:

```ts
import type { Transport } from '@tesseron/core';

class InMemoryTransport implements Transport {
  peer?: InMemoryTransport;
  private messageHandlers: Array<(m: unknown) => void> = [];
  private closeHandlers: Array<(r?: string) => void> = [];

  send(message: unknown): void {
    queueMicrotask(() => this.peer?.deliver(message));
  }
  private deliver(message: unknown): void {
    for (const h of this.messageHandlers) h(message);
  }
  onMessage(handler: (m: unknown) => void): void { this.messageHandlers.push(handler); }
  onClose(handler: (r?: string) => void): void { this.closeHandlers.push(handler); }
  close(reason?: string): void {
    for (const h of this.closeHandlers) h(reason);
  }
}

it('completes the hello handshake', async () => {
  const clientT = new InMemoryTransport();
  const serverT = new InMemoryTransport();
  clientT.peer = serverT;
  serverT.peer = clientT;

  const fakeGateway = new FakeGateway(serverT); // your test double

  tesseron.app({ id: 'test', name: 'Test' });
  tesseron.action('ping').describe('Ping').handler(() => 'pong');

  const welcome = await tesseron.connect(clientT);
  expect(welcome.sessionId).toBeDefined();
  expect(welcome.claimCode).toMatch(/^[A-Z]{4}-[A-Z]{2}$/);
});
```

The `FakeGateway` responds to `tesseron/hello` with a canned `WelcomeResult` and routes `actions/invoke` as test assertions require.

## Testing resources (read + subscribe)

Resource reads are straightforward — call `def.reader?.()`:

```ts
it('reads current todo count', () => {
  const todos = ['a', 'b', 'c'];
  const def = tesseron
    .resource('todoCount')
    .describe('Count')
    .read(() => todos.length);

  expect(def.reader?.()).toBe(3);
});
```

Subscribers need a bit more ceremony — capture emits into an array:

```ts
it('emits initial value and updates', () => {
  const registry = new Set<(v: number) => void>();
  let count = 0;

  const def = tesseron
    .resource('counter')
    .describe('Counter')
    .subscribe((emit) => {
      emit(count);
      registry.add(emit);
      return () => registry.delete(emit);
    });

  const emits: number[] = [];
  const cleanup = def.subscriber!((v) => emits.push(v));

  expect(emits).toEqual([0]); // initial emit

  count = 1;
  for (const emit of registry) emit(count);

  expect(emits).toEqual([0, 1]);

  cleanup();
  count = 2;
  for (const emit of registry) emit(count);

  expect(emits).toEqual([0, 1]); // cleanup unregistered
});
```

## Testing session resume

Resume tests need the in-memory transport round-trip. First connect, capture `{ sessionId, resumeToken }`, close the transport, reconnect with `{ resume: credentials }`, and assert the gateway response.

```ts
it('resumes a session with a valid token', async () => {
  const welcome1 = await tesseron.connect(transport1);
  const creds = { sessionId: welcome1.sessionId, resumeToken: welcome1.resumeToken! };

  transport1.close();

  const welcome2 = await tesseron.connect(transport2, { resume: creds });
  expect(welcome2.sessionId).toBe(creds.sessionId);
  expect(welcome2.resumeToken).not.toBe(creds.resumeToken); // rotated
});

it('falls back to fresh connect on ResumeFailed', async () => {
  const badCreds = { sessionId: 'stale', resumeToken: 'expired' };
  await expect(
    tesseron.connect(transport, { resume: badCreds }),
  ).rejects.toThrow(/resume/i);
});
```

## Testing React hooks

For React hook tests, use `@testing-library/react` and render a test component that registers the hook. The `@tesseron/react` hooks are thin wrappers around the singleton — testing the hook end-to-end usually means testing the underlying registration, which is already covered by the direct handler tests above.

When you need to test hook behavior specifically (e.g. that unmount removes the action), override the optional `client` parameter with a capturing client so the registration is observable:

```tsx
import { render } from '@testing-library/react';
import { useTesseronAction } from '@tesseron/react';

it('registers on mount and removes on unmount', () => {
  const fakeClient = new CapturingClient();
  function Thing() {
    useTesseronAction('ping', { handler: () => 'pong' }, fakeClient as any);
    return null;
  }
  const { unmount } = render(<Thing />);
  expect(fakeClient.actions).toContain('ping');

  unmount();
  expect(fakeClient.actions).not.toContain('ping');
});
```

## Common mistakes

- **Testing against a real gateway.** Slow, flaky, and tightly coupled to dev-server state. Use in-memory transports and direct handler calls.
- **Not awaiting handler invocations in tests.** Handlers may be sync, but always `await` — sync handlers return the value directly, async handlers return a promise, and `await` handles both.
- **Forgetting to abort signals in cancellation tests.** Create an `AbortController`, hand `.signal` to the mock context, and call `.abort()` at the right moment.
- **Mocking `ActionContext` partially and casting `as ActionContext`.** Works at runtime but skips type safety. Provide all fields in the factory (`makeMockContext`) — TypeScript will tell you when the API changes.
- **Using `console.log` to debug tests.** Vitest's snapshots and `expect` give better feedback; `console.log` spam clutters CI output.
- **Asserting on `error.message` text.** Messages may change; assert on `error.code` or `instanceof TesseronError`.
