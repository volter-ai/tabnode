/**
 * An addon's `uv_async_send` queue from its threads to its process's main thread (ADR-0011 §5), in a
 * `SharedArrayBuffer` of 32-bit words: the read counter (the next slot the main side reads), the write counter (the
 * next slot a thread writes), the writers' lock, the stop word, then `SLOTS` slots of two words each, emnapi's message:
 * its callback (a table index) and its data (a pointer). Many threads write, under the lock; the main side alone reads.
 * The counters wrap modulo 2³²: the fill is their difference as a signed 32-bit number, never more than `SLOTS`, and a
 * slot is a counter's low bits. Nothing in it is the engine's, so a thread's worker imports it with `native-thread.ts`
 * alone.
 */
import { waitAsync } from './stdin-ring';

const HEAD = 0, TAIL = 1, LOCK = 2, STOP = 3, FIRST = 4, SLOTS = 1024, WORDS = 2;

/** A new, empty queue. */
export function createNativeQueue(): SharedArrayBuffer {
  return new SharedArrayBuffer((FIRST + SLOTS * WORDS) * 4);
}

const slotOf = (counter: number): number => FIRST + (counter & (SLOTS - 1)) * WORDS;

/** A thread's send: blocks (a worker may) while the queue is full or another thread is writing; dropped once stopped. */
export function sendNative(queue: SharedArrayBuffer, callback: number, data: number): void {
  const words = new Int32Array(queue);
  while (Atomics.compareExchange(words, LOCK, 0, 1) !== 0) Atomics.wait(words, LOCK, 1);
  try {
    let head = Atomics.load(words, HEAD);
    const tail = Atomics.load(words, TAIL);
    while (((tail - head) | 0) >= SLOTS) {
      if (Atomics.load(words, STOP) !== 0) return;
      Atomics.wait(words, HEAD, head);
      head = Atomics.load(words, HEAD);
    }
    if (Atomics.load(words, STOP) !== 0) return;
    const slot = slotOf(tail);
    words[slot] = callback;
    words[slot + 1] = data;
    Atomics.store(words, TAIL, (tail + 1) | 0);
    Atomics.notify(words, TAIL);
  } finally {
    Atomics.store(words, LOCK, 0);
    Atomics.notify(words, LOCK, 1);
  }
}

/**
 * The main side: hands each message to `receive` in order, then waits for the next with `Atomics.waitAsync`, no
 * timer, until the queue is stopped. Holds nothing of the loop itself.
 */
export function receiveNative(queue: SharedArrayBuffer, receive: (callback: number, data: number) => void): void {
  if (typeof waitAsync !== 'function') throw new Error('this realm has no Atomics.waitAsync, which an addon\'s threads wake it by');
  const words = new Int32Array(queue);
  const drain = (): void => {
    if (Atomics.load(words, STOP) !== 0) return;
    try {
      for (let head = Atomics.load(words, HEAD); head !== Atomics.load(words, TAIL) && Atomics.load(words, STOP) === 0;
        head = Atomics.load(words, HEAD)) {
        const slot = slotOf(head);
        const callback = words[slot], data = words[slot + 1];
        Atomics.store(words, HEAD, (head + 1) | 0);
        Atomics.notify(words, HEAD);
        receive(callback, data);
      }
    } finally {
      // A callback that throws reports as its caller reports it; the queue keeps being read until it is stopped.
      if (Atomics.load(words, STOP) === 0) {
        const waited = waitAsync!(words, TAIL, Atomics.load(words, HEAD));
        if (waited.async) void waited.value.then(drain);
        else queueMicrotask(drain);
      }
    }
  };
  drain();
}

/**
 * The queue's end, with its process's: the receiver, woken on the write counter, returns without waiting again, and a
 * writer waiting on a full queue is woken and drops its send.
 */
export function stopNative(queue: SharedArrayBuffer): void {
  const words = new Int32Array(queue);
  Atomics.store(words, STOP, 1);
  Atomics.notify(words, TAIL);
  Atomics.notify(words, HEAD);
}
