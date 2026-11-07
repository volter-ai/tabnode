/**
 * Server Bridge
 * Connects Service Worker requests to virtual HTTP servers
 */

import {
  __requestOverLoopback, __streamOverLoopback, __upgradeOverLoopback, connectLoopback, refused,
  type ResponseData, type LoopbackStreamFlow,
} from './node-lib/http-bridge';
import { loadNodeLib } from './node-lib/load';
import { watchListens } from './node-lib/binding/tcp_wrap';
import { callingSockets, treeSocketsOf } from './host-sockets';
import type { Socket } from './node-lib/net-module';
import { Buffer } from './node-lib/buffer-module';
import { uint8ToBase64 } from './utils/binary-encoding';
import { PortBridge, type IVirtualServer, type VirtualServer, type BridgeOptions } from './port-bridge';

const _encoder = new TextEncoder();

export type { IVirtualServer, VirtualServer, BridgeOptions, InitServiceWorkerOptions } from './port-bridge';

/**
 * A guest that called `listen` is a server: it answers requests on its port,
 * over a connection the bridge makes as its container's process. The page
 * observes registrations by wrapping `registerServer` and reading
 * `server.handleRequest`, so each listen registers a server whose
 * `handleRequest` answers.
 */
function guestListeningServer(tree: object | undefined, port: number, address: string): IVirtualServer {
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
      __requestOverLoopback(tree, port, method, url, headers, (typeof body === 'string' ? Buffer.from(body) : body) as Buffer | undefined),
  };
}

/*
 * A virtual WebSocket (ADR-0014). The page's connector posts a `connect` on the `vite-ws-channel` channel, and the
 * bridge its runtime registered the connector with (§3) opens Node's own WebSocket client, undici's, to the guest's
 * port over the container's loopback (§1). Every protocol case is undici's; the bridge carries the channel (§2): the
 * page's sends and closes in, the socket's open, messages and single close out.
 */

/** The size limit of a message, either way (browser-substrate ADR-0099 *Kept*, `MAX_VIRTUAL_WEBSOCKET_FRAME_BYTES`). */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** What a connector sends on the channel (ADR-0014 §2). */
interface ChannelSignal {
  type: string;
  clientId: string;
  /** `connect`: the connector's registered id (§3). */
  connector?: string;
  /** `connect`: a URL whose port is the guest port and whose path and query are the request target. */
  url?: string;
  protocols?: string[];
  /** `connect`: the request's headers, a `HeadersInit`. */
  headers?: unknown;
  /** `connect`: `"none"` asks for a byte pipe (§4); anything else, or nothing, is a WebSocket. */
  framing?: string;
  /** `message`. */
  payload?: unknown;
  /** `disconnect`. */
  kind?: string;
  code?: number;
  reason?: string;
}

/** One client the bridge carries, from its `connect` to its single `close`. */
interface CarriedClient {
  /** The page's `message`; a throw fails the client. */
  deliver(payload: unknown): void;
  /** The page's `disconnect`. */
  disconnect(kind: 'close' | 'fail', code: number | undefined, reason: string): void;
  /** The bridge's own close (§5): the connection ended, nothing more posted. */
  release(): void;
}

/** A bridge's side of one client: the channel's posts addressed to it, and its end. */
interface ClientLink {
  post(message: Record<string, unknown>): void;
  /** Nothing listened on the port in this bridge's container (§3). */
  refused(): void;
  /** The client's single `close` has been posted, or will never be: it leaves the bridge. */
  forget(): void;
}

/** The bridges each connector id is registered with (§3). */
const registeredConnectors = new Map<string, Set<ServerBridge>>();
/** The bridges that refused a client's connect, until every bridge its connector is registered with has (§3). */
const refusals = new Map<string, Set<ServerBridge>>();

/** The undici Node bundles, as the bridge uses it (ADR-0014 §1): the engine's own, loaded at the first virtual WebSocket. */
interface UndiciWebSocket extends EventTarget {
  binaryType: string;
  readonly readyState: number;
  readonly protocol: string;
  readonly extensions: string;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
interface UndiciDispatcher {
  dispatch(options: object, handler: object): boolean;
  destroy(): Promise<void>;
}
interface Undici {
  WebSocket: (new (url: string, init: { protocols: string[]; dispatcher: object; headers: [string, string][] }) => UndiciWebSocket)
    & { CONNECTING: number; OPEN: number };
  EnvHttpProxyAgent: new (options: object) => UndiciDispatcher;
}
const engineUndici = (): Undici => loadNodeLib('internal/deps/undici/undici') as Undici;

/** The error a cancelled connection is answered with, as an aborted connection is answered. */
const cancelled = (): Error => Object.assign(new Error('The connection was cancelled'), { code: 'ECONNABORTED' });

/** A `HeadersInit` as name and value pairs: a list of pairs or a record of strings; anything else is refused. */
function headerPairs(init: unknown): [string, string][] {
  if (init === undefined || init === null) return [];
  if (typeof init !== 'object') throw new TypeError('headers are a list of pairs or a record');
  const pairs = Array.isArray(init) ? init : Object.entries(init as Record<string, unknown>);
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new TypeError('a header is a name and a value');
    }
  }
  return pairs as [string, string][];
}

/** The authority the page addressed, from its `Host`, where it is one; else the guest port on `localhost`. */
function authorityOf(pairs: readonly [string, string][], port: number): string {
  const host = pairs.find(([name]) => name.toLowerCase() === 'host')?.[1];
  return host !== undefined && /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/iu.test(host) ? host : `localhost:${port}`;
}

/** A field's value as undici hands it: a string, a Buffer, or a list of them. */
const fieldValues = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).map((each) => (each as { toString(encoding?: string): string }).toString('latin1'));

/** The `Set-Cookie` values of a head as `onUpgrade` gives it (name and value alternating) or as `onRequestUpgrade` does. */
function setCookieOf(head: unknown): string[] {
  if (Array.isArray(head)) {
    const values: string[] = [];
    for (let index = 0; index + 1 < head.length; index += 2) {
      if (String(head[index]).toLowerCase() === 'set-cookie') values.push(...fieldValues(head[index + 1]));
    }
    return values;
  }
  if (head === null || typeof head !== 'object') return [];
  const entry = Object.entries(head as Record<string, unknown>).find(([name]) => name.toLowerCase() === 'set-cookie');
  return entry && entry[1] != null ? fieldValues(entry[1]) : [];
}

/**
 * undici's handler for one request, with its upgrade observed (ADR-0014 §1): the 101's `Set-Cookie` and the upgraded
 * socket are handed to `seen`, and the call goes on to undici unchanged.
 */
function observeUpgrade(handler: object, seen: (setCookie: string[], socket: Socket) => void): object {
  return new Proxy(handler, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (key === 'onUpgrade') {
        return function (this: unknown, status: number, rawHeaders: unknown, socket: Socket): unknown {
          if (status === 101) seen(setCookieOf(rawHeaders), socket);
          return value.call(this, status, rawHeaders, socket);
        };
      }
      if (key === 'onRequestUpgrade') {
        return function (this: unknown, controller: unknown, status: number, headers: unknown, socket: Socket): unknown {
          if (status === 101) seen(setCookieOf(headers), socket);
          return value.call(this, controller, status, headers, socket);
        };
      }
      return value;
    },
  });
}

/** A WebSocket client: Node's own, undici's, to the guest's `port` over `tree`'s loopback (ADR-0014 §1, §2). */
function carryWebSocket(link: ClientLink, tree: object | undefined, port: number, target: string,
  pairs: [string, string][], protocols: string[]): CarriedClient {
  const undici = engineUndici();
  let refusedHere = false;
  let socket: Socket | null = null;
  let setCookie: string[] = [];
  let gone = false;
  let released = false;
  let connecting: { connection: Socket; answer: (error: Error | null, connected: Socket | null) => void } | null = null;
  const agent = new undici.EnvHttpProxyAgent({
    // No proxy is ever taken from the engine's environment.
    httpProxy: '',
    httpsProxy: '',
    // The connection is the container's, to the guest's port, whatever authority the URL names.
    // The connection is this client's until its answer hands it to undici (§1): a cancel before then destroys it.
    connect: (_options: unknown, answer: (error: Error | null, connected: Socket | null) => void): void => {
      if (gone || released) { answer(cancelled(), null); return; }
      const connection = connectLoopback(tree, port);
      const ready = (connection as unknown as { encrypted?: boolean }).encrypted === true ? 'secureConnect' : 'connect';
      const attempt = { connection, answer };
      connecting = attempt;
      connection.once(ready, () => {
        if (connecting !== attempt) return;
        connecting = null;
        answer(null, connection);
      });
      connection.once('error', (error: Error) => {
        if (connecting !== attempt) return;
        connecting = null;
        if (refused(error)) refusedHere = true;
        answer(error, null);
      });
    },
  });
  const dispatcher = {
    webSocketOptions: { maxPayloadSize: MAX_MESSAGE_BYTES },
    dispatch: (options: object, handler: object): boolean => agent.dispatch(options, observeUpgrade(handler, (cookies, upgraded) => {
      setCookie = cookies;
      socket = upgraded;
      // A 101 for a client already gone sends no `connected`.
      if (gone || released) upgraded.destroy();
    })),
  };
  const headers = pairs.filter(([name]) => name.toLowerCase() !== 'host');
  const ws = new undici.WebSocket(`ws://${authorityOf(pairs, port)}${target}`, { protocols, dispatcher, headers });
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    if (gone || released) return;
    link.post({ type: 'connected', protocol: ws.protocol, extensions: ws.extensions, setCookie });
  });
  ws.addEventListener('message', (event) => {
    if (released) return;
    link.post({ type: 'message', payload: (event as MessageEvent).data });
  });
  ws.addEventListener('close', (event) => {
    void agent.destroy().catch(() => undefined);
    link.forget();
    if (released) return;
    if (refusedHere && socket === null) { link.refused(); return; }
    const closed = event as CloseEvent;
    link.post({ type: 'close', code: closed.code, reason: closed.reason, wasClean: closed.wasClean });
  });
  // While the connection is being made, a close or a fail cancels it (§2): undici fails it, a loopback connection not
  // yet handed to undici is destroyed and its connect answered with the cancel, and a socket already upgraded is
  // destroyed before undici takes it.
  const cancel = (): void => {
    gone = true;
    ws.close();
    const attempt = connecting;
    connecting = null;
    if (attempt) {
      attempt.connection.destroy();
      attempt.answer(cancelled(), null);
    }
    socket?.destroy();
  };
  return {
    deliver: (payload) => {
      ws.send(payload as string | ArrayBuffer | ArrayBufferView);
    },
    disconnect: (kind, code, reason) => {
      if (ws.readyState === undici.WebSocket.CONNECTING) { cancel(); return; }
      // A fail, whatever its code, closes the connection with no Close (RFC 6455 §7.1.1; a code is ADR-0014 *Kept* (2)).
      if (kind === 'fail') { socket?.destroy(); return; }
      // 1001 is a Close with no body (ADR-0014 *Kept* (1)); no code is `close()`'s own case, a reason making it 1000.
      if (code === 1001) ws.close();
      else ws.close(code, reason);
    },
    // By its state, as the runtime's release ends a socket (§5): CONNECTING cancelled, OPEN closed (*Kept* (1)), and
    // CLOSING aborted, since undici's `close` does nothing for a CLOSING socket and the carrier goes with the runtime.
    release: () => {
      released = true;
      if (ws.readyState === undici.WebSocket.CONNECTING) cancel();
      else if (ws.readyState === undici.WebSocket.OPEN) ws.close();
      else socket?.destroy();
    },
  };
}

/**
 * A byte pipe (ADR-0014 §4): the same upgrade request, and then the connection's bytes as they are, every read one
 * `message` and every `message` one write. VS Code's `RemoteExtensionHostAgentServer` writes its own 101 and then
 * reads and writes its remote protocol on the socket, unframed.
 */
function carryBytePipe(link: ClientLink, tree: object | undefined, port: number, target: string,
  pairs: [string, string][], protocols: string[]): CarriedClient {
  let socket: Socket | null = null;
  let gone = false;
  let released = false;
  // The upgrade request's connection is the request's until its 101 hands it here; this aborts it before then.
  const upgrade = new AbortController();
  const request: Record<string, string> = {};
  for (const [name, value] of pairs) if (name.toLowerCase() !== 'host') request[name] = value;
  Object.assign(request, {
    Host: authorityOf(pairs, port),
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': uint8ToBase64(crypto.getRandomValues(new Uint8Array(16))),
    ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
  });
  void __upgradeOverLoopback(tree, port, 'GET', target, request, upgrade.signal).then((result) => {
    if (gone || released) { result.socket?.destroy(); return; }
    if (result.statusCode === 503 && !result.socket) { link.forget(); link.refused(); return; }
    if (result.statusCode !== 101 || !result.socket) {
      link.forget();
      link.post({ type: 'close', code: 1006, reason: '', wasClean: false });
      return;
    }
    const upgraded = result.socket;
    socket = upgraded;
    upgraded.on('data', (chunk: Uint8Array) => {
      if (released) return;
      link.post({ type: 'message', payload: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) });
    });
    upgraded.on('close', (hadError: boolean) => {
      link.forget();
      if (released) return;
      // No closing handshake: an end without error is 1005, clean; an error is 1006.
      link.post({ type: 'close', code: hadError ? 1006 : 1005, reason: '', wasClean: !hadError });
    });
    link.post({
      type: 'connected',
      protocol: result.headers['sec-websocket-protocol'] ?? '',
      extensions: '',
      setCookie: setCookieOf(result.rawHeaders),
    });
  });
  return {
    deliver: (payload) => {
      if (!socket) throw new Error('a byte pipe takes no message before it is connected');
      socket.write(typeof payload === 'string' ? _encoder.encode(payload) : ArrayBuffer.isView(payload)
        ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength).slice() : new Uint8Array(payload as ArrayBuffer));
    },
    disconnect: (kind) => {
      if (!socket) {
        // Still being made: the upgrade request is cancelled, and this is the client's one `close`.
        gone = true;
        upgrade.abort();
        link.forget();
        link.post({ type: 'close', code: 1006, reason: '', wasClean: false });
        return;
      }
      if (kind === 'fail') socket.destroy();
      else socket.end();
    },
    release: () => {
      released = true;
      upgrade.abort();
      socket?.destroy();
    },
  };
}

/**
 * The channel a bridge's clients arrive on (ADR-0014 §2, §3), opened for the guest whose servers this bridge holds. It
 * is the bridge's to hold and the bridge's to give back: a subscribed `BroadcastChannel` is a `MessagePort` the host's
 * loop counts, so it is unreferenced where the host counts handles against exit (a browser's has no `unref` and holds
 * nothing open), and `close` gives it up. A host resource the engine opens for a guest must not outlive the guest,
 * and must never be the reason someone else's process stays alive.
 */
class SocketChannel {
  private readonly channel: BroadcastChannel;
  private readonly clients = new Map<string, CarriedClient>();
  private open = true;

  constructor(private readonly bridge: ServerBridge) {
    this.channel = new BroadcastChannel('vite-ws-channel');
    (this.channel as unknown as { unref?: () => void }).unref?.();
    this.channel.addEventListener('message', (event) => this.receive(event.data as ChannelSignal));
  }

  private post(clientId: string, message: Record<string, unknown>): void {
    if (!this.open) return;
    if (message.type === 'connected' || message.type === 'close') refusals.delete(clientId);
    this.channel.postMessage({ ...message, targetClient: clientId });
  }

  private linkFor(clientId: string, connector: string): ClientLink {
    return {
      post: (message) => this.post(clientId, message),
      refused: () => {
        const registered = registeredConnectors.get(connector);
        const refusing = refusals.get(clientId) ?? new Set<ServerBridge>();
        refusing.add(this.bridge);
        if (registered && [...registered].some((bridge) => !refusing.has(bridge))) { refusals.set(clientId, refusing); return; }
        this.post(clientId, { type: 'close', code: 1006, reason: '', wasClean: false });
      },
      forget: () => { this.clients.delete(clientId); },
    };
  }

  /** A client whose operation threw is failed (ADR-0014 §2). */
  private fail(clientId: string, client: CarriedClient): void {
    try { client.disconnect('fail', undefined, ''); } catch { /* a client already ending is ending */ }
  }

  private receive(signal: ChannelSignal): void {
    if (!signal || typeof signal !== 'object' || typeof signal.clientId !== 'string') return;
    if (signal.type === 'connect') {
      if (typeof signal.connector !== 'string' || !this.bridge.hasConnector(signal.connector) || this.clients.has(signal.clientId)) return;
      const link = this.linkFor(signal.clientId, signal.connector);
      let url: URL;
      let pairs: [string, string][];
      try {
        url = new URL(signal.url!);
        pairs = headerPairs(signal.headers);
      } catch {
        link.post({ type: 'close', code: 1006, reason: '', wasClean: false });
        return;
      }
      const port = Number(url.port);
      const protocols = Array.isArray(signal.protocols) ? signal.protocols : [];
      const carry = signal.framing === 'none' ? carryBytePipe : carryWebSocket;
      try {
        this.clients.set(signal.clientId, carry(link, this.bridge.tree, port, url.pathname + url.search, pairs, protocols));
      } catch {
        // undici's constructor refused the request (a protocol list §2.2 refuses).
        this.clients.delete(signal.clientId);
        link.post({ type: 'close', code: 1006, reason: '', wasClean: false });
      }
      return;
    }
    const client = this.clients.get(signal.clientId);
    if (!client) return;
    try {
      if (signal.type === 'message') client.deliver(signal.payload);
      else if (signal.type === 'disconnect') {
        client.disconnect(signal.kind === 'fail' ? 'fail' : 'close', typeof signal.code === 'number' ? signal.code : undefined,
          typeof signal.reason === 'string' ? signal.reason : '');
      }
    } catch {
      this.fail(signal.clientId, client);
    }
  }

  /** The bridge's close (ADR-0014 §5): every client told `close` 1006 while the channel can carry it, then ended. */
  close(): void {
    const clients = [...this.clients];
    this.clients.clear();
    for (const [clientId] of clients) this.post(clientId, { type: 'close', code: 1006, reason: '', wasClean: false });
    this.open = false;
    try { this.channel.close(); } catch { /* a channel the realm already closed is closed */ }
    for (const [, client] of clients) {
      try { client.release(); } catch { /* a client already ending is ending */ }
    }
  }
}

/**
 * The page's requests answered by a guest's own servers, over connections the bridge makes as its container's process,
 * and the page's virtual WebSockets carried to them (ADR-0014).
 */
export class ServerBridge extends PortBridge {
  /** The channel this bridge's virtual WebSockets arrive on, held so it can be given back. */
  private sockets: SocketChannel | null = null;
  /** The connector ids registered with this bridge (ADR-0014 §3). */
  private readonly connectors = new Set<string>();

  /** The tree of the process this bridge acts as, its container's; the calling process's where none was given. */
  readonly tree: object | undefined;
  private stopWatching: (() => void) | null = null;

  constructor(options: BridgeOptions = {}) {
    super(options);
    this.tree = options.tree;
    // A guest's servers register themselves, from the port they take.
    this.watchGuestPorts();
    this.sockets = typeof BroadcastChannel === 'undefined' ? null : new SocketChannel(this);
  }

  /**
   * Every port a guest starts listening on becomes a server this bridge can
   * answer for, and every port it stops listening on stops being one. The
   * news comes from the net binding, as a handle made through this bridge's
   * process's socket calls starts and stops listening; the engine's `http`
   * is Node's own file and knows nothing of a page. A process with no socket
   * calls listens on nothing.
   */
  private readonly guestServers = new WeakSet<IVirtualServer>();

  private watchGuestPorts(): void {
    const sockets = this.tree === undefined ? callingSockets() : treeSocketsOf(this.tree);
    if (!sockets) return;
    this.stopWatching = watchListens(sockets,
      (port, address) => {
        if (this.servers.has(port)) return;
        const hostname = address || '0.0.0.0';
        const server = guestListeningServer(this.tree, port, hostname);
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

  /**
   * Registers a connector's random id with this bridge (ADR-0014 §3): the bridge answers that connector's `connect`s,
   * and only registered ones. Answers the call that removes it.
   */
  registerConnector(id: string): () => void {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('a connector id is a non-empty string');
    this.connectors.add(id);
    let bridges = registeredConnectors.get(id);
    if (!bridges) { bridges = new Set(); registeredConnectors.set(id, bridges); }
    bridges.add(this);
    return () => this.unregisterConnector(id);
  }

  /** Whether a connector's id is registered with this bridge. */
  hasConnector(id: string): boolean {
    return this.connectors.has(id);
  }

  private unregisterConnector(id: string): void {
    this.connectors.delete(id);
    const bridges = registeredConnectors.get(id);
    bridges?.delete(this);
    if (bridges?.size === 0) registeredConnectors.delete(id);
  }

  override close(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    for (const id of [...this.connectors]) this.unregisterConnector(id);
    this.sockets?.close();
    this.sockets = null;
    super.close();
  }

  /** A guest's listener (a request adapter) is answered over a connection to its port. */
  protected override isGuest(entry: VirtualServer): boolean {
    return entry.server === null || this.guestServers.has(entry.server);
  }

  protected override requestGuest(port: number, method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined): Promise<ResponseData> {
    return __requestOverLoopback(this.tree, port, method, url, headers, body as Buffer | undefined);
  }

  protected override streamGuest(
    port: number, method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined,
    onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
    onChunk: (chunk: Uint8Array) => void,
    onEnd: () => void,
    flow?: LoopbackStreamFlow,
  ): Promise<void> {
    return __streamOverLoopback(this.tree, port, method, url, headers, body as Buffer | undefined, onStart, onChunk, onEnd, flow);
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
