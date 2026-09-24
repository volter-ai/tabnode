/**
 * The internals Node's `net` names that are neither vendored nor a binding:
 * async ids, timers, stream defaults, the option table, and the three
 * one-line answers (`assert`, `hasObserver`, `isBuildingSnapshot`).
 *
 * Each object holds exactly the names the vendored files destructure.
 */

/**
 * `internal/async_hooks`. The engine has no async-hooks graph, so an id is a
 * number nobody follows and a trigger scope is the call itself. The two
 * symbols matter and are real: `owner_symbol` is how a handle finds its
 * stream — `onStreamRead` reads `this[owner_symbol]` on every chunk — and
 * `async_id_symbol` is where `net.js` keeps a socket's id.
 */
let nextAsyncId = 1;
const symbols = {
  async_id_symbol: Symbol('async_id_symbol'),
  trigger_async_id_symbol: Symbol('trigger_async_id_symbol'),
  owner_symbol: Symbol('owner_symbol'),
  init_symbol: Symbol('init_symbol'),
  destroy_symbol: Symbol('destroy_symbol'),
  async_id_fields: Symbol('async_id_fields'),
};

export const internalAsyncHooks = {
  symbols,
  newAsyncId: (): number => nextAsyncId++,
  /**
   * Node's `getOrSetAsyncId`: the id an object already carries, or a new one
   * put on it. `_http_server.js` asks it of every socket it accepts, to name
   * the scope the connection listener runs in.
   */
  getOrSetAsyncId: (object: Record<symbol, unknown>): number => {
    const key = symbols.async_id_symbol;
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key] as number;
    object[key] = nextAsyncId++;
    return object[key] as number;
  },
  getDefaultTriggerAsyncId: (): number => 0,
  defaultTriggerAsyncIdScope: <A extends unknown[], R>(
    _triggerAsyncId: number, block: (...args: A) => R, ...args: A
  ): R => block(...args),
  initHooksExist: (): boolean => false,
  afterHooksExist: (): boolean => false,
  destroyHooksExist: (): boolean => false,
  emitInit: (): void => {},
  emitBefore: (): void => {},
  emitAfter: (): void => {},
  emitDestroy: (): void => {},
  hasAsyncIdStack: (): boolean => false,
  registerDestroyHook: (): void => {},
};

/**
 * Node's `AsyncResource`, which `events.js` extends to build
 * `EventEmitterAsyncResource`. A tab has no async-hooks graph, so an id is a
 * number nobody follows -- but it is a real positive id, because a program
 * that asks `asyncId` of a resource, as Node's own tests do, must see one.
 * Served through `require('async_hooks')` so the vendored file can extend it;
 * the class lives here, never in that file.
 */
let nextAsyncResourceId = 1;
export class AsyncResource {
  #asyncId: number;
  #triggerAsyncId: number;

  constructor(_type: string, options?: { triggerAsyncId?: number; requireManualDestroy?: boolean }) {
    this.#asyncId = nextAsyncResourceId++;
    this.#triggerAsyncId = options?.triggerAsyncId ?? 0;
  }

  runInAsyncScope<T>(fn: (...args: never[]) => T, thisArg?: unknown, ...args: never[]): T {
    return fn.apply(thisArg, args);
  }

  emitDestroy(): this { return this; }
  asyncId(): number { return this.#asyncId; }
  triggerAsyncId(): number { return this.#triggerAsyncId; }

  static bind<T extends (...args: never[]) => unknown>(fn: T, _type?: string): T {
    return fn;
  }
}

/**
 * `internal/timers`. Only `setStreamTimeout` in
 * `internal/stream_base_commons.js` uses it, for `socket.setTimeout`, and
 * Node's timer for that is unref'd: a socket's idle timeout never holds a
 * process open. The engine counts a guest's own timers to decide whether a
 * program is still working, and a timer made here is made with the realm's
 * own `setTimeout` rather than the guest's view of it, so it is not counted —
 * which is exactly what unref'd means.
 */
const kTimeout = Symbol('timeout');

/** The realm's own timer, never the guest's counted one. */
function realmSetTimeout(fn: () => void, ms: number): unknown {
  const realm = globalThis as unknown as {
    __browserRuntimeNativeSetTimeout?: (fn: () => void, ms: number) => unknown;
  };
  return (realm.__browserRuntimeNativeSetTimeout ?? globalThis.setTimeout).call(globalThis, fn, ms);
}
function realmClearTimeout(id: unknown): void {
  const realm = globalThis as unknown as {
    __browserRuntimeNativeClearTimeout?: (id: unknown) => void;
  };
  (realm.__browserRuntimeNativeClearTimeout ?? globalThis.clearTimeout).call(globalThis, id as number);
}

/**
 * What `setUnrefTimeout` answers: a timer that can be refreshed in place, as
 * Node's `Timeout` can, and that `timers.clearTimeout` here knows how to stop.
 */
export class UnrefTimeout {
  private id: unknown = null;
  private readonly onTimeout: () => void;
  private readonly msecs: number;

  constructor(onTimeout: () => void, msecs: number) {
    this.onTimeout = onTimeout;
    this.msecs = msecs;
    this.id = realmSetTimeout(() => { this.id = null; this.onTimeout(); }, msecs);
  }

  refresh(): this {
    if (this.id !== null) realmClearTimeout(this.id);
    this.id = realmSetTimeout(() => { this.id = null; this.onTimeout(); }, this.msecs);
    return this;
  }

  stop(): void {
    if (this.id !== null) realmClearTimeout(this.id);
    this.id = null;
  }

  ref(): this { return this; }
  unref(): this { return this; }
  hasRef(): boolean { return false; }
}

export const TIMEOUT_MAX = 2 ** 31 - 1;

export const internalTimers = {
  kTimeout,
  TIMEOUT_MAX,
  setUnrefTimeout: (fn: () => void, msecs: number): UnrefTimeout => new UnrefTimeout(fn, msecs),
  /** Node's `getTimerDuration`: a number in range, and 1 for anything under it. */
  getTimerDuration(msecs: unknown, name: string): number {
    if (typeof msecs !== 'number') {
      throw Object.assign(new TypeError(`The "${name}" argument must be of type number. Received ${typeof msecs}`), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    if (msecs < 0 || !Number.isFinite(msecs)) {
      throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be a non-negative finite number. Received ${msecs}`), { code: 'ERR_OUT_OF_RANGE' });
    }
    if (msecs === 0) return 0;
    if (msecs > TIMEOUT_MAX) return 1;
    return msecs < 1 ? 1 : msecs;
  },
};

/** `internal/streams/state`: Node's default high-water marks. */
export const internalStreamsState = {
  getDefaultHighWaterMark: (objectMode?: boolean): number => (objectMode ? 16 : 65536),
  setDefaultHighWaterMark: (): void => {},
};

/** `internal/process/task_queues`: the realm's own microtask queue. */
export const internalTaskQueues = {
  queueMicrotask: (fn: () => void): void => queueMicrotask(fn),
  setHasTickScheduled: (): void => {},
  runNextTicks: (): void => {},
};

/** `internal/event_target`: the one symbol `abort_listener.js` reads. */
// Registry symbols, not unique ones: the engine's bundle can be evaluated
// more than once in a realm -- a page's copy and a worker's -- and each
// evaluation would otherwise mint its own key. The default below was defined
// under one key and `events.js` read another, so a fresh `EventTarget`
// answered nothing while one that had been set answered fine.
const kEventsSymbol = Symbol.for('nodejs.event_target.events');
// Every `EventTarget` answers the symbol above with an empty map, for the
// reason given on `kEvents` below. One getter on the prototype, installed
// where the binding is defined rather than inside a guest's realm, because
// `events.js` reads it off whatever target it was handed.
if (typeof EventTarget === 'function' && !(kEventsSymbol in EventTarget.prototype)) {
  const empty = new Map<unknown, unknown>();
  Object.defineProperty(EventTarget.prototype, kEventsSymbol, { get: () => empty, configurable: true });
}

export const internalEventTarget = {
  kResistStopPropagation: Symbol('kResistStopPropagation'),
  /** `internal/streams/operators.js` marks its abort listener weak with this. */
  kWeakHandler: Symbol('kWeakHandler'),
  /**
   * Whether a thing is an `EventTarget`. `events.js` asks before it treats a
   * value as one -- `once`, `on`, `getEventListeners` and `setMaxListeners`
   * all take either an emitter or a target. Node's own `EventTarget` is a
   * class in `internal/event_target.js`; the engine's is the realm's, which
   * is where that class comes from in the first place.
   */
  isEventTarget: (value: unknown): boolean =>
    typeof EventTarget === 'function' && value instanceof EventTarget,
  /**
   * The map Node keeps its own EventTarget's listeners in.
   *
   * THE LOSS, named: the realm's `EventTarget` keeps its listeners where no
   * JavaScript can reach them. The DOM has no way to ask what is listening --
   * `addEventListener` is a door in, and there is no door out -- so
   * `events.getEventListeners(target)` cannot answer for one. It reads this
   * map unguarded, so every target answers with an empty one: the call
   * reports no listeners rather than throwing at a program that asked a fair
   * question. An `EventEmitter` is unaffected; it answers from its own
   * `listeners()`, which is the branch above this one in `events.js`.
   */
  kEvents: kEventsSymbol,
  kNewListener: Symbol('kNewListener'),
  kRemoveListener: Symbol('kRemoveListener'),
};

/**
 * `internal/options`: the command-line options Node's `net`, `http` and
 * `util` read. The engine takes no command line of its own, so each is
 * Node's own default.
 */
const optionValues: Record<string, unknown> = {
  '--network-family-autoselection': true,
  '--network-family-autoselection-attempt-timeout': 250,
  '--no-deprecation': false,
  '--throw-deprecation': false,
  '--trace-deprecation': false,
  '--pending-deprecation': false,
  '--report-uncaught-exception': false,
  '--experimental-print-required-tla': false,
  '--max-http-header-size': 16 * 1024,
  '--insecure-http-parser': false,
  '--enable-source-maps': false,
};

export const internalOptions = {
  getOptionValue: (name: string): unknown => optionValues[name],
  getEmbedderOptions: () => ({ shouldNotRegisterESMLoader: false, noGlobalSearchPaths: false, noBrowserGlobals: false }),
};

/** `internal/perf/observe`: nothing observes `net` in the engine. */
export const internalPerfObserve = {
  hasObserver: (): boolean => false,
  startPerf: (): void => {},
  stopPerf: (): void => {},
};

/** `internal/assert`: Node's internal assertion, which no program should ever see. */
export function internalAssert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(`Internal assertion failed${message ? `: ${message}` : ''}`);
}
internalAssert.fail = (message?: string): never => {
  throw new Error(`Internal assertion failed${message ? `: ${message}` : ''}`);
};
internalAssert.ok = internalAssert;

/** `internal/v8/startup_snapshot`: the engine never builds one. */
export const internalStartupSnapshot = {
  namespace: {
    isBuildingSnapshot: (): boolean => false,
    addSerializeCallback: (): void => {},
    addDeserializeCallback: (): void => {},
    setDeserializeMainFunction: (): void => {},
  },
  runDeserializeCallbacks: (): void => {},
};

/**
 * `internal/process/permission`: the engine runs no permission model, so
 * nothing is denied and there are no flags for `child_process.js` to copy
 * into a child's `NODE_OPTIONS`.
 */
export const internalPermission = {
  isEnabled: (): boolean => false,
  has: (): boolean => true,
  availableFlags: (): string[] => [],
};
