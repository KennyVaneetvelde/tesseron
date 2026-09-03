/**
 * App-id validation, shared between the SDK host transports and the MCP
 * gateway. The SDK needs to apply these checks before sending hello (so
 * a misconfigured app surfaces the error at `connect()` time rather than
 * after a network round-trip), and the gateway re-applies them as
 * defence-in-depth on its own hello handler. Defining the regex and the
 * reserved-id set in one place keeps the two paths from drifting.
 */

const RESERVED_APP_IDS = new Set(['tesseron', 'mcp', 'system']);
const APP_ID_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Throws `Error` with a clear message when `id` is not a legal Tesseron
 * app id. Use at SDK hello-construction time AND at gateway hello-handler
 * time; both layers must reject identical inputs identically.
 */
export function validateAppId(id: string): void {
  if (!APP_ID_RE.test(id)) {
    throw new Error(`Invalid app id "${id}". Must match /^[a-z][a-z0-9_]*$/.`);
  }
  if (RESERVED_APP_IDS.has(id)) {
    throw new Error(`App id "${id}" is reserved. Choose a different identifier.`);
  }
}
