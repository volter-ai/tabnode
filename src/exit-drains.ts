/**
 * What a process hands over before `process.exit` ends its run: Linux writes a
 * stdio pipe synchronously (libuv sets UV_HANDLE_BLOCKING_WRITES on stdio
 * pipes), so every byte a program wrote before it exited is in the pipe when
 * it is gone. A transport that answers writes later registers a drain here,
 * and the exit runs every one after its 'exit' listeners, before the run ends.
 */
const drains = new Set<() => void>();

export function registerExitDrain(drain: () => void): () => void {
  drains.add(drain);
  return () => { drains.delete(drain); };
}

export function runExitDrains(): void {
  for (const drain of [...drains]) {
    try { drain(); } catch { /* a transport already gone has nothing left to hand over */ }
  }
}
