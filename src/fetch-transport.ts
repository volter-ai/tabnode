/** Host Fetch I/O uses the same process-owned liveness registry as sockets. */
import type { Process } from './shims/process';
import { __tokenForProcess, __runFor, enterRun, type ProcessToken } from './process-tokens';
import { registerHandle, __adoptHandle, refHandle, unrefHandle, releaseHandle } from './node-lib/binding/handles';

export interface FetchActivity {
  /** One pending transport operation; the returned release is idempotent. */
  hold(): () => void;
  /** EOF/error/cancellation ends ownership, without cancelling completed I/O. */
  release(): void;
}

export interface FetchTransportContext {
  /** Retain cancellation ownership while idle, but do not keep the run alive. */
  begin(cancel: () => void): FetchActivity;
}

export type FetchTransport = (input: RequestInfo | URL, init: RequestInit | undefined, context: FetchTransportContext) => Promise<Response>;
let transport: FetchTransport | undefined;

/** Host-only seam: the adapter reports pending headers/pulls and final cleanup. */
export function installFetchTransport(adapter: FetchTransport): () => void {
  const previous = transport;
  transport = adapter;
  return () => { if (transport === adapter) transport = previous; };
}

function activity(owner: ProcessToken | null, cancel: () => void): FetchActivity {
  let ended = false;
  let pending = 0;
  const handle = {
    close() {
      if (ended) return;
      release();
      cancel();
    },
  };
  const release = (): void => {
    if (ended) return;
    ended = true;
    releaseHandle(handle);
  };
  registerHandle(handle);
  // Never attribute a delayed request to the last process that happened to run.
  __adoptHandle(handle, owner);
  unrefHandle(handle);
  return {
    hold() {
      if (ended) throw new Error('Fetch request has already ended.');
      pending += 1;
      refHandle(handle);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (--pending === 0 && !ended) unrefHandle(handle);
      };
    },
    release,
  };
}

/** Each process may replace its own fetch; the host adapter remains private. */
export function guestFetch(process: Process, fallback: typeof globalThis.fetch): typeof globalThis.fetch {
  return function fetch(input, init) {
    const adapter = transport;
    if (!adapter) return fallback.call(globalThis, input, init);
    const owner = __tokenForProcess(process);
    const ended = () => owner !== null && __runFor(owner)?.process !== process;
    const stopped = () => new DOMException('The requesting process has ended.', 'AbortError');
    if (ended()) return Promise.reject(stopped());
    const context: FetchTransportContext = { begin(cancel) {
      if (ended()) throw stopped();
      return activity(owner, cancel);
    } };
    const dispatch = () => adapter(input, init, context);
    return owner === null ? dispatch() : enterRun(owner, dispatch);
  };
}
