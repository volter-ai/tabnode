/**
 * Server Bridge
 * Connects Service Worker requests to virtual HTTP servers
 */

import {
  __requestOverLoopback, __streamOverLoopback, __upgradeOverLoopback, __listening,
  type ResponseData,
} from './node-lib/http-bridge';
import { setPortWatchers } from './node-lib/net-module';
import { EventEmitter } from './node-lib/events-module';
import { __bridgeConnection } from './node-lib/net-module';
import type { Socket } from './node-lib/net-module';
import { Buffer } from './node-lib/buffer-module';
import { uint8ToBase64 } from './utils/binary-encoding';

const _encoder = new TextEncoder();

/** The bytes this view names, in a buffer of their own. A pooled Buffer is a window on 8 KB. */
function ownedBytes(view: Uint8Array): Uint8Array {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy;
}

/**
 * Interface for virtual servers that can be registered with the bridge
 */
export interface IVirtualServer {
  listening: boolean;
  /** What `net.Server.address()` answers: an address and a port, or the PATH of a unix-domain socket. */
  address(): { port: number; address: string; family: string } | string | null;
  handleRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Buffer | string
  ): Promise<ResponseData>;
}

/**
 * A guest that called `listen` is a server: it answers requests over the
 * engine's loopback. The page observes registrations by wrapping
 * `registerServer` and reading `server.handleRequest`; a `null` server there
 * threw, tcp_wrap swallowed it, and a listen on `127.0.0.1` never opened
 * while one with no host (openvscode-server's) could still reach the page
 * through a wrap that did not bind `handleRequest`.
 */
function guestListeningServer(port: number, address: string): IVirtualServer {
  const hostname = address || '0.0.0.0';
  return {
    listening: true,
    address: () => ({
      port,
      address: hostname,
      family: hostname.includes(':') ? 'IPv6' : 'IPv4',
    }),
    handleRequest: (method, url, headers, body) =>
      __requestOverLoopback(port, method, url, headers, typeof body === 'string' ? Buffer.from(body) : body),
  };
}

export interface VirtualServer {
  /**
   * A server the host registered and answers itself, or null for a guest's
   * own: a guest's server is a port this engine is listening on, and it is
   * reached by connecting to it like any other client.
   */
  server: IVirtualServer | null;
  port: number;
  hostname: string;
}

export interface BridgeOptions {
  baseUrl?: string;
  onServerReady?: (port: number, url: string) => void;
}

export interface InitServiceWorkerOptions {
  /**
   * The URL path to the service worker file
   * @default '/__sw__.js'
   */
  swUrl?: string;
  /**
   * The page's own documents that are frames of it (a sandbox, a worker
   * host), by path, so the worker does not take one for the preview's.
   */
  ownDocuments?: string[];
}

/**
 * Server Bridge manages virtual HTTP servers and routes requests
 */
/**
 * A virtual WebSocket to a port whose server is an HTTP server with an
 * `upgrade` listener, and no `ws` shim server of its own, reaches that listener
 * as Node delivers it: an `upgrade` event with the request and a duplex socket,
 * on which the program's own WebSocket library — `ws` bundled inside Vite among
 * them — writes its 101 response and then frames. The bridge speaks RFC 6455 on
 * the socket's other end: the library's frames become the client's messages,
 * the client's messages become masked frames the library reads, a close either
 * way closes both.
 */
/** One client's place in the bridge: who it is, which port, the channel it speaks on. */
interface UpgradeEntry {
  clientId: string;
  port: number;
  channel: BroadcastChannel;
}

/** A partly read frame stream: bytes not yet a whole frame, and a fragmented message in progress. */
interface FrameState {
  pending: Uint8Array;
  fragments: { opcode: number; parts: Uint8Array[] } | null;
}

/** What a virtual WebSocket client sends over the shared channel. */
interface UpgradeSignal {
  type: string;
  clientId: string;
  url?: string;
  protocols?: string[];
  /** `"none"` asks for a byte pipe; anything else, or nothing, is a WebSocket. */
  framing?: "websocket" | "none";
  payload?: string | ArrayBuffer;
  code?: number;
  reason?: string;
}

/** What a server must answer for a virtual connect to reach it as an upgrade. */
interface UpgradeTarget {
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
}

/** The end of an upgraded socket the bridge drives, whichever socket the listener was handed. */
interface UpgradeEnd {
  deliver(payload: string | ArrayBuffer): void;
  disconnect(code: number, reason: string): void;
  destroy(): void;
}

/**
 * The duplex socket an `upgrade` listener is handed: the connection's own
 * `net.Socket`, which is what Node hands one, plus the two calls the bridge
 * drives its own end with, `deliver` and `disconnect`, and the two a Duplex
 * here does not inherit -- `cork`/`uncork` are the Writable base's, Node's
 * socket has them, and `ws` corks a two-part frame before it writes it.
 */
type UpgradeSocket = Socket & UpgradeEnd & { cork(): void; uncork(): void };

// RFC 6455 on the bridge's side of an upgraded socket: what the server's
// library writes is parsed into messages for the client, what the client
// sends is framed, masked as a client must, for the library to read.
const __substrateUpgradeSockets = new Map<string, UpgradeEnd>();
function __substrateFrame(opcode: number, payload: Uint8Array, masked: boolean): Uint8Array {
  const length = payload.length;
  const header = [0x80 | opcode];
  if (length < 126) header.push((masked ? 0x80 : 0) | length);
  else if (length < 65536) header.push((masked ? 0x80 : 0) | 126, length >> 8, length & 255);
  else header.push((masked ? 0x80 : 0) | 127, 0, 0, 0, 0, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255);
  const mask = masked ? [Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0] : [];
  const out = new Uint8Array(header.length + mask.length + length);
  out.set(header, 0);
  out.set(mask, header.length);
  for (let index = 0; index < length; index += 1) out[header.length + mask.length + index] = masked ? payload[index] ^ mask[index & 3] : payload[index];
  return out;
}
function __substrateParseFrames(state: FrameState, chunk: Uint8Array, onFrame: (opcode: number, payload: Uint8Array) => void): void {
  const joined = state.pending.length ? new Uint8Array([...state.pending, ...chunk]) : chunk;
  let offset = 0;
  for (;;) {
    if (joined.length - offset < 2) break;
    const b0 = joined[offset], b1 = joined[offset + 1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f, at = offset + 2;
    if (length === 126) { if (joined.length - at < 2) break; length = (joined[at] << 8) | joined[at + 1]; at += 2; }
    else if (length === 127) { if (joined.length - at < 8) break; length = 0; for (let index = 0; index < 8; index += 1) length = length * 256 + joined[at + index]; at += 8; }
    let mask: Uint8Array | undefined;
    if (masked) { if (joined.length - at < 4) break; mask = joined.subarray(at, at + 4); at += 4; }
    if (joined.length - at < length) break;
    const payload = joined.slice(at, at + length);
    if (mask) for (let index = 0; index < length; index += 1) payload[index] ^= mask[index & 3];
    offset = at + length;
    if (opcode === 0 && state.fragments) { state.fragments.parts.push(payload); if (fin) { const parts = state.fragments.parts; const total = parts.reduce((sum, part) => sum + part.length, 0); const whole = new Uint8Array(total); let cursor = 0; for (const part of parts) { whole.set(part, cursor); cursor += part.length; } const op = state.fragments.opcode; state.fragments = null; onFrame(op, whole); } }
    else if (!fin && (opcode === 1 || opcode === 2)) state.fragments = { opcode, parts: [payload] };
    else onFrame(opcode, payload);
  }
  state.pending = joined.slice(offset);
}
/**
 * The socket an `upgrade` listener is handed for a connect that carries
 * WebSocket frames: Node's own `net.Socket`, over a handle whose peer is the
 * bridge.
 *
 * Node hands an `upgrade` listener the connection's `net.Socket`, and a
 * program does everything a socket can with it. The engine used to hand it an
 * object with `write`, `end` and `destroy` overridden on a socket-shaped
 * class, so pause, resume, pipe, `setEncoding` and `bufferSize` were either
 * wrong or absent -- VS Code's `NodeSocket.drain` resolves on
 * `bufferSize === 0` and otherwise waits for a `drain` event, and waited
 * forever, which is what openvscode-server does before handing its extension
 * host the workbench's connection.
 *
 * So the bridge is a handle, not a fake socket: the listener's end is a
 * `net.Socket` of Node's own making and the bridge holds the other end of the
 * pairing. What the library writes arrives as bytes -- read first as the
 * `101` head and then as RFC 6455 -- and what the client says is framed,
 * masked as a client must, and pushed in as the connection's own inbound
 * bytes.
 */
function __substrateUpgradeSocket(entry: UpgradeEntry, socket: Socket): UpgradeSocket {
  // The connection is already made and its `101` already read: this is the
  // client's own end of a connection the guest's server accepted, so the
  // bytes on it from here are the protocol's.
  const end = socket as UpgradeSocket;
  const bridge = {
    push: (frame: Uint8Array): void => { socket.write(frame); },
    destroy: (): void => { socket.destroy(); },
    get destroyed(): boolean { return socket.destroyed; },
    onData: (listener: (chunk: Uint8Array) => void): void => { socket.on("data", listener); },
  };
  let closed = false;
  const headed = true;
  const state: FrameState = { pending: new Uint8Array(0), fragments: null };
  const decoder = new TextDecoder();
  const finish = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    __substrateUpgradeSockets.delete(entry.clientId);
    entry.channel.postMessage({ type: "close", targetClient: entry.clientId, code, reason });
  };
  /** What the client says, framed for the server's library, as the socket's own inbound bytes. */
  const receive = (frame: Uint8Array): void => { if (!bridge.destroyed) bridge.push(frame); };
  bridge.onData((chunk) => {
    const bytes = chunk;
    if (!headed) return;
    __substrateParseFrames(state, bytes, (opcode, payload) => {
      if (opcode === 1) entry.channel.postMessage({ type: "message", targetClient: entry.clientId, payload: decoder.decode(payload) });
      else if (opcode === 2) entry.channel.postMessage({ type: "message", targetClient: entry.clientId, payload: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) });
      else if (opcode === 8) { const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005; finish(code === 1005 ? 1000 : code, payload.length > 2 ? decoder.decode(payload.subarray(2)) : ""); end.destroy(); }
      else if (opcode === 9) receive(__substrateFrame(10, payload, true));
    });
  });
  // The listener's own end going is the connection going: the bridge's client
  // is told, once, whichever side ended it.
  end.on("close", () => { finish(1000, ""); bridge.destroy(); });
  end.deliver = (payload: string | ArrayBuffer) => {
    if (closed || end.destroyed) return;
    const bytes = typeof payload === "string" ? _encoder.encode(payload) : new Uint8Array(payload);
    receive(__substrateFrame(typeof payload === "string" ? 1 : 2, bytes, true));
  };
  end.disconnect = (code: number, reason: string) => {
    if (closed || end.destroyed) return;
    const text = _encoder.encode(reason || "");
    const payload = new Uint8Array(2 + text.length); payload[0] = code >> 8; payload[1] = code & 255; payload.set(text, 2);
    receive(__substrateFrame(8, payload, true));
    // The library answers a close frame with its own, and that write ends this
    // end through the reader above; a library that does not answer ends here.
    setTimeout(() => { finish(code, reason || ""); end.destroy(); }, 50);
  };
  return end;
}
/**
 * The socket an `upgrade` listener is handed for a connect that carries no
 * WebSocket frames: the same `net.Socket` over the same pairing, with the
 * bridge speaking bytes rather than frames on its end.
 *
 * vscode-server's `RemoteExtensionHostAgentServer` answers its own upgrade. It
 * writes `HTTP/1.1 101 Switching Protocols` with `socket.write` and then reads
 * and writes its remote protocol on that same socket as bytes, because its
 * client asked for no framing and the server frames nothing either way. The
 * engine handed it the bridge's RFC 6455 socket, which read the server's
 * protocol as frames and found none, so the server's answer went nowhere and
 * the client's connect never opened. Here every write is one message to the
 * client, every message from the client is data on the socket, and the head
 * the server writes is the client's to strip.
 */
function __substrateRawUpgradeSocket(entry: UpgradeEntry, socket: Socket): Socket & UpgradeEnd {
  const end = socket as Socket & UpgradeEnd;
  const bridge = {
    push: (data: Uint8Array): void => { socket.write(data); },
    destroy: (): void => { socket.destroy(); },
    end: (): void => { socket.end(); },
    get destroyed(): boolean { return socket.destroyed; },
    onData: (listener: (chunk: Uint8Array) => void): void => { socket.on("data", listener); },
  };
  let closed = false;
  const finish = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    __substrateUpgradeSockets.delete(entry.clientId);
    entry.channel.postMessage({ type: "close", targetClient: entry.clientId, code, reason });
  };
  bridge.onData((chunk) => {
    if (closed) return;
    entry.channel.postMessage({ type: "message", targetClient: entry.clientId, payload: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) });
  });
  end.on("close", () => { finish(1000, ""); bridge.destroy(); });
  end.deliver = (payload: string | ArrayBuffer) => {
    if (closed || end.destroyed || bridge.destroyed) return;
    bridge.push(typeof payload === "string" ? _encoder.encode(payload) : new Uint8Array(payload));
  };
  end.disconnect = (code: number, reason: string) => {
    if (closed || end.destroyed) return;
    bridge.end();
    finish(code, reason || "");
    end.destroy();
  };
  return end;
}
/**
 * The channel a virtual websocket's connect arrives on, opened for the guest
 * whose servers this bridge holds. It is the bridge's to hold and the
 * bridge's to give back: a subscribed `BroadcastChannel` is a `MessagePort`
 * the host's loop counts, and this one was opened in a closure and never
 * stored, so a Node process that used the engine — `createContainer()` and
 * nothing more — never reached `beforeExit`; the substrate's own
 * `verify:pnpm-workspace` had to run with `--test-force-exit` for it. It is
 * unreferenced where the host counts handles against exit (a browser's
 * `BroadcastChannel` has no `unref` and holds nothing open), and `close()`
 * gives it up altogether. The rule this restores is the one the fork already
 * states for import, carried on to use: a host resource the engine opens for
 * a guest must not outlive the guest, and must never be the reason someone
 * else's process stays alive.
 */
function __substrateListenForUpgrades(bridge: ServerBridge): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel("vite-ws-channel");
  (channel as unknown as { unref?: () => void }).unref?.();
  channel.addEventListener("message", (event) => {
    const data2 = event.data as UpgradeSignal;
    if (!data2 || typeof data2 !== "object") return;
    if (data2.type === "connect") {
      let url2: URL;
      try { url2 = new URL(data2.url!); } catch { return; }
      const port = Number(url2.port);
      if (!__listening(port)) return;
      const record = { clientId: data2.clientId, port, channel };
      // A client that asked for no frames is a byte pipe; anything else is a
      // WebSocket, and the bridge speaks RFC 6455 on its own end of it.
      const raw = data2.framing === "none";
      const key = uint8ToBase64(crypto.getRandomValues(new Uint8Array(16)));
      const protocols = Array.isArray(data2.protocols) ? data2.protocols : [];
      // The handshake is a request on a real connection, and the guest's
      // server answers it with its own code: Node's `http` emits `upgrade`
      // with the socket, which is what the real `ws` takes over. What comes
      // back here is the client's end of that same connection.
      void __upgradeOverLoopback(port, "GET", url2.pathname + url2.search, {
        Host: url2.host,
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        ...(protocols.length ? { "Sec-WebSocket-Protocol": protocols.join(", ") } : {}),
      }).then((result) => {
        if (result.statusCode !== 101 || !result.socket) {
          channel.postMessage({ type: "close", targetClient: data2.clientId, code: 1006, reason: "upgrade refused" });
          return;
        }
        const socket = raw
          ? __substrateRawUpgradeSocket(record, result.socket)
          : __substrateUpgradeSocket(record, result.socket);
        __substrateUpgradeSockets.set(data2.clientId, socket);
        channel.postMessage({
          type: "connected",
          targetClient: data2.clientId,
          protocol: result.headers["sec-websocket-protocol"] ?? (raw ? protocols[0] ?? "" : ""),
        });
      });
    } else if (data2.type === "message") {
      const socket = __substrateUpgradeSockets.get(data2.clientId);
      if (socket) socket.deliver(data2.payload!);
    } else if (data2.type === "disconnect") {
      const socket = __substrateUpgradeSockets.get(data2.clientId);
      if (socket) socket.disconnect(typeof data2.code === "number" ? data2.code : 1000, typeof data2.reason === "string" ? data2.reason : "");
    }
  });
  return channel;
}

export class ServerBridge extends EventEmitter {
  static DEBUG = false;
  servers: Map<number, VirtualServer> = new Map();
  private baseUrl: string;
  private options: BridgeOptions;
  private messageChannel: MessageChannel | null = null;
  /** The upgrade channel this bridge opened, held so it can be given back. */
  private upgradeChannel: BroadcastChannel | null = null;
  private serviceWorkerReady: boolean = false;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: BridgeOptions = {}) {
    super();
    this.options = options;

    // Handle browser vs Node.js environment
    if (typeof location !== 'undefined') {
      this.baseUrl = options.baseUrl || `${location.protocol}//${location.host}`;
    } else {
      this.baseUrl = options.baseUrl || 'http://localhost';
    }

    // A guest's servers register themselves, from the port they take.
    this.watchGuestPorts();
    this.upgradeChannel = __substrateListenForUpgrades(this);
  }

  /**
   * Give back everything this bridge opened: the upgrade channel and the
   * service worker keepalive. A host that is done with a container calls it
   * and has its process back; calling it twice is nothing.
   */
  /**
   * Every port a guest starts listening on becomes a server this bridge can
   * answer for, and every port it stops listening on stops being one. The
   * news comes from the net binding, because that is where a port is taken;
   * the engine's `http` is Node's own file and knows nothing of a page.
   */
  private readonly guestServers = new WeakSet<IVirtualServer>();

  private watchGuestPorts(): void {
    setPortWatchers(
      (port, address) => {
        if (this.servers.has(port)) return;
        const hostname = address || '0.0.0.0';
        const server = guestListeningServer(port, hostname);
        this.guestServers.add(server);
        this.registerServer(server, port, hostname);
      },
      (port) => {
        const entry = this.servers.get(port);
        // Closing a guest's listener releases its bridge port too. Guest
        // registrations carry a request adapter now, not the old null sentinel;
        // a host replacement on that port must still be left alone.
        if (entry && (entry.server === null || this.guestServers.has(entry.server))) {
          if (entry.server) entry.server.listening = false;
          this.unregisterServer(port);
        }
      },
    );
  }

  close(): void {
    if (this.upgradeChannel) {
      try { this.upgradeChannel.close(); } catch { /* a channel the realm already closed is closed */ }
      this.upgradeChannel = null;
    }
    if (this.keepaliveInterval !== null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Register a server on a port
   */
  registerServer(server: IVirtualServer | null, port: number, hostname: string = '0.0.0.0'): void {
    this.servers.set(port, { server, port, hostname });

    // Emit server-ready event
    const url = this.getServerUrl(port);
    this.emit('server-ready', port, url);

    if (this.options.onServerReady) {
      this.options.onServerReady(port, url);
    }

    // Notify service worker if connected
    this.notifyServiceWorker('server-registered', { port, hostname, primary: port === this.primaryPort });
  }

  /**
   * Unregister a server
   */
  unregisterServer(port: number): void {
    this.servers.delete(port);
    if (this.primaryPort === port) this.primaryPort = null;
    this.notifyServiceWorker('server-unregistered', { port });
  }

  /** The server the service worker answers at the origin's root, the preview's; null for none. */
  private primaryPort: number | null = null;

  /**
   * Names the server the service worker serves at the origin's root, as an
   * app is served at its own origin's root: its documents read their routes
   * from `location.pathname`, which under /__virtual__/<port>/ is not the
   * path they expect. Told to the worker now and again whenever the worker
   * is (re)initialized, since a worker that restarted remembers nothing.
   */
  setPrimaryPort(port: number | null): void {
    const previous = this.primaryPort;
    this.primaryPort = port;
    if (previous !== null && previous !== port) {
      const entry = this.servers.get(previous);
      if (entry) this.notifyServiceWorker('server-registered', { port: previous, hostname: entry.hostname, primary: false });
    }
    if (port !== null) {
      const entry = this.servers.get(port);
      this.notifyServiceWorker('server-registered', { port, hostname: entry?.hostname ?? '0.0.0.0', primary: true });
    }
  }

  /** Every registration the worker should hold, sent again to a worker that was (re)initialized. */
  private announceServers(): void {
    if (this.ownDocuments) this.notifyServiceWorker('own-documents', { paths: this.ownDocuments });
    for (const [port, entry] of this.servers) {
      this.notifyServiceWorker('server-registered', { port, hostname: entry.hostname, primary: port === this.primaryPort });
    }
  }
  private ownDocuments: string[] | undefined;

  /**
   * Get server URL for a port
   */
  getServerUrl(port: number): string {
    return `${this.baseUrl}/__virtual__/${port}`;
  }

  /**
   * Get all registered server ports
   */
  getServerPorts(): number[] {
    return [...this.servers.keys()];
  }

  /**
   * Handle an incoming request from Service Worker
   */
  async handleRequest(
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer
  ): Promise<ResponseData> {
    const virtualServer = this.servers.get(port);

    if (!virtualServer) {
      return {
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain' },
        body: ownedBytes(Buffer.from(`No server listening on port ${port}`)),
      };
    }

    try {
      const bodyBuffer = body ? Buffer.from(new Uint8Array(body)) : undefined;
      // Every request a server sees carries a Host. HTTP/1.1 requires one and
      // Node's own parser answers 400 without it, so a server is written as
      // though it is always there: Next's middleware reads
      // `req.headers.get('host')` on its first line and Dub's died on null.
      // A browser's `fetch` may not send the header and a service worker may
      // not add it, so the request that arrives here often has none; the
      // server is listening on a port, and that is the authority it is
      // reachable at.
      const named = Object.keys(headers).some((name) => name.toLowerCase() === 'host');
      const authority = `${virtualServer.hostname && virtualServer.hostname !== '0.0.0.0' && virtualServer.hostname !== '::' ? virtualServer.hostname : '127.0.0.1'}:${port}`;
      const withHost = named ? headers : { ...headers, host: authority };
      // A server the host registered answers for itself; a guest's server is
      // a port this engine is listening on, and the request goes to it as
      // bytes on a connection, which is what a server reads.
      if (virtualServer.server) return await virtualServer.server.handleRequest(method, url, withHost, bodyBuffer);
      return await __requestOverLoopback(port, method, url, withHost, bodyBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      return {
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        headers: { 'Content-Type': 'text/plain' },
        body: ownedBytes(Buffer.from(message)),
      };
    }
  }

  /**
   * Initialize Service Worker communication
   * @param options - Configuration options for the service worker
   * @param options.swUrl - Custom URL path to the service worker file (default: '/__sw__.js')
   */
  async initServiceWorker(options?: InitServiceWorkerOptions): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Workers not supported');
    }

    const swUrl = options?.swUrl ?? '/__sw__.js';

    // Set up controllerchange listener BEFORE registration so we don't miss the event.
    // clients.claim() in the SW's activate handler fires controllerchange, and it can
    // happen before our activation wait completes.
    const controllerReady = navigator.serviceWorker.controller
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        });

    // Register service worker
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: '/',
    });

    // Wait for service worker to be active
    const sw = registration.active || registration.waiting || registration.installing;

    if (!sw) {
      throw new Error('Service Worker registration failed');
    }

    await new Promise<void>((resolve) => {
      if (sw.state === 'activated') {
        resolve();
      } else {
        const handler = () => {
          if (sw.state === 'activated') {
            sw.removeEventListener('statechange', handler);
            resolve();
          }
        };
        sw.addEventListener('statechange', handler);
      }
    });

    // Set up message channel for communication
    this.messageChannel = new MessageChannel();
    this.messageChannel.port1.onmessage = this.handleServiceWorkerMessage.bind(this);

    this.ownDocuments = options?.ownDocuments;
    // Send port to service worker
    sw.postMessage({ type: 'init', port: this.messageChannel.port2, data: { ownDocuments: this.ownDocuments ?? [] } }, [
      this.messageChannel.port2,
    ]);

    // Wait for SW to actually control this page (clients.claim() in SW activate handler)
    // Without this, fetch requests bypass the SW and go directly to the server
    await controllerReady;

    // Re-establish communication when the SW loses its port (idle termination)
    // or when the SW is replaced (new deployment). The SW sends 'sw-needs-init'
    // to all clients when a request arrives but mainPort is null.
    const reinit = () => {
      if (navigator.serviceWorker.controller) {
        this.messageChannel = new MessageChannel();
        this.messageChannel.port1.onmessage = this.handleServiceWorkerMessage.bind(this);
        navigator.serviceWorker.controller.postMessage(
          { type: 'init', port: this.messageChannel.port2, data: { ownDocuments: this.ownDocuments ?? [] } },
          [this.messageChannel.port2]
        );
        this.announceServers();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', reinit);
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'sw-needs-init') {
        reinit();
      }
    });

    // Keep the SW alive with periodic pings. Browsers terminate idle SWs
    // after ~30s, losing the MessageChannel port and all in-memory state.
    this.keepaliveInterval = setInterval(() => {
      this.messageChannel?.port1.postMessage({ type: 'keepalive' });
    }, 20_000);

    this.serviceWorkerReady = true;
    this.announceServers();
    this.emit('sw-ready');
  }

  /**
   * Handle messages from Service Worker
   */
  private async handleServiceWorkerMessage(event: MessageEvent): Promise<void> {
    const { type, id, data } = event.data;

    ServerBridge.DEBUG && console.log('[ServerBridge] SW message:', type, id, data?.url);

    if (type === 'request') {
      const { port, method, url, headers, body, streaming } = data;

      ServerBridge.DEBUG && console.log('[ServerBridge] Handling request:', port, method, url, 'streaming:', streaming);
      if (streaming) {
        ServerBridge.DEBUG && console.log('[ServerBridge] 🔴 Will use streaming handler');
      }

      try {
        if (streaming) {
          // Handle streaming request
          await this.streamToServiceWorker(id, port, method, url, headers, body);
        } else {
          // Handle regular request
          const response = await this.handleRequest(port, method, url, headers, body);
          ServerBridge.DEBUG && console.log('[ServerBridge] Response:', response.statusCode, 'body length:', response.body?.length);

          // Convert body to base64 string to avoid structured cloning issues with Uint8Array
          let bodyBase64 = '';
          if (response.body && response.body.length > 0) {
            const bytes = response.body instanceof Uint8Array ? response.body : new Uint8Array(0);
            bodyBase64 = uint8ToBase64(bytes);
          }

          ServerBridge.DEBUG && console.log('[ServerBridge] Sending response to SW, body base64 length:', bodyBase64.length);

          this.messageChannel?.port1.postMessage({
            type: 'response',
            id,
            data: {
              statusCode: response.statusCode,
              statusMessage: response.statusMessage,
              headers: response.headers,
              bodyBase64: bodyBase64,
            },
          });
        }
      } catch (error) {
        this.messageChannel?.port1.postMessage({
          type: 'response',
          id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Handle a streaming request - sends chunks as they arrive
   */
  /**
   * A page-side request streamed to the caller as it arrives, the door a host
   * reads a guest's server through when it wants chunks rather than a body:
   * a guest's own server is reached over the loopback as any client reaches
   * it; a server the host registered answers through its own streaming
   * method where it has one, else its buffered answer is delivered whole.
   */
  async handleStreamingRequest(
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body: ArrayBuffer | undefined,
    callbacks: {
      start(statusCode: number, statusMessage: string, headers: Record<string, string>): void;
      chunk(chunk: Uint8Array): void;
      end(): void;
    },
  ): Promise<boolean> {
    const virtualServer = this.servers.get(port);
    if (!virtualServer) return false;
    const bodyBuffer = body ? Buffer.from(new Uint8Array(body)) : undefined;
    if (virtualServer.server === null) {
      const named = Object.keys(headers).some((name) => name.toLowerCase() === 'host');
      const authority = `${virtualServer.hostname && virtualServer.hostname !== '0.0.0.0' && virtualServer.hostname !== '::' ? virtualServer.hostname : '127.0.0.1'}:${port}`;
      await __streamOverLoopback(
        port, method, url, named ? headers : { ...headers, host: authority }, bodyBuffer,
        (statusCode, statusMessage, respHeaders) => callbacks.start(statusCode, statusMessage, respHeaders),
        (chunk) => callbacks.chunk(ownedBytes(chunk)),
        () => callbacks.end(),
      );
      return true;
    }
    const server = virtualServer.server as IVirtualServer & {
      handleStreamingRequest?: (
        method: string, url: string, headers: Record<string, string>, body: Buffer | undefined,
        onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
        onChunk: (chunk: string | Uint8Array) => void,
        onEnd: () => void,
      ) => Promise<void>;
    };
    if (typeof server.handleStreamingRequest === 'function') {
      await server.handleStreamingRequest(
        method, url, headers, bodyBuffer,
        (statusCode, statusMessage, respHeaders) => callbacks.start(statusCode, statusMessage, respHeaders),
        (chunk) => callbacks.chunk(typeof chunk === 'string' ? _encoder.encode(chunk) : ownedBytes(chunk)),
        () => callbacks.end(),
      );
      return true;
    }
    const response = await this.handleRequest(port, method, url, headers, body);
    callbacks.start(response.statusCode, response.statusMessage ?? '', response.headers as Record<string, string>);
    if (response.body) {
      const body = typeof response.body === 'string' ? _encoder.encode(response.body) : response.body;
      callbacks.chunk(ownedBytes(body));
    }
    callbacks.end();
    return true;
  }

  private async streamToServiceWorker(
    id: number,
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer
  ): Promise<void> {
    const virtualServer = this.servers.get(port);

    if (!virtualServer) {
      this.messageChannel?.port1.postMessage({
        type: 'stream-start',
        id,
        data: { statusCode: 503, statusMessage: 'Service Unavailable', headers: {} },
      });
      this.messageChannel?.port1.postMessage({ type: 'stream-end', id });
      return;
    }

    // A guest's server is a port: its answer is streamed off the connection
    // as it arrives, which is what the page reads chunk by chunk.
    if (virtualServer.server === null) {
      const bodyBuffer = body ? Buffer.from(new Uint8Array(body)) : undefined;
      const named = Object.keys(headers).some((name) => name.toLowerCase() === 'host');
      const authority = `${virtualServer.hostname && virtualServer.hostname !== '0.0.0.0' && virtualServer.hostname !== '::' ? virtualServer.hostname : '127.0.0.1'}:${port}`;
      await __streamOverLoopback(
        port, method, url, named ? headers : { ...headers, host: authority }, bodyBuffer,
        (statusCode, statusMessage, respHeaders) => {
          this.messageChannel?.port1.postMessage({ type: 'stream-start', id, data: { statusCode, statusMessage, headers: respHeaders } });
        },
        (chunk) => {
          // A pooled Buffer's `.slice()` is a window on the same 8 KB; the
          // transfer of `copy.buffer` would move the pool. These are the
          // bytes the view names, in a buffer of their own.
          const copy = ownedBytes(chunk);
          this.messageChannel?.port1.postMessage({ type: 'stream-chunk', id, data: copy.buffer }, [copy.buffer]);
        },
        () => { this.messageChannel?.port1.postMessage({ type: 'stream-end', id }); },
      );
      return;
    }

    // Check if the server supports streaming (has handleStreamingRequest method)
    const server = virtualServer.server as any;
    if (typeof server.handleStreamingRequest === 'function') {
      ServerBridge.DEBUG && console.log('[ServerBridge] 🟢 Server has streaming support, calling handleStreamingRequest');
      // Use streaming handler
      const bodyBuffer = body ? Buffer.from(new Uint8Array(body)) : undefined;

      await server.handleStreamingRequest(
        method,
        url,
        headers,
        bodyBuffer,
        // onStart - called with headers
        (statusCode: number, statusMessage: string, respHeaders: Record<string, string>) => {
          ServerBridge.DEBUG && console.log('[ServerBridge] 🟢 onStart called, sending stream-start');
          this.messageChannel?.port1.postMessage({
            type: 'stream-start',
            id,
            data: { statusCode, statusMessage, headers: respHeaders },
          });
        },
        // onChunk - called for each chunk
        (chunk: string | Uint8Array) => {
          const bytes = typeof chunk === 'string' ? _encoder.encode(chunk) : chunk;
          const chunkBase64 = uint8ToBase64(bytes);
          ServerBridge.DEBUG && console.log('[ServerBridge] 🟡 onChunk called, sending stream-chunk, size:', chunkBase64.length);
          this.messageChannel?.port1.postMessage({
            type: 'stream-chunk',
            id,
            data: { chunkBase64 },
          });
        },
        // onEnd - called when response is complete
        () => {
          ServerBridge.DEBUG && console.log('[ServerBridge] 🟢 onEnd called, sending stream-end');
          this.messageChannel?.port1.postMessage({ type: 'stream-end', id });
        }
      );
    } else {
      // Fall back to regular request handling
      const bodyBuffer = body ? Buffer.from(new Uint8Array(body)) : undefined;
      const response = await virtualServer.server.handleRequest(method, url, headers, bodyBuffer);

      // Send as a single stream
      this.messageChannel?.port1.postMessage({
        type: 'stream-start',
        id,
        data: {
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
        },
      });

      if (response.body && response.body.length > 0) {
        const bytes = response.body instanceof Uint8Array ? response.body : new Uint8Array(0);
        this.messageChannel?.port1.postMessage({
          type: 'stream-chunk',
          id,
          data: { chunkBase64: uint8ToBase64(bytes) },
        });
      }

      this.messageChannel?.port1.postMessage({ type: 'stream-end', id });
    }
  }

  /**
   * Send message to Service Worker
   */
  private notifyServiceWorker(type: string, data: unknown): void {
    if (this.serviceWorkerReady && this.messageChannel) {
      this.messageChannel.port1.postMessage({ type, data });
    }
  }

  /**
   * Create a mock request handler for testing without Service Worker
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      // Check if this is a virtual server request
      const match = url.pathname.match(/^\/__virtual__\/(\d+)(\/.*)?$/);
      if (!match) {
        throw new Error('Not a virtual server request');
      }

      const port = parseInt(match[1], 10);
      const path = match[2] || '/';

      // Build headers object
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Get body if present
      let body: ArrayBuffer | undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = await request.arrayBuffer();
      }

      // Handle request
      const response = await this.handleRequest(
        port,
        request.method,
        path + url.search,
        headers,
        body
      );

      // Convert to fetch Response
      // A header sent more than once, `set-cookie` above all, is appended as
      // many times; a fetch Response takes each value on its own.
      const answerHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const each of Array.isArray(value) ? value : [value]) answerHeaders.append(name, each);
      }
      return new Response(response.body as unknown as BodyInit, {
        status: response.statusCode,
        statusText: response.statusMessage ?? '',
        headers: answerHeaders,
      });
    };
  }
}

// Global bridge instance
let globalBridge: ServerBridge | null = null;

/**
 * Get or create the global server bridge
 */
export function getServerBridge(options?: BridgeOptions): ServerBridge {
  if (!globalBridge) {
    globalBridge = new ServerBridge(options);
  }
  return globalBridge;
}

/**
 * Reset the global bridge (for testing)
 */
export function resetServerBridge(): void {
  globalBridge = null;
}

export default ServerBridge;
