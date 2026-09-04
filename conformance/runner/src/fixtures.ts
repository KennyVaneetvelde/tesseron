import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { isRecord } from './matcher.js';
import type {
  CloseExpectation,
  ConnectExpectation,
  ConnectInstruction,
  FileModeExpectation,
  FixtureDocument,
  FixtureStep,
} from './types.js';

export const KNOWN_REQUIREMENTS = new Set([
  'actions',
  'elicitation',
  'host-minted-claim',
  'resources',
  'resume',
  'sampling',
  'streaming',
  'subscriptions',
  'uds',
]);

const STEP_KINDS = [
  'recv',
  'send',
  'connect',
  'reconnect',
  'dropTransport',
  'expectClosed',
  'expectSilence',
  'expectFileMode',
] as const;
const SIMPLE_MATCHERS = new Set([
  '~any',
  '~string',
  '~number',
  '~boolean',
  '~object',
  '~array',
  '~absent',
]);

export class FixtureSchemaError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'FixtureSchemaError';
  }
}

export async function loadFixtures(directory: string): Promise<FixtureDocument[]> {
  const root = resolve(directory);
  const files = await collectFixtureFiles(root);
  const problems: string[] = [];
  const fixtures: FixtureDocument[] = [];

  for (const file of files) {
    const expectedId = relative(root, file)
      .split(sep)
      .join('/')
      .replace(/\.json$/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      problems.push(`${expectedId}: invalid JSON (${errorMessage(error)})`);
      continue;
    }
    const fixture = parseFixture(parsed, expectedId, problems);
    if (fixture) fixtures.push(fixture);
  }

  if (files.length === 0) problems.push(`No fixture JSON files found under ${root}`);
  if (problems.length > 0) throw new FixtureSchemaError(problems);
  return fixtures.sort((left, right) => left.id.localeCompare(right.id));
}

async function collectFixtureFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFixtureFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files.sort();
}

function parseFixture(
  value: unknown,
  expectedId: string,
  problems: string[],
): FixtureDocument | undefined {
  if (!isRecord(value)) {
    problems.push(`${expectedId}: fixture document must be an object`);
    return undefined;
  }

  const id = typeof value['id'] === 'string' ? value['id'] : '';
  const title = typeof value['title'] === 'string' ? value['title'] : '';
  const spec = typeof value['spec'] === 'string' ? value['spec'] : '';
  if (id !== expectedId) problems.push(`${expectedId}: id is ${JSON.stringify(id)}`);
  if (title.length === 0) problems.push(`${expectedId}: needs a title`);
  if (!spec.startsWith('/')) problems.push(`${expectedId}: needs an absolute docs spec anchor`);

  const requires = parseRequirements(value['requires'], expectedId, problems);
  const fixture = isRecord(value['fixture']) ? value['fixture'] : undefined;
  if (!fixture) problems.push(`${expectedId}: fixture must be an object`);
  else validateFixtureApp(fixture, requires, expectedId, problems);

  const rawSteps = value['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    problems.push(`${expectedId}: needs at least one step`);
    return undefined;
  }

  const captures = new Set<string>();
  const labels = new Set<string>();
  const steps: FixtureStep[] = [];
  rawSteps.forEach((rawStep, index) => {
    const step = parseStep(rawStep, expectedId, index, captures, labels, problems);
    if (step) steps.push(step);
  });
  if (fixture) validateEmissionLabels(fixture, labels, expectedId, problems);
  if (steps.some((step) => step.expectFileMode) && !requires.includes('uds')) {
    problems.push(`${expectedId}: expectFileMode requires the uds capability tag`);
  }

  if (!fixture || steps.length !== rawSteps.length) return undefined;
  return { id, title, spec, requires, fixture, steps };
}

function parseRequirements(value: unknown, fixtureId: string, problems: string[]): string[] {
  if (!Array.isArray(value)) {
    problems.push(`${fixtureId}: needs a requires array`);
    return [];
  }
  const requirements: string[] = [];
  const seen = new Set<string>();
  for (const requirement of value) {
    if (typeof requirement !== 'string') {
      problems.push(`${fixtureId}: requires entries must be strings`);
      continue;
    }
    if (!KNOWN_REQUIREMENTS.has(requirement)) {
      problems.push(`${fixtureId}: unknown requires tag ${JSON.stringify(requirement)}`);
    } else if (seen.has(requirement)) {
      problems.push(`${fixtureId}: duplicate requires tag ${JSON.stringify(requirement)}`);
    } else {
      seen.add(requirement);
      requirements.push(requirement);
    }
  }
  return requirements;
}

function parseStep(
  value: unknown,
  fixtureId: string,
  index: number,
  captures: Set<string>,
  labels: Set<string>,
  problems: string[],
): FixtureStep | undefined {
  if (!isRecord(value)) {
    problems.push(`${fixtureId}: step ${index} must be an object`);
    return undefined;
  }
  const kinds = STEP_KINDS.filter((kind) => Object.hasOwn(value, kind));
  if (kinds.length !== 1) {
    problems.push(
      `${fixtureId}: step ${index} must contain exactly one kind (${STEP_KINDS.join(', ')})`,
    );
    return undefined;
  }

  const kind = kinds[0]!;
  const step: FixtureStep = {};
  const label = value['label'];
  const notBefore = value['notBefore'];
  const timeoutMs = value['timeoutMs'];
  if (label !== undefined) {
    if (typeof label !== 'string' || label.length === 0) {
      problems.push(`${fixtureId}: step ${index} label must be a non-empty string`);
    } else if (labels.has(label)) {
      problems.push(`${fixtureId}: step ${index} duplicates label ${JSON.stringify(label)}`);
    } else {
      step.label = label;
    }
  }
  if (notBefore !== undefined) {
    if (kind !== 'recv') {
      problems.push(`${fixtureId}: step ${index} notBefore is valid only on recv`);
    } else if (typeof notBefore !== 'string' || !labels.has(notBefore)) {
      problems.push(`${fixtureId}: step ${index} references a label that has not completed`);
    } else {
      step.notBefore = notBefore;
    }
  }
  if (step.label) labels.add(step.label);

  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      problems.push(`${fixtureId}: step ${index} timeoutMs must be a positive number`);
    } else if (!['recv', 'connect', 'reconnect', 'expectClosed', 'expectSilence'].includes(kind)) {
      problems.push(`${fixtureId}: step ${index} ${kind} does not accept timeoutMs`);
    } else {
      step.timeoutMs = timeoutMs;
    }
  }
  if (kind === 'expectSilence' && step.timeoutMs === undefined) {
    problems.push(`${fixtureId}: step ${index} expectSilence requires timeoutMs`);
  }
  if (typeof value['note'] === 'string') step.note = value['note'];
  const raw = value['raw'];
  if (raw !== undefined) {
    if (kind !== 'send' || raw !== true) {
      problems.push(`${fixtureId}: step ${index} raw is valid only as true on send`);
    } else {
      step.raw = true;
    }
  }

  const body = value[kind];
  if (kind === 'recv' || kind === 'send') {
    if (!isRecord(body)) {
      problems.push(`${fixtureId}: step ${index} ${kind} must be a JSON-RPC object`);
      return undefined;
    }
    if (kind === 'send' && !step.raw && body['jsonrpc'] !== '2.0') {
      problems.push(`${fixtureId}: step ${index} send must carry jsonrpc "2.0"`);
    }
    validateMatcherTokens(body, fixtureId, index, kind, captures, problems);
    step[kind] = body;
    return step;
  }

  if (kind === 'connect') {
    const instruction = parseConnectInstruction(body, fixtureId, index, problems);
    if (instruction) step.connect = instruction;
    return instruction ? step : undefined;
  }
  if (kind === 'reconnect') {
    if (body === true) {
      step.reconnect = true;
      return step;
    }
    const instruction = parseConnectInstruction(body, fixtureId, index, problems);
    if (instruction) step.reconnect = instruction;
    return instruction ? step : undefined;
  }
  if (kind === 'dropTransport') {
    if (body !== true) problems.push(`${fixtureId}: step ${index} dropTransport must be true`);
    step.dropTransport = true;
    return step;
  }
  if (kind === 'expectClosed') {
    const expectation = parseCloseExpectation(body, fixtureId, index, problems);
    if (expectation) step.expectClosed = expectation;
    return expectation ? step : undefined;
  }
  if (kind === 'expectSilence') {
    validateMatcherTokens(body, fixtureId, index, kind, captures, problems);
    step.expectSilence = body;
    return step;
  }

  const expectation = parseFileModeExpectation(body, fixtureId, index, problems);
  if (expectation) step.expectFileMode = expectation;
  return expectation ? step : undefined;
}

function parseConnectInstruction(
  value: unknown,
  fixtureId: string,
  index: number,
  problems: string[],
): ConnectInstruction | undefined {
  if (!isRecord(value)) {
    problems.push(`${fixtureId}: step ${index} connect instruction must be an object`);
    return undefined;
  }
  const instruction: ConnectInstruction = {};
  if (value['bindCode'] !== undefined) {
    if (typeof value['bindCode'] !== 'string' || value['bindCode'].length === 0) {
      problems.push(`${fixtureId}: step ${index} bindCode must be a non-empty string`);
    } else {
      instruction.bindCode = value['bindCode'];
    }
  }
  if (value['expect'] !== undefined) {
    const expectation = parseConnectExpectation(value['expect'], fixtureId, index, problems);
    if (expectation) instruction.expect = expectation;
  }
  return instruction;
}

function parseConnectExpectation(
  value: unknown,
  fixtureId: string,
  index: number,
  problems: string[],
): ConnectExpectation | undefined {
  if (value === 'open') return value;
  if (!isRecord(value)) {
    problems.push(`${fixtureId}: step ${index} connect expect has an invalid shape`);
    return undefined;
  }
  if (typeof value['upgradeStatus'] === 'number') {
    return { upgradeStatus: value['upgradeStatus'] };
  }
  if (typeof value['bindErrorCode'] === 'number') {
    const expectation: { bindErrorCode: number; closes?: boolean } = {
      bindErrorCode: value['bindErrorCode'],
    };
    if (value['closes'] !== undefined) {
      if (typeof value['closes'] !== 'boolean') {
        problems.push(`${fixtureId}: step ${index} closes must be boolean`);
      } else {
        expectation.closes = value['closes'];
      }
    }
    return expectation;
  }
  problems.push(`${fixtureId}: step ${index} connect expect needs upgradeStatus or bindErrorCode`);
  return undefined;
}

function parseCloseExpectation(
  value: unknown,
  fixtureId: string,
  index: number,
  problems: string[],
): true | CloseExpectation | undefined {
  if (value === true) return true;
  if (!isRecord(value)) {
    problems.push(`${fixtureId}: step ${index} expectClosed must be true or an object`);
    return undefined;
  }
  const expectation: CloseExpectation = {};
  if (value['code'] !== undefined) {
    if (typeof value['code'] !== 'number') {
      problems.push(`${fixtureId}: step ${index} close code must be a number`);
    } else {
      expectation.code = value['code'];
    }
  }
  if (value['reason'] !== undefined) {
    if (typeof value['reason'] !== 'string') {
      problems.push(`${fixtureId}: step ${index} close reason must be a string`);
    } else {
      expectation.reason = value['reason'];
    }
  }
  return expectation;
}

function parseFileModeExpectation(
  value: unknown,
  fixtureId: string,
  index: number,
  problems: string[],
): FileModeExpectation | undefined {
  if (!isRecord(value)) {
    problems.push(`${fixtureId}: step ${index} expectFileMode must be an object`);
    return undefined;
  }
  const target = value['target'];
  const mode = value['mode'];
  if (target !== 'socket' && target !== 'parent') {
    problems.push(`${fixtureId}: step ${index} file mode target must be socket or parent`);
    return undefined;
  }
  if (mode !== '0600' && mode !== '0700') {
    problems.push(`${fixtureId}: step ${index} file mode must be 0600 or 0700`);
    return undefined;
  }
  return { target, mode };
}

function validateMatcherTokens(
  value: unknown,
  fixtureId: string,
  stepIndex: number,
  kind: 'expectSilence' | 'recv' | 'send',
  captures: Set<string>,
  problems: string[],
): void {
  for (const token of matcherTokens(value)) {
    if (kind === 'send' && !token.startsWith('~ref:')) {
      problems.push(`${fixtureId}: step ${stepIndex} send accepts only ~ref matchers (${token})`);
      continue;
    }
    if (SIMPLE_MATCHERS.has(token)) continue;
    if (token.startsWith('~regex:')) {
      try {
        new RegExp(token.slice('~regex:'.length));
      } catch (error) {
        problems.push(`${fixtureId}: step ${stepIndex} invalid regex (${errorMessage(error)})`);
      }
      continue;
    }
    if (token.startsWith('~capture:')) {
      const name = token.slice('~capture:'.length);
      if (kind !== 'recv') {
        problems.push(`${fixtureId}: step ${stepIndex} capture is valid only on recv`);
      } else if (name.length === 0 || captures.has(name)) {
        problems.push(`${fixtureId}: step ${stepIndex} capture name is empty or duplicated`);
      } else {
        captures.add(name);
      }
      continue;
    }
    if (token.startsWith('~ref:')) {
      const name = token.slice('~ref:'.length);
      if (!captures.has(name)) {
        problems.push(`${fixtureId}: step ${stepIndex} ref ${JSON.stringify(name)} is not bound`);
      }
      continue;
    }
    problems.push(`${fixtureId}: step ${stepIndex} unknown matcher ${token}`);
  }
}

function* matcherTokens(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    if (value.startsWith('~')) yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) yield* matcherTokens(entry);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) yield* matcherTokens(entry);
  }
}

function validateFixtureApp(
  fixture: Record<string, unknown>,
  requirements: string[],
  fixtureId: string,
  problems: string[],
): void {
  validateKnownFields(
    fixture,
    new Set(['actions', 'resources', 'hostMintedClaim']),
    fixtureId,
    problems,
  );
  validateFixtureActions(fixture['actions'], fixtureId, problems);
  validateFixtureResources(fixture['resources'], fixtureId, problems);

  const claim = fixture['hostMintedClaim'];
  if (claim !== undefined) {
    if (
      !isRecord(claim) ||
      !nonEmptyString(claim['code']) ||
      !nonEmptyString(claim['sessionId']) ||
      !nonEmptyString(claim['resumeToken'])
    ) {
      problems.push(`${fixtureId}: fixture.hostMintedClaim needs code, sessionId, and resumeToken`);
    } else {
      validateKnownFields(
        claim,
        new Set(['code', 'sessionId', 'resumeToken']),
        `${fixtureId}: fixture.hostMintedClaim`,
        problems,
      );
    }
  }
  if ((claim !== undefined) !== requirements.includes('host-minted-claim')) {
    problems.push(
      `${fixtureId}: fixture.hostMintedClaim and the host-minted-claim requirement must appear together`,
    );
  }
}

function validateFixtureActions(value: unknown, fixtureId: string, problems: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    problems.push(`${fixtureId}: fixture.actions must be an array`);
    return;
  }
  const knownFields = new Set([
    'name',
    'description',
    'returns',
    'inputSchema',
    'blocksUntilCancelled',
    'confirms',
    'returnsConfirmResult',
    'progress',
    'assertHandlerNotCalled',
    'elicits',
  ]);
  for (const [index, action] of value.entries()) {
    const location = `${fixtureId}: fixture.actions[${index}]`;
    if (!isRecord(action) || !nonEmptyString(action['name'])) {
      problems.push(`${location} needs a name`);
      continue;
    }
    validateKnownFields(action, knownFields, location, problems);
    validateOptionalType(action, 'description', 'string', location, problems);
    validateOptionalType(action, 'blocksUntilCancelled', 'boolean', location, problems);
    validateOptionalType(action, 'confirms', 'string', location, problems);
    validateOptionalType(action, 'returnsConfirmResult', 'boolean', location, problems);
    validateOptionalType(action, 'assertHandlerNotCalled', 'boolean', location, problems);
    if (action['returnsConfirmResult'] === true && typeof action['confirms'] !== 'string') {
      problems.push(`${location}.returnsConfirmResult requires confirms`);
    }
    validateProgress(action['progress'], location, problems);
    if (action['elicits'] !== undefined) {
      const elicits = action['elicits'];
      if (
        !isRecord(elicits) ||
        !nonEmptyString(elicits['question']) ||
        !Object.hasOwn(elicits, 'jsonSchema')
      ) {
        problems.push(`${location}.elicits needs question and jsonSchema`);
      } else {
        validateKnownFields(
          elicits,
          new Set(['question', 'jsonSchema']),
          `${location}.elicits`,
          problems,
        );
      }
    }
  }
}

function validateProgress(value: unknown, location: string, problems: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    problems.push(`${location}.progress must be an array`);
    return;
  }
  for (const [index, update] of value.entries()) {
    const updateLocation = `${location}.progress[${index}]`;
    if (!isRecord(update)) {
      problems.push(`${updateLocation} must be an object`);
      continue;
    }
    validateKnownFields(update, new Set(['percent', 'message', 'data']), updateLocation, problems);
    validateOptionalType(update, 'percent', 'number', updateLocation, problems);
    validateOptionalType(update, 'message', 'string', updateLocation, problems);
  }
}

function validateFixtureResources(value: unknown, fixtureId: string, problems: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    problems.push(`${fixtureId}: fixture.resources must be an array`);
    return;
  }
  const knownFields = new Set(['name', 'description', 'value', 'subscribable', 'emits']);
  for (const [index, resource] of value.entries()) {
    const location = `${fixtureId}: fixture.resources[${index}]`;
    if (!isRecord(resource) || !nonEmptyString(resource['name'])) {
      problems.push(`${location} needs a name`);
      continue;
    }
    validateKnownFields(resource, knownFields, location, problems);
    validateOptionalType(resource, 'description', 'string', location, problems);
    validateOptionalType(resource, 'subscribable', 'boolean', location, problems);
    const emissions = resource['emits'];
    if (emissions === undefined) continue;
    if (!Array.isArray(emissions)) {
      problems.push(`${location}.emits must be an array`);
      continue;
    }
    if (resource['subscribable'] !== true) problems.push(`${location}.emits requires subscribable`);
    for (const [emissionIndex, emission] of emissions.entries()) {
      const emissionLocation = `${location}.emits[${emissionIndex}]`;
      if (
        !isRecord(emission) ||
        !nonEmptyString(emission['afterStep']) ||
        !Object.hasOwn(emission, 'value')
      ) {
        problems.push(`${emissionLocation} needs afterStep and value`);
      } else {
        validateKnownFields(emission, new Set(['afterStep', 'value']), emissionLocation, problems);
      }
    }
  }
}

function validateEmissionLabels(
  fixture: Record<string, unknown>,
  labels: ReadonlySet<string>,
  fixtureId: string,
  problems: string[],
): void {
  const resources = fixture['resources'];
  if (!Array.isArray(resources)) return;
  for (const [resourceIndex, resource] of resources.entries()) {
    if (!isRecord(resource) || !Array.isArray(resource['emits'])) continue;
    for (const [emissionIndex, emission] of resource['emits'].entries()) {
      if (!isRecord(emission) || typeof emission['afterStep'] !== 'string') continue;
      if (!labels.has(emission['afterStep'])) {
        problems.push(
          `${fixtureId}: fixture.resources[${resourceIndex}].emits[${emissionIndex}] references unknown step label ${JSON.stringify(emission['afterStep'])}`,
        );
      }
    }
  }
}

function validateKnownFields(
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  location: string,
  problems: string[],
): void {
  for (const field of Object.keys(value)) {
    if (!knownFields.has(field))
      problems.push(`${location} has unknown field ${JSON.stringify(field)}`);
  }
}

function validateOptionalType(
  value: Record<string, unknown>,
  field: string,
  expectedType: 'boolean' | 'number' | 'string',
  location: string,
  problems: string[],
): void {
  const fieldValue = value[field];
  if (fieldValue === undefined) return;
  const matches =
    (expectedType === 'boolean' && typeof fieldValue === 'boolean') ||
    (expectedType === 'number' && typeof fieldValue === 'number') ||
    (expectedType === 'string' && typeof fieldValue === 'string');
  if (!matches) problems.push(`${location}.${field} must be a ${expectedType}`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseUnsupported(value: string | undefined): Set<string> {
  if (value === undefined || value.trim() === '') return new Set();
  const unsupported = new Set<string>();
  const problems: string[] = [];
  for (const rawTag of value.split(',')) {
    const tag = rawTag.trim();
    if (!KNOWN_REQUIREMENTS.has(tag)) problems.push(`Unknown unsupported capability: ${tag}`);
    else if (unsupported.has(tag)) problems.push(`Duplicate unsupported capability: ${tag}`);
    else unsupported.add(tag);
  }
  if (problems.length > 0) throw new FixtureSchemaError(problems);
  return unsupported;
}

export function matchesIdGlob(id: string, glob: string): boolean {
  let pattern = '^';
  for (const character of glob) {
    if (character === '*') pattern += '.*';
    else if (character === '?') pattern += '.';
    else pattern += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${pattern}$`).test(id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
