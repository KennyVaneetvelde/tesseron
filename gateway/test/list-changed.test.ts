import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListResourcesResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type ActionManifestEntry,
  type HelloParams,
  PROTOCOL_VERSION,
  type ResourceManifestEntry,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import { afterEach, describe, expect, it } from 'vitest';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';

interface PairedTransport {
  forGateway: Transport;
  forSdk: Transport;
}

function pair(): PairedTransport {
  const sdkMessageHandlers: Array<(message: unknown) => void> = [];
  const gatewayMessageHandlers: Array<(message: unknown) => void> = [];
  const sdkCloseHandlers: Array<(reason?: string) => void> = [];
  const gatewayCloseHandlers: Array<(reason?: string) => void> = [];

  return {
    forGateway: {
      send(message): void {
        queueMicrotask(() => {
          for (const handler of sdkMessageHandlers) handler(message);
        });
      },
      onMessage(handler): void {
        gatewayMessageHandlers.push(handler);
      },
      onClose(handler): void {
        gatewayCloseHandlers.push(handler);
      },
      close(): void {
        for (const handler of gatewayCloseHandlers) handler('test close');
      },
    },
    forSdk: {
      send(message): void {
        queueMicrotask(() => {
          for (const handler of gatewayMessageHandlers) handler(message);
        });
      },
      onMessage(handler): void {
        sdkMessageHandlers.push(handler);
      },
      onClose(handler): void {
        sdkCloseHandlers.push(handler);
      },
      close(): void {
        for (const handler of sdkCloseHandlers) handler('test close');
      },
    },
  };
}

function action(name: string): ActionManifestEntry {
  return { name, description: name, inputSchema: { type: 'object' } };
}

function resource(name: string): ResourceManifestEntry {
  return { name, description: name, subscribable: true };
}

function helloParams(
  actions: ActionManifestEntry[] = [],
  resources: ResourceManifestEntry[] = [],
): HelloParams {
  return {
    protocolVersion: PROTOCOL_VERSION,
    app: { id: 'listapp', name: 'List app', origin: 'http://localhost' },
    actions,
    resources,
    capabilities: { streaming: true, subscriptions: true, sampling: false, elicitation: false },
  };
}

async function sendHello(forSdk: Transport, params: HelloParams): Promise<WelcomeResult> {
  const response = new Promise<WelcomeResult>((resolve) => {
    forSdk.onMessage((message) => {
      const result = message as { id?: number; result?: WelcomeResult };
      if (result.id === 1 && result.result) resolve(result.result);
    });
  });
  forSdk.send({ jsonrpc: '2.0', id: 1, method: 'tesseron/hello', params });
  return response;
}

async function connectBridge(
  gateway: TesseronGateway,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const bridge = new McpAgentBridge({ gateway });
  const [agentTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  await bridge.connect(bridgeTransport);
  const client = new Client({ name: 'list-changed-test', version: '0.0.0' });
  await client.connect(agentTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await gateway.stop();
    },
  };
}

describe('gateway list-changed notifications', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('adds actions announced after hello to the claimed MCP tool list', async () => {
    const gateway = new TesseronGateway();
    const bridge = await connectBridge(gateway);
    close = bridge.close;
    const { forGateway, forSdk } = pair();
    gateway.handleConnection(forGateway);
    const welcome = await sendHello(forSdk, helloParams([action('first')]));
    const session = await gateway.claimSession(welcome.claimCode!);
    expect(session).toBeDefined();

    let sessionsChanged = 0;
    gateway.on('sessions-changed', () => {
      sessionsChanged += 1;
    });
    forSdk.send({
      jsonrpc: '2.0',
      method: 'actions/list_changed',
      params: { actions: [action('first'), action('later')] },
    });
    await Promise.resolve();

    const tools = await bridge.client.request({ method: 'tools/list' }, ListToolsResultSchema);
    expect(tools.tools.map((tool) => tool.name)).toContain('listapp__later');
    expect(sessionsChanged).toBe(1);
  });

  it('removes callbacks and MCP resources removed after hello', async () => {
    const gateway = new TesseronGateway();
    const bridge = await connectBridge(gateway);
    close = bridge.close;
    const { forGateway, forSdk } = pair();
    gateway.handleConnection(forGateway);
    const welcome = await sendHello(forSdk, helloParams([], [resource('removed')]));
    const session = await gateway.claimSession(welcome.claimCode!);
    expect(session).toBeDefined();
    session!.subscriptionCallbacks = new Map([
      ['subscription', { resourceName: 'removed', onUpdate: () => {} }],
    ]);

    forSdk.send({
      jsonrpc: '2.0',
      method: 'resources/list_changed',
      params: { resources: [] },
    });
    await Promise.resolve();

    const resources = await bridge.client.request(
      { method: 'resources/list' },
      ListResourcesResultSchema,
    );
    expect(resources.resources.map((entry) => entry.uri)).not.toContain(
      'tesseron://listapp/removed',
    );
    expect(session!.subscriptionCallbacks).not.toContain('subscription');
  });

  it('ignores list-changed notifications before hello', async () => {
    const gateway = new TesseronGateway();
    close = async () => gateway.stop();
    const { forGateway, forSdk } = pair();
    gateway.handleConnection(forGateway);

    forSdk.send({
      jsonrpc: '2.0',
      method: 'actions/list_changed',
      params: { actions: [action('later')] },
    });
    forSdk.send({
      jsonrpc: '2.0',
      method: 'resources/list_changed',
      params: { resources: [resource('later')] },
    });
    await Promise.resolve();

    expect(gateway.getClaimedSessions()).toEqual([]);
  });
});
