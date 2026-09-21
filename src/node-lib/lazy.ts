/**
 * A vendored Node module, and a class out of one, named before the loader can
 * build it.
 *
 * The engine's own TypeScript imports `Buffer` and `Readable` the way any
 * program does -- as values, at the top of a file. But `buffer` and `stream`
 * are vendored Node files that `./load.ts` builds out of the binding and the
 * internals, and several of the engine's own shims are what that loader
 * resolves a public name to: the two sit in one import cycle, and which side a
 * bundler evaluates first is its own decision, not a thing the source can
 * state. Taking the class at import time therefore failed to load the engine
 * at all, differently on each build.
 *
 * So a name here stands for the thing rather than being it, until the first
 * time anyone touches it. `Buffer.from(…)` is one property read through a
 * proxy and then the real call; `x instanceof Buffer` reads the real class's
 * `Symbol.hasInstance`; `new Readable()` constructs the real one. Node's own
 * files never go through this -- they `require('buffer')` and get the class.
 */
// The loader itself, not the hook a binding uses: importing it is what puts
// it in the graph at all, so a program that only ever touches `Readable`
// still has a loader to build it with.
import { nodeLibInternalRequire } from './load';


/** The module a name stands for, loaded once, on the first property read. */
function loadedModule(name: string, cache: { value?: Record<string, unknown> }): Record<string, unknown> {
  return cache.value ??= nodeLibInternalRequire(name) as Record<string, unknown>;
}

/**
 * A vendored module object, whose properties are read when they are asked for.
 *
 * A module object is a program's to write on, and packages do: `graceful-fs`
 * -- which half of npm loads, openvscode-server through `fs-extra` and
 * `@vscode/deviceid` -- defines `Symbol.for('graceful-fs.queue')` on `fs` with
 * `Object.defineProperty` and then clones the module, which walks its keys.
 * Every trap here read the loaded module and none read the proxy's own target,
 * where a define with no trap of its own lands: the read came back
 * `undefined`, `key in fs` answered false, and `Reflect.ownKeys(fs)` threw
 * `'ownKeys' on proxy: trap result did not include
 * 'Symbol(graceful-fs.queue)'` -- a proxy may neither hide nor deny a
 * non-configurable own key of its target. graceful-fs threw out of its own
 * module load, so every program that loads it died there: in the substrate's
 * tab, openvscode-server's server at boot and its extension host, which exited
 * 1 without a word because a forked host's console goes to its parent over IPC
 * and the server drops those messages.
 *
 * So a define lands on the module, as it would in Node, and a
 * non-configurable one lands on the target as well because the proxy has to
 * report it from there; every read answers the target first and the module
 * after. This is the shape the guest global's proxy in `src/runtime.ts` uses,
 * for the same reason.
 */
export function lazyModule<T extends object>(name: string): T {
  const cache: { value?: Record<string, unknown> } = {};
  const own = (target: object, key: PropertyKey): boolean =>
    Reflect.getOwnPropertyDescriptor(target, key) !== undefined;
  return new Proxy({} as T, {
    get: (target, key, receiver) => (own(target, key)
      ? Reflect.get(target, key, receiver)
      : Reflect.get(loadedModule(name, cache), key)),
    set: (target, key, value, receiver) => (own(target, key)
      ? Reflect.set(target, key, value, receiver)
      : Reflect.set(loadedModule(name, cache), key, value)),
    has: (target, key) => own(target, key) || Reflect.has(loadedModule(name, cache), key),
    defineProperty: (target, key, descriptor) => {
      const module = loadedModule(name, cache);
      if (descriptor.configurable === false) {
        if (!Reflect.defineProperty(target, key, descriptor)) return false;
        Reflect.defineProperty(module, key, { ...descriptor, configurable: true });
        return true;
      }
      return Reflect.defineProperty(module, key, descriptor)
        || Reflect.defineProperty(target, key, descriptor);
    },
    deleteProperty: (target, key) => {
      if (own(target, key) && !Reflect.deleteProperty(target, key)) return false;
      return Reflect.deleteProperty(loadedModule(name, cache), key);
    },
    ownKeys: (target) => {
      const keys = Reflect.ownKeys(target);
      for (const key of Reflect.ownKeys(loadedModule(name, cache))) if (!keys.includes(key)) keys.push(key);
      return keys;
    },
    getOwnPropertyDescriptor: (target, key) => {
      const mine = Reflect.getOwnPropertyDescriptor(target, key);
      if (mine !== undefined) return mine;
      const descriptor = Reflect.getOwnPropertyDescriptor(loadedModule(name, cache), key);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
  }) as T;
}

/**
 * One export of a vendored module that is a class or a function: callable,
 * constructible, and the same object to `instanceof` as the real one.
 */
export function lazyExport<T>(name: string, key: string): T {
  const cache: { value?: Record<string, unknown> } = {};
  // The prototype a subclass takes when it is DEFINED. `class Socket extends
  // EventEmitter` reads `EventEmitter.prototype` at the moment the class is
  // written, which is while the bundle is still evaluating -- before the
  // loader, its bindings, or the shims those bindings read have run their own
  // bodies, and several of them are in one import cycle with this file (the
  // `constants` binding reads the `crypto` shim, which is an EventEmitter).
  // Loading there is not late, it is impossible. So a class defined that early
  // is given this empty object as its parent prototype, and the first time the
  // real class is built the object is grafted onto the real prototype: the
  // subclass's chain becomes `Subclass.prototype -> stand -> EventEmitter.
  // prototype`, so every method resolves and `instanceof` holds. After the
  // graft the real prototype is what is handed out, so an instance Node's own
  // code made is an instance of the same class to everyone.
  const stand = Object.create(null) as object;
  let grafted = false;
  const real = (): object => {
    const value = loadedModule(name, cache)[key] as object;
    if (!grafted) {
      grafted = true;
      const prototype = (value as { prototype?: object }).prototype;
      if (prototype) Object.setPrototypeOf(stand, prototype);
    }
    return value;
  };
  // A plain function is the target because it is the one thing that is both
  // callable and constructible; nothing of it is ever read.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const target = function stand() {} as unknown as object;
  return new Proxy(target, {
    get: (_t, propertyKey, receiver) => {
      // Before the real class exists, `prototype` is the stand-in above; from
      // the first load on it is the real one.
      if (propertyKey === 'prototype' && !grafted && !cache.value) return stand;
      return Reflect.get(real(), propertyKey, receiver);
    },
    set: (_t, propertyKey, value) => Reflect.set(real(), propertyKey, value),
    has: (_t, propertyKey) => Reflect.has(real(), propertyKey),
    getPrototypeOf: () => Reflect.getPrototypeOf(real()),
    // A module whose exports IS this function -- `require("events")` is
    // Node's `EventEmitter` -- is read as a module too: destructured,
    // enumerated, asked for its own keys. The target's own `prototype`,
    // `length` and `name` are non-configurable and must be reported as the
    // target has them, so they are answered from the target and everything
    // else from the real class.
    ownKeys: () => {
      const own = Reflect.ownKeys(target);
      return [...Reflect.ownKeys(real()).filter((key) => !own.includes(key)), ...own];
    },
    getOwnPropertyDescriptor: (_t, propertyKey) => {
      const fromTarget = Reflect.getOwnPropertyDescriptor(target, propertyKey);
      if (fromTarget !== undefined) return fromTarget;
      const own = Reflect.getOwnPropertyDescriptor(real(), propertyKey);
      return own === undefined ? undefined : { ...own, configurable: true };
    },
    apply: (_t, thisArg, args) => Reflect.apply(real() as (...a: unknown[]) => unknown, thisArg, args as unknown[]),
    construct: (_t, args, newTarget) => Reflect.construct(real() as new (...a: unknown[]) => object, args as unknown[], newTarget === target ? (real() as new (...a: unknown[]) => object) : newTarget),
  }) as T;
}
