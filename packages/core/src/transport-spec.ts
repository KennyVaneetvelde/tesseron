/**
 * Discriminated description of how a Tesseron app binding can be reached. Used
 * by the gateway to pick a dialer and by the SDK transports to advertise
 * themselves in the instance manifest. The set is intentionally closed; a new
 * binding requires a new tag and a new gateway dialer.
 *
 * The `Transport` interface in `./transport.ts` is the runtime contract the
 * binding must implement. `TransportSpec` is the *address* — it tells the
 * gateway how to dial in, not how to talk once connected.
 */
export type TransportSpec =
  | {
      kind: 'ws';
      /** Full WebSocket URL (`ws://host:port/path`) the gateway dials with the `tesseron-gateway` subprotocol. */
      url: string;
    }
  | {
      kind: 'uds';
      /** Filesystem path of the Unix domain socket the gateway connects to. NDJSON framing. */
      path: string;
    };

/**
 * On-disk descriptor each running app writes to `~/.tesseron/instances/<id>.json`
 * so the gateway can discover and dial it. Replaces the v1 `tabs/` files; the
 * gateway reads both formats during the compat window. SDKs only ever write v2.
 *
 * `instanceId` and `appName` are the same fields the v1 manifest carried under
 * `tabId` / `appName`. `transport` is the {@link TransportSpec} discriminant
 * that lets new bindings (UDS, future stdio, etc.) ship without changing the
 * file shape.
 */
export interface InstanceManifest {
  version: 2;
  instanceId: string;
  appName: string;
  /** Unix-millis timestamp of when the manifest was written. */
  addedAt: number;
  /**
   * Process id of the SDK side that owns this instance (i.e. the Vite dev
   * server, Node app, etc.). Optional for backward compatibility — older
   * SDKs omit it; gateways treat absence as "trust" so upgrading the
   * gateway before the SDK doesn't tombstone working manifests. When
   * present, gateways probe `process.kill(pid, 0)` and skip / tombstone
   * manifests whose owning process is gone. See tesseron#53.
   */
  pid?: number;
  transport: TransportSpec;
}
