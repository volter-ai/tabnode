/**
 * `internal/util/types`, bound by hand -- which is also `util.types`, because
 * Node's `util.types` IS this module.
 *
 * Node's own is `internalBinding('types')`, V8 asking a value what it is from
 * the outside. The engine asks the one question a tab can ask: the value's
 * own `Object.prototype.toString` tag, which V8 fills in from the same
 * internal type and which a program cannot forge without saying so. A
 * `Symbol.toStringTag` a program sets IS such a statement, and Node's answer
 * and this one differ only for an object that has lied about itself.
 *
 * Two exceptions, each for a reason a tab cannot get around:
 *
 * A `Proxy` shows the tag of the thing it wraps, by design, so no tag can
 * find one. The engine's realm records every proxy it makes -- `runtime.ts`
 * replaces the realm's `Proxy` for a guest -- and `isProxy` answers from that
 * record. undici's `Headers` guard asks it of every init it converts, and a
 * proxy the host made before the guest's realm existed is not in the record.
 *
 * `isExternal` is always false: nothing in a tab is a native handle.
 *
 * `internal/util` itself is no longer here: it is Node's own file now, and
 * every name the vendored files used to take from a hand-bound object is
 * Node's own code, on the bindings under `../binding/`.
 */

/**
 * Every proxy a guest's realm has made. `runtime.ts` fills it, from the
 * `Proxy` it installs for a guest; this module reads it.
 */
export const recordedProxies = new WeakSet<object>();

const tagOf = (value: unknown): string => Object.prototype.toString.call(value);

/** The `size` getters, which need a real Map or Set behind `this`. */
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get as () => number;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get as () => number;

/**
 * Whether a value carries the internal slot a built-in method needs. Calling
 * the method is the only test of a slot JavaScript has, and a value without
 * one throws rather than answering -- which is the answer.
 */
function hasSlot(value: unknown, method: (...args: never[]) => unknown, args: unknown[] = []): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try { (method as (...a: unknown[]) => unknown).apply(value, args); return true; } catch { return false; }
}
const taggedAs = (tag: string) => (value: unknown): boolean => tagOf(value) === tag;

/** `internal/util/types`, which is `util.types`. */
export const internalUtilTypes: Record<string, (value: unknown) => boolean> = {
  isArgumentsObject: taggedAs('[object Arguments]'),
  isArrayBuffer: taggedAs('[object ArrayBuffer]'),
  isSharedArrayBuffer: taggedAs('[object SharedArrayBuffer]'),
  isAnyArrayBuffer: (value) => tagOf(value) === '[object ArrayBuffer]' || tagOf(value) === '[object SharedArrayBuffer]',
  isArrayBufferView: (value) => ArrayBuffer.isView(value),
  isDataView: taggedAs('[object DataView]'),
  isTypedArray: (value) => ArrayBuffer.isView(value) && tagOf(value) !== '[object DataView]',
  isUint8Array: taggedAs('[object Uint8Array]'),
  isAsyncFunction: taggedAs('[object AsyncFunction]'),
  isGeneratorFunction: (value) => tagOf(value) === '[object GeneratorFunction]' || tagOf(value) === '[object AsyncGeneratorFunction]',
  isGeneratorObject: (value) => tagOf(value) === '[object Generator]' || tagOf(value) === '[object AsyncGenerator]',
  isRegExp: taggedAs('[object RegExp]'),
  isMapIterator: taggedAs('[object Map Iterator]'),
  isSetIterator: taggedAs('[object Set Iterator]'),
  isModuleNamespaceObject: taggedAs('[object Module]'),
  isPromise: taggedAs('[object Promise]'),
  isNativeError: (value) => value instanceof Error && tagOf(value) === '[object Error]',
  // A boxed primitive is asked the one question only a real one can answer:
  // its own prototype's `valueOf` needs the internal slot and throws without
  // it. A tag would say yes to `Object.create(String.prototype)`, which has
  // no slot at all, and `isDeepStrictEqual` then compared it as a string and
  // threw where Node answered.
  isBooleanObject: (value) => hasSlot(value, Boolean.prototype.valueOf),
  isNumberObject: (value) => hasSlot(value, Number.prototype.valueOf),
  isStringObject: (value) => hasSlot(value, String.prototype.valueOf),
  isSymbolObject: (value) => hasSlot(value, Symbol.prototype.valueOf),
  isBigIntObject: (value) => hasSlot(value, BigInt.prototype.valueOf),
  isDate: (value) => hasSlot(value, Date.prototype.valueOf),
  isMap: (value) => hasSlot(value, mapSize),
  isSet: (value) => hasSlot(value, setSize),
  isWeakMap: (value) => hasSlot(value, WeakMap.prototype.has, ['x']),
  isWeakSet: (value) => hasSlot(value, WeakSet.prototype.has, ['x']),
  isKeyObject: () => false,
  isCryptoKey: (value) => typeof CryptoKey !== 'undefined' && value instanceof CryptoKey,
  isExternal: () => false,
  isProxy: (value) => (typeof value === 'object' || typeof value === 'function') && value !== null && recordedProxies.has(value as object),
};

internalUtilTypes.isBoxedPrimitive = (value) =>
  internalUtilTypes.isBooleanObject(value) || internalUtilTypes.isNumberObject(value) ||
  internalUtilTypes.isStringObject(value) || internalUtilTypes.isSymbolObject(value) ||
  internalUtilTypes.isBigIntObject(value);

for (const name of ['Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']) {
  internalUtilTypes[`is${name}`] = taggedAs(`[object ${name}]`);
}
