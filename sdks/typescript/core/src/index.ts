/**
 * Public API surface for @tesseron/core.
 *
 * Internal helpers used by sibling packages live under
 * `@tesseron/core/internal` and are NOT part of the semver contract.
 */

export * from './protocol.js';
export * from './context.js';
export * from './builder.js';
export * from './errors.js';
export * from './transport.js';
export * from './transport-spec.js';
export {
  TesseronClient,
  type AppConfig,
  type ConnectOptions,
  type ResumeCredentials,
} from './client.js';
