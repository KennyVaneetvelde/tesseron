import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';

// Pinned in lockstep with `@tesseron/mcp` by `scripts/sync-plugin-version.mjs`.
// Do not edit by hand — `pnpm sync-plugin-version` rewrites this constant.
const TESSERON_MCP_VERSION = '2.6.1';

type JsonRpcId = number;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RawMcpContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

interface ToolCallResult {
  content?: RawMcpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Minimal stdio JSON-RPC 2.0 client for an MCP server child process.
 *
 * Does not depend on `@modelcontextprotocol/sdk` — its dep tree (express, hono,
 * ajv, ~30-50 MB installed) is not worth carrying for the narrow surface we
 * need here. We control both ends, so the framing is straightforward:
 * newline-delimited JSON on stdin/stdout, init handshake then `tools/call`.
 */
class StdioMcp {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId: JsonRpcId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private initPromise?: Promise<void>;
  private exited = false;

  constructor(
    private readonly spec: { command: string; args: string[] },
    private readonly label: string,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    await this.ensureInitialized();
    const result = (await this.request('tools/call', {
      name,
      arguments: args,
    })) as ToolCallResult;
    return result;
  }

  shutdown(): void {
    if (!this.child || this.exited) return;
    try {
      this.child.kill();
    } catch {
      // best-effort
    }
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((err) => {
        // Reset so the next call retries cleanly instead of returning a stale
        // rejected promise forever.
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    this.spawn();
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: '@tesseron/pi', version: TESSERON_MCP_VERSION },
    });
    this.notify('notifications/initialized', {});
  }

  private spawn(): void {
    const child = spawn(this.spec.command, this.spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // shell:false keeps argv structured. On Windows we use { cmd /c npx … }
      // so the shim is invoked via cmd; on POSIX we exec npx directly.
      shell: false,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', () => {
      // Discard MCP server stderr — Pi already shows it via the pi-coding-agent
      // log surface if anything goes wrong, and forwarding it as ctx.ui.notify
      // would be very noisy on cold-start (npx fetch + install).
    });
    child.on('exit', () => this.onExit());
    child.on('error', (err: Error) => this.onSpawnError(err));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handleMessage(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // notification or stray frame
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`[${this.label}] ${msg.error.message} (code ${msg.error.code})`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onExit(): void {
    this.exited = true;
    const err = new Error(`[${this.label}] MCP server exited`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  private onSpawnError(err: Error): void {
    this.exited = true;
    const wrapped = new Error(`[${this.label}] failed to spawn: ${err.message}`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(wrapped);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[${this.label}] ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: unknown): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // stdin closed; the exit handler will reject pending requests.
    }
  }
}

function npxSpec(pkg: string, version: string): { command: string; args: string[] } {
  // On Windows, libuv's raw uv_spawn cannot resolve .cmd shims without
  // shell:true. Routing through `cmd /c` sidesteps it.
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'npx', '-y', `${pkg}@${version}`] };
  }
  return { command: 'npx', args: ['-y', `${pkg}@${version}`] };
}

function normalizeContent(items: RawMcpContent[]): (TextContent | ImageContent)[] {
  return items.map((item): TextContent | ImageContent => {
    if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    ) {
      return { type: 'image', data: item.data, mimeType: item.mimeType };
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      return { type: 'text', text: item.text };
    }
    // Resource / audio / unknown content kinds — fall back to a stringified
    // text block so the model still sees the payload instead of empty content.
    return { type: 'text', text: JSON.stringify(item) };
  });
}

function textFromMcp(result: ToolCallResult): string {
  const parts = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  if (parts.length > 0) return parts.join('\n');
  return JSON.stringify(result.structuredContent ?? result, null, 2);
}

function passThroughResult(result: ToolCallResult): {
  content: (TextContent | ImageContent)[];
  details: ToolCallResult;
} {
  // Tesseron MCP errors arrive as `isError: true` with text content describing
  // the failure. Pi's runtime sets isError by THROW, not by returning a flag —
  // so re-raise so the tool result is reported as failed to the model.
  if (result.isError) {
    throw new Error(textFromMcp(result));
  }
  return {
    content: normalizeContent(result.content ?? []),
    details: result,
  };
}

const NoArgsSchema = Type.Object({}, { additionalProperties: false });

export default function tesseronExtension(pi: ExtensionAPI): void {
  const tesseron = new StdioMcp(npxSpec('@tesseron/mcp', TESSERON_MCP_VERSION), 'tesseron');
  const docs = new StdioMcp(npxSpec('@tesseron/docs-mcp', TESSERON_MCP_VERSION), 'tesseron-docs');

  pi.on('session_shutdown', () => {
    tesseron.shutdown();
    docs.shutdown();
  });

  // ---------- Gateway tools (5) ----------

  pi.registerTool({
    name: 'tesseron_claim_session',
    label: 'Tesseron: Claim Session',
    description:
      'Claim a pending Tesseron session by its 6-character code (format: XXXX-XX) so its actions appear as Tesseron tools. Web apps display this code when the user clicks "Connect Pi".',
    promptSnippet: 'Claim a Tesseron web-app session by 6-char code so its actions become callable',
    promptGuidelines: [
      'Use tesseron_claim_session when the user reads a 6-character claim code from a Tesseron-enabled web app.',
      'After tesseron_claim_session succeeds, call tesseron_list_actions to discover the app_id and which actions it exposes.',
    ],
    parameters: Type.Object({
      code: Type.String({ description: 'The 6-character claim code, e.g. "ABCD-23".' }),
    }),
    async execute(_id, params) {
      return passThroughResult(
        await tesseron.callTool('tesseron__claim_session', { code: params.code }),
      );
    },
  });

  pi.registerTool({
    name: 'tesseron_list_actions',
    label: 'Tesseron: List Actions',
    description:
      'List every action and resource registered by currently claimed Tesseron sessions, grouped by app_id.',
    promptSnippet: 'List Tesseron actions and resources currently exposed by claimed sessions',
    promptGuidelines: [
      'Call tesseron_list_actions before tesseron_invoke_action to discover the exact app_id + action name pair to call.',
    ],
    parameters: NoArgsSchema,
    async execute() {
      return passThroughResult(await tesseron.callTool('tesseron__list_actions', {}));
    },
  });

  pi.registerTool({
    name: 'tesseron_list_pending_claims',
    label: 'Tesseron: List Pending Claims',
    description:
      'List every claim code the gateway can currently redeem (gateway-minted sessions waiting for claim, plus host-minted manifests with an unconsumed code). Recovery path when a previously claimed session was invalidated mid-conversation.',
    promptSnippet:
      'List unredeemed Tesseron claim codes when a previously-claimed session has gone stale',
    promptGuidelines: [
      'Use tesseron_list_pending_claims when an action call returns "No claimed session found" — pick the entry whose app_id matches and re-claim with tesseron_claim_session.',
    ],
    parameters: NoArgsSchema,
    async execute() {
      return passThroughResult(await tesseron.callTool('tesseron__list_pending_claims', {}));
    },
  });

  pi.registerTool({
    name: 'tesseron_invoke_action',
    label: 'Tesseron: Invoke Action',
    description:
      'Invoke any action on a currently claimed Tesseron session by app_id and action name.',
    promptSnippet: 'Invoke a typed Tesseron action exposed by a claimed web app',
    promptGuidelines: [
      'Use tesseron_invoke_action to drive a Tesseron-enabled app via its typed action surface instead of browser automation.',
      'Pass the unprefixed action name (e.g. "addTodo"), not the namespaced MCP tool name.',
    ],
    parameters: Type.Object({
      app_id: Type.String({
        description:
          'The claimed session\'s app id (e.g. "svelte_todo"). Use tesseron_list_actions to enumerate.',
      }),
      action: Type.String({
        description:
          'The action name registered by the app (e.g. "addTodo"). NOT the namespaced MCP tool name.',
      }),
      args: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description:
              "Arguments object for the action handler. Shape must match the action's declared input schema.",
          },
        ),
      ),
    }),
    async execute(_id, params) {
      return passThroughResult(
        await tesseron.callTool('tesseron__invoke_action', {
          app_id: params.app_id,
          action: params.action,
          args: params.args ?? {},
        }),
      );
    },
  });

  pi.registerTool({
    name: 'tesseron_read_resource',
    label: 'Tesseron: Read Resource',
    description:
      'Read a resource exposed by a claimed Tesseron session. Takes the Tesseron app_id + resource name directly.',
    promptSnippet: 'Read a Tesseron resource by app_id + resource name',
    promptGuidelines: [
      'Use tesseron_read_resource for state observation; use tesseron_invoke_action for state mutation.',
    ],
    parameters: Type.Object({
      app_id: Type.String({
        description: 'The claimed session\'s app id (e.g. "svelte_todo").',
      }),
      name: Type.String({
        description:
          'The resource name registered by the app (e.g. "todoStats"). NOT the full tesseron:// URI.',
      }),
    }),
    async execute(_id, params) {
      return passThroughResult(
        await tesseron.callTool('tesseron__read_resource', {
          app_id: params.app_id,
          name: params.name,
        }),
      );
    },
  });

  // ---------- Docs tools (3) ----------

  pi.registerTool({
    name: 'tesseron_docs_list',
    label: 'Tesseron Docs: List',
    description:
      'List every Tesseron documentation page with title, slug, section, short description, and related slugs.',
    promptSnippet: 'List the Tesseron docs catalogue with slugs, sections, and descriptions',
    promptGuidelines: [
      'Call tesseron_docs_list before tesseron_docs_search when you want to scan the full catalogue.',
    ],
    parameters: NoArgsSchema,
    async execute() {
      return passThroughResult(await docs.callTool('list_docs', {}));
    },
  });

  pi.registerTool({
    name: 'tesseron_docs_search',
    label: 'Tesseron Docs: Search',
    description:
      'Full-text search across Tesseron docs (BM25, title- and description-weighted). Returns ranked hits with short snippets.',
    promptSnippet:
      'BM25-search the Tesseron docs and follow promising hits with tesseron_docs_read',
    promptGuidelines: [
      'Call tesseron_docs_search for any precision question about Tesseron protocol or SDK behavior; follow up with tesseron_docs_read on the top hits.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Free-form query. Supports multiple terms; fuzzy + prefix matching are on.',
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: 'Maximum hits to return. Default 8, hard cap 20.',
        }),
      ),
    }),
    async execute(_id, params) {
      const args: Record<string, unknown> = { query: params.query };
      const limit = params['limit'];
      if (limit !== undefined) args['limit'] = limit;
      return passThroughResult(await docs.callTool('search_docs', args));
    },
  });

  pi.registerTool({
    name: 'tesseron_docs_read',
    label: 'Tesseron Docs: Read',
    description:
      'Return the full markdown body of a Tesseron docs page plus its structured frontmatter (title, description, section, related). Slug format: `<section>/<basename>` without extension (e.g. `protocol/handshake`).',
    promptSnippet: 'Read a full Tesseron docs page by slug',
    promptGuidelines: [
      'Use tesseron_docs_read for chapter-and-verse questions about Tesseron behavior — quote it back at the user instead of paraphrasing.',
    ],
    parameters: Type.Object({
      slug: Type.String({
        description:
          'Page slug (e.g. "protocol/handshake"). Use tesseron_docs_list or tesseron_docs_search to discover valid slugs.',
      }),
    }),
    async execute(_id, params) {
      return passThroughResult(await docs.callTool('read_doc', { slug: params.slug }));
    },
  });

  // ---------- Slash command ----------

  pi.registerCommand('tesseron', {
    description: 'Show the Tesseron tool surface and the claim-code workflow.',
    handler: (_args, ctx) => {
      ctx.ui.notify(
        'Tesseron tools: tesseron_claim_session, tesseron_list_actions, tesseron_list_pending_claims, tesseron_invoke_action, tesseron_read_resource. Docs tools: tesseron_docs_list, tesseron_docs_search, tesseron_docs_read. Workflow: open a Tesseron-enabled web app, copy the 6-char claim code, then ask Pi to call tesseron_claim_session({ code }).',
        'info',
      );
      return Promise.resolve();
    },
  });
}
