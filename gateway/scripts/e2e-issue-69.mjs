/**
 * Issue #69 end-to-end validation.
 *
 * Spawns the rebuilt plugin bundle (`plugin/server/index.cjs`) as the actual
 * MCP gateway, dials it via the official MCP SDK over stdio, and walks
 * through the recovery scenario from issue #69:
 *
 *   1. Wait for the live browser tab's claim code to appear in
 *      `tesseron__list_pending_claims`.
 *   2. Claim it. Invoke `todos__addTodo` to confirm the path is hot.
 *   3. Ask the operator to refresh the browser tab (which mints a fresh
 *      claim code). Wait for the gateway to discover the new code.
 *   4. Try the cached `todos__addTodo` tool — must return the *new*
 *      improved error (mentions the new code + recovery tool).
 *   5. Call `tesseron__list_pending_claims` — must surface the new code.
 *   6. Claim it. Re-invoke `todos__addTodo` — must succeed.
 *
 * Run with `node packages/mcp/scripts/e2e-issue-69.mjs`. Expects the
 * react-todo dev server to be running on http://localhost:5174 with one
 * pending instance.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const bundle = resolve(repoRoot, 'plugin/server/index.cjs');

if (!existsSync(bundle)) {
  console.error(
    `[e2e] gateway bundle not found at ${bundle}. Run \`pnpm build:plugin\` from the repo root first.`,
  );
  process.exit(1);
}

console.log(`[e2e] gateway bundle: ${bundle}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundle],
});

const client = new Client(
  { name: 'e2e-issue-69', version: '0.0.0' },
  {
    capabilities: { sampling: {}, elicitation: {} },
  },
);

await client.connect(transport);
console.log('[e2e] MCP client connected');

async function callTool(name, args) {
  const r = await client.request(
    { method: 'tools/call', params: { name, arguments: args ?? {} } },
    CallToolResultSchema,
  );
  const text = r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('');
  return { text, isError: r.isError === true };
}

async function listToolNames() {
  const r = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
  return r.tools.map((t) => t.name);
}

function fail(msg) {
  console.error(`[e2e] FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`[e2e] PASS: ${msg}`);
}

async function waitForPendingCode(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await callTool('tesseron__list_pending_claims', {});
    if (r.text.startsWith('{')) {
      const payload = JSON.parse(r.text);
      const match = payload.pending_claims.find(predicate);
      if (match) return match;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${label}: no matching pending claim within ${timeoutMs}ms`);
}

try {
  // Step 0: confirm the new tool is exposed.
  const tools = await listToolNames();
  console.log(`[e2e] tools: ${tools.join(', ')}`);
  if (!tools.includes('tesseron__list_pending_claims')) {
    fail('tesseron__list_pending_claims is not in tools/list');
  }
  pass('tesseron__list_pending_claims appears in tools/list');

  // Step 1: discover the live browser tab's pending claim.
  const pendingBefore = await waitForPendingCode(
    (c) => c.app_id === 'todos' || c.app_id === 'react-todo',
    'initial pending claim',
  );
  console.log(`[e2e] discovered pending claim: ${JSON.stringify(pendingBefore)}`);
  pass('list_pending_claims surfaces the live browser tab claim code');

  // Step 2: claim it. The pre-bind list_pending_claims may report the
  // manifest's `appName` (filesystem-friendly, e.g. "react-todo") rather
  // than the SDK's real `app.id` ("todos"); the issue #69 fix populates
  // the manifestAppName→appId cache once the bind completes, so subsequent
  // list_pending_claims calls report the agent-visible app id.
  const firstClaim = await callTool('tesseron__claim_session', { code: pendingBefore.code });
  if (firstClaim.isError) fail(`first claim failed: ${firstClaim.text}`);
  pass(`first claim succeeded: ${firstClaim.text.slice(0, 100)}...`);

  // Parse the real app.id out of the claim result body (which lists
  // `<app_id>__<action>` tool names). This is what an agent would learn
  // from `tools/list_changed` after claim.
  const toolMatch = firstClaim.text.match(/(\w+)__\w+/);
  if (!toolMatch) fail('could not extract app_id from claim result');
  const appId = toolMatch[1];
  console.log(
    `[e2e] real app.id from bind: "${appId}" (manifest appName was "${pendingBefore.app_id}")`,
  );

  const addOk = await callTool(`${appId}__addTodo`, { text: 'pre-refresh todo' });
  if (addOk.isError) fail(`addTodo on fresh session failed: ${addOk.text}`);
  pass(`addTodo on fresh session: ${addOk.text}`);

  // Step 3: pause for the operator to refresh the browser. Wait for a code
  // that's both fresh-on-disk AND different from the one we already bound,
  // ignoring any leftover manifests from previous test runs.
  // After my fix, the cache is populated by the successful bind above, so the
  // post-refresh pending claim should report `app_id` matching the SDK's real
  // app.id (the same prefix the agent's cached `<app_id>__<action>` tools use).
  const firstBindAt = Date.now();
  console.log(
    '\n[e2e] >>> REFRESH THE BROWSER TAB NOW (test waits 30s for a NEW claim code) <<<\n',
  );
  const pendingAfter = await waitForPendingCode(
    (c) =>
      c.app_id === appId &&
      c.code !== pendingBefore.code &&
      c.minted_at > firstBindAt &&
      c.source === 'host-minted',
    'post-refresh pending claim',
    30_000,
  );
  console.log(`[e2e] discovered new pending claim: ${JSON.stringify(pendingAfter)}`);
  if (pendingAfter.app_id !== appId) {
    fail(
      `post-refresh entry app_id "${pendingAfter.app_id}" does not match expected "${appId}" — manifestAppName→appId cache failed to populate`,
    );
  }
  pass(
    `list_pending_claims reports correct agent-visible app_id "${appId}" after refresh (cache populated by first bind)`,
  );

  // Step 4: cached tool call must hit the new error path.
  const stale = await callTool(`${appId}__addTodo`, { text: 'should fail' });
  if (!stale.isError) fail(`expected stale invoke to error, got: ${stale.text}`);
  console.log(`[e2e] stale invoke error body: ${stale.text}`);
  if (!stale.text.includes('tesseron__list_pending_claims')) {
    fail('stale-invoke error body does not name tesseron__list_pending_claims');
  }
  if (!stale.text.includes(pendingAfter.code)) {
    fail(`stale-invoke error body does not inline the new claim code ${pendingAfter.code}`);
  }
  pass('stale invoke surfaces improved error with new code + recovery tool name');

  // Step 5: claim the new code via the same MCP tool.
  const reclaim = await callTool('tesseron__claim_session', { code: pendingAfter.code });
  if (reclaim.isError) fail(`reclaim failed: ${reclaim.text}`);
  pass(`reclaim succeeded: ${reclaim.text.slice(0, 100)}...`);

  // Step 6: action works again.
  const addAgain = await callTool(`${appId}__addTodo`, { text: 'post-recovery todo' });
  if (addAgain.isError) fail(`post-recovery addTodo failed: ${addAgain.text}`);
  pass(`post-recovery addTodo: ${addAgain.text}`);

  console.log('\n[e2e] ALL CHECKS PASSED');
  process.exit(0);
} catch (err) {
  console.error('[e2e] uncaught error:', err);
  process.exit(1);
} finally {
  // Surface cleanup errors as warnings instead of swallowing them — a wedged
  // gateway or half-closed stdio pipe is worth knowing about even after the
  // checks pass. Don't flip the exit code: the test result itself is the
  // contract this script reports.
  await client
    .close()
    .catch((e) => console.warn('[e2e] client.close failed:', e instanceof Error ? e.message : e));
  await Promise.resolve(transport.close()).catch((e) =>
    console.warn('[e2e] transport.close failed:', e instanceof Error ? e.message : e),
  );
}
