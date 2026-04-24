#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TesseronGateway } from './gateway.js';
import { McpAgentBridge, type ToolSurfaceMode } from './mcp-bridge.js';

function toolSurfaceFromEnv(): ToolSurfaceMode {
  const v = process.env['TESSERON_TOOL_SURFACE'];
  if (v === 'dynamic' || v === 'meta' || v === 'both') return v;
  return 'both';
}

async function main(): Promise<void> {
  const toolSurface = toolSurfaceFromEnv();

  const gateway = new TesseronGateway();
  gateway.watchAppsJson();
  process.stderr.write('[tesseron] watching ~/.tesseron/tabs/ for app connections\n');
  process.stderr.write(`[tesseron] tool surface mode: ${toolSurface}\n`);

  const bridge = new McpAgentBridge({ gateway, toolSurface });
  await bridge.connect(new StdioServerTransport());
  process.stderr.write('[tesseron] MCP stdio bridge ready\n');

  const shutdown = async (): Promise<void> => {
    process.stderr.write('[tesseron] shutting down\n');
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[tesseron] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
