import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  type ElicitRequestFormParams,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode as McpErrorCode,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ElicitationNotAvailableError,
  type ResourceManifestEntry,
  SamplingNotAvailableError,
  TesseronError,
  TesseronErrorCode,
  type TesseronStructuredError,
} from '@tesseron/core';
import { assertValidElicitSchema } from '@tesseron/core/internal';
import type { ResourceSubscription, TesseronGateway } from './gateway.js';
import type { Session } from './session.js';

const META_TOOL_CLAIM_SESSION = 'tesseron__claim_session';
const META_TOOL_LIST_ACTIONS = 'tesseron__list_actions';
const META_TOOL_INVOKE_ACTION = 'tesseron__invoke_action';
const META_TOOL_READ_RESOURCE = 'tesseron__read_resource';
const PREFIX_SEPARATOR = '__';
const RESOURCE_SCHEME = 'tesseron:';
const DEFAULT_SERVER_NAME = 'tesseron';

const CLAIM_TOOL = {
  name: META_TOOL_CLAIM_SESSION,
  description:
    'Claim a pending Tesseron session by its 6-character code (format: XXXX-XX) so its actions appear as MCP tools. Web apps display this code in their UI when the user clicks "Connect Claude".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string',
        description: 'The 6-character claim code from the web app, e.g. "ABCD-23".',
      },
    },
    required: ['code'],
    additionalProperties: false,
  },
} as const;

// Meta-tool dispatcher surface. Workaround for clients that freeze their tool list at startup and
// ignore notifications/tools/list_changed. Tracked upstream: anthropics/claude-code#50515.
const META_DISPATCHER_TOOLS = [
  {
    name: META_TOOL_LIST_ACTIONS,
    description:
      'List every action and resource registered by currently claimed Tesseron sessions. Use this to discover what you can invoke via tesseron__invoke_action when your MCP client has not refreshed its tool list after a claim.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: META_TOOL_INVOKE_ACTION,
    description:
      'Invoke any action on a currently claimed Tesseron session. Fallback dispatcher for MCP clients that do not refresh tools/list after notifications/tools/list_changed — lets you call `<app_id>__<action>` tools even when they are absent from the client tool list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description:
            'The claimed session\'s app id (e.g. "svelte_todo"). Use tesseron__list_actions to enumerate.',
        },
        action: {
          type: 'string',
          description:
            'The action name registered by the app (e.g. "addTodo"). NOT the namespaced MCP tool name.',
        },
        args: {
          type: 'object',
          description:
            "Arguments object for the action handler. Shape must match the action's declared input schema.",
          additionalProperties: true,
        },
      },
      required: ['app_id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: META_TOOL_READ_RESOURCE,
    description:
      'Read a resource exposed by a claimed Tesseron session. Prefer this over the generic ReadMcpResourceTool — it takes the Tesseron app_id + resource name directly, so the agent does not need to know the client-side MCP server identifier (which varies by how the server is mounted, e.g. "plugin:tesseron:tesseron" in Claude Code plugin installs vs "tesseron" in a raw config). Use tesseron__list_actions to enumerate available resources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description:
            'The claimed session\'s app id (e.g. "svelte_todo"). Use tesseron__list_actions to enumerate.',
        },
        name: {
          type: 'string',
          description:
            'The resource name registered by the app (e.g. "todoStats"). NOT the full tesseron:// URI.',
        },
      },
      required: ['app_id', 'name'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * How the bridge exposes claimed-session actions over MCP.
 *
 * - `dynamic` (spec-pure): only `tesseron__claim_session` + per-app `<app_id>__<action>` tools,
 *   announced via `notifications/tools/list_changed`. Best for clients that refresh on that notification.
 * - `meta`: only `tesseron__claim_session`, `tesseron__list_actions`, `tesseron__invoke_action`. No per-app
 *   tools; every action is invoked by name through the dispatcher. Bulletproof for clients that freeze
 *   their tool list at startup (see anthropics/claude-code#50515).
 * - `both` (default): per-app tools AND the meta dispatcher. Largest tool surface, maximum compat.
 */
export type ToolSurfaceMode = 'dynamic' | 'meta' | 'both';

/** Constructor options for {@link McpAgentBridge}. */
export interface McpAgentBridgeOptions {
  /** Gateway instance whose claimed sessions should be surfaced as MCP tools/resources. */
  gateway: TesseronGateway;
  /** MCP `serverInfo` advertised during `initialize`. Defaults to `{ name: 'tesseron', version: '0.0.0' }`. */
  serverInfo?: { name: string; version: string };
  /** How claimed-session actions are exposed to the MCP client. See {@link ToolSurfaceMode}. Defaults to `both`. */
  toolSurface?: ToolSurfaceMode;
}

/**
 * Adapter that fronts a {@link TesseronGateway} with an MCP `Server`. Claimed
 * sessions' actions surface as MCP tools (`<app_id>__<action>`) and resources
 * surface as `tesseron://<app_id>/<name>` URIs. Also wires sampling and
 * elicitation requests from the SDK back into the connected MCP client, and
 * translates MCP `method not found` errors into typed {@link SamplingNotAvailableError}
 * / {@link ElicitationNotAvailableError} so handlers can branch on capability.
 */
export class McpAgentBridge {
  readonly server: Server;
  private readonly gateway: TesseronGateway;
  private readonly toolSurface: ToolSurfaceMode;
  private readonly serverName: string;
  private connected = false;
  private readonly mcpSubscriptions = new Map<string, ResourceSubscription>();
  // Per-invocation monotonic progress cursor, keyed by progressToken. MCP requires
  // `progress` to strictly increase within a single tools/call; without this, a
  // message-only `ctx.progress({ message })` would emit progress=0 and regress the
  // observer's cursor. See tesseron#6.
  private readonly progressCursors = new Map<string | number, number>();

  constructor(options: McpAgentBridgeOptions) {
    this.gateway = options.gateway;
    this.toolSurface = options.toolSurface ?? 'both';
    const serverInfo = options.serverInfo ?? { name: DEFAULT_SERVER_NAME, version: '0.0.0' };
    this.serverName = serverInfo.name;
    this.server = new Server(serverInfo, {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
    });

    this.registerToolHandlers();
    this.registerResourceHandlers();
    this.gateway.setSamplingHandler(async (req) => {
      try {
        const result = await this.server.createMessage({
          messages: [{ role: 'user', content: { type: 'text', text: req.prompt } }],
          maxTokens: req.maxTokens ?? 1024,
        });
        const content = result.content;
        const text =
          content && typeof content === 'object' && 'type' in content && content.type === 'text'
            ? (content as { text: string }).text
            : JSON.stringify(content);
        return { content: text };
      } catch (error) {
        // Translate MCP-level "method not found" into a structured Tesseron error. This is a
        // belt-and-braces safety net: the gateway should already have rejected the sampling
        // request based on the client's advertised capabilities, but some clients advertise
        // `sampling` and then reject `sampling/createMessage` anyway — still give the handler
        // something it can catch and handle gracefully.
        if (isMethodNotFoundError(error)) {
          const clientName = this.server.getClientVersion()?.name;
          throw new SamplingNotAvailableError(clientName ? { clientName } : undefined);
        }
        throw error;
      }
    });
    this.gateway.setElicitationHandler(async (req) => {
      // Defense in depth — primary validation runs on the SDK send path in
      // client.ts so authors see the error at the ctx.elicit call site. Re-check
      // here to reject malformed payloads from misbehaving or older peers.
      const requestedSchema = assertValidElicitSchema(
        req.schema,
      ) as ElicitRequestFormParams['requestedSchema'];
      const params: ElicitRequestFormParams = {
        message: req.question,
        requestedSchema,
      };
      try {
        const result = await this.server.elicitInput(params);
        if (result.action === 'accept') return { action: 'accept', value: result.content };
        if (result.action === 'decline') return { action: 'decline' };
        return { action: 'cancel' };
      } catch (error) {
        if (isMethodNotFoundError(error)) {
          const clientName = this.server.getClientVersion()?.name;
          throw new ElicitationNotAvailableError(clientName ? { clientName } : undefined);
        }
        throw error;
      }
    });

    this.gateway.on('sessions-changed', () => {
      void this.notifyToolsChanged();
      void this.notifyResourcesChanged();
    });
  }

  /**
   * Attaches the MCP server to an MCP transport (stdio, websocket, etc.) and
   * resyncs client capabilities once `initialize` completes so the gateway
   * accurately reflects what the connected MCP client supports.
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
    this.connected = true;
    // Capabilities may not yet be available immediately after `server.connect()` — the
    // `initialize` round-trip can still be in flight. Read what's available here as a
    // fast-path for handlers that invoke early, and rely on the `oninitialized` hook below
    // to resync once the handshake completes.
    this.syncClientCapabilities();
    const previousOnInitialized = this.server.oninitialized;
    this.server.oninitialized = () => {
      this.syncClientCapabilities();
      previousOnInitialized?.();
    };
    const previousOnClose = this.server.onclose;
    this.server.onclose = () => {
      this.connected = false;
      for (const sub of this.mcpSubscriptions.values()) {
        void sub.unsubscribe();
      }
      this.mcpSubscriptions.clear();
      previousOnClose?.();
    };
  }

  private syncClientCapabilities(): void {
    const caps = this.server.getClientCapabilities();
    const info = this.server.getClientVersion();
    this.gateway.setAgentCapabilities({
      sampling: caps?.sampling !== undefined,
      elicitation: caps?.elicitation !== undefined,
      clientName: info?.name,
    });
  }

  /** Emits `notifications/tools/list_changed` to the MCP client. No-op when disconnected. */
  async notifyToolsChanged(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.server.sendToolListChanged();
    } catch {
      // transport raced shutdown
    }
  }

  /** Emits `notifications/resources/list_changed` to the MCP client. No-op when disconnected. */
  async notifyResourcesChanged(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.server.sendResourceListChanged();
    } catch {
      // transport raced shutdown
    }
  }

  private registerToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Array<{ name: string; description: string; inputSchema: unknown }> = [
        CLAIM_TOOL,
      ];
      if (this.toolSurface === 'meta' || this.toolSurface === 'both') {
        tools.push(...META_DISPATCHER_TOOLS);
      }
      if (this.toolSurface === 'dynamic' || this.toolSurface === 'both') {
        tools.push(
          ...this.gateway.getClaimedSessions().flatMap((session) => sessionToTools(session)),
        );
      }
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const progressToken = (
        request.params._meta as { progressToken?: string | number } | undefined
      )?.progressToken;

      if (name === META_TOOL_CLAIM_SESSION) {
        return this.handleClaim(args);
      }
      if (name === META_TOOL_LIST_ACTIONS) {
        return this.handleListActions();
      }
      if (name === META_TOOL_READ_RESOURCE) {
        return this.handleReadResource(args);
      }

      let appId: string;
      let localName: string;
      let invokeArgs: Record<string, unknown>;
      if (name === META_TOOL_INVOKE_ACTION) {
        const rawAppId = typeof args['app_id'] === 'string' ? args['app_id'] : '';
        const rawAction = typeof args['action'] === 'string' ? args['action'] : '';
        if (!rawAppId || !rawAction) {
          return errorResult(
            'tesseron__invoke_action requires string "app_id" and "action". Use tesseron__list_actions to enumerate.',
          );
        }
        appId = rawAppId;
        localName = rawAction;
        invokeArgs =
          typeof args['args'] === 'object' && args['args'] !== null
            ? (args['args'] as Record<string, unknown>)
            : {};
      } else {
        const separatorIdx = name.indexOf(PREFIX_SEPARATOR);
        if (separatorIdx === -1) {
          return errorResult(`Tool "${name}" is not a Tesseron-prefixed action.`);
        }
        appId = name.slice(0, separatorIdx);
        localName = name.slice(separatorIdx + PREFIX_SEPARATOR.length);
        invokeArgs = args;
      }
      const session = this.gateway.getClaimedSessions().find((s) => s.app.id === appId);
      if (!session) {
        return errorResult(`No claimed session found for app "${appId}".`);
      }

      if (progressToken !== undefined) {
        this.progressCursors.set(progressToken, 0);
      }
      try {
        const output = await this.gateway.invokeAction(session.id, localName, invokeArgs, {
          signal: extra.signal,
          // Per MCP spec, progress notifications are forwarded only when the caller
          // supplied `_meta.progressToken` on tools/call. Clients that don't opt in
          // (notably Claude Code as of April 2026) never see these — see tesseron#2.
          onProgress:
            progressToken !== undefined
              ? (update) => {
                  // Preserve monotonic progress across message-only updates and
                  // defend against out-of-order decreases from misbehaving handlers.
                  // See tesseron#6.
                  const previous = this.progressCursors.get(progressToken) ?? 0;
                  let next = previous;
                  if (update.percent !== undefined && update.percent > previous) {
                    next = Math.min(update.percent, 100);
                  }
                  this.progressCursors.set(progressToken, next);
                  void this.server.notification({
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: next,
                      total: 100,
                      message: update.message,
                    },
                  });
                }
              : undefined,
          onLog: (entry) => {
            void this.server
              .sendLoggingMessage({
                level: levelFromString(entry.level),
                logger: session.app.id,
                data: { message: entry.message, ...(entry.meta ?? {}) },
              })
              .catch(() => {});
          },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, error instanceof TesseronError ? error : undefined);
      } finally {
        if (progressToken !== undefined) {
          this.progressCursors.delete(progressToken);
        }
      }
    });
  }

  private registerResourceHandlers(): void {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: this.gateway
        .getClaimedSessions()
        .flatMap((session) => session.resources.map((r) => resourceToMcp(session, r))),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const located = this.locateResource(uri);
      if (!located) {
        throw new Error(`Unknown resource URI: ${uri}`);
      }
      const result = await this.gateway.readResource(located.session.id, located.resourceName);
      const value = result.value;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return {
        contents: [
          {
            uri,
            mimeType: typeof value === 'string' ? 'text/plain' : 'application/json',
            text,
          },
        ],
      };
    });

    this.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      const located = this.locateResource(uri);
      if (!located) throw new Error(`Unknown resource URI: ${uri}`);
      const subscription = await this.gateway.subscribeResource(
        located.session.id,
        located.resourceName,
        {
          onUpdate: () => {
            void this.server.sendResourceUpdated({ uri }).catch(() => {});
          },
        },
      );
      this.mcpSubscriptions.set(uri, subscription);
      return {};
    });

    this.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      const subscription = this.mcpSubscriptions.get(uri);
      if (subscription) {
        this.mcpSubscriptions.delete(uri);
        await subscription.unsubscribe();
      }
      return {};
    });
  }

  private locateResource(uri: string): { session: Session; resourceName: string } | null {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return null;
    }
    if (parsed.protocol !== RESOURCE_SCHEME) return null;
    const appId = parsed.hostname;
    const resourceName = parsed.pathname.replace(/^\//, '');
    if (!appId || !resourceName) return null;
    const session = this.gateway.getClaimedSessions().find((s) => s.app.id === appId);
    if (!session) return null;
    return { session, resourceName };
  }

  private handleListActions(): {
    content: Array<{ type: 'text'; text: string }>;
  } {
    const claimed = this.gateway.getClaimedSessions();
    const sessions = claimed.map((session) => ({
      app_id: session.app.id,
      name: session.app.name,
      origin: session.app.origin,
      actions: session.actions.map((a) => ({
        action: a.name,
        description: a.description,
        mcp_tool_name: `${session.app.id}${PREFIX_SEPARATOR}${a.name}`,
        input_schema: a.inputSchema ?? null,
      })),
      resources: session.resources.map((r) => ({
        name: r.name,
        uri: `tesseron://${session.app.id}/${r.name}`,
        description: r.description,
        read_via: {
          preferred: {
            tool: META_TOOL_READ_RESOURCE,
            arguments: { app_id: session.app.id, name: r.name },
          },
          fallback: {
            tool: 'ReadMcpResourceTool',
            arguments: { server: this.serverName, uri: `tesseron://${session.app.id}/${r.name}` },
            note: `Client may namespace the MCP server (e.g. "plugin:tesseron:tesseron" in Claude Code plugin installs). If "${this.serverName}" is rejected, list MCP servers on the client and pick the one that matches.`,
          },
        },
      })),
    }));
    const payload = {
      mcp_server_name: this.serverName,
      mcp_server_note: `This is the name this gateway advertises over MCP. Some clients namespace it (e.g. "plugin:tesseron:tesseron" in Claude Code plugin installs). Use tesseron__read_resource instead of ReadMcpResourceTool to avoid routing ambiguity.`,
      sessions,
    };
    return {
      content: [
        {
          type: 'text' as const,
          text:
            claimed.length === 0
              ? 'No sessions claimed. Have the user visit their web app, copy its claim code, and call tesseron__claim_session first.'
              : JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async handleReadResource(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const appId = typeof args['app_id'] === 'string' ? args['app_id'] : '';
    const resourceName = typeof args['name'] === 'string' ? args['name'] : '';
    if (!appId || !resourceName) {
      return errorResult(
        'tesseron__read_resource requires string "app_id" and "name". Use tesseron__list_actions to enumerate available resources.',
      );
    }
    const session = this.gateway.getClaimedSessions().find((s) => s.app.id === appId);
    if (!session) {
      return errorResult(`No claimed session found for app "${appId}".`);
    }
    if (!session.resources.some((r) => r.name === resourceName)) {
      return errorResult(
        `Resource "${resourceName}" is not registered on app "${appId}". Known resources: ${
          session.resources.map((r) => r.name).join(', ') || '(none)'
        }.`,
      );
    }
    try {
      const result = await this.gateway.readResource(session.id, resourceName);
      const value = result.value;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(message, error instanceof TesseronError ? error : undefined);
    }
  }

  private handleClaim(args: Record<string, unknown>): {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  } {
    const code = typeof args['code'] === 'string' ? args['code'] : '';
    if (!code) {
      return errorResult('Missing "code" argument. Provide the 6-character claim code.');
    }
    const session = this.gateway.claimSession(code);
    if (!session) {
      return errorResult(
        `No pending session found for code "${code}". Has the web app connected, and is the code current?`,
      );
    }
    const toolNames = session.actions.map((a) => `${session.app.id}${PREFIX_SEPARATOR}${a.name}`);
    const actionSummary =
      toolNames.length === 0
        ? 'no actions registered yet'
        : `${toolNames.length} action(s) now available: ${toolNames.join(', ')}`;
    const resourceSummary =
      session.resources.length === 0
        ? ''
        : ` ${session.resources.length} resource(s): ${session.resources
            .map((r) => `tesseron://${session.app.id}/${r.name}`)
            .join(
              ', ',
            )}. Read them with ${META_TOOL_READ_RESOURCE}({ app_id: "${session.app.id}", name: "<resource>" }) — this avoids having to know the client-side MCP server namespacing. (Fallback: ReadMcpResourceTool on server "${this.serverName}", which some clients namespace as e.g. "plugin:tesseron:tesseron".)`;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Claimed session for "${session.app.name}" (origin ${session.app.origin}). ${actionSummary}.${resourceSummary}`,
        },
      ],
    };
  }
}

function sessionToTools(session: Session): Array<{
  name: string;
  description: string;
  inputSchema: object;
}> {
  return session.actions.map((action) => {
    const inputSchema =
      typeof action.inputSchema === 'object' && action.inputSchema !== null
        ? (action.inputSchema as object)
        : { type: 'object', additionalProperties: true };
    return {
      name: `${session.app.id}${PREFIX_SEPARATOR}${action.name}`,
      description: action.description || `Action ${action.name} from ${session.app.name}`,
      inputSchema,
    };
  });
}

function resourceToMcp(
  session: Session,
  resource: ResourceManifestEntry,
): {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
} {
  return {
    uri: `${RESOURCE_SCHEME}//${session.app.id}/${resource.name}`,
    name: `${session.app.id}__${resource.name}`,
    description: resource.description,
    mimeType: 'application/json',
  };
}

function levelFromString(level: string): 'debug' | 'info' | 'warning' | 'error' {
  switch (level) {
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * Build the MCP `CallToolResult` payload for a failed tools/call.
 *
 * When a {@link TesseronError} is supplied, its `code` (and `data`, when
 * present) are surfaced in two places: the human-readable `text` body keeps
 * the existing `${message}\n${JSON}` shape so log scraping stays compatible,
 * and an MCP-spec-native `structuredContent` object gives agents a
 * programmatic branch point (e.g. retry on `TransportClosed` but not on
 * `HandlerError`). Without the `structuredContent` carve-out, the only way
 * for an agent to tell error codes apart was regex on the text.
 */
function errorResult(
  message: string,
  error?: TesseronError,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: TesseronStructuredError;
  isError: true;
} {
  const structured: TesseronStructuredError | undefined = error
    ? { code: error.code, ...(error.data !== undefined ? { data: error.data } : {}) }
    : undefined;
  const textSuffix = structured ? `\n${JSON.stringify(structured, null, 2)}` : '';
  return {
    content: [
      {
        type: 'text' as const,
        text: `${message}${textSuffix}`,
      },
    ],
    ...(structured ? { structuredContent: structured } : {}),
    isError: true,
  };
}

function isMethodNotFoundError(error: unknown): boolean {
  if (error instanceof McpError) return error.code === McpErrorCode.MethodNotFound;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' && code === McpErrorCode.MethodNotFound) return true;
  }
  return false;
}
