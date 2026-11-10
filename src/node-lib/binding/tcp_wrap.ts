/**
 * `internalBinding('tcp_wrap')`: libuv's `uv_tcp_t`, over the calling process's kernel sockets (ADR-0009).
 *
 * A handle keeps the socket calls of the process that made it (`host-sockets.ts` callingSockets), as a socket keeps
 * the namespace and descriptor table of the process whose `socket(2)` made it. Everything a socket is (its port, its
 * loopback, where a connect goes, what pairs with what) is the kernel's; this file holds the libuv rules over the
 * calls, read in Node v24.21.0's `deps/uv/src/unix/tcp.c` and `src/tcp_wrap.cc` (its stream is `kernel_stream.ts`):
 *
 * - the socket is made at `bind`, `connect` or `listen`, of the address's family (`maybe_new_socket`), non-blocking
 *   and close-on-exec; `listen` on a handle with none makes an AF_INET one;
 * - `bind` sets `SO_REUSEADDR`, `SO_REUSEPORT` for `UV_TCP_REUSEPORT` and `IPV6_V6ONLY` on an IPv6 socket; its
 *   `EADDRINUSE` is held (`delayed_error`) and said by `listen` or by a connect's callback;
 * - a connect in progress waits for the socket to be writable and reads `SO_ERROR`; an immediate `ECONNREFUSED` is
 *   the callback's, any other error the call's;
 * - a listener accepts one connection per readiness;
 * - `close` cancels a pending connect with `ECANCELED`, then the stream's pending requests.
 *
 * A process whose tree offers no socket calls has no IPv4 or IPv6: making the socket is `EAFNOSUPPORT`.
 */
import { queueBindingTask } from '../../guest-loop';
import { KernelStreamWrap, registerKernelHandle } from './kernel_stream';
import { holdRequest, ownerOf, ownerOfInstance, invokeOwned, observeNodeRequest, forgetNodeRequest, startHandle } from './handles';
import { __runFor } from '../../process-tokens';
import { internalAsyncHooks, internalTimers } from '../internals/runtime';
import { rememberSocketConnect, traceSocketConnect } from '../../socket-connect-trace';
import { UV_EAFNOSUPPORT, UV_EALREADY, UV_EBADF, UV_EBUSY, UV_ECANCELED, UV_ECONNREFUSED, UV_EINVAL } from './uv';
import {
  intOption, linux, readIntOption, readSocketName, socketAddress, socketAddressBuffer, type SocketName, type TreeSockets,
} from '../../host-sockets';

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

/**
 * Who is told when a handle made through a process's calls starts or stops listening: a container's page bridge,
 * for the handles made through its tree's calls, so a preview finds the port. What this engine's own handles did,
 * said as they do it; what listens is the kernel's to know.
 */
type ListenWatcher = { onListen(port: number, address: string): void; onClose(port: number): void };
const listenWatchers = new WeakMap<TreeSockets, Set<ListenWatcher>>();
export function watchListens(sockets: TreeSockets, onListen: ListenWatcher['onListen'], onClose: ListenWatcher['onClose']): () => void {
  const watcher: ListenWatcher = { onListen, onClose };
  let set = listenWatchers.get(sockets);
  if (!set) listenWatchers.set(sockets, set = new Set());
  set.add(watcher);
  return () => { set!.delete(watcher); };
}
/**
 * The listening handles each port of a process's calls was told for: its watchers hear a port once, when the first
 * handle listens on it, and its close when the last one closes (a listener received over IPC listens on the port its
 * sender did).
 */
const announced = new WeakMap<TreeSockets, Map<number, number>>();
/** The handles listening on each port of a process's calls, for a bridge that asks what listens there. */
const listening = new WeakMap<TreeSockets, Map<number, Set<TCP>>>();
/** The handles of `sockets`'s process listening on `port`. */
export function listeningHandles(sockets: TreeSockets, port: number): TCP[] {
  return [...listening.get(sockets)?.get(port) ?? []];
}

interface PendingConnect { request: TCPConnectWrap; complete: (status: number) => void; release: () => void }

export class TCP extends KernelStreamWrap {
  /** `constants.SOCKET` or `constants.SERVER`. */
  readonly type: number;
  listening = false;
  /** Set by `net.js` on a server handle; how an accepted connection is announced. */
  onconnection: ((status: number, clientHandle: TCP) => void) | null = null;

  /** The socket's family, AF_INET or AF_INET6. */
  #family = 0;
  /** libuv's `delayed_error`: a bind's `EADDRINUSE` or a connect's immediate refusal, said later. */
  #delayedError = 0;
  #noDelay = false;
  #keepAlive = false;
  #connect: PendingConnect | null = null;
  /** The port this handle told its process's watchers it listens on. */
  #announcedPort: number | null = null;

  constructor(type: number = constants.SOCKET) {
    super(true);
    this.type = type;
  }

  /** The descriptor, made now of `family` where the handle has none (`maybe_new_socket`). */
  #socketFor(family: number): number {
    if (this.descriptor >= 0) return 0;
    const sockets = this.sockets;
    if (!sockets) return UV_EAFNOSUPPORT;
    const fd = sockets.socket(family, linux.SOCK_STREAM | linux.SOCK_NONBLOCK | linux.SOCK_CLOEXEC, 0);
    if (fd < 0) return fd;
    const status = this.#adopt(fd, family);
    if (status !== 0) { sockets.close(fd); this.setDescriptor(-1); }
    return status;
  }

  /** uv__stream_open: the descriptor is this handle's, and a TCP_NODELAY or keep-alive asked before it is set on it. */
  #adopt(fd: number, family: number, sockets?: TreeSockets): number {
    if (this.descriptor >= 0 && this.descriptor !== fd) return UV_EBUSY;
    this.setDescriptor(fd, sockets);
    this.#family = family;
    return this.#applyOptions();
  }

  #applyOptions(): number {
    if (this.#noDelay) { const status = this.#setInt(linux.IPPROTO_TCP, linux.TCP_NODELAY, 1); if (status !== 0) return status; }
    if (this.#keepAlive) { const status = this.#keepalive(true, 60, 1, 10); if (status !== 0) return status; }
    return 0;
  }

  #setInt(level: number, name: number, value: number): number {
    const status = this.sockets!.setsockopt(this.descriptor, level, name, intOption(value));
    return status < 0 ? status : 0;
  }

  /** uv__tcp_keepalive. */
  #keepalive(on: boolean, idle: number, interval: number, count: number): number {
    let status = this.#setInt(linux.SOL_SOCKET, linux.SO_KEEPALIVE, on ? 1 : 0);
    if (status !== 0 || !on) return status;
    if (idle < 1 || interval < 1 || count < 1) return UV_EINVAL;
    status = this.#setInt(linux.IPPROTO_TCP, linux.TCP_KEEPIDLE, idle);
    if (status === 0) status = this.#setInt(linux.IPPROTO_TCP, linux.TCP_KEEPINTVL, interval);
    if (status === 0) status = this.#setInt(linux.IPPROTO_TCP, linux.TCP_KEEPCNT, count);
    return status;
  }

  bind(address: string, port: number, flags?: number): number {
    return this.#bind(4, address, port, Number(flags) || 0);
  }

  bind6(address: string, port: number, flags?: number): number {
    return this.#bind(6, address, port, Number(flags) || 0);
  }

  /** TCPWrap::Bind's `uv_ip4_addr`/`uv_ip6_addr`, then uv__tcp_bind. */
  #bind(family: 4 | 6, address: string, port: number, flags: number): number {
    const name = socketAddress(family, address, port, this.sockets);
    if (!name) return UV_EINVAL;
    if ((flags & constants.UV_TCP_IPV6ONLY) && family !== 6) return UV_EINVAL;
    let status = this.#socketFor(family === 6 ? linux.AF_INET6 : linux.AF_INET);
    if (status !== 0) return status;
    status = this.#setInt(linux.SOL_SOCKET, linux.SO_REUSEADDR, 1);
    if (status !== 0) return status;
    if (flags & constants.UV_TCP_REUSEPORT) {
      status = this.#setInt(linux.SOL_SOCKET, linux.SO_REUSEPORT, 1);
      if (status !== 0) return status;
    }
    if (family === 6) {
      status = this.#setInt(linux.IPPROTO_IPV6, linux.IPV6_V6ONLY, flags & constants.UV_TCP_IPV6ONLY ? 1 : 0);
      if (status !== 0) return status === -linux.EOPNOTSUPP ? UV_EINVAL : status;
    }
    const bound = this.sockets!.bind(this.descriptor, name);
    if (bound < 0 && bound !== -linux.EADDRINUSE) return bound === -linux.EAFNOSUPPORT ? UV_EINVAL : bound;
    this.#delayedError = bound < 0 ? bound : 0;
    return 0;
  }

  listen(backlog: number): number {
    if (this.#delayedError) return this.#delayedError;
    const status = this.#socketFor(linux.AF_INET);
    if (status !== 0) return status;
    const listened = this.sockets!.listen(this.descriptor, Number(backlog) | 0);
    if (listened < 0) return listened;
    const port = this.#localPort();
    if (!this.listening) {
      this.listening = true;
      // uv_listen: a listening socket holds its loop.
      startHandle(this);
      this.#announce(port);
    }
    sayListenClock(this, port);
    this.waitIn();
    return 0;
  }

  /** The bound port, or null where the socket has none. */
  #localPort(): number | null {
    const out: Partial<SockName> = {};
    return this.getsockname(out) === 0 && typeof out.port === 'number' ? out.port : null;
  }

  /** Its process's watchers hear the port it listens on, where no other of its handles listens there. */
  #announce(port: number | null): void {
    const sockets = this.sockets;
    if (!sockets || port === null) return;
    this.#announcedPort = port;
    let handles = listening.get(sockets);
    if (!handles) listening.set(sockets, handles = new Map());
    let onPort = handles.get(port);
    if (!onPort) handles.set(port, onPort = new Set());
    onPort.add(this);
    let ports = announced.get(sockets);
    if (!ports) announced.set(sockets, ports = new Map());
    const listeners = ports.get(port) ?? 0;
    ports.set(port, listeners + 1);
    if (listeners > 0) return;
    const out: Partial<SockName> = {};
    const address = this.getsockname(out) === 0 ? out.address ?? '' : '';
    for (const watcher of [...listenWatchers.get(sockets) ?? []]) {
      try { watcher.onListen(port, address); } catch { /* a watcher that throws is not the listen's business */ }
    }
  }

  connect(req: TCPConnectWrap, address: string, port: number): number {
    return this.#connectTo(req, address, port, 4);
  }

  connect6(req: TCPConnectWrap, address: string, port: number): number {
    return this.#connectTo(req, address, port, 6);
  }

  /** TCPWrap::Connect's `uv_ip4_addr`/`uv_ip6_addr`, then uv__tcp_connect. */
  #connectTo(req: TCPConnectWrap, address: string, port: number, family: 4 | 6): number {
    const socket = (this as unknown as Record<symbol, unknown>)[internalAsyncHooks.symbols.owner_symbol];
    const owner = ownerOfInstance(req);
    if (socket && typeof socket === 'object') rememberSocketConnect(socket, {
      pid: owner === null ? null : __runFor(owner)?.process.pid ?? null, id: null,
      socketId: (socket as Record<symbol, number>)[internalAsyncHooks.symbols.async_id_symbol] ?? null, request: null,
    });
    const complete = (status: number): unknown => {
      const timer = (): unknown => (socket as Record<symbol, unknown> | undefined)?.[internalTimers.kTimeout];
      traceSocketConnect('binding-entered', socket, timer(), status);
      try { return invokeOwned(req, 'oncomplete', status, this, req, true, true); }
      finally { traceSocketConnect('binding-returned', socket, timer(), status); }
    };
    const name = socketAddress(family, address, Number(port), this.sockets);
    if (!name) return UV_EINVAL;
    if (this.#connect) return UV_EALREADY;
    if (this.#delayedError === 0) {
      const status = this.#socketFor(family === 6 ? linux.AF_INET6 : linux.AF_INET);
      if (status !== 0) return status;
      this.setOpen(true, true);
      if (family === 6) this.#defaultLinkLocalScope(name);
      let connected: number;
      do connected = this.sockets!.connect(this.descriptor, name); while (connected === -linux.EINTR);
      if (connected < 0 && connected !== -linux.EINPROGRESS) {
        // Linux reports a refusal later; an immediate one (or an EINVAL, which a BSD gives for it) is the callback's.
        if (connected === -linux.ECONNREFUSED || connected === -linux.EINVAL) this.#delayedError = UV_ECONNREFUSED;
        else return connected;
      }
    }
    observeNodeRequest(req, this);
    this.#connect = { request: req, complete, release: holdRequest(this) };
    if (this.#delayedError) queueBindingTask(() => this.#connected());
    else this.waitOut();
    return 0;
  }

  /** A link-local IPv6 destination named with no interface goes out of the first one that has a link-local address. */
  #defaultLinkLocalScope(name: Uint8Array): void {
    if (name[8] !== 0xfe || name[9] !== 0x80) return;
    const view = new DataView(name.buffer, name.byteOffset, name.byteLength);
    if (view.getUint32(24, true) !== 0) return;
    let entries: ReturnType<TreeSockets['getifaddrs']> = [];
    try { entries = this.sockets?.getifaddrs() ?? []; } catch { return; }
    for (const entry of entries) {
      const own = readSocketName(entry.address);
      if (own?.family === 'IPv6' && entry.address[8] === 0xfe && entry.address[9] === 0x80) { view.setUint32(24, own.scopeid ?? 0, true); return; }
    }
  }

  /** uv__stream_connect: the connect's outcome, its held error or the socket's own (`SO_ERROR`). */
  #connected(): void {
    const pending = this.#connect;
    if (!pending) return;
    let error: number;
    if (this.#delayedError) { error = this.#delayedError; this.#delayedError = 0; }
    else {
      const value = new Uint8Array(4);
      const status = this.sockets!.getsockopt(this.descriptor, linux.SOL_SOCKET, linux.SO_ERROR, value);
      error = status < 0 ? status : -readIntOption(value);
    }
    if (error === -linux.EINPROGRESS) { this.waitOut(); return; }
    this.#connect = null;
    try { pending.complete(error); }
    finally { forgetNodeRequest(pending.request); pending.release(); }
    if (this.descriptor < 0) return;
    if (error < 0) { this.cancelWrites(UV_ECANCELED); return; }
    this.resumeWrites();
  }

  /** A connect in progress holds the writes queued behind it. */
  protected override writesHeld(): boolean { return this.#connect !== null; }

  /** A listener's readiness is a connection to accept; a connection's, bytes to read. */
  protected override onReadable(): void {
    if (this.listening) this.#accept();
    else super.onReadable();
  }

  /** A connect in progress is answered by the socket's writability; else the queue is sent. */
  protected override onWritable(): void {
    if (this.#connect) this.#connected();
    else super.onWritable();
  }

  /**
   * A connection accepted (uv__server_io), with the options asked of the listener's family. A listener nobody serves
   * yet (a received one whose receiver has not set its `onconnection`) leaves it in the kernel's backlog until it
   * listens again.
   */
  #accept(): void {
    if (!this.listening || this.closed || this.onconnection === null) return;
    this.serveConnection((fd, sockets) => {
      const accepted = new (this.constructor as typeof TCP)(constants.SOCKET);
      if (accepted.#adopt(fd, this.#family, sockets) === 0) return accepted;
      sockets.close(fd);
      accepted.setDescriptor(-1);
      accepted.close();
      return undefined;
    });
  }

  /** uv_close: a pending connect is cancelled, then the stream's requests; the descriptor goes. */
  override close(callback?: () => void): void {
    if (!this.closed) {
      const connect = this.#connect;
      this.#connect = null;
      if (connect) queueBindingTask(() => { try { connect.complete(UV_ECANCELED); } finally { forgetNodeRequest(connect.request); connect.release(); } });
    }
    super.close(callback);
  }

  getsockname(out: Partial<SockName>): number {
    return this.#name('getsockname', out);
  }

  getpeername(out: Partial<SockName>): number {
    return this.#name('getpeername', out);
  }

  /** uv_tcp_getsockname / uv_tcp_getpeername: a held error first, then the kernel's name, as AddressToJS reads it. */
  #name(call: 'getsockname' | 'getpeername', out: Partial<SockName>): number {
    if (this.#delayedError) return this.#delayedError;
    const sockets = this.sockets;
    if (this.descriptor < 0 || !sockets) return UV_EBADF;
    const buffer = socketAddressBuffer();
    const status = sockets[call](this.descriptor, buffer);
    if (status < 0) return status;
    const name: SocketName | undefined = readSocketName(buffer, sockets);
    if (!name) return UV_EINVAL;
    out.address = name.address;
    out.family = name.family;
    out.port = name.port;
    return 0;
  }

  /** uv_tcp_nodelay: set now where the socket exists, and remembered for when it is made. */
  setNoDelay(enable: boolean): number {
    const on = Boolean(enable);
    if (this.descriptor >= 0) { const status = this.#setInt(linux.IPPROTO_TCP, linux.TCP_NODELAY, on ? 1 : 0); if (status !== 0) return status; }
    this.#noDelay = on;
    return 0;
  }

  /** uv_tcp_keepalive_ex (TCPWrap::SetKeepAlive: an interval of 1 s and 10 probes where none is given). */
  setKeepAlive(enable: boolean, delay: number, interval?: number, count?: number): number {
    const on = Boolean(enable);
    if (this.descriptor >= 0) {
      const status = this.#keepalive(on, Number(delay) >>> 0, typeof interval === 'number' ? interval >>> 0 : 1, typeof count === 'number' ? count >>> 0 : 10);
      if (status !== 0) return status;
    }
    this.#keepAlive = on;
    return 0;
  }

  /** TCPWrap::SetTypeOfService: IP_TOS for an IPv4 socket, IPV6_TCLASS for an IPv6 one. */
  setTypeOfService(tos: number): number {
    const option = this.#typeOfServiceOption();
    if (typeof option === 'number') return option;
    return this.#setInt(option.level, option.name, Number(tos) | 0);
  }

  getTypeOfService(): number {
    const option = this.#typeOfServiceOption();
    if (typeof option === 'number') return option;
    const value = new Uint8Array(4);
    const status = this.sockets!.getsockopt(this.descriptor, option.level, option.name, value);
    return status < 0 ? status : readIntOption(value);
  }

  #typeOfServiceOption(): { level: number; name: number } | number {
    if (this.descriptor < 0) return UV_EBADF;
    const out: Partial<SockName> = {};
    const status = this.getsockname(out);
    if (status !== 0) return status;
    return out.family === 'IPv6' ? { level: linux.IPPROTO_IPV6, name: linux.IPV6_TCLASS } : { level: linux.IPPROTO_IP, name: linux.IP_TOS };
  }

  setSimultaneousAccepts(_enable: boolean): number {
    return 0;
  }

  /** uv_tcp_open: a descriptor of this process's, made non-blocking, with the options asked before it. */
  open(fd: number): number {
    let status = this.openDescriptor(fd);
    if (status !== 0) return status;
    const buffer = socketAddressBuffer();
    this.#family = this.sockets!.getsockname(fd, buffer) < 0 ? linux.AF_INET : buffer[0]! | (buffer[1]! << 8);
    status = this.#applyOptions();
    return status;
  }

  /** uv_tcp_close_reset: `SO_LINGER` {1, 0}, then close: the peer reads ECONNRESET rather than EOF. */
  reset(callback?: () => void): number {
    if (this.closed) return UV_EBADF;
    if (this.shutdownPending) return UV_EINVAL;
    const sockets = this.sockets;
    if (this.descriptor >= 0 && sockets) {
      const linger = new Uint8Array(8);
      new DataView(linger.buffer).setInt32(0, 1, true);
      const status = sockets.setsockopt(this.descriptor, linux.SOL_SOCKET, linux.SO_LINGER, linger);
      if (status < 0 && status !== -linux.EINVAL) return status;
    }
    this.close(callback);
    return 0;
  }

  protected override onCloseHandle(): void {
    this.listening = false;
    this.onconnection = null;
    const port = this.#announcedPort, sockets = this.sockets;
    this.#announcedPort = null;
    if (sockets && port !== null) {
      const onPort = listening.get(sockets)?.get(port);
      onPort?.delete(this);
      if (onPort?.size === 0) listening.get(sockets)!.delete(port);
    }
    const ports = sockets && announced.get(sockets);
    if (port === null || !ports) return;
    const listeners = (ports.get(port) ?? 1) - 1;
    if (listeners > 0) { ports.set(port, listeners); return; }
    ports.delete(port);
    for (const watcher of [...listenWatchers.get(sockets) ?? []]) {
      try { watcher.onClose(port); } catch { /* a watcher that throws is not the close's business */ }
    }
  }
}

registerKernelHandle('TCP', () => new TCP(constants.SOCKET));

export default { TCP, TCPConnectWrap, constants };
