/**
 * WHAT A PROCESS'S GLOBAL HOLDS, AND HOW A FREE NAME REACHES IT (ADR-0015).
 *
 * Node compiles every builtin and every module inside its process's context, so a free name a file reads is that
 * process's global's, and a name the global does not hold is a `ReferenceError`. The engine runs many processes in
 * one realm and compiled each kind of code with a list of names bound and the rest left to the realm: undici's bundle
 * read the realm's `Buffer`, which a browser worker has not (Rallly: `ReferenceError: Buffer is not defined` at
 * `lib/dispatcher/client-h1.js`), and a guest's `typeof XMLHttpRequest` found the browser's.
 *
 * Here are the name sets every compile site shares, and the objects a free name is resolved through:
 * - a rewritten body reads `__substrateGuestScope.X` (a `ReferenceError` where the global does not hold X) and
 *   `typeof __substrateGuestTypeof.X` (the global itself, so an absent name is "undefined");
 * - code whose names are dynamic runs inside `with (W)`, `W` answering the names the global holds and shadowing the
 *   realm's other names, so nothing a process lacks is found on the realm.
 */

/**
 * The names Node v24.21.0's global holds with no flags that are not ECMAScript's own, as its bootstrap installs them
 * (`internal/bootstrap/node.js`, `internal/bootstrap/web/exposed-wildcard.js`, `exposed-window-or-worker.js`), with
 * `Promise`, `WebAssembly`, `console` and `globalThis`, which the process answers itself. `EventSource`,
 * `localStorage`, `sessionStorage` and `Storage` are behind flags in v24 and are not among them.
 */
export const NODE_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  'global', 'globalThis', 'process', 'Buffer', 'console', 'Promise', 'WebAssembly',
  'queueMicrotask', 'clearImmediate', 'setImmediate', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout',
  'structuredClone', 'atob', 'btoa', 'performance', 'fetch', 'crypto', 'navigator', 'Navigator',
  'AbortController', 'AbortSignal', 'Blob', 'BroadcastChannel', 'ByteLengthQueuingStrategy', 'CompressionStream',
  'CountQueuingStrategy', 'Crypto', 'CryptoKey', 'CustomEvent', 'DecompressionStream', 'DOMException', 'Event',
  'EventTarget', 'File', 'FormData', 'Headers', 'MessageChannel', 'MessageEvent', 'MessagePort', 'Performance',
  'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure', 'PerformanceObserver', 'PerformanceObserverEntryList',
  'PerformanceResourceTiming', 'ReadableByteStreamController', 'ReadableStream', 'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest', 'ReadableStreamDefaultController', 'ReadableStreamDefaultReader', 'Request', 'Response',
  'SubtleCrypto', 'TextDecoder', 'TextDecoderStream', 'TextEncoder', 'TextEncoderStream', 'TransformStream',
  'TransformStreamDefaultController', 'URL', 'URLPattern', 'URLSearchParams', 'WebSocket', 'CloseEvent',
  'WritableStream', 'WritableStreamDefaultController', 'WritableStreamDefaultWriter',
]);

/**
 * ECMAScript's globals and V8's (v13.6, Node v24's), which a process answers with the realm's own: a free reference
 * to one is left as written, so V8 resolves it through its global load cache and no hot reference to `Object` or
 * `Uint8Array` pays a lookup through the guest. `Promise`, `WebAssembly` and `globalThis` are the process's own
 * answers and are not here.
 */
export const REALM_NAMES: ReadonlySet<string> = new Set([
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean',
  'String', 'Symbol', 'Date', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError', 'SuppressedError', 'JSON', 'Math', 'Intl', 'ArrayBuffer',
  'SharedArrayBuffer', 'Atomics', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray', 'BigUint64Array', 'BigInt64Array', 'DataView',
  'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'FinalizationRegistry', 'WeakRef', 'Iterator',
  'DisposableStack', 'AsyncDisposableStack', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'escape', 'unescape', 'eval', 'isFinite', 'isNaN',
]);

/** The engine's own helpers, which lowered text calls by bare name on the realm (`__browserRuntimeObject`, `__substrateContext`). */
export function isEnginePlumbing(name: string): boolean {
  return name.startsWith('__substrate') || name.startsWith('__browserRuntime');
}

/** A free name every compile site leaves as written: the realm answers it for every process alike. */
export function leftToRealm(name: string): boolean {
  return REALM_NAMES.has(name) || isEnginePlumbing(name);
}

/**
 * The names a Node global inherits from `Object.prototype` (`toString`, `hasOwnProperty`, `constructor`), which a free
 * reference finds through the global's prototype as in Node; a browser global's chain answers them from its own
 * interfaces first (its `constructor` is `DedicatedWorkerGlobalScope`).
 */
export const OBJECT_PROTOTYPE_NAMES: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype).filter((name) => name !== '__proto__'));

/** Whether a process's global holds a name it has not made its own: Node's, ECMAScript's, the engine's plumbing, or one it inherits. */
export function guestHolds(name: string): boolean {
  return NODE_GLOBAL_NAMES.has(name) || leftToRealm(name) || OBJECT_PROTOTYPE_NAMES.has(name);
}

/** The names a module body's wrapper binds (`runtime.ts` `__substrateWrapBody`), and `arguments`, its function's own. */
export const MODULE_SCOPE_NAMES: ReadonlySet<string> = new Set([
  '$exports', 'exports', '$require', 'require', '$module', 'module', '__filename', '__dirname', '$process', 'process',
  'console', 'import_meta', '$dynamicImport', '__dynamicImport', 'globalThis', 'global', 'Buffer', 'queueMicrotask',
  'atob', 'btoa', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'arguments',
]);

/** The names Node's `BuiltinModule` wrapper binds for a library file, with the engine's `globalThis`. */
export const NODE_LIB_SCOPE_NAMES: ReadonlySet<string> = new Set([
  'exports', 'require', 'module', 'process', 'internalBinding', 'primordials', 'globalThis', 'arguments',
]);

/** The global-scope `with` object's own outer names, which only the engine's evaluators declare. */
const GLOBAL_SCOPE_NAMES: ReadonlySet<string> = new Set(['__dynamicImport']);

/**
 * The objects free names of one global's code resolve through, made once a global and reading it live: nothing of
 * the global or the realm is captured when they are made, so a name either gains later is answered (ADR-0015 §4).
 */
export interface GuestScopes {
  /** `__substrateGuestScope` of rewritten text: a read of a name the global does not hold throws `ReferenceError`. */
  readonly read: object;
  /** `__substrateGuestTypeof` of rewritten text: the global itself, `undefined` for a name it does not hold. */
  readonly typeOf: object;
  /** The `with` object of code at a process's global scope (a made function, a script, a declined library file). */
  readonly withGlobal: object;
  /** The `with` object of a declined module body and the REPL: the wrapper's own names are left to the wrapper. */
  readonly withModule: object;
}

const scopesByGlobal = new WeakMap<object, GuestScopes>();

/** The `with` object over a global: a name it holds is its; a realm-only name is shadowed (reads `undefined`). */
function withScope(global: Record<PropertyKey, unknown>, own: ReadonlySet<string>): object {
  const realm = globalThis as unknown as Record<PropertyKey, unknown>;
  return new Proxy(Object.create(null) as object, {
    has(_target, key) {
      if (typeof key !== 'string' || leftToRealm(key) || own.has(key)) return false;
      return key in global || key in realm;
    },
    get(_target, key) {
      if (key === Symbol.unscopables) return undefined;
      return Reflect.get(global, key);
    },
    // Sloppy code ignores a refused assignment rather than throwing, as on the global itself.
    set(_target, key, value) { Reflect.set(global, key, value); return true; },
    deleteProperty(_target, key) { return Reflect.deleteProperty(global, key); },
  });
}

export function guestScopesOf(global: object): GuestScopes {
  let scopes = scopesByGlobal.get(global);
  if (scopes) return scopes;
  const held = global as Record<PropertyKey, unknown>;
  const read = new Proxy(Object.create(null) as object, {
    get(_target, key) {
      const value = Reflect.get(held, key);
      if (value === undefined && typeof key === 'string' && !(key in held)) throw new ReferenceError(`${key} is not defined`);
      return value;
    },
    set(_target, key, value) { Reflect.set(held, key, value); return true; },
    has(_target, key) { return key in held; },
    deleteProperty(_target, key) { return Reflect.deleteProperty(held, key); },
  });
  scopes = {
    read,
    typeOf: global,
    withGlobal: withScope(held, GLOBAL_SCOPE_NAMES),
    withModule: withScope(held, MODULE_SCOPE_NAMES),
  };
  scopesByGlobal.set(global, scopes);
  return scopes;
}
