/**
 * One loader for Node's own files.
 *
 * `src/shims/path.ts` is the precedent: a vendored file binds, it does not
 * implement, and a bug in it is fixed by moving the file to a newer Node.
 * `path` bound its own primordials and its own three internals by hand, which
 * is affordable for one file that names fourteen names. `net.js` names two
 * hundred, and `child_process.js` after it, so the binding is written once
 * here instead: Node's own `internal/per_context/primordials.js` builds the
 * whole `primordials` object over this realm's built-ins the way Node's
 * bootstrap does, and a vendored file is evaluated in the scope Node's
 * `BuiltinModule` gives one —
 *
 *     (function (exports, require, module, process, internalBinding, primordials) { … })
 *
 * — so nothing in a vendored file is hand-written and nothing in it is edited.
 *
 * Resolution, in the order Node's own `require` inside a builtin resolves: an
 * `internal/…` name is a vendored file when one is vendored under that name,
 * else the small hand-bound object in `./internals/` that holds exactly the
 * names the vendored files destructure; a public name is the engine's own
 * shim, the same object a guest's `require` answers with.
 * `internalBinding(name)` is the libuv-shaped surface in `./binding/`.
 */
import PRIMORDIALS_SOURCE from './primordials.js?raw';
import { NODE_LIB_SOURCES } from './sources';
import { nodeLibInternal } from './internals';
import { nodeLibBinding } from './binding';
import { nodeLibPublic } from './public-modules';
import { setLibRequire } from './require-hook';
import { NODE_LTS_VERSION, nodeVersions } from './node-versions';

/**
 * The realm's built-ins, captured as Node captures them: before a program can
 * monkey-patch them, in the shape every vendored file destructures. Node runs
 * this file once per context with a `primordials` object to fill and the
 * realm's `globalThis` around it; so does this.
 */
// `var`, not `let`: hoisted and already `undefined` when a cycle calls in.
// eslint-disable-next-line no-var, vars-on-top
var builtPrimordials: Record<string, unknown> | undefined;
export function primordialsOf(): Record<string, unknown> {
  if (builtPrimordials === undefined) {
    const built: Record<string, unknown> = {};
    // eslint-disable-next-line no-new-func
    new Function('primordials', `${PRIMORDIALS_SOURCE}\n//# sourceURL=node:internal/per_context/primordials`)(built);
    builtPrimordials = built;
  }
  return builtPrimordials;
}

/** A vendored file's module record, as Node's `BuiltinModule` holds one. */
interface NodeLibModule {
  exports: unknown;
  id: string;
  filename: string;
  loaded: boolean;
}

/**
 * The loader's own state, built on first use rather than when this module is
 * evaluated. A vendored file is asked for from inside the import graph that
 * leads here -- the engine's `string_decoder` shim wants Node's `Buffer`, and
 * `Buffer` is a vendored file -- so the loader must answer whatever order the
 * bundler settles on. Module-scope `const`s left it in its own temporal dead
 * zone and the engine failed to load at all.
 */
/* eslint-disable no-var, vars-on-top */
var cache: Map<string, NodeLibModule> | undefined;
var builtInternals: Map<string, unknown> | undefined;
var builtBindings: Map<string, unknown> | undefined;
/* eslint-enable no-var, vars-on-top */

/** The libuv-shaped surface, built once per name, on the first file that asks. */
function internalBinding(name: string): unknown {
  builtBindings ??= new Map<string, unknown>();
  if (builtBindings.has(name)) return builtBindings.get(name);
  const build = nodeLibBinding(name);
  if (!build) throw new Error(`node-lib: no binding for internalBinding('${name}')`);
  const value = build();
  builtBindings.set(name, value);
  return value;
}

/**
 * The process a vendored file is handed where the realm has none: the engine
 * loaded as a library, before any guest has run.
 *
 * Node compiles a builtin inside a bootstrapped process, and Node's own files
 * read that process while they compile -- `internal/util` reads
 * `process.versions.openssl` and `process.versions.amaro` at its top, and
 * `internal/streams/state` reads `process.platform` -- so a realm with no
 * process must still answer the static facts of one. It answers only those:
 * everything a run owns -- its argv, its environment, its streams, its exit --
 * belongs to that run's own process and is answered there.
 *
 * What made this a wall: the engine's `net-module` compiles Node's `net.js`
 * while the bundle is still evaluating, `net` requires `events` and `events`
 * requires `internal/util`, and in a page or a worker -- a realm with no
 * `process` global -- `process.versions` was `undefined`, so the whole engine
 * failed to import with `Cannot read properties of undefined (reading
 * 'openssl')`.
 */
const NODE_LIB_LIBRARY_PROCESS: Record<string, unknown> = {
  platform: 'linux',
  arch: 'x64',
  version: `v${NODE_LTS_VERSION}`,
  versions: nodeVersions(),
  env: {},
  argv: ['node'],
  argv0: 'node',
  execArgv: [],
  execPath: '/usr/local/bin/node',
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
};

/**
 * The `process` a vendored file is handed, built by a hoisted function for
 * the reason `nodeLibInternalRequire` gives: a file can be compiled while the
 * bundle is still evaluating, when a module-scope `var` is still undefined.
 * Node hands a builtin the process of
 * the realm it runs in; so does this, read at call time, because a guest's
 * process is installed on the realm after this module is loaded and every run
 * replaces it. Where the realm has no process at all the answer is
 * {@link NODE_LIB_LIBRARY_PROCESS}.
 */
var nodeLibProcessCache: Record<string, unknown> | undefined;
export function nodeLibProcessOf(): Record<string, unknown> {
  return nodeLibProcessCache ??= new Proxy({} as Record<string, unknown>, {
  get(_target, key) {
    const realm = (globalThis as unknown as { process?: Record<string, unknown> }).process;
    if (!realm) return NODE_LIB_LIBRARY_PROCESS[key as string];
    const value = realm[key as string];
    if (key === 'nextTick' && typeof value !== 'function') {
      return (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args));
    }
    if (key === 'platform' && typeof value !== 'string') return 'linux';
    return value;
  },
  set(_target, key, value) {
    const realm = (globalThis as unknown as { process?: Record<string, unknown> }).process;
    if (realm) realm[key as string] = value;
    return true;
  },
  has(_target, key) {
    const realm = (globalThis as unknown as { process?: Record<string, unknown> }).process;
    return realm ? key in realm : key in NODE_LIB_LIBRARY_PROCESS;
  },
  });
}

function nodeLibRequire(specifier: string): unknown {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (NODE_LIB_SOURCES[name] !== undefined) return loadNodeLib(name);
  const internal = nodeLibInternal(name);
  if (internal !== undefined) {
    builtInternals ??= new Map<string, unknown>();
    if (!builtInternals.has(name)) builtInternals.set(name, internal());
    return builtInternals.get(name);
  }
  const shim = nodeLibPublic(name);
  if (shim !== undefined) return shim();
  throw new Error(`node-lib: a vendored Node file asked for '${specifier}', which the binding does not provide`);
}

/**
 * A vendored file, evaluated as Node's `BuiltinModule.compileForInternalLoader`
 * evaluates one and cached under its name. The record is cached before the
 * body runs, as Node's is, so a cycle between two vendored files sees a
 * partly-filled `exports` rather than looping.
 */
export function loadNodeLib(name: string): unknown {
  cache ??= new Map<string, NodeLibModule>();
  const cached = cache.get(name);
  if (cached) return cached.exports;
  const record = newNodeLibRecord(name);
  // Cached before compile, as Node's is, so a cycle sees a partly-filled
  // `exports`. A throw used to leave that empty record in the cache:
  // `https.js` calls `assertCrypto()` at the top, the first read threw
  // ERR_NO_CRYPTO, and every later `import("https")` answered `{}`, so
  // `.request` was undefined (`r is not a function`).
  cache.set(name, record);
  try {
    compileNodeLib(name, record);
  } catch (error) {
    cache.delete(name);
    throw error;
  }
  return record.exports;
}

/**
 * A vendored file evaluated into a module scope of its own, uncached.
 *
 * Node has one module graph per process and lets a builtin keep its state in
 * its own file scope. The engine runs many guests in one realm, so a file
 * whose scope IS the state is instantiated per run rather than shared:
 * `internal/modules/customization_hooks` holds the hooks a program registered
 * in two module-scope arrays, and one run's hooks must not resolve another
 * run's imports. The caller holds the instance for as long as the run does.
 */
/**
 * Node's ESM namespace for a CommonJS builtin: `default` is the module
 * object, and every own key of `module.exports` is a named export, live.
 * `import("https").then(m => m.request)` is `require("https").request`.
 * Spread of a lazy proxy copied nothing; `Object.getOwnPropertyNames` reads
 * the proxy's ownKeys trap, which is the module's keys.
 */
const builtinNamespaces: Array<{ cjs: object; ns: Record<string, unknown> }> = [];

export function esmNamespaceOf(mod: unknown): Record<string, unknown> {
  const ns: Record<string, unknown> = { default: mod };
  if (mod !== null && (typeof mod === 'object' || typeof mod === 'function')) {
    const cjs = mod as object;
    for (const key of Object.getOwnPropertyNames(cjs)) {
      if (key === 'default') continue;
      Object.defineProperty(ns, key, {
        enumerable: true,
        configurable: true,
        get(): unknown { return (cjs as Record<string, unknown>)[key]; },
        set(value: unknown) { (cjs as Record<string, unknown>)[key] = value; },
      });
    }
    builtinNamespaces.push({ cjs, ns });
  }
  return ns;
}

/** Node's `module.syncBuiltinESMExports`: newly assigned CJS keys appear on the namespace. */
export function syncBuiltinESMExports(): void {
  for (const { cjs, ns } of builtinNamespaces) {
    for (const key of Object.getOwnPropertyNames(cjs)) {
      if (key === 'default' || Object.prototype.hasOwnProperty.call(ns, key)) continue;
      Object.defineProperty(ns, key, {
        enumerable: true,
        configurable: true,
        get(): unknown { return (cjs as Record<string, unknown>)[key]; },
        set(value: unknown) { (cjs as Record<string, unknown>)[key] = value; },
      });
    }
  }
}

export function loadNodeLibInstance(name: string): unknown {
  const record = newNodeLibRecord(name);
  compileNodeLib(name, record);
  return record.exports;
}

/**
 * A vendored file cached on one engine instance rather than the realm.
 *
 * Node has one builtin cache per process. The engine runs many processes in
 * one realm, and the realm cache is keyed only by name, so a second
 * `Runtime`'s `require('fs')` was the first's module object: a `Symbol.for`
 * tag written by one guest was readable by the other. The first instance
 * still uses {@link loadNodeLib}; a later instance asks here, and the file
 * is compiled once for that owner. Its `require` of other vendored files
 * still hits the realm cache, so `net` and `events` stay one class.
 */
let byOwner: WeakMap<object, Map<string, NodeLibModule>> | undefined;
export function loadNodeLibFor(owner: object, name: string): unknown {
  byOwner ??= new WeakMap();
  let owned = byOwner.get(owner);
  if (!owned) {
    owned = new Map();
    byOwner.set(owner, owned);
  }
  const cached = owned.get(name);
  if (cached) return cached.exports;
  const record = newNodeLibRecord(name);
  owned.set(name, record);
  try {
    compileNodeLib(name, record);
  } catch (error) {
    owned.delete(name);
    throw error;
  }
  return record.exports;
}

function newNodeLibRecord(name: string): NodeLibModule {
  if (NODE_LIB_SOURCES[name] === undefined) throw new Error(`node-lib: no vendored file for '${name}'`);
  return { exports: {}, id: name, filename: `node:${name}`, loaded: false };
}

/** The scope Node's `BuiltinModule.compileForInternalLoader` gives a builtin. */
function compileNodeLib(name: string, record: NodeLibModule): void {
  // eslint-disable-next-line no-new-func
  const compiled = new Function(
    'exports', 'require', 'module', 'process', 'internalBinding', 'primordials',
    `${NODE_LIB_SOURCES[name]}\n//# sourceURL=node:${name}`,
  );
  compiled(record.exports, nodeLibRequire, record, nodeLibProcessOf(), internalBinding, primordialsOf());
  record.loaded = true;
  bootstrapNodeLib(name, record.exports);
}

/**
 * What Node's own bootstrap does to a builtin once it is compiled.
 *
 * A few of Node's files are compiled in a state that cannot answer yet and
 * are finished by `internal/bootstrap/node.js`. `internal/util/debuglog.js`
 * says so in its own comment: "calls to `debuglog()` before
 * `initializeDebugEnv()` is called will throw", and it threw -- the first
 * `readable.push` in the engine logged through a `debuglog` with no
 * `testEnabled`. The engine has no bootstrap file, so the step lives here,
 * beside the compile it belongs to.
 */
function bootstrapNodeLib(name: string, exports: unknown): void {
  if (name === 'events') {
    // Node's own `EventTarget` sets its listener ceiling on itself in its
    // constructor, and `events.getMaxListeners` reads that field back. The
    // realm's `EventTarget` -- the DOM's in a tab, Node's own where the
    // engine runs inside a Node -- has no such field, and either way it is
    // keyed by a symbol THIS `events.js` minted, not the one the realm's
    // class was built against. So the default goes on the prototype under
    // this file's own keys, where `getMaxListeners` looks, and a target given
    // its own ceiling shadows it, which is what an own property does.
    const events = exports as { kMaxEventTargetListeners?: symbol; kMaxEventTargetListenersWarned?: symbol };
    const target = (globalThis as { EventTarget?: { prototype: object } }).EventTarget;
    const defaults: Array<[symbol | undefined, unknown]> = [
      [events.kMaxEventTargetListeners, 10],
      [events.kMaxEventTargetListenersWarned, false],
    ];
    if (target) {
      for (const [key, fallback] of defaults) {
        if (!key || key in target.prototype) continue;
        Object.defineProperty(target.prototype, key, {
          configurable: true,
          get(): unknown { return fallback; },
          set(this: object, value: unknown) {
            Object.defineProperty(this, key, { value, writable: true, configurable: true });
          },
        });
      }
    }
    return;
  }
  if (name === 'internal/util/debuglog') {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    (exports as { initializeDebugEnv?: (value: string) => void }).initializeDebugEnv?.(env?.NODE_DEBUG ?? '');
    return;
  }
  if (name === 'assert') {
    // Node 23 hangs `Assert` off the module; the vendored 22.18 file does not.
    const assert = exports as { Assert?: unknown; strictEqual?: (a: unknown, b: unknown) => void };
    if (typeof assert.Assert !== 'function') {
      class Assert {
        diff: string;
        constructor(options?: { diff?: string }) { this.diff = options?.diff ?? 'simple'; }
        strictEqual(a: unknown, b: unknown): void { assert.strictEqual?.(a, b); }
      }
      (assert as { Assert: unknown }).Assert = Assert;
    }
    return;
  }
  if (name === 'fs') {
    // Node 23 hangs `mkdtempDisposableSync` off `fs`; the vendored 22.18
    // file does not, and `openAsBlob`'s neighbour in the gate calls it.
    const fs = exports as {
      mkdtempSync?: (prefix: string, options?: unknown) => string;
      mkdtempDisposableSync?: unknown;
      rmSync?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
    };
    if (typeof fs.mkdtempDisposableSync !== 'function' && typeof fs.mkdtempSync === 'function') {
      fs.mkdtempDisposableSync = (prefix: string, options?: unknown) => {
        const tempPath = fs.mkdtempSync!(prefix, options);
        const remove = (): void => { try { fs.rmSync?.(tempPath, { recursive: true, force: true }); } catch { /* gone */ } };
        return { path: tempPath, remove, [Symbol.dispose]: remove };
      };
    }
  }
}

/**
 * What a hand-bound internal, a binding or `./lazy.ts` calls to reach a
 * vendored file.
 *
 * A function DECLARATION, not a `const`: a name that stands for a vendored
 * class is read while the bundle is still evaluating -- `class Foo extends
 * EventEmitter` runs `getPrototypeOf` on the proxy at the moment the class is
 * defined, which is module-evaluation time, before this file's own bindings
 * are initialized. A hoisted function is already callable then; a `const` is
 * in its temporal dead zone and the engine failed to load at all.
 */
export function nodeLibInternalRequire(specifier: string): unknown {
  return nodeLibRequire(specifier);
}
setLibRequire(nodeLibRequire);
