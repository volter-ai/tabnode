/**
 * libuv's `uv_stream_t` over a kernel descriptor (ADR-0009): what `tcp_wrap`'s TCP and a kernel AF_UNIX
 * `pipe_wrap` Pipe share, as libuv's `tcp.c` and `pipe.c` share `stream.c`. Read in Node v24.21.0's
 * `deps/uv/src/unix/stream.c` and `src/stream_wrap.cc`:
 *
 * - a read is up to 64 KiB, at most 32 per readiness, stopping at a short one; 0 is EOF; an error is the read's status;
 * - a write is tried at once (`uv_try_write`) and completes synchronously when it is taken whole, else is queued for
 *   the socket's writability; `shutdown` follows the queued writes; `close` cancels what is pending with `ECANCELED`
 *   before its callback;
 * - an IPC pipe reads with `recvmsg` (`MSG_CMSG_CLOEXEC`), and each descriptor an `SCM_RIGHTS` record brings is now
 *   one of this process's (the kernel installed it, `scm_detach_fds`), queued (`queued_fds`) and handed to the next
 *   read's callback as the handle its type makes (`OnUvRead`, `uv_pipe_pending_type`, `uv_accept`); a write that
 *   sends a handle (`uv_write2`) is a `sendmsg` whose first bytes carry the handle's descriptor.
 *
 * A handle that is not a kernel descriptor's (a pipe of a process whose tree offers no socket calls) is the engine's
 * pairing, `stream_wrap.ts`.
 */
import { queueBindingTask } from '../../guest-loop';
import { LibuvStreamWrap, type WriteWrap, type ShutdownWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset, kBytesWritten, kLastWriteWasAsync } from './stream_wrap';
import { __adoptHandle, holdRequest, ownerOf, invokeOwned, observeNodeRequest, forgetNodeRequest, startHandle, stopHandle, type OwnedHandle } from './handles';
import { UV_EBADF, UV_EBUSY, UV_ECANCELED, UV_EINVAL, UV_ENOTCONN, UV_EOF, UV_EPIPE } from './uv';
import { callingSockets, captureCallingSockets, linux, receivedRights, rightsControl, rightsSpace, type TreeSockets } from '../../host-sockets';
import { kernelSocketType, type HandleType } from './fds';

/** libuv's `uv__handle_fd`: the kernel descriptor a handle is, -1 while it has none. */
export const kHandleFd = Symbol('uv__handle_fd');

/** What a received descriptor becomes: a handle of its type, opened on it (`uv_accept`'s `uv__stream_open`, `uv_udp_open`). */
interface KernelHandle extends OwnedHandle {
  open(fd: number): number;
  readonly [kHandleFd]: number;
}
const kernelHandles: Partial<Record<HandleType, () => KernelHandle>> = {};

/** Each binding names the handle a descriptor of its type becomes, after its class is defined. */
export function registerKernelHandle(type: 'TCP' | 'UDP' | 'PIPE', make: () => KernelHandle): void {
  kernelHandles[type] = make;
}

/** uv__read's buffer (`alloc_cb`'s suggested size) and its reads per readiness. */
const READ_BYTES = 64 * 1024;
const READS_PER_READINESS = 32;
/** uv__write's writes per readiness. */
const WRITES_PER_READINESS = 32;
/** UV__CMSG_FD_COUNT: the descriptors one IPC read has room for. */
const CMSG_FD_COUNT = 64;

/** A queued write; `fd` the descriptor it sends (`req->send_handle`) until its first bytes are taken. */
interface QueuedWrite { request: WriteWrap; bytes: Uint8Array; sent: number; fd: number | undefined; release: () => void }

export class KernelStreamWrap extends LibuvStreamWrap {
  readonly #kernel: boolean;
  /** The socket calls of the process that made the handle, which it keeps. */
  #sockets: TreeSockets | undefined;
  /** The calling process the handle was made in: a descriptor it receives becomes a handle there. */
  readonly #calling: (<T>(continuation: () => T) => T) | undefined;
  /** The descriptor (libuv's `io_watcher.fd`), -1 until it is made or opened. */
  #fd = -1;
  #readable = false;
  #writable = false;
  /** UV_HANDLE_READING. */
  #reading = false;
  /** UV_HANDLE_SHUT: the write side was shut down. */
  #shut = false;
  #writes: QueuedWrite[] = [];
  #shutdown: { request: ShutdownWrap; release: () => void } | null = null;
  /** The readiness questions this handle has asked and not yet had answered. */
  #waitingIn = false;
  #waitingOut = false;
  /** uv__read's buffer, reused: what a read delivers is copied out at its length. */
  #scratch: Uint8Array | null = null;
  /** An IPC read's control room. */
  #control: Uint8Array | null = null;
  /** libuv's `queued_fds`: descriptors received and not yet handed to a read's callback. */
  #received: number[] = [];

  /** `kernel`: the handle is a kernel descriptor of the calling process's (else the engine's pairing serves it). */
  constructor(kernel: boolean) {
    // uv_tcp_init and uv_pipe_init leave a kernel stream stopped; the engine's pairing holds its loop from its start.
    super(!kernel);
    this.#kernel = kernel;
    this.#sockets = kernel ? callingSockets() : undefined;
    this.#calling = kernel ? captureCallingSockets() : undefined;
  }

  /** Whether the handle is a kernel descriptor's. */
  get kernelBacked(): boolean { return this.#kernel; }

  get [kHandleFd](): number { return this.#kernel ? this.#fd : -1; }

  protected get sockets(): TreeSockets | undefined { return this.#sockets; }
  protected get descriptor(): number { return this.#fd; }

  /** The handle's descriptor is `fd`, of `sockets`' process. */
  protected setDescriptor(fd: number, sockets: TreeSockets | undefined = this.#sockets): void {
    this.#sockets = sockets;
    this.#fd = fd;
    this.fd = fd;
  }

  /** UV_HANDLE_READABLE and UV_HANDLE_WRITABLE. */
  protected setOpen(readable: boolean, writable: boolean): void {
    this.#readable = readable;
    this.#writable = writable;
  }

  /** uv_tcp_open, uv_pipe_open: a descriptor of this process's, made non-blocking, readable and writable. */
  protected openDescriptor(fd: number): number {
    const sockets = this.#sockets;
    if (!sockets) return UV_EBADF;
    if (this.#fd >= 0 && this.#fd !== fd) return UV_EBUSY;
    const flags = sockets.fcntl(fd, linux.F_GETFL, 0);
    if (flags < 0) return flags;
    const set = sockets.fcntl(fd, linux.F_SETFL, flags | linux.O_NONBLOCK);
    if (set < 0) return set;
    this.setDescriptor(fd);
    this.setOpen(true, true);
    return 0;
  }

  /**
   * uv_spawn's `UV_CREATE_PIPE` for a child's channel: `uv_socketpair(SOCK_STREAM)`, close-on-exec, this handle one end
   * and `child`'s the other, each made non-blocking.
   */
  socketpair(child: KernelStreamWrap): number {
    const sockets = this.#sockets;
    if (!sockets || !child.#kernel) return UV_EINVAL;
    const pair = new Int32Array(2);
    const made = sockets.socketpair(linux.AF_UNIX, linux.SOCK_STREAM | linux.SOCK_CLOEXEC, 0, pair);
    if (made < 0) return made;
    let status = this.openDescriptor(pair[0]!);
    if (status === 0) { child.#sockets = sockets; status = child.openDescriptor(pair[1]!); }
    if (status !== 0) {
      if (this.#fd !== pair[0]) sockets.close(pair[0]!);
      if (child.#fd !== pair[1]) sockets.close(pair[1]!);
    }
    return status;
  }

  /** `other`'s descriptor becomes this handle's, as the end a child opens of a channel its parent made in its table. */
  protected takeDescriptorFrom(other: KernelStreamWrap): void {
    this.setDescriptor(other.#fd, other.#sockets);
    this.setOpen(true, true);
    other.#fd = -1;
    other.fd = -1;
    other.close();
  }

  /** The descriptor a write sends with its bytes (`uv_write2`'s `send_handle`): only an IPC pipe sends one. */
  protected descriptorToSend(_handle: unknown): number { return UV_EINVAL; }

  /** Whether reads take descriptors with their bytes: an IPC pipe's. */
  protected get receivesDescriptors(): boolean { return false; }

  /** Whether a shutdown waits for the queued writes. */
  protected get shutdownPending(): boolean { return this.#shutdown !== null; }

  /** Whether queued writes wait (a connect in progress). */
  protected writesHeld(): boolean { return false; }

  override readStart(): number {
    if (!this.#kernel) return super.readStart();
    if (this.closed) return UV_EINVAL;
    if (!this.#readable) return UV_ENOTCONN;
    this.#reading = true;
    this.reading = true;
    // uv_read_start: reading is what a stream does, so it holds its loop while it reads.
    startHandle(this);
    this.waitIn();
    return 0;
  }

  override readStop(): number {
    if (!this.#kernel) return super.readStop();
    this.reading = false;
    if (!this.#reading) return 0;
    // uv_read_stop: polling stops and so does the handle (its requests hold the loop for themselves); a readiness
    // already asked for is answered and left: the bytes stay in the kernel's buffer.
    this.#reading = false;
    stopHandle(this);
    return 0;
  }

  /** The socket's readability, asked once while a read or an accept wants it. */
  protected waitIn(): void {
    const sockets = this.#sockets;
    if (this.#waitingIn || this.#fd < 0 || this.closed || !sockets) return;
    this.#waitingIn = true;
    const fd = this.#fd;
    void sockets.wait(fd, linux.POLLIN).then(() => queueBindingTask(() => {
      this.#waitingIn = false;
      if (this.closed || this.#fd !== fd) return;
      this.onReadable();
    }));
  }

  /** The socket is readable: a reading stream reads. */
  protected onReadable(): void {
    if (this.#reading) this.#read();
  }

  /** uv__read: up to 32 reads of 64 KiB, stopping at a short one, at EOF, at an error or when reading stops. */
  #read(): void {
    for (let count = READS_PER_READINESS; count > 0 && this.#reading && !this.closed; count -= 1) {
      const target = this.userBuffer;
      const buffer = target ?? (this.#scratch ??= new Uint8Array(READ_BYTES));
      let read: number;
      do read = this.#receive(buffer); while (read === -linux.EINTR);
      if (read === -linux.EAGAIN) { this.waitIn(); return; }
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
      this.#takePending();
      streamBaseState[kReadBytesOrError] = read;
      streamBaseState[kArrayBufferOffset] = 0;
      if (target) invokeOwned(this, 'onread', null);
      else invokeOwned(this, 'onread', buffer.slice(0, read).buffer);
      if (read < buffer.byteLength) break;
    }
    if (this.#reading && !this.closed) this.waitIn();
  }

  /** recvfrom(2), or an IPC pipe's recvmsg(2), whose received descriptors join the queue. */
  #receive(buffer: Uint8Array): number {
    const sockets = this.#sockets!;
    if (!this.receivesDescriptors) return sockets.recvfrom(this.#fd, buffer, 0, null);
    const message = { data: buffer, control: this.#control ??= new Uint8Array(rightsSpace(CMSG_FD_COUNT)), controlLength: 0, flags: 0 };
    const read = sockets.recvmsg(this.#fd, message, linux.MSG_CMSG_CLOEXEC);
    if (read >= 0 && message.controlLength > 0) this.#received.push(...receivedRights(message.control, message.controlLength));
    return read;
  }

  /**
   * OnUvRead's pending handle: the next received descriptor, made a handle of this handle's process by its type
   * (uv_guess_handle), counted in this handle's run, as `pendingHandle` for the read's callback. A descriptor of no
   * handle type is closed.
   */
  #takePending(): void {
    const fd = this.#received.shift();
    if (fd === undefined) return;
    const sockets = this.#sockets!;
    const type = kernelSocketType(sockets, fd);
    const make = type === undefined ? undefined : kernelHandles[type];
    if (!make) { sockets.close(fd); return; }
    const handle = this.#calling!(make);
    const status = handle.open(fd);
    if (status !== 0) {
      if (handle[kHandleFd] !== fd) sockets.close(fd);
      handle.close();
      return;
    }
    __adoptHandle(handle, ownerOf(this), this);
    this.pendingHandle = handle;
  }

  #deliverStatus(status: number): void {
    streamBaseState[kReadBytesOrError] = status;
    streamBaseState[kArrayBufferOffset] = 0;
    invokeOwned(this, 'onread', null);
  }

  /** send(2), never raising SIGPIPE (Node ignores it), so a closed peer is EPIPE; with `fd`, a sendmsg carrying it. */
  #send(bytes: Uint8Array, fd: number | undefined): number {
    const sockets = this.#sockets!;
    const flags = linux.MSG_NOSIGNAL | linux.MSG_DONTWAIT;
    let sent: number;
    do {
      sent = fd === undefined ? sockets.sendto(this.#fd, bytes, flags, null)
        : sockets.sendmsg(this.#fd, { data: bytes, control: rightsControl([fd]) }, flags);
    } while (sent === -linux.EINTR);
    return sent;
  }

  /**
   * StreamBase::Write: tried at once (`uv_try_write`), complete and synchronous when taken whole; what remains is
   * queued and sent as the socket can take it, completed through the request. A write that sends a handle is
   * `uv_write2`: queued, and written at once where nothing is ahead of it.
   */
  protected override dispatchWrite(req: WriteWrap, buffer: Uint8Array, handle?: unknown): number {
    if (!this.#kernel) return super.dispatchWrite(req, buffer, handle);
    streamBaseState[kBytesWritten] = buffer.byteLength;
    streamBaseState[kLastWriteWasAsync] = 0;
    req.async = false;
    let fd: number | undefined;
    if (handle !== undefined && handle !== null) {
      fd = this.descriptorToSend(handle);
      if (fd < 0) return fd;
    }
    if (this.closed) return UV_EBADF;
    if (!this.#writable || this.#fd < 0) return UV_EPIPE;
    const idle = this.#writes.length === 0 && !this.writesHeld();
    let sent = 0;
    if (idle && fd === undefined) {
      const taken = this.#send(buffer, undefined);
      if (taken < 0 && taken !== -linux.EAGAIN) return taken;
      if (taken > 0) { sent = taken; this.bytesWritten += taken; }
      if (sent === buffer.byteLength) return 0;
    }
    this.#writes.push({ request: req, bytes: buffer, sent, fd, release: holdRequest(this) });
    this.writeQueueSize += buffer.byteLength - sent;
    observeNodeRequest(req, this);
    req.async = true;
    streamBaseState[kLastWriteWasAsync] = 1;
    if (idle && fd !== undefined) this.#flushWrites();
    else if (!this.writesHeld()) this.waitOut();
    return 0;
  }

  /** The socket's writability, asked once while a connect or a queued write wants it. */
  protected waitOut(): void {
    const sockets = this.#sockets;
    if (this.#waitingOut || this.#fd < 0 || this.closed || !sockets) return;
    this.#waitingOut = true;
    const fd = this.#fd;
    void sockets.wait(fd, linux.POLLOUT).then(() => queueBindingTask(() => {
      this.#waitingOut = false;
      if (this.closed || this.#fd !== fd) return;
      this.onWritable();
    }));
  }

  /** The socket is writable: the queue is sent. */
  protected onWritable(): void {
    this.#flushWrites();
  }

  /** uv__write: the queue, in order, as far as the socket takes it; then uv__drain. */
  #flushWrites(): void {
    let count = WRITES_PER_READINESS;
    while (this.#writes.length) {
      const write = this.#writes[0]!;
      const taken = this.#send(write.bytes.subarray(write.sent), write.fd);
      if (taken === -linux.EAGAIN) { this.waitOut(); return; }
      if (taken < 0) { this.#finishWrite(write, taken); return; }
      write.fd = undefined;
      write.sent += taken;
      this.bytesWritten += taken;
      this.writeQueueSize -= taken;
      if (write.sent < write.bytes.byteLength) continue;
      this.#finishWrite(write, 0);
      if (--count <= 0) { this.waitOut(); return; }
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

  /** Every queued write completes with `status` (a failed connect's, a close's ECANCELED). */
  protected cancelWrites(status: number): void {
    for (const write of [...this.#writes]) this.#finishWrite(write, status);
  }

  /** Writes held behind a connect go on once it is made: the queue, or a shutdown with nothing queued. */
  protected resumeWrites(): void {
    if (this.#writes.length) this.waitOut();
    else if (this.#shutdown) this.#drain();
  }

  /** uv_shutdown: the write side ends once the queued writes are sent. */
  override shutdown(req: ShutdownWrap): number {
    if (!this.#kernel) return super.shutdown(req);
    if (!this.#writable || this.#shut || this.#shutdown || this.closed || this.#fd < 0) return UV_ENOTCONN;
    this.#writable = false;
    observeNodeRequest(req, this);
    this.#shutdown = { request: req, release: holdRequest(this) };
    if (this.#writes.length === 0 && !this.writesHeld()) queueBindingTask(() => this.#drain());
    return 0;
  }

  /** uv__drain: the pending shutdown, once nothing is queued. */
  #drain(): void {
    if (!this.#shutdown || this.#writes.length) return;
    // A close cancels a pending shutdown itself, so a drain finds the socket open.
    const shut = this.#sockets!.shutdown(this.#fd, linux.SHUT_WR);
    if (shut >= 0) this.#shut = true;
    this.#finishShutdown(shut < 0 ? shut : 0);
  }

  /** The pending shutdown's request completed with `status`, on its own turn. */
  #finishShutdown(status: number): void {
    const pending = this.#shutdown;
    if (!pending) return;
    this.#shutdown = null;
    queueBindingTask(() => {
      try { invokeOwned(pending.request, 'oncomplete', status); }
      finally { forgetNodeRequest(pending.request); pending.release(); }
    });
  }

  /** uv_close: the descriptor goes now, with any received and not handed on; what was pending is cancelled first. */
  override close(callback?: () => void): void {
    if (this.#kernel && !this.closed) {
      this.cancelWrites(UV_ECANCELED);
      if (this.#shutdown) this.#finishShutdown(UV_ECANCELED);
      this.#reading = false;
      const sockets = this.#sockets;
      for (const fd of this.#received.splice(0)) sockets?.close(fd);
      if (this.#fd >= 0 && sockets) sockets.close(this.#fd);
      this.#fd = -1;
      this.fd = -1;
    }
    super.close(callback);
  }
}
