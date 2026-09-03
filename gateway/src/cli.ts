#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type GatewayOptions, TesseronGateway } from './gateway.js';
import { McpAgentBridge, type ToolSurfaceMode } from './mcp-bridge.js';

function toolSurfaceFromEnv(): ToolSurfaceMode {
  const v = process.env['TESSERON_TOOL_SURFACE'];
  if (v === 'dynamic' || v === 'meta' || v === 'both') return v;
  return 'both';
}

/**
 * Parses `TESSERON_RESUME_TTL_MS`. Accepts a non-negative integer (ms);
 * `0` disables resume entirely (same contract as `GatewayOptions.resumeTtlMs`).
 * Anything else logs a warning to stderr and falls through to the gateway's
 * default — invalid env values are non-fatal so a typo doesn't take a session
 * offline.
 */
function resumeTtlFromEnv(): number | undefined {
  const raw = process.env['TESSERON_RESUME_TTL_MS'];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(
      `[tesseron] ignoring TESSERON_RESUME_TTL_MS=${JSON.stringify(raw)} — expected a non-negative integer (milliseconds)\n`,
    );
    return undefined;
  }
  return parsed;
}

async function main(): Promise<void> {
  const toolSurface = toolSurfaceFromEnv();
  const resumeTtlMs = resumeTtlFromEnv();

  const gatewayOptions: GatewayOptions = {};
  if (resumeTtlMs !== undefined) gatewayOptions.resumeTtlMs = resumeTtlMs;

  const gateway = new TesseronGateway(gatewayOptions);
  gateway.watchAppsJson();
  process.stderr.write('[tesseron] watching ~/.tesseron/tabs/ for app connections\n');
  process.stderr.write(`[tesseron] tool surface mode: ${toolSurface}\n`);
  if (resumeTtlMs !== undefined) {
    process.stderr.write(`[tesseron] resume TTL: ${resumeTtlMs}ms (from TESSERON_RESUME_TTL_MS)\n`);
  }

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
