import type { ProcessIdentity } from './process-registry';
import type { NativeStreamDescriptor } from './native-stream-owner';
import type { RunStreams } from './shims/child_process';
import type { VirtualFS } from './virtual-fs';

/** Trusted launch data, before Node options or the script execute in a realm. */
export interface NodeProcessLaunch {
  token: string;
  identity: ProcessIdentity;
  /** Arguments after the Node executable, preserving each parsed word. */
  argv: readonly string[];
  cwd: string;
  /** This entry's filesystem view, including any host-prepared entry wrapper. */
  filesystem: VirtualFS;
  env: Record<string, string>;
  stdin?: string;
  stdinStream?: AsyncIterable<Uint8Array>;
  streams?: RunStreams;
  inherited: readonly { fd: number; handle: NativeStreamDescriptor }[];
}

export interface NodeProcessHost {
  run(launch: NodeProcessLaunch): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

let host: NodeProcessHost | undefined;
let installed = false;
let started = false;
let localToken: string | undefined;
let localStarted = false;

export function nodeProcessHostInstalled(): boolean { return installed; }

const HostTransformStream = globalThis.TransformStream;
const HostTextEncoder = globalThis.TextEncoder;

/** Adapt the engine's push sink to the worker bridge's pull-based input. */
export function nodeProcessInput(streams: RunStreams | undefined): {
  stream?: AsyncIterable<Uint8Array>;
  dispose(): void;
} {
  if (streams?.stdinStream) return { stream: streams.stdinStream, dispose() {} };
  if (!streams || (!streams.stdinOpen && !streams.held)) return { dispose() {} };
  let inputController!: TransformStreamDefaultController<Uint8Array>;
  const pipe = new HostTransformStream<Uint8Array, Uint8Array>({
    start(controller) { inputController = controller; },
  });
  const writer = pipe.writable.getWriter();
  // Cancellation is delivered through the readable side and pending writes.
  // The host's bookkeeping promise must not become a guest rejection.
  void writer.closed.catch(() => {});
  const encoder = new HostTextEncoder();
  let disposed = false;
  let ended = false;
  const write = (chunk: string | Uint8Array | null): Promise<void> => {
    if (chunk === null) {
      if (ended) return Promise.resolve();
      ended = true;
      return writer.close();
    }
    if (ended || disposed) return Promise.reject(new Error('Node process input is closed.'));
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk);
    return writer.write(bytes);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    streams.signal?.removeEventListener('abort', dispose);
    // Error both sides, which also releases a write waiting for readable
    // demand. Aborting only the writer can wait behind that blocked write.
    inputController.error(streams.signal?.reason ?? new Error('Node process input stopped.'));
  };
  streams.signal?.addEventListener('abort', dispose, { once: true });
  if (streams.signal?.aborted) dispose();
  streams.stdin = {
    emit() {},
    // The host's legacy sendInput is fire-and-forget. Forked pipes use the
    // acknowledged door below and stop reading while its promise is pending.
    push(chunk) { void write(chunk).catch(dispose); return (writer.desiredSize ?? 0) > 0; },
    writeAsync: write,
  };
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        const reader = pipe.readable.getReader();
        void reader.closed.catch(() => {});
        let completed = false;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) { completed = true; return; }
            yield next.value;
          }
        } finally { reader.releaseLock(); if (!completed) dispose(); }
      },
    },
    dispose,
  };
}

/** Host bootstrap only. A process worker admits exactly one local Node entry. */
export function installNodeProcessHost(next: NodeProcessHost, token?: string): void {
  if (installed || started) throw new Error('Node process host must be installed once before Node execution.');
  if (typeof next?.run !== 'function' || (token !== undefined && (typeof token !== 'string' || !token.length))) {
    throw new Error('Invalid Node process host.');
  }
  host = next;
  localToken = token;
  installed = true;
}

/** Called by the common Node command entry, including engine-first forks. */
export function nodeProcessHostFor(token: string | null): NodeProcessHost | undefined {
  started = true;
  if (!host) return undefined;
  if (token === null) throw new Error('Isolated Node execution requires a named run.');
  if (token !== localToken) return host;
  if (localStarted) throw new Error('This worker has already executed its admitted Node process.');
  localStarted = true;
  return undefined;
}
