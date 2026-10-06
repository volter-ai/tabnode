[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / STDIN\_RING

# Variable: STDIN\_RING

> `const` **STDIN\_RING**: `object`

A run's fd 0 over shared memory: a single-producer, single-consumer byte
ring a host writes from a thread of its own (the kernel's pipe reader) and
the run reads, synchronously or not. This module is the contract's one
home: the producer (`StdinRingWriter`) and the engine's consumer
(`StdinRingReader`) are both here, and it imports nothing, so a page loads
it as `@volter/tabnode/stdin-ring` without the engine.

Why it exists: a blocking `read(0)` waits for the writer, and every other
door a run's stdin has (a host's `stdinStream`, `sendInput`, a parent
guest's pipe write) delivers on the run's own realm loop, which a thread
blocked in the read holds -- the wait there is a deadlock. Bytes a
different thread writes into shared memory are what a blocked thread can
still receive, as a synchronous child's answers already are.

The layout, which producer and consumer both read from here:

- An `Int32Array` header over the buffer's first 32 bytes (eight words,
  five used, the rest zero), so the data area starts aligned:
  - `[WRITE_INDEX]` bytes the producer has written, ever, modulo 2^32;
  - `[READ_INDEX]` bytes the consumer has taken, ever, modulo 2^32;
  - `[CLOSED]` 1 once the producer has written its last byte (EOF);
  - `[CAPACITY]` the data area's length in bytes, a power of two;
  - `[SIGNAL]` a counter the producer bumps with `Atomics.add` after every
    write and at close: the word a reader waits on.
- The data area from byte 32: byte number `i` is at `32 + (i % capacity)`.
- Bytes available to read: `(write - read) >>> 0`; room to write:
  `capacity - available`.
- The producer copies bytes in, `Atomics.store`s WRITE_INDEX, then
  `Atomics.add`s SIGNAL and `Atomics.notify`s it; at EOF it stores
  CLOSED = 1, then adds to and notifies SIGNAL. With no room it waits on
  READ_INDEX, which every take changes.
- The consumer copies bytes out, then `Atomics.store`s READ_INDEX and
  `Atomics.notify`s it. With nothing to read and CLOSED 0 it waits on
  SIGNAL with the value it read BEFORE it looked: `Atomics.wait` for a
  blocking read, `Atomics.waitAsync` for the run's `process.stdin`. A wait
  on WRITE_INDEX lost a close that landed between the look and the wait,
  because close leaves WRITE_INDEX as it was; every event changes SIGNAL.

## Type Declaration

### CAPACITY

> `readonly` **CAPACITY**: `3` = `3`

### CLOSED

> `readonly` **CLOSED**: `2` = `2`

### HEADER\_BYTES

> `readonly` **HEADER\_BYTES**: `32` = `32`

Where the data area begins, in bytes.

### HEADER\_WORDS

> `readonly` **HEADER\_WORDS**: `8` = `8`

The header's words, used and reserved.

### READ\_INDEX

> `readonly` **READ\_INDEX**: `1` = `1`

### SIGNAL

> `readonly` **SIGNAL**: `4` = `4`

### WRITE\_INDEX

> `readonly` **WRITE\_INDEX**: `0` = `0`
