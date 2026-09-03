import type { ActionContext } from '@tesseron/server';
import { ServerTesseronClient } from '@tesseron/server';

export interface HostMintedClaimFixture {
  code: string;
  sessionId: string;
  resumeToken: string;
}

interface ActionFixture {
  name: string;
  description?: string;
  returns?: unknown;
  inputSchema?: unknown;
  blocksUntilCancelled?: boolean;
  confirms?: string;
  returnsConfirmResult?: boolean;
  progress?: Array<{ percent?: number; message?: string; data?: unknown }>;
  assertHandlerNotCalled?: boolean;
  elicits?: { question: string; jsonSchema: unknown };
}

interface ResourceFixture {
  name: string;
  description?: string;
  value?: unknown;
  subscribable?: boolean;
  emits?: Array<{ afterStep: string; value: unknown }>;
}

export interface HostFixture {
  id: string;
  requires: string[];
  actions: ActionFixture[];
  resources: ResourceFixture[];
  hostMintedClaim?: HostMintedClaimFixture;
}

export function parseHostFixture(value: unknown): HostFixture {
  if (!isRecord(value)) throw new Error('Fixture document must be an object');
  const id = requiredString(value, 'id');
  const requires = stringArray(value['requires'], 'requires');
  const fixture = value['fixture'];
  if (!isRecord(fixture)) throw new Error('fixture must be an object');
  const actions = parseActions(fixture['actions']);
  const resources = parseResources(fixture['resources']);
  const hostMintedClaim = parseHostMintedClaim(fixture['hostMintedClaim']);
  return {
    id,
    requires,
    actions,
    resources,
    ...(hostMintedClaim ? { hostMintedClaim } : {}),
  };
}

export function createFixtureClient(fixture: HostFixture): ServerTesseronClient {
  const client = new ServerTesseronClient();
  client.app({
    id: 'conformance_host',
    name: 'TypeScript conformance host',
    origin: 'tesseron-conformance://typescript',
  });
  for (const action of fixture.actions) registerAction(client, action);
  for (const resource of fixture.resources) registerResource(client, resource);
  return client;
}

function registerAction(client: ServerTesseronClient, action: ActionFixture): void {
  let builder = client.action(action.name).describe(action.description ?? '');
  if (action.inputSchema !== undefined) {
    builder = builder.input(jsonSchemaValidator(action.inputSchema), action.inputSchema);
  }
  builder.handler(async (_input, context) => runAction(action, context));
}

async function runAction(action: ActionFixture, context: ActionContext): Promise<unknown> {
  if (action.assertHandlerNotCalled) throw new Error('Fixture handler was called unexpectedly');
  if (action.blocksUntilCancelled) return new Promise<unknown>(() => {});
  for (const update of action.progress ?? []) context.progress(update);
  if (action.confirms !== undefined) {
    const confirmed = await context.confirm({ question: action.confirms });
    if (action.returnsConfirmResult) return { confirmed };
  }
  if (action.elicits) {
    await context.elicit({
      question: action.elicits.question,
      schema: permissiveValidator(),
      jsonSchema: action.elicits.jsonSchema,
    });
  }
  return structuredClone(action.returns ?? null);
}

function registerResource(client: ServerTesseronClient, resource: ResourceFixture): void {
  const builder = client.resource(resource.name).describe(resource.description ?? '');
  builder.read(() => structuredClone(resource.value ?? null));
  if (resource.subscribable) {
    builder.subscribe((emit) => {
      const timers = (resource.emits ?? []).map((update, index) =>
        setTimeout(() => emit(structuredClone(update.value)), index),
      );
      return () => {
        for (const timer of timers) clearTimeout(timer);
      };
    });
  }
}

function jsonSchemaValidator(schema: unknown): StandardValidator {
  return {
    '~standard': {
      version: 1,
      vendor: 'tesseron-conformance-host',
      validate: (value) => {
        const issues = validateJsonValue(schema, value, []);
        return issues.length === 0 ? { value } : { issues };
      },
    },
  };
}

function permissiveValidator(): StandardValidator {
  return {
    '~standard': {
      version: 1,
      vendor: 'tesseron-conformance-host',
      validate: (value) => ({ value }),
    },
  };
}

interface StandardValidator {
  '~standard': {
    version: 1;
    vendor: string;
    validate: (
      value: unknown,
    ) => { value: unknown } | { issues: Array<{ message: string; path?: Array<string | number> }> };
  };
}

function validateJsonValue(
  schema: unknown,
  value: unknown,
  path: Array<string | number>,
): Array<{ message: string; path?: Array<string | number> }> {
  if (!isRecord(schema)) return [];
  const types = Array.isArray(schema['type']) ? schema['type'] : [schema['type']];
  const declaredTypes = types.filter((type): type is string => typeof type === 'string');
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => valueHasJsonType(value, type))) {
    return [{ message: `Expected ${declaredTypes.join(' or ')}`, path }];
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((entry) => deepEqual(entry, value))) {
    return [{ message: 'Value is not in enum', path }];
  }
  if (Object.hasOwn(schema, 'const') && !deepEqual(schema['const'], value)) {
    return [{ message: 'Value does not match const', path }];
  }
  if (isRecord(value)) {
    const issues: Array<{ message: string; path?: Array<string | number> }> = [];
    const required = Array.isArray(schema['required'])
      ? schema['required'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key))
        issues.push({ message: `Missing required property ${key}`, path: [...path, key] });
    }
    const properties = schema['properties'];
    if (isRecord(properties)) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(value, key)) {
          issues.push(...validateJsonValue(propertySchema, value[key], [...path, key]));
        }
      }
    }
    return issues;
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    return value.flatMap((entry, index) =>
      validateJsonValue(schema['items'], entry, [...path, index]),
    );
  }
  return [];
}

function valueHasJsonType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseActions(value: unknown): ActionFixture[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('fixture.actions must be an array');
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`fixture.actions[${index}] must be an object`);
    const action: ActionFixture = { name: requiredString(entry, 'name') };
    const description = optionalString(entry, 'description');
    const blocksUntilCancelled = optionalBoolean(entry, 'blocksUntilCancelled');
    const returnsConfirmResult = optionalBoolean(entry, 'returnsConfirmResult');
    const assertHandlerNotCalled = optionalBoolean(entry, 'assertHandlerNotCalled');
    const confirms = optionalString(entry, 'confirms');
    if (description !== undefined) action.description = description;
    if (blocksUntilCancelled !== undefined) action.blocksUntilCancelled = blocksUntilCancelled;
    if (returnsConfirmResult !== undefined) action.returnsConfirmResult = returnsConfirmResult;
    if (assertHandlerNotCalled !== undefined)
      action.assertHandlerNotCalled = assertHandlerNotCalled;
    if (confirms !== undefined) action.confirms = confirms;
    if (Object.hasOwn(entry, 'returns')) action.returns = entry['returns'];
    if (Object.hasOwn(entry, 'inputSchema')) action.inputSchema = entry['inputSchema'];
    if (entry['progress'] !== undefined) action.progress = parseProgress(entry['progress'], index);
    if (entry['elicits'] !== undefined) action.elicits = parseElicits(entry['elicits'], index);
    return action;
  });
}

function parseProgress(value: unknown, actionIndex: number): ActionFixture['progress'] {
  if (!Array.isArray(value))
    throw new Error(`fixture.actions[${actionIndex}].progress must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`progress[${index}] must be an object`);
    const update: { percent?: number; message?: string; data?: unknown } = {};
    if (entry['percent'] !== undefined) {
      if (typeof entry['percent'] !== 'number')
        throw new Error(`progress[${index}].percent must be a number`);
      update.percent = entry['percent'];
    }
    if (entry['message'] !== undefined) {
      if (typeof entry['message'] !== 'string')
        throw new Error(`progress[${index}].message must be a string`);
      update.message = entry['message'];
    }
    if (Object.hasOwn(entry, 'data')) update.data = entry['data'];
    return update;
  });
}

function parseElicits(value: unknown, actionIndex: number): NonNullable<ActionFixture['elicits']> {
  if (!isRecord(value))
    throw new Error(`fixture.actions[${actionIndex}].elicits must be an object`);
  if (!Object.hasOwn(value, 'jsonSchema')) {
    throw new Error(`fixture.actions[${actionIndex}].elicits needs jsonSchema`);
  }
  return { question: requiredString(value, 'question'), jsonSchema: value['jsonSchema'] };
}

function parseResources(value: unknown): ResourceFixture[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('fixture.resources must be an array');
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`fixture.resources[${index}] must be an object`);
    const resource: ResourceFixture = { name: requiredString(entry, 'name') };
    const description = optionalString(entry, 'description');
    const subscribable = optionalBoolean(entry, 'subscribable');
    if (description !== undefined) resource.description = description;
    if (subscribable !== undefined) resource.subscribable = subscribable;
    if (Object.hasOwn(entry, 'value')) resource.value = entry['value'];
    if (entry['emits'] !== undefined) resource.emits = parseEmits(entry['emits'], index);
    return resource;
  });
}

function parseEmits(value: unknown, resourceIndex: number): NonNullable<ResourceFixture['emits']> {
  if (!Array.isArray(value))
    throw new Error(`fixture.resources[${resourceIndex}].emits must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry) || !Object.hasOwn(entry, 'value')) {
      throw new Error(`fixture.resources[${resourceIndex}].emits[${index}] is invalid`);
    }
    return { afterStep: requiredString(entry, 'afterStep'), value: entry['value'] };
  });
}

function parseHostMintedClaim(value: unknown): HostMintedClaimFixture | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('fixture.hostMintedClaim must be an object');
  return {
    code: requiredString(value, 'code'),
    sessionId: requiredString(value, 'sessionId'),
    resumeToken: requiredString(value, 'resumeToken'),
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.length === 0)
    throw new Error(`${key} must be a non-empty string`);
  return result;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return [...value];
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function optionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
