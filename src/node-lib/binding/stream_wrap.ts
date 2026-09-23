/**
 * `internalBinding('stream_wrap')`: the libuv stream surface, and nothing above it.
 *
 * `internal/stream_base_commons.js` is Node's own and is vendored unmodified;
 * it writes through `handle.writeBuffer(req, buf)` and its string cousins and
 * reads through `handle.onread(arrayBuffer)` with the byte count in
 * `streamBaseState[kReadBytesOrError]`. That is the whole contract, and this
 * file implements exactly it over the engine's loopback pairing: two handles
 * whose writes are each other's reads.
 *
 * Nothing here implements anything Node's files implement. There is no
 * buffering policy, no half-open rule, no timeout: those are `net.js`'s, and
 * `net.js` is vendored.
 */
import { bytesOfString } from './buffer';
import { UV_EOF, UV_EBADF, UV_ECONNRESET, UV_EPIPE } from './uv';

/**
 * The bytes this view names. Node's `Buffer.from` of a short string is a
 * window on an 8 KB pool (`Buffer.poolSize`); taking `view.buffer` without
 * `byteOffset` / `byteLength` carries the neighbours that sit beside it.
 */
function ownedBytes(view: Uint8Array): Uint8Array {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy;
}
import {
  registerHandle, refHandle, unrefHandle, handleHasRef, releaseHandle, stopHandle,
  type OwnedHandle,
} from './handles';

/** The four slots libuv's `StreamBase` reports a read or a write through. */
export const kReadBytesOrError = 0;
export const kArrayBufferOffset = 1;
export const kBytesWritten = 2;
export const kLastWriteWasAsync = 3;
export const streamBaseState = new Int32Array(4);

/** Node's `WriteWrap`: the request `writeGeneric` fills and hands to a write. */
export class WriteWrap {
  handle: LibuvStreamWrap | null = null;
  oncomplete: ((status: number) => void) | null = null;
  async = false;
  bytes = 0;
  buffer: unknown = null;
  callback: unknown = null;
  error: unknown = undefined;
  _chunks: unknown = null;
}

/** Node's `ShutdownWrap`: the request a `_final` hands to `shutdown`. */
export class ShutdownWrap {
  handle: LibuvStreamWrap | null = null;
  oncomplete: ((status: number) => void) | null = null;
  callback: (() => void) | null = null;
}

let nextAsyncId = 1;

/**
 * The bytes one direction of a pairing is carrying, oldest first, and the
 * handle a write of them carried. A descriptor crosses an IPC channel beside
 * the bytes of the message it belongs to and is read out of the receiver just
 * before those bytes reach it, which is the order `setupChannel` in Node's
 * `internal/child_process.js` reads them in.
 */
interface Inbound {
  bytes: Uint8Array;
  handle?: unknown;
}

/** The connection end shared by duplicated native descriptors, not a JS socket. */
class StreamEndpoint {
  readonly handles = new Set<LibuvStreamWrap>();
  peer: StreamEndpoint | null = null;
  inbound: Inbound[] = [];
  eof = false;
  error: number | null = null;
  writeEnded = false;
  flushScheduled = false;
  readonly finalizers: Array<() => void> = [];

  constructor(handle: LibuvStreamWrap) { this.handles.add(handle); }
}

/**
 * The base every `TCP` and `Pipe` extends, as `LibuvStreamWrap` is the base of
 * libuv's `uv_stream_t` wrappers.
 *
 * A pairing joins two connection endpoints. Duplicated wrappers reference the
 * same endpoint and consume its bytes once. A write queues a copy at the peer;
 * reads are delivered on its own turn while a wrapper is reading, which is
 * what `readStart` and `readStop` mean.
 */
export class LibuvStreamWrap implements OwnedHandle {
  /** Set by `net.js` to `onStreamRead`; the only way bytes reach a stream. */
  onread: ((arrayBuffer: ArrayBuffer | null) => unknown) | null = null;
  /** `net.js` owns this flag; `readStart`/`readStop` follow it. */
  reading = false;
  bytesRead = 0;
  bytesWritten = 0;
  /** Nothing is ever queued: a write is taken whole by the peer. */
  writeQueueSize = 0;
  /** The engine has no descriptors for a paired handle, as libuv reports -1 for one it has no fd for. */
  fd = -1;

  private streamEndpoint = new StreamEndpoint(this);
  /** A live wrapper on the other end, including after the original was closed. */
  get peer(): LibuvStreamWrap | null {
    return this.streamEndpoint.peer?.handles.values().next().value ?? null;
  }
  /** True once `close()` has been called; a closed handle carries nothing. */
  closed = false;
  /**
   * The handle the read now being delivered carried, which `setupChannel`
   * takes off the channel at the top of its `onread`. libuv keeps the same
   * thing in a pipe's pending-handle queue.
   */
  pendingHandle: unknown = null;

  protected get inbound(): Inbound[] { return this.streamEndpoint.inbound; }
  protected get inboundEof(): boolean { return this.streamEndpoint.eof; }
  protected get inboundError(): number | null { return this.streamEndpoint.error; }
  protected eofDelivered = false;
  protected userBuffer: Uint8Array | null = null;
  protected readonly asyncId = nextAsyncId++;

  constructor() {
    registerHandle(this);
  }

  getAsyncId(): number {
    return this.asyncId;
  }

  ref(): void {
    refHandle(this);
  }

  unref(): void {
    unrefHandle(this);
  }

  hasRef(): boolean {
    return handleHasRef(this);
  }

  readStart(): number {
    if (this.closed) return UV_EBADF;
    this.reading = true;
    this.flushInbound();
    return 0;
  }

  readStop(): number {
    this.reading = false;
    return 0;
  }

  /** Node's `onread` option: reads land in the program's own buffer. */
  useUserBuffer(buffer: Uint8Array): void {
    this.userBuffer = buffer;
  }

  /**
   * libuv's `uv_shutdown`: this end says it will write no more, and the peer
   * reads EOF. The request completes on its own turn, as libuv's does.
   */
  shutdown(req: ShutdownWrap): number {
    if (this.closed) return UV_EBADF;
    this.sendEof();
    queueMicrotask(() => { req.oncomplete?.(0); });
    return 0;
  }

  writeBuffer(req: WriteWrap, buffer: Uint8Array): number {
    return this.dispatchWrite(req, buffer);
  }

  writev(req: WriteWrap, chunks: unknown[], allBuffers: boolean): number {
    const parts: Uint8Array[] = [];
    if (allBuffers) {
      for (const chunk of chunks) parts.push(chunk as Uint8Array);
    } else {
      for (let index = 0; index < chunks.length; index += 2) {
        const chunk = chunks[index];
        const encoding = chunks[index + 1] as string;
        parts.push(typeof chunk === 'string' ? bytesOfString(chunk, encoding) : (chunk as Uint8Array));
      }
    }
    let total = 0;
    for (const part of parts) total += part.byteLength;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      joined.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at);
      at += part.byteLength;
    }
    return this.dispatchWrite(req, joined);
  }

  writeUtf8String(req: WriteWrap, text: string, handle?: unknown): number {
    return this.dispatchWrite(req, bytesOfString(text, 'utf8'), handle);
  }

  writeAsciiString(req: WriteWrap, text: string): number {
    return this.dispatchWrite(req, bytesOfString(text, 'ascii'));
  }

  writeLatin1String(req: WriteWrap, text: string): number {
    return this.dispatchWrite(req, bytesOfString(text, 'latin1'));
  }

  writeUcs2String(req: WriteWrap, text: string): number {
    return this.dispatchWrite(req, bytesOfString(text, 'ucs2'));
  }

  /**
   * libuv's `uv_close`. The peer reads EOF when the last descriptor closes;
   * the callback runs on its own turn, because `net.js` emits
   * `close` from it and Node emits that after the turn that destroyed.
   */
  close(callback?: () => void): void {
    if (!this.closed) {
      this.closed = true;
      releaseHandle(this);
      const endpoint = this.streamEndpoint;
      endpoint.handles.delete(this);
      // Writes land in the peer's inbound queue at once; flushing here
      // delivers those bytes and then EOF, in that order, on this turn. A
      // child's setupChannel then disconnects (`connected` false) before the
      // next `process.send`, so that send is ERR_IPC_CHANNEL_CLOSED rather
      // than a write on a handle a later release would close (`write EBADF`).
      // Closing one descriptor must not end a connection another process
      // still holds (`send(socket, { keepOpen: true })` is one such case).
      if (endpoint.handles.size === 0) {
        const peer = endpoint.peer;
        endpoint.peer = null;
        if (peer) {
          peer.peer = null;
          peer.eof = true;
          for (const handle of peer.handles) handle.flushInbound();
        }
        for (const finalize of endpoint.finalizers.splice(0)) finalize();
        endpoint.inbound.length = 0;
      }
      this.onCloseHandle();
    }
    // Node schedules a destroy(error)'s error on nextTick after close() returns.
    // The native close completion comes afterward. One microtask here ran the
    // close listener first, so ClientRequest replaced the actual policy denial
    // with ECONNRESET ("socket hang up"). Leave that tick ahead of completion.
    if (callback) queueMicrotask(() => queueMicrotask(callback));
  }

  /** What a `TCP` or a `Pipe` gives up beyond the stream: a port, a path. */
  protected onCloseHandle(): void {}

  /**
   * libuv's `dup()`: a second handle on the same connection.
   *
   * A descriptor sent over IPC arrives in the receiver as a NEW descriptor
   * referring to the same socket, which is what `SCM_RIGHTS` gives it, and
   * Node's own `child_process.js` counts on exactly that: on the receiver's
   * `NODE_HANDLE_ACK` the sender CLOSES the handle it sent. With one handle
   * for both, that close ended the connection the child had just been given
   * and its first write was `EBADF`.
   *
   * Both descriptors share the connection and its unread bytes. Node may
   * close the sender on acknowledgement or keep it open; the binding must
   * support either, without knowing the child_process option that chose it.
   */
  duplicate(): LibuvStreamWrap {
    const copy = new LibuvStreamWrap();
    copy.shareConnectionFrom(this);
    return copy;
  }

  /** Two handles become each other's peer; what one writes the other reads. */
  static pair(a: LibuvStreamWrap, b: LibuvStreamWrap): void {
    a.streamEndpoint.peer = b.streamEndpoint;
    b.streamEndpoint.peer = a.streamEndpoint;
  }

  /** A fresh wrapper acquires a descriptor reference on this connection. */
  protected shareConnectionFrom(other: LibuvStreamWrap): void {
    this.streamEndpoint.handles.delete(this);
    this.streamEndpoint = other.streamEndpoint;
    this.streamEndpoint.handles.add(this);
  }

  /** Native connection resources outlive individual duplicated wrappers. */
  protected onLastReferenceClose(callback: () => void): void {
    this.streamEndpoint.finalizers.push(callback);
  }

  /**
   * Take over another handle's end of a pairing, with everything that arrived
   * on it while nobody was holding it. This is what opening a descriptor is
   * here: a forked child's channel is opened by the child after its parent has
   * already written to it -- `fork(…)` and `send(…)` are one synchronous turn
   * in every program that does it -- and the bytes waiting at that descriptor
   * are the child's. A pairing whose bytes stayed behind left the child
   * waiting for a message its parent had already sent.
   */
  takeOverFrom(other: LibuvStreamWrap): void {
    if (other === this) return;
    this.shareConnectionFrom(other);
    this.streamEndpoint.handles.delete(other);
    other.streamEndpoint = new StreamEndpoint(other);
    this.flushInbound();
  }

  /**
   * A write: the bytes are copied (the caller may reuse its buffer) and put in
   * the peer's queue at once, where anything the writer does afterwards lands
   * behind them. Delivery is still the peer's own turn, because libuv never
   * delivers a read inside the write that caused it. It completes
   * synchronously — `kBytesWritten` set, `kLastWriteWasAsync` 0 — because the
   * engine's writes are taken whole and there is no queue for a `drain` to
   * empty.
   *
   * Handing the bytes over on a microtask instead put them BEHIND an end
   * announced from the same turn: `stdin.write('hello'); stdin.end()` is one
   * synchronous block in every program that does it, the peer read EOF first
   * and the bytes were dropped after it, and `spawn('cat')` fed that way
   * produced nothing.
   */
  protected dispatchWrite(req: WriteWrap, buffer: Uint8Array, handle?: unknown): number {
    void req;
    const length = buffer.byteLength;
    streamBaseState[kBytesWritten] = length;
    streamBaseState[kLastWriteWasAsync] = 0;
    if (this.closed) return UV_EBADF;
    if (this.streamEndpoint.writeEnded) return UV_EPIPE;
    this.bytesWritten += length;
    const peer = this.peer;
    if (!peer || peer.closed) return 0;
    if (length === 0) return 0;
    peer.receive(ownedBytes(buffer), handle);
    return 0;
  }

  /**
   * The peer will write no more; this end reads EOF once it has read the rest.
   * Announced on a microtask of its own, so it lands behind the writes that
   * were handed over before it: `stdin.write('hello'); stdin.end()` is one
   * turn in every program, and an EOF announced from inside `end` reached the
   * reader first and the bytes never reached it at all.
   */
  protected sendEof(): void {
    this.streamEndpoint.writeEnded = true;
    const peer = this.peer;
    if (peer) peer.receiveEof();
  }

  /**
   * libuv's close-with-reset: the peer's next read is `ECONNRESET`, not EOF,
   * which is how `socket.resetAndDestroy()` differs from `socket.destroy()`.
   */
  protected sendReset(): void {
    this.streamEndpoint.writeEnded = true;
    const peer = this.peer;
    if (peer) peer.receiveError(UV_ECONNRESET);
  }

  /** An error arriving on the read side, delivered as libuv delivers one. */
  receiveError(code: number): void {
    if (this.closed) return;
    this.streamEndpoint.error = code;
    this.scheduleFlush();
  }

  /** Bytes arriving from the peer, and the handle their write carried. */
  receive(bytes: Uint8Array, handle?: unknown): void {
    if (this.closed) return;
    this.inbound.push(handle === undefined || handle === null ? { bytes } : { bytes, handle });
    this.scheduleFlush();
  }

  /** The peer is done writing. */
  receiveEof(): void {
    if (this.closed) return;
    this.streamEndpoint.eof = true;
    this.scheduleFlush();
  }

  /**
   * What arrived is recorded the moment it arrives and delivered on a turn of
   * its own, once, however many arrivals that turn holds. This is the order
   * libuv's loop reads in: everything a writer did in one turn is read in the
   * order it did it, and never from inside the call that did it.
   */
  protected scheduleFlush(): void {
    const endpoint = this.streamEndpoint;
    if (endpoint.flushScheduled) return;
    endpoint.flushScheduled = true;
    queueMicrotask(() => {
      endpoint.flushScheduled = false;
      for (const handle of endpoint.handles) handle.flushInbound();
    });
  }

  /**
   * Hand what has arrived to `onStreamRead`, in libuv's shape: the byte count
   * in `streamBaseState[kReadBytesOrError]`, the offset beside it, the
   * `ArrayBuffer` as the argument. A reader that pushes back calls `readStop`
   * from inside `onread`, so the loop re-reads `reading` every time.
   */
  protected flushInbound(): void {
    while (this.reading && !this.closed && this.inbound.length > 0) {
      const next = this.inbound.shift() as Inbound;
      const bytes = next.bytes;
      // The handle is on the channel before the bytes it belongs to reach the
      // reader, which is where `setupChannel` takes it off.
      if (next.handle !== undefined) this.pendingHandle = next.handle;
      this.bytesRead += bytes.byteLength;
      const target = this.userBuffer;
      if (target) {
        // `net.Socket({ onread })`: the bytes land in the program's buffer and
        // `onStreamRead` hands the count to its callback.
        const taken = Math.min(target.byteLength, bytes.byteLength);
        target.set(bytes.subarray(0, taken));
        if (taken < bytes.byteLength) this.inbound.unshift({ bytes: bytes.subarray(taken) });
        streamBaseState[kReadBytesOrError] = taken;
        streamBaseState[kArrayBufferOffset] = 0;
        this.onread?.(null);
        continue;
      }
      streamBaseState[kReadBytesOrError] = bytes.byteLength;
      streamBaseState[kArrayBufferOffset] = bytes.byteOffset;
      this.onread?.(bytes.buffer as ArrayBuffer);
    }
    if (this.reading && !this.closed && this.inbound.length === 0 && !this.eofDelivered &&
        (this.inboundError !== null || this.inboundEof)) {
      this.eofDelivered = true;
      // libuv stops a stream when it reads EOF, and a stopped handle does not
      // hold the loop: a socket whose peer has gone is not work, however much
      // unread data is still in its buffer.
      stopHandle(this);
      streamBaseState[kReadBytesOrError] = this.inboundError ?? UV_EOF;
      streamBaseState[kArrayBufferOffset] = 0;
      this.onread?.(null);
    }
  }
}

export default {
  LibuvStreamWrap,
  WriteWrap,
  ShutdownWrap,
  streamBaseState,
  kReadBytesOrError,
  kArrayBufferOffset,
  kBytesWritten,
  kLastWriteWasAsync,
};
