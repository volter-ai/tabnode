/** Host-owned native handles. Node's JS socket and IPC libraries stay in the guest. */
import { TCP, TCPConnectWrap, type SockName } from './node-lib/binding/tcp_wrap';
import { Pipe, PipeConnectWrap } from './node-lib/binding/pipe_wrap';
import { LibuvStreamWrap, WriteWrap, ShutdownWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset } from './node-lib/binding/stream_wrap';
import { __adoptHandle } from './node-lib/binding/handles';
import { UV_EBADF, UV_ECANCELED, UV_EINVAL, UV_ENOBUFS, UV_ENOTSUP, UV_EPIPE, UV_EMFILE, UV_EBUSY, UV_EALREADY } from './node-lib/binding/uv';

export interface NativeStreamDescriptor { id: number; kind: 'tcp' | 'pipe'; type: number }
export interface NativeStreamLimits {
  maxHandles: number;
  maxReadChunkBytes: number;
  maxQueuedBytes: number;
  /** Per connection, like maxQueuedBytes; includes unread IPC descriptor copies. */
  maxQueuedHandles: number;
  maxPendingWriteBytes: number;
}
export type NativeStreamEvent =
  | { type: 'closed' }
  | { type: 'read'; id: number; status: number; bytes?: Uint8Array; handle?: NativeStreamDescriptor }
  | { type: 'connection'; id: number; status: number; handle?: NativeStreamDescriptor }
  | { type: 'connect' | 'shutdown' | 'close'; id: number; request: number; status: number };
export type NativeStreamOperation =
  | { operation: 'create'; kind: 'tcp' | 'pipe'; type: number }
  | { operation: 'pair'; id: number; peer: number }
  | { operation: 'bind'; id: number; address: string; port?: number; ipv6?: boolean; flags?: number }
  | { operation: 'listen'; id: number; backlog: number }
  | { operation: 'connect'; id: number; request: number; address: string; port?: number; ipv6?: boolean }
  | { operation: 'open'; id: number; fd: number }
  | { operation: 'readStart' | 'readStop' | 'ref' | 'unref' | 'getsockname' | 'getpeername'; id: number }
  | { operation: 'shutdown' | 'close' | 'reset'; id: number; request: number };
export interface NativeStreamReply { status: number; handle?: NativeStreamDescriptor; address?: Partial<SockName> }
export interface NativeStreamTransport {
  readonly limits: Readonly<NativeStreamLimits>;
  call(operation: NativeStreamOperation): NativeStreamReply;
  write(id: number, bytes: Uint8Array, handle?: number): Promise<number>;
  onEvent(listener: (event: NativeStreamEvent) => void): () => void;
}

type NativeHandle = TCP | Pipe;
interface Entry { handle: NativeHandle; descriptor: NativeStreamDescriptor; buffer?: Uint8Array }
const scopes = new WeakMap<LibuvStreamWrap, NativeStreamScope>();

/**
 * One capability namespace per worker. Only the trusted host can inherit a
 * descriptor from another scope; wire operations can name this scope's IDs only.
 */
export class NativeStreamScope {
  private readonly entries = new Map<number, Entry>();
  private readonly descriptors = new Map<number, number>();
  private readonly writes = new Map<number, (status: number) => void>();
  private readonly connects = new Map<number, number>();
  private nextId = 1;
  private pendingWriteBytes = 0;
  private disposed = false;
  private readonly limits: Readonly<NativeStreamLimits>;

  constructor(limits: NativeStreamLimits, private readonly emit: (event: NativeStreamEvent) => void) {
    if ([limits.maxHandles, limits.maxReadChunkBytes, limits.maxQueuedBytes, limits.maxQueuedHandles, limits.maxPendingWriteBytes].some(value => !Number.isSafeInteger(value) || value < 1)
      || limits.maxReadChunkBytes > 0x7fffffff
      || limits.maxReadChunkBytes > limits.maxQueuedBytes
      || limits.maxReadChunkBytes > limits.maxPendingWriteBytes) throw new Error('Invalid native stream resource limits.');
    this.limits = Object.freeze({ ...limits });
  }

  private entry(id: number): Entry | undefined {
    return this.disposed ? undefined : this.entries.get(id);
  }

  private publish(event: NativeStreamEvent): void {
    if (this.disposed) return;
    try { this.emit(event); }
    catch (cause) {
      try { this.dispose(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Native stream event delivery and cleanup failed.'); }
      throw cause;
    }
  }

  private claim(handle: NativeHandle): NativeStreamDescriptor | undefined {
    if (this.disposed || !Number.isSafeInteger(this.nextId) || this.entries.size >= this.limits.maxHandles || scopes.has(handle)) return undefined;
    const descriptor: NativeStreamDescriptor = { id: this.nextId++, kind: handle instanceof TCP ? 'tcp' : 'pipe', type: handle.type };
    const entry: Entry = { handle, descriptor };
    this.entries.set(descriptor.id, entry);
    scopes.set(handle, this);
    // The scope, not the currently executing guest in the owner realm, owns it.
    __adoptHandle(handle, null);
    handle.onconnection = (status: number, accepted: NativeHandle) => {
      const incoming = status === 0 ? this.claim(accepted) : undefined;
      if (status === 0 && !incoming) accepted.close();
      this.publish({ type: 'connection', id: descriptor.id, status: status || (incoming ? 0 : UV_EMFILE), ...(incoming ? { handle: incoming } : {}) });
    };
    handle.onread = buffer => {
      const count = streamBaseState[kReadBytesOrError];
      const offset = streamBaseState[kArrayBufferOffset];
      handle.readStop(); // One read credit; the receiver explicitly replenishes it.
      const sent = handle.pendingHandle;
      handle.pendingHandle = null;
      let incoming: NativeStreamDescriptor | undefined;
      if (sent != null) {
        if ((sent instanceof TCP || sent instanceof Pipe) && !sent.listening) incoming = this.claim(sent);
        if (!incoming) {
          if (sent instanceof LibuvStreamWrap && !scopes.has(sent) && !(sent as NativeHandle).listening) sent.close();
          this.publish({ type: 'read', id: descriptor.id, status: UV_ENOTSUP });
          this.close(descriptor.id);
          return;
        }
      }
      const bytes = count > 0
        ? (buffer ? new Uint8Array(buffer, offset, count) : entry.buffer!.subarray(0, count)).slice()
        : undefined;
      this.publish({ type: 'read', id: descriptor.id, status: count,
        ...(bytes ? { bytes } : {}), ...(incoming ? { handle: incoming } : {}) });
    };
    return { ...descriptor };
  }

  /** Synchronous operations return libuv status; completions use the event door. */
  call(operation: NativeStreamOperation): NativeStreamReply {
    if (this.disposed) return { status: UV_EBADF };
    if (operation.operation === 'create') {
      if (this.entries.size >= this.limits.maxHandles) return { status: UV_EMFILE };
      if ((operation.kind !== 'tcp' && operation.kind !== 'pipe')
        || !Number.isInteger(operation.type) || operation.type < 0 || operation.type > (operation.kind === 'pipe' ? 2 : 1)) return { status: UV_EINVAL };
      const handle = operation.kind === 'tcp' ? new TCP(operation.type) : new Pipe(operation.type);
      const descriptor = this.claim(handle);
      if (!descriptor) { handle.close(); return { status: UV_EMFILE }; }
      return { status: 0, handle: descriptor };
    }
    const entry = this.entry(operation.id);
    if (!entry) return { status: UV_EBADF };
    const handle = entry.handle;
    switch (operation.operation) {
      case 'pair': {
        const other = this.entry(operation.peer)?.handle;
        if (!other || handle.peer || other.peer || handle.listening || other.listening || other === handle) return { status: UV_EINVAL };
        LibuvStreamWrap.pair(handle, other);
        return { status: 0 };
      }
      case 'bind': {
        if (typeof operation.address !== 'string') return { status: UV_EINVAL };
        if (handle instanceof Pipe) return { status: handle.bind(operation.address) };
        if (!Number.isInteger(operation.port) || operation.port! < 0 || operation.port! > 65535) return { status: UV_EINVAL };
        return { status: operation.ipv6 ? handle.bind6(operation.address, operation.port!, operation.flags) : handle.bind(operation.address, operation.port!, operation.flags) };
      }
      case 'listen': return { status: Number.isInteger(operation.backlog) && operation.backlog >= 0 ? handle.listen(operation.backlog) : UV_EINVAL };
      case 'connect': {
        if (this.connects.has(operation.id)) return { status: UV_EALREADY };
        if (typeof operation.address !== 'string' || !Number.isSafeInteger(operation.request) || operation.request < 1) return { status: UV_EINVAL };
        if (handle instanceof TCP && (!Number.isInteger(operation.port) || operation.port! < 1 || operation.port! > 65535)) return { status: UV_EINVAL };
        this.connects.set(operation.id, operation.request);
        const request = handle instanceof TCP ? new TCPConnectWrap() : new PipeConnectWrap();
        request.oncomplete = status => {
          if (this.connects.get(operation.id) !== operation.request) return;
          this.connects.delete(operation.id);
          this.publish({ type: 'connect', id: operation.id, request: operation.request, status });
        };
        const status = handle instanceof TCP
          ? operation.ipv6 ? handle.connect6(request as TCPConnectWrap, operation.address, operation.port!) : handle.connect(request as TCPConnectWrap, operation.address, operation.port!)
          : handle.connect(request as PipeConnectWrap, operation.address);
        if (status !== 0) this.connects.delete(operation.id);
        return { status };
      }
      case 'open': {
        const inherited = this.descriptors.get(operation.fd);
        const held = inherited === undefined ? undefined : this.entry(inherited);
        if (!held || held.descriptor.kind !== entry.descriptor.kind || handle.peer || handle.listening) return { status: UV_EBADF };
        if (held !== entry) {
          if (handle instanceof TCP && held.handle instanceof TCP) {
            const local: Partial<SockName> = {}, remote: Partial<SockName> = {};
            if (held.handle.getsockname(local) === 0 && held.handle.getpeername(remote) === 0) handle.adoptNames(local as SockName, remote as SockName);
          }
          handle.takeOverFrom(held.handle);
          this.entries.delete(inherited!);
          scopes.delete(held.handle);
          held.handle.close();
          this.descriptors.set(operation.fd, operation.id);
        }
        return { status: 0 };
      }
      case 'readStart':
        entry.buffer ??= new Uint8Array(this.limits.maxReadChunkBytes);
        handle.useUserBuffer(entry.buffer);
        return { status: handle.readStart() };
      case 'readStop': return { status: handle.readStop() };
      case 'ref': handle.ref(); return { status: 0 };
      case 'unref': handle.unref(); return { status: 0 };
      case 'getsockname': case 'getpeername': {
        if (!(handle instanceof TCP)) return { status: UV_ENOTSUP };
        const address: Partial<SockName> = {};
        const status = handle[operation.operation](address);
        return { status, ...(status === 0 ? { address } : {}) };
      }
      case 'shutdown': {
        if (!Number.isSafeInteger(operation.request) || operation.request < 1) return { status: UV_EINVAL };
        if (this.writes.has(operation.id)) return { status: UV_EBUSY };
        const request = new ShutdownWrap();
        request.oncomplete = status => this.publish({ type: 'shutdown', id: operation.id, request: operation.request, status });
        return { status: handle.shutdown(request) };
      }
      case 'reset':
        if (!Number.isSafeInteger(operation.request) || operation.request < 1) return { status: UV_EINVAL };
        if (!(handle instanceof TCP)) return { status: UV_ENOTSUP };
        this.writes.get(operation.id)?.(UV_ECANCELED);
        return this.close(operation.id, operation.request, true);
      case 'close':
        if (!Number.isSafeInteger(operation.request) || operation.request < 1) return { status: UV_EINVAL };
        return this.close(operation.id, operation.request);
    }
  }

  /**
   * Transport chunks are bounded and serialized per handle. Waiting for native
   * receive capacity retains at most one chunk per writer, within the scope's
   * explicit aggregate ceiling. No polling or copying a whole guest write.
   */
  write(id: number, bytes: Uint8Array, sentId?: number): Promise<number> {
    const handle = this.entry(id)?.handle;
    if (!handle) return Promise.resolve(UV_EBADF);
    if (this.writes.has(id)) return Promise.resolve(UV_EBUSY);
    if (bytes.byteLength > this.limits.maxReadChunkBytes
      || this.pendingWriteBytes + bytes.byteLength > this.limits.maxPendingWriteBytes) return Promise.resolve(UV_ENOBUFS);
    const sent = sentId === undefined ? undefined : this.entry(sentId)?.handle;
    if (sentId !== undefined && !sent) return Promise.resolve(UV_EBADF);
    if (sent && (!(handle instanceof Pipe) || !sent.peer || sent.listening || bytes.byteLength === 0)) return Promise.resolve(UV_ENOTSUP);
    // Retain the descriptor while capacity is unavailable; the sender can close
    // its original after submitting the write without invalidating this copy.
    const owned = bytes.slice();
    const retained = sent?.duplicate();
    if (retained) __adoptHandle(retained, null);
    this.pendingWriteBytes += owned.byteLength;
    return new Promise((resolve, reject) => {
      let ended = false;
      let unsubscribe = (): void => {};
      const finish = (status: number, failure?: unknown): void => {
        if (ended) return;
        ended = true;
        unsubscribe();
        this.writes.delete(id);
        this.pendingWriteBytes -= owned.byteLength;
        try { retained?.close(); }
        catch (cause) { reject(cause); return; }
        if (failure !== undefined) reject(failure);
        else resolve(status);
      };
      const attempt = (): void => {
        if (ended) return;
        if (handle.closed || this.disposed) { finish(UV_ECANCELED); return; }
        if (!handle.peer) { finish(UV_EPIPE); return; }
        if (handle.peerQueuedBytes + owned.byteLength > this.limits.maxQueuedBytes) return;
        // A one-byte IPC message can carry an entire descriptor. Byte credit
        // alone does not meaningfully bound unread SCM_RIGHTS copies.
        if (retained && handle.peerQueuedHandles >= this.limits.maxQueuedHandles) return;
        try { finish(handle.writeBuffer(new WriteWrap(), owned, retained)); }
        catch (cause) { finish(UV_ECANCELED, cause); }
      };
      this.writes.set(id, finish);
      unsubscribe = handle.onPeerReadCapacity(attempt);
      attempt();
    });
  }

  /** Trusted parent-to-child inheritance; this is deliberately absent from call(). */
  inherit(fd: number, source: NativeStreamScope, id: number): NativeStreamReply {
    if (this.disposed || !Number.isInteger(fd) || fd < 0 || this.descriptors.has(fd)) return { status: UV_EINVAL };
    if (this.entries.size >= this.limits.maxHandles) return { status: UV_EMFILE };
    const handle = source.entry(id)?.handle;
    if (!handle) return { status: UV_EBADF };
    if (handle.listening || !handle.peer) return { status: UV_ENOTSUP };
    const copy = handle.duplicate();
    const descriptor = this.claim(copy);
    if (!descriptor) { copy.close(); return { status: UV_EMFILE }; }
    this.descriptors.set(fd, descriptor.id);
    return { status: 0, handle: descriptor };
  }

  private close(id: number, request?: number, reset = false): NativeStreamReply {
    const entry = this.entries.get(id);
    if (!entry) return { status: UV_EBADF };
    this.writes.get(id)?.(UV_ECANCELED);
    const connecting = this.connects.get(id);
    this.connects.delete(id);
    if (connecting !== undefined) this.publish({ type: 'connect', id, request: connecting, status: UV_ECANCELED });
    this.entries.delete(id);
    scopes.delete(entry.handle);
    for (const [fd, held] of this.descriptors) if (held === id) this.descriptors.delete(fd);
    const complete = request === undefined ? undefined : () => this.publish({ type: 'close', id, request, status: 0 });
    if (reset) (entry.handle as TCP).reset(complete);
    else entry.handle.close(complete);
    return { status: 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const id of [...this.entries.keys()]) {
      try { this.close(id); } catch (cause) { failures.push(cause); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native stream scope cleanup failed.');
  }
}
