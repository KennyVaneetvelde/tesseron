import {
  type ConnectOptions,
  TesseronClient,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import {
  NodeWebSocketServerTransport,
  type NodeWebSocketServerTransportOptions,
} from './transport.js';
import {
  UnixSocketServerTransport,
  type UnixSocketServerTransportOptions,
} from './uds-transport.js';

export * from '@tesseron/core';
export {
  NodeWebSocketServerTransport,
  type NodeWebSocketServerTransportOptions,
} from './transport.js';
export {
  UnixSocketServerTransport,
  type UnixSocketServerTransportOptions,
} from './uds-transport.js';

/**
 * Options for {@link ServerTesseronClient.connect} that pick the host transport
 * binding. `transport: 'ws'` (the default) binds a loopback WebSocket server;
 * `transport: 'uds'` binds a Unix domain socket under `os.tmpdir()`. Pass
 * either flavour's binding-specific options inline; pass a {@link Transport}
 * to bypass the bind-and-announce flow entirely.
 */
export type ServerConnectTarget =
  | (NodeWebSocketServerTransportOptions & { transport?: 'ws' })
  | (UnixSocketServerTransportOptions & { transport: 'uds' })
  | Transport;

/**
 * Node-side {@link TesseronClient}. Call `connect()` to bind a host transport
 * (WebSocket on loopback by default, or Unix domain socket if you pass
 * `{ transport: 'uds' }`) and announce this process to the gateway via
 * `~/.tesseron/instances/`. The gateway dials in; standard Tesseron JSON-RPC
 * traffic flows from there.
 *
 * Pass {@link NodeWebSocketServerTransportOptions} (or
 * {@link UnixSocketServerTransportOptions} with `transport: 'uds'`) to
 * customise binding details. Pass a custom {@link Transport} to bypass the
 * bind-and-announce flow entirely — useful in tests or when tunnelling through
 * another channel.
 */
export class ServerTesseronClient extends TesseronClient {
  override async connect(
    target?: ServerConnectTarget,
    options?: ConnectOptions,
  ): Promise<WelcomeResult> {
    if (target && isTransportInstance(target)) {
      return super.connect(target, options);
    }
    const transport = createHostTransport(target);
    await transport.ready();
    return super.connect(transport, options);
  }
}

interface HostTransport extends Transport {
  ready(): Promise<void>;
}

function createHostTransport(target?: Exclude<ServerConnectTarget, Transport>): HostTransport {
  if (target && 'transport' in target && target.transport === 'uds') {
    const { transport: _ignored, ...udsOptions } = target;
    return new UnixSocketServerTransport(udsOptions);
  }
  if (target && 'transport' in target) {
    const { transport: _ignored, ...wsOptions } = target;
    return new NodeWebSocketServerTransport(wsOptions);
  }
  return new NodeWebSocketServerTransport(
    target as NodeWebSocketServerTransportOptions | undefined,
  );
}

function isTransportInstance(target: ServerConnectTarget): target is Transport {
  return (
    typeof target === 'object' &&
    target !== null &&
    'send' in target &&
    'onMessage' in target &&
    'onClose' in target &&
    typeof (target as Transport).send === 'function'
  );
}

/**
 * Singleton {@link ServerTesseronClient} shared across a Node process. Most
 * backends import and use this directly rather than constructing their own.
 */
export const tesseron = new ServerTesseronClient();
