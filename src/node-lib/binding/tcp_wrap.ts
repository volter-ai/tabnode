/**
 * `internalBinding('tcp_wrap')`: Node's TCPWrap (Node v24.21.0's `src/tcp_wrap.cc`) over libuv's `uv_tcp_t`
 * (ADR-0018 §3, item 4), where the realm's process is `node` on libuv's loop. The handle is libuv's in the process's
 * memory, its stream `kernel_stream.ts`'s; making its socket, its family, SO_REUSEADDR and IPV6_V6ONLY at bind, a
 * bind's held EADDRINUSE, a connect in progress and its SO_ERROR, an accept per readiness and a close's cancellations
 * are libuv's (`deps/uv/src/unix/tcp.c`, `stream.c`). The binding parses nothing: an address's text and its port go to
 * uv_ip4_addr and uv_ip6_addr, as TCPWrap::Bind and Connect hand them.
 *
 * A realm with no libuv is a process with no IPv4 or IPv6: a bind, a listen or a connect is `EAFNOSUPPORT`.
 */
import { KernelStreamWrap, kKernelBacked, realmHasLibuv, registerKernelHandle } from './kernel_stream';
import { ownerOf, ownerOfInstance, observeNodeRequest } from './handles';
import { __runFor } from '../../process-tokens';
import { internalAsyncHooks } from '../internals/runtime';
import { nodeLibInternalRequire } from '../load';
import { rememberSocketConnect, traceSocketConnect } from '../../socket-connect-trace';
import { uvConstant } from './uv';
import { nodeProgram, sockOrPeerName, withCString } from './program';
import { wrapConstants } from '../../shims/constants';
import { callingSockets, type TreeSockets } from '../../host-sockets';

/** TCPWrap's SocketType (tcp_wrap.h:38-41) and uv.h's two flags `getFlags` builds, for a realm with no program. */
const engineConstants = { SOCKET: 0, SERVER: 1, UV_TCP_IPV6ONLY: 1, UV_TCP_REUSEPORT: 2 };

/** TCPWrap::Initialize's constants (tcp_wrap.cc:133-137), the program's compiled ones where the realm has it. */
export function tcpConstants(): typeof engineConstants { return wrapConstants('tcp_wrap', engineConstants); }

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
 * The listening handles on each port of a process's calls: its watchers hear a port once, when the first handle
 * listens on it, and its close when the last one closes (a listener received over IPC listens on the port its sender
 * did); a bridge asks which handles listen there (`listensWithTls`).
 */
const listening = new WeakMap<TreeSockets, Map<number, Set<TCP>>>();
/** The handles of `sockets`'s process listening on `port`. */
export function listeningHandles(sockets: TreeSockets, port: number): TCP[] {
  return [...listening.get(sockets)?.get(port) ?? []];
}

/** `IsUint32()` of an argument V8 would read. */
function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export class TCP extends KernelStreamWrap {
  /** `SOCKET` or `SERVER`. */
  readonly type: number;
  listening = false;
  /** Set by `net.js` on a server handle; how an accepted connection is announced. */
  onconnection: ((status: number, clientHandle: TCP | undefined) => void) | null = null;

  /** The socket calls of the process that made the handle, whose listen watchers hear its port. */
  readonly #sockets: TreeSockets | undefined = callingSockets();
  /** The port this handle told its process's watchers it listens on. */
  #announcedPort: number | null = null;

  /** TCPWrap::New: a uv_tcp_init'd handle. */
  constructor(type: number = tcpConstants().SOCKET) {
    super(realmHasLibuv(), false);
    this.type = type;
    if (this[kKernelBacked]) this.attachUv(nodeProgram().exports.tabnode_tcp_init(), true);
  }

  /** ConnectionWrap::OnConnection's client: TCPWrap::Instantiate with SOCKET. */
  protected override makeClient(): TCP {
    return new (this.constructor as typeof TCP)(tcpConstants().SOCKET);
  }

  bind(address: string, port: number, flags?: number): number {
    return this.#bind(4, address, port, flags);
  }

  bind6(address: string, port: number, flags?: number): number {
    return this.#bind(6, address, port, flags);
  }

  /** TCPWrap::Bind: the address parsed by uv_ip4_addr or uv_ip6_addr, then uv_tcp_bind. */
  #bind(family: 4 | 6, address: string, port: number, flags: unknown): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return uvConstant('UV_EAFNOSUPPORT');
    if (!handle) return uvConstant('UV_EBADF');
    const given = isUint32(flags) ? flags : 0;
    return withCString(String(address), (ip) => nodeProgram().exports.tabnode_tcp_bind(handle.wrap, family, ip, Number(port) | 0, given));
  }

  /** TCPWrap::Listen: uv_listen, whose connections are ConnectionWrap::OnConnection's. */
  listen(backlog: number): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return uvConstant('UV_EAFNOSUPPORT');
    if (!handle) return uvConstant('UV_EBADF');
    const err = nodeProgram().exports.tabnode_stream_listen(handle.wrap, Number(backlog) | 0);
    if (err !== 0) return err;
    const port = this.#localPort();
    if (!this.listening) {
      this.listening = true;
      this.#announce(port);
    }
    sayListenClock(this, port);
    return 0;
  }

  /** The bound port, or null where the socket has none. */
  #localPort(): number | null {
    const out: Partial<SockName> = {};
    return this.getsockname(out) === 0 && typeof out.port === 'number' ? out.port : null;
  }

  /** Its process's watchers hear the port it listens on, where no other of its handles listens there. */
  #announce(port: number | null): void {
    const sockets = this.#sockets;
    if (!sockets || port === null) return;
    this.#announcedPort = port;
    let ports = listening.get(sockets);
    if (!ports) listening.set(sockets, ports = new Map());
    let onPort = ports.get(port);
    if (!onPort) ports.set(port, onPort = new Set());
    onPort.add(this);
    if (onPort.size > 1) return;
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

  /** TCPWrap::Connect: the address parsed, then uv_tcp_connect under the request, completed by AfterConnect. */
  #connectTo(req: TCPConnectWrap, address: string, port: number, family: 4 | 6): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return uvConstant('UV_EAFNOSUPPORT');
    if (!handle) return uvConstant('UV_EBADF');
    const socket = (this as unknown as Record<symbol, unknown>)[internalAsyncHooks.symbols.owner_symbol];
    const owner = ownerOfInstance(req);
    if (socket && typeof socket === 'object') rememberSocketConnect(socket, {
      pid: owner === null ? null : __runFor(owner)?.process.pid ?? null, id: null,
      socketId: (socket as Record<symbol, number>)[internalAsyncHooks.symbols.async_id_symbol] ?? null, request: null,
    });
    const done = this.connectDone(req);
    const timer = (): unknown => (socket as Record<symbol, unknown> | undefined)?.[(nodeLibInternalRequire('internal/timers') as { kTimeout: symbol }).kTimeout];
    const id = handle.dispatch((status, readable, writable) => {
      traceSocketConnect('binding-entered', socket, timer(), status);
      try { done(status, readable, writable); }
      finally { traceSocketConnect('binding-returned', socket, timer(), status); }
    });
    const err = withCString(String(address), (ip) => nodeProgram().exports.tabnode_tcp_connect(handle.wrap, id, family, ip, Number(port) | 0));
    if (err) handle.undispatch(id);
    else observeNodeRequest(req, this);
    return err;
  }

  getsockname(out: Partial<SockName>): number {
    return this.#name(0, out);
  }

  getpeername(out: Partial<SockName>): number {
    return this.#name(1, out);
  }

  /** GetSockOrPeerName<TCPWrap, uv_tcp_getsockname / uv_tcp_getpeername>, AddressToJS on success. */
  #name(peer: 0 | 1, out: Partial<SockName>): number {
    const handle = this.liveUv();
    if (!handle) return uvConstant('UV_EBADF');
    return sockOrPeerName((at) => nodeProgram().exports.tabnode_tcp_name(handle.wrap, peer, at), out as Record<string, unknown>);
  }

  /** TCPWrap::SetNoDelay: uv_tcp_nodelay. */
  setNoDelay(enable: unknown): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return 0;
    if (!handle) return uvConstant('UV_EBADF');
    return nodeProgram().exports.tabnode_tcp_nodelay(handle.wrap, enable === true ? 1 : 0);
  }

  /** TCPWrap::SetKeepAlive: uv_tcp_keepalive_ex, an interval of 1 s and 10 probes where none is given. */
  setKeepAlive(enable: unknown, delay: number, interval?: unknown, count?: unknown): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return 0;
    if (!handle) return uvConstant('UV_EBADF');
    return nodeProgram().exports.tabnode_tcp_keepalive(handle.wrap, Number(enable) | 0, Number(delay) >>> 0,
      isUint32(interval) ? interval : 1, isUint32(count) ? count : 10);
  }

  /** TCPWrap::SetTypeOfService: IP_TOS or IPV6_TCLASS by the socket's family. */
  setTypeOfService(tos: number): number {
    const handle = this.liveUv();
    if (!handle) return uvConstant('UV_EBADF');
    return nodeProgram().exports.tabnode_tcp_set_tos(handle.wrap, Number(tos) | 0);
  }

  getTypeOfService(): number {
    const handle = this.liveUv();
    if (!handle) return uvConstant('UV_EBADF');
    return nodeProgram().exports.tabnode_tcp_get_tos(handle.wrap);
  }

  setSimultaneousAccepts(_enable: boolean): number {
    return 0;
  }

  /** TCPWrap::Open: uv_tcp_open of a descriptor of this process's. */
  open(fd: number): number {
    const handle = this.liveUv();
    if (!handle) return uvConstant('UV_EBADF');
    return nodeProgram().exports.tabnode_tcp_open(handle.wrap, Math.trunc(Number(fd)));
  }

  /** TCPWrap::Reset: uv_tcp_close_reset (the peer reads ECONNRESET), its callback HandleWrap::OnClose. */
  reset(callback?: () => void): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) { this.close(callback); return 0; }
    if (!handle || handle.closing) return 0;
    const err = nodeProgram().exports.tabnode_tcp_reset(handle.wrap);
    this.closed = true;
    handle.closingWith(err === 0 ? callback : undefined);
    return err;
  }

  protected override onCloseHandle(): void {
    this.listening = false;
    this.onconnection = null;
    const port = this.#announcedPort, sockets = this.#sockets;
    this.#announcedPort = null;
    const ports = sockets && listening.get(sockets);
    const onPort = port === null ? undefined : ports?.get(port);
    if (port === null || !ports || !onPort) return;
    onPort.delete(this);
    if (onPort.size > 0) return;
    ports.delete(port);
    for (const watcher of [...listenWatchers.get(sockets) ?? []]) {
      try { watcher.onClose(port); } catch { /* a watcher that throws is not the close's business */ }
    }
  }
}

registerKernelHandle('TCP', () => new TCP(tcpConstants().SOCKET));

export default { TCP, TCPConnectWrap, get constants() { return tcpConstants(); } };
