/**
 * `internalBinding('udp_wrap')`: libuv's `uv_udp_t` over the calling process's kernel sockets (ADR-0009), under
 * Node's own `dgram.js` and `internal/dgram.js`.
 *
 * A handle keeps the socket calls of the process that made it, as `tcp_wrap`'s does. The rules are libuv's and
 * Node's, read in Node v24.21.0's `deps/uv/src/unix/udp.c` and `src/udp_wrap.cc`: the socket is made at bind, or by
 * the first connect, send or receive, bound then to the wildcard of its family (`uv__udp_maybe_deferred_bind`); a
 * send is tried at once (`uv_udp_try_send`, which answers its size plus one when the datagram was taken) and else
 * queued for the socket's writability; a receive delivers each datagram as `onmessage(nread, handle, buffer, rinfo)`,
 * at most 32 per readiness; the options are their socket options. A process whose tree offers no socket calls has no
 * IPv4 or IPv6: making the socket is `EAFNOSUPPORT`.
 */
import { queueBindingTask, withGuestCallback } from '../../guest-loop';
import { holdRequest, invokeOwned, nodeHandleHasRef, refHandle, registerHandle, releaseHandle, resourceScopeProcess, startHandle, stopHandle, unrefHandle, type OwnedHandle } from './handles';
import { nextHandleAsyncId } from './stream_wrap';
import { kHandleFd, registerKernelHandle } from './kernel_stream';
import { UV_EAFNOSUPPORT, UV_EBADF, UV_ECANCELED, UV_EINVAL, UV_ENOSYS, UV_ENOTCONN, errname, getErrorMap } from './uv';
import { callingSockets, intOption, linux, readIntOption, readSocketName, socketAddress, socketAddressBuffer, type TreeSockets } from '../../host-sockets';
import { loadNodeLib, loadNodeLibFor } from '../load';

/** libuv's `uv_udp_flags` Node names. */
export const constants = {
  UV_UDP_IPV6ONLY: 1,
  UV_UDP_REUSEADDR: 4,
  UV_UDP_REUSEPORT: 64,
};
/** UV_UDP_LINUX_RECVERR, which uv__udp_bind also takes. */
const UV_UDP_LINUX_RECVERR = 32;
const UV_EISCONN = -106;
const UV_EDESTADDRREQ = -89;
const UV_ENODEV = -19;

/** uv__udp_recvmsg's buffer and its reads per readiness. */
const DATAGRAM_BYTES = 64 * 1024;
const RECEIVES_PER_READINESS = 32;

/** Node's `SendWrap`: the request a send is completed through, when it has a callback. */
export class SendWrap {
  list: unknown = null;
  address: unknown = undefined;
  port: unknown = undefined;
  callback: unknown = undefined;
  oncomplete: ((status: number, sent: number) => void) | null = null;
}

/** The `Buffer` of the graph whose binding made the handle, which a received datagram is one of. */
type BufferClass = { from(bytes: ArrayBuffer): Uint8Array };
function scopeBuffer(): BufferClass {
  const process = resourceScopeProcess();
  return ((process ? loadNodeLibFor(process, 'buffer') : loadNodeLib('buffer')) as { Buffer: BufferClass }).Buffer;
}

interface QueuedSend { request: SendWrap; data: Uint8Array; address: Uint8Array | null; hasCallback: boolean; release: () => void }

export class UDP implements OwnedHandle {
  /** Set by `dgram.js`: each datagram, or a receive's error. */
  onmessage: ((nread: number, handle: UDP, buffer?: unknown, rinfo?: unknown) => void) | null = null;
  onerror: ((nread: number, handle: UDP, error: unknown) => void) | null = null;
  /** Set by `internal/dgram.js`: the socket's lookup, bound to its family. */
  lookup: unknown = undefined;

  /** The socket calls of the process that made the handle, which it keeps. */
  #sockets: TreeSockets | undefined = callingSockets();
  #Buffer: BufferClass = scopeBuffer();
  #fd = -1;
  /** UV_HANDLE_IPV6: the socket was bound to an IPv6 address. */
  #ipv6 = false;
  /** UV_HANDLE_UDP_CONNECTED. */
  #connected = false;
  #receiving = false;
  #waitingIn = false;
  #waitingOut = false;
  #sends: QueuedSend[] = [];
  #sendQueueSize = 0;
  #closed = false;
  #scratch: Uint8Array | null = null;
  readonly #asyncId = nextHandleAsyncId();

  constructor() {
    // A UDP handle does nothing until it receives or sends (uv_udp_init leaves it stopped).
    registerHandle(this, true, false);
  }

  /** The socket's descriptor, -1 until it is made. */
  get fd(): number { return this.#fd; }
  get [kHandleFd](): number { return this.#fd; }

  getAsyncId(): number { return this.#asyncId; }

  ref(): void { refHandle(this); }
  unref(): void { unrefHandle(this); }
  hasRef(): boolean { return nodeHandleHasRef(this); }

  #setInt(level: number, name: number, value: number): number {
    if (this.#fd < 0 || !this.#sockets) return UV_EBADF;
    const status = this.#sockets.setsockopt(this.#fd, level, name, intOption(value));
    return status < 0 ? status : 0;
  }

  /** uv__udp_bind. */
  #bindTo(name: Uint8Array, family: number, flags: number): number {
    if (flags & ~(constants.UV_UDP_IPV6ONLY | constants.UV_UDP_REUSEADDR | constants.UV_UDP_REUSEPORT | UV_UDP_LINUX_RECVERR)) return UV_EINVAL;
    if ((flags & constants.UV_UDP_IPV6ONLY) && family !== linux.AF_INET6) return UV_EINVAL;
    const sockets = this.#sockets;
    if (!sockets) return UV_EAFNOSUPPORT;
    if (this.#fd < 0) {
      const fd = sockets.socket(family, linux.SOCK_DGRAM | linux.SOCK_NONBLOCK | linux.SOCK_CLOEXEC, 0);
      if (fd < 0) return fd;
      this.#fd = fd;
    }
    let status = 0;
    if (flags & constants.UV_UDP_REUSEADDR) status = this.#setInt(linux.SOL_SOCKET, linux.SO_REUSEADDR, 1);
    if (status === 0 && (flags & constants.UV_UDP_REUSEPORT)) status = this.#setInt(linux.SOL_SOCKET, linux.SO_REUSEPORT, 1);
    if (status === 0 && (flags & constants.UV_UDP_IPV6ONLY)) status = this.#setInt(linux.IPPROTO_IPV6, linux.IPV6_V6ONLY, 1);
    if (status !== 0) return status;
    const bound = sockets.bind(this.#fd, name);
    if (bound < 0) return bound === -linux.EAFNOSUPPORT ? UV_EINVAL : bound;
    if (family === linux.AF_INET6) this.#ipv6 = true;
    return 0;
  }

  /** uv__udp_maybe_deferred_bind: a socket not yet made is bound to its family's wildcard, port 0. */
  #deferredBind(family: number, flags = 0): number {
    if (this.#fd >= 0) return 0;
    const name = family === linux.AF_INET6 ? socketAddress(6, '::', 0) : socketAddress(4, '0.0.0.0', 0);
    return this.#bindTo(name!, family, flags);
  }

  bind(address: string, port: number, flags: number): number { return this.#bind(4, address, port, flags); }
  bind6(address: string, port: number, flags: number): number { return this.#bind(6, address, port, flags); }

  /** UDPWrap::DoBind: `sockaddr_for_family`, then uv_udp_bind. */
  #bind(family: 4 | 6, address: string, port: number, flags: number): number {
    if (this.#closed) return UV_EBADF;
    const name = socketAddress(family, String(address), Number(port) >>> 0, this.#sockets);
    if (!name) return UV_EINVAL;
    return this.#bindTo(name, family === 6 ? linux.AF_INET6 : linux.AF_INET, Number(flags) >>> 0);
  }

  /** uv_udp_open: a descriptor of this process's, made non-blocking. */
  open(fd: number): number {
    const sockets = this.#sockets;
    if (!sockets) return UV_EBADF;
    if (this.#fd >= 0) return -16; // UV_EBUSY
    const flags = sockets.fcntl(fd, linux.F_GETFL, 0);
    if (flags < 0) return flags;
    const set = sockets.fcntl(fd, linux.F_SETFL, flags | linux.O_NONBLOCK);
    if (set < 0) return set;
    this.#fd = fd;
    const name = socketAddressBuffer();
    if (sockets.getsockname(fd, name) === 0 && (name[0]! | (name[1]! << 8)) === linux.AF_INET6) this.#ipv6 = true;
    if (sockets.getpeername(fd, socketAddressBuffer()) === 0) this.#connected = true;
    return 0;
  }

  connect(address: string, port: number): number { return this.#connect(4, address, port); }
  connect6(address: string, port: number): number { return this.#connect(6, address, port); }

  /** uv_udp_connect to an address: bound first where it is not, then connect(2). */
  #connect(family: 4 | 6, address: string, port: number): number {
    if (this.#closed) return UV_EBADF;
    const name = socketAddress(family, String(address), Number(port) >>> 0, this.#sockets);
    if (!name) return UV_EINVAL;
    if (this.#connected) return UV_EISCONN;
    const status = this.#deferredBind(family === 6 ? linux.AF_INET6 : linux.AF_INET);
    if (status !== 0) return status;
    let connected: number;
    do connected = this.#sockets!.connect(this.#fd, name); while (connected === -linux.EINTR);
    if (connected < 0) return connected;
    this.#connected = true;
    return 0;
  }

  /** uv_udp_connect(handle, NULL): a connect to AF_UNSPEC dissolves the association. */
  disconnect(): number {
    if (this.#closed) return UV_EBADF;
    if (!this.#connected) return UV_ENOTCONN;
    const unspecified = new Uint8Array(16);
    let status: number;
    do status = this.#sockets!.connect(this.#fd, unspecified); while (status === -linux.EINTR);
    if (status < 0 && status !== -linux.EAFNOSUPPORT) return status;
    this.#connected = false;
    return 0;
  }

  send(request: SendWrap, list: Uint8Array[], count: number, ...rest: unknown[]): number { return this.#send(4, request, list, count, rest); }
  send6(request: SendWrap, list: Uint8Array[], count: number, ...rest: unknown[]): number { return this.#send(6, request, list, count, rest); }

  /**
   * UDPWrap::DoSend and Send: `send(req, list, count, port, address, hasCallback)` to an address, or
   * `send(req, list, count, hasCallback)` on a connected socket. A datagram taken at once answers its size plus one;
   * one queued answers 0 and completes through the request.
   */
  #send(family: 4 | 6, request: SendWrap, list: Uint8Array[], count: number, rest: unknown[]): number {
    if (this.#closed) return UV_EBADF;
    const sendto = rest.length === 3;
    const hasCallback = (sendto ? rest[2] : rest[0]) === true;
    let address: Uint8Array | null = null;
    if (sendto) {
      address = socketAddress(family, String(rest[1]), Number(rest[0]) >>> 0 & 0xffff, this.#sockets) ?? null;
      if (!address) return UV_EINVAL;
    }
    let size = 0;
    for (let index = 0; index < count; index += 1) size += list[index]!.byteLength;
    const data = new Uint8Array(size);
    for (let index = 0, at = 0; index < count; index += 1) { data.set(list[index]!, at); at += list[index]!.byteLength; }
    // uv_udp_try_send's and uv_udp_send's checks.
    if (address && this.#connected) return UV_EISCONN;
    if (!address && !this.#connected) return UV_EDESTADDRREQ;
    if (address) {
      const status = this.#deferredBind(family === 6 ? linux.AF_INET6 : linux.AF_INET);
      if (status !== 0) return status;
    }
    if (this.#sends.length === 0) {
      const sent = this.#sendto(data, address);
      if (sent >= 0) return size + 1;
      if (sent !== -linux.EAGAIN && sent !== UV_ENOSYS) return sent;
    }
    this.#sends.push({ request, data, address, hasCallback, release: holdRequest(this) });
    this.#sendQueueSize += size;
    this.#waitOut();
    return 0;
  }

  #sendto(data: Uint8Array, address: Uint8Array | null): number {
    let sent: number;
    do sent = this.#sockets!.sendto(this.#fd, data, linux.MSG_DONTWAIT, address); while (sent === -linux.EINTR);
    return sent;
  }

  #waitOut(): void {
    const sockets = this.#sockets;
    if (this.#waitingOut || this.#fd < 0 || this.#closed || !sockets) return;
    this.#waitingOut = true;
    const fd = this.#fd;
    void sockets.wait(fd, linux.POLLOUT).then(() => queueBindingTask(() => {
      this.#waitingOut = false;
      if (this.#closed || this.#fd !== fd) return;
      this.#flushSends();
    }));
  }

  /** uv__udp_sendmsg: the queue in order while the socket takes datagrams. */
  #flushSends(): void {
    while (this.#sends.length) {
      const send = this.#sends[0]!;
      const sent = this.#sendto(send.data, send.address);
      if (sent === -linux.EAGAIN) { this.#waitOut(); return; }
      this.#finishSend(send, sent < 0 ? sent : 0);
    }
  }

  /** OnSendDone: a send with a callback is told its status and the datagram's size. */
  #finishSend(send: QueuedSend, status: number): void {
    const index = this.#sends.indexOf(send);
    if (index >= 0) this.#sends.splice(index, 1);
    this.#sendQueueSize -= send.data.byteLength;
    queueBindingTask(() => {
      try { if (send.hasCallback) invokeOwned(send.request, 'oncomplete', status, send.data.byteLength); }
      finally { send.release(); }
    });
  }

  /** uv_udp_recv_start (UDPWrap::RecvStart takes an already receiving socket as success). */
  recvStart(): number {
    if (this.#closed) return UV_EBADF;
    if (this.#receiving) return 0;
    const status = this.#deferredBind(linux.AF_INET);
    if (status !== 0) return status;
    this.#receiving = true;
    startHandle(this);
    this.#waitIn();
    return 0;
  }

  recvStop(): number {
    if (this.#receiving) { this.#receiving = false; stopHandle(this); }
    return 0;
  }

  #waitIn(): void {
    const sockets = this.#sockets;
    if (this.#waitingIn || this.#fd < 0 || this.#closed || !sockets) return;
    this.#waitingIn = true;
    const fd = this.#fd;
    void sockets.wait(fd, linux.POLLIN).then(() => queueBindingTask(() => {
      this.#waitingIn = false;
      if (this.#closed || this.#fd !== fd || !this.#receiving) return;
      this.#receive();
    }));
  }

  /** uv__udp_recvmsg and UDPWrap::OnRecv: each datagram to `onmessage`, an error as its status. */
  #receive(): void {
    const sockets = this.#sockets!;
    for (let count = RECEIVES_PER_READINESS; count > 0 && this.#receiving && !this.#closed; count -= 1) {
      const buffer = this.#scratch ??= new Uint8Array(DATAGRAM_BYTES);
      const from = socketAddressBuffer();
      let read: number;
      do read = sockets.recvfrom(this.#fd, buffer, 0, from); while (read === -linux.EINTR);
      if (read === -linux.EAGAIN) break;
      if (read < 0) {
        invokeOwned(this, 'onmessage', read, this, undefined, undefined);
        break;
      }
      const name = readSocketName(from, sockets);
      const rinfo = name ? { address: name.address, family: name.family, port: name.port } : undefined;
      invokeOwned(this, 'onmessage', read, this, this.#Buffer.from(buffer.slice(0, read).buffer), rinfo);
    }
    if (this.#receiving && !this.#closed) this.#waitIn();
  }

  getsockname(out: Record<string, unknown>): number { return this.#name('getsockname', out); }
  getpeername(out: Record<string, unknown>): number { return this.#name('getpeername', out); }

  #name(call: 'getsockname' | 'getpeername', out: Record<string, unknown>): number {
    if (this.#fd < 0 || !this.#sockets) return UV_EBADF;
    const buffer = socketAddressBuffer();
    const status = this.#sockets[call](this.#fd, buffer);
    if (status < 0) return status;
    const name = readSocketName(buffer, this.#sockets);
    if (!name) return UV_EINVAL;
    out.address = name.address;
    out.family = name.family;
    out.port = name.port;
    return 0;
  }

  /** uv__setsockopt: the IPv6 option on a socket bound to IPv6, the IPv4 one otherwise. */
  #familyOption(option4: number, option6: number, value: number): number {
    return this.#ipv6 ? this.#setInt(linux.IPPROTO_IPV6, option6, value) : this.#setInt(linux.IPPROTO_IP, option4, value);
  }

  setBroadcast(on: number): number { return this.#setInt(linux.SOL_SOCKET, linux.SO_BROADCAST, Number(on) | 0); }

  /** uv_udp_set_ttl: 1 to 255. */
  setTTL(ttl: number): number {
    const value = Number(ttl) | 0;
    if (value < 1 || value > 255) return UV_EINVAL;
    return this.#familyOption(linux.IP_TTL, linux.IPV6_UNICAST_HOPS, value);
  }

  /** uv_udp_set_multicast_ttl: 0 to 255 for an IPv4 socket. */
  setMulticastTTL(ttl: number): number {
    const value = Number(ttl) | 0;
    if (!this.#ipv6 && (value < 0 || value > 255)) return UV_EINVAL;
    return this.#familyOption(linux.IP_MULTICAST_TTL, linux.IPV6_MULTICAST_HOPS, value);
  }

  setMulticastLoopback(on: number): number {
    const value = Number(on) | 0;
    if (!this.#ipv6 && (value < 0 || value > 255)) return UV_EINVAL;
    return this.#familyOption(linux.IP_MULTICAST_LOOP, linux.IPV6_MULTICAST_LOOP, value);
  }

  /** uv_udp_set_multicast_interface: IP_MULTICAST_IF with the interface's address, IPV6_MULTICAST_IF with its index. */
  setMulticastInterface(interfaceAddress: string): number {
    if (this.#fd < 0 || !this.#sockets) return UV_EBADF;
    const given = interfaceAddress === undefined || interfaceAddress === null ? undefined : String(interfaceAddress);
    const v4 = given === undefined ? (this.#ipv6 ? undefined : socketAddress(4, '0.0.0.0', 0)) : socketAddress(4, given, 0);
    const v6 = v4 ? undefined : given === undefined ? socketAddress(6, '::', 0) : socketAddress(6, given, 0, this.#sockets);
    if (v4) {
      const status = this.#sockets.setsockopt(this.#fd, linux.IPPROTO_IP, linux.IP_MULTICAST_IF, v4.slice(4, 8));
      return status < 0 ? status : 0;
    }
    if (!v6) return UV_EINVAL;
    const status = this.#sockets.setsockopt(this.#fd, linux.IPPROTO_IPV6, linux.IPV6_MULTICAST_IF, v6.slice(24, 28));
    return status < 0 ? status : 0;
  }

  addMembership(multicastAddress: string, interfaceAddress?: string | null): number { return this.#membership(multicastAddress, interfaceAddress, true); }
  dropMembership(multicastAddress: string, interfaceAddress?: string | null): number { return this.#membership(multicastAddress, interfaceAddress, false); }

  /** uv_udp_set_membership: bound first (with SO_REUSEADDR) where it is not, then a `struct ip_mreq` or `ipv6_mreq`. */
  #membership(multicastAddress: string, interfaceAddress: string | null | undefined, join: boolean): number {
    if (this.#closed) return UV_EBADF;
    const group4 = socketAddress(4, String(multicastAddress), 0);
    const group6 = group4 ? undefined : socketAddress(6, String(multicastAddress), 0, this.#sockets);
    if (!group4 && !group6) return UV_EINVAL;
    const status = this.#deferredBind(group4 ? linux.AF_INET : linux.AF_INET6, constants.UV_UDP_REUSEADDR);
    if (status !== 0) return status;
    const sockets = this.#sockets!;
    const iface = interfaceAddress === undefined || interfaceAddress === null ? undefined : String(interfaceAddress);
    let applied: number;
    if (group4) {
      const request = new Uint8Array(8);
      request.set(group4.subarray(4, 8), 0);
      if (iface !== undefined) {
        const own = socketAddress(4, iface, 0);
        if (!own) return UV_EINVAL;
        request.set(own.subarray(4, 8), 4);
      }
      applied = sockets.setsockopt(this.#fd, linux.IPPROTO_IP, join ? linux.IP_ADD_MEMBERSHIP : linux.IP_DROP_MEMBERSHIP, request);
    } else {
      const request = new Uint8Array(20);
      request.set(group6!.subarray(8, 24), 0);
      if (iface !== undefined) {
        const own = socketAddress(6, iface, 0, sockets);
        if (!own) return UV_EINVAL;
        request.set(own.subarray(24, 28), 16);
      }
      applied = sockets.setsockopt(this.#fd, linux.IPPROTO_IPV6, join ? linux.IPV6_ADD_MEMBERSHIP : linux.IPV6_DROP_MEMBERSHIP, request);
    }
    if (applied === -6) return UV_ENODEV; // ENXIO
    return applied < 0 ? applied : 0;
  }

  addSourceSpecificMembership(source: string, group: string, interfaceAddress?: string | null): number { return this.#sourceMembership(source, group, interfaceAddress, true); }
  dropSourceSpecificMembership(source: string, group: string, interfaceAddress?: string | null): number { return this.#sourceMembership(source, group, interfaceAddress, false); }

  /**
   * uv_udp_set_source_membership, for IPv4: a `struct ip_mreq_source` (group, interface, source). An IPv6 one
   * (`struct group_source_req`) is laid out by the host's word size, which this interface does not fix: ENOSYS.
   */
  #sourceMembership(source: string, group: string, interfaceAddress: string | null | undefined, join: boolean): number {
    if (this.#closed) return UV_EBADF;
    const group4 = socketAddress(4, String(group), 0), source4 = socketAddress(4, String(source), 0);
    if (!group4 || !source4) {
      if (socketAddress(6, String(group), 0) && socketAddress(6, String(source), 0)) return UV_ENOSYS;
      return UV_EINVAL;
    }
    const status = this.#deferredBind(linux.AF_INET, constants.UV_UDP_REUSEADDR);
    if (status !== 0) return status;
    const request = new Uint8Array(12);
    request.set(group4.subarray(4, 8), 0);
    if (interfaceAddress !== undefined && interfaceAddress !== null) {
      const own = socketAddress(4, String(interfaceAddress), 0);
      if (!own) return UV_EINVAL;
      request.set(own.subarray(4, 8), 4);
    }
    request.set(source4.subarray(4, 8), 8);
    const applied = this.#sockets!.setsockopt(this.#fd, linux.IPPROTO_IP, join ? linux.IP_ADD_SOURCE_MEMBERSHIP : linux.IP_DROP_SOURCE_MEMBERSHIP, request);
    return applied < 0 ? applied : 0;
  }

  /** UDPWrap::BufferSize: `uv_recv_buffer_size` / `uv_send_buffer_size`, 0 reads the size; a failure fills `ctx`. */
  bufferSize(size: number, isRecv: boolean, ctx: Record<string, unknown>): number | undefined {
    const syscall = isRecv ? 'uv_recv_buffer_size' : 'uv_send_buffer_size';
    const fail = (err: number): undefined => {
      ctx.errno = err;
      ctx.code = errname(err);
      ctx.message = getErrorMap().get(err)?.[1] ?? 'unknown error';
      ctx.syscall = syscall;
      return undefined;
    };
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff) return fail(UV_EINVAL);
    if (this.#fd < 0 || !this.#sockets) return fail(UV_EBADF);
    const option = isRecv ? linux.SO_RCVBUF : linux.SO_SNDBUF;
    if (size === 0) {
      const value = new Uint8Array(4);
      const status = this.#sockets.getsockopt(this.#fd, linux.SOL_SOCKET, option, value);
      return status < 0 ? fail(status) : readIntOption(value);
    }
    const status = this.#setInt(linux.SOL_SOCKET, option, size);
    return status !== 0 ? fail(status) : size;
  }

  getSendQueueSize(): number { return this.#sendQueueSize; }
  getSendQueueCount(): number { return this.#sends.length; }

  /** uv_close: the descriptor goes now; queued sends complete with ECANCELED before the close's callback. */
  close(callback?: () => void): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#receiving = false;
    for (const send of [...this.#sends]) this.#finishSend(send, UV_ECANCELED);
    if (this.#fd >= 0 && this.#sockets) this.#sockets.close(this.#fd);
    this.#fd = -1;
    releaseHandle(this, true);
    if (typeof callback === 'function') queueBindingTask(() => queueBindingTask(() => withGuestCallback(callback)));
  }
}

registerKernelHandle('UDP', () => new UDP());

export default { UDP, SendWrap, constants };
