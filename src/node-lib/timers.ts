/**
 * Node's `Timeout`, over whatever the realm's timers answer.
 *
 * Node's timers answer an object -- `ref`, `unref`, `hasRef`, `refresh`, and a
 * primitive conversion to the id -- and Node's own files rely on it:
 * `lib/_http_server.js` writes `setInterval(...).unref()` the moment a server
 * listens. A browser realm answers a number, so the object has to be built
 * here. Two readers need the same one: a guest's global timers, counted
 * against the run's loop in `src/runtime.ts`, and the `timers` module a
 * vendored file requires, in `src/node-lib/public-modules.ts`. They must agree
 * on the shape, because a timer made through one is cleared through the other.
 *
 * This file imports nothing, so both can read it.
 */

/** Node's `Timeout` over a browser's numeric id; anything else is already a handle. */
export function nodeTimeout(id: unknown): unknown {
  if (typeof id !== "number") return id;
  const timeout = {
    _id: id,
    ref() { return timeout; },
    unref() { return timeout; },
    hasRef() { return true; },
    refresh() { return timeout; },
    [Symbol.toPrimitive]() { return id; },
  };
  return timeout;
}

/** The realm's own id inside a {@link nodeTimeout}, for the clear that takes one. */
export function timerHandleOf(id: unknown): unknown {
  return id && typeof id === "object" && "_id" in (id as object) ? (id as { _id: unknown })._id : id;
}

/** Native timers surface shared by both builtin loaders, fresh for each graph. */
export function createTimersModule(owned?: {
  setTimeout(fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown;
  clearInterval(id: unknown): void;
}) {
  const schedule = owned?.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancel = owned?.clearTimeout ?? ((id: unknown) => globalThis.clearTimeout(timerHandleOf(id) as number));
  // Node's legacy timer list API, deprecated (DEP0095) and still exported:
  // an object with `_onTimeout` is enrolled for a duration, made active to
  // start or restart its countdown, and unenrolled to stop it.
  type Enrolled = { _onTimeout?: () => void; _idleTimeout?: number; _idleTimeoutId?: unknown };
  const unenroll = (item: Enrolled): void => {
    if (item._idleTimeoutId) cancel(item._idleTimeoutId);
    item._idleTimeoutId = null;
    item._idleTimeout = -1;
  };
  const enroll = (item: Enrolled, msecs: number): void => {
    if (item._idleTimeoutId) cancel(item._idleTimeoutId);
    item._idleTimeoutId = null;
    item._idleTimeout = msecs;
  };
  const active = (item: Enrolled): void => {
    const msecs = item._idleTimeout;
    if (typeof msecs !== 'number' || msecs < 0) return;
    if (item._idleTimeoutId) cancel(item._idleTimeoutId);
    item._idleTimeoutId = schedule(() => { item._idleTimeoutId = null; if (typeof item._onTimeout === 'function') item._onTimeout(); }, msecs);
  };
  const abortError = () => {
    const error = new Error("The operation was aborted") as Error & { code?: string };
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    return error;
  };
  // timers/promises.setInterval was the global setInterval, which answers a
  // handle rather than the async generator Node does, so "for await" over it
  // never yielded; setTimeout dropped the value it was given, and neither took
  // a signal.
  const timersPromises = {
    setTimeout: (delay: any, value: any, options: any) => new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) { reject(abortError()); return; }
      const onAbort = () => { cancel(handle); reject(abortError()); };
      const handle = schedule(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, delay);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    }),
    setImmediate: (value: any, options: any) => timersPromises.setTimeout(0, value, options),
    setInterval: async function* setInterval(delay: any, value: any, options: any) {
      const signal = options && options.signal;
      for (;;) {
        await timersPromises.setTimeout(delay, void 0, options);
        if (signal && signal.aborted) return;
        yield value;
      }
    },
    scheduler: {
      wait: (delay: any, options: any) => timersPromises.setTimeout(delay, void 0, options),
      yield: () => timersPromises.setTimeout(0, void 0, void 0)
    }
  };
  return {
    setTimeout(fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) {
      return nodeTimeout(globalThis.setTimeout(fn as () => void, ms, ...rest));
    },
    clearTimeout(id: unknown) { return globalThis.clearTimeout(timerHandleOf(id) as number); },
    setInterval(fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) {
      return nodeTimeout(globalThis.setInterval(fn as () => void, ms, ...rest));
    },
    clearInterval(id: unknown) { return globalThis.clearInterval(timerHandleOf(id) as number); },
    setImmediate(fn: (...a: unknown[]) => void, ...args: unknown[]) {
      const realm = globalThis as unknown as { setImmediate?: (fn: (...a: unknown[]) => void, ...args: unknown[]) => unknown };
      return nodeTimeout(realm.setImmediate
        ? realm.setImmediate(fn, ...args)
        : globalThis.setTimeout(fn as () => void, 0, ...args));
    },
    clearImmediate(id: unknown) {
      const realm = globalThis as unknown as { clearImmediate?: (id: unknown) => void };
      const handle = timerHandleOf(id);
      return realm.clearImmediate ? realm.clearImmediate(handle) : globalThis.clearTimeout(handle as number);
    },
    ...(owned ? {
      ...owned,
      setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => owned.setTimeout(fn, 0, ...args),
      clearImmediate: owned.clearTimeout,
    } : {}),
    active, enroll, unenroll, promises: timersPromises,
  };
}
