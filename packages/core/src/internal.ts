/**
 * Internal: used by sibling packages (@tesseron/web, /server, /mcp, /react)
 * and the @tesseron/core test suite. NOT part of the public API contract.
 *
 * Symbols exposed here are subject to change without a major version bump.
 * Do not import from `@tesseron/core/internal` in application code — use
 * `@tesseron/core` instead.
 */

export { JsonRpcDispatcher } from './dispatcher.js';
export {
  CONFIRM_REQUESTED_SCHEMA,
  PERMISSIVE_ELICIT_SCHEMA,
  assertValidElicitSchema,
  permissiveJsonSchema,
  standardValidate,
  type ValidationFailure,
  type ValidationOutcome,
  type ValidationSuccess,
} from './schema-helpers.js';
export {
  ActionBuilderImpl,
  ResourceBuilderImpl,
  type ActionBuilderInit,
  type BuilderRegistry,
} from './builder-impl.js';
export { SDK_CAPABILITIES } from './client.js';
export { constantTimeEqual } from './timing-safe.js';
