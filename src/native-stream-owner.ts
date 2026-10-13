/** Host-owned native handles. Node's JS socket and IPC libraries stay in the guest. */
import { TCP, TCPConnectWrap, type SockName } from './node-lib/binding/tcp_wrap';
import { Pipe, PipeConnectWrap } from './node-lib/binding/pipe_wrap';
import { LibuvStreamWrap, WriteWrap, ShutdownWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset } from './node-lib/binding/stream_wrap';
import { __adoptHandle } from './node-lib/binding/handles';
import uv, { UV_EBADF, UV_ECANCELED, UV_EINVAL, UV_ENOBUFS, UV_ENOTSUP, UV_EPIPE, UV_EMFILE, UV_EBUSY, UV_EALREADY, UV_ENOSYS } from './node-lib/binding/uv';

const UV_EAGAIN = uv.UV_EAGAIN as number;

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
  | { operation: 'fdType'; fd: number }
  | { operation: 'pair'; id: number; peer: number }
  | { operation: 'duplicate'; id: number }
  | { operation: 'bind'; id: number; address: string; port?: number; ipv6?: boolean; flags?: number }
  | { operation: 'listen'; id: number; backlog: number }
  | { operation: 'connect'; id: number; request: number; address: string; port?: number; ipv6?: boolean }
  | { operation: 'open'; id: number; fd: number }
  | { operation: 'readStart' | 'readStop' | 'ref' | 'unref' | 'getsockname' | 'getpeername'; id: number }
  | { operation: 'shutdown' | 'close' | 'reset'; id: number; request: number };
export interface NativeStreamReply { status: number; handle?: NativeStreamDescriptor; handleType?: 'TCP' | 'PIPE'; address?: Partial<SockName> }
/** Bounded evidence only; no stream authority or payload bytes. */
export interface NativeStreamWriteTrace { listener: number; vector: number; chunk: number }
export interface NativeStreamTransport {
  readonly limits: Readonly<NativeStreamLimits>;
  call(operation: NativeStreamOperation): NativeStreamReply;
  /**
   * An operation whose answer nothing waits for, sent without waiting for
   * the owner: the owner takes it in order with every call after it, and one
   * it refuses completes with its status: a read grant as the handle's failed
   * read, a shutdown as its completion. Optional; without it each is a call.
   */
  post?(operation: { operation: 'readStart'; id: number } | { operation: 'shutdown'; id: number; request: number }): void;
  write(id: number, bytes: Uint8Array, handle?: number, trace?: NativeStreamWriteTrace): Promise<number>;
  /** Whole bounded write, without a descriptor: 0 means all bytes accepted.
   * EAGAIN (or undefined when local credit prevents an attempt) accepts none.
   * The host bounds the synchronous wait. A Promise owns the ALREADY submitted
   * write's async completion: do not submit its bytes again. Older holders omit
   * this bounded method and their ordered writes stay async. */
  tryWriteWithinBudget?(id: number, bytes: Uint8Array, trace?: NativeStreamWriteTrace): number | Promise<number> | undefined;
  onEvent(listener: (event: NativeStreamEvent) => void): () => void;
}

type NativeHandle = TCP | Pipe;
interface Entry { handle: NativeHandle; descriptor: NativeStreamDescriptor; buffer?: Uint8Array }
const scopes = new WeakMap<LibuvStreamWrap, NativeStreamScope>();
// Every scope not yet disposed: what the container's /proc lists as each
// process's descriptors.
const liveScopes = new Set<NativeStreamScope>();

/** One open stream handle, as a process's descriptor table shows it. */
export interface NativeStreamHandleView { pid?: number; id: number; kind: 'tcp' | 'pipe'; listening: boolean }

/**
 * One capability namespace per worker. Only the trusted host can inherit a
 * descriptor from another scope; wire operations can name this scope's IDs only.
 */
export class NativeStreamScope {
  private readonly entries = new Map<number, Entry>();
  private readonly descriptors = new Map<number, number>();
  private readonly writes = new Map<number, (status: number) => void>();
  private readonly connects = new Map<number, number>();
  /**
   * Entries whose bytes another realm carries (R14, takeExclusive). That realm hands them back before it duplicates,
   * passes, pairs or lets a child inherit one (returnExclusive); refusing those here is the backstop, never the path.
   */
  private readonly exclusive = new Set<number>();
  /** Who waits for an entry's bytes to settle (watchSettled). */
  private readonly settledWatchers = new Map<number, Set<() => void>>();
  private nextId = 1;
  private pendingWriteBytes = 0;
  private disposed = false;
  private readonly limits: Readonly<NativeStreamLimits>;

  /**
   * `ownerPid` names the process whose worker this scope serves: a listener
   * it opens is that process's socket, as the container's /proc shows it.
   */
  constructor(limits: NativeStreamLimits, private readonly emit: (event: NativeStreamEvent) => void, readonly ownerPid?: () => number | undefined) {
    if ([limits.maxHandles, limits.maxReadChunkBytes, limits.maxQueuedBytes, limits.maxQueuedHandles, limits.maxPendingWriteBytes].some(value => !Number.isSafeInteger(value) || value < 1)
      || limits.maxReadChunkBytes > 0x7fffffff
      || limits.maxReadChunkBytes > limits.maxQueuedBytes
      || limits.maxReadChunkBytes > limits.maxPendingWriteBytes) throw new Error('Invalid native stream resource limits.');
    this.limits = Object.freeze({ ...limits });
    liveScopes.add(this);
  }

  /** This scope's open handles, with the process it serves. */
  handles(): NativeStreamHandleView[] {
    if (this.disposed) return [];
    const pid = this.ownerPid?.();
    return [...this.entries.values()].map(({ handle, descriptor }) => ({
      ...(pid !== undefined ? { pid } : {}), id: descriptor.id, kind: descriptor.kind, listening: !!handle.listening,
    }));
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
    if (operation.operation === 'fdType') {
      if (!Number.isInteger(operation.fd) || operation.fd < 0) return { status: UV_EINVAL };
      const id = this.descriptors.get(operation.fd);
      const entry = id === undefined ? undefined : this.entry(id);
      return entry ? { status: 0, handleType: entry.descriptor.kind === 'tcp' ? 'TCP' : 'PIPE' } : { status: UV_EBADF };
    }
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
    if (this.exclusive.has(operation.id) && (operation.operation === 'duplicate' || operation.operation === 'pair')) return { status: UV_ENOTSUP };
    switch (operation.operation) {
      case 'duplicate': {
        // A connection is duplicated whether or not its other end is still
        // there (the copy reads its EOF); a listening server is not one.
        if (handle.listening) return { status: UV_ENOTSUP };
        if (this.entries.size >= this.limits.maxHandles) return { status: UV_EMFILE };
        const copy = handle.duplicate();
        const descriptor = this.claim(copy);
        if (!descriptor) { copy.close(); return { status: UV_EMFILE }; }
        return { status: 0, handle: descriptor };
      }
      case 'pair': {
        if (this.exclusive.has(operation.peer)) return { status: UV_ENOTSUP };
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

  /** Node's DoTryWrite: never wait, queue, partially accept, or carry a handle.
   * The local binding copies bytes into the peer's native queue before returning
   * 0, and schedules the reader separately. EAGAIN leaves that queue untouched. */
  tryWrite(id: number, bytes: Uint8Array): number {
    const handle = this.entry(id)?.handle;
    if (!handle || handle.closed) return UV_EBADF;
    if (!(bytes instanceof Uint8Array)) return UV_EINVAL;
    if (bytes.byteLength > this.limits.maxReadChunkBytes
      || this.writes.has(id)
      || this.pendingWriteBytes + bytes.byteLength > this.limits.maxPendingWriteBytes) return UV_EAGAIN;
    if (!handle.peer) return UV_EPIPE;
    if (handle.peerQueuedBytes + bytes.byteLength > this.limits.maxQueuedBytes) return UV_EAGAIN;
    return handle.writeBuffer(new WriteWrap(), bytes);
  }

  /** The caller's short wait ended after we claimed its attempt. Only the
   * native statuses that accepted NO bytes may enter the ordinary write queue.
   * Otherwise that same submission completes with its actual native status. */
  finishTryWrite(id: number, bytes: Uint8Array, status: number): Promise<number> {
    return status === UV_EAGAIN || status === UV_ENOSYS
      ? this.write(id, bytes) : Promise.resolve(status);
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
    if (sentId !== undefined && this.exclusive.has(sentId)) return Promise.resolve(UV_ENOTSUP);
    // A connection crosses whether or not its other end is still there: Node
    // passes a socket whose peer has closed, and the receiver reads its EOF.
    // Refusing it failed the whole channel write (`write ENOTSUP`), which ended
    // VS Code's extension host when a reconnecting client had already gone.
    if (sent && (!(handle instanceof Pipe) || sent.listening || bytes.byteLength === 0)) return Promise.resolve(UV_ENOTSUP);
    // Retain the descriptor while capacity is unavailable; the sender can close
    // its original after submitting the write without invalidating this copy.
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
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
        queueMicrotask(() => this.settled(id));
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
    if (handle.listening || source.exclusive.has(id)) return { status: UV_ENOTSUP };
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
    this.exclusive.delete(id);
    this.settledWatchers.delete(id);
    scopes.delete(entry.handle);
    for (const [fd, held] of this.descriptors) if (held === id) this.descriptors.delete(fd);
    const complete = request === undefined ? undefined : () => this.publish({ type: 'close', id, request, status: 0 });
    if (reset) (entry.handle as TCP).reset(complete);
    else entry.handle.close(complete);
    return { status: 0 };
  }

  /** nativeStreamPeerEntry, where a host holds the class (a host on an older engine finds no such method). */
  static peerEntry(handle: object): { scope: NativeStreamScope; id: number } | undefined { return nativeStreamPeerEntry(handle); }

  /** The id this scope gives a handle it holds. */
  idOf(handle: NativeHandle): number | undefined {
    if (this.disposed) return undefined;
    for (const [id, entry] of this.entries) if (entry.handle === handle) return id;
    return undefined;
  }

  /** Whether a write for this entry is waiting for its peer's read capacity. */
  writing(id: number): boolean { return this.writes.has(id); }

  /**
   * Called when what an entry carries may have settled: its pending write finished, or its peer read (so the bytes
   * the entry wrote moved on). A host waiting for both directions to drain rechecks there, never on a timer.
   */
  watchSettled(id: number, listener: () => void): () => void {
    const entry = this.entry(id);
    if (!entry) return () => {};
    let watchers = this.settledWatchers.get(id);
    if (!watchers) { watchers = new Set(); this.settledWatchers.set(id, watchers); }
    watchers.add(listener);
    const unsubscribe = entry.handle.onPeerReadCapacity(listener);
    return () => { unsubscribe(); watchers!.delete(listener); if (!watchers!.size && this.settledWatchers.get(id) === watchers) this.settledWatchers.delete(id); };
  }

  private settled(id: number): void {
    for (const listener of [...this.settledWatchers.get(id) ?? []]) listener();
  }

  /**
   * Hand an entry's bytes to another realm exclusively (R14): the bytes that arrived and were not yet read are taken, and from
   * here the entry carries only its control (connect, names, shutdown, close, EOF and errors). Undefined, changing
   * nothing, where the entry cannot move: absent, listening, shared with another descriptor, waiting to write, or
   * holding anything but bytes.
   */
  takeExclusive(id: number): Uint8Array | undefined {
    const entry = this.entry(id);
    if (!entry || entry.handle.closed || entry.handle.listening || this.exclusive.has(id) || this.writes.has(id) || this.connects.has(id)
      || [...this.descriptors.values()].includes(id)) return undefined;
    const bytes = entry.handle.takeQueuedReads();
    if (bytes) this.exclusive.add(id);
    return bytes;
  }

  /**
   * The other realm hands the entry's bytes back (before a duplicate, an inheritance, a pass or a pairing, or as it
   * stops): what it took and did not read is read first, then (`ended`) the EOF or error it held, and the entry is an
   * ordinary one again.
   */
  returnExclusive(id: number, unread: Uint8Array, ended = false): boolean {
    const entry = this.entry(id);
    if (!entry) return false;
    // Possibly released already (releaseExclusive), while the bytes were still on their way back.
    this.exclusive.delete(id);
    // takeExclusive refuses an end with its EOF or error pending, so one read here since was read while the other
    // realm held the bytes: it is read again after them (review of 2d9217a, item 3).
    entry.handle.returnQueuedReads(unread, ended || entry.handle.readEnded);
    return true;
  }

  /**
   * The other realm has asked to hand the entry back and its bytes are on their way: the entry is ordinary from
   * here (a duplicate, pass, pairing or inheritance asked meanwhile succeeds), and returnExclusive puts the bytes in
   * front when they arrive.
   */
  releaseExclusive(id: number): boolean { return this.exclusive.delete(id); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    liveScopes.delete(this);
    const failures: unknown[] = [];
    for (const id of [...this.entries.keys()]) {
      try { this.close(id); } catch (cause) { failures.push(cause); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native stream scope cleanup failed.');
  }
}

/**
 * The scope entry on the other end of a realm-local connection (R14): an accepted handle whose peer is one native
 * entry, with no other wrapper on that end. Undefined otherwise.
 */
export function nativeStreamPeerEntry(handle: object): { scope: NativeStreamScope; id: number } | undefined {
  if (!(handle instanceof LibuvStreamWrap)) return undefined;
  const peer = handle.soleRealmPeer;
  const scope = peer ? scopes.get(peer as NativeHandle) : undefined;
  const id = scope && peer ? scope.idOf(peer as NativeHandle) : undefined;
  return scope && id !== undefined ? { scope, id } : undefined;
}

/** The process a handle opened for another worker's process belongs to, where a scope holds it. */
export function nativeStreamOwnerPid(handle: object): number | undefined {
  return scopes.get(handle as NativeHandle)?.ownerPid?.();
}

/** Every open native stream handle in this worker, by the process each scope serves. */
export function nativeStreamHandles(): NativeStreamHandleView[] {
  return [...liveScopes].flatMap(scope => scope.handles());
}
