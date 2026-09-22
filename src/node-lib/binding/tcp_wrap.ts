/**
 * `internalBinding('tcp_wrap')`: the engine's loopback, in libuv's shape.
 *
 * One engine is one host. A `bind` reserves a port, a `listen` starts
 * answering on it, and a `connect` to a loopback address on a port something
 * is listening on pairs two handles whose writes are each other's reads —
 * which is what the engine has always done for a `net` connect, moved here so
 * that Node's own `net.js` runs on it. A connect to anything that is not this
 * host is `ECONNREFUSED`, because there is nothing else to reach: a page's
 * request to the outside goes through `fetch`, not through a socket.
 *
 * A wildcard bind holds the port for both families, as a dual-stack `::` bind
 * does on Linux, so `connect('127.0.0.1')` reaches a server that bound `::`.
 */
import { LibuvStreamWrap } from './stream_wrap';
import { __adoptHandle, ownerOf } from './handles';
import { UV_EADDRINUSE, UV_ECONNREFUSED, UV_EINVAL, UV_ENOTSUP } from './uv';

/** libuv's `uv_tcp_t` flavours, and the two flags `getFlags` builds. */
export const constants = {
  SOCKET: 0,
  SERVER: 1,
  UV_TCP_IPV6ONLY: 1,
  UV_TCP_REUSEPORT: 4,
};

/** What `getsockname`/`getpeername` fill in. */
export interface SockName {
  address: string;
  family: string;
  port: number;
}

/** Node's `TCPConnectWrap`: the request a connect fills and is answered through. */
export class TCPConnectWrap {
  oncomplete: ((status: number, handle: unknown, req: unknown, readable: boolean, writable: boolean) => void) | null = null;
  address = '';
  port = 0;
  localAddress: string | undefined = undefined;
  localPort: number | undefined = undefined;
  addressType: number | undefined = undefined;
}

/**
 * Every port this engine holds: a handle that has bound one, listening or
 * not, and every ephemeral port a client end was given. One space, because
 * one engine is one host and a port is taken once.
 */
const boundPorts = new Map<number, TCP>();
const ephemeralPorts = new Set<number>();

/** Linux's ephemeral range, walked in order as a kernel walks it. */
let nextEphemeral = 49152;
function allocatePort(): number {
  for (let tries = 0; tries < 16384; tries += 1) {
    const port = nextEphemeral;
    nextEphemeral = nextEphemeral >= 65535 ? 49152 : nextEphemeral + 1;
    if (!boundPorts.has(port) && !ephemeralPorts.has(port)) return port;
  }
  return 0;
}

/** Loopback and the wildcards: what this engine answers for. */
function isThisHost(address: string): boolean {
  if (!address) return true;
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const name = bare.split('%')[0].toLowerCase();
  return name === 'localhost' || name === '0.0.0.0' || name === '::' || name === '::1' ||
    name === '0:0:0:0:0:0:0:1' || name === '0:0:0:0:0:0:0:0' || name.startsWith('127.');
}

/**
 * What the page bridge is told when a guest starts or stops listening. The
 * bridge used to learn this from the engine's own `http.Server`; `http` is
 * Node's own file now and knows nothing of a page, so the news comes from
 * where a port is actually taken.
 */
type ListenWatcher = (port: number, address: string) => void;
// eslint-disable-next-line no-var, vars-on-top
var onListenWatcher: ListenWatcher | null = null;
// eslint-disable-next-line no-var, vars-on-top
var onCloseWatcher: ((port: number) => void) | null = null;
export function setPortWatchers(onListen: ListenWatcher | null, onClose: ((port: number) => void) | null): void {
  onListenWatcher = onListen;
  onCloseWatcher = onClose;
}

/** The listening handle a connect to this port reaches, if any. */
export function listenerOnPort(port: number): TCP | undefined {
  const bound = boundPorts.get(port);
  return bound && bound.listening ? bound : undefined;
}

export class TCP extends LibuvStreamWrap {
  /** `constants.SOCKET` or `constants.SERVER`. */
  readonly type: number;
  listening = false;
  /** Set by `net.js` on a server handle; how an accepted pairing is announced. */
  onconnection: ((status: number, clientHandle: TCP) => void) | null = null;

  private local: SockName | null = null;
  private remote: SockName | null = null;
  private ephemeral: number | null = null;

  constructor(type: number = constants.SOCKET) {
    super();
    this.type = type;
  }

  bind(address: string, port: number, _flags?: number): number {
    return this.bindTo(address || '0.0.0.0', port, 'IPv4');
  }

  bind6(address: string, port: number, _flags?: number): number {
    return this.bindTo(address || '::', port, 'IPv6');
  }

  private bindTo(address: string, port: number, family: string): number {
    if (!isThisHost(address)) return UV_EADDRINUSE;
    const wanted = Number(port) || 0;
    if (wanted !== 0 && boundPorts.has(wanted)) return UV_EADDRINUSE;
    if (wanted !== 0 && ephemeralPorts.has(wanted)) return UV_EADDRINUSE;
    const bound = wanted === 0 ? allocatePort() : wanted;
    if (this.local && boundPorts.get(this.local.port) === this) boundPorts.delete(this.local.port);
    this.local = { address, family, port: bound };
    boundPorts.set(bound, this);
    return 0;
  }

  listen(_backlog: number): number {
    if (!this.local) {
      const err = this.bindTo('0.0.0.0', 0, 'IPv4');
      if (err) return err;
    }
    this.listening = true;
    if (this.local) { try { onListenWatcher?.(this.local.port, this.local.address); } catch { /* a watcher that throws is not the listen's business */ } }
    return 0;
  }

  connect(req: TCPConnectWrap, address: string, port: number): number {
    return this.connectTo(req, address, port, 'IPv4');
  }

  connect6(req: TCPConnectWrap, address: string, port: number): number {
    return this.connectTo(req, address, port, 'IPv6');
  }

  private connectTo(req: TCPConnectWrap, address: string, port: number, family: string): number {
    const target = Number(port);
    const reachable = isThisHost(address);
    if (!this.local) {
      const mine = allocatePort();
      ephemeralPorts.add(mine);
      this.ephemeral = mine;
      this.local = { address: family === 'IPv6' ? '::1' : '127.0.0.1', family, port: mine };
    }
    this.remote = { address, family, port: target };
    // libuv answers a connect through the request, never from the call: a
    // refused connection is `oncomplete(UV_ECONNREFUSED)`, which is what
    // `afterConnect` turns into the socket's `ECONNREFUSED` error.
    queueMicrotask(() => {
      if (this.closed) return;
      const server = reachable ? listenerOnPort(target) : undefined;
      if (!server) {
        req.oncomplete?.(UV_ECONNREFUSED, this, req, true, true);
        return;
      }
      const accepted = new (server.constructor as typeof TCP)(constants.SOCKET);
      accepted.local = { ...(server.local as SockName), port: target };
      accepted.remote = { ...(this.local as SockName) };
      // An accepted connection is a handle of the loop that is serving, not of
      // the one that connected: the pairing is made inside the connector's own
      // turn, so without this the server's end of every connection would hold
      // the connecting run alive until the server closed it.
      __adoptHandle(accepted, ownerOf(server));
      LibuvStreamWrap.pair(this, accepted);
      server.onconnection?.(0, accepted);
      req.oncomplete?.(0, this, req, true, true);
    });
    return 0;
  }

  /**
   * Name both ends of a pairing the engine made without a connect. The page
   * bridge's end of an upgraded connection is one: there was no `connect`, and
   * the socket an `upgrade` listener is handed still has to answer
   * `remoteAddress` and `localPort` as a connection's socket does.
   */
  adoptNames(local: SockName, remote: SockName): void {
    this.local = { ...local };
    this.remote = { ...remote };
  }

  /** libuv's `dup()`: the same connection, under both its names. */
  override duplicate(): TCP {
    const copy = new (this.constructor as typeof TCP)(constants.SOCKET);
    if (this.local && this.remote) copy.adoptNames(this.local, this.remote);
    copy.takeOverFrom(this);
    return copy;
  }

  getsockname(out: Partial<SockName>): number {
    if (!this.local) return UV_EINVAL;
    out.address = this.local.address;
    out.family = this.local.family;
    out.port = this.local.port;
    return 0;
  }

  getpeername(out: Partial<SockName>): number {
    if (!this.remote) return UV_EINVAL;
    out.address = this.remote.address;
    out.family = this.remote.family;
    out.port = this.remote.port;
    return 0;
  }

  /** Nothing is buffered between two handles in one realm, so there is nothing to delay. */
  setNoDelay(_enable: boolean): number {
    return 0;
  }

  /** There is no idle connection to probe: a pairing is alive while both ends are. */
  setKeepAlive(_enable: boolean, _delay: number): number {
    return 0;
  }

  setSimultaneousAccepts(_enable: boolean): number {
    return 0;
  }

  /** An engine handle carries no descriptor a program can hand it. */
  open(_fd: number): number {
    return UV_ENOTSUP;
  }

  /** libuv's `uv_tcp_close_reset`: the peer reads ECONNRESET rather than EOF. */
  reset(callback?: () => void): number {
    this.sendReset();
    this.close(callback);
    return 0;
  }

  protected override onCloseHandle(): void {
    const wasListening = this.listening;
    this.listening = false;
    this.onconnection = null;
    if (wasListening && this.local) { try { onCloseWatcher?.(this.local.port); } catch { /* as above */ } }
    if (this.local && boundPorts.get(this.local.port) === this) boundPorts.delete(this.local.port);
    if (this.ephemeral !== null) { ephemeralPorts.delete(this.ephemeral); this.ephemeral = null; }
  }
}

export default { TCP, TCPConnectWrap, constants };
