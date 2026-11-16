/**
 * `internalBinding('task_queue')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's
 * src/node_task_queue.cc and the Environment's TickInfo (src/env.h:470-480), for Node's own
 * `lib/internal/process/task_queues.js` and `lib/internal/process/promises.js`.
 *
 * Node's C++ reads `tickInfo` where a callback scope closes (InternalCallbackScope::Close, src/api/callback.cc): with a
 * tick scheduled or a rejection to warn of it calls the tick callback, `processTicksAndRejections`. The engine closes
 * a scope where its callbacks return (guest-loop.ts `drainGuestNextTicks`, native/node env.c's drain), and calls the
 * tick callback there. What a page's engine has that Node's has not is code that runs in no scope at all, a promise's
 * continuation the browser settled; a tick it schedules is run from a microtask, so `tickInfo`'s two fields are
 * accessors that see the field turn on.
 *
 * Where this differs from Node:
 * - `runMicrotasks` cannot run the realm's microtask queue from inside a call: a page's engine has no checkpoint a
 *   script can call. The microtasks queued by ticks run when the call that runs the ticks returns.
 * - A rejection with no handler is the realm's `unhandledrejection` event (a Node host's `unhandledRejection`), raised
 *   after the microtask checkpoint that left it unhandled, where V8 calls PromiseRejectCallback at the rejection; its
 *   handler added later is `rejectionhandled`. `kPromiseResolveAfterResolved` and `kPromiseRejectAfterResolved` have
 *   no event and are never given.
 */
import { setNodeTickCallback } from '../../guest-loop';
import { realmHost, realmProcess } from '../../system';

/** TickInfo::Fields (src/env.h:476). */
const kHasTickScheduled = 0, kHasRejectionToWarn = 1;
/** v8::PromiseRejectEvent, as NODE_DEFINE_CONSTANT gives them (node_task_queue.cc:172-178). */
const promiseRejectEvents = {
  kPromiseRejectWithNoHandler: 0,
  kPromiseHandlerAddedAfterReject: 1,
  kPromiseResolveAfterResolved: 2,
  kPromiseRejectAfterResolved: 3,
};

const enqueue = globalThis.queueMicrotask.bind(globalThis);

export function createTaskQueueBinding(): Record<string, unknown> {
  const fields = new Uint8Array(2);
  let tickCallback: (() => void) | undefined;
  let checkQueued = false;
  // The ticks of code that runs in no scope: one microtask runs them once the field turns on.
  const runTicks = (): void => {
    if (tickCallback !== undefined && (fields[kHasTickScheduled] === 1 || fields[kHasRejectionToWarn] === 1)) tickCallback();
  };
  const check = (): void => {
    if (checkQueued) return;
    checkQueued = true;
    enqueue(() => { checkQueued = false; runTicks(); });
  };
  const field = (index: number): PropertyDescriptor => ({
    enumerable: true,
    get: () => fields[index],
    set: (value: unknown) => {
      const was = fields[index];
      fields[index] = Number(value) ? 1 : 0;
      if (was === 0 && fields[index] === 1) check();
    },
  });
  const tickInfo = Object.defineProperties({}, { 0: field(kHasTickScheduled), 1: field(kHasRejectionToWarn), length: { value: 2 } });

  return {
    tickInfo,
    enqueueMicrotask(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('enqueueMicrotask: a function');
      enqueue(callback as () => void);
    },
    runMicrotasks(): void {},
    setTickCallback(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('setTickCallback: a function');
      tickCallback = callback as () => void;
      setNodeTickCallback(runTicks);
    },
    promiseRejectEvents,
    setPromiseRejectCallback(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('setPromiseRejectCallback: a function');
      listenForRejections(callback as (type: number, promise: unknown, reason: unknown) => void);
    },
  };
}

/** The realm's own reports of a rejection nobody handled, and of a handler added after one, as V8's events. */
function listenForRejections(callback: (type: number, promise: unknown, reason: unknown) => void): void {
  const report = (type: number, promise: unknown, reason: unknown): void => {
    try { callback(type, promise, reason); }
    catch (error) {
      // "Exception in PromiseRejectCallback:" and the exception, printed as Node prints a caught one.
      const said = error instanceof Error ? error.stack ?? String(error) : String(error);
      (globalThis as { console?: { error?: (text: string) => void } }).console?.error?.(`Exception in PromiseRejectCallback:\n${said}`);
    }
  };
  if (realmHost === 'worker' || realmHost === 'window') {
    const target = globalThis as unknown as EventTarget;
    target.addEventListener('unhandledrejection', (event: Event) => {
      const rejection = event as PromiseRejectionEvent;
      event.preventDefault();
      report(promiseRejectEvents.kPromiseRejectWithNoHandler, rejection.promise, rejection.reason);
    });
    target.addEventListener('rejectionhandled', (event: Event) => {
      report(promiseRejectEvents.kPromiseHandlerAddedAfterReject, (event as PromiseRejectionEvent).promise, undefined);
    });
    return;
  }
  if (realmProcess) {
    realmProcess.on('unhandledRejection', (reason: unknown, promise: unknown) => {
      report(promiseRejectEvents.kPromiseRejectWithNoHandler, promise, reason);
    });
    realmProcess.on('rejectionHandled', (promise: unknown) => {
      report(promiseRejectEvents.kPromiseHandlerAddedAfterReject, promise, undefined);
    });
  }
}
