/**
 * A run's fd 0 over shared memory: a single-producer, single-consumer byte
 * ring a host writes from a thread of its own (the kernel's pipe reader) and
 * the run reads, synchronously or not.
 *
 * Why it exists: a blocking `read(0)` waits for the writer, and every other
 * door a run's stdin has (a host's `stdinStream`, `sendInput`, a parent
 * guest's pipe write) delivers on the run's own realm loop, which a thread
 * blocked in the read holds -- the wait there is a deadlock. Bytes a
 * different thread writes into shared memory are what a blocked thread can
 * still receive, as a synchronous child's answers already are.
 *
 * The layout, which producer and consumer both read from here:
 *
 * - An `Int32Array` header over the buffer's first 16 bytes:
 *   - `[WRITE_INDEX]` bytes the producer has written, ever, modulo 2^32;
 *   - `[READ_INDEX]` bytes the consumer has taken, ever, modulo 2^32;
 *   - `[CLOSED]` 1 once the producer has written its last byte (EOF);
 *   - `[CAPACITY]` the data area's length in bytes, a power of two.
 * - The data area from byte 16: byte number `i` is at `16 + (i % capacity)`.
 * - Bytes available to read: `(write - read) >>> 0`; room to write:
 *   `capacity - available`.
 * - The producer copies bytes in, then `Atomics.store`s WRITE_INDEX and
 *   `Atomics.notify`s it; at EOF it stores CLOSED = 1 and notifies
 *   WRITE_INDEX. With no room it waits on READ_INDEX.
 * - The consumer copies bytes out, then `Atomics.store`s READ_INDEX and
 *   `Atomics.notify`s it. With nothing to read and CLOSED 0 it waits on
 *   WRITE_INDEX: `Atomics.wait` for a blocking read, `Atomics.waitAsync` for
 *   the run's `process.stdin`.
 */
export const STDIN_RING = {
  WRITE_INDEX: 0,
  READ_INDEX: 1,
  CLOSED: 2,
  CAPACITY: 3,
  /** Where the data area begins, in bytes. */
  HEADER_BYTES: 16,
} as const;

/** `Atomics.waitAsync` (ES2024), declared here because the build's library is ES2022. */
type WaitAsync = (typedArray: Int32Array, index: number, value: number) =>
  { async: false; value: 'not-equal' | 'timed-out' } | { async: true; value: Promise<'ok' | 'timed-out'> };
const waitAsync: WaitAsync | undefined = typeof Atomics === 'object'
  ? (Atomics as { waitAsync?: WaitAsync }).waitAsync
  : undefined;

/** Whether this realm can wait for a ring without blocking (Chrome, Node 16+); a run given one needs it. */
export function stdinRingWaitsAsync(): boolean {
  return typeof waitAsync === 'function';
}

/** A ring of `capacity` bytes (a power of two), empty and open, for a producer to hand a run. */
export function createStdinRing(capacity: number): SharedArrayBuffer {
  if (!Number.isInteger(capacity) || capacity <= 0 || (capacity & (capacity - 1)) !== 0 || capacity > 2 ** 30) {
    throw new RangeError('a stdin ring capacity is a power of two up to 2^30 bytes');
  }
  const buffer = new SharedArrayBuffer(STDIN_RING.HEADER_BYTES + capacity);
  new Int32Array(buffer, 0, 4)[STDIN_RING.CAPACITY] = capacity;
  return buffer;
}

/** Why a buffer is not a stdin ring, or null when it is one. */
export function stdinRingProblem(buffer: unknown): string | null {
  if (typeof SharedArrayBuffer !== 'function' || !(buffer instanceof SharedArrayBuffer)) return 'stdinShared must be a SharedArrayBuffer';
  if (buffer.byteLength < STDIN_RING.HEADER_BYTES) return 'stdinShared is shorter than its 16-byte header';
  const capacity = new Int32Array(buffer, 0, 4)[STDIN_RING.CAPACITY]!;
  if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) return 'stdinShared capacity must be a power of two';
  if (buffer.byteLength < STDIN_RING.HEADER_BYTES + capacity) return 'stdinShared is shorter than its header and capacity';
  return null;
}

/** The consumer's end of a ring. */
export class StdinRingReader {
  private readonly header: Int32Array;
  private readonly data: Uint8Array;
  private readonly capacity: number;

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, 4);
    this.capacity = this.header[STDIN_RING.CAPACITY]!;
    this.data = new Uint8Array(buffer, STDIN_RING.HEADER_BYTES, this.capacity);
  }

  /** Bytes there to read now. */
  available(): number {
    return (Atomics.load(this.header, STDIN_RING.WRITE_INDEX) - Atomics.load(this.header, STDIN_RING.READ_INDEX)) >>> 0;
  }

  /** The producer wrote its last byte. */
  closed(): boolean {
    return Atomics.load(this.header, STDIN_RING.CLOSED) === 1;
  }

  /**
   * Up to `length` bytes into `into` at `offset`, without waiting: the count
   * taken, 0 at EOF, or null when nothing is there yet and the ring is open.
   */
  take(into: Uint8Array, offset: number, length: number): number | null {
    const count = Math.min(length, this.available());
    if (count === 0) return this.closed() && this.available() === 0 ? 0 : null;
    const read = Atomics.load(this.header, STDIN_RING.READ_INDEX) >>> 0;
    for (let index = 0; index < count; index += 1) into[offset + index] = this.data[(read + index) % this.capacity]!;
    Atomics.store(this.header, STDIN_RING.READ_INDEX, (read + count) | 0);
    Atomics.notify(this.header, STDIN_RING.READ_INDEX);
    return count;
  }

  /** Everything there now, as one chunk; 0-length at EOF; null when nothing is there yet. */
  takeAll(): Uint8Array | null {
    const bytes = new Uint8Array(this.available());
    const count = this.take(bytes, 0, bytes.length);
    return count === null ? null : bytes.subarray(0, count);
  }

  /**
   * A blocking read: waits on WRITE_INDEX until there are bytes or EOF.
   * Throws where the realm refuses `Atomics.wait` (a page's main thread).
   */
  takeBlocking(into: Uint8Array, offset: number, length: number): number {
    for (;;) {
      const written = Atomics.load(this.header, STDIN_RING.WRITE_INDEX);
      const count = this.take(into, offset, length);
      if (count !== null) return count;
      Atomics.wait(this.header, STDIN_RING.WRITE_INDEX, written);
    }
  }

  /** Resolves when WRITE_INDEX or CLOSED may have moved, without a timer. */
  whenWritten(): Promise<void> {
    const written = Atomics.load(this.header, STDIN_RING.WRITE_INDEX);
    if (this.available() > 0 || this.closed()) return Promise.resolve();
    const waiting = waitAsync!.call(Atomics, this.header, STDIN_RING.WRITE_INDEX, written);
    return waiting.async ? waiting.value.then(() => undefined) : Promise.resolve();
  }
}

/** Where a run's process carries its ring reader, for the fs binding's read of fd 0. */
export const kStdinRing = Symbol.for('tabnode.run.stdinRing');
