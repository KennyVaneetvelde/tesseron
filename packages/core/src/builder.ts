import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ActionContext } from './context.js';
import type { ActionAnnotations } from './protocol.js';

export type ActionHandler<I, O> = (input: I, ctx: ActionContext) => Promise<O> | O;

export interface ActionBuilder<I = unknown, O = unknown> {
  describe(description: string): ActionBuilder<I, O>;
  input<NewI>(schema: StandardSchemaV1<NewI>, jsonSchema?: unknown): ActionBuilder<NewI, O>;
  output<NewO>(schema: StandardSchemaV1<NewO>, jsonSchema?: unknown): ActionBuilder<I, NewO>;
  annotate(annotations: ActionAnnotations): ActionBuilder<I, O>;
  timeout(ms: number): ActionBuilder<I, O>;
  strictOutput(): ActionBuilder<I, O>;
  handler(fn: ActionHandler<I, O>): RegisteredAction<I, O>;
}

export interface RegisteredAction<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema?: StandardSchemaV1<I>;
  outputSchema?: StandardSchemaV1<O>;
  annotations: ActionAnnotations;
  timeoutMs: number;
  strictOutput: boolean;
  handler: ActionHandler<I, O>;
}

export type ResourceReader<T> = () => T | Promise<T>;
export type ResourceSubscriber<T> = (emit: (value: T) => void) => () => void;

export interface ResourceBuilder<T = unknown> {
  describe(description: string): ResourceBuilder<T>;
  output<NewT>(schema: StandardSchemaV1<NewT>, jsonSchema?: unknown): ResourceBuilder<NewT>;
  read(reader: ResourceReader<T>): ResourceBuilder<T>;
  subscribe(subscriber: ResourceSubscriber<T>): ResourceBuilder<T>;
}

export interface RegisteredResource<T = unknown> {
  name: string;
  description: string;
  outputSchema?: StandardSchemaV1<T>;
  reader?: ResourceReader<T>;
  subscriber?: ResourceSubscriber<T>;
}
