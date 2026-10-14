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
import { queueBindingTask } from '../../guest-loop';
import { LibuvStreamWrap } from './stream_wrap';
import { __adoptHandle, ownerOf, ownerOfInstance, invokeOwned, observeNodeRequest, forgetNodeRequest } from './handles';
import { __runFor } from '../../process-tokens';
import { internalAsyncHooks, internalTimers } from '../internals/runtime';
import { rememberSocketConnect, traceSocketConnect } from '../../socket-connect-trace';
import { nativeStreamFor, registerNativeStreamConstructor } from '../../native-stream-binding';
import { UV_EADDRINUSE, UV_ECONNREFUSED, UV_EINVAL, UV_ENOTSUP, UV_EBADF } from './uv';

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
 * Every port this engine holds, by address family: a handle that has bound
 * one, listening or not, and every ephemeral port a client end was given. An
 * IPv4 bind takes the IPv4 space, an `ipv6Only` bind the IPv6 space, and a
 * dual-stack IPv6 bind both, so an IPv6-only socket can share a port number
 * with an IPv4 one, as on a host.
 */
const v4Ports = new Map<number, TCP>();
const v6Ports = new Map<number, TCP>();
const ephemeralPorts = new Set<number>();
const portTaken = (port: number): boolean => v4Ports.has(port) || v6Ports.has(port) || ephemeralPorts.has(port);
/** The family spaces a bind occupies. */
function spacesOf(family: string, flags: number): Array<Map<number, TCP>> {
  if (family !== 'IPv6') return [v4Ports];
  return (flags & constants.UV_TCP_IPV6ONLY) ? [v6Ports] : [v4Ports, v6Ports];
}

/** Linux's ephemeral range, walked in order as a kernel walks it. */
let nextEphemeral = 49152;
function allocatePort(): number {
  for (let tries = 0; tries < 16384; tries += 1) {
    const port = nextEphemeral;
    nextEphemeral = nextEphemeral >= 65535 ? 49152 : nextEphemeral + 1;
    if (!portTaken(port)) return port;
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
/**
 * An instrument's seam: told, once a handle, that a server began listening, with the process that owns the handle
 * and the port. The engine's load clock says the process's split there (runtime.ts): a server still loading its
 * modules when the page's first request arrives says nothing else before a dry run's capture ends (S2 R17).
 */
let listenClockObserver: ((owner: ReturnType<typeof ownerOf>, port: number | null) => void) | undefined;
export function observeListenClocks(observer: NonNullable<typeof listenClockObserver>): void { listenClockObserver = observer; }
function sayListenClock(handle: TCP, port: number | null): void {
  try { listenClockObserver?.(ownerOf(handle), port); }
  catch { /* Evidence failure must not change a listen. */ }
}
// eslint-disable-next-line no-var, vars-on-top
var onCloseWatcher: ((port: number) => void) | null = null;
export function setPortWatchers(onListen: ListenWatcher | null, onClose: ((port: number) => void) | null): void {
  onListenWatcher = onListen;
  onCloseWatcher = onClose;
}

/** The listening handle a connect to this port reaches, if any. */
export function listenerOnPort(port: number, family?: string): TCP | undefined {
  const order = family === 'IPv6' ? [v6Ports, v4Ports] : [v4Ports, v6Ports];
  for (const space of order) {
    const member = space.get(port)?.acceptingMember();
    if (member) return member;
  }
  return undefined;
}
/** Each shared listening socket's turn: its next connection goes to the member after the last one served. */
const acceptTurns = new WeakMap<object, number>();
/** Each shared listening socket's accept queue (TCP.queueAccepted). */
const acceptQueues = new WeakMap<object, Array<{ accepted: TCP; adoptedBy: TCP | undefined }>>();

export class TCP extends LibuvStreamWrap {
  /** `constants.SOCKET` or `constants.SERVER`. */
  readonly type: number;
  listening = false;
  /** Set by `net.js` on a server handle; how an accepted pairing is announced. */
  onconnection: ((status: number, clientHandle: TCP) => void) | null = null;

  private local: SockName | null = null;
  private remote: SockName | null = null;

  constructor(type: number = constants.SOCKET) {
    super();
    this.type = type;
    this.attachNative('tcp', type);
  }

  bind(address: string, port: number, _flags?: number): number {
    const native = nativeStreamFor(this);
    if (native) return native.call({ operation: 'bind', id: native.descriptor.id, address, port, flags: _flags }).status;
    return this.bindTo(address || '0.0.0.0', port, 'IPv4', Number(_flags) || 0);
  }

  bind6(address: string, port: number, _flags?: number): number {
    const native = nativeStreamFor(this);
    if (native) return native.call({ operation: 'bind', id: native.descriptor.id, address, port, flags: _flags, ipv6: true }).status;
    return this.bindTo(address || '::', port, 'IPv6', Number(_flags) || 0);
  }

  private bindTo(address: string, port: number, family: string, flags = 0): number {
    if (!isThisHost(address)) return UV_EADDRINUSE;
    const wanted = Number(port) || 0;
    const spaces = spacesOf(family, flags);
    if (wanted !== 0 && spaces.some(space => space.has(wanted))) return UV_EADDRINUSE;
    if (wanted !== 0 && ephemeralPorts.has(wanted)) return UV_EADDRINUSE;
    const bound = wanted === 0 ? allocatePort() : wanted;
    if (this.local) for (const space of [v4Ports, v6Ports]) if (space.get(this.local.port) === this) space.delete(this.local.port);
    this.local = { address, family, port: bound };
    for (const space of spaces) space.set(bound, this);
    this.onLastReferenceClose(() => { for (const space of spaces) if (space.get(bound) === this) space.delete(bound); });
    return 0;
  }

  listen(_backlog: number): number {
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'listen', id: native.descriptor.id, backlog: _backlog }).status;
      if (status === 0) { this.listening = true; sayListenClock(this, this.local?.port ?? null); }
      return status;
    }
    // listen(2) on a listening socket (a passed server's receiver listens on it again) only sets its backlog; what
    // was queued while nobody served it is accepted now.
    if (this.listening) { sayListenClock(this, this.local?.port ?? null); this.drainAccepted(); return 0; }
    if (!this.local) {
      const err = this.bindTo('0.0.0.0', 0, 'IPv4');
      if (err) return err;
    }
    this.listening = true;
    if (this.local) { try { onListenWatcher?.(this.local.port, this.local.address); } catch { /* a watcher that throws is not the listen's business */ } }
    sayListenClock(this, this.local?.port ?? null);
    return 0;
  }

  connect(req: TCPConnectWrap, address: string, port: number): number {
    return this.connectTo(req, address, port, 'IPv4');
  }

  connect6(req: TCPConnectWrap, address: string, port: number): number {
    return this.connectTo(req, address, port, 'IPv6');
  }

  private connectTo(req: TCPConnectWrap, address: string, port: number, family: string): number {
    const native = nativeStreamFor(this);
    const socket = (this as unknown as Record<symbol, unknown>)[internalAsyncHooks.symbols.owner_symbol];
    const owner = ownerOfInstance(req);
    if (socket && typeof socket === 'object') rememberSocketConnect(socket, {
      pid: owner === null ? null : __runFor(owner)?.process.pid ?? null, id: native?.descriptor.id ?? null,
      socketId: (socket as Record<symbol, number>)[internalAsyncHooks.symbols.async_id_symbol] ?? null, request: null,
    });
    const complete = (status: number, request?: number): unknown => {
      const timer = (): unknown => (socket as Record<symbol, unknown> | undefined)?.[internalTimers.kTimeout];
      traceSocketConnect('binding-entered', socket, timer(), status, request);
      try { return invokeOwned(req, 'oncomplete', status, this, req, true, true); }
      finally { traceSocketConnect('binding-returned', socket, timer(), status, request); }
    };
    observeNodeRequest(req, this);
    if (native) {
      try {
        const status = native.connect(address, port, family === 'IPv6', complete);
        if (status !== 0) forgetNodeRequest(req);
        return status;
      } catch (cause) { forgetNodeRequest(req); throw cause; }
    }
    const target = Number(port);
    const reachable = isThisHost(address);
    if (!this.local) {
      const mine = allocatePort();
      ephemeralPorts.add(mine);
      this.onLastReferenceClose(() => { ephemeralPorts.delete(mine); });
      this.local = { address: family === 'IPv6' ? '::1' : '127.0.0.1', family, port: mine };
    }
    this.remote = { address, family, port: target };
    // libuv answers a connect through the request, never from the call: a
    // refused connection is `oncomplete(UV_ECONNREFUSED)`, which is what
    // `afterConnect` turns into the socket's `ECONNREFUSED` error.
    queueBindingTask(() => {
      try {
        if (this.closed) { forgetNodeRequest(req); return; }
        const server = reachable ? listenerOnPort(target, family) : undefined;
        if (!server) {
          complete(UV_ECONNREFUSED);
          return;
        }
        const accepted = new (server.constructor as typeof TCP)(constants.SOCKET);
        accepted.local = { ...(server.local as SockName), port: target };
        accepted.remote = { ...(this.local as SockName) };
        // An accepted connection is a handle of the loop that is serving, not of the one that connected: the pairing
        // is made inside the connector's own turn, so without this the server's end would be the connecting run's
        // (its exit would close it, and it would hold that run alive). One that waits in the socket's accept queue is
        // the socket's, no run's (the kernel's, as on Linux): whichever member accepts it makes it its run's.
        __adoptHandle(accepted, server.onconnection === null ? null : ownerOf(server), server);
        LibuvStreamWrap.pair(this, accepted);
        // A passed socket whose receiver has not yet served it (its net.Server sets onconnection, then listens):
        // the connection waits in the socket's accept queue, as a connect completes on Linux before any accept.
        if (server.onconnection === null) server.queueAccepted(accepted);
        else server.deliverAccepted(accepted, server);
        complete(0);
      } finally { forgetNodeRequest(req); }
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

  /**
   * A listening socket passed over IPC is one socket under two descriptors, as `SCM_RIGHTS` gives it: either may
   * accept, and it listens until both are closed (net.js's receiver calls `listen` again on it; a cluster primary
   * closes its own when its workers are gone). A native listener is refused by its owner (native-stream-owner.ts).
   */
  override get listenerDuplicates(): boolean { return nativeStreamFor(this) === undefined; }

  /** The member of this handle's socket a connection is accepted on: a listening one, those net.js serves first, in turn. */
  acceptingMember(): TCP | undefined {
    const members = [this, ...this.sharingHandles].filter((handle, index, all): handle is TCP =>
      handle instanceof TCP && handle.listening && !handle.closed && all.indexOf(handle) === index);
    const serving = members.filter(handle => handle.onconnection !== null);
    const pool = serving.length ? serving : members;
    if (pool.length < 2) return pool[0];
    const turn = acceptTurns.get(this.connectionEnd) ?? 0;
    acceptTurns.set(this.connectionEnd, turn + 1);
    return pool[turn % pool.length];
  }

  /** A connection accepted on this member: its onconnection, in the serving run. */
  /** Accepted on this member: it becomes this member's run's (`adoptedBy` this member: it already is). */
  deliverAccepted(accepted: TCP, adoptedBy?: TCP): void {
    if (adoptedBy !== this) __adoptHandle(accepted, ownerOf(this), this);
    invokeOwned(this, 'onconnection', 0, accepted);
  }

  /** The socket's accept queue: connections made while none of its members was served. */
  queueAccepted(accepted: TCP): void {
    const queue = acceptQueues.get(this.connectionEnd) ?? [];
    queue.push({ accepted, adoptedBy: undefined });
    acceptQueues.set(this.connectionEnd, queue);
  }

  /** A member is served now (net.js set its onconnection, then listened): the queue drains to the serving members. */
  private drainAccepted(): void {
    const queue = acceptQueues.get(this.connectionEnd);
    if (!queue?.length) return;
    queueBindingTask(() => {
      while (queue.length) {
        const member = this.acceptingMember();
        if (!member || member.onconnection === null) return;
        const { accepted, adoptedBy } = queue.shift()!;
        if (!accepted.closed) member.deliverAccepted(accepted, adoptedBy);
      }
    });
  }

  /**
   * libuv's `dup()`: the same socket under both its names, listening where it listens. A socket bound and not yet
   * listening (cluster's shared handle, which the worker listens on) keeps its bound name, where the copy had none and
   * its `listen` bound a fresh port.
   */
  override duplicate(): TCP {
    const native = nativeStreamFor(this);
    if (native) {
      const copy = native.duplicate() as TCP;
      if (this.local && this.remote) copy.adoptNames(this.local, this.remote);
      return copy;
    }
    const copy = new (this.constructor as typeof TCP)(this.type);
    copy.local = this.local ? { ...this.local } : null;
    copy.remote = this.remote ? { ...this.remote } : null;
    copy.shareConnectionFrom(this);
    copy.listening = this.listening;
    return copy;
  }

  getsockname(out: Partial<SockName>): number {
    const native = nativeStreamFor(this);
    if (native) {
      const result = native.call({ operation: 'getsockname', id: native.descriptor.id });
      if (result.address) Object.assign(out, result.address);
      return result.status;
    }
    if (!this.local) return UV_EINVAL;
    out.address = this.local.address;
    out.family = this.local.family;
    out.port = this.local.port;
    return 0;
  }

  getpeername(out: Partial<SockName>): number {
    const native = nativeStreamFor(this);
    if (native) {
      const result = native.call({ operation: 'getpeername', id: native.descriptor.id });
      if (result.address) Object.assign(out, result.address);
      return result.status;
    }
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
  setKeepAlive(_enable: boolean, _delay: number, _interval?: number, _count?: number): number {
    return 0;
  }

  /** In-realm streams carry bytes, not IP packet headers. */
  setTypeOfService(_tos: number): number { return UV_ENOTSUP; }
  getTypeOfService(): number { return UV_ENOTSUP; }

  setSimultaneousAccepts(_enable: boolean): number {
    return 0;
  }

  /** An engine handle carries no descriptor a program can hand it. */
  open(_fd: number): number {
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'open', id: native.descriptor.id, fd: _fd }).status;
      if (status === 0) this.fd = _fd;
      return status;
    }
    return UV_ENOTSUP;
  }

  /** libuv's `uv_tcp_close_reset`: the peer reads ECONNRESET rather than EOF. */
  reset(callback?: () => void): number {
    if (this.closed) return UV_EBADF;
    const native = nativeStreamFor(this);
    if (native) return native.close(callback, true);
    this.sendReset();
    this.close(callback);
    return 0;
  }

  protected override onCloseHandle(): void {
    const wasListening = this.listening;
    this.listening = false;
    this.onconnection = null;
    // A listening socket another descriptor still holds (a passed server) goes on listening.
    const shared = [...this.sharingHandles].some(handle => handle !== this && handle instanceof TCP && handle.listening);
    if (wasListening && !shared && this.local) { try { onCloseWatcher?.(this.local.port); } catch { /* as above */ } }
    // The socket's last listener closed: what waited in its accept queue is reset (inet_csk_listen_stop: its peers
    // read ECONNRESET), as Linux disconnects an unaccepted child.
    if (wasListening && !shared) { for (const { accepted } of acceptQueues.get(this.connectionEnd)?.splice(0) ?? []) if (!accepted.closed) accepted.reset(); }
  }
}

registerNativeStreamConstructor('tcp', TCP);
export default { TCP, TCPConnectWrap, constants };
