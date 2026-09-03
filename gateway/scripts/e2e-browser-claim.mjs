/**
 * End-to-end validation of the host-mint claim flow against a real Vite
 * dev server with a real browser tab open. Spawns an in-process gateway
 * pointed at the live `~/.tesseron/instances/` directory, runs the same
 * MCP claim flow Claude Code would, and verifies the session registers
 * with the host-minted ids the SDK already showed in its UI.
 *
 * Usage: pass the claim code (read from the browser DOM) as argv[2].
 *   node scripts/e2e-browser-claim.mjs VQNJ-C6
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpAgentBridge, TesseronGateway } from '@tesseron/mcp';

const code = process.argv[2];
if (!code) {
  console.error('usage: node e2e-browser-claim.mjs <claim-code>');
  process.exit(1);
}

const gateway = new TesseronGateway();
gateway.watchInstances();
const bridge = new McpAgentBridge({ gateway });
const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
await bridge.connect(gatewaySide);
const client = new Client({ name: 'browser-e2e', version: '0.0.0' });
await client.connect(agentSide);

console.log('[e2e] gateway up; waiting 3s for discovery to register the manifest...');
await new Promise((r) => setTimeout(r, 3000));

console.log(`[e2e] calling tesseron__claim_session with code ${code}...`);
const claimResult = await client.request(
  {
    method: 'tools/call',
    params: { name: 'tesseron__claim_session', arguments: { code } },
  },
  CallToolResultSchema,
);

console.log('[e2e] claim result:', JSON.stringify(claimResult, null, 2));
if (claimResult.isError) {
  console.error('[e2e] CLAIM FAILED');
  process.exit(2);
}

await new Promise((r) => setTimeout(r, 200));
const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
const todoTools = tools.tools.filter((t) => t.name.startsWith('vanilla_todo__'));
console.log(`[e2e] gateway exposes ${todoTools.length} vanilla_todo actions:`);
for (const t of todoTools) console.log(`  - ${t.name}`);

if (todoTools.length === 0) {
  console.error('[e2e] FAIL: no vanilla_todo tools registered after claim');
  process.exit(3);
}

console.log('[e2e] invoking vanilla_todo__addTodo to verify end-to-end action flow...');
const addResult = await client.request(
  {
    method: 'tools/call',
    params: {
      name: 'vanilla_todo__addTodo',
      arguments: { text: 'wired by e2e from MCP', tag: 'e2e' },
    },
  },
  CallToolResultSchema,
);
console.log('[e2e] addTodo result:', JSON.stringify(addResult.content, null, 2));
if (addResult.isError) {
  console.error('[e2e] FAIL: addTodo errored');
  process.exit(4);
}

await client.close();
await gateway.stop();
console.log('[e2e] PASS: full host-mint claim flow worked end-to-end with a real browser');
