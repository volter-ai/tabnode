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
import { createUtilBinding } from './binding/util';
import { createFsBindings } from './binding/fs';
import { stackOverrideMap } from '../stack-overrides';

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
type BuiltinNamespace = { cjs: object; ns: Record<string, unknown> };
const builtinNamespaces = new WeakMap<object, BuiltinNamespace[]>();
const hostNamespaceOwner = {};
function namespacesFor(owner: object): BuiltinNamespace[] {
  let held = builtinNamespaces.get(owner);
  if (!held) { held = []; builtinNamespaces.set(owner, held); }
  return held;
}

export function esmNamespaceOf(mod: unknown, owner: object = hostNamespaceOwner): Record<string, unknown> {
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
    namespacesFor(owner).push({ cjs, ns });
  }
  return ns;
}

/** Node's `module.syncBuiltinESMExports`: newly assigned CJS keys appear on the namespace. */
export function syncBuiltinESMExports(owner: object = hostNamespaceOwner): void {
  for (const { cjs, ns } of namespacesFor(owner)) {
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
 * Each guest owns one recursively resolved builtin graph. The default loader
 * is private to the engine; guest monkey patches never reach it or siblings.
 * Native bindings retain the shared OS registries beneath those graphs.
 */
export type NodeLibRequire = (name: string) => any;
type ModuleInitializer = (name: string, value: any, require: NodeLibRequire) => void;
const moduleInitializers = new Set<ModuleInitializer>();

/** Host bootstrap adapters are applied to each newly compiled builtin. */
export function onNodeLibLoaded(initialize: ModuleInitializer): () => void {
  moduleInitializers.add(initialize);
  return () => { moduleInitializers.delete(initialize); };
}

/** Native implementations can be shared; their exported module records cannot. */
export function moduleSurface(value: any, seen = new Map<object, any>()): any {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && !Array.isArray(value)) return value;
  const surface = Array.isArray(value) ? [] : Object.create(prototype === null ? null : Object.prototype);
  seen.set(value, surface);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    descriptor.configurable = true;
    if ('value' in descriptor) {
      descriptor.value = moduleSurface(descriptor.value, seen);
      descriptor.writable = true;
    }
    Object.defineProperty(surface, key, descriptor);
  }
  return surface;
}

/** Native class implementation and OS registries are shared, JS prototypes are not. */
function bindingSurface(value: unknown): unknown {
  const surface = moduleSurface(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(surface))) {
    const implementation = descriptor.value;
    // ECMAScript classes have a non-writable own prototype. Ordinary native
    // functions stay callable functions; class facades retain their static API.
    if (typeof implementation !== 'function'
      || Object.getOwnPropertyDescriptor(implementation, 'prototype')?.writable !== false) continue;
    const ScopedBinding = class extends implementation {};
    Object.defineProperty(ScopedBinding, 'name', { value: implementation.name, configurable: true });
    // IPC transfers native handles within the shared OS. Node's native-brand
    // checks must recognize the received handle even when its JS facade was
    // allocated by another process. This does not share guest module exports.
    Object.defineProperty(ScopedBinding, Symbol.hasInstance, {
      value: (instance: unknown) => Function.prototype[Symbol.hasInstance].call(implementation, instance),
    });
    Object.defineProperty(surface, key, { ...descriptor, value: ScopedBinding });
  }
  return surface;
}

class NodeLibScope {
  private readonly modules = new Map<string, NodeLibModule>();
  private readonly internals = new Map<string, unknown>();
  private readonly bindings = new Map<string, unknown>();
  private readonly surfaces = new Map<string, unknown>();
  constructor(readonly process: object) {}

  readonly require: NodeLibRequire = (specifier) => {
    const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (name === 'process') return this.process;
    if (name === 'fs/promises') return this.require('internal/fs/promises').exports;
    if (name === 'timers/promises') return this.require('timers').promises;
    if (name === 'dns/promises') return this.require('dns').promises;
    if (name === 'path/posix') return this.require('path').posix;
    if (name === 'path/win32') return this.require('path').win32;
    if (name === 'assert/strict') return this.require('assert').strict;
    if (name === 'util/types') return this.require('internal/util/types');
    if (NODE_LIB_SOURCES[name] !== undefined) return this.load(name);
    const internal = nodeLibInternal(name, this.require, this.process);
    if (internal) {
      if (!this.internals.has(name)) this.internals.set(name, moduleSurface(internal()));
      return this.internals.get(name);
    }
    const native = nodeLibPublic(name, this.require, this.process);
    if (native) return this.surface(name, native);
    throw new Error(`node-lib: no builtin '${specifier}' in this process`);
  };

  surface(name: string, create: () => unknown): unknown {
    if (!this.surfaces.has(name)) this.surfaces.set(name, moduleSurface(create()));
    return this.surfaces.get(name);
  }

  private readonly binding = (name: string): unknown => {
    if (!this.bindings.has(name)) {
      if (['fs', 'fs_dir', 'fs_event_wrap'].includes(name)) {
        // Exported handles and encoded names belong to this graph; the fd
        // allocator, open-file descriptions and filesystem remain shared OS state.
        const fs = createFsBindings(() => this.require('buffer').Buffer);
        this.bindings.set('fs', fs.fsBinding);
        this.bindings.set('fs_dir', fs.fsDirBinding);
        this.bindings.set('fs_event_wrap', fs.fsEventWrapBinding);
      } else {
        this.bindings.set(name, name === 'util' ? createUtilBinding(this.require) : bindingSurface(internalBinding(name)));
      }
    }
    return this.bindings.get(name);
  };

  private load(name: string): unknown {
    const cached = this.modules.get(name);
    if (cached) return cached.exports;
    const record = newNodeLibRecord(name);
    // Insert before evaluation: circular dependencies see this graph's record.
    this.modules.set(name, record);
    try {
      compileNodeLib(name, record, this.require, this.process, this.binding);
      for (const initialize of moduleInitializers) initialize(name, record.exports, this.require);
    } catch (error) {
      this.modules.delete(name);
      throw error;
    }
    return record.exports;
  }
}

const byOwner = new WeakMap<object, NodeLibScope>();
function scopeFor(owner: object): NodeLibScope {
  let scope = byOwner.get(owner);
  if (!scope) { scope = new NodeLibScope(owner); byOwner.set(owner, scope); }
  return scope;
}
export function loadNodeLibFor(owner: object, name: string): any {
  return scopeFor(owner).require(name);
}
export function hasNodeLibModule(name: string): boolean {
  return NODE_LIB_SOURCES[name] !== undefined || nodeLibPublic(name) !== undefined
    || ['path/posix', 'path/win32', 'assert/strict', 'util/types', 'fs/promises', 'timers/promises', 'dns/promises'].includes(name);
}
export function nativeModuleFor(owner: object, name: string, create: () => unknown): unknown {
  return scopeFor(owner).surface(name, create);
}

function newNodeLibRecord(name: string): NodeLibModule {
  if (NODE_LIB_SOURCES[name] === undefined) throw new Error(`node-lib: no vendored file for '${name}'`);
  return { exports: {}, id: name, filename: `node:${name}`, loaded: false };
}

/** The scope Node's `BuiltinModule.compileForInternalLoader` gives a builtin. */
function compileNodeLib(name: string, record: NodeLibModule, require: NodeLibRequire = nodeLibRequire,
  process: object = nodeLibProcessOf(), binding: (name: string) => unknown = internalBinding): void {
  // eslint-disable-next-line no-new-func
  const compiled = new Function(
    'exports', 'require', 'module', 'process', 'internalBinding', 'primordials',
    `${NODE_LIB_SOURCES[name]}\n//# sourceURL=node:${name}`,
  );
  compiled(record.exports, require, record, process, binding, primordialsOf());
  record.loaded = true;
  bootstrapNodeLib(name, record.exports, process);
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
function bootstrapNodeLib(name: string, exports: unknown, process: object): void {
  if (name === 'events') {
    // Browser EventTargets do not carry Node's process-local listener symbol.
    // Adapt that native boundary without installing a new pair of symbols on
    // the shared EventTarget prototype for every short-lived guest process.
    const events = exports as {
      kMaxEventTargetListeners: symbol;
      defaultMaxListeners: number;
      getMaxListeners: (target: any) => number;
    };
    const original = events.getMaxListeners;
    events.getMaxListeners = (target) => {
      if (typeof EventTarget !== 'undefined' && target instanceof EventTarget
        && typeof (target as any).getMaxListeners !== 'function'
        && (target as any)[events.kMaxEventTargetListeners] === undefined) return events.defaultMaxListeners;
      return original(target);
    };
    return;
  }
  if (name === 'internal/errors') {
    // Node's bootstrap registers this file's `prepareStackTraceCallback` with
    // V8, which reads `overrideStackTrace` before anything else formats a
    // stack. Here the realm's `Error.prepareStackTrace` hook is that reader,
    // so the map is the one it reads (`src/stack-overrides.ts`). Unread, an
    // `assert.ok(false)` indexed the stack's text for a call site and threw
    // `TypeError: call.getFileName is not a function`.
    // A primordial map's prototype is frozen, so its methods are shadowed by
    // definition rather than assignment.
    const map = (exports as { overrideStackTrace: object }).overrideStackTrace;
    for (const [key, value] of Object.entries(stackOverrideMap)) Object.defineProperty(map, key, { value, configurable: true });
    return;
  }
  if (name === 'internal/util/debuglog') {
    const env = (process as { env?: Record<string, string | undefined> }).env;
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
