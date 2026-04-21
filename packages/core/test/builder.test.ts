import { describe, expect, it } from 'vitest';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ActionContext,
  ActionBuilderImpl,
  type RegisteredAction,
  type RegisteredResource,
  ResourceBuilderImpl,
} from '../src/index.js';

class CapturingRegistry {
  actions: RegisteredAction[] = [];
  resources: RegisteredResource[] = [];
  registerAction(a: RegisteredAction): void {
    this.actions.push(a);
  }
  registerResource(r: RegisteredResource): void {
    this.resources.push(r);
  }
}

const stringSchema: StandardSchemaV1<string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      if (typeof value === 'string') return { value };
      return { issues: [{ message: 'expected string' }] };
    },
  },
};

const noopCtx = {} as ActionContext;

describe('ActionBuilderImpl', () => {
  it('captures all builder state on handler()', () => {
    const registry = new CapturingRegistry();
    const builder = new ActionBuilderImpl<unknown, unknown>('greet', registry);

    builder
      .describe('Greets a person')
      .input(stringSchema)
      .output(stringSchema)
      .annotate({ readOnly: true })
      .timeout(5000)
      .handler((name) => `hello ${name as string}`);

    expect(registry.actions).toHaveLength(1);
    const action = registry.actions[0]!;
    expect(action.name).toBe('greet');
    expect(action.description).toBe('Greets a person');
    expect(action.annotations.readOnly).toBe(true);
    expect(action.timeoutMs).toBe(5000);
    expect(typeof action.handler).toBe('function');
  });

  it('defaults timeout to 60s and strictOutput to false', () => {
    const registry = new CapturingRegistry();
    new ActionBuilderImpl<unknown, unknown>('plain', registry).handler(() => undefined);
    const action = registry.actions[0]!;
    expect(action.timeoutMs).toBe(60_000);
    expect(action.strictOutput).toBe(false);
  });

  it('threads handler invocations correctly', async () => {
    const registry = new CapturingRegistry();
    new ActionBuilderImpl<string, string>('echo', registry)
      .input(stringSchema)
      .handler((input) => input.toUpperCase());

    const result = await registry.actions[0]!.handler('hi', noopCtx);
    expect(result).toBe('HI');
  });
});

describe('ResourceBuilderImpl', () => {
  it('builds a readable resource', async () => {
    const registry = new CapturingRegistry();
    new ResourceBuilderImpl<string>('greeting', registry)
      .describe('Current greeting')
      .read(() => 'hi');

    const resource = registry.resources[0]!;
    expect(resource.name).toBe('greeting');
    expect(resource.description).toBe('Current greeting');
    const value = await resource.reader?.();
    expect(value).toBe('hi');
  });

  it('builds a subscribable resource', () => {
    const registry = new CapturingRegistry();
    let emitted: string[] = [];
    new ResourceBuilderImpl<string>('counter', registry).subscribe((emit) => {
      emit('a');
      emit('b');
      return () => emitted.push('cleanup');
    });

    const resource = registry.resources[0]!;
    expect(typeof resource.subscriber).toBe('function');
    const cleanup = resource.subscriber?.((v) => emitted.push(v as string));
    expect(emitted).toEqual(['a', 'b']);
    cleanup?.();
    expect(emitted).toEqual(['a', 'b', 'cleanup']);
  });
});
