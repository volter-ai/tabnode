/** Worker-side libuv delegation. The capability channel never becomes a handle property. */
import { withGuestCallback } from './guest-loop';
import type { NativeStreamDescriptor, NativeStreamEvent, NativeStreamOperation, NativeStreamReply, NativeStreamTransport } from './native-stream-owner';
import type { TCP } from './node-lib/binding/tcp_wrap';
import type { Pipe } from './node-lib/binding/pipe_wrap';
import { LibuvStreamWrap, type WriteWrap, streamBaseState, kBytesWritten, kLastWriteWasAsync } from './node-lib/binding/stream_wrap';
import { __adoptHandle, ownerOf, registerHandle, releaseHandle } from './node-lib/binding/handles';
import { UV_EBADF, UV_ECANCELED, UV_EINVAL, UV_EPIPE, errname } from './node-lib/binding/uv';

type Stream = TCP | Pipe;
const drivers = new WeakMap<LibuvStreamWrap, NativeStreamDriver>();
const handles = new Map<number, Stream>();
const constructors: Partial<Record<'tcp' | 'pipe', new (type: number) => Stream>> = {};
let transport: NativeStreamTransport | undefined;
let allocated = false;
let stopped = false;
let incoming: NativeStreamDescriptor | undefined;
let nextRequest = 1;

// Register after each concrete binding class is defined. Importing TCP/Pipe
// here at runtime would cycle through StreamWrap before their base class exists.
export function registerNativeStreamConstructor(kind: 'tcp' | 'pipe', constructor: new (type: number) => Stream): void {
  constructors[kind] = constructor;
}

function requestId(): number {
  if (!Number.isSafeInteger(nextRequest)) throw new Error('Native stream request IDs exhausted.');
  return nextRequest++;
}

/**
 * An instrument: what this realm asked of its stream owner. Per operation, the calls, the milliseconds this thread
 * was blocked in them (a call is synchronous: it returns when the owner's thread has answered) and the longest one;
 * per write, the bytes and the milliseconds until the owner said it was written; per event the owner sent, the count.
 * A single call that blocks past `SLOW_CALL_MS` is said at once, so a stall is named even by a process that never exits.
 */
/** `over`: how many took at least 1, 4, 16, 64 and 250 ms, so a few long waits are told from many short ones. */
interface StreamCount { calls: number; ms: number; max: number; over: number[]; bytes?: number }
const OVER_MS = [1, 4, 16, 64, 250];
const streamCounts = new Map<string, StreamCount>();
const streamEvents = new Map<string, number>();
const SLOW_CALL_MS = 250;
let streamCountsSaid = 0;
function tally(operation: string, ms: number, bytes?: number): void {
  let count = streamCounts.get(operation);
  if (!count) streamCounts.set(operation, count = { calls: 0, ms: 0, max: 0, over: OVER_MS.map(() => 0) });
  count.calls += 1; count.ms += ms; if (ms > count.max) count.max = ms;
  for (let at = 0; at < OVER_MS.length && ms >= OVER_MS[at]!; at++) count.over[at]! += 1;
  if (bytes !== undefined) count.bytes = (count.bytes ?? 0) + bytes;
}
function counting(next: NativeStreamTransport): NativeStreamTransport {
  return {
    limits: next.limits,
    call(operation) {
      const from = performance.now();
      try { return next.call(operation); }
      finally {
        const ms = performance.now() - from;
        tally(operation.operation, ms);
        if (ms >= SLOW_CALL_MS) console.log('[stream-calls]', JSON.stringify({ event: 'slow', at: Date.now(), operation: operation.operation, id: 'id' in operation ? operation.id : null, blockedMs: Math.round(ms) }));
      }
    },
    ...(next.post ? { post(operation: Parameters<NonNullable<NativeStreamTransport['post']>>[0]): void { tally(`post:${operation.operation}`, 0); next.post!(operation); } } : {}),
    write(id, bytes, handle) {
      const from = performance.now();
      const size = bytes.byteLength;
      const written = next.write(id, bytes, handle);
      const done = (): void => tally('write', performance.now() - from, size);
      written.then(done, done);
      return written;
    },
    onEvent(listener) {
      return next.onEvent(event => {
        const kind = event.type === 'read' ? (event.bytes ? 'read' : event.handle ? 'read-handle' : `read-status-${event.status}`) : event.type;
        streamEvents.set(kind, (streamEvents.get(kind) ?? 0) + 1);
        if (event.type === 'read' && event.bytes) streamEvents.set('read-bytes', (streamEvents.get('read-bytes') ?? 0) + event.bytes.byteLength);
        listener(event);
      });
    },
  };
}
/** Says the counts so far, once per change: a process says them at its exit. */
export function sayNativeStreamCounts(pid: number | null, when: string): void {
  let total = 0;
  for (const count of streamCounts.values()) total += count.calls;
  if (total === streamCountsSaid) return;
  streamCountsSaid = total;
  const operations = [...streamCounts].sort((a, b) => b[1].ms - a[1].ms)
    .map(([operation, count]) => [operation, count.calls, Math.round(count.ms), Math.round(count.max), count.over, ...(count.bytes === undefined ? [] : [count.bytes])]);
  console.log('[stream-calls]', JSON.stringify({ event: when, at: Date.now(), pid, columns: ['operation', 'calls', 'blockedMs', 'maxMs', `over ${OVER_MS.join('/')} ms`, 'bytes'], operations, events: Object.fromEntries(streamEvents) }));
}

/** Host bootstrap only, before any TCP/Pipe exists in this process realm. */
export function installNativeStreamTransport(next: NativeStreamTransport): void {
  if (transport || allocated) throw new Error('Native stream transport must be installed before stream construction.');
  next = counting(next);
  transport = next;
  next.onEvent(event => {
    if (event.type === 'closed') {
      stopped = true;
      const failures: unknown[] = [];
      for (const handle of [...handles.values()]) {
        try { drivers.get(handle)?.ownerStopped(); } catch (cause) { failures.push(cause); }
      }
      if (failures.length) throw new AggregateError(failures, 'Native stream owner stopped during callbacks.');
      return;
    }
    const handle = handles.get(event.id);
    if (handle) drivers.get(handle)!.receive(event);
    // A read/accept already posted before close still owns its transferred
    // descriptor. Discarding the event must not leak that owner capability.
    else if ('handle' in event && event.handle && !stopped) closeDescriptor(event.handle.id);
  });
}

function closeDescriptor(id: number): void {
  if (!stopped) transport!.call({ operation: 'close', id, request: requestId() });
}

/** uv requests keep their loop alive even when their stream is unreferenced. */
function holdRequest(handle: Stream): () => void {
  const request = { close: (): void => releaseHandle(request) };
  registerHandle(request);
  __adoptHandle(request, ownerOf(handle));
  return request.close;
}

function adopt(descriptor: NativeStreamDescriptor, receiver: Stream): Stream {
  if (handles.has(descriptor.id)) throw new Error('Native descriptor was delivered twice.');
  const previous = incoming;
  incoming = descriptor;
  try {
    const Constructor = constructors[descriptor.kind];
    if (!Constructor) throw new Error('Native stream constructor is unavailable.');
    const handle = new Constructor(descriptor.type);
    __adoptHandle(handle, ownerOf(receiver));
    return handle;
  } finally { incoming = previous; }
}

export function nativeStreamFor(handle: LibuvStreamWrap): NativeStreamDriver | undefined { return drivers.get(handle); }

/** Inherited descriptors live with the owner, not in this realm's JS fd table. */
export function nativeInheritedFdType(fd: number): 'TCP' | 'PIPE' | undefined {
  if (!transport || stopped || !Number.isInteger(fd) || fd < 0) return undefined;
  const result = transport.call({ operation: 'fdType', fd });
  if (result.status === UV_EBADF) return undefined;
  if (result.status !== 0 || (result.handleType !== 'TCP' && result.handleType !== 'PIPE')) {
    throw new Error(`Native descriptor lookup failed: ${errname(result.status)}`);
  }
  return result.handleType;
}

/** Trusted process admission uses this ID for explicit descriptor inheritance. */
export function nativeStreamDescriptor(handle: LibuvStreamWrap): NativeStreamDescriptor | undefined {
  const driver = drivers.get(handle);
  return driver && !handle.closed ? { ...driver.descriptor } : undefined;
}

export function attachNativeStream(
  handle: Stream, kind: 'tcp' | 'pipe', type: number,
  closeLocal: (callback?: () => void) => void, flushLocal: () => void,
): void {
  allocated = true;
  if (!transport) return;
  try {
    if (stopped) throw new Error('Native stream owner stopped.');
    const result = incoming ? { status: 0, handle: incoming } : transport.call({ operation: 'create', kind, type });
    if (result.status !== 0 || !result.handle) {
      throw Object.assign(new Error(`Native stream creation failed: ${errname(result.status)}`), { code: errname(result.status), errno: result.status });
    }
    const descriptor = result.handle;
    if (descriptor.kind !== kind || descriptor.type !== type || handles.has(descriptor.id)) throw new Error('Invalid native stream descriptor.');
    incoming = undefined;
    drivers.set(handle, new NativeStreamDriver(handle, descriptor, transport, closeLocal, flushLocal));
    handles.set(descriptor.id, handle);
  } catch (cause) { releaseHandle(handle); throw cause; }
}

interface PendingWrite {
  request: WriteWrap;
  parts: Uint8Array[];
  bytes: number;
  sent?: number;
  ended: boolean;
  release(): void;
}
interface LocalEndpoint { handles: Set<Stream>; peer?: LocalEndpoint }

export class NativeStreamDriver {
  private readingCredit = false;
  private buffered = false;
  private readEnded = false;
  private closing = false;
  private readonly completions = new Map<number, (status: number) => void>();
  private readonly writes: PendingWrite[] = [];
  private readonly closeCallbacks: Array<() => void> = [];
  private endpoint: LocalEndpoint;
  private pumping = false;
  private releaseClose: (() => void) | undefined;
  private writeEnded = false;
  private pendingShutdown: (() => void) | undefined;

  constructor(
    private readonly handle: Stream,
    readonly descriptor: NativeStreamDescriptor,
    private readonly channel: NativeStreamTransport,
    private readonly closeLocal: (callback?: () => void) => void,
    private readonly flushLocal: () => void,
  ) { this.endpoint = { handles: new Set([handle]) }; }

  get peer(): LibuvStreamWrap | null {
    for (const handle of this.endpoint.peer?.handles ?? []) if (!handle.closed) return handle;
    return null;
  }

  pair(other: NativeStreamDriver): void {
    const { status } = this.call({ operation: 'pair', id: this.descriptor.id, peer: other.descriptor.id });
    if (status !== 0) throw Object.assign(new Error('Native stream pairing failed.'), { errno: status });
    this.endpoint.peer = other.endpoint;
    other.endpoint.peer = this.endpoint;
  }

  call(operation: NativeStreamOperation): NativeStreamReply {
    return this.closing || stopped ? { status: UV_EBADF } : this.channel.call(operation);
  }

  /**
   * The realm stopped reading: a grant still outstanding is taken back at the
   * owner, as a call, so it reads nothing more for this realm until asked.
   * Without it the owner kept the grant and read one more chunk for a paused
   * socket: VS Code's server pauses the extension host's socket to hand it to
   * that process, the chunk reached the server, and the extension host's
   * stream began mid-frame. A chunk already on its way still arrives, and is
   * kept, as Node keeps what it read before a pause.
   */
  endRead(): void {
    if (!this.readingCredit || this.closing || stopped) return;
    this.call({ operation: 'readStop', id: this.descriptor.id });
    this.readingCredit = false;
  }

  operation(operation: 'readStop' | 'ref' | 'unref'): number {
    return this.call({ operation, id: this.descriptor.id }).status;
  }

  beginRead(): number {
    if (this.closing || stopped) return UV_EBADF;
    if (this.readingCredit || this.buffered || this.readEnded) return 0;
    this.readingCredit = true;
    // Posted where it can be, so a process does not stop for its owner's thread once per chunk it reads: a refusal
    // is the read that fails. A realm that stops reading takes the grant back (endRead), so the owner never reads
    // ahead for a socket its realm has paused.
    if (this.channel.post) {
      try { this.channel.post({ operation: 'readStart', id: this.descriptor.id }); }
      catch (cause) { this.readingCredit = false; throw cause; }
      return 0;
    }
    const status = this.call({ operation: 'readStart', id: this.descriptor.id }).status;
    if (status !== 0) this.readingCredit = false;
    return status;
  }

  readFlushed(empty: boolean, ended: boolean): void {
    this.buffered = !empty;
    this.readEnded ||= ended;
    if (this.handle.reading && empty && !this.readEnded && !this.closing && !stopped) {
      const status = this.beginRead();
      if (status !== 0) this.handle.receiveError(status);
    }
  }

  complete(operation: NativeStreamOperation, callback: (status: number) => void): number {
    if (!('request' in operation)) throw new Error('Native completion requires a request ID.');
    const release = holdRequest(this.handle);
    this.completions.set(operation.request, status => { try { withGuestCallback(() => callback(status)); } finally { release(); } });
    // A shutdown is posted where it can be: it completes by its event either
    // way, and Node's own completion of one reads no status (net's
    // `afterShutdown`), so a refusal the owner completes is the same to it.
    if (operation.operation === 'shutdown' && this.channel.post && !this.closing && !stopped) {
      try { this.channel.post(operation as { operation: 'shutdown'; id: number; request: number }); return 0; }
      catch (cause) { this.completions.delete(operation.request); release(); throw cause; }
    }
    try {
      const status = this.call(operation).status;
      if (status !== 0) { this.completions.delete(operation.request); release(); }
      return status;
    } catch (cause) { this.completions.delete(operation.request); release(); throw cause; }
  }

  connect(address: string, port: number | undefined, ipv6: boolean, callback: (status: number) => void): number {
    return this.complete({ operation: 'connect', id: this.descriptor.id, request: requestId(), address, port, ipv6 }, callback);
  }

  shutdown(callback: (status: number) => void): number {
    if (this.closing || stopped) return UV_EBADF;
    if (this.writeEnded) return UV_EPIPE;
    this.writeEnded = true;
    const operation = { operation: 'shutdown' as const, id: this.descriptor.id, request: requestId() };
    if (!this.writes.length) return this.complete(operation, callback);
    // uv_shutdown follows all accepted writes, including writes still split
    // into transport chunks. EOF must not overtake those bytes.
    const release = holdRequest(this.handle);
    let completed = false;
    const complete = (status: number): void => {
      if (completed) return;
      completed = true;
      try { withGuestCallback(() => callback(status)); } finally { release(); }
    };
    this.pendingShutdown = () => {
      if (this.closing || stopped) { queueMicrotask(() => complete(UV_ECANCELED)); return; }
      try {
        const status = this.complete(operation, complete);
        if (status !== 0) queueMicrotask(() => complete(status));
      } catch { queueMicrotask(() => complete(UV_ECANCELED)); }
    };
    return 0;
  }

  duplicate(): Stream {
    const result = this.call({ operation: 'duplicate', id: this.descriptor.id });
    if (result.status !== 0 || !result.handle) throw Object.assign(new Error('Native descriptor duplication failed.'), { code: errname(result.status), errno: result.status });
    const copy = adopt(result.handle, this.handle);
    const other = drivers.get(copy)!;
    other.endpoint.handles.delete(copy);
    other.endpoint = this.endpoint;
    this.endpoint.handles.add(copy);
    return copy;
  }

  write(request: WriteWrap, parts: Uint8Array[], sent?: unknown): number {
    streamBaseState[kLastWriteWasAsync] = 0;
    const bytes = parts.reduce((total, part) => total + part.byteLength, 0);
    streamBaseState[kBytesWritten] = bytes;
    if (this.closing || stopped) return UV_EBADF;
    if (this.writeEnded) return UV_EPIPE;
    if (!Number.isSafeInteger(bytes)) return UV_EINVAL;
    if (bytes === 0) return sent == null ? 0 : UV_EINVAL;
    let retained: number | undefined;
    if (sent != null) {
      const driver = sent instanceof LibuvStreamWrap ? drivers.get(sent) : undefined;
      if (!driver || this.descriptor.kind !== 'pipe') return UV_EINVAL;
      const result = driver.call({ operation: 'duplicate', id: driver.descriptor.id });
      if (result.status !== 0 || !result.handle) return result.status || UV_EBADF;
      retained = result.handle.id;
    }
    const write: PendingWrite = { request, parts, bytes, sent: retained, ended: false, release: holdRequest(this.handle) };
    // Node retains the caller's buffers until completion, even for a write
    // larger than the transport budget. The channel bounds copied chunks and
    // waits for capacity; rejecting this whole write breaks normal streaming.
    this.handle.writeQueueSize += bytes;
    this.writes.push(write);
    request.async = true;
    streamBaseState[kLastWriteWasAsync] = 1;
    if (!this.pumping) void this.pumpWrites();
    return 0;
  }

  private async pumpWrites(): Promise<void> {
    this.pumping = true;
    try { while (this.writes.length) await this.writeNext(); }
    finally { this.pumping = false; this.flushShutdown(); }
  }

  private flushShutdown(): void {
    if (this.writes.length || !this.pendingShutdown) return;
    const dispatch = this.pendingShutdown;
    this.pendingShutdown = undefined;
    dispatch();
  }

  private async writeNext(): Promise<void> {
    const write = this.writes[0];
    if (!write || write.ended) return;
    let status = 0;
    try {
      outer: for (const part of write.parts) {
        for (let offset = 0; offset < part.byteLength; offset += this.channel.limits.maxReadChunkBytes) {
          if (this.closing || stopped) { status = UV_ECANCELED; break outer; }
          const chunk = part.subarray(offset, offset + this.channel.limits.maxReadChunkBytes);
          status = await this.channel.write(this.descriptor.id, chunk, write.sent);
          if (write.sent !== undefined) { closeDescriptor(write.sent); write.sent = undefined; }
          if (status !== 0) break outer;
          this.handle.bytesWritten += chunk.byteLength;
        }
      }
    } catch { status = stopped ? UV_ECANCELED : UV_EPIPE; }
    this.finishWrite(write, status);
  }

  private finishWrite(write: PendingWrite, status: number): void {
    if (write.ended) return;
    write.ended = true;
    const index = this.writes.indexOf(write);
    if (index >= 0) this.writes.splice(index, 1);
    this.handle.writeQueueSize -= write.bytes;
    write.parts = [];
    try { if (write.sent !== undefined) closeDescriptor(write.sent); }
    catch (cause) {
      status = UV_ECANCELED;
      write.request.error = cause instanceof Error ? cause.message : String(cause);
    } finally { write.sent = undefined; }
    // A Node callback throws as a native callback, not as a rejection of this
    // bridge's private async function.
    queueMicrotask(() => { try { withGuestCallback(() => write.request.oncomplete?.(status)); } finally { write.release(); } });
  }

  close(callback?: () => void, reset = false): number {
    if (callback) this.closeCallbacks.push(callback);
    if (this.closing) return 0;
    this.closing = true;
    this.releaseClose = holdRequest(this.handle);
    this.handle.closed = true;
    this.handle.reading = false;
    // Keep the local handle registered until the owner's close completes.
    // Otherwise the process could be reaped before its descriptors are closed.
    const request = requestId();
    this.completions.set(request, () => this.finishClose());
    if (stopped) { this.finishClose(); return 0; }
    try {
      const status = this.channel.call({ operation: reset ? 'reset' : 'close', id: this.descriptor.id, request }).status;
      if (status !== 0) { this.completions.delete(request); this.finishClose(); }
      return status;
    } catch (cause) {
      this.completions.delete(request);
      this.finishClose();
      throw cause;
    }
  }

  private finishClose(): void {
    if (!handles.has(this.descriptor.id)) return;
    handles.delete(this.descriptor.id);
    drivers.delete(this.handle);
    this.endpoint.handles.delete(this.handle);
    if (this.endpoint.handles.size === 0) {
      if (this.endpoint.peer) this.endpoint.peer.peer = undefined;
      this.endpoint.peer = undefined;
    }
    // closeLocal owns the existing local queue/fd/ref cleanup; reset its guard
    // only for this synchronous handoff after the native descriptor is gone.
    this.handle.closed = false;
    const callbacks = this.closeCallbacks.splice(0);
    this.closeLocal(() => {
      const failures: unknown[] = [];
      try {
        for (const callback of callbacks) { try { withGuestCallback(callback); } catch (cause) { failures.push(cause); } }
      } finally { this.releaseClose?.(); this.releaseClose = undefined; }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Native close callbacks failed.');
    });
  }

  receive(event: Exclude<NativeStreamEvent, { type: 'closed' }>): void {
    if (event.type === 'read') {
      this.readingCredit = false;
      if (this.closing) { if (event.handle) closeDescriptor(event.handle.id); return; }
      this.buffered = true;
      if (event.status > 0 && event.bytes) this.handle.receive(event.bytes, event.handle ? adopt(event.handle, this.handle) : undefined);
      else { this.readEnded = true; this.handle.receiveError(event.status); }
    } else if (event.type === 'connection') {
      if (this.closing || !this.handle.onconnection) { if (event.handle) closeDescriptor(event.handle.id); return; }
      const accepted = event.handle ? adopt(event.handle, this.handle) : undefined;
      withGuestCallback(() => (this.handle.onconnection as (status: number, handle?: Stream) => void)(event.status, accepted));
    } else {
      const complete = this.completions.get(event.request);
      this.completions.delete(event.request);
      complete?.(event.status);
    }
  }

  ownerStopped(): void {
    const failures: unknown[] = [];
    const attempt = (action: () => void): void => { try { action(); } catch (cause) { failures.push(cause); } };
    this.closing = true;
    for (const write of [...this.writes]) attempt(() => this.finishWrite(write, UV_ECANCELED));
    attempt(() => this.flushShutdown());
    const completions = [...this.completions.values()];
    this.completions.clear();
    for (const complete of completions) attempt(() => complete(UV_ECANCELED));
    if (handles.has(this.descriptor.id)) {
      attempt(() => { this.handle.receiveError(UV_ECANCELED); this.flushLocal(); });
      attempt(() => this.finishClose());
    }
    if (failures.length) throw new AggregateError(failures, 'Native stream shutdown callbacks failed.');
  }
}
