/**
 * An addon's `uv_async_send` queue from its threads to its process's main thread (ADR-0011 §3, §4), in a
 * `SharedArrayBuffer` of 32-bit words: the head (the next slot the main side reads), the tail (the next slot a thread
 * writes), the writers' lock, then `SLOTS` slots of three words each, emnapi's message: its kind (0 `setImmediate`,
 * 1 `nextTick`), its callback (a table index) and its data (a pointer). Many threads write, under the lock; the main
 * side alone reads. Nothing in it is the engine's, so a thread's worker imports it with `native-thread.ts` alone.
 */
import { waitAsync } from './stdin-ring';

const HEAD = 0, TAIL = 1, LOCK = 2, FIRST = 4, SLOTS = 1024, WORDS = 3;

/** A new, empty queue. */
export function createNativeQueue(): SharedArrayBuffer {
  return new SharedArrayBuffer((FIRST + SLOTS * WORDS) * 4);
}

/** A thread's send: blocks (a worker may) while the queue is full or another thread is writing. */
export function sendNative(queue: SharedArrayBuffer, kind: number, callback: number, data: number): void {
  const words = new Int32Array(queue);
  while (Atomics.compareExchange(words, LOCK, 0, 1) !== 0) Atomics.wait(words, LOCK, 1);
  try {
    let head = Atomics.load(words, HEAD);
    const tail = Atomics.load(words, TAIL);
    while (tail - head >= SLOTS) {
      Atomics.wait(words, HEAD, head);
      head = Atomics.load(words, HEAD);
    }
    const slot = FIRST + (tail % SLOTS) * WORDS;
    words[slot] = kind;
    words[slot + 1] = callback;
    words[slot + 2] = data;
    Atomics.store(words, TAIL, tail + 1);
    Atomics.notify(words, TAIL);
  } finally {
    Atomics.store(words, LOCK, 0);
    Atomics.notify(words, LOCK, 1);
  }
}

/**
 * The main side: hands each message to `receive` in order, then waits for the next with `Atomics.waitAsync`, no
 * timer, until `stopped()` says the queue's addon is gone. Holds nothing of the loop itself.
 */
export function receiveNative(queue: SharedArrayBuffer, receive: (kind: number, callback: number, data: number) => void,
  stopped: () => boolean): void {
  if (typeof waitAsync !== 'function') throw new Error('this realm has no Atomics.waitAsync, which an addon\'s threads wake it by');
  const words = new Int32Array(queue);
  const drain = (): void => {
    if (stopped()) return;
    try {
      for (let head = Atomics.load(words, HEAD); head !== Atomics.load(words, TAIL); head = Atomics.load(words, HEAD)) {
        const slot = FIRST + (head % SLOTS) * WORDS;
        const kind = words[slot], callback = words[slot + 1], data = words[slot + 2];
        Atomics.store(words, HEAD, head + 1);
        Atomics.notify(words, HEAD);
        receive(kind, callback, data);
      }
    } finally {
      // A callback that throws reports as its caller reports it; the queue keeps being read.
      const head = Atomics.load(words, HEAD);
      const waited = waitAsync!(words, TAIL, head);
      if (waited.async) void waited.value.then(drain);
      else queueMicrotask(drain);
    }
  };
  drain();
}
