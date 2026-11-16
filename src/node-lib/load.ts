// First, so a file compiled while the bundle is still evaluating finds them evaluated (ADR-0015).
import { guestScopesOf, NODE_LIB_PARAMETERS } from '../guest-scope';
import { scopedBody, type ScopedBody } from './scoped-body';
import { isNodeLibFile, nodeLibBody } from './bodies';
import { createOsBinding } from './binding/misc';
import { withGuestExecution } from '../guest-loop';
import { traceSocketConnect } from '../socket-connect-trace';
/**
 * One loader for Node's own files.
 *
 * A vendored file binds, it does not implement, and a bug in it is fixed by
 * moving the file to a newer Node. The binding is written once, here: Node's
 * own `internal/per_context/primordials.js` builds the
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
import { nodeLibInternal } from './internals';
import { nodeLibBinding } from './binding';
import { nodeLibPublic } from './public-modules';
import { setLibRequire } from './require-hook';
import { NODE_LTS_VERSION, nodeVersions } from './node-versions';
import { transcodeFor } from './binding/transcode';
import { createUtilBinding } from './binding/util';
import { ownedRun, ownerOfInstance, setInstanceOwner, withNodeResourceScope } from './binding/handles';
import { __tokenForProcess, type ProcessToken } from '../process-tokens';
import { createProcess, type Process } from '../shims/process';
import { createFsBindings } from './binding/fs';
import { libnodeAttached } from './binding/libnode';
import { fsContext } from './binding/fs_req';
import { createNodeFileBinding } from './binding/node_file';
import { createNodeDirBinding } from './binding/node_dir';
import { createFsEventWrapBinding } from './binding/fs_event_wrap';
import { createDiagnosticsChannelBinding } from './binding/diagnostics_channel';
import { createWasmWebApiBinding } from './binding/wasm_web_api';
import { createBlobBinding } from './binding/blob';
import { createMessagingBinding } from './binding/messaging';
import { errorsBinding } from './binding/misc';
import { errorSourcePositions } from '../error-source';
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
 * leads here -- the engine's own modules want Node's `Buffer`, and `Buffer`
 * is a vendored file -- so the loader must answer whatever order the
 * bundler settles on. Module-scope `const`s left it in its own temporal dead
 * zone and the engine failed to load at all.
 */
/* eslint-disable no-var, vars-on-top */
var cache: Map<string, NodeLibModule> | undefined;
var builtInternals: Map<string, unknown> | undefined;
/** A builtin's file compiled once a realm (compiledNodeLibFor), kept for the realm's life. */
var compiledNodeLib: Map<string, ScopedFunction> | undefined;
/** Each process's global object, as the engine makes it (setNodeLibGlobal). */
var processGlobalOf: ((process: object) => object) | undefined;
var builtBindings: Map<string, unknown> | undefined;
/* eslint-enable no-var, vars-on-top */

/** The libuv-shaped surface, built once per name, on the first file that asks. */
/** An instrument: the binding names Node's lib has asked this realm for, for the run's record of what it used. */
const bindingsAsked = new Set<string>();
export function nodeLibBindingsAsked(): readonly string[] { return [...bindingsAsked]; }
function internalBinding(name: string): unknown {
  bindingsAsked.add(name);
  builtBindings ??= new Map<string, unknown>();
  if (builtBindings.has(name)) return builtBindings.get(name);
  const build = nodeLibBinding(name);
  if (!build) throw new Error(`node-lib: no binding for internalBinding('${name}')`);
  const value = build();
  builtBindings.set(name, value);
  return value;
}

/**
 * The static facts of the library realm's process, answered before that
 * process can be made.
 *
 * Node compiles a builtin inside a bootstrapped process, and Node's own files
 * read that process while they compile -- `internal/util` reads
 * `process.versions.openssl` and `process.versions.amaro` at its top, and
 * `internal/streams/state` reads `process.platform` -- and the engine
 * compiles some of them while its bundle is still evaluating, before the
 * library realm's process can be made, so these facts are answered until it
 * is. They are that process's own: the same platform, versions and argv.
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
 * The `process` a vendored file loaded outside any process is handed: the engine's own process for the library
 * realm, `createProcess()` with no run (a process object no run names is the realm's own, shims/process.ts), so the
 * library's builtins have Node's `emitWarning`, `nextTick`, `cwd` and the rest. `url.parse` warns DEP0169 on its first
 * call; read off a page's `globalThis.process` -- the polyfill shims/child_process.ts puts there, with no
 * `emitWarning` -- it threw. A guest's process is never this one: each guest's builtins are its own graph, given
 * that guest's process (`NodeLibScope`).
 *
 * Built by a hoisted function for the reason `nodeLibInternalRequire` gives, and made on the first read of a name
 * that is not one of {@link NODE_LIB_LIBRARY_PROCESS}'s static facts: a file compiled while the bundle is still
 * evaluating reads only those (its platform and versions), before shims/process.ts can make a process.
 */
var nodeLibProcessCache: Record<string, unknown> | undefined;
var libraryProcess: Record<string, unknown> | undefined;
function libraryProcessOf(): Record<string, unknown> {
  return libraryProcess ??= createProcess() as unknown as Record<string, unknown>;
}
const isStaticFact = (key: string | symbol): boolean =>
  libraryProcess === undefined && typeof key === 'string' && Object.prototype.hasOwnProperty.call(NODE_LIB_LIBRARY_PROCESS, key);
export function nodeLibProcessOf(): Record<string, unknown> {
  return nodeLibProcessCache ??= new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (isStaticFact(key) ? NODE_LIB_LIBRARY_PROCESS[key as string] : Reflect.get(libraryProcessOf(), key)),
    set: (_target, key, value) => Reflect.set(libraryProcessOf(), key, value),
    has: (_target, key) => isStaticFact(key) || Reflect.has(libraryProcessOf(), key),
  });
}

/**
 * Node's own files vendored for the realm whose process is `node` (ADR-0018 §7) that a graph running no bootstrap
 * does not take -- the library's, and every process's in a realm with no `node` program: it keeps the engine's own
 * answer for these names (./internals, the engine's `module`, `vm`, `console` and the rest), which it was built over.
 */
const BOOTSTRAP_FILES = new Set(['internal/async_hooks', 'internal/process/task_queues', 'internal/process/permission',
  'internal/options', 'internal/assert', 'internal/v8/startup_snapshot', 'internal/abort_controller',
  'internal/console/global', 'internal/process/execution', 'internal/process/warning', 'internal/source_map/source_map_cache',
  'internal/worker/js_transferable', 'internal/modules/helpers', 'internal/process/per_thread', 'internal/bootstrap/realm',
  'module', 'vm', 'internal/vm/module', '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform',
  '_stream_wrap', '_stream_writable', 'console', 'sys', 'trace_events']);
/** Whether a graph that runs no bootstrap loads the vendored file of the name. */
function vendoredOutsideBootstrap(name: string): boolean {
  return isNodeLibFile(name) && !BOOTSTRAP_FILES.has(name);
}

function nodeLibRequire(specifier: string): unknown {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (vendoredOutsideBootstrap(name)) return loadNodeLib(name);
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
/**
 * A binding as one process's NodeLibScope hands it out: that process's (ADR-0129: a run is attributed by its scope).
 * Every instance it makes is owned by the scope's process and constructed in its run; every method and function runs
 * in its owner's run, so what the binding attributes (a handle, a stdio write, a spawn's parent) is that process's,
 * whatever frame the call came from (a native await in Node's own library included). `owner` is the scope's run.
 */
function bindingSurface(value: unknown, owner: () => ProcessToken | null, process: object): unknown {
  const inScope = <T>(call: () => T): T => withNodeResourceScope(process, call);
  const surface = moduleSurface(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(surface))) {
    const implementation = descriptor.value;
    if (typeof implementation !== 'function') continue;
    // ECMAScript classes have a non-writable own prototype. Ordinary functions run in the owner's run, called or
    // constructed.
    if (Object.getOwnPropertyDescriptor(implementation, 'prototype')?.writable !== false) {
      Object.defineProperty(surface, key, { ...descriptor, value: new Proxy(implementation, {
        apply: (target, self, args) => inScope(() => ownedRun(owner(), () => Reflect.apply(target, self, args))),
        construct: (target, args, newTarget) => inScope(() => ownedRun(owner(), () => Reflect.construct(target, args, newTarget))) as object,
      }) });
      continue;
    }
    const ScopedBinding = class extends implementation {};
    // Its methods run in the instance's owner's run (a handle received over IPC keeps the process that made it).
    for (let prototype = implementation.prototype; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
      for (const [name, method] of Object.entries(Object.getOwnPropertyDescriptors(prototype))) {
        if (name === 'constructor' || typeof method.value !== 'function' || Object.prototype.hasOwnProperty.call(ScopedBinding.prototype, name)) continue;
        const call = method.value as (...values: unknown[]) => unknown;
        Object.defineProperty(ScopedBinding.prototype, name, { ...method, value: function (this: object, ...args: unknown[]) {
          return inScope(() => ownedRun(ownerOfInstance(this), () => call.apply(this, args)));
        } });
      }
    }
    Object.defineProperty(ScopedBinding, 'name', { value: implementation.name, configurable: true });
    // IPC transfers native handles within the shared OS. Node's native-brand
    // checks must recognize the received handle even when its JS facade was
    // allocated by another process. This does not share guest module exports.
    Object.defineProperty(ScopedBinding, Symbol.hasInstance, {
      value: (instance: unknown) => Function.prototype[Symbol.hasInstance].call(implementation, instance),
    });
    // Made in its owner's run and owned by it, a subclass Node's library derives from it included (newTarget).
    const Owned = new Proxy(ScopedBinding, {
      construct: (target, args, newTarget) => {
        const token = owner();
        const instance = inScope(() => ownedRun(token, () => Reflect.construct(target, args, newTarget))) as object;
        setInstanceOwner(instance, token);
        return instance;
      },
    });
    Object.defineProperty(surface, key, { ...descriptor, value: Owned });
  }
  return surface;
}

/**
 * ONE ENVIRONMENT A REALM (ADR-0018 item 2). Node keeps its timer lists in `internal/timers` and their handles in its
 * Environment, one a process. The engine runs every process of a realm on that realm's one loop (the system's,
 * system.ts), whose timer and check handles the `timers` binding drives, so the timer lists over them are the realm's
 * too: every graph's `internal/timers` is the realm's one file, and so is the context frame its timers and Node's
 * `AsyncLocalStorage` keep their stores in. Each process's `timers` and `timers/promises` are its own files over them.
 * So is `internal/crypto/keys`: the crypto binding's NativeKeyObject and NativeCryptoKey classes are made once, as
 * Node's Environment keeps their constructors (crypto_keys.cc CreateNativeKeyObjectClass, CreateCryptoKeyClass), so
 * the file that makes them, and its KeyObject and CryptoKey, are the realm's (ADR-0018 item 7).
 */
export const REALM_ENVIRONMENT: ReadonlySet<string> = new Set(['internal/timers', 'internal/async_context_frame', 'internal/crypto/keys']);
const REALM_BINDINGS = new Set(['timers', 'async_context_frame', 'task_queue']);

/**
 * The process a realm whose program is `node` is (ADR-0018 §7): its global is the realm's own `globalThis`, its code
 * compiled as Node compiles it, with no free name rewritten, no Proxy and no `with` (realm.ts).
 */
const nodeRealmProcesses = new WeakSet<object>();
export function markNodeRealmProcess(process: object): void { nodeRealmProcesses.add(process); }
export function isNodeRealmProcess(process: unknown): boolean {
  return process !== null && typeof process === 'object' && nodeRealmProcesses.has(process);
}

/** A realm's own loaders, where its process is `node` and Node's bootstrap made them (realm.ts). */
export interface RealmLoaders {
  require(id: string): unknown;
  internalBinding(name: string): unknown;
}

class NodeLibScope {
  private readonly modules = new Map<string, NodeLibModule>();
  private readonly internals = new Map<string, unknown>();
  private readonly bindings = new Map<string, unknown>();
  private readonly surfaces = new Map<string, unknown>();
  /** Node's BuiltinModule and internalBinding of the realm, once its bootstrap has run: this process's whole graph. */
  realm: RealmLoaders | undefined;
  constructor(readonly process: object) {}
  /** The run this scope's process is (a guest's own runtime has none: the realm process's). */
  private readonly owner = (): ProcessToken | null => __tokenForProcess(this.process as Process);

  readonly require: NodeLibRequire = (specifier) => {
    const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (this.realm) return this.realm.require(name);
    if (name === 'process') return this.process;
    if (name === 'fs/promises') return this.require('internal/fs/promises').exports;
    if (name === 'dns/promises') return this.require('dns').promises;
    if (name === 'path/posix') return this.require('path').posix;
    if (name === 'path/win32') return this.require('path').win32;
    if (name === 'assert/strict') return this.require('assert').strict;
    if (name === 'util/types') return this.require('internal/util/types');
    if (REALM_ENVIRONMENT.has(name)) return loadNodeLib(name);
    if (vendoredOutsideBootstrap(name)) return this.load(name);
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

  readonly binding = (name: string): unknown => this.realm ? this.realm.internalBinding(name) : this.engineBinding(name);

  /** The engine's own binding of a name for this process, which a realm's internalBinding answers a name it makes none of with. */
  readonly engineBinding = (name: string): unknown => {
    if (!this.bindings.has(name)) {
      if (REALM_BINDINGS.has(name)) {
        this.bindings.set(name, internalBinding(name));
      } else if (['fs', 'fs_dir', 'fs_event_wrap'].includes(name) && libnodeAttached()) {
        // A process whose program is `node`: its fs is libuv's, uv_fs_* in its kernel (ADR-0018 item 6).
        const context = fsContext(() => this.require('buffer').Buffer,
          (value) => (this.require('internal/errors') as { determineSpecificType(value: unknown): string }).determineSpecificType(value),
          (id) => this.require(id));
        this.bindings.set('fs', bindingSurface(createNodeFileBinding(context).fsBinding, this.owner, this.process));
        this.bindings.set('fs_dir', bindingSurface(createNodeDirBinding(context).fsDirBinding, this.owner, this.process));
        this.bindings.set('fs_event_wrap', bindingSurface(createFsEventWrapBinding(context).fsEventWrapBinding, this.owner, this.process));
      } else if (['fs', 'fs_dir', 'fs_event_wrap'].includes(name)) {
        // Exported handles and encoded names belong to this graph; the fd
        // allocator, open-file descriptions and filesystem remain shared OS state.
        const fs = createFsBindings(() => this.require('buffer').Buffer);
        this.bindings.set('fs', bindingSurface(fs.fsBinding, this.owner, this.process));
        this.bindings.set('fs_dir', bindingSurface(fs.fsDirBinding, this.owner, this.process));
        this.bindings.set('fs_event_wrap', bindingSurface(fs.fsEventWrapBinding, this.owner, this.process));
      } else if (name === 'os') {
        this.bindings.set(name, createOsBinding(this.process));
      } else if (name === 'messaging') {
        // Its MessagePort is this graph's, whose `internal/worker/io` reshapes its prototype (ADR-0018 item 9).
        this.bindings.set(name, createMessagingBinding(this.require));
      } else if (name === 'errors') {
        this.bindings.set(name, { ...errorsBinding, getErrorSourcePositions: (error: object) => errorSourcePositions(this.process, error) });
      } else if (name === 'diagnostics_channel') {
        this.bindings.set(name, createDiagnosticsChannelBinding());
      } else if (name === 'wasm_web_api') {
        this.bindings.set(name, createWasmWebApiBinding());
      } else if (name === 'blob') {
        // A realm's blob URL registry is its process's (node_blob.cc's BlobBindingData).
        this.bindings.set(name, createBlobBinding());
      } else {
        this.bindings.set(name, name === 'util' ? createUtilBinding(this.require) : bindingSurface(internalBinding(name), this.owner, this.process));
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
      compileNodeLib(name, record, this.require, this.process, this.binding, processGlobalOf?.(this.process));
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
/** process.binding and vendored internalBinding share the same process-owned native surface. */
export function nodeLibBindingFor(owner: object, name: string): unknown { return scopeFor(owner).binding(name); }

/** The engine's own binding of a name for a process, beneath any realm's loaders (realm.ts `engineBinding`). */
export function engineBindingFor(owner: object, name: string): unknown { return scopeFor(owner).engineBinding(name); }

/** A process's graph becomes its realm's: every builtin and binding it asks for is Node's bootstrap's (ADR-0018 §7). */
export function adoptRealmLoaders(owner: object, loaders: RealmLoaders): void {
  const scope = scopeFor(owner);
  if (scope.realm) throw new Error('node-lib: this process already has its realm\'s loaders');
  scope.realm = loaders;
}

export function loadNodeLibFor(owner: object, name: string): any {
  return scopeFor(owner).require(name);
}
export function hasNodeLibModule(name: string): boolean {
  return isNodeLibFile(name) || nodeLibPublic(name) !== undefined
    || ['path/posix', 'path/win32', 'assert/strict', 'util/types', 'fs/promises', 'timers/promises', 'dns/promises'].includes(name);
}
export function nativeModuleFor(owner: object, name: string, create: () => unknown): unknown {
  return scopeFor(owner).surface(name, create);
}

/** The global object a process's builtins run in (`setNodeLibGlobal`), the realm's where none is named. */
export function nodeLibGlobalFor(owner: object): object {
  return processGlobalOf?.(owner) ?? globalThis;
}

/**
 * A file compiled as the body of a function whose outer parameters are `globalThis` and the scope objects its free
 * names resolve through (ADR-0015 §2), and whether its names were rewritten onto the read scope (`scoped`) or it runs
 * inside `with` of the global scope object because they are dynamic.
 */
interface ScopedFunction { compiled: Function; scoped: boolean }
/** A scoped body (scoped-body.ts) compiled, its outer parameters `globalThis` and the scope objects. */
function compileBody({ body, scoped }: ScopedBody): ScopedFunction {
  // eslint-disable-next-line no-new-func
  return { compiled: new Function('globalThis', '__substrateGuestScope', '__substrateGuestTypeof', body), scoped };
}
/** Calls a compiled file's outer function with a global and the scope objects over it. */
function withGlobal(file: ScopedFunction, global: object): Function {
  const scopes = guestScopesOf(global);
  return file.compiled(global, file.scoped ? scopes.read : scopes.withGlobal, scopes.typeOf) as Function;
}

const compiledDependencies = new Map<string, ScopedFunction>();
const dependencyEval = eval;
/**
 * A dependency's CommonJS file evaluated once per process, as its builtins are (`compileNodeLib`): its `process`,
 * `require` and `globalThis` are that process's, and each name of `globals` is that process's global's value of the
 * name, or the value `given` names for it, so what the file takes from its host when it is evaluated is that process's.
 * Every other free name it reads is that process's global's too (ADR-0015).
 */
export function loadDependencyFor(owner: object, name: string, source: string, globals: readonly string[],
  given: Readonly<Record<string, unknown>> = {}): unknown {
  return scopeFor(owner).surface(name, () => {
    // Where the realm is the process's (ADR-0018 §7), the file is compiled as Node compiles one, at the realm's scope.
    if (isNodeRealmProcess(owner)) {
      const parameters = ['exports', 'require', 'module', 'process', ...globals];
      const made = dependencyEval(`(function (${parameters.join(', ')}) {${source}\n})\n//# sourceURL=${name}`) as Function;
      const realm = globalThis as unknown as Record<string, unknown>;
      const module = { exports: {} as unknown };
      made(module.exports, scopeFor(owner).require, module, owner, ...globals.map((key) => key in given ? given[key] : realm[key]));
      return module.exports;
    }
    let compiled = compiledDependencies.get(name);
    if (!compiled) {
      compiled = compileBody(scopedBody(['exports', 'require', 'module', 'process', ...globals], source, name));
      compiledDependencies.set(name, compiled);
    }
    const global = nodeLibGlobalFor(owner) as Record<string, unknown>;
    const module = { exports: {} as unknown };
    withGlobal(compiled, global)(module.exports, scopeFor(owner).require, module, owner, ...globals.map((key) => key in given ? given[key] : global[key]));
    return module.exports;
  });
}

function newNodeLibRecord(name: string): NodeLibModule {
  if (!isNodeLibFile(name)) throw new Error(`node-lib: no vendored file for '${name}'`);
  return { exports: {}, id: name, filename: `node:${name}`, loaded: false };
}

/**
 * The global object a process's builtins run in: Node runs every builtin in its process's context, so a builtin's
 * `globalThis` is that process's global (undici keeps its global dispatcher there, and a program's own undici sets it
 * there). The engine runs many processes in one realm and gives each a global of its own; it names it here.
 */
export function setNodeLibGlobal(of: (process: object) => object): void {
  processGlobalOf = of;
}

/**
 * A builtin's file as a function, compiled once a realm (S2 AC-LC12): every Node process's realm compiled its builtins
 * at their first require, on its own start (LibreChat run 4: 332 ms of `compileNodeLib` self time over its 20 Node
 * realms). Compiling runs nothing: each load still calls it into a module scope of its own, given its process's
 * global as `globalThis` (a scope around the file's own, so a file that declares the name keeps its declaration).
 *
 * Every other free name the file reads is its process's global's too (ADR-0015), as Node compiles a builtin inside
 * its process's context. The file's text is rewritten for it when the library is built (bodies.ts), and compiled
 * once a realm, here (a spare pays it in `precompileNodeLib`); the vendored file itself is unedited.
 */
function compiledNodeLibFor(name: string): ScopedFunction {
  compiledNodeLib ??= new Map<string, ScopedFunction>();
  let compiled = compiledNodeLib.get(name);
  if (!compiled) {
    compiled = compileBody(nodeLibBody(name)!);
    compiledNodeLib.set(name, compiled);
  }
  return compiled;
}
/**
 * Compiles a builtin's file ahead of its first require, running none of it: a realm that waits idle for its process
 * (a spare) spends that wait here instead of in the process's start. False for a name that has no file, or one
 * already compiled.
 */
export function precompileNodeLib(name: string): boolean {
  if (!isNodeLibFile(name) || compiledNodeLib?.has(name)) return false;
  compiledNodeLibFor(name);
  return true;
}

/** The scope Node's `BuiltinModule.compileForInternalLoader` gives a builtin. */
function compileNodeLib(name: string, record: NodeLibModule, require: NodeLibRequire = nodeLibRequire,
  process: object = nodeLibProcessOf(), binding: (name: string) => unknown = internalBinding, global: object = globalThis): void {
  withGlobal(compiledNodeLibFor(name), global)(record.exports, require, record, process, binding, primordialsOf());
  // lib/buffer.js defines `transcode` only where Node is built with ICU, which this engine is not; the one
  // function is bound here (binding/transcode.ts) rather than left undefined.
  if (name === 'buffer') {
    const made = record.exports as { transcode?: unknown; Buffer: { from(bytes: Uint8Array): unknown } };
    if (made.transcode === undefined) made.transcode = transcodeFor((bytes) => made.Buffer.from(bytes));
  }
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
    // Node's library owns listener semantics; the engine owns the native
    // event-loop boundary that invokes those listeners. Nested emits count once.
    const prototype = (exports as { prototype: { emit: (...args: unknown[]) => unknown } }).prototype;
    const emit = prototype.emit;
    prototype.emit = function(this: unknown, ...args: unknown[]) {
      return withGuestExecution(() => {
        if (args[0] === 'connect' || args[0] === 'timeout') traceSocketConnect(`socket-${args[0]}`, this, undefined);
        return emit.apply(this, args);
      }, 'emit', args[0]);
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
  if (name === 'internal/timers') {
    // lib/internal/bootstrap/node.js: the loop's handles call Node's own timer callbacks, whose ticks between two
    // callbacks are the process's tick queue (internal/process/task_queues `runNextTicks`).
    const { runNextTicks } = nodeLibRequire('internal/process/task_queues') as { runNextTicks: () => void };
    const { processImmediate, processTimers } = (exports as {
      getTimerCallbacks(runNextTicks: () => void): { processImmediate: () => void; processTimers: (now: number) => number };
    }).getTimerCallbacks(runNextTicks);
    (internalBinding('timers') as { setupTimers(immediate: () => void, timers: (now: number) => number): void })
      .setupTimers(processImmediate, processTimers);
    return;
  }
  if (name === 'internal/util/debuglog') {
    const env = (process as { env?: Record<string, string | undefined> }).env;
    (exports as { initializeDebugEnv?: (value: string) => void }).initializeDebugEnv?.(env?.NODE_DEBUG ?? '');
    return;
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
