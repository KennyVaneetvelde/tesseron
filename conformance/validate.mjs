#!/usr/bin/env node
/**
 * Validates the fixture corpus against the format documented in README.md.
 *
 * This never opens a socket. It checks fixture source files before a bad
 * fixture can look like a failure in a language port.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const KNOWN_REQUIREMENTS = new Set([
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
const MATCHER_TYPES = new Set(['any', 'string', 'number', 'boolean', 'object', 'array', 'absent']);
const STEP_KINDS = [
  'recv',
  'send',
  'connect',
  'reconnect',
  'expectClosed',
  'expectSilence',
  'expectFileMode',
  'dropTransport',
];
const problems = [];

function report(fixtureId, message) {
  problems.push(`${fixtureId}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectFixtureFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...collectFixtureFiles(path));
    else if (entry.endsWith('.json')) found.push(path);
  }
  return found;
}

function* matcherTokens(node) {
  if (typeof node === 'string') {
    if (node.startsWith('~')) yield node.slice(1);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) yield* matcherTokens(item);
    return;
  }
  if (isRecord(node)) {
    for (const value of Object.values(node)) yield* matcherTokens(value);
  }
}

function checkMatcher(fixtureId, token, captured, stepKind) {
  if (stepKind === 'send' && !token.startsWith('ref:')) {
    report(fixtureId, `~${token} used in a send step; send accepts only ~ref`);
    return;
  }
  if (MATCHER_TYPES.has(token)) return;
  if (token.startsWith('regex:')) {
    try {
      new RegExp(token.slice('regex:'.length));
    } catch (error) {
      report(fixtureId, `~regex is not a valid pattern: ${error.message}`);
    }
    return;
  }
  if (token.startsWith('capture:')) {
    const name = token.slice('capture:'.length);
    if (!name) report(fixtureId, '~capture needs a name');
    else if (stepKind !== 'recv') report(fixtureId, `~capture:${name} is valid only on recv`);
    else if (captured.has(name)) report(fixtureId, `~capture:${name} declared twice`);
    else captured.add(name);
    return;
  }
  if (token.startsWith('ref:')) {
    const name = token.slice('ref:'.length);
    if (!captured.has(name)) report(fixtureId, `~ref:${name} is used before capture`);
    return;
  }
  report(fixtureId, `unknown matcher ~${token}`);
}

function validateRequirements(fixtureId, requirements) {
  if (!Array.isArray(requirements)) {
    report(fixtureId, 'needs a requires array (use [] when it applies to every host)');
    return;
  }
  const seen = new Set();
  for (const requirement of requirements) {
    if (typeof requirement !== 'string' || !KNOWN_REQUIREMENTS.has(requirement)) {
      report(fixtureId, `unknown requires tag ${JSON.stringify(requirement)}`);
    } else if (seen.has(requirement)) {
      report(fixtureId, `duplicate requires tag ${JSON.stringify(requirement)}`);
    }
    seen.add(requirement);
  }
}

function validateFixtureApp(fixtureId, fixture, requirements) {
  if (!isRecord(fixture)) {
    report(fixtureId, 'fixture must be an object');
    return;
  }
  validateKnownFields(fixtureId, 'fixture', fixture, ['actions', 'resources', 'hostMintedClaim']);
  if (fixture.actions !== undefined) {
    if (!Array.isArray(fixture.actions)) report(fixtureId, 'fixture.actions must be an array');
    else fixture.actions.forEach((action, index) => validateAction(fixtureId, action, index));
  }
  if (fixture.resources !== undefined) {
    if (!Array.isArray(fixture.resources)) report(fixtureId, 'fixture.resources must be an array');
    else
      fixture.resources.forEach((resource, index) => validateResource(fixtureId, resource, index));
  }
  const claim = fixture.hostMintedClaim;
  if (claim !== undefined) {
    if (
      !isRecord(claim) ||
      !nonEmptyString(claim.code) ||
      !nonEmptyString(claim.sessionId) ||
      !nonEmptyString(claim.resumeToken)
    ) {
      report(fixtureId, 'fixture.hostMintedClaim needs code, sessionId, and resumeToken');
    } else {
      validateKnownFields(fixtureId, 'fixture.hostMintedClaim', claim, [
        'code',
        'sessionId',
        'resumeToken',
      ]);
    }
  }
  const hasRequirement = Array.isArray(requirements) && requirements.includes('host-minted-claim');
  if ((claim !== undefined) !== hasRequirement) {
    report(
      fixtureId,
      'fixture.hostMintedClaim and the host-minted-claim requirement must appear together',
    );
  }
}

function validateAction(fixtureId, action, index) {
  const location = `fixture.actions[${index}]`;
  if (!isRecord(action) || !nonEmptyString(action.name)) {
    report(fixtureId, `${location} needs a name`);
    return;
  }
  validateKnownFields(fixtureId, location, action, [
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
  validateOptionalType(fixtureId, location, action, 'description', 'string');
  validateOptionalType(fixtureId, location, action, 'blocksUntilCancelled', 'boolean');
  validateOptionalType(fixtureId, location, action, 'confirms', 'string');
  validateOptionalType(fixtureId, location, action, 'returnsConfirmResult', 'boolean');
  validateOptionalType(fixtureId, location, action, 'assertHandlerNotCalled', 'boolean');
  if (action.returnsConfirmResult === true && typeof action.confirms !== 'string') {
    report(fixtureId, `${location}.returnsConfirmResult requires confirms`);
  }
  if (action.progress !== undefined) {
    if (!Array.isArray(action.progress)) report(fixtureId, `${location}.progress must be an array`);
    else
      action.progress.forEach((update, updateIndex) => {
        const updateLocation = `${location}.progress[${updateIndex}]`;
        if (!isRecord(update)) report(fixtureId, `${updateLocation} must be an object`);
        else {
          validateKnownFields(fixtureId, updateLocation, update, ['percent', 'message', 'data']);
          validateOptionalType(fixtureId, updateLocation, update, 'percent', 'number');
          validateOptionalType(fixtureId, updateLocation, update, 'message', 'string');
        }
      });
  }
  if (action.elicits !== undefined) {
    const elicits = action.elicits;
    if (
      !isRecord(elicits) ||
      !nonEmptyString(elicits.question) ||
      !Object.hasOwn(elicits, 'jsonSchema')
    ) {
      report(fixtureId, `${location}.elicits needs question and jsonSchema`);
    } else {
      validateKnownFields(fixtureId, `${location}.elicits`, elicits, ['question', 'jsonSchema']);
    }
  }
}

function validateResource(fixtureId, resource, index) {
  const location = `fixture.resources[${index}]`;
  if (!isRecord(resource) || !nonEmptyString(resource.name)) {
    report(fixtureId, `${location} needs a name`);
    return;
  }
  validateKnownFields(fixtureId, location, resource, [
    'name',
    'description',
    'value',
    'subscribable',
    'emits',
  ]);
  validateOptionalType(fixtureId, location, resource, 'description', 'string');
  validateOptionalType(fixtureId, location, resource, 'subscribable', 'boolean');
  if (resource.emits === undefined) return;
  if (!Array.isArray(resource.emits)) {
    report(fixtureId, `${location}.emits must be an array`);
    return;
  }
  if (resource.subscribable !== true) report(fixtureId, `${location}.emits requires subscribable`);
  resource.emits.forEach((emission, emissionIndex) => {
    const emissionLocation = `${location}.emits[${emissionIndex}]`;
    if (
      !isRecord(emission) ||
      !nonEmptyString(emission.afterStep) ||
      !Object.hasOwn(emission, 'value')
    ) {
      report(fixtureId, `${emissionLocation} needs afterStep and value`);
    } else {
      validateKnownFields(fixtureId, emissionLocation, emission, ['afterStep', 'value']);
    }
  });
}

function validateKnownFields(fixtureId, location, value, knownFields) {
  const known = new Set(knownFields);
  for (const field of Object.keys(value)) {
    if (!known.has(field))
      report(fixtureId, `${location} has unknown field ${JSON.stringify(field)}`);
  }
}

function validateOptionalType(fixtureId, location, value, field, expectedType) {
  const fieldValue = value[field];
  if (fieldValue === undefined) return;
  const matches =
    (expectedType === 'boolean' && typeof fieldValue === 'boolean') ||
    (expectedType === 'number' && typeof fieldValue === 'number') ||
    (expectedType === 'string' && typeof fieldValue === 'string');
  if (!matches) report(fixtureId, `${location}.${field} must be a ${expectedType}`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateConnect(fixtureId, stepIndex, instruction) {
  if (!isRecord(instruction)) {
    report(fixtureId, `step ${stepIndex} connect instruction must be an object`);
    return;
  }
  if (
    instruction.bindCode !== undefined &&
    (typeof instruction.bindCode !== 'string' || !instruction.bindCode)
  ) {
    report(fixtureId, `step ${stepIndex} bindCode must be a non-empty string`);
  }
  const expectation = instruction.expect;
  if (expectation === undefined || expectation === 'open') return;
  if (!isRecord(expectation)) {
    report(fixtureId, `step ${stepIndex} connect expect has an invalid shape`);
    return;
  }
  const hasUpgradeStatus = typeof expectation.upgradeStatus === 'number';
  const hasBindErrorCode = typeof expectation.bindErrorCode === 'number';
  if (hasUpgradeStatus === hasBindErrorCode) {
    report(fixtureId, `step ${stepIndex} connect expect needs one result shape`);
  }
  if (
    expectation.closes !== undefined &&
    (!hasBindErrorCode || typeof expectation.closes !== 'boolean')
  ) {
    report(fixtureId, `step ${stepIndex} closes is valid only with bindErrorCode`);
  }
}

function validateStep(fixtureId, step, index, captured, labels) {
  if (!isRecord(step)) {
    report(fixtureId, `step ${index} must be an object`);
    return;
  }
  const kinds = STEP_KINDS.filter((kind) => Object.hasOwn(step, kind));
  if (kinds.length !== 1) {
    report(fixtureId, `step ${index} must contain exactly one kind (${STEP_KINDS.join(', ')})`);
    return;
  }
  const kind = kinds[0];
  let validLabel;
  if (step.label !== undefined) {
    if (typeof step.label !== 'string' || !step.label)
      report(fixtureId, `step ${index} label must be non-empty`);
    else if (labels.has(step.label))
      report(fixtureId, `step ${index} duplicates label ${JSON.stringify(step.label)}`);
    else validLabel = step.label;
  }
  if (step.notBefore !== undefined) {
    if (kind !== 'recv') report(fixtureId, `step ${index} notBefore is valid only on recv`);
    else if (typeof step.notBefore !== 'string' || !labels.has(step.notBefore)) {
      report(fixtureId, `step ${index} references a label that has not completed`);
    }
  }
  if (validLabel) labels.add(validLabel);
  if (step.timeoutMs !== undefined) {
    const acceptsTimeout = [
      'recv',
      'connect',
      'reconnect',
      'expectClosed',
      'expectSilence',
    ].includes(kind);
    if (
      typeof step.timeoutMs !== 'number' ||
      !Number.isFinite(step.timeoutMs) ||
      step.timeoutMs <= 0
    ) {
      report(fixtureId, `step ${index} timeoutMs must be a positive number`);
    } else if (!acceptsTimeout)
      report(fixtureId, `step ${index} ${kind} does not accept timeoutMs`);
  }
  if (kind === 'expectSilence' && step.timeoutMs === undefined) {
    report(fixtureId, `step ${index} expectSilence requires timeoutMs`);
  }

  const body = step[kind];
  if (kind === 'recv' || kind === 'send') {
    if (!isRecord(body)) {
      report(fixtureId, `step ${index} ${kind} must be a JSON-RPC frame object`);
      return;
    }
    if (kind === 'send' && body.jsonrpc !== '2.0') {
      report(fixtureId, `step ${index} send frame must carry "jsonrpc": "2.0"`);
    }
    for (const token of matcherTokens(body)) checkMatcher(fixtureId, token, captured, kind);
    return;
  }
  if (kind === 'connect') {
    validateConnect(fixtureId, index, body);
    return;
  }
  if (kind === 'reconnect') {
    if (body !== true) validateConnect(fixtureId, index, body);
    return;
  }
  if (kind === 'dropTransport') {
    if (body !== true) report(fixtureId, `step ${index} dropTransport must be true`);
    return;
  }
  if (kind === 'expectClosed') {
    if (body !== true && !isRecord(body))
      report(fixtureId, `step ${index} expectClosed must be true or an object`);
    else if (isRecord(body)) {
      if (body.code !== undefined && typeof body.code !== 'number')
        report(fixtureId, `step ${index} close code must be a number`);
      if (body.reason !== undefined && typeof body.reason !== 'string')
        report(fixtureId, `step ${index} close reason must be a string`);
    }
    return;
  }
  if (kind === 'expectSilence') {
    for (const token of matcherTokens(body)) checkMatcher(fixtureId, token, captured, kind);
    return;
  }
  if (kind === 'expectFileMode') {
    if (
      !isRecord(body) ||
      !['socket', 'parent'].includes(body.target) ||
      !['0600', '0700'].includes(body.mode)
    ) {
      report(
        fixtureId,
        `step ${index} expectFileMode needs target socket|parent and mode 0600|0700`,
      );
    }
  }
}

function validateEmissionLabels(fixtureId, fixture, labels) {
  if (!isRecord(fixture) || !Array.isArray(fixture.resources)) return;
  fixture.resources.forEach((resource, resourceIndex) => {
    if (!isRecord(resource) || !Array.isArray(resource.emits)) return;
    resource.emits.forEach((emission, emissionIndex) => {
      if (
        isRecord(emission) &&
        typeof emission.afterStep === 'string' &&
        !labels.has(emission.afterStep)
      ) {
        report(
          fixtureId,
          `fixture.resources[${resourceIndex}].emits[${emissionIndex}] references unknown step label ${JSON.stringify(emission.afterStep)}`,
        );
      }
    });
  });
}

function validateFixture(path) {
  const expectedId = relative(FIXTURES_ROOT, path)
    .split(sep)
    .join('/')
    .replace(/\.json$/, '');
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    report(expectedId, `is not valid JSON: ${error.message}`);
    return;
  }
  if (!isRecord(fixture)) {
    report(expectedId, 'fixture document must be an object');
    return;
  }
  if (fixture.id !== expectedId) report(expectedId, `id is ${JSON.stringify(fixture.id)}`);
  if (typeof fixture.title !== 'string' || !fixture.title) report(expectedId, 'needs a title');
  if (typeof fixture.spec !== 'string' || !fixture.spec.startsWith('/'))
    report(expectedId, 'needs an absolute spec anchor');
  validateRequirements(expectedId, fixture.requires);
  validateFixtureApp(expectedId, fixture.fixture, fixture.requires);
  if (!Array.isArray(fixture.steps) || fixture.steps.length === 0) {
    report(expectedId, 'needs at least one step');
    return;
  }
  const captured = new Set();
  const labels = new Set();
  fixture.steps.forEach((step, index) => validateStep(expectedId, step, index, captured, labels));
  if (
    fixture.steps.some((step) => isRecord(step) && Object.hasOwn(step, 'expectFileMode')) &&
    (!Array.isArray(fixture.requires) || !fixture.requires.includes('uds'))
  ) {
    report(expectedId, 'expectFileMode requires the uds capability tag');
  }
  validateEmissionLabels(expectedId, fixture.fixture, labels);
}

const files = collectFixtureFiles(FIXTURES_ROOT);
for (const file of files) validateFixture(file);

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) in ${files.length} fixture(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`${files.length} fixtures valid.`);
