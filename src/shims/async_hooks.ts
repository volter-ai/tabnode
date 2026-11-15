/**
 * async_hooks: Node's `AsyncLocalStorage` (its async-context-frame form, Node v24.21.0
 * `lib/internal/async_local_storage/async_context_frame.js`, vendored) and Node's `AsyncResource`, over the engine's
 * context frame; the hooks themselves are not available in a browser.
 */

import { forGuestRealm, takeFromHost } from '../host-globals';
import { withGuestExecution, withGuestCallback, resumeGuestTurn, setGuestTurnEnd, isBindingTask } from '../guest-loop';
import { nodeLibInternalRequire } from '../node-lib/load';

/**
 * THE CONTEXT FRAME (ADR-0018 item 2): the one value Node's `internal/async_context_frame` reads and writes, V8's
 * continuation-preserved embedder data, which Node's `AsyncLocalStorage` keeps every storage's store in (a map of
 * each storage to its store) and Node's timers capture and restore around each callback. A page's engine exposes no
 * such data, so the engine keeps the value here and preserves it where V8 would: each module body it compiles
 * captures its async function's frame on entry and restores it where the function resumes (after each `await`, in a
 * `catch` or `finally`, around a `for await`), through `__substrateResume` and `__substrateRestore` below, and each
 * microtask and `then` callback runs in the frame it was queued in (`carried`). A continuation's frame holds only for
 * the turn it runs in; the next turn starts from none, as a macrotask of Node's does. Code the engine did not compile
 * (its own) runs in whichever frame is current when it is called. `undefined` is V8's own initial value.
 */
let currentFrame: unknown;
let resetQueued = false;
const resetFrame = (): void => { if (!resetQueued) return; resetQueued = false; currentFrame = undefined; };
// The frame is put back where the continuation's turn ends, by the task that ends it (guest-loop.ts): one microtask an
// awaiting turn, where there were two (S2 AC-LC9).
setGuestTurnEnd(resetFrame);
/** A resumed continuation's frame, current until the turn it runs in ends. */
const resumeFrame = (frame: unknown): void => {
  resumeGuestTurn();
  if (frame === currentFrame) return;
  currentFrame = frame;
  resetQueued = true;
};
const withFrame = <R>(frame: unknown, callback: () => R): R => {
  const previous = currentFrame;
  currentFrame = frame;
  try {
    return callback();
  } finally {
    currentFrame = previous;
  }
};

/** `internalBinding('async_context_frame')`: V8's continuation-preserved embedder data, here the engine's frame. */
export const asyncContextFrameBinding = {
  getContinuationPreservedEmbedderData: (): unknown => currentFrame,
  setContinuationPreservedEmbedderData: (frame: unknown): void => { currentFrame = frame; },
};

/** The calling context's frame, and a call made in a frame taken earlier: for the engine's own deferred answers. */
export function contextFrame(): unknown { return currentFrame; }
export function inContextFrame<R>(frame: unknown, callback: () => R): R { return withFrame(frame, callback); }

/** Node's `AsyncLocalStorage`, as its `async_hooks` answers it with `--async-context-frame` on (Node 24's default). */
type AsyncLocalStorageClass = new <T>(options?: { defaultValue?: T; name?: unknown }) => {
  getStore(): T | undefined; run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R;
};
export function nodeAsyncLocalStorage(require: (name: string) => unknown = nodeLibInternalRequire): AsyncLocalStorageClass {
  // lib/async_hooks.js:297-301: reading `enabled` is what makes the frame active (internal/async_context_frame.js
  // `checkEnabled`), before any storage is made.
  if (!(require('internal/async_context_frame') as { enabled: boolean }).enabled) {
    throw new Error('tabnode: --async-context-frame is off, and only its AsyncLocalStorage is Node\'s here');
  }
  return require('internal/async_local_storage/async_context_frame') as AsyncLocalStorageClass;
}

const asyncIdSymbol = Symbol('asyncId');
const triggerAsyncIdSymbol = Symbol('triggerAsyncId');
const contextFrameSymbol = Symbol('context_frame');
let nextAsyncResourceId = 1;
/**
 * Node's `AsyncResource` (lib/async_hooks.js:180-292): it takes the context frame when it is made and runs its
 * callbacks in it, as Node's does over `internal/async_context_frame`. A tab has no async-hooks graph, so an id is a
 * number nobody follows, but a real positive one, because a program that asks `asyncId` of a resource, as Node's own
 * tests do, must see one. `events.js` extends it to build `EventEmitterAsyncResource`, and Node's `AsyncLocalStorage`
 * binds through it.
 */
export class AsyncResource {
  [asyncIdSymbol]: number;
  [triggerAsyncIdSymbol]: number;
  [contextFrameSymbol]: unknown;

  constructor(type: string, options?: number | { triggerAsyncId?: number; requireManualDestroy?: boolean }) {
    if (typeof type !== 'string') {
      throw Object.assign(new TypeError(`The "type" argument must be of type string. Received ${typeof type}`), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    const triggerAsyncId = typeof options === 'number' ? options : options?.triggerAsyncId ?? 0;
    if (!Number.isSafeInteger(triggerAsyncId) || triggerAsyncId < -1) {
      throw Object.assign(new RangeError(`Invalid triggerAsyncId value: ${triggerAsyncId}`), { code: 'ERR_INVALID_ASYNC_ID' });
    }
    this[contextFrameSymbol] = currentFrame;
    this[asyncIdSymbol] = nextAsyncResourceId++;
    this[triggerAsyncIdSymbol] = triggerAsyncId;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInAsyncScope<T>(fn: (...args: any[]) => T, thisArg?: unknown, ...args: any[]): T {
    return withGuestExecution(() => withFrame(this[contextFrameSymbol], () => Reflect.apply(fn, thisArg, args)), 'async-resource', fn);
  }

  emitDestroy(): this { return this; }
  asyncId(): number { return this[asyncIdSymbol]; }
  triggerAsyncId(): number { return this[triggerAsyncIdSymbol]; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bind<F extends (...args: any[]) => any>(fn: F, thisArg?: unknown): F {
    if (typeof fn !== 'function') {
      throw Object.assign(new TypeError(`The "fn" argument must be of type function. Received ${typeof fn}`), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    const resource = this;
    const bound = thisArg === undefined
      ? function (this: unknown, ...args: unknown[]) { return resource.runInAsyncScope(fn, this, ...args); }
      : (...args: unknown[]) => resource.runInAsyncScope(fn, thisArg, ...args);
    Object.defineProperty(bound, 'length', { configurable: true, enumerable: false, value: fn.length, writable: false });
    return bound as F;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static bind<F extends (...args: any[]) => any>(fn: F, type?: string, thisArg?: unknown): F {
    const name = type || (fn as { name?: string }).name;
    return new AsyncResource(name || 'bound-anonymous-fn').bind(fn, thisArg);
  }
}

/**
 * V8 carries its continuation-preserved embedder data into every promise reaction and microtask; Node's timers carry
 * theirs themselves (lib/internal/timers.js, its `async_context_frame` of each Timeout and Immediate). A tab carries
 * none, so the realm's own continuations are wrapped once to run in the frame current when each was queued: a
 * microtask, a `then` callback, and a task the realm's own `setTimeout`, `setInterval` or `setImmediate` queues. A
 * native `await` is the one continuation this cannot follow: the compiled module body follows it, through the three
 * globals installed here.
 *
 * The wrapping is a guest's, not the realm's. It used to run at load, so
 * importing the engine into a Node process replaced that process's own
 * `setTimeout` and `Promise.prototype.then`; it now waits for the first
 * runtime, and `restoreHostGlobals()` puts them back.
 */
/**
 * Where an exception a task callback threw goes while its frame is still current: the run that scheduled it, as Node
 * reports an exception in a timer to that process (process-tokens.ts installs it). True when a run took it.
 */
let routeUncaught: ((error: unknown) => boolean) | undefined;
export function routeUncaughtExceptions(route: (error: unknown) => boolean): void { routeUncaught = route; }
/** An exception a loop callback threw, reported to the run whose frame is current (binding/timers.ts). */
export function reportUncaughtInFrame(error: unknown): boolean { return routeUncaught?.(error) === true; }

forGuestRealm(() => {
  // Wrapped once: a second pass would carry through a carrier.
  if ((globalThis as unknown as Record<string, unknown>).__substrateCarried) return;
  // `task`: a timer, immediate or microtask, whose throw is its run's uncaught exception; a `then` callback's throw
  // rejects its promise instead, and is left to.
  // `kind`: which door the callback came through, for the realm's entry account (guest-loop.ts, S2 R27).
  const carried = <T>(callback: T, task = false, bindingCallback = false, kind = 'then'): T => {
    if (typeof callback !== "function") return callback;
    const frame = currentFrame;
    const call = callback as (...values: unknown[]) => unknown;
    // The engine's own deferred work for a binding is not program code: it takes no bracket here (guest-loop.ts).
    const enter = bindingCallback ? withGuestCallback : isBindingTask(callback) ? (<R>(run: () => R, _kind?: string, _source?: unknown): R => run()) : withGuestExecution;
    return function (this: unknown, ...args: unknown[]) {
      return enter(() => withFrame(frame, () => {
        if (!task) return call.apply(this, args);
        try { return call.apply(this, args); }
        catch (error) { if (routeUncaught?.(error)) return undefined; throw error; }
      }), kind, call);
    } as T;
  };
  for (const name of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]) {
    const original = (globalThis as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, callback: unknown, ...rest: unknown[]) { return original.call(this, carried(callback, true, name !== 'queueMicrotask', name), ...rest); };
    Object.defineProperty(wrapped, "name", { value: name });
    takeFromHost(globalThis, name, wrapped);
  }
  const then = Promise.prototype.then;
  const carriedThen = function <TFulfilled = unknown, TRejected = never>(
    this: Promise<unknown>,
    onFulfilled?: ((value: unknown) => TFulfilled | PromiseLike<TFulfilled>) | null,
    onRejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<TFulfilled | TRejected> { return then.call(this, carried(onFulfilled), carried(onRejected)) as Promise<TFulfilled | TRejected>; };
  takeFromHost(Promise.prototype, 'then', carriedThen);
  takeFromHost(globalThis, '__substrateCarried', carried);
  // An async function's frame, taken on entry; put back where it resumes.
  takeFromHost(globalThis, '__substrateContext', () => currentFrame);
  takeFromHost(globalThis, '__substrateResume', <V>(frame: unknown, value: V): V => { resumeFrame(frame); return value; });
  takeFromHost(globalThis, '__substrateRestore', (frame: unknown): void => { resumeFrame(frame); });
});

export interface AsyncHook {
  enable(): this;
  disable(): this;
}

export function createHook(_callbacks: object): AsyncHook {
  return {
    enable(): AsyncHook { return this; },
    disable(): AsyncHook { return this; },
  };
}

export function executionAsyncId(): number {
  return 0;
}

export function executionAsyncResource(): object {
  return {};
}

export function triggerAsyncId(): number {
  return 0;
}

/**
 * The `async_hooks` module of a graph: `AsyncLocalStorage` is that graph's Node class (`require`, a process's builtin
 * graph or the library's), read when it is asked for, since Node's file itself requires this module.
 */
export function asyncHooksModule(require: (name: string) => unknown = nodeLibInternalRequire): Record<string, unknown> {
  const module: Record<string, unknown> = { AsyncResource, createHook, executionAsyncId, executionAsyncResource, triggerAsyncId };
  Object.defineProperty(module, 'AsyncLocalStorage', { enumerable: true, configurable: true, get: () => nodeAsyncLocalStorage(require) });
  return module;
}

export default asyncHooksModule();
