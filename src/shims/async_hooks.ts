/**
 * async_hooks shim: AsyncLocalStorage and AsyncResource carry context the way
 * Node's do; the hooks themselves are not available in a browser.
 */

import { forGuestRealm, takeFromHost } from '../host-globals';

/**
 * The context a continuation runs in: every storage's store, as one frame.
 * `run` makes a new frame for its callback and puts the old one back when the
 * callback returns, as Node's does; a frame is never changed after it is
 * made, so a snapshot is the frame itself.
 *
 * A tab has no async hooks and no AsyncContext, and an `await` of a native
 * promise bypasses any `then` a patch installs. The engine follows it at the
 * source instead: each module body it compiles captures its async function's
 * frame on entry and restores it where the function resumes (after each
 * `await`, in a `catch` or `finally`, around a `for await`), through
 * `__substrateResume` and `__substrateRestore` below. A continuation's frame
 * holds only for the turn it runs in; the next turn starts from the root, as
 * a macrotask of Node's does. Code the engine did not compile (its own) runs
 * in whichever frame is current when it is called.
 */
type ContextFrame = ReadonlyMap<AsyncLocalStorage<unknown>, unknown>;
const ROOT_FRAME: ContextFrame = new Map();
let currentFrame: ContextFrame = ROOT_FRAME;
const nativeQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
let resetQueued = false;
const resetFrame = (): void => { resetQueued = false; currentFrame = ROOT_FRAME; };
/** A resumed continuation's frame, current until the turn it runs in ends. */
const resumeFrame = (frame: ContextFrame): void => {
  if (frame === currentFrame) return;
  currentFrame = frame;
  if (!resetQueued) { resetQueued = true; nativeQueueMicrotask(resetFrame); }
};
const withFrame = <R>(frame: ContextFrame, callback: () => R): R => {
  const previous = currentFrame;
  currentFrame = frame;
  try {
    return callback();
  } finally {
    currentFrame = previous;
  }
};

export class AsyncLocalStorage<T> {
  static snapshot() {
    const captured = currentFrame;
    return (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => withFrame(captured, () => callback(...args));
  }
  static bind(callback: (...args: unknown[]) => unknown) {
    const snapshot = AsyncLocalStorage.snapshot();
    return (...args: unknown[]) => snapshot(callback, ...args);
  }

  disable(): void {
    if (!currentFrame.has(this as AsyncLocalStorage<unknown>)) return;
    const next = new Map(currentFrame);
    next.delete(this as AsyncLocalStorage<unknown>);
    currentFrame = next;
  }

  getStore(): T | undefined {
    return currentFrame.get(this as AsyncLocalStorage<unknown>) as T | undefined;
  }

  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const next = new Map(currentFrame);
    next.set(this as AsyncLocalStorage<unknown>, store);
    return withFrame(next, () => callback(...args));
  }

  exit<R>(callback: () => R): R {
    const next = new Map(currentFrame);
    next.delete(this as AsyncLocalStorage<unknown>);
    return withFrame(next, callback);
  }

  enterWith(store: T): void {
    const next = new Map(currentFrame);
    next.set(this as AsyncLocalStorage<unknown>, store);
    currentFrame = next;
  }
}

/** Runs its callbacks in the context it was made in, as Node's does. */
export class AsyncResource {
  private readonly frame = currentFrame;
  constructor(_type: string, _options?: object) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInAsyncScope<T>(fn: (...args: any[]) => T, thisArg?: unknown, ...args: any[]): T {
    return withFrame(this.frame, () => fn.apply(thisArg, args));
  }

  emitDestroy(): this { return this; }
  asyncId(): number { return 0; }
  triggerAsyncId(): number { return 0; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static bind<T extends (...args: any[]) => any>(fn: T, _type?: string): T {
    return AsyncLocalStorage.bind(fn) as T;
  }
}

/**
 * Node carries an AsyncLocalStorage store into every continuation a program
 * schedules: a timer, an immediate, a microtask, a nextTick, a promise
 * callback. A tab has no async hooks, so each of those is wrapped once to
 * capture the stores current when it was scheduled and restore them when it
 * runs. A native `await` is the one continuation this cannot follow: the
 * compiled module body follows it, through the three globals installed here.
 * React's server renderer schedules its work on immediates and promises, and
 * read Next's request store through them.
 *
 * The wrapping is a guest's, not the realm's. It used to run at load, so
 * importing the engine into a Node process replaced that process's own
 * `setTimeout` and `Promise.prototype.then`; it now waits for the first
 * runtime, and `restoreHostGlobals()` puts them back.
 */
forGuestRealm(() => {
  // Wrapped once: a second pass would carry through a carrier.
  if ((globalThis as unknown as Record<string, unknown>).__substrateCarried) return;
  const carried = <T>(callback: T): T => {
    if (typeof callback !== "function") return callback;
    const restore = AsyncLocalStorage.snapshot();
    return function (this: unknown, ...args: unknown[]) { return restore(() => (callback as (...values: unknown[]) => unknown).apply(this, args)); } as T;
  };
  for (const name of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]) {
    const original = (globalThis as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, callback: unknown, ...rest: unknown[]) { return original.call(this, carried(callback), ...rest); };
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
  takeFromHost(globalThis, '__substrateResume', <V>(frame: ContextFrame, value: V): V => { resumeFrame(frame); return value; });
  takeFromHost(globalThis, '__substrateRestore', (frame: ContextFrame): void => { resumeFrame(frame); });
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

export default {
  AsyncResource,
  AsyncLocalStorage,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};
