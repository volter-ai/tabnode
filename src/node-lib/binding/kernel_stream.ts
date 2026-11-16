/**
 * Node's LibuvStreamWrap over libuv's `uv_stream_t` (ADR-0018 §3, items 3 and 4): what `tcp_wrap`'s TCP,
 * `pipe_wrap`'s Pipe and `tty_wrap`'s TTY share where the realm's process is `node` on libuv's loop, as Node's
 * `src/stream_wrap.cc`, the JavaScript-facing half of `src/stream_base.cc` and `src/connection_wrap.cc` are shared by
 * its TCPWrap, PipeWrap and TTYWrap (Node v24.21.0). The handle is a uv_handle_t in the process's memory (`handle_wrap.ts`,
 * native/node); a read, a write, a shutdown, a listen and an accept are libuv's calls through native/node's glue, and
 * their order, their buffering, half-close, end of stream, ref and unref and close are libuv's.
 *
 * What is the binding's here is what Node's C++ object decides: the bytes a read hands `onread` (a copy, as Node's
 * managed buffer is released into an ArrayBuffer) and the program's own buffer when it gave one (`useUserBuffer`),
 * the handle an IPC read carries (AcceptHandle: a wrap of the pending handle's type, accepted, as `pendingHandle`),
 * the client a connection makes (ConnectionWrap::OnConnection), the streamBaseState slots a write fills, and each
 * request's `oncomplete`. A realm with no libuv makes no kernel stream: its handles are the engine's pairing
 * (`stream_wrap.ts`).
 */
import { LibuvStreamWrap, type WriteWrap, type ShutdownWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset, kBytesWritten, kLastWriteWasAsync } from './stream_wrap';
import { invokeOwned, observeNodeRequest, ownedRun, ownerOfInstance, type OwnedHandle } from './handles';
import { uvConstant } from './uv';
import { fromMemory, intoMemory, nodeProgram, programForm, type HandleCallbacks } from './program';
import { HandleWrap, completeRequest } from './handle_wrap';

/** libuv's `uv__handle_fd`: the kernel descriptor a handle is, -1 while it has none. */
export const kHandleFd = Symbol('uv__handle_fd');
/** Whether the handle is libuv's (the realm's process is `node` on libuv's loop). */
export const kKernelBacked = Symbol('kernelBacked');
/** HandleWrap::GetHandle: the wrap's address in the process's memory, 0 once it is closed. */
export const kUvWrap = Symbol('uvWrap');

/** The handle types an IPC pipe carries, by GetUVHandleTypeCode (native/node handle_wrap.c). */
type CarriedType = 'TCP' | 'UDP' | 'PIPE';
const CARRIED: Record<number, CarriedType> = { 0: 'TCP', 2: 'UDP', 4: 'PIPE' };

/** What a carried handle becomes: a wrap of its type (WrapType::Instantiate). */
export interface KernelHandle extends OwnedHandle {
  readonly [kUvWrap]: number;
}
const kernelHandles: Partial<Record<CarriedType, () => KernelHandle>> = {};

/** Each binding names the wrap a handle of its type becomes, after its class is defined. */
export function registerKernelHandle(type: CarriedType, make: () => KernelHandle): void {
  kernelHandles[type] = make;
}

/** Whether the realm's process is libuv's: its handles are made over its loop. */
export function realmHasLibuv(): boolean { return programForm('a handle\'s libuv'); }

export class KernelStreamWrap extends LibuvStreamWrap implements HandleCallbacks {
  readonly #kernel: boolean;
  #uv: HandleWrap | undefined;

  /**
   * `kernel`: the handle is libuv's (else the engine's pairing serves it); `pairingActive`: whether a pairing's
   * handle holds its run's loop from its start (a TCP of a realm with no libuv does nothing and holds nothing).
   */
  constructor(kernel: boolean, pairingActive = true) {
    super(pairingActive, kernel);
    this.#kernel = kernel;
    if (!kernel) return;
    // StreamBase's `fd` and LibuvStreamWrap's `writeQueueSize` accessors (stream_base.cc:607-622, stream_wrap.cc:272).
    Object.defineProperty(this, 'fd', { configurable: true, enumerable: true, get: () => {
      const handle = this.#uv;
      if (!handle?.alive) return uvConstant('UV_EINVAL');
      const fd = handle.fileno();
      return fd >= 0 ? fd : -1;
    } });
    Object.defineProperty(this, 'writeQueueSize', { configurable: true, enumerable: true, get: () => {
      const handle = this.#uv;
      return handle?.alive ? nodeProgram().exports.tabnode_stream_write_queue_size(handle.wrap) : 0;
    } });
  }

  /** The handle at `handle` (uv_tcp_init's, uv_pipe_init's, or a TTY's before its uv_tty_init), the stream's HandleWrap. */
  protected attachUv(handle: number, initialized: boolean): HandleWrap {
    this.#uv = new HandleWrap(this, this, handle, initialized);
    return this.#uv;
  }

  /** The libuv handle, where the stream is libuv's. */
  protected get uvHandle(): HandleWrap | undefined { return this.#uv; }

  get [kKernelBacked](): boolean { return this.#kernel; }

  get [kHandleFd](): number {
    const handle = this.#uv;
    if (!handle?.alive) return -1;
    const fd = handle.fileno();
    return fd >= 0 ? fd : -1;
  }

  get [kUvWrap](): number { return this.#uv?.alive ? this.#uv.wrap : 0; }

  /** LibuvStreamWrap::IsIPCPipe: only an IPC pipe sends and receives handles. */
  protected get isIpc(): boolean { return false; }

  /** The client a connection makes (TCPWrap or PipeWrap Instantiate with SOCKET). */
  protected makeClient(): KernelStreamWrap | undefined { return undefined; }

  /** The stream's libuv handle where it is alive (StreamBase::JSMethod's IsAlive), else undefined. */
  protected liveUv(): HandleWrap | undefined {
    const handle = this.#uv;
    return handle?.alive ? handle : undefined;
  }

  override readStart(): number {
    if (!this.#kernel) return super.readStart();
    const handle = this.liveUv();
    return handle ? nodeProgram().exports.tabnode_stream_read_start(handle.wrap) : uvConstant('UV_EINVAL');
  }

  override readStop(): number {
    if (!this.#kernel) return super.readStop();
    const handle = this.liveUv();
    return handle ? nodeProgram().exports.tabnode_stream_read_stop(handle.wrap) : uvConstant('UV_EINVAL');
  }

  /** StreamBase::UseUserBuffer: reads land in `buffer`, at most its length at a time. */
  override useUserBuffer(buffer: Uint8Array): void {
    if (!this.#kernel) { super.useUserBuffer(buffer); return; }
    const handle = this.liveUv();
    if (!handle) return;
    this.userBuffer = buffer;
    nodeProgram().exports.tabnode_stream_use_buffer(handle.wrap, buffer.byteLength);
  }

  /** LibuvStreamWrap::SetBlocking. */
  setBlocking(enable: unknown): number {
    const handle = this.liveUv();
    if (!this.#kernel || !handle) return uvConstant('UV_EINVAL');
    return nodeProgram().exports.tabnode_stream_set_blocking(handle.wrap, enable === true ? 1 : 0);
  }

  /** StreamBase::Shutdown over LibuvStreamWrap::DoShutdown; AfterUvShutdown reports to `oncomplete`. */
  override shutdown(req: ShutdownWrap): number {
    if (!this.#kernel) return super.shutdown(req);
    const handle = this.liveUv();
    if (!handle) return uvConstant('UV_EINVAL');
    const id = handle.dispatch((status) => completeRequest(req, status, this, undefined));
    const err = nodeProgram().exports.tabnode_stream_shutdown(handle.wrap, id);
    if (err) handle.undispatch(id);
    else observeNodeRequest(req, this);
    return err;
  }

  /**
   * StreamBase::WriteBuffer, Writev and WriteString over StreamBase::Write: the bytes (in the process's memory, as
   * Node's backing store holds them) tried at once and the rest uv_write2'd, an IPC pipe's carried handle with them
   * (`req.handle`, so it lives until AfterUvWrite); streamBaseState says the size and whether it is asynchronous.
   */
  protected override dispatchWrite(req: WriteWrap, buffer: Uint8Array, handle?: unknown): number {
    if (!this.#kernel) return super.dispatchWrite(req, buffer, handle);
    const own = this.liveUv();
    if (!own) return uvConstant('UV_EINVAL');
    let send = 0;
    if (handle !== null && typeof handle === 'object' && this.isIpc) {
      send = (handle as { [kUvWrap]?: number })[kUvWrap] ?? 0;
      if (!send) return uvConstant('UV_EINVAL');
      (req as unknown as { handle: unknown }).handle = handle;
    }
    const length = buffer.byteLength;
    this.bytesWritten += length;
    const bytes = intoMemory(buffer);
    const id = own.dispatch((status) => completeRequest(req, status, this, undefined));
    const answer = nodeProgram().exports.tabnode_stream_write(own.wrap, id, bytes, length, send);
    if (answer === 1) observeNodeRequest(req, this);
    else own.undispatch(id);
    streamBaseState[kBytesWritten] = length;
    streamBaseState[kLastWriteWasAsync] = answer === 1 ? 1 : 0;
    return answer < 0 ? answer : 0;
  }

  override ref(): void { if (this.#kernel) this.#uv?.ref(); else super.ref(); }
  override unref(): void { if (this.#kernel) this.#uv?.unref(); else super.unref(); }
  override hasRef(): boolean { return this.#kernel ? this.#uv?.hasRef() === true : super.hasRef(); }

  /** HandleWrap::Close. */
  override close(callback?: () => void): void {
    if (!this.#kernel) { super.close(callback); return; }
    const handle = this.#uv;
    if (!handle?.alive || handle.closing) return;
    this.closed = true;
    handle.close(callback);
  }

  /** HandleWrap::OnClose's own part: what a TCP or a Pipe gives up beyond the stream. */
  onUvClose(): void { this.onCloseHandle(); }

  /**
   * LibuvStreamWrap::OnUvRead, then EmitRead to EmitToJSStreamListener or CustomBufferJSListener: on an IPC pipe, a
   * read that brought a handle first makes it this process's (`pendingHandle`); then the bytes to `onread`.
   */
  onUvRead(nread: number, base: number): void {
    const handle = this.#uv;
    if (!handle?.alive) return;
    if (this.isIpc && nread > 0) {
      const type = CARRIED[nodeProgram().exports.tabnode_pipe_pending_type(handle.wrap)];
      const make = type === undefined ? undefined : kernelHandles[type];
      if (make) {
        const carried = this.#instantiate(make);
        // AcceptHandle aborts where uv_accept of a handle the pipe holds fails.
        if (nodeProgram().exports.tabnode_stream_accept(handle.wrap, carried[kUvWrap]) !== 0) throw new Error('uv_accept of a carried handle failed');
        this.pendingHandle = carried;
      }
    }
    if (nread > 0) this.bytesRead += nread;
    const target = this.userBuffer;
    if (target) {
      if (base === 0 && nread < 0) { this.#emit(nread, undefined); return; }
      if (nread > 0) target.set(new Uint8Array(fromMemory(base, nread)));
      const next = this.#emit(nread, undefined);
      if (next instanceof Uint8Array) {
        this.userBuffer = next;
        if (handle.alive) nodeProgram().exports.tabnode_stream_use_buffer(handle.wrap, next.byteLength);
      }
      return;
    }
    if (nread < 0) { this.#emit(nread, undefined); return; }
    if (nread === 0) return;
    this.#emit(nread, fromMemory(base, nread));
  }

  /** StreamBase::CallJSOnreadMethod: the read's status and offset in streamBaseState, `onread` with the bytes. */
  #emit(nread: number, bytes: ArrayBuffer | undefined): unknown {
    streamBaseState[kReadBytesOrError] = nread;
    streamBaseState[kArrayBufferOffset] = 0;
    return invokeOwned(this, 'onread', bytes);
  }

  /** WrapType::Instantiate in this wrap's run. */
  #instantiate<T>(make: () => T): T {
    return ownedRun(ownerOfInstance(this), make) as T;
  }

  /**
   * ConnectionWrap::OnConnection: a client wrap made and accepted, then `onconnection(status, client)`; one uv_accept
   * refuses (a connection already gone) is given back, as Node's unreferenced wrap is collected and closed.
   */
  onUvConnection(status: number): void {
    const handle = this.#uv;
    if (!handle?.alive) return;
    let client: KernelStreamWrap | undefined;
    if (status === 0) {
      const made = this.#instantiate(() => this.makeClient());
      if (!made) return;
      if (nodeProgram().exports.tabnode_stream_accept(handle.wrap, made[kUvWrap]) !== 0) { made.close(); return; }
      client = made;
    }
    invokeOwned(this, 'onconnection', status, client);
  }

  /** ConnectionWrap::AfterConnect: `oncomplete(status, handle, req, readable, writable)`. */
  protected connectDone(req: object): (status: number, readable?: number, writable?: number) => void {
    return (status, readable = 0, writable = 0) => completeRequest(req, status, this, req, readable !== 0, writable !== 0);
  }
}
