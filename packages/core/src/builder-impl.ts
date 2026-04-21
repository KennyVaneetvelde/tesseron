import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  ActionBuilder,
  ActionHandler,
  RegisteredAction,
  RegisteredResource,
  ResourceBuilder,
  ResourceReader,
  ResourceSubscriber,
} from './builder.js';
import type { ActionAnnotations } from './protocol.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface BuilderRegistry {
  registerAction(action: RegisteredAction): void;
  registerResource(resource: RegisteredResource): void;
}

export interface ActionBuilderInit<I, O> {
  inputJsonSchema?: unknown;
  outputJsonSchema?: unknown;
}

export class ActionBuilderImpl<I, O> implements ActionBuilder<I, O> {
  private description = '';
  private inputSchema?: StandardSchemaV1<I>;
  private outputSchema?: StandardSchemaV1<O>;
  private inputJsonSchema?: unknown;
  private outputJsonSchema?: unknown;
  private annotations: ActionAnnotations = {};
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private isStrictOutput = false;

  constructor(
    private readonly name: string,
    private readonly registry: BuilderRegistry,
  ) {}

  describe(description: string): ActionBuilder<I, O> {
    this.description = description;
    return this;
  }

  input<NewI>(
    schema: StandardSchemaV1<NewI>,
    jsonSchema?: unknown,
  ): ActionBuilder<NewI, O> {
    this.inputSchema = schema as unknown as StandardSchemaV1<I>;
    if (jsonSchema !== undefined) this.inputJsonSchema = jsonSchema;
    return this as unknown as ActionBuilder<NewI, O>;
  }

  output<NewO>(
    schema: StandardSchemaV1<NewO>,
    jsonSchema?: unknown,
  ): ActionBuilder<I, NewO> {
    this.outputSchema = schema as unknown as StandardSchemaV1<O>;
    if (jsonSchema !== undefined) this.outputJsonSchema = jsonSchema;
    return this as unknown as ActionBuilder<I, NewO>;
  }

  annotate(annotations: ActionAnnotations): ActionBuilder<I, O> {
    this.annotations = { ...this.annotations, ...annotations };
    return this;
  }

  timeout(ms: number): ActionBuilder<I, O> {
    this.timeoutMs = ms;
    return this;
  }

  strictOutput(): ActionBuilder<I, O> {
    this.isStrictOutput = true;
    return this;
  }

  handler(fn: ActionHandler<I, O>): RegisteredAction<I, O> {
    const registered: RegisteredAction<I, O> = {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      annotations: this.annotations,
      timeoutMs: this.timeoutMs,
      strictOutput: this.isStrictOutput,
      handler: fn,
    };
    Object.assign(registered, {
      inputJsonSchema: this.inputJsonSchema,
      outputJsonSchema: this.outputJsonSchema,
    });
    this.registry.registerAction(registered as RegisteredAction);
    return registered;
  }
}

export class ResourceBuilderImpl<T> implements ResourceBuilder<T> {
  private description = '';
  private outputSchema?: StandardSchemaV1<T>;
  private outputJsonSchema?: unknown;
  private reader?: ResourceReader<T>;
  private subscriber?: ResourceSubscriber<T>;

  constructor(
    private readonly name: string,
    private readonly registry: BuilderRegistry,
  ) {}

  describe(description: string): ResourceBuilder<T> {
    this.description = description;
    return this;
  }

  output<NewT>(schema: StandardSchemaV1<NewT>, jsonSchema?: unknown): ResourceBuilder<NewT> {
    this.outputSchema = schema as unknown as StandardSchemaV1<T>;
    if (jsonSchema !== undefined) this.outputJsonSchema = jsonSchema;
    return this as unknown as ResourceBuilder<NewT>;
  }

  read(reader: ResourceReader<T>): ResourceBuilder<T> {
    this.reader = reader;
    this.commit();
    return this;
  }

  subscribe(subscriber: ResourceSubscriber<T>): ResourceBuilder<T> {
    this.subscriber = subscriber;
    this.commit();
    return this;
  }

  private commit(): void {
    const registered: RegisteredResource<T> = {
      name: this.name,
      description: this.description,
      outputSchema: this.outputSchema,
      reader: this.reader,
      subscriber: this.subscriber,
    };
    Object.assign(registered, { outputJsonSchema: this.outputJsonSchema });
    this.registry.registerResource(registered as RegisteredResource);
  }
}
