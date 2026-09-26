/**
 * Server Bridge
 * Connects Service Worker requests to virtual HTTP servers
 */

import {
  __requestOverLoopback, __streamOverLoopback, __upgradeOverLoopback, __listening,
  type ResponseData, type LoopbackStreamFlow,
} from './node-lib/http-bridge';
import { setPortWatchers } from './node-lib/net-module';
import { __bridgeConnection } from './node-lib/net-module';
import type { Socket } from './node-lib/net-module';
import { Buffer } from './node-lib/buffer-module';
import { uint8ToBase64 } from './utils/binary-encoding';
import { PortBridge, type IVirtualServer, type VirtualServer, type BridgeOptions } from './port-bridge';

const _encoder = new TextEncoder();

export type { IVirtualServer, VirtualServer, BridgeOptions, InitServiceWorkerOptions } from './port-bridge';

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
      // this engine's bridge hands its servers a Buffer (`bodyOf`)
      __requestOverLoopback(port, method, url, headers, (typeof body === 'string' ? Buffer.from(body) : body) as Buffer | undefined),
  };
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

/**
 * A partly read frame stream: the chunks not yet a whole frame, how many
 * bytes they hold, how many the frame they begin needs once its header is
 * read (0 while it is not), and a fragmented message in progress.
 */
export interface FrameState {
  pending: Uint8Array[];
  pendingBytes: number;
  needed: number;
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
  /** The origin of the page that opened the socket, which a browser sends on every handshake. */
  origin?: string;
  /** The authority the client addressed, its handshake's Host; the engine's own URL names the port. */
  host?: string;
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
  const start = header.length + mask.length;
  if (!masked) out.set(payload, start);
  else for (let index = 0; index < length; index += 1) out[start + index] = payload[index] ^ mask[index & 3];
  return out;
}
/**
 * The frames whole in what has arrived, each handed on once. A frame larger
 * than a socket's chunk arrives over many: they are kept as they came and
 * joined once, when the frame's header says they hold it all. Joining them
 * on every chunk, as numbers spread into an array, was 740 ms of the owner's
 * main thread opening the model editor (2026-09-26), every socket of every
 * process waiting behind it.
 */
/** The largest message the page's socket takes (browser-substrate's 32 MiB), with room. */
const __SUBSTRATE_MAX_FRAME_BYTES = 64 * 1024 * 1024;
export function __substrateParseFrames(state: FrameState, chunk: Uint8Array, onFrame: (opcode: number, payload: Uint8Array) => void): void {
  // A chunk kept past this call is copied: the socket may reuse its buffer.
  if (state.pendingBytes + chunk.byteLength < state.needed) {
    state.pending.push(new Uint8Array(chunk));
    state.pendingBytes += chunk.byteLength;
    return;
  }
  state.pending.push(chunk);
  state.pendingBytes += chunk.byteLength;
  let joined: Uint8Array;
  if (state.pending.length === 1) joined = state.pending[0];
  else {
    joined = new Uint8Array(state.pendingBytes);
    let cursor = 0;
    for (const part of state.pending) { joined.set(part, cursor); cursor += part.byteLength; }
  }
  state.pending = [];
  state.pendingBytes = 0;
  state.needed = 0;
  let offset = 0;
  for (;;) {
    if (joined.length - offset < 2) break;
    const b0 = joined[offset], b1 = joined[offset + 1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f, at = offset + 2;
    if (length === 126) { if (joined.length - at < 2) break; length = (joined[at] << 8) | joined[at + 1]; at += 2; }
    else if (length === 127) { if (joined.length - at < 8) break; length = 0; for (let index = 0; index < 8; index += 1) length = length * 256 + joined[at + index]; at += 8; }
    // A frame larger than any the page would take is the protocol's 1009,
    // not bytes kept until they arrive.
    if (length > __SUBSTRATE_MAX_FRAME_BYTES) {
      state.pending = []; state.pendingBytes = 0; state.needed = 0; state.fragments = null;
      onFrame(8, new Uint8Array([0x03, 0xf1]));
      return;
    }
    let mask: Uint8Array | undefined;
    if (masked) { if (joined.length - at < 4) break; mask = joined.subarray(at, at + 4); at += 4; }
    if (joined.length - at < length) { state.needed = at + length - offset; break; }
    // A copy of the bytes, whatever `joined` is: a Buffer's `slice` is a
    // view of it, and its species is the guest's to redefine.
    const payload = new Uint8Array(length);
    payload.set(joined.subarray(at, at + length));
    if (mask) for (let index = 0; index < length; index += 1) payload[index] ^= mask[index & 3];
    offset = at + length;
    if (opcode === 0 && state.fragments) { state.fragments.parts.push(payload); if (fin) { const parts = state.fragments.parts; const total = parts.reduce((sum, part) => sum + part.length, 0); const whole = new Uint8Array(total); let cursor = 0; for (const part of parts) { whole.set(part, cursor); cursor += part.length; } const op = state.fragments.opcode; state.fragments = null; onFrame(op, whole); } }
    else if (!fin && (opcode === 1 || opcode === 2)) state.fragments = { opcode, parts: [payload] };
    else onFrame(opcode, payload);
  }
  if (offset < joined.length) {
    const rest = new Uint8Array(joined.length - offset);
    rest.set(joined.subarray(offset));
    state.pending = [rest];
    state.pendingBytes = rest.byteLength;
  }
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
  const state: FrameState = { pending: [], pendingBytes: 0, needed: 0, fragments: null };
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
        // Host is the authority the client addressed, as an HTTP request's is
        Host: typeof data2.host === "string" && /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/iu.test(data2.host) ? data2.host : url2.host,
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        ...(protocols.length ? { "Sec-WebSocket-Protocol": protocols.join(", ") } : {}),
        // A browser sends Origin on every WebSocket handshake, and a server's
        // check of it is how it refuses sockets from pages it did not serve.
        ...(typeof data2.origin === "string" && /^https?:\/\/[^/]+$/u.test(data2.origin) ? { Origin: data2.origin } : {}),
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

export class ServerBridge extends PortBridge {
  /** The upgrade channel this bridge opened, held so it can be given back. */
  private upgradeChannel: BroadcastChannel | null = null;

  constructor(options: BridgeOptions = {}) {
    super(options);
    // A guest's servers register themselves, from the port they take.
    this.watchGuestPorts();
    this.upgradeChannel = __substrateListenForUpgrades(this);
  }

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

  override close(): void {
    if (this.upgradeChannel) {
      try { this.upgradeChannel.close(); } catch { /* a channel the realm already closed is closed */ }
      this.upgradeChannel = null;
    }
    super.close();
  }

  /** A guest's listener (the old null sentinel, now a request adapter) is answered over the loopback. */
  protected override isGuest(entry: VirtualServer): boolean {
    return entry.server === null || this.guestServers.has(entry.server);
  }

  protected override requestGuest(port: number, method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined): Promise<ResponseData> {
    return __requestOverLoopback(port, method, url, headers, body as Buffer | undefined);
  }

  protected override streamGuest(
    port: number, method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined,
    onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
    onChunk: (chunk: Uint8Array) => void,
    onEnd: () => void,
    flow?: LoopbackStreamFlow,
  ): Promise<void> {
    return __streamOverLoopback(port, method, url, headers, body as Buffer | undefined, onStart, onChunk, onEnd, flow);
  }

  /** A server of this engine reads a request's body as Node's Buffer. */
  protected override bodyOf(bytes: Uint8Array): Uint8Array {
    return Buffer.from(bytes);
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
