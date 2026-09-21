/**
 * async_hooks shim - Async tracking is not available in browser
 */

import { forGuestRealm, takeFromHost } from '../host-globals';

export class AsyncResource {
  constructor(_type: string, _options?: object) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInAsyncScope<T>(fn: (...args: any[]) => T, thisArg?: unknown, ...args: any[]): T {
    return fn.apply(thisArg, args);
  }

  emitDestroy(): this { return this; }
  asyncId(): number { return 0; }
  triggerAsyncId(): number { return 0; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static bind<T extends (...args: any[]) => any>(fn: T, _type?: string): T {
    return fn;
  }
}

/**
 * `AsyncLocalStorage.snapshot()` captures every storage's current store and
 * answers a function that runs a call inside that capture, which Next's
 * request-store constructors use to carry a request's context into the work
 * they schedule. These storages are store slots with no such capture; every
 * storage registers itself, and a snapshot is the slots as they are, restored
 * around the call and put back after.
 */
const __substrateAsyncLocalStorages = new Set<AsyncLocalStorage<unknown>>();

export class AsyncLocalStorage<T> {
  private store: T | undefined;

  constructor() {
    __substrateAsyncLocalStorages.add(this as AsyncLocalStorage<unknown>);
  }

  static snapshot() {
    const captured = new Map<AsyncLocalStorage<unknown>, unknown>();
    for (const storage of __substrateAsyncLocalStorages) captured.set(storage, storage.store);
    return (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      const previous = new Map<AsyncLocalStorage<unknown>, unknown>();
      for (const [storage, store] of captured) { previous.set(storage, storage.store); storage.store = store; }
      try {
        return callback(...args);
      } finally {
        for (const [storage, store] of previous) storage.store = store;
      }
    };
  }
  static bind(callback: (...args: unknown[]) => unknown) {
    const snapshot = AsyncLocalStorage.snapshot();
    return (...args: unknown[]) => snapshot(callback, ...args);
  }

  disable(): void {}

  getStore(): T | undefined {
    return this.store;
  }

  /**
   * A store entered for an async callback used to be left the moment the
   * callback returned its promise, so the first `await` inside a Server Action
   * lost Next's request store and `cookies()` was "outside a request scope". A
   * tab has no async_hooks and no AsyncContext, and an `await` of a native
   * promise bypasses any `then` a patch could install, so the continuations
   * cannot be followed. What can be done honestly is keep the store current
   * until the callback's promise settles: exact for one run at a time, and
   * last-entered-wins where two async runs overlap.
   */
  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const prev = this.store;
    this.store = store;
    let result;
    try {
      result = callback(...args);
    } catch (error) {
      this.store = prev;
      throw error;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      const restore = () => { if (this.store === store) this.store = prev; };
      (result as unknown as Promise<unknown>).then(restore, restore);
      return result;
    }
    this.store = prev;
    return result;
  }

  exit<R>(callback: () => R): R {
    const prev = this.store;
    this.store = undefined;
    try {
      return callback();
    } finally {
      this.store = prev;
    }
  }

  enterWith(store: T): void {
    this.store = store;
  }
}

/**
 * Node carries an AsyncLocalStorage store into every continuation a program
 * schedules: a timer, an immediate, a microtask, a nextTick, a promise
 * callback. A tab has no async hooks, so each of those is wrapped once to
 * capture the stores current when it was scheduled and restore them when it
 * runs. A native `await` is the one continuation this cannot follow, which
 * `run` covers by holding its store until the callback settles. React's
 * server renderer schedules its work on immediates and promises, and read
 * Next's request store through them.
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
