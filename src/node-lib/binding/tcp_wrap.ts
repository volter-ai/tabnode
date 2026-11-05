/**
 * `internalBinding('tcp_wrap')`: libuv's `uv_tcp_t`, over the calling process's kernel sockets (ADR-0009).
 *
 * A handle keeps the socket calls of the process that made it (`host-sockets.ts` callingSockets), as a socket keeps
 * the namespace and descriptor table of the process whose `socket(2)` made it. Everything a socket is (its port, its
 * loopback, where a connect goes, what pairs with what) is the kernel's; this file holds the libuv rules over the
 * calls, read in Node v24.21.0's `deps/uv/src/unix/tcp.c` and `stream.c` and `src/tcp_wrap.cc`:
 *
 * - the socket is made at `bind`, `connect` or `listen`, of the address's family (`maybe_new_socket`), non-blocking
 *   and close-on-exec; `listen` on a handle with none makes an AF_INET one;
 * - `bind` sets `SO_REUSEADDR`, `SO_REUSEPORT` for `UV_TCP_REUSEPORT` and `IPV6_V6ONLY` on an IPv6 socket; its
 *   `EADDRINUSE` is held (`delayed_error`) and said by `listen` or by a connect's callback;
 * - a connect in progress waits for the socket to be writable and reads `SO_ERROR`; an immediate `ECONNREFUSED` is
 *   the callback's, any other error the call's;
 * - a listener accepts one connection per readiness; a read is up to 64 KiB, at most 32 per readiness; a write is
 *   tried at once and completes synchronously when it is taken whole, else is queued for the socket's writability;
 *   `shutdown` follows the queued writes; `close` cancels what is pending with `ECANCELED` before its callback.
 *
 * A process whose tree offers no socket calls has no IPv4 or IPv6: making the socket is `EAFNOSUPPORT`.
 */
import { queueBindingTask } from '../../guest-loop';
import { LibuvStreamWrap, type WriteWrap, type ShutdownWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset, kBytesWritten, kLastWriteWasAsync } from './stream_wrap';
import { __adoptHandle, ownerOf, ownerOfInstance, invokeOwned, observeNodeRequest, forgetNodeRequest, registerHandle, releaseHandle, stopHandle } from './handles';
import { __runFor } from '../../process-tokens';
import { internalAsyncHooks, internalTimers } from '../internals/runtime';
import { rememberSocketConnect, traceSocketConnect } from '../../socket-connect-trace';
import { UV_EAFNOSUPPORT, UV_EALREADY, UV_EBADF, UV_EBUSY, UV_ECANCELED, UV_ECONNREFUSED, UV_EINVAL, UV_ENOTCONN, UV_EOF, UV_EPIPE, errname } from './uv';
import {
  callingSockets, intOption, linux, readIntOption, readSocketName, socketAddress, socketAddressBuffer,
  type SocketName, type TreeSockets,
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

/** uv__read's buffer (`alloc_cb`'s suggested size) and its reads per readiness. */
const READ_BYTES = 64 * 1024;
const READS_PER_READINESS = 32;
/** uv__write's writes per readiness. */
const WRITES_PER_READINESS = 32;

/** uv requests keep their loop alive even when their stream is unreferenced. */
function holdRequest(handle: TCP): () => void {
  const request = { close: (): void => releaseHandle(request) };
  registerHandle(request);
  __adoptHandle(request, ownerOf(handle));
  return request.close;
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
/** What a listening socket told its watchers, by the socket (the connection end its duplicates share). */
const announcements = new WeakMap<object, { sockets: TreeSockets; port: number }>();

interface QueuedWrite { request: WriteWrap; bytes: Uint8Array; sent: number; release: () => void }
interface PendingConnect { request: TCPConnectWrap; complete: (status: number) => void; release: () => void }

export class TCP extends LibuvStreamWrap {
  /** `constants.SOCKET` or `constants.SERVER`. */
  readonly type: number;
  listening = false;
  /** Set by `net.js` on a server handle; how an accepted connection is announced. */
  onconnection: ((status: number, clientHandle: TCP) => void) | null = null;

  /** The socket calls of the process that made the handle, which it keeps. */
  #sockets: TreeSockets | undefined = callingSockets();
  /** The socket's descriptor (libuv's `io_watcher.fd`), -1 until it is made. */
  #fd = -1;
  /** The socket's family, AF_INET or AF_INET6. */
  #family = 0;
  /** libuv's `delayed_error`: a bind's `EADDRINUSE` or a connect's immediate refusal, said later. */
  #delayedError = 0;
  #readable = false;
  #writable = false;
  /** UV_HANDLE_READING. */
  #reading = false;
  /** UV_HANDLE_SHUT: the write side was shut down. */
  #shut = false;
  #noDelay = false;
  #keepAlive = false;
  #connect: PendingConnect | null = null;
  #writes: QueuedWrite[] = [];
  #shutdown: { request: ShutdownWrap; release: () => void } | null = null;
  /** The readiness questions this handle has asked and not yet had answered. */
  #waitingIn = false;
  #waitingOut = false;
  /** uv__read's buffer, reused: what a read delivers is copied out at its length. */
  #scratch: Uint8Array | null = null;

  constructor(type: number = constants.SOCKET) {
    super();
    this.type = type;
  }

  /** The descriptor, made now of `family` where the handle has none (`maybe_new_socket`). */
  #socketFor(family: number): number {
    if (this.#fd >= 0) return 0;
    const sockets = this.#sockets;
    if (!sockets) return UV_EAFNOSUPPORT;
    const fd = sockets.socket(family, linux.SOCK_STREAM | linux.SOCK_NONBLOCK | linux.SOCK_CLOEXEC, 0);
    if (fd < 0) return fd;
    const status = this.#adopt(fd, family);
    if (status !== 0) { sockets.close(fd); this.#fd = -1; this.fd = -1; }
    return status;
  }

  /** uv__stream_open: the descriptor is this handle's, and a TCP_NODELAY or keep-alive asked before it is set on it. */
  #adopt(fd: number, family: number): number {
    if (this.#fd >= 0 && this.#fd !== fd) return UV_EBUSY;
    this.#fd = fd;
    this.fd = fd;
    this.#family = family;
    if (this.#noDelay) { const status = this.#setInt(linux.IPPROTO_TCP, linux.TCP_NODELAY, 1); if (status !== 0) return status; }
    if (this.#keepAlive) { const status = this.#keepalive(true, 60, 1, 10); if (status !== 0) return status; }
    return 0;
  }

  #setInt(level: number, name: number, value: number): number {
    const status = this.#sockets!.setsockopt(this.#fd, level, name, intOption(value));
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
    const name = socketAddress(family, address, port, this.#sockets);
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
    const bound = this.#sockets!.bind(this.#fd, name);
    if (bound < 0 && bound !== -linux.EADDRINUSE) return bound === -linux.EAFNOSUPPORT ? UV_EINVAL : bound;
    this.#delayedError = bound < 0 ? bound : 0;
    return 0;
  }

  listen(backlog: number): number {
    if (this.#delayedError) return this.#delayedError;
    const status = this.#socketFor(linux.AF_INET);
    if (status !== 0) return status;
    const listened = this.#sockets!.listen(this.#fd, Number(backlog) | 0);
    if (listened < 0) return listened;
    const port = this.#localPort();
    if (!this.listening) {
      this.listening = true;
      this.#announce(port);
    }
    sayListenClock(this, port);
    this.#waitIn();
    return 0;
  }

  /** The bound port, or null where the socket has none. */
  #localPort(): number | null {
    const out: Partial<SockName> = {};
    return this.getsockname(out) === 0 && typeof out.port === 'number' ? out.port : null;
  }

  /** Its process's watchers hear the port it listens on. */
  #announce(port: number | null): void {
    const sockets = this.#sockets;
    if (!sockets || port === null) return;
    announcements.set(this.connectionEnd, { sockets, port });
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
    const name = socketAddress(family, address, Number(port), this.#sockets);
    if (!name) return UV_EINVAL;
    if (this.#connect) return UV_EALREADY;
    if (this.#delayedError === 0) {
      const status = this.#socketFor(family === 6 ? linux.AF_INET6 : linux.AF_INET);
      if (status !== 0) return status;
      this.#readable = true;
      this.#writable = true;
      if (family === 6) this.#defaultLinkLocalScope(name);
      let connected: number;
      do connected = this.#sockets!.connect(this.#fd, name); while (connected === -linux.EINTR);
      if (connected < 0 && connected !== -linux.EINPROGRESS) {
        // Linux reports a refusal later; an immediate one (or an EINVAL, which a BSD gives for it) is the callback's.
        if (connected === -linux.ECONNREFUSED || connected === -linux.EINVAL) this.#delayedError = UV_ECONNREFUSED;
        else return connected;
      }
    }
    observeNodeRequest(req, this);
    this.#connect = { request: req, complete, release: holdRequest(this) };
    if (this.#delayedError) queueBindingTask(() => this.#connected());
    else this.#waitOut();
    return 0;
  }

  /** A link-local IPv6 destination named with no interface goes out of the first one that has a link-local address. */
  #defaultLinkLocalScope(name: Uint8Array): void {
    if (name[8] !== 0xfe || name[9] !== 0x80) return;
    const view = new DataView(name.buffer, name.byteOffset, name.byteLength);
    if (view.getUint32(24, true) !== 0) return;
    let entries: ReturnType<TreeSockets['getifaddrs']> = [];
    try { entries = this.#sockets?.getifaddrs() ?? []; } catch { return; }
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
      const status = this.#sockets!.getsockopt(this.#fd, linux.SOL_SOCKET, linux.SO_ERROR, value);
      error = status < 0 ? status : -readIntOption(value);
    }
    if (error === -linux.EINPROGRESS) { this.#waitOut(); return; }
    this.#connect = null;
    try { pending.complete(error); }
    finally { forgetNodeRequest(pending.request); pending.release(); }
    if (this.#fd < 0) return;
    if (error < 0) { for (const write of [...this.#writes]) this.#finishWrite(write, UV_ECANCELED); return; }
    if (this.#writes.length) this.#waitOut();
    else if (this.#shutdown) this.#drain();
  }

  readStart(): number {
    if (this.closed) return UV_EINVAL;
    if (!this.#readable) return UV_ENOTCONN;
    this.#reading = true;
    this.reading = true;
    this.#waitIn();
    return 0;
  }

  readStop(): number {
    // libuv stops polling; a readiness already asked for is answered and left: the bytes stay in the kernel's buffer.
    this.#reading = false;
    this.reading = false;
    return 0;
  }

  /** The socket's readability, asked once while a read or an accept wants it. */
  #waitIn(): void {
    const sockets = this.#sockets;
    if (this.#waitingIn || this.#fd < 0 || this.closed || !sockets) return;
    this.#waitingIn = true;
    const fd = this.#fd;
    void sockets.wait(fd, linux.POLLIN).then(() => queueBindingTask(() => {
      this.#waitingIn = false;
      if (this.closed || this.#fd !== fd) return;
      if (this.listening) this.#accept();
      else if (this.#reading) this.#read();
    }));
  }

  /**
   * uv__server_io: one connection per readiness, handed to `onconnection`. A listener nobody serves yet (a passed one
   * whose receiver has not set its `onconnection`) leaves it in the kernel's backlog until it listens again.
   */
  #accept(): void {
    if (!this.listening || this.closed || this.onconnection === null) return;
    const fd = this.#sockets!.accept4(this.#fd, linux.SOCK_NONBLOCK | linux.SOCK_CLOEXEC, null);
    if (fd < 0) { this.#waitIn(); return; }
    const accepted = new (this.constructor as typeof TCP)(constants.SOCKET);
    accepted.#sockets = this.#sockets;
    const status = accepted.#adopt(fd, this.#family);
    if (status !== 0) { this.#sockets!.close(fd); accepted.#fd = -1; accepted.fd = -1; accepted.close(); this.#waitIn(); return; }
    accepted.#readable = true;
    accepted.#writable = true;
    // An accepted connection is a handle of the loop that serves it.
    __adoptHandle(accepted, ownerOf(this), this);
    invokeOwned(this, 'onconnection', 0, accepted);
    this.#waitIn();
  }

  /** uv__read: up to 32 reads of 64 KiB, stopping at a short one, at EOF, at an error or when reading stops. */
  #read(): void {
    const sockets = this.#sockets!;
    for (let count = READS_PER_READINESS; count > 0 && this.#reading && !this.closed; count -= 1) {
      const target = this.userBuffer;
      const buffer = target ?? (this.#scratch ??= new Uint8Array(READ_BYTES));
      let read: number;
      do read = sockets.recvfrom(this.#fd, buffer, 0, null); while (read === -linux.EINTR);
      if (read === -linux.EAGAIN) { this.#waitIn(); return; }
      if (read < 0) {
        this.#readable = false;
        this.#writable = false;
        this.#reading = false;
        stopHandle(this);
        this.#deliverStatus(read);
        return;
      }
      if (read === 0) {
        // uv__stream_eof: reading stops, and a stopped handle holds no loop.
        this.#reading = false;
        stopHandle(this);
        this.#deliverStatus(UV_EOF);
        return;
      }
      this.bytesRead += read;
      streamBaseState[kReadBytesOrError] = read;
      streamBaseState[kArrayBufferOffset] = 0;
      if (target) invokeOwned(this, 'onread', null);
      else invokeOwned(this, 'onread', buffer.slice(0, read).buffer);
      if (read < buffer.byteLength) break;
    }
    if (this.#reading && !this.closed) this.#waitIn();
  }

  #deliverStatus(status: number): void {
    streamBaseState[kReadBytesOrError] = status;
    streamBaseState[kArrayBufferOffset] = 0;
    invokeOwned(this, 'onread', null);
  }

  /** send(2), never raising SIGPIPE (Node ignores it), so a closed peer is EPIPE. */
  #send(bytes: Uint8Array): number {
    let sent: number;
    do sent = this.#sockets!.sendto(this.#fd, bytes, linux.MSG_NOSIGNAL | linux.MSG_DONTWAIT, null); while (sent === -linux.EINTR);
    return sent;
  }

  /**
   * StreamBase::Write: tried at once (`uv_try_write`), complete and synchronous when taken whole; what remains is
   * queued and sent as the socket can take it, completed through the request.
   */
  protected override dispatchWrite(req: WriteWrap, buffer: Uint8Array, handle?: unknown): number {
    streamBaseState[kBytesWritten] = buffer.byteLength;
    streamBaseState[kLastWriteWasAsync] = 0;
    req.async = false;
    if (handle !== undefined && handle !== null) return UV_EINVAL;
    if (this.closed) return UV_EBADF;
    if (!this.#writable || this.#fd < 0) return UV_EPIPE;
    let sent = 0;
    if (this.#writes.length === 0 && this.#connect === null) {
      const taken = this.#send(buffer);
      if (taken < 0 && taken !== -linux.EAGAIN) return taken;
      if (taken > 0) { sent = taken; this.bytesWritten += taken; }
      if (sent === buffer.byteLength) return 0;
    }
    this.#writes.push({ request: req, bytes: buffer, sent, release: holdRequest(this) });
    this.writeQueueSize += buffer.byteLength - sent;
    observeNodeRequest(req, this);
    req.async = true;
    streamBaseState[kLastWriteWasAsync] = 1;
    if (this.#connect === null) this.#waitOut();
    return 0;
  }

  /** The socket's writability, asked once while a connect or a queued write wants it. */
  #waitOut(): void {
    const sockets = this.#sockets;
    if (this.#waitingOut || this.#fd < 0 || this.closed || !sockets) return;
    this.#waitingOut = true;
    const fd = this.#fd;
    void sockets.wait(fd, linux.POLLOUT).then(() => queueBindingTask(() => {
      this.#waitingOut = false;
      if (this.closed || this.#fd !== fd) return;
      if (this.#connect) this.#connected();
      else this.#flushWrites();
    }));
  }

  /** uv__write: the queue, in order, as far as the socket takes it; then uv__drain. */
  #flushWrites(): void {
    let count = WRITES_PER_READINESS;
    while (this.#writes.length) {
      const write = this.#writes[0]!;
      const taken = this.#send(write.bytes.subarray(write.sent));
      if (taken === -linux.EAGAIN) { this.#waitOut(); return; }
      if (taken < 0) { this.#finishWrite(write, taken); return; }
      write.sent += taken;
      this.bytesWritten += taken;
      this.writeQueueSize -= taken;
      if (write.sent < write.bytes.byteLength) continue;
      this.#finishWrite(write, 0);
      if (--count <= 0) { this.#waitOut(); return; }
    }
    this.#drain();
  }

  #finishWrite(write: QueuedWrite, status: number): void {
    const index = this.#writes.indexOf(write);
    if (index < 0) return;
    this.#writes.splice(index, 1);
    this.writeQueueSize -= write.bytes.byteLength - write.sent;
    queueBindingTask(() => {
      try { invokeOwned(write.request, 'oncomplete', status); }
      finally { forgetNodeRequest(write.request); write.release(); }
    });
  }

  /** uv_shutdown: the write side ends once the queued writes are sent. */
  override shutdown(req: ShutdownWrap): number {
    if (!this.#writable || this.#shut || this.#shutdown || this.closed || this.#fd < 0) return UV_ENOTCONN;
    this.#writable = false;
    observeNodeRequest(req, this);
    this.#shutdown = { request: req, release: holdRequest(this) };
    if (this.#writes.length === 0 && this.#connect === null) queueBindingTask(() => this.#drain());
    return 0;
  }

  /** uv__drain: the pending shutdown, once nothing is queued. */
  #drain(): void {
    const pending = this.#shutdown;
    if (!pending || this.#writes.length) return;
    this.#shutdown = null;
    let status = 0;
    if (this.closed) status = UV_ECANCELED;
    else {
      const shut = this.#sockets!.shutdown(this.#fd, linux.SHUT_WR);
      if (shut < 0) status = shut; else this.#shut = true;
    }
    queueBindingTask(() => {
      try { invokeOwned(pending.request, 'oncomplete', status); }
      finally { forgetNodeRequest(pending.request); pending.release(); }
    });
  }

  /** uv_close: the descriptor goes now; what was pending is cancelled before the close's own callback. */
  override close(callback?: () => void): void {
    if (!this.closed) {
      const connect = this.#connect;
      this.#connect = null;
      if (connect) queueBindingTask(() => { try { connect.complete(UV_ECANCELED); } finally { forgetNodeRequest(connect.request); connect.release(); } });
      for (const write of [...this.#writes]) this.#finishWrite(write, UV_ECANCELED);
      if (this.#shutdown) this.#drain();
      this.#reading = false;
      if (this.#fd >= 0 && this.#sockets) this.#sockets.close(this.#fd);
      this.#fd = -1;
      this.fd = -1;
    }
    super.close(callback);
  }

  /**
   * A listening socket passed over IPC is one socket under two descriptors, as `SCM_RIGHTS` gives it: the copy is
   * `F_DUPFD_CLOEXEC` of this one, the same open description.
   */
  override get listenerDuplicates(): boolean { return true; }

  /** libuv's `dup()`: the same socket under a second descriptor of this process, listening where it listens. */
  override duplicate(): TCP {
    const copy = new (this.constructor as typeof TCP)(this.type);
    copy.#sockets = this.#sockets;
    if (this.#fd >= 0 && this.#sockets) {
      const fd = this.#sockets.fcntl(this.#fd, linux.F_DUPFD_CLOEXEC, 0);
      if (fd < 0) throw Object.assign(new Error(`dup ${errname(fd)}`), { errno: fd, code: errname(fd), syscall: 'dup' });
      copy.#adopt(fd, this.#family);
      copy.#readable = this.#readable;
      copy.#writable = this.#writable;
    }
    copy.shareConnectionFrom(this);
    copy.listening = this.listening;
    return copy;
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
    if (this.#fd < 0 || !this.#sockets) return UV_EBADF;
    const buffer = socketAddressBuffer();
    const status = this.#sockets[call](this.#fd, buffer);
    if (status < 0) return status;
    const name: SocketName | undefined = readSocketName(buffer, this.#sockets);
    if (!name) return UV_EINVAL;
    out.address = name.address;
    out.family = name.family;
    out.port = name.port;
    return 0;
  }

  /** uv_tcp_nodelay: set now where the socket exists, and remembered for when it is made. */
  setNoDelay(enable: boolean): number {
    const on = Boolean(enable);
    if (this.#fd >= 0) { const status = this.#setInt(linux.IPPROTO_TCP, linux.TCP_NODELAY, on ? 1 : 0); if (status !== 0) return status; }
    this.#noDelay = on;
    return 0;
  }

  /** uv_tcp_keepalive_ex (TCPWrap::SetKeepAlive: an interval of 1 s and 10 probes where none is given). */
  setKeepAlive(enable: boolean, delay: number, interval?: number, count?: number): number {
    const on = Boolean(enable);
    if (this.#fd >= 0) {
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
    const status = this.#sockets!.getsockopt(this.#fd, option.level, option.name, value);
    return status < 0 ? status : readIntOption(value);
  }

  #typeOfServiceOption(): { level: number; name: number } | number {
    if (this.#fd < 0) return UV_EBADF;
    const out: Partial<SockName> = {};
    const status = this.getsockname(out);
    if (status !== 0) return status;
    return out.family === 'IPv6' ? { level: linux.IPPROTO_IPV6, name: linux.IPV6_TCLASS } : { level: linux.IPPROTO_IP, name: linux.IP_TOS };
  }

  setSimultaneousAccepts(_enable: boolean): number {
    return 0;
  }

  /** uv_tcp_open: a descriptor of this process's, made non-blocking. */
  open(fd: number): number {
    const sockets = this.#sockets;
    if (!sockets) return UV_EBADF;
    const flags = sockets.fcntl(fd, linux.F_GETFL, 0);
    if (flags < 0) return flags;
    const set = sockets.fcntl(fd, linux.F_SETFL, flags | linux.O_NONBLOCK);
    if (set < 0) return set;
    const buffer = socketAddressBuffer();
    const named = sockets.getsockname(fd, buffer);
    const family = named < 0 ? linux.AF_INET : buffer[0]! | (buffer[1]! << 8);
    const status = this.#adopt(fd, family);
    if (status !== 0) return status;
    this.#readable = true;
    this.#writable = true;
    return 0;
  }

  /** uv_tcp_close_reset: `SO_LINGER` {1, 0}, then close: the peer reads ECONNRESET rather than EOF. */
  reset(callback?: () => void): number {
    if (this.closed) return UV_EBADF;
    if (this.#shutdown) return UV_EINVAL;
    if (this.#fd >= 0 && this.#sockets) {
      const linger = new Uint8Array(8);
      new DataView(linger.buffer).setInt32(0, 1, true);
      const status = this.#sockets.setsockopt(this.#fd, linux.SOL_SOCKET, linux.SO_LINGER, linger);
      if (status < 0 && status !== -linux.EINVAL) return status;
    }
    this.close(callback);
    return 0;
  }

  protected override onCloseHandle(): void {
    const wasListening = this.listening;
    this.listening = false;
    this.onconnection = null;
    // A listening socket another descriptor of this engine still holds (a passed server) goes on listening.
    const shared = [...this.sharingHandles].some(handle => handle !== this && handle instanceof TCP && handle.listening);
    const announced = wasListening && !shared ? announcements.get(this.connectionEnd) : undefined;
    if (announced) {
      announcements.delete(this.connectionEnd);
      for (const watcher of [...listenWatchers.get(announced.sockets) ?? []]) {
        try { watcher.onClose(announced.port); } catch { /* as above */ }
      }
    }
  }
}

export default { TCP, TCPConnectWrap, constants };
