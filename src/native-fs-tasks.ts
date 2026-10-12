/**
 * Asynchronous filesystem completions belong to the loop, not the tick or promise queue.
 * A microtask chain of completed fs requests could finish server initialization and all of its synchronous
 * preload before an incoming request's MessagePort task was delivered (K5). Each operation now takes one host
 * task turn. This changes no synchronous fs operation and cannot interrupt synchronous guest work.
 *
 * Capture the host constructor, but create no port until work is queued. One channel is shared by this realm;
 * native Node ports hold its loop only while work is pending. Guest request ownership lives in the fs binding.
 */
const HostMessageChannel = globalThis.MessageChannel;
type HostPort = MessagePort & { ref?(): void; unref?(): void };
let channel: { port1: HostPort; port2: HostPort } | undefined;
let sequence = 0;
const pending = new Map<number, () => void>();

function taskChannel(): NonNullable<typeof channel> {
  if (channel) return channel;
  const made = new HostMessageChannel();
  const ports = { port1: made.port1 as HostPort, port2: made.port2 as HostPort };
  ports.port1.addEventListener('message', ({ data }: MessageEvent<number>) => {
    const run = pending.get(data);
    pending.delete(data);
    try { run?.(); }
    finally {
      if (pending.size === 0) { ports.port1.unref?.(); ports.port2.unref?.(); }
    }
  });
  ports.port1.start();
  ports.port1.unref?.(); ports.port2.unref?.();
  return channel = ports;
}

/** Queue one operation, returning the cancellation used when its owning process ends. */
export function queueNativeFsTask(run: () => void): () => void {
  const ports = taskChannel();
  const id = ++sequence;
  pending.set(id, run);
  ports.port1.ref?.(); ports.port2.ref?.();
  try { ports.port2.postMessage(id); }
  catch (cause) {
    pending.delete(id);
    if (pending.size === 0) { ports.port1.unref?.(); ports.port2.unref?.(); }
    throw cause;
  }
  return () => {
    pending.delete(id);
    if (pending.size === 0) { ports.port1.unref?.(); ports.port2.unref?.(); }
  };
}
