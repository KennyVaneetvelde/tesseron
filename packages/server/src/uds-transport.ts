import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from '@tesseron/core';

const isWindows = platform() === 'win32';

/**
 * Resolves the instance-discovery directory on every call rather than at
 * module load. Tests (and long-lived processes that change `$HOME` at runtime)
 * need this — capturing at load time meant a sandbox set via
 * `process.env.HOME` before `beforeAll` was ignored.
 */
function getInstancesDir(): string {
  return join(homedir(), '.tesseron', 'instances');
}

function generateInstanceId(): string {
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UnixSocketServerTransportOptions {
  /** App name written to the instance manifest. Defaults to `'node'`. */
  appName?: string;
  /**
   * Override the socket path. If omitted, the transport creates a 0700 dir
   * under `os.tmpdir()` and binds `<dir>/sock` inside it — the dir mode is the
   * access control (kernel rejects `connect()` from any UID other than the
   * owner on Linux/macOS).
   */
  path?: string;
}

/**
 * Transport that hosts a one-shot Unix domain socket and announces itself to
 * the Tesseron gateway by writing `~/.tesseron/instances/<instanceId>.json`
 * with a `{ kind: 'uds', path }` spec. The gateway watches that directory,
 * connects to the advertised path, and the two ends exchange newline-delimited
 * JSON-RPC messages.
 *
 * **Framing.** NDJSON: `JSON.stringify(msg) + '\n'` per outbound message; line
 * splitter on inbound. `JSON.stringify` never emits raw `\n` (newlines inside
 * strings are escaped as `\\n`), so the framing is lossless.
 *
 * **Access control.** On Linux/macOS the socket file lives inside a temp dir
 * created with mode 0700, so only the owning UID can `connect()`. The gateway
 * dialer relies on this — there's no claim-code-level handshake before bytes
 * flow. Threat model matches loopback WS + claim code.
 *
 * **Windows.** AF_UNIX is supported on Windows ≥ 1803 but file-mode-based UID
 * enforcement is not. Same-UID enforcement on Windows is the responsibility
 * of the OS-level user separation; treat the binding as "any process the
 * current user can spawn" there. Document explicitly in the binding spec.
 *
 * Accepts exactly one connection — the first peer wins, subsequent connect
 * attempts close immediately.
 */
export class UnixSocketServerTransport implements Transport {
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private readonly opened: Promise<void>;
  private readonly instanceId: string;
  private readonly options: UnixSocketServerTransportOptions;
  private server?: Server;
  private socket?: Socket;
  private socketPath?: string;
  /** Temp dir created by us; deleted on close. Undefined when caller supplied `options.path`. */
  private tempDir?: string;
  private manifestFile?: string;
  /** Messages queued before the gateway dials in. Drained on connection. */
  private readonly sendQueue: string[] = [];
  /** Inbound NDJSON splitter buffer. */
  private buffer = '';

  constructor(options: UnixSocketServerTransportOptions = {}) {
    this.options = options;
    this.instanceId = generateInstanceId();
    this.opened = this.listen();
  }

  private async listen(): Promise<void> {
    const socketPath = await this.resolveSocketPath();
    this.socketPath = socketPath;

    const server = createServer((socket) => this.attachGateway(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    // Tighten the socket-file mode where the OS honours it. On Windows AF_UNIX
    // sockets ignore POSIX mode bits, so this is a no-op there — the parent
    // dir's mode is also a no-op. Documented as a known limitation.
    if (!isWindows) {
      try {
        await chmod(socketPath, 0o600);
      } catch {
        // best effort — tempdir mode 0700 is the primary access gate
      }
    }

    await this.writeManifest(socketPath);
  }

  /**
   * Resolve the socket path. When the caller supplies `options.path` we use
   * it verbatim. Otherwise we create a 0700 temp dir and bind `sock` inside,
   * so file-mode-based UID enforcement guards the inode without depending on
   * the global `os.tmpdir()` permissions (which on Linux are typically 1777).
   */
  private async resolveSocketPath(): Promise<string> {
    if (this.options.path) {
      // Make sure stale leftover from a prior run with the same path doesn't
      // collide with bind. UDS bind() fails with EADDRINUSE on existing files.
      if (existsSync(this.options.path)) {
        try {
          await unlink(this.options.path);
        } catch {
          // bind will fail noisily if this was important
        }
      }
      return this.options.path;
    }
    // mkdtemp respects the process umask; explicit chmod after for determinism.
    const dir = await mkdtemp(join(tmpdir(), 'tesseron-'));
    this.tempDir = dir;
    if (!isWindows) {
      try {
        await chmod(dir, 0o700);
      } catch {
        // tmpdir is rare to fail chmod; if it does we still bind below
      }
    }
    return join(dir, 'sock');
  }

  private attachGateway(socket: Socket): void {
    if (this.socket) {
      // Already bound to a gateway; reject duplicates by ending immediately.
      socket.end();
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf-8');

    // Drain anything the caller tried to send before the gateway showed up.
    for (const msg of this.sendQueue) {
      socket.write(`${msg}\n`);
    }
    this.sendQueue.length = 0;

    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf('\n');
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
            for (const handler of this.messageHandlers) handler(parsed);
          } catch {
            // skip malformed line
          }
        }
        idx = this.buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      for (const handler of this.closeHandlers) handler();
    });

    socket.on('error', () => {
      // 'close' fires after 'error'; let onClose drive teardown
    });
  }

  private async writeManifest(socketPath: string): Promise<void> {
    const instancesDir = getInstancesDir();
    if (!existsSync(instancesDir)) {
      await mkdir(instancesDir, { recursive: true });
    }
    this.manifestFile = join(instancesDir, `${this.instanceId}.json`);
    await writeFile(
      this.manifestFile,
      JSON.stringify(
        {
          version: 2,
          instanceId: this.instanceId,
          appName: this.options.appName ?? 'node',
          addedAt: Date.now(),
          // Stamp the Node app's pid so a gateway can probe liveness with
          // `process.kill(pid, 0)` and tombstone manifests whose owning
          // process died without unlinking the socket file. See tesseron#53.
          pid: process.pid,
          transport: { kind: 'uds', path: socketPath },
        },
        null,
        2,
      ),
    );
  }

  /** Resolves once the UDS server is listening and the manifest has been written. */
  async ready(): Promise<void> {
    await this.opened;
  }

  send(message: unknown): void {
    const raw = JSON.stringify(message);
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${raw}\n`);
    } else {
      this.sendQueue.push(raw);
    }
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(_reason?: string): void {
    if (this.manifestFile && existsSync(this.manifestFile)) {
      unlink(this.manifestFile).catch(() => {});
    }
    this.socket?.end();
    this.socket?.destroy();
    this.server?.close();
    if (this.socketPath && existsSync(this.socketPath)) {
      unlink(this.socketPath).catch(() => {});
    }
    if (this.tempDir) {
      rm(this.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
