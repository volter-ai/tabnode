/**
 * `internalBinding('udp_wrap')`: Node's UDPWrap (Node v24.21.0's `src/udp_wrap.cc`) over libuv's `uv_udp_t`
 * (ADR-0018 §3, item 4), under Node's own `dgram.js` and `internal/dgram.js`, where the realm's process is `node` on
 * libuv's loop. The handle is libuv's in the process's memory; its socket and its deferred bind to its family's
 * wildcard, a send tried at once and else queued, the receives per readiness and every option are libuv's
 * (`deps/uv/src/unix/udp.c`). What is the binding's is what Node's object decides: a send taken at once answers its
 * size plus one, a received datagram is a Buffer with its sender's address (AddressToJS) for `onmessage`, and a send
 * with a callback completes through its request's `oncomplete`.
 *
 * A realm with no libuv is a process with no IPv4 or IPv6: making the socket is `EAFNOSUPPORT`.
 */
import { registerHandle, releaseHandle, nodeHandleHasRef, refHandle, unrefHandle, invokeOwned, observeNodeRequest, resourceScopeProcess, type OwnedHandle } from './handles';
import { nextHandleAsyncId } from './stream_wrap';
import { kHandleFd, kUvWrap, realmHasLibuv, registerKernelHandle } from './kernel_stream';
import { UV_EAFNOSUPPORT, UV_EBADF, UV_EINVAL } from './uv';
import { UvHandle, addressAt, collectUVExceptionInfo, completeRequest, fromMemory, intoMemory, sockOrPeerName, uv, withCString, type LibuvTarget } from './libuv';
import { loadNodeLib, loadNodeLibFor } from '../load';
import { queueBindingTask, withGuestCallback } from '../../guest-loop';

/** libuv's `uv_udp_flags` Node names. */
export const constants = {
  UV_UDP_IPV6ONLY: 1,
  UV_UDP_REUSEADDR: 4,
  UV_UDP_REUSEPORT: 64,
};

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

/** SetLibuvInt32's options, by native/node udp_wrap.c `tabnode_udp_set_int`. */
const MULTICAST_TTL = 0, MULTICAST_LOOP = 1, BROADCAST = 2, TTL = 3;

export class UDP implements OwnedHandle, LibuvTarget {
  /** Set by `dgram.js`: each datagram, or a receive's error. */
  onmessage: ((nread: number, handle: UDP, buffer?: unknown, rinfo?: unknown) => void) | null = null;
  onerror: ((nread: number, handle: UDP, error: unknown) => void) | null = null;
  /** Set by `internal/dgram.js`: the socket's lookup, bound to its family. */
  lookup: unknown = undefined;

  #Buffer: BufferClass = scopeBuffer();
  readonly #asyncId = nextHandleAsyncId();
  /** The handle, where the realm has libuv. */
  readonly #uv: UvHandle | undefined;
  /** A realm with no libuv: its handle is closed. */
  #closed = false;

  /** UDPWrap::New: a uv_udp_init'd handle. */
  constructor() {
    if (realmHasLibuv()) this.#uv = new UvHandle(this, this, (id) => uv().tabnode_udp_init(id));
    // A handle that does nothing holds nothing (uv_udp_init leaves it stopped).
    else registerHandle(this, true, false);
  }

  /** The handle where it is alive (ASSIGN_OR_RETURN_UNWRAP), else undefined. */
  #live(): UvHandle | undefined { return this.#uv?.alive ? this.#uv : undefined; }

  /** UDPWrap::GetFD: uv_fileno, UV_EBADF where there is none. */
  get fd(): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    const fd = handle.fileno();
    return fd >= 0 ? fd : UV_EBADF;
  }
  get [kHandleFd](): number { const fd = this.fd; return fd >= 0 ? fd : -1; }
  get [kUvWrap](): number { return this.#live()?.wrap ?? 0; }

  getAsyncId(): number { return this.#asyncId; }

  ref(): void { if (this.#uv) this.#uv.ref(); else refHandle(this); }
  unref(): void { if (this.#uv) this.#uv.unref(); else unrefHandle(this); }
  hasRef(): boolean { return this.#uv ? this.#uv.hasRef() : nodeHandleHasRef(this); }

  bind(address: string, port: number, flags: number): number { return this.#bind(4, address, port, flags); }
  bind6(address: string, port: number, flags: number): number { return this.#bind(6, address, port, flags); }

  /** UDPWrap::DoBind: `sockaddr_for_family`, then uv_udp_bind. */
  #bind(family: 4 | 6, address: string, port: number, flags: number): number {
    if (!this.#uv) return UV_EAFNOSUPPORT;
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    return withCString(String(address), (ip) => uv().tabnode_udp_bind(handle.wrap, family, ip, Number(port) >>> 0, Number(flags) >>> 0));
  }

  /** UDPWrap::Open: uv_udp_open. */
  open(fd: number): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    return uv().tabnode_udp_open(handle.wrap, Number(fd) | 0);
  }

  connect(address: string, port: number): number { return this.#connect(4, address, port); }
  connect6(address: string, port: number): number { return this.#connect(6, address, port); }

  /** UDPWrap::DoConnect: uv_udp_connect. */
  #connect(family: 4 | 6, address: string, port: number): number {
    if (!this.#uv) return UV_EAFNOSUPPORT;
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    return withCString(String(address), (ip) => uv().tabnode_udp_connect(handle.wrap, family, ip, Number(port) >>> 0));
  }

  /** UDPWrap::Disconnect: uv_udp_connect(handle, NULL). */
  disconnect(): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    return uv().tabnode_udp_disconnect(handle.wrap);
  }

  send(request: SendWrap, list: Uint8Array[], count: number, ...rest: unknown[]): number { return this.#send(4, request, list, count, rest); }
  send6(request: SendWrap, list: Uint8Array[], count: number, ...rest: unknown[]): number { return this.#send(6, request, list, count, rest); }

  /**
   * UDPWrap::DoSend and Send: `send(req, list, count, port, address, hasCallback)` to an address, or
   * `send(req, list, count, hasCallback)` on a connected socket. A datagram taken at once answers its size plus one;
   * one queued answers 0 and completes through the request.
   */
  #send(family: 4 | 6, request: SendWrap, list: Uint8Array[], count: number, rest: unknown[]): number {
    if (!this.#uv) return UV_EAFNOSUPPORT;
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    const sendto = rest.length === 3;
    const hasCallback = (sendto ? rest[2] : rest[0]) === true;
    let size = 0;
    for (let index = 0; index < count; index += 1) size += list[index]!.byteLength;
    const data = new Uint8Array(size);
    for (let index = 0, at = 0; index < count; index += 1) { data.set(list[index]!, at); at += list[index]!.byteLength; }
    const bytes = intoMemory(data);
    const id = handle.dispatch((status) => { if (hasCallback) completeRequest(request, status, size); });
    const answer = withCString(sendto ? String(rest[1]) : null, (ip) =>
      uv().tabnode_udp_send(handle.wrap, id, bytes, size, sendto ? family : 0, ip, sendto ? Number(rest[0]) >>> 0 : 0));
    if (answer === 0) observeNodeRequest(request, this);
    else handle.undispatch(id);
    return answer;
  }

  /** UDPWrap::RecvStart and RecvStop. */
  recvStart(): number {
    if (!this.#uv) return UV_EAFNOSUPPORT;
    const handle = this.#live();
    return handle ? uv().tabnode_udp_recv_start(handle.wrap) : UV_EBADF;
  }

  recvStop(): number {
    const handle = this.#live();
    return handle ? uv().tabnode_udp_recv_stop(handle.wrap) : UV_EBADF;
  }

  /**
   * UDPWrap::OnRecv: the datagram as a Buffer and its sender (AddressToJS) to `onmessage`, an error with nothing; an
   * address AddressToJS cannot make is `onerror`'s.
   */
  onUvRecv(nread: number, base: number, name: number): void {
    if (nread < 0) { invokeOwned(this, 'onmessage', nread, this, undefined, undefined); return; }
    let rinfo: unknown;
    try { rinfo = name === 0 ? undefined : addressAt(name); }
    catch (error) { invokeOwned(this, 'onerror', nread, this, error); return; }
    const buffer = this.#Buffer.from(nread === 0 ? new ArrayBuffer(0) : fromMemory(base, nread));
    invokeOwned(this, 'onmessage', nread, this, buffer, rinfo);
  }

  getsockname(out: Record<string, unknown>): number { return this.#name(0, out); }
  getpeername(out: Record<string, unknown>): number { return this.#name(1, out); }

  /** GetSockOrPeerName<UDPWrap, uv_udp_getsockname / uv_udp_getpeername>. */
  #name(peer: 0 | 1, out: Record<string, unknown>): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    return sockOrPeerName((at) => uv().tabnode_udp_name(handle.wrap, peer, at), out);
  }

  #setInt(which: number, value: number): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    return uv().tabnode_udp_set_int(handle.wrap, which, Number(value) | 0);
  }

  setBroadcast(on: number): number { return this.#setInt(BROADCAST, on); }
  setTTL(ttl: number): number { return this.#setInt(TTL, ttl); }
  setMulticastTTL(ttl: number): number { return this.#setInt(MULTICAST_TTL, ttl); }
  setMulticastLoopback(on: number): number { return this.#setInt(MULTICAST_LOOP, on); }

  /** UDPWrap::SetMulticastInterface: uv_udp_set_multicast_interface. */
  setMulticastInterface(interfaceAddress: string): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    return withCString(String(interfaceAddress), (iface) => uv().tabnode_udp_multicast_interface(handle.wrap, iface));
  }

  addMembership(multicastAddress: string, interfaceAddress?: string | null): number { return this.#membership(multicastAddress, interfaceAddress, 1); }
  dropMembership(multicastAddress: string, interfaceAddress?: string | null): number { return this.#membership(multicastAddress, interfaceAddress, 0); }

  /** UDPWrap::SetMembership: uv_udp_set_membership; no interface where it is undefined or null. */
  #membership(multicastAddress: string, interfaceAddress: string | null | undefined, join: number): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    const iface = interfaceAddress === undefined || interfaceAddress === null ? null : String(interfaceAddress);
    return withCString(String(multicastAddress), (group) => withCString(iface, (at) =>
      uv().tabnode_udp_membership(handle.wrap, group, at, join)));
  }

  addSourceSpecificMembership(source: string, group: string, interfaceAddress?: string | null): number { return this.#sourceMembership(source, group, interfaceAddress, 1); }
  dropSourceSpecificMembership(source: string, group: string, interfaceAddress?: string | null): number { return this.#sourceMembership(source, group, interfaceAddress, 0); }

  /** UDPWrap::SetSourceMembership: uv_udp_set_source_membership. */
  #sourceMembership(source: string, group: string, interfaceAddress: string | null | undefined, join: number): number {
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    const iface = interfaceAddress === undefined || interfaceAddress === null ? null : String(interfaceAddress);
    return withCString(String(source), (from) => withCString(String(group), (to) => withCString(iface, (at) =>
      uv().tabnode_udp_source_membership(handle.wrap, from, to, at, join))));
  }

  /** UDPWrap::BufferSize: uv_recv_buffer_size / uv_send_buffer_size, 0 reads the size; a failure fills `ctx`. */
  bufferSize(size: number, isRecv: boolean, ctx: Record<string, unknown>): number | undefined {
    const syscall = isRecv ? 'uv_recv_buffer_size' : 'uv_send_buffer_size';
    const handle = this.#live();
    if (!handle) return UV_EBADF;
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff) { collectUVExceptionInfo(ctx, UV_EINVAL, syscall); return undefined; }
    const answer = uv().tabnode_udp_buffer_size(handle.wrap, size, isRecv ? 1 : 0);
    if (answer < 0) { collectUVExceptionInfo(ctx, answer, syscall); return undefined; }
    return answer;
  }

  getSendQueueSize(): number { const handle = this.#live(); return handle ? uv().tabnode_udp_send_queue_size(handle.wrap) : UV_EBADF; }
  getSendQueueCount(): number { const handle = this.#live(); return handle ? uv().tabnode_udp_send_queue_count(handle.wrap) : UV_EBADF; }

  /** HandleWrap::Close: libuv cancels the queued sends (ECANCELED) before the close's callback. */
  close(callback?: () => void): void {
    if (this.#uv) { this.#uv.close(callback); return; }
    if (this.#closed) return;
    this.#closed = true;
    releaseHandle(this, true);
    if (typeof callback === 'function') queueBindingTask(() => queueBindingTask(() => withGuestCallback(callback)));
  }
}

registerKernelHandle('UDP', () => new UDP());

export default { UDP, SendWrap, constants };
