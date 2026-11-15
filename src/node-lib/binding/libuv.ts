/**
 * THE PROCESS'S LIBUV (ADR-0018 §3, §4): where the realm's process is the WALI program `node`, its loop is libuv's
 * and every handle a binding makes is a uv_handle_t in the process's memory, owned by the binding's object as Node's
 * HandleWrap owns its handle (`src/handle_wrap.cc`, Node v24.21.0). The glue is C (Tabnode's `native/node`, as Node's
 * `src/*_wrap.cc` is C++): the binding calls its exports, and libuv's callbacks reach the binding as the engine's
 * imports (`native/node/engine.h`), which `libuvImports` answers, each followed in C by a drain, as Node's
 * MakeCallback is followed by its InternalCallbackScope's close.
 *
 * The host gives the program here once, when its `bootstrap` import runs (`attachLibuv`): the program's exports and
 * the two calls that move bytes in and out of its memory. A realm with no program attached has no libuv (a tab's
 * engine with no machine), and its bindings are the engine's own.
 *
 * What a binding object keeps of its handle is what Node's C++ object keeps: its state (initialized, closing,
 * closed), its close callback and the requests it has in flight. What the handle does is libuv's.
 */
import { invokeOwned, ownedRun, ownerOfInstance, registerLibuvHandle, releaseLibuvHandle, type OwnedHandle } from './handles';
import { errname, getErrorMap } from './uv';

/** The exports of `node`'s glue (native/node/*.c), by their C names; a pointer is a number of the process's memory. */
export interface LibuvExports {
  tabnode_alloc(size: number): number;
  tabnode_free(bytes: number): void;
  tabnode_handle_close(wrap: number): void;
  tabnode_handle_ref(wrap: number): void;
  tabnode_handle_unref(wrap: number): void;
  tabnode_handle_has_ref(wrap: number): number;
  tabnode_handle_is_active(wrap: number): number;
  tabnode_handle_fileno(wrap: number): number;
  tabnode_guess_handle(fd: number): number;
  tabnode_pipe_pending_type(wrap: number): number;
  tabnode_stream_read_start(wrap: number): number;
  tabnode_stream_read_stop(wrap: number): number;
  tabnode_stream_use_buffer(wrap: number, length: number): void;
  tabnode_stream_write(wrap: number, id: number, bytes: number, length: number, sendHandle: number): number;
  tabnode_stream_shutdown(wrap: number, id: number): number;
  tabnode_stream_write_queue_size(wrap: number): number;
  tabnode_stream_set_blocking(wrap: number, blocking: number): number;
  tabnode_stream_listen(wrap: number, backlog: number): number;
  tabnode_stream_accept(server: number, client: number): number;
  tabnode_tcp_init(id: number): number;
  tabnode_tcp_open(wrap: number, fd: number): number;
  tabnode_tcp_bind(wrap: number, family: number, ip: number, port: number, flags: number): number;
  tabnode_tcp_connect(wrap: number, id: number, family: number, ip: number, port: number): number;
  tabnode_tcp_name(wrap: number, peer: number, out: number): number;
  tabnode_tcp_nodelay(wrap: number, enable: number): number;
  tabnode_tcp_keepalive(wrap: number, enable: number, delay: number, interval: number, count: number): number;
  tabnode_tcp_set_tos(wrap: number, tos: number): number;
  tabnode_tcp_get_tos(wrap: number): number;
  tabnode_tcp_reset(wrap: number): number;
  tabnode_pipe_init(id: number, ipc: number): number;
  tabnode_pipe_bind(wrap: number, name: number, length: number): number;
  tabnode_pipe_open(wrap: number, fd: number): number;
  tabnode_pipe_connect(wrap: number, id: number, name: number, length: number): number;
  tabnode_pipe_chmod(wrap: number, mode: number): number;
  tabnode_tty_new(id: number): number;
  tabnode_tty_init(wrap: number, fd: number): number;
  tabnode_tty_get_winsize(wrap: number, out: number): number;
  tabnode_tty_set_mode(wrap: number, mode: number): number;
  tabnode_udp_init(id: number): number;
  tabnode_udp_open(wrap: number, fd: number): number;
  tabnode_udp_bind(wrap: number, family: number, ip: number, port: number, flags: number): number;
  tabnode_udp_connect(wrap: number, family: number, ip: number, port: number): number;
  tabnode_udp_disconnect(wrap: number): number;
  tabnode_udp_send(wrap: number, id: number, bytes: number, length: number, family: number, ip: number, port: number): number;
  tabnode_udp_recv_start(wrap: number): number;
  tabnode_udp_recv_stop(wrap: number): number;
  tabnode_udp_name(wrap: number, peer: number, out: number): number;
  tabnode_udp_membership(wrap: number, address: number, iface: number, join: number): number;
  tabnode_udp_source_membership(wrap: number, source: number, group: number, iface: number, join: number): number;
  tabnode_udp_multicast_interface(wrap: number, iface: number): number;
  tabnode_udp_set_int(wrap: number, which: number, value: number): number;
  tabnode_udp_buffer_size(wrap: number, size: number, isRecv: number): number;
  tabnode_udp_send_queue_size(wrap: number): number;
  tabnode_udp_send_queue_count(wrap: number): number;
}

/** What the host gives: the program's exports and its memory's one door, a copy out and a copy in. */
export interface LibuvProgram {
  readonly exports: LibuvExports;
  /** A copy of `length` bytes of the process's memory at `at`. */
  read(at: number, length: number): Uint8Array;
  /** `bytes` into the process's memory at `at`. */
  write(at: number, bytes: Uint8Array): void;
}

let program: LibuvProgram | undefined;

/** The realm's process is `node` on libuv's loop: its program, given once by the host's `bootstrap`. */
export function attachLibuv(given: LibuvProgram): void {
  if (program && program !== given) throw new Error('the realm already has its process\'s libuv');
  program = given;
}

/** The realm's process's libuv, where it has one. */
export function libuv(): LibuvProgram | undefined { return program; }

function attached(): LibuvProgram {
  if (!program) throw new Error('the realm has no libuv');
  return program;
}

/** The exports of the attached program. */
export function uv(): LibuvExports { return attached().exports; }

/** `bytes` copied into room the call they are handed to owns (a write's, a send's): the room's address. */
export function intoMemory(bytes: Uint8Array): number {
  const { exports, write } = attached();
  const at = exports.tabnode_alloc(bytes.byteLength);
  if (bytes.byteLength) write(at, bytes);
  return at;
}

/** A copy of `length` bytes of the process's memory at `at`, an ArrayBuffer of its own. */
export function fromMemory(at: number, length: number): ArrayBuffer {
  const bytes = attached().read(at, length);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `text` as Node's Utf8Value makes it (its UTF-8, NUL-terminated) in the process's memory for the length of `call`,
 * which is given its address and its length without the NUL; null text is a NULL pointer.
 */
export function withCString<T>(text: string | null, call: (at: number, length: number) => T): T {
  if (text === null) return call(0, 0);
  const bytes = encoder.encode(text);
  const room = new Uint8Array(bytes.byteLength + 1);
  room.set(bytes);
  const at = intoMemory(room);
  try { return call(at, bytes.byteLength); } finally { uv().tabnode_free(at); }
}

/** Room of `size` bytes for a call's out-parameters, read back as a DataView, for the length of `call`. */
export function withRoom<T>(size: number, call: (at: number) => T, read: (view: DataView, answer: T) => void): T {
  const exports = uv();
  const at = exports.tabnode_alloc(size);
  try {
    const answer = call(at);
    const bytes = attached().read(at, size);
    read(new DataView(bytes.buffer, bytes.byteOffset, size), answer);
    return answer;
  } finally { exports.tabnode_free(at); }
}

/** native/node wrap.h `tabnode_address_t`: family, port, error, then the address's text; room enough for it. */
const ADDRESS_BYTES = 128;
const ADDRESS_TEXT = 12;

/** AddressToJS's fields, as a name call or a received datagram fills them. */
export interface AddressFields { address: string; family?: string; port?: number }

/** A filled `tabnode_address_t`, read as AddressToJS writes its object; uv_if_indextoiid's failure is thrown. */
export function readAddress(view: DataView): AddressFields {
  const family = view.getInt32(0, true), port = view.getInt32(4, true), error = view.getInt32(8, true);
  if (error !== 0) throw uvException(error, 'uv_if_indextoiid');
  let end = ADDRESS_TEXT;
  while (end < view.byteLength && view.getUint8(end) !== 0) end += 1;
  const address = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + ADDRESS_TEXT, end - ADDRESS_TEXT));
  if (family === 4) return { address, family: 'IPv4', port };
  if (family === 6) return { address, family: 'IPv6', port };
  return { address: '' };
}

/** GetSockOrPeerName (src/node_internals.h:70-83): `call` fills a name; on success AddressToJS sets it on `out`. */
export function sockOrPeerName(call: (out: number) => number, out: Record<string, unknown>): number {
  return withRoom(ADDRESS_BYTES, call, (view, err) => { if (err === 0) Object.assign(out, readAddress(view)); });
}

/** The process's memory at `at` read as a filled `tabnode_address_t`. */
export function addressAt(at: number): AddressFields {
  const bytes = attached().read(at, ADDRESS_BYTES);
  return readAddress(new DataView(bytes.buffer, bytes.byteOffset, ADDRESS_BYTES));
}

/** Node's UVException: an Error with the error's errno, code and syscall, as `env->ThrowUVException` makes it. */
export function uvException(err: number, syscall: string): Error {
  const [code, message] = getErrorMap().get(err) ?? [errname(err), 'unknown error'];
  return Object.assign(new Error(`${syscall}: ${message}`), { errno: err, code, syscall });
}

/** Environment::CollectUVExceptionInfo: the error's fields on the binding's context object. */
export function collectUVExceptionInfo(ctx: unknown, err: number, syscall: string): void {
  if (ctx === null || typeof ctx !== 'object') return;
  const [code, message] = getErrorMap().get(err) ?? [errname(err), 'unknown error'];
  Object.assign(ctx, { errno: err, code, message, syscall });
}

/** What a callback of libuv's reaches: the binding object a handle belongs to. */
export interface LibuvTarget {
  /** LibuvStreamWrap::OnUvRead. */
  onUvRead?(nread: number, base: number): void;
  /** ConnectionWrap::OnConnection. */
  onUvConnection?(status: number): void;
  /** UDPWrap::OnRecv. */
  onUvRecv?(nread: number, base: number, name: number, flags: number): void;
}

/** Each handle's object and each request's completion, by the number its C struct carries. */
const handles = new Map<number, UvHandle>();
const requests = new Map<number, (status: number, ...rest: number[]) => void>();
let nextId = 1;

/** A request in flight: its completion, called once with libuv's status (and what AfterConnect adds). */
export function dispatchRequest(complete: (status: number, ...rest: number[]) => void): number {
  const id = nextId++;
  requests.set(id, complete);
  return id;
}
/** A request whose dispatch failed: no completion will come. */
export function forgetRequest(id: number): void { requests.delete(id); }

function complete(id: number, status: number, ...rest: number[]): void {
  const done = requests.get(id);
  requests.delete(id);
  done?.(status, ...rest);
}

/**
 * The engine's imports libuv's callbacks reach (native/node/engine.h), which the host answers with these: each finds
 * its object by the number C gave it and calls its JavaScript; the drain that closes the callback's scope is C's.
 */
export const libuvImports = {
  handle_closed: (id: number): void => { handles.get(id)?.onClosed(); },
  stream_read: (id: number, nread: number, base: number): void => { handles.get(id)?.target.onUvRead?.(nread, base); },
  stream_written: (id: number, status: number): void => { complete(id, status); },
  stream_shut: (id: number, status: number): void => { complete(id, status); },
  stream_connection: (id: number, status: number): void => { handles.get(id)?.target.onUvConnection?.(status); },
  stream_connected: (id: number, status: number, readable: number, writable: number): void => { complete(id, status, readable, writable); },
  udp_received: (id: number, nread: number, base: number, name: number, flags: number): void => {
    handles.get(id)?.target.onUvRecv?.(nread, base, name, flags);
  },
  udp_sent: (id: number, status: number): void => { complete(id, status); },
};

const kInitialized = 0, kClosing = 1, kClosed = 2;

/**
 * Node's HandleWrap over a uv_handle_t of the process's (handle_wrap.cc): the wrap's address, its state, its close
 * callback (`handle_onclose_symbol`), and the requests in flight its owner dispatched, which hold the loop whatever the
 * handle's ref, as libuv's do. `owner` is the binding object (a TCP, a Pipe, a TTY, a UDP), whose callbacks it is.
 */
export class UvHandle {
  readonly id = nextId++;
  /** The wrap's address in the process's memory; 0 for a handle whose init failed. */
  wrap = 0;
  state = kInitialized;
  inFlight = 0;
  #onclose: (() => void) | undefined;

  constructor(readonly owner: OwnedHandle, readonly target: LibuvTarget, init: (id: number) => number) {
    handles.set(this.id, this);
    this.wrap = init(this.id);
    registerLibuvHandle(owner, () => this.holdsLoop(), () => this.hasRef());
  }

  /** MarkAsUninitialized: a handle whose init failed is closed, and its wrap freed (it was never in the loop). */
  uninitialized(): void {
    if (this.wrap) uv().tabnode_free(this.wrap);
    this.wrap = 0;
    this.state = kClosed;
    handles.delete(this.id);
    releaseLibuvHandle(this.owner);
  }

  /** HandleWrap::IsAlive: initialized or closing. */
  get alive(): boolean { return this.state !== kClosed && this.wrap !== 0; }
  get closing(): boolean { return this.state === kClosing; }

  /** What libuv counts of it: active and referenced, closing, or with a request in flight (uv__loop_alive). */
  holdsLoop(): boolean {
    if (!this.alive) return false;
    if (this.state === kClosing || this.inFlight > 0) return true;
    const exports = uv();
    return exports.tabnode_handle_is_active(this.wrap) !== 0 && exports.tabnode_handle_has_ref(this.wrap) !== 0;
  }

  ref(): void { if (this.alive) uv().tabnode_handle_ref(this.wrap); }
  unref(): void { if (this.alive) uv().tabnode_handle_unref(this.wrap); }
  hasRef(): boolean { return this.alive && uv().tabnode_handle_has_ref(this.wrap) !== 0; }

  /** HandleWrap::Close: once, from initialized; the callback is kept for OnClose. */
  close(callback: unknown): void {
    if (this.state !== kInitialized || !this.wrap) return;
    uv().tabnode_handle_close(this.wrap);
    this.closingWith(callback);
  }

  /** The state a close leaves, with its callback (TCPWrap::Reset closes through its own call). */
  closingWith(callback: unknown): void {
    this.state = kClosing;
    if (typeof callback === 'function') this.#onclose = callback as () => void;
  }

  /** uv_fileno: the descriptor, or a negative error where the handle has none. */
  fileno(): number { return this.alive ? uv().tabnode_handle_fileno(this.wrap) : -9; }

  /** A request dispatched under this handle: it holds the loop until `settled`. */
  dispatch(complete: (status: number, ...rest: number[]) => void): number {
    this.inFlight += 1;
    return dispatchRequest((status, ...rest) => { this.inFlight -= 1; complete(status, ...rest); });
  }
  /** A dispatch that failed: its request will not complete. */
  undispatch(id: number): void { this.inFlight -= 1; forgetRequest(id); }

  /** HandleWrap::OnClose: closed; the owner's own close work (`OnClose`), then the close callback in its run. */
  onClosed(): void {
    this.state = kClosed;
    this.wrap = 0;
    handles.delete(this.id);
    const callback = this.#onclose;
    this.#onclose = undefined;
    try { (this.owner as { onUvClose?(): void }).onUvClose?.(); }
    finally {
      releaseLibuvHandle(this.owner);
      if (callback) ownedRun(ownerOfInstance(this.owner), () => callback.call(this.owner), true, 'wrap', callback);
    }
  }
}

/** MakeCallback on a request's `oncomplete`, in its run, as ReqWrap's callback is made. */
export function completeRequest(request: object, ...args: unknown[]): void {
  invokeOwned(request, 'oncomplete', ...args);
}
