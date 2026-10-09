/**
 * Runtime - Execute user code with shimmed Node.js globals
 *
 * ESM to CJS transformation is now handled during npm install by transform.ts
 * using esbuild-wasm. This runtime just executes the pre-transformed CJS code.
 */

import { VirtualFS } from './virtual-fs';
import { rememberCompiledSource } from './error-source';
import { startGuestLoop, withGuestExecution } from './guest-loop';
import { guestPromise, intrinsicPromise } from './promise-ownership';
import { guestFetch, rememberRequestBodySource } from './fetch-transport';
import { installNodeResponse } from './node-response';
import { withNodeRequestBody } from './node-body';
import { forGuestRealm, installGuestRealm, takeFromHost, defineOnHost, heldWork } from './host-globals';
import type { IRuntime, IExecuteResult, IRuntimeOptions } from './runtime-interface';
import type { PackageJson } from './types/package-json';
import { simpleHash } from './utils/hash';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PREPARED_MODULES_FORMAT, PREPARED_MODULES_KEPT, preparedModuleKind, preparedModuleKeyOf, isPreparedModuleKey } from './prepared-key';
import { uint8ToBase64, uint8ToHex } from './utils/binary-encoding';
import { createFsShim, FsShim } from './shims/fs';
import * as pathShim from './shims/path';
import { createProcess, Process } from './shims/process';
import {
  httpModule, httpsModule, httpCommonModule, httpIncomingModule, httpOutgoingModule,
  httpServerModule, httpClientModule, httpAgentModule,
} from './node-lib/http-module';
import { netModule as netShim } from './node-lib/net-module';
import { errname as __uvErrname } from './node-lib/binding/uv';
import { createTimersModule } from './node-lib/timers';
import { guestTimerFunctions } from './guest-timers';
import { stackOverrides } from './stack-overrides';
export { pendingGuestTimers, stopGuestTimers } from './guest-timers';
import eventsShim from './node-lib/events-module';
import { streamModule as streamShim, streamPromisesModule as streamPromises } from './node-lib/stream-module';
import * as urlShim from './shims/url';
import utilShim from './node-lib/util-module';
import * as cryptoShim from './shims/crypto';
import * as stringDecoderShim from './shims/string_decoder';
import { createDnsModule } from './shims/dns';
import { bufferModule as bufferShim } from './node-lib/buffer-module';
import { initChildProcess } from './shims/child_process';
import { childProcessModule as childProcessShim } from './node-lib/child-process-module';
import { getServerBridge } from './server-bridge';
import * as moduleShim from './shims/module';
import { RunModuleHooks, CJS_CONDITIONS } from './node-lib/module-hooks';
import { kRunFilesystem } from './node-lib/binding/fs';
import { esmNamespaceOf, syncBuiltinESMExports, loadNodeLibFor, hasNodeLibModule, nativeModuleFor } from './node-lib/load';
import { fsModule, fsModuleFor } from './node-lib/fs-module';
import {
  assertModule, querystringModule, punycodeModule, constantsModule,
  diagnosticsChannelModule, osModule, ttyModule, readlineModule, readlinePromisesModule, zlibModule,
} from './node-lib/small-modules';
import { recordedProxies } from './node-lib/internals/util';
import { __nodeResolverFor } from './node-resolver';
import { sayNativeStreamCounts } from './native-stream-binding';
import { nodeLibBindingsAsked } from './node-lib/load';
import type { ResolutionKept } from './node-resolution';
import { freshEsModuleImportTurns, nodeLineOf } from './node-line';
import { setSourceMapsSupportOf, sourceMapsSupportOf } from './node-lib/internals/events-util';
import { ERR_INVALID_ARG_TYPE } from './node-internals';
import { Buffer as BufferPolyfill } from './node-lib/buffer-module';
import { PUNYCODE_SOURCE } from './punycode-source';
import * as perfHooksShim from './shims/perf_hooks';
import * as workerThreadsShim from './shims/worker_threads';
import { guestMessageGlobals, guestMessageModule } from './guest-message-ports';
import { validateTransferList } from './transfer-ownership';
import * as esbuildShim from './shims/esbuild';
import * as rollupShim from './shims/rollup';
import * as v8Shim from './shims/v8';
import * as tlsShim from './shims/tls';
import * as http2Shim from './shims/http2';
import * as clusterShim from './shims/cluster';
import * as dgramShim from './shims/dgram';
import * as replShim from './shims/repl';
import * as vmShim from './shims/vm';
import * as inspectorShim from './shims/inspector';
import * as asyncHooksShim from './shims/async_hooks';
import * as domainShim from './shims/domain';
import { createWasiModule, type WasiHostFs, type WasiModule } from './shims/wasi';

import { resolve as resolveExports, imports as resolveImports } from 'resolve.exports';
import { transformEsmToCjsSimple, setNodeLowering, __cjsExports, __cjsObject, __substrateHasEsmSyntax } from './code-transforms';
import { applySourceEdits } from './source-edits';
import { canStripTypes, stripModuleTypes, transformsTypes } from './node-lib/typescript-module';
import * as acorn from 'acorn';

/**
 * Walk an acorn AST recursively, calling the callback for every node.
 */
function walkAst(node: any, callback: (node: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') {
    callback(node);
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && typeof item.type === 'string') {
            walkAst(item, callback);
          }
        }
      } else if (typeof child.type === 'string') {
        walkAst(child, callback);
      }
    }
  }
}

/**
 * On the in-page lane a guest module runs where the page's `document`,
 * `window`, and `location` are in scope, so a package that asks
 * `typeof document` to tell a browser from Node takes the browser path and
 * fails on Node work. A Node program sees none of them; the module wrapper
 * shadows them, and the guest's `globalThis` is a proxy over the host's that
 * answers for them.
 */
const __substrateGuestGlobals = new WeakMap<Process, Record<string, unknown>>();
const __substrateAsyncFunction = (async function() {}).constructor;
const __substrateFunctionScope = Function("__substrateFunctionGlobals", "__substrateFunctionSource", "with (__substrateFunctionGlobals) { return eval('(' + __substrateFunctionSource + ')'); }");
function __substrateGuestConstructor(Constructor: unknown, process: Process): unknown {
  if (Constructor === intrinsicPromise) return guestPromise(process);
  if (Constructor !== Function && Constructor !== __substrateAsyncFunction) return Constructor;
  return new Proxy(Constructor as object, { construct(target, args) {
    const compiled = Reflect.construct(target as new (...args: unknown[]) => unknown, args);
    return __substrateFunctionScope(__substrateGuestGlobal(process), String(compiled));
  } });
}
/**
 * `vm.runInThisContext` runs its script in the calling process's global scope,
 * as Node's does. The shim evaluated it in the host's, so a script saw the
 * worker's own timers: jiti evaluates every module it loads this way, and
 * pi-mcp-adapter's `setInterval(...).unref()` threw "unref is not a function"
 * because the browser's `setInterval` returns a number. The script runs inside
 * the process's guest global, as a guest `Function` does
 * (`__substrateGuestConstructor`).
 */
const __substrateScriptScope = Function("__substrateScriptGlobals", "__substrateScriptSource", "with (__substrateScriptGlobals) { return eval(__substrateScriptSource); }");
const __substrateGuestVms = new WeakMap<Process, unknown>();
function __substrateGuestVm(process: Process): unknown {
  let vm = __substrateGuestVms.get(process);
  if (vm) return vm;
  const run = (code: string): unknown => __substrateScriptScope(__substrateGuestGlobal(process), String(code));
  class Script extends vmShim.Script {
    override runInThisContext(_options?: object): unknown { return run((this as unknown as { code: string }).code); }
  }
  vm = { ...vmShim, Script, runInThisContext: (code: string, _options?: object) => run(code), default: undefined };
  (vm as { default: unknown }).default = vm;
  __substrateGuestVms.set(process, vm);
  return vm;
}
/**
 * A `.ts`, `.mts` or `.cts` file runs with its types stripped, as Node runs
 * one since 22.18, before the module's imports are read -- the entry a `node`
 * command names and every module it loads alike. A page that loaded a
 * stripper into the realm supplies it; elsewhere the engine erases the types
 * itself, through Node's own `typescript.js` over amaro
 * (`node-lib/typescript-module.ts`): strip-only, positions kept, the syntax
 * Node refuses refused with Node's error. Before this, a realm with no stripper
 * registered -- the engine under Node -- ran the file as JavaScript and died on
 * its first type (`Unexpected identifier 'SlackReply'`), and an entry was never
 * stripped anywhere. A realm that can load neither runs the file as it is.
 *
 * `format` is what a load hook named, and it decides instead of the extension
 * where a hook gave one.
 */
function __substrateModuleTypes(code: string, resolvedPath: string, format: string | undefined, process: unknown): string {
  const typescript = format === undefined
    ? /[.](?:ts|mts|cts)$/u.test(resolvedPath) && !resolvedPath.endsWith('.d.ts')
    : format === 'typescript' || format === 'commonjs-typescript' || format === 'module-typescript';
  if (!typescript) return code;
  const registered = (globalThis as { __substrateStripTypes?: (code: string, filename: string) => string }).__substrateStripTypes;
  if (typeof registered === 'function') return registered(code, resolvedPath);
  if (!canStripTypes()) return code;
  return stripModuleTypes(code, resolvedPath, process as object);
}
/**
 * The name the script of a module's body carries.
 *
 * Node compiles a module from its file, so every frame of its body names the
 * file and counts the file's own lines. The engine evaluates a module's body,
 * and V8 names an eval'd script only when the script says so: a
 * `//# sourceURL=` directive at its end is the whole of it. Without one every
 * stack a guest printed read `at eval (eval at runModuleBody (.../node-execution-worker.js:84621:17), <anonymous>:96:613)`
 * — no file, and a line offset by the wrapper.
 *
 * A `file:` URL is named by the path it points at. A name a directive cannot
 * hold — a `data:` module whose URL carries a line break — names nothing,
 * since a broken directive would be read as code.
 */
function __substrateSourceURL(resolvedPath: string): string {
  let name = resolvedPath;
  if (name.startsWith('file://')) {
    try { name = decodeURIComponent(new URL(name).pathname); } catch { /* a URL that will not parse names itself */ }
  }
  return /[\n\r]/u.test(name) ? '' : `\n//# sourceURL=${name}`;
}
function __substrateScopeGlobalCalls(code: string): string {
  if (!/\b(?:new|fetch|Promise)\b/u.test(code)) return code;
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true }); }
  catch { return code; }
  const positions: Array<[number, number, string]> = [];
  walkAst(ast, node => {
    // A function's source is also data: a program sends `String(fn)` to be
    // run elsewhere (a browser page, a worker), where the module wrapper's
    // names do not exist. The rewrite is the original `new` there.
    if (node.type === "NewExpression" && node.callee.type === "Identifier") {
      const callee = code.slice(node.callee.start, node.callee.end);
      positions.push([node.callee.start, node.callee.end, "(typeof __substrateGuestConstructor==='function'?__substrateGuestConstructor(" + callee + ",$process):" + callee + ")"]);
    }
    // The narrow with-scope below keeps global replacements dynamic.
    // Remove its object receiver for ordinary calls (including local
    // bindings, whose bare-call receiver was already undefined).
    const called = node.type === "CallExpression" ? node.callee : node.type === "TaggedTemplateExpression" ? node.tag : undefined;
    if (called?.type === "Identifier" && (called.name === "fetch" || called.name === "Promise")) positions.push([called.start, called.end, "(0," + code.slice(called.start, called.end) + ")"]);
  });
  return applySourceEdits(code, positions.sort((a,b) => b[0] - a[0]));
}
/**
 * Work the host is doing for a guest, counted while it is outstanding.
 *
 * Node keeps a process alive for its outstanding requests, not for its
 * promises: `new Promise(() => {})` alone exits, while an awaited file read
 * or a compile does not, because a request is pending underneath. The engine
 * counts a guest's timers and its held work the same way, and a run ends when
 * nothing is pending. What it never counted is the work the host does on a
 * guest's behalf behind a promise, so a guest that wrote the ordinary thing,
 * `await WebAssembly.instantiate(bytes)`, was ended mid-await and the line
 * after it never ran: the shape every one of Node's WASI tests is written in,
 * and the shape a napi-rs wasm loader uses. Such a call is this engine's
 * analogue of one of those requests, and it holds the run while it is in
 * flight, exactly as the engine's own esbuild and rollup work already does.
 */
function __substrateHeldAsync<T extends (...args: never[]) => Promise<unknown>>(call: T, host: unknown): T {
  return function (this: unknown, ...args: Parameters<T>) {
    const held = heldWork();
    held.count += 1;
    let settled: Promise<unknown>;
    try { settled = call.apply(this === undefined ? host : this, args); }
    catch (error) { held.count -= 1; throw error; }
    if (!(settled instanceof Promise)) { held.count -= 1; return settled; }
    return settled.finally(() => { held.count -= 1; });
  } as T;
}

/** The host namespaces whose asynchronous calls are work the guest is waiting on. */
const __substrateHeldNamespaces: Record<string, readonly string[]> = {
  WebAssembly: ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming'],
};

/** The names `for (const name in globalThis)` gives in Node v24.21.0, measured (`node -e` of that loop), less the module wrapper's five. */
/** Node's own shape for the globals it gives every program that are accessors (v24.21.0, `Object.getOwnPropertyDescriptor(globalThis, name)`); the rest are writable values. */
const NODE_GLOBAL_ACCESSORS: Record<string, { set: boolean; enumerable: boolean } | undefined> = { __proto__: null as never, performance: { set: true, enumerable: true }, Buffer: { set: true, enumerable: false }, crypto: { set: false, enumerable: true } };
const NODE_ENUMERABLE_GLOBALS = new Set(['global', 'clearImmediate', 'setImmediate', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout', 'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'performance', 'fetch', 'crypto', 'navigator']);
/** The names whose shape the guest's global takes from Node: those fifteen and two it does not enumerate, `Buffer` and `globalThis`. `process` is not among them: see the `get` trap. `navigator` is among them and is the guest's own accessor from the start. */
const NODE_GLOBALS = new Set([...NODE_ENUMERABLE_GLOBALS, 'Buffer', 'globalThis']);
function __substrateGuestGlobal(process: Process): Record<string, unknown> {
  let guest = __substrateGuestGlobals.get(process);
  if (guest) return guest;
  const host = globalThis as unknown as Record<string, unknown>;
  const fetch = typeof host.fetch === 'function' ? guestFetch(process, host.fetch as typeof globalThis.fetch) : host.fetch;
  // A guest's global object is an ordinary object to the guest, as Node's is: what it assigns, defines or deletes
  // is ITS, and every trap below reads that before anything else. Two places hold it and nothing else does:
  //   - the proxy's own target, for a name the guest has assigned or defined (a value, or an accessor);
  //   - `removed`, for a name the guest deleted, so what stands behind it does not come back.
  // A name the guest has not touched is answered by what stands behind it (`standing`, below): the engine's own
  // object for a name it provides, the realm's otherwise. It was three slots and five special cases, and a trap
  // that lacked a case answered from behind the guest's own write (an assignment to `atob` was ignored).
  // The realm's `document`, `window` and `location` are no globals of Node's and a guest starts without them, which
  // is the state of a name it deleted: one it then makes (a DOM test setup's `globalThis.window = dom.window`) is its
  // own like any other.
  const removed = new Set<string | symbol>(['document', 'window', 'location']);
  /** What a guest assigned to `process`, where it is not the run's own process object (the `set` trap). */
  let assignedProcess: { value: unknown } | undefined;
  const boundGlobals = new Map<string | symbol, { original: unknown; bound: unknown }>();
  // A key the guest defined that the host would not take (a name the host
  // holds non-configurable, `navigator` under a worker's authority) lives on
  // the proxy's own target, and is this guest's from then on.
  const shadowed = (target: object, key: string | symbol): boolean => Reflect.getOwnPropertyDescriptor(target, key) !== undefined;
  const hostAtStart = new Set<string | symbol>(Reflect.ownKeys(host));
  const localGlobals = Object.create(null);
  Object.defineProperty(localGlobals, "Promise", { value: intrinsicPromise, writable: true, configurable: true, enumerable: false });
  // Node's own navigator, scoped to this process; never expose WorkerNavigator.
  Object.defineProperties(localGlobals, {
    navigator: { configurable: true, enumerable: true,
      get: () => loadNodeLibFor(process, 'internal/navigator').navigator },
    Navigator: { configurable: true, enumerable: false,
      get: () => loadNodeLibFor(process, 'internal/navigator').Navigator,
      set: value => Object.defineProperty(localGlobals, 'Navigator', {
        value, writable: true, configurable: true, enumerable: false,
      }) },
  });
  // Guest-written globals are process-local, including absent Node globals.
  // Assigning global.Worker/globalThis.self must create the corresponding
  // bare binding without exposing or mutating the browser worker authority.
  Object.defineProperties(localGlobals, {
    Worker: { value: undefined, writable: true, configurable: true, enumerable: false },
    self: { value: undefined, writable: true, configurable: true, enumerable: false },
  });
  // These stand-ins are how the realm's own names are kept from a guest, and are no globals of Node's: they are not
  // enumerated. One a guest assigns becomes its global and is enumerated from then on (the `set` trap below).
  const guestAssigned = new Set<string | symbol>();
  // Browser worker messaging is host authority, not a Node global. A guest's
  // adapter may define its own names without hijacking the host transport.
  const browserTransportGlobals = ['postMessage', 'onmessage', 'onmessageerror', 'close', 'addEventListener', 'removeEventListener', 'dispatchEvent'];
  for (const key of browserTransportGlobals) Object.defineProperty(localGlobals, key, {
    value: undefined, writable: true, configurable: true, enumerable: false,
  });
  // The names Node gives as accessors are the guest's own accessors from the start, as `navigator` is: each answers
  // what stands behind the name until its setter is called, and from then what was assigned. Being properties of
  // the target, a program may read their descriptor, define it back, change an attribute or delete them as on any
  // object, and nothing the proxy reports about them has to be made up.
  for (const [name, shape] of Object.entries(NODE_GLOBAL_ACCESSORS)) {
    let assigned = false, held: unknown;
    Object.defineProperty(localGlobals, name, {
      get: () => assigned ? held : standing(name),
      set: shape!.set ? (value: unknown) => { assigned = true; held = value; } : undefined,
      configurable: true, enumerable: shape!.enumerable,
    });
  }
  const isLocalGlobal = (key: string | symbol) => ['Promise', 'navigator', 'Navigator', 'Worker', 'self', ...browserTransportGlobals].includes(key as string);
  /** What stands behind a name the guest has not made its own. */
  const standing = (key: string | symbol): unknown => {
      if (key === "global" || key === "globalThis") return guest;
      if (key === "fetch") return fetch;
      // The guest's `Buffer` is the one `require('buffer')` answers with, read when the guest asks rather than when
      // this closure is made: a guest that compared the two found two objects.
      if (key === "Buffer") return loadNodeLibFor(process, 'buffer').Buffer;
      if (key === "MessageChannel" || key === "MessagePort") return guestMessageGlobals(process)[key as "MessageChannel" | "MessagePort"];
      // `perf_hooks`'s own object.
      if (key === "performance") return perfHooksShim.performance;
      const value = Reflect.get(host, key, host);
      if (key === "structuredClone" && typeof value === "function") {
        if (boundGlobals.get(key)?.original !== value) boundGlobals.set(key, {
          original: value,
          bound: (input: unknown, options?: { transfer?: unknown[] }) => {
            validateTransferList(options?.transfer);
            return value.call(host, input, options);
          },
        });
        return boundGlobals.get(key)!.bound;
      }
      if (["setTimeout", "clearTimeout", "setInterval", "clearInterval"].includes(key as string) && typeof value === "function") {
        // The guest's timers, counted for it; rebuilt if the host's own change.
        if (boundGlobals.get(key)?.original !== value) {
          const timers = guestTimerFunctions(process, host);
          for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const) boundGlobals.set(name, { original: Reflect.get(host, name, host), bound: timers[name] });
        }
        return boundGlobals.get(key)!.bound;
      }
      // A namespace whose asynchronous calls the guest waits on: the calls are
      // wrapped, everything else passes through, so `instanceof` and the
      // synchronous constructors are the host's own.
      const held = __substrateHeldNamespaces[key as string];
      if (held !== undefined && value !== null && typeof value === "object") {
        if (boundGlobals.get(key)?.original !== value) {
          const namespace = value as Record<string, unknown>;
          boundGlobals.set(key, { original: value, bound: new Proxy(namespace, {
            get(target, name, receiver) {
              const member = Reflect.get(target, name, receiver);
              if (!held.includes(name as string) || typeof member !== "function") return member;
              return __substrateHeldAsync(member as (...args: never[]) => Promise<unknown>, target);
            },
          }) });
        }
        return boundGlobals.get(key)!.bound;
      }
      // `atob` and `btoa` are the `buffer` module's own, as in Node, where the global IS `require('buffer').atob`:
      // a program that compares the two (Node's test/common does, to know its globals) found two functions.
      if (key === "atob" || key === "btoa") return (loadNodeLibFor(process, 'buffer') as Record<string, unknown>)[key];
      if (["structuredClone", "queueMicrotask"].includes(key as string) && typeof value === "function") {
        if (boundGlobals.get(key)?.original !== value) boundGlobals.set(key, { original: value, bound: value.bind(host) });
        return boundGlobals.get(key)!.bound;
      }
      return value;
  };
  guest = new Proxy(localGlobals, {
    get(target, key) {
      // `process` is the realm's as well as the guest's: the engine's own bindings find the run that is asking by
      // the realm's `process`, which each module's start assigns (the wrapper's `globalThis.process = $process`).
      // So it is answered and assigned here, ahead of the guest's own properties; a guest may still delete it.
      if (key === "process") return removed.has(key) ? undefined : assignedProcess ? assignedProcess.value : process;
      if (shadowed(target, key)) return Reflect.get(target, key, guest);
      if (removed.has(key)) return undefined;
      return standing(key);
    },
    set(target, key, value) {
      if (isLocalGlobal(key) && !guestAssigned.has(key) && (key === 'Worker' || key === 'self' || browserTransportGlobals.includes(key as string))) {
        guestAssigned.add(key);
        return Reflect.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
      }
      // The run's own process is written to the realm, where the engine reads it. Anything else a guest assigns is
      // kept for the guest alone: written to the realm it would stand where the engine looks for the asking run,
      // and every filesystem call after it would find no run ("this realm has no filesystem").
      if (key === "process") {
        removed.delete(key);
        if (value !== process) { assignedProcess = { value }; return true; }
        assignedProcess = undefined;
        return Reflect.set(host, key, value, host);
      }
      // The guest's own property takes the assignment as any object's does: a value is replaced, an accessor's
      // setter is called, one with no setter or not writable ignores it.
      if (shadowed(target, key)) return Reflect.set(target, key, value, target);
      if (removed.has(key)) { removed.delete(key); return Reflect.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true }); }
      // One of Node's value globals, not yet the guest's own: it becomes so, with the shape it had.
      if (typeof key === 'string' && NODE_GLOBALS.has(key)) return Reflect.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: key !== 'globalThis' });
      if (Reflect.set(host, key, value, host)) return true;
      // A global the host holds read-only (a confined realm's \`WebSocket\`) is
      // still the guest's to replace, as Node's globals are: undici's
      // \`install()\` assigns \`globalThis.WebSocket\` and Pi died on the refusal.
      // The value becomes the guest's own binding; the host's is untouched.
      return Reflect.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
    },
    has(target, key) {
      if (removed.has(key)) return false;
      if (shadowed(target, key)) return true;
      return isLocalGlobal(key) ? false : (typeof key === 'string' && NODE_GLOBALS.has(key)) || key in host;
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      for (const key of Reflect.ownKeys(host)) if (!isLocalGlobal(key) && !removed.has(key) && !keys.includes(key)) keys.push(key);
      for (const key of NODE_GLOBALS) if (!isLocalGlobal(key) && !removed.has(key) && !keys.includes(key)) keys.push(key);
      return keys;
    },
    deleteProperty(target, key) {
      // The guest's own property goes as any object's does (one it defined non-configurable stays); what stood behind
      // the name is the guest's no longer either.
      if (shadowed(target, key) && !Reflect.deleteProperty(target, key)) return false;
      removed.add(key);
      return true;
    },
    getOwnPropertyDescriptor(target, key) {
      // The guest's own first: a key it defined non-configurable is reported from the target, as a proxy must.
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own) return own;
      if (removed.has(key) || isLocalGlobal(key)) return undefined;
      // Node's shape for `process`: an accessor with a setter, not enumerated.
      if (key === "process") return { get: () => guest!.process, set: (value: unknown) => { guest!.process = value; }, configurable: true, enumerable: false };
      // One of Node's value globals the guest has not touched: writable, configurable, enumerable but for `globalThis`.
      if (typeof key === 'string' && NODE_GLOBALS.has(key)) return { value: standing(key), writable: true, configurable: true, enumerable: key !== 'globalThis' };
      const descriptor = Reflect.getOwnPropertyDescriptor(host, key);
      // What the realm had before this guest (a worker's `self`, `postMessage`, `onmessage`, the engine's own names)
      // is reachable and is not ENUMERATED unless Node enumerates that name: `for (const name in global)` in a
      // guest gave Node's fifteen names and eleven of the realm's. A program that walks its globals to find what it
      // leaked found those (Node's own test/common does at every exit: 186 of its files failed on that alone once
      // `exit` was emitted when a loop drains). A global the guest itself adds is enumerable as it defined it.
      if (descriptor && descriptor.enumerable && hostAtStart.has(key) && !(typeof key === 'string' && NODE_ENUMERABLE_GLOBALS.has(key))) return { ...descriptor, configurable: true, enumerable: false };
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    defineProperty(target, key, descriptor) {
      if (shadowed(target, key)) return Reflect.defineProperty(target, key, descriptor);
      // A name Node gives every program, or one the guest deleted, is defined on the guest's own global: over what
      // stood there, so an attribute the descriptor leaves out keeps the one the name had, as on any object.
      if (removed.has(key) || (typeof key === 'string' && NODE_GLOBALS.has(key))) {
        // The language's rule for a define over an existing property, the property being one of Node's value
        // globals: a field the descriptor leaves out keeps what the property had, and making it an accessor starts
        // the accessor's fields from their defaults. A name the guest deleted is defined as on a bare object.
        let next: PropertyDescriptor = descriptor;
        if (!removed.has(key)) {
          const name = key as string;
          const attributes = { enumerable: descriptor.enumerable ?? name !== 'globalThis', configurable: descriptor.configurable ?? true };
          next = 'get' in descriptor || 'set' in descriptor
            ? { ...attributes, get: descriptor.get, set: descriptor.set }
            : { ...attributes, value: 'value' in descriptor ? descriptor.value : standing(name), writable: descriptor.writable ?? true };
        }
        if (!Reflect.defineProperty(target, key, next)) return false;
        removed.delete(key);
        return true;
      }
      // A non-configurable define, undici's of its global dispatcher symbol,
      // is defined on the proxy's own target too: a proxy may only claim a
      // non-configurable property its target holds non-configurable, and
      // the host global keeps every key configurable so a later guest can
      // redefine it.
      if (descriptor.configurable === false) {
        if (!Reflect.defineProperty(target, key, descriptor)) return false;
        Reflect.defineProperty(host, key, { ...descriptor, configurable: true });
        return true;
      }
      if (Reflect.defineProperty(host, key, descriptor)) return true;
      // The host refused (a name it holds non-configurable): the define is
      // still the guest's to make on its own global, so the target takes it.
      return Reflect.defineProperty(target, key, descriptor);
    },
  });
  __substrateGuestGlobals.set(process, guest!);
  return guest!;
}
// Node compiles a CommonJS body as sloppy script code: an assignment to a
// getter-only property is ignored rather than thrown, an undeclared assignment
// makes a global, and `this` at the top is `module.exports`. A direct `eval`
// from this module, and a module is always strict, made every guest body
// strict: lightningcss's `node/index.js` assigns three names onto the wasm
// build's namespace it had just re-exported, and the assignment threw where
// Node ignores it, so Tailwind's PostCSS plugin died under Next. The wrapper is
// compiled through this alias, which is an indirect eval: global scope, sloppy.
// The guest helpers are then out of scope by name, so they are arguments.
const __substrateSloppyEval = eval;
function __substrateCompileBody(source: string, owner: object): any {
  rememberCompiledSource(owner, source);
  return __substrateSloppyEval(source);
}
// An ES module stays strict, as Node keeps one: the lowering marks its output.
const __substrateModuleMarker = '/*__substrate_module__*/';

/**
 * Transform dynamic imports in code: import('x') -> __dynamicImport('x')
 * Regex-based fallback for when AST parsing fails.
 */
function transformDynamicImportsRegex(code: string): string {
  // A `#` before the word makes it a private name, never an import expression:
  // happy-dom's module loader declares `#import()` and calls it, the declaration
  // was renamed and the calls were not, and the class no longer declared the
  // field its body used.
  return code.replace(/(?<![.$\w#])import\s*\(/g, '__dynamicImport(');
}

/**
 * All-in-one ESM to CJS transform using AST.
 * Handles import/export declarations, import.meta, and dynamic imports in a single pass.
 * Falls back to regex-based transforms if acorn can't parse the code.
 */
/**
 * `import()` in a CommonJS module is Node's way of loading an ES module from
 * one, and Next's server loads a project's config exactly so. The engine rewrote
 * `import()` to its own loader only inside modules it lowered from ESM, so a
 * CommonJS `.js` module's `import()` ran the host's, which has no view of the
 * engine's filesystem. Every module the engine compiles gets the rewrite, and it
 * is made from the module's syntax tree, never from its text: an `import(`
 * inside a string is not an import, and Next's app loader writes
 * `() => import("...")` into a template string that a text rewrite turned into
 * the engine's loader call inside webpack's generated entry, where webpack then
 * saw no import at all.
 */
function __substrateRewriteDynamicImportsInScript(code: string): string {
  if (!/(?<![.$\w#])(?:import|eval)\s*\(/.test(code)) return code;
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: true, allowAwaitOutsideFunction: true });
  } catch {
    return code;
  }
  const replacements: Array<[number, number, string]> = [];
  walkAst(ast, (node: any) => {
    if (node.type === "ImportExpression") replacements.push([node.start, node.start + 6, "__dynamicImport"]);
    collectDirectEval(node, replacements);
  });
  if (replacements.length === 0) return code;
  return applyReplacements(code, replacements);
}

/**
 * A direct `eval` runs source the module builds at run time, and Node runs an
 * `import()` in it through the module's loader: Playwright loads an ES config
 * with ``eval(`import(${url})`)``. The call stays a direct eval, so the
 * source keeps the module's scope, `__dynamicImport` included; only the
 * source it is given is rewritten the way the module's own was.
 */
function collectDirectEval(node: any, replacements: Array<[number, number, string]>): void {
  if (node.type !== "CallExpression" || node.optional || node.callee?.type !== "Identifier" || node.callee.name !== "eval") return;
  const source = node.arguments?.[0];
  if (!source || source.type === "SpreadElement") return;
  replacements.push([source.start, source.start, "__substrateEvalSource("]);
  replacements.push([source.end, source.end, ")"]);
}

/**
 * Node's AsyncLocalStorage context follows an `await`; in a tab nothing can
 * observe one (see shims/async_hooks), so the body follows it itself. An async
 * function takes its frame on entry and puts it back wherever it resumes:
 * after each `await`, at the start of a `catch` or `finally` (a rejected
 * `await` resumes there), and in and after a `for await`. An async arrow with
 * an expression body takes the frame at each `await`, which is the same
 * frame. Playwright names each API call from a zone it keeps in one; a zone
 * left over from another call made its errors lose `locator.click:`. Only
 * insertions, and no line breaks, so a stack frame keeps its line.
 */
const ASYNC_FRAME = '__substrateAsyncFrame';
// Every fragment the pass inserts is one of these strings or ends in the
// marker, so a function's source can be given back as it was written (below).
const FOLLOW_MARK = '/*substrate*/';
const FOLLOW_TAKE = `const ${ASYNC_FRAME}=__substrateContext();`;
const FOLLOW_RESTORE = `__substrateRestore(${ASYNC_FRAME});`;
const FOLLOW_RESUME_FRAMED = `__substrateResume(${ASYNC_FRAME},`;
const FOLLOW_RESUME_TAKEN = '__substrateResume(__substrateContext(),';
function __substrateFollowAwaits(code: string): string {
  if (!/\bawait\b/.test(code)) return code;
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: true, allowAwaitOutsideFunction: true });
  } catch {
    return code;
  }
  const edits: Array<[number, number, string]> = [];
  const insert = (at: number, text: string): void => { edits.push([at, at, text]); };
  // What closes a node goes before what opens the next one at the same offset: a node that ends where another starts
  // never holds it, so its closing lands first. `for await(x of y)await a;await b` ends the loop's body and starts the
  // next statement's `await` at one offset, and the resume opened there landed inside the loop's brace: a SyntaxError
  // in a 7 MB server chunk of Dub's (its web-stream pipe). Closings are kept apart and applied after, so they land first.
  const closings: Array<[number, number, string]> = [];
  const close = (at: number, text: string): void => { closings.push([at, at, text]); };
  const isFunction = (node: any): boolean => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
  // `framed`: the nearest function is async and holds the frame in ASYNC_FRAME.
  const visit = (node: any, framed: boolean, parent: any): void => {
    // What opens a block (the frame's take in an async body, the restore
    // at the start of a catch, a finally or a for-await body) goes before
    // anything in it: where the block's first statement is an `await`
    // (`async function f(){await g()}`, `finally{await h()}`, as minified code
    // writes them), both share an offset, and edits at one offset land in
    // reverse of the order they were made. So these are made after the
    // block's own edits, and land first.
    const leading: Array<[number, string]> = [];
    if (isFunction(node)) {
      framed = node.async && node.body.type === 'BlockStatement';
      if (framed) {
        const directives = node.body.body.filter((statement: any) => statement.directive !== undefined);
        leading.push([directives.length ? directives[directives.length - 1].end : node.body.start + 1, FOLLOW_TAKE]);
      }
    } else if (node.type === 'AwaitExpression') {
      insert(node.start, framed ? FOLLOW_RESUME_FRAMED : FOLLOW_RESUME_TAKEN);
      close(node.end, `${FOLLOW_MARK})`);
    } else if (framed && node.type === 'CatchClause') {
      leading.push([node.body.start + 1, FOLLOW_RESTORE]);
    } else if (framed && node.type === 'TryStatement' && node.finalizer) {
      leading.push([node.finalizer.start + 1, FOLLOW_RESTORE]);
    } else if (framed && node.type === 'ForOfStatement' && node.await) {
      // The loop's own wrap first: where its end is the body's, an insertion
      // made later lands before it, so the body's brace closes inside.
      const whole = parent?.type === 'LabeledStatement' ? parent : node;
      insert(whole.start, `{${FOLLOW_MARK}`);
      close(whole.end, `;${FOLLOW_RESTORE}${FOLLOW_MARK}}`);
      if (node.body.type === 'BlockStatement') leading.push([node.body.start + 1, FOLLOW_RESTORE]);
      else { leading.push([node.body.start, `{${FOLLOW_MARK}${FOLLOW_RESTORE}`]); close(node.body.end, `${FOLLOW_MARK}}`); }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (!child || typeof child !== 'object') continue;
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') visit(item, framed, node);
      } else if (typeof child.type === 'string') visit(child, framed, node);
    }
    for (const [at, text] of leading) insert(at, text);
  };
  visit(ast, false, undefined);
  // applyReplacements' sort is stable and lands edits at one offset in reverse of their order: closings after openings
  const followed = edits.length || closings.length ? applyReplacements(code, [...edits, ...closings]) : code;
  return __substrateTopLevelAwait(ast) ? `${followed}\n${__substrateTopLevelAwaitMarker}` : followed;
}

/**
 * Whether a module body awaits outside every function of its own. Its
 * import markers make it a generator, and in a generator `await (x)` is a
 * call of an identifier named `await`: chrome-devtools-mcp's bundle
 * (`const HOST_RUNTIME = await (async () => ...)()`) compiled, ran, and
 * threw "await is not defined". Such a body runs as an async function.
 */
const __substrateTopLevelAwaitMarker = '/*__substrate_top_level_await__*/';
function __substrateTopLevelAwait(ast: any): boolean {
  const isFunction = (node: any): boolean => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
  const stack: any[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) return true;
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (!child || typeof child !== 'object') continue;
      for (const item of Array.isArray(child) ? child : [child]) {
        if (item && typeof item.type === 'string' && !isFunction(item)) stack.push(item);
      }
    }
  }
  return false;
}

/**
 * A function's source as it was written. Playwright sends the source of the
 * function a test evaluates to the browser, where the pass's calls do not
 * exist; the pass only inserts, so removing its fragments gives the text back.
 */
function __substrateUnfollowAwaits(source: string): string {
  if (!source.includes('__substrate')) return source;
  return source
    .replaceAll(`;${FOLLOW_RESTORE}${FOLLOW_MARK}}`, '')
    .replaceAll(`{${FOLLOW_MARK}${FOLLOW_RESTORE}`, '')
    .replaceAll(`{${FOLLOW_MARK}`, '')
    .replaceAll(`${FOLLOW_MARK}}`, '')
    .replaceAll(`${FOLLOW_MARK})`, '')
    .replaceAll(FOLLOW_TAKE, '')
    .replaceAll(FOLLOW_RESTORE, '')
    .replaceAll(FOLLOW_RESUME_FRAMED, '')
    .replaceAll(FOLLOW_RESUME_TAKEN, '');
}
forGuestRealm(() => {
  const native = Function.prototype.toString;
  // A function's source never changes, so its written text is made once: Nest and TypeORM read the same classes'
  // sources over and over (1.55 s of Twenty's boot was this pass re-scanning them).
  const written = new WeakMap<object, string>();
  takeFromHost(Function.prototype, 'toString', function toString(this: unknown): string {
    const held = typeof this === 'function' ? written.get(this) : undefined;
    if (held !== undefined) return held;
    const text = __substrateUnfollowAwaits(native.call(this));
    if (typeof this === 'function') written.set(this, text);
    return text;
  });
});

/** Applies edits in source coordinates, preserving reverse insertion order at a shared offset. */
function applyReplacements(code: string, replacements: Array<[number, number, string]>): string {
  replacements.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  // Rebuilding the whole module per insertion made loading a large generated
  // module quadratic. Node accepts these modules without that copying cost.
  // Keep the original descending order (including stable ties), collecting
  // each untouched span once, then assemble once. Current passes emit disjoint
  // ranges; retain the old semantics if a future pass supplies overlaps.
  const parts: string[] = [];
  let cursor = code.length;
  for (const [start, end, text] of replacements) {
    if (end > cursor) {
      let out = code;
      for (const [from, to, replacement] of replacements) out = out.slice(0, from) + replacement + out.slice(to);
      return out;
    }
    parts.push(code.slice(end, cursor), text);
    cursor = start;
  }
  parts.push(code.slice(0, cursor));
  return parts.reverse().join('');
}

Object.defineProperty(globalThis, "__substrateEvalSource", {
  configurable: true,
  value: (source: unknown): unknown => typeof source === "string" ? __substrateRewriteDynamicImportsInScript(source) : source,
});
/** A file's source made a body: shebang stripped, types stripped, ESM lowered, dynamic imports rewritten, awaits followed. */
function __substratePrepareBody(rawCode: string, resolvedPath: string, format: string | undefined, process: unknown): string {
  let code = rawCode;

  // Strip shebang line if present (e.g. #!/usr/bin/env node)
  if (code.startsWith('#!')) {
    code = code.slice(code.indexOf('\n') + 1);
  }

  code = __substrateModuleTypes(code, resolvedPath, format, process);

  // Transform ESM to CJS if needed (for .mjs files or ESM that wasn't pre-transformed)
  // transformEsmToCjs uses AST to handle import/export, import.meta, and dynamic imports
  // It also handles already-CJS files safely (AST finds no ESM nodes → no-op)
  const __commonjs = format === 'commonjs' || format === 'commonjs-typescript'
    ? true
    : format === 'module' || format === 'module-typescript'
      ? false
      : resolvedPath.endsWith('.cjs') || resolvedPath.endsWith('.cts');
  if (!__commonjs) {
    // An ES module is strict wherever it runs; the mark says so to the
    // compile below, which is otherwise sloppy as a CommonJS body is.
    // The directive shares the body's first line, as Node's one-line
    // wrapper does, so a frame of an ES module counts the file's own lines;
    // on a line of its own it put every frame one line below the file's.
    const lowered = transformEsmToCjs(code, resolvedPath);
    code = lowered === code ? code : `${__substrateModuleMarker}"use strict";${lowered}`;
  } else {
    // A `.cjs` module skips the ESM transform, and with it the rewrite of
    // `import(...)` to the engine's dynamic import, so its
    // `import("fs/promises")` reached the browser's own import and failed on
    // the bare specifier. The dynamic-import rewrite applies to `.cjs` too,
    // from the syntax tree as for every other CommonJS module: the text
    // rewrite also renamed a method called `import`, and jiti's
    // `async import(e,t){...}` became `__dynamicImport`, so `jiti.import` was
    // undefined and every Pi extension failed to load.
    code = __substrateRewriteDynamicImportsInScript(code);
  }

  return __substrateFollowAwaits(code);
}

/**
 * Module bodies prepared where the image is built. Parsing a package's files
 * for the passes above is most of a `require` in a tab: 36 of 45 s for
 * playwright-core's, measured in a tab, against 0.9 s under Node on the same
 * machine. The image carries each body under the hash of the file it was made
 * from, in this directory of the tab's filesystem, and the loader takes it in
 * place of the passes when the file it read hashes to one. A body the loader
 * prepares for a file the image has none for is kept there the same way.
 * Under `/opt`, a root a tab's store keeps, so a host can link the image's
 * bodies there once from a store they share instead of writing each into
 * every process's memory.
 */
export const PREPARED_MODULES_DIR = '/opt/.tabnode/prepared';
export { PREPARED_MODULES_FORMAT, PREPARED_MODULES_KEPT, preparedModuleKind, preparedModuleKeyOf, isPreparedModuleKey };
/** The name a prepared body goes under, for a caller that has the file's text: its bytes are hashed here. Undefined for a file no body is prepared for. */
export function preparedModuleKey(rawCode: string, resolvedPath: string): string | undefined {
  const kind = preparedModuleKind(resolvedPath);
  return kind ? preparedModuleKeyOf(kind, bytesToHex(sha256(new TextEncoder().encode(rawCode)))) : undefined;
}
/** The body the loader would compile for this file, with no load hooks and no type stripping: what the image carries. */
export function prepareModuleForImage(rawCode: string, resolvedPath: string): string {
  return __substrateScopeGlobalCalls(__substratePrepareBody(rawCode, resolvedPath, undefined, { execArgv: [], env: {} }));
}

/**
 * An instrument: the terms that decide whether a compile takes a prepared
 * body, said for a realm's first compile and for its first compile of a file
 * under no `node_modules` (an application's own built output).
 */
const __substratePreparedGateSaid = new WeakMap<object, { first: boolean; own: boolean }>();
function __substrateTracePreparedGate(vfs: { existsSync(path: string): boolean }, process: unknown, compiling: { raw: string; format: string | undefined } | undefined, content: string, resolvedPath: string): void {
  const said = __substratePreparedGateSaid.get(process as object) ?? { first: false, own: false };
  __substratePreparedGateSaid.set(process as object, said);
  const own = !resolvedPath.includes('/node_modules/') && !resolvedPath.includes('/.browser-runtime-node-entry-');
  const which = !said.first ? 'first' : own && !said.own ? 'own' : undefined;
  if (!which) return;
  said.first = true;
  if (own) said.own = true;
  const exists = (path: string): boolean | string => { try { return vfs.existsSync(path); } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };
  const key = preparedModuleKey(content, resolvedPath);
  console.log('[boot-trace]', JSON.stringify({
    event: 'prepared-bodies', where: 'compile', which, at: Date.now(), file: resolvedPath, bytes: content.length,
    rawIsOwn: compiling?.raw === content, handedRaw: compiling !== undefined, format: compiling?.format ?? null,
    transformsTypes: transformsTypes(process as { execArgv?: string[]; env?: Record<string, string> }),
    directory: exists(PREPARED_MODULES_DIR), key: key ?? null, body: key ? exists(`${PREPARED_MODULES_DIR}/${key}`) : false,
  }));
}

/**
 * An instrument: how each of a process's compiles came by its body, said when its loading has been quiet for two
 * seconds and when it exits. `digest`: named by the tree's digest, the source never read. `hash`: named by hashing
 * the source read. `kept`: prepared here and kept. The rest prepared here, by why no body could be taken.
 * `stats`: the resolver's stat probes for the same process (node-resolution.ts `ResolutionKept.probes`).
 */
type PreparedCounts = { digest: number; hash: number; kept: number; noDirectory: number; notOwnText: number; format: number; types: number; notJavaScript: number; said: number; timer?: ReturnType<typeof setTimeout> };
const __substratePreparedCounts = new WeakMap<object, PreparedCounts>();
/**
 * An instrument: WHERE A PROCESS'S MODULE LOADING SPENDS ITS TIME, by this realm's own clock, said beside the counts
 * above (when its loading has been quiet for two seconds, and at its exit). A load is about a millisecond a module in
 * a tab and a third of that in Node (17,000 modules of one application: 17 s against 5 to 7.5), and the kernel's own
 * account holds a third of the tab's; nothing said what the rest was.
 *
 * Every instant since the process's first `require` is in exactly one phase, and a phase's time is its own, never a
 * nested load's: a `require` made while a body runs leaves `evaluate` and returns to it.
 *   resolve   from a `require`'s start to its module's load: the resolver's candidates, its stats, the cache's answer;
 *   read      the load step before a body is run: the file's digest, its prepared body's bytes, or its source;
 *   link      the engine's own work to run one body: its `require`, console, import function and wrapper;
 *   compile   the script made of the wrapped body (the engine's eval);
 *   evaluate  the module's own body;
 *   outside   everything else since the first `require`: the program running, and waiting.
 * `kernelMs` is, of each phase, the time this realm was blocked on its file system's answers, where its file
 * system says it (`vfs.kernelBlockedMs`, the holder's); a phase's own work is its time less that. Without one the
 * field is zero and the phase is not split. The process's entry script is run elsewhere and is in `outside`.
 */
type LoadPhase = 'outside' | 'resolve' | 'read' | 'link' | 'compile' | 'evaluate';
type LoadClock = { fs?: LoadClockFs; phase: LoadPhase; at: number; kernelAt: number; wall: Record<LoadPhase, number>; kernel: Record<LoadPhase, number>; bodies: number; bodyBytes: number; began: number; said: number };
const __substrateLoadClocks = new WeakMap<object, LoadClock>();
type LoadClockFs = { kernelBlockedMs?: () => number };
/** Ends the process's current phase now and begins `phase`; answers the phase that ended, for its caller to return to. */
function __substrateLoadPhase(process: object, vfs: object | undefined, phase: LoadPhase): LoadPhase {
  const now = performance.now();
  let clock = __substrateLoadClocks.get(process);
  if (!clock) {
    const zero = (): Record<LoadPhase, number> => ({ outside: 0, resolve: 0, read: 0, link: 0, compile: 0, evaluate: 0 });
    clock = { phase: 'outside', at: now, kernelAt: 0, wall: zero(), kernel: zero(), bodies: 0, bodyBytes: 0, began: now, said: -1 };
    __substrateLoadClocks.set(process, clock);
  }
  // The file system is the process's, known from the first caller that holds it (a `require` made through
  // `Module.prototype.require` holds none): its total is taken from then, so nothing before is counted to a phase.
  if (!clock.fs && vfs) { clock.fs = vfs as LoadClockFs; clock.kernelAt = clock.fs.kernelBlockedMs?.() ?? 0; }
  const kernelNow = clock.fs?.kernelBlockedMs?.() ?? 0;
  const was = clock.phase;
  clock.wall[was] += now - clock.at; clock.kernel[was] += kernelNow - clock.kernelAt;
  clock.phase = phase; clock.at = now; clock.kernelAt = kernelNow;
  return was;
}
function __substrateSayLoadClock(process: object, at: string): void {
  const clock = __substrateLoadClocks.get(process);
  if (!clock || clock.bodies === clock.said) return;
  clock.said = clock.bodies;
  const round = (values: Record<LoadPhase, number>): Record<string, number> => Object.fromEntries(Object.entries(values).map(([name, ms]) => [name, Math.round(ms)]));
  // The phase open now is counted to this instant, in a copy: the clock itself goes on.
  const wall = { ...clock.wall }, now = performance.now();
  wall[clock.phase] += now - clock.at;
  console.log('[boot-trace]', JSON.stringify({ event: 'load-clock', at: Date.now(), when: at, pid: (process as { pid?: number }).pid ?? null,
    bodies: clock.bodies, bodyBytes: clock.bodyBytes, sinceFirstRequireMs: Math.round(now - clock.began), wallMs: round(wall), kernelMs: round(clock.kernel),
    // What the kernel split was read from: on one run every process said zeros for it beside seconds blocked in its
    // own request account, and nothing said whether the file system here gave no total or gave one that stood still.
    kernelFrom: { fileSystem: clock.fs ? (clock.fs as object).constructor?.name ?? 'unnamed' : null, total: typeof clock.fs?.kernelBlockedMs === 'function' ? Math.round(clock.fs.kernelBlockedMs()) : 'no kernelBlockedMs on it' } }));
}
function __substrateSayPrepared(process: object, counts: PreparedCounts, at: string): void {
  if (counts.timer !== undefined) { clearTimeout(counts.timer); counts.timer = undefined; }
  __substrateSayLoadClock(process, at);
  const totals = { digest: counts.digest, hash: counts.hash, kept: counts.kept, noDirectory: counts.noDirectory, notOwnText: counts.notOwnText, format: counts.format, types: counts.types, notJavaScript: counts.notJavaScript };
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (total === counts.said) return;
  counts.said = total;
  console.log('[boot-trace]', JSON.stringify({ event: 'prepared-bodies', where: 'counts', at: Date.now(), when: at, pid: (process as { pid?: number }).pid ?? null, ...totals, stats: __substrateResolutionKept.get(process)?.probes ?? null }));
}
function __substrateCountPrepared(process: object, how: Exclude<keyof PreparedCounts, 'said' | 'timer'>): void {
  let counts = __substratePreparedCounts.get(process);
  if (!counts) {
    counts = { digest: 0, hash: 0, kept: 0, noDirectory: 0, notOwnText: 0, format: 0, types: 0, notJavaScript: 0, said: 0 };
    __substratePreparedCounts.set(process, counts);
  }
  counts[how] += 1;
  if (counts.timer !== undefined) clearTimeout(counts.timer);
  const mine = counts;
  counts.timer = setTimeout(() => { mine.timer = undefined; __substrateSayPrepared(process, mine, 'quiet'); }, 2000);
  (counts.timer as { unref?: () => void }).unref?.();
}
/**
 * An instrument: what this process used of the engine, in the capability ledger's own row ids, one line at its exit:
 * `engine.<builtin>` for each builtin it loaded (Node's `process.moduleLoadList`, which the engine keeps) and
 * `engine.binding.<name>` for each binding Node's lib asked for. The count is 1: loaded, not how often called.
 * Bindings are the realm's, and a realm is one process wherever processes are separate realms.
 */
const __substrateRowsSaid = new WeakSet<object>();
function __substrateSayRowsUsed(process: object): void {
  if (__substrateRowsSaid.has(process)) return;
  __substrateRowsSaid.add(process);
  const view = process as { pid?: number; argv0?: string; moduleLoadList?: string[] };
  const rows: Record<string, number> = {};
  for (const entry of view.moduleLoadList ?? []) if (entry.startsWith('NativeModule ')) rows[`engine.${entry.slice(13)}`] = 1;
  for (const name of nodeLibBindingsAsked()) rows[`engine.binding.${name}`] = 1;
  const program = String(view.argv0 ?? 'node').split('/').pop() || 'node';
  console.log('[rows-used]', JSON.stringify({ pid: view.pid ?? null, program, rows }));
}
Object.defineProperty(globalThis, '__substratePreparedExit', {
  configurable: true,
  value: (process: object): void => {
    const counts = __substratePreparedCounts.get(process);
    if (counts) __substrateSayPrepared(process, counts, 'exit');
    sayNativeStreamCounts((process as { pid?: number }).pid ?? null, 'exit');
    __substrateSayRowsUsed(process);
  },
});
/** A prepared body's text, or undefined where the tree holds none by that name: the read's own miss is the answer. */
function __substrateReadPrepared(vfs: { readFileSync(path: string, encoding: 'utf8'): string }, key: string): string | undefined {
  try { return vfs.readFileSync(`${PREPARED_MODULES_DIR}/${key}`, 'utf8'); }
  catch { return undefined; }
}

function transformEsmToCjs(code: string, filename: string): string {
  // Quick check: does the code have any ESM-like patterns?
  const maybeEsm = __substrateHasEsmSyntax(code);
  if (!maybeEsm) return __substrateRewriteDynamicImportsInScript(code);

  setNodeLowering(true);
  try {
    return transformEsmToCjsAst(code, filename);
  } catch {
    // Acorn can't parse — fall back to regex transforms
    return transformEsmToCjsRegexFallback(code, filename);
  } finally {
    setNodeLowering(false);
  }
}

/**
 * AST-based ESM to CJS transform. Parses once with acorn, then:
 * 1. Replaces import.meta with import_meta (the wrapper-provided variable)
 * 2. Replaces dynamic import() with __dynamicImport()
 * 3. Transforms import/export declarations to require/exports
 *
 * Steps 1 & 2 use a deep AST walk (handles nodes inside functions/classes).
 * Step 3 re-parses the modified code via transformEsmToCjsSimple.
 */
function transformEsmToCjsAst(code: string, filename: string): string {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as any;

  // Collect deep replacements: import.meta → import_meta, import() → __dynamicImport()
  const deepReplacements: Array<[number, number, string]> = [];

  walkAst(ast, (node: any) => {
    // import.meta → import_meta (variable provided by module wrapper)
    if (node.type === 'MetaProperty' && node.meta?.name === 'import' && node.property?.name === 'meta') {
      deepReplacements.push([node.start, node.end, 'import_meta']);
    }
    // import('x') → __dynamicImport('x')
    if (node.type === 'ImportExpression') {
      // Replace just the 'import' keyword, preserving the (...) part
      deepReplacements.push([node.start, node.start + 6, '__dynamicImport']);
    }
    collectDirectEval(node, deepReplacements);
  });

  // Check for actual import/export declarations
  const hasImportDecl = ast.body.some((n: any) => n.type === 'ImportDeclaration');
  const hasExportDecl = ast.body.some((n: any) => n.type?.startsWith('Export'));

  // Apply deep replacements from end to start (preserves earlier positions)
  let transformed = applyReplacements(code, deepReplacements);

  // Transform import/export declarations (re-parses the modified code)
  if (hasImportDecl || hasExportDecl) {
    transformed = transformEsmToCjsSimple(transformed);

    if (hasExportDecl) {
      transformed = `${__cjsObject()}.defineProperty(${__cjsExports()}, "__esModule", { value: true });\n` + transformed;
    }
  }

  return transformed;
}

/**
 * Regex-based fallback for ESM to CJS transform (when acorn can't parse).
 */
function transformEsmToCjsRegexFallback(code: string, _filename: string): string {
  let transformed = code;

  // Replace import.meta (regex — may match in strings, but this is the fallback) with the variable the module's
  // wrapper supplies when the body runs, as the syntax-tree lowering does. A body holds nothing of the path it was
  // made at: bodies are named by content and shared by every file with that content, and this wrote the path in
  // (`"file://<path>"`), so a file lowered here would have answered another file's `import.meta`.
  transformed = transformed.replace(/\bimport\.meta\b/g, 'import_meta');

  // Replace dynamic imports
  transformed = transformDynamicImportsRegex(transformed);

  // Transform import/export (AST with its own regex fallback)
  const hasImport = /\bimport\s+[\w{*'"]/m.test(code);
  const hasExport = /\bexport\s+(?:default|const|let|var|function|class|{|\*)/m.test(code);
  if (hasImport || hasExport) {
    transformed = transformEsmToCjsSimple(transformed);
    if (hasExport) {
      transformed = `${__cjsObject()}.defineProperty(${__cjsExports()}, "__esModule", { value: true });\n` + transformed;
    }
  }

  return transformed;
}

/**
 * Create a dynamic import function for a module context
 * Returns a function that wraps require() in a Promise
 */
/**
 * A module whose body is still settling: one with a top-level `await`, or one
 * importing such a module. Node evaluates a module graph in order and an
 * importer's body runs after what it imports has settled; `import()` of it
 * settles when it has. The loader runs such a body as an async function and
 * keeps its promise on the exports under this symbol until it settles, where
 * an importer's lowered import awaits it and a dynamic import does too. A
 * synchronous `require` of a settling module still answers its exports as
 * they are, where Node throws ERR_REQUIRE_ASYNC_MODULE.
 */
/**
 * A `data:` URL whose media type is JavaScript is a module, as Node imports
 * one: its payload evaluated as a module whose `import.meta.url` is the URL
 * itself, cached by URL. Packages that compile a file in memory and import
 * the result, import-from-string under vite-plugin-fake-server, depend on it.
 */
function __substrateDataModuleSource(url: string): string | undefined {
  const match = /^data:([^,;]*)((?:;[^,]*)*),(.*)$/su.exec(url);
  if (!match) return undefined;
  const type = (match[1] || 'text/plain').toLowerCase();
  if (!/^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/u.test(type)) {
    throw Object.assign(new Error(`Unknown module format for data: URL of type ${type}`), { code: 'ERR_UNKNOWN_MODULE_FORMAT' });
  }
  const payload = match[3]!;
  return /;base64/iu.test(match[2] ?? '')
    ? new TextDecoder().decode(Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)))
    : decodeURIComponent(payload);
}

const __substratePending = Symbol.for('substrate.pending');
export function __substratePendingOf(value: unknown): Promise<void> | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  const pending = (value as Record<symbol, unknown>)[__substratePending];
  return pending instanceof Promise ? pending : undefined;
}
/**
 * The module's body promise, kept on its exports until it settles; a body
 * that failed forgets the module. Nothing here handles the rejection: an
 * importer, a dynamic import or the program's runner awaits it, and a body
 * nobody awaits fails as an unhandled rejection, which a program's runner
 * reports, where Node prints the error and exits 1.
 */
function __substrateKeepPending(module: Module, body: Promise<unknown>, forget: () => void): void {
  const exports = module.exports as Record<symbol, unknown>;
  const holds = exports !== null && (typeof exports === 'object' || typeof exports === 'function');
  const settled: Promise<void> = body.then(
    () => { module.loaded = true; if (holds) delete exports[__substratePending]; },
    (error: unknown) => { forget(); if (holds) delete exports[__substratePending]; throw error; },
  );
  if (holds) Object.defineProperty(exports, __substratePending, { value: settled, configurable: true, enumerable: false, writable: true });
}
const __substrateAwaitMarker = '/*__substrate_await__*/(';
/**
 * A lowered ES module body runs as a generator: each import marker yields
 * what the imported module is still settling on, if anything. The loader
 * drives it synchronously, so a body whose imports have all settled runs
 * through in one go, and a synchronous throw is thrown from the load, as
 * Node's would be; a body that meets a settling import is continued once it
 * has settled, and its own settling is what its importers await. The body's
 * imports evaluate where they stand, once, in the body's own order.
 */
function __substrateGeneratorBody(wrappedCode: string): string {
  return wrappedCode.replace('return (function() {', 'return (function* () {').replaceAll(__substrateAwaitMarker, 'yield (');
}
/** A body V8 refuses as a generator, a top-level `await` of its own, runs as an async function; the end of the body says it ran through. */
function __substrateAsyncBody(wrappedCode: string): string {
  const at = wrappedCode.lastIndexOf('\n}).call(');
  if (at < 0) throw new Error('module wrapper changed');
  return wrappedCode.slice(0, at).replace('return (function() {', 'return (async function() {').replaceAll(__substrateAwaitMarker, 'await (')
    + '\n;$module.__substrateBodyDone = true;' + wrappedCode.slice(at);
}
/**
 * Drives a body: a generator runs until an import is still settling or the
 * body is done; an async body's promise is its own. Returns what is still
 * settling, or undefined when the body ran through.
 */
function __substrateDriveBody(kind: 'sync' | 'generator' | 'async', body: unknown, module: Module): Promise<unknown> | undefined {
  if (kind === 'sync') return undefined;
  if (kind === 'async') return (module as { __substrateBodyDone?: boolean }).__substrateBodyDone ? undefined : body as Promise<unknown>;
  const iterator = body as Iterator<unknown>;
  let step: IteratorResult<unknown> = withGuestExecution(() => iterator.next());
  while (!step.done && !step.value) step = withGuestExecution(() => iterator.next());
  if (step.done) return undefined;
  return (async () => {
    let current: IteratorResult<unknown> = step;
    while (!current.done) {
      await current.value;
      current = withGuestExecution(() => iterator.next());
      while (!current.done && !current.value) current = withGuestExecution(() => iterator.next());
    }
  })();
}

/**
 * A dynamic import through the chain `module.register` built.
 *
 * This is where an asynchronous hook is consulted, because this is where the
 * engine can await one: `import()` answers a promise in Node too. A static
 * `import` is lowered to a synchronous `require` and never arrives here, so a
 * hook that must see every specifier is registered with `registerHooks`,
 * whose chain is synchronous and runs at both seams.
 */
async function __substrateImportThroughHooks(
  hooks: RunModuleHooks,
  id: string,
  parentURL: string | undefined,
  moduleRequire: RequireFunction,
): Promise<unknown> {
  // A run with a module resolution outstanding is not idle. The chain can
  // wait on anything -- VS Code's hook asks the main thread over a
  // `MessagePort` and waits for the answer -- and the engine ends a run that
  // holds no timer and no handle. It ended this one between the hook's
  // question and its answer, so `import('vscode')` never settled and nothing
  // said why. Node keeps its loop alive for a pending import; the engine
  // holds the run for the same reason, and lets go however the chain ends.
  const held = heldWork();
  held.count += 1;
  try {
    return await __substrateImportChain(hooks, id, parentURL, moduleRequire);
  } finally {
    held.count -= 1;
  }
}

async function __substrateImportChain(
  hooks: RunModuleHooks,
  id: string,
  parentURL: string | undefined,
  moduleRequire: RequireFunction,
): Promise<unknown> {
  const doors = moduleRequire as unknown as {
    __resolveToURL: (specifier: string) => string;
    __loadFromURL: (url: string, format?: string, source?: string | ArrayBuffer | ArrayBufferView | null) => unknown;
    __readFromURL: (url: string) => string | null;
  };
  const resolved = hooks.hasAsyncResolve
    ? await hooks.resolve(id, parentURL, void 0, (specifier: string) => ({ url: doors.__resolveToURL(specifier) }))
    : { url: doors.__resolveToURL(id), format: void 0 as string | undefined };
  if (!hooks.hasAsyncLoad) return doors.__loadFromURL(resolved.url, resolved.format);
  const loaded = await hooks.load(resolved.url, resolved.format, void 0, (url: string, context: { format?: string }) => ({
    source: doors.__readFromURL(url),
    format: context.format,
  }));
  return doors.__loadFromURL(resolved.url, loaded.format ?? resolved.format, loaded.source ?? void 0);
}

/**
 * A module's `import.meta`: `url`, `dirname`, `filename` and Node's synchronous
 * `resolve` (Node 20.6+). Pi's extension loader resolves its own packages with
 * `import.meta.resolve(specifier)`, and without it every Pi extension failed to
 * load with "import_meta.resolve is not a function". A relative or URL specifier
 * resolves against the module's URL, a builtin to `node:<name>`, and a bare one
 * through the module's own resolver, the one `import()` uses here. Unlike Node,
 * a relative specifier naming a missing file resolves instead of throwing.
 */
function createImportMeta(moduleRequire: RequireFunction, url: string, dirname: string, filename: string): Record<string, unknown> {
  const resolve = (specifier: unknown, parent?: unknown): string => {
    const id = typeof specifier === 'string' ? specifier : String(specifier);
    const base = parent === undefined ? url : String(parent);
    if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) return new URL(id, base).href;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(id)) return id.startsWith('node:') ? id : new URL(id).href;
    if (Object.prototype.hasOwnProperty.call(builtinModules, id)) return `node:${id}`;
    return 'file://' + moduleRequire.resolve(id);
  };
  return { url, dirname, filename, resolve };
}

/** ES module bodies a process has run: an import that raises it ran one for the first time. */
const __substrateEsBodiesRun = new WeakMap<object, number>();
function __substrateEsBodyRuns(process: object): void { __substrateEsBodiesRun.set(process, (__substrateEsBodiesRun.get(process) ?? 0) + 1); }
/** One turn of the loop a guest's own `setImmediate` waits on. */
const __substrateLoopTurn = (): Promise<void> => new Promise<void>(resolve => { setImmediate(resolve); });
function createDynamicImport(moduleRequire: RequireFunction, process: Process, parentURL?: string): (specifier: unknown) => Promise<unknown> {
  return async (specifier: unknown): Promise<unknown> => {
    try {
      // What the guest's Node line does when an import runs an ES module for the first time (node-line.ts).
      const turns = freshEsModuleImportTurns(nodeLineOf((process as { version?: unknown }).version));
      const esBodiesBefore = turns > 0 ? __substrateEsBodiesRun.get(process) ?? 0 : 0;
      // The specifier of `import()` undergoes ToString, as Node's does. ESLint's
      // `loadFormatter` imports `pathToFileURL(formatterPath)` — a URL object —
      // and the engine handed the object to require untouched, so the
      // installed-wins check called `.startsWith` on it and `vite --host` died at
      // `initializeESLint` with "id4.startsWith is not a function". A value whose
      // conversion throws rejects the import, which is Node's answer too.
      const id = typeof specifier === 'string' ? specifier : String(specifier);
      // A dynamic import of a `file://` URL loads the file. Node takes a file
      // URL in `import()`, and Vite loads a project's config by bundling it to
      // a file beside it and importing that file by URL; handing the URL to
      // require found no module by that name. `String(new URL(...))` is the
      // href, so a URL object arrives at that branch as the same `file://` string.
      const hooks = (moduleRequire as unknown as { __moduleHooks?: () => RunModuleHooks | undefined }).__moduleHooks?.();
      const mod = hooks && (hooks.hasAsyncResolve || hooks.hasAsyncLoad)
        ? await __substrateImportThroughHooks(hooks, id, parentURL, moduleRequire)
        : moduleRequire(id.startsWith('file://') ? decodeURIComponent(new URL(id).pathname) : id);
      // A module still settling settles the import, as Node's does.
      const pending = __substratePendingOf(mod);
      if (pending) await pending;
      if (turns > 0 && (__substrateEsBodiesRun.get(process) ?? 0) > esBodiesBefore) for (let turn = 0; turn < turns; turn += 1) await __substrateLoopTurn();

      // A lowered ES module already carries its named exports and `__esModule`.
      // A CommonJS builtin does not: Node's ESM namespace is built from the
      // module's own keys with `default` the module object. Spread of a lazy
      // proxy copied none of those keys, so `(await import("https")).request`
      // was undefined.
      if (mod && typeof mod === 'object' && '__esModule' in (mod as object)) {
        return mod;
      }
      return esmNamespaceOf(mod, process);
    } catch (error) {
      // Re-throw as a rejected promise (which is what dynamic import does)
      throw error;
    }
  };
}

export interface Module {
  id: string;
  filename: string;
  exports: unknown;
  loaded: boolean;
  children: Module[];
  paths: string[];
  /** The module that first required this one; null for the entry, as Node's is. */
  parent?: Module | null;
}

export interface RuntimeOptions {
  cwd?: string;
  env?: Record<string, string>;
  onConsole?: (method: string, args: unknown[]) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /** fd 1 and fd 2 as the bytes the program wrote; where given, the text sink of that fd is not called. */
  onStdoutBytes?: (bytes: Uint8Array) => void;
  onStderrBytes?: (bytes: Uint8Array) => void;
  /** What is on the guest's fd 0, the way a shell puts the left of a pipe there. */
  stdin?: string | Uint8Array;
  /** The runner can still write to fd 0, so standard input has not ended. */
  stdinHeld?: boolean;
  /** The run was given a TTY, on all three fds or per fd as `[stdin, stdout, stderr]`; a pipe child is not one. */
  tty?: boolean | readonly [boolean, boolean, boolean];
  /** This run's process number and its parent's; minted where neither is given. */
  pid?: number;
  ppid?: number;
}

export interface RequireFunction {
  (id: string): unknown;
  resolve: (id: string) => string;
  cache: Record<string, Module>;
}

/**
 * Minimal prettier shim - just returns input unchanged
 * This is needed because prettier uses createRequire which conflicts with our runtime
 */
const prettierShim = {
  format: (source: string, _options?: unknown) => Promise.resolve(source),
  formatWithCursor: (source: string, _options?: unknown) => Promise.resolve({ formatted: source, cursorOffset: 0 }),
  check: (_source: string, _options?: unknown) => Promise.resolve(true),
  resolveConfig: () => Promise.resolve(null),
  resolveConfigFile: () => Promise.resolve(null),
  clearConfigCache: () => {},
  getFileInfo: () => Promise.resolve({ ignored: false, inferredParser: null }),
  getSupportInfo: () => Promise.resolve({ languages: [], options: [] }),
  version: '3.0.0',
  doc: {
    builders: {},
    printer: {},
    utils: {},
  },
};

/**
 * Create a mutable copy of a module for packages that need to patch it
 * (e.g., Sentry needs to patch http.request/http.get)
 */
function makeMutable(mod: Record<string, unknown>): Record<string, unknown> {
  const mutable: Record<string, unknown> = {};
  for (const key of Object.keys(mod)) {
    mutable[key] = mod[key];
  }
  return mutable;
}

/**
 * Built-in modules registry
 */
// Node's old `constants` module, and the groups `process.binding("constants")`
// serves it from, are one table in `shims/constants.ts`.
const __browserRuntimePunycode = (() => { const module = { exports: {} }; new Function("module", "exports", PUNYCODE_SOURCE)(module, module.exports); return module.exports; })();
/**
 * Node's `stream/web` is the web streams the worker already has as globals; the
 * table had no entry, so `file-type`, on Dub's middleware path, was "Cannot
 * find module 'stream/web'". The module is those globals.
 */
/**
 * Where a page registers the native side of an installed package for one
 * filesystem: `vfs[__substrateNativeModules]` is a `Map` from a file the
 * package's own exports name to a factory the guest's `require` calls with the
 * asking process. The engine keeps resolution, the manifest and the version
 * check with the installed package; the registration replaces only the module
 * the resolved file would have produced, and only on the filesystem it was made
 * for.
 */
const __substrateNativeModules = Symbol.for("@volter/browser-node/rolldown-modules");
/** `pkg:<name>@<version>/<path within the package>` for a file, from the nearest package.json above it; undefined outside a package. */
const __substrateIdentityCache = new WeakMap<object, Map<string, string | null>>();
function __substratePackageIdentity(vfs: VirtualFS, file: string): string | undefined {
  let cache = __substrateIdentityCache.get(vfs);
  if (!cache) { cache = new Map(); __substrateIdentityCache.set(vfs, cache); }
  let directory = file.slice(0, file.lastIndexOf('/'));
  const walked: string[] = [];
  let found: string | null = null;
  while (directory) {
    const cached = cache.get(directory);
    if (cached !== undefined) { found = cached; break; }
    walked.push(directory);
    const manifest = `${directory}/package.json`;
    if (vfs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(vfs.readFileSync(manifest, 'utf8') as string) as { name?: unknown; version?: unknown };
        if (typeof parsed.name === 'string' && typeof parsed.version === 'string') { found = `${directory}\u0000${parsed.name}@${parsed.version}`; break; }
      } catch { /* not a package manifest */ }
    }
    if (directory.endsWith('/node_modules')) { found = null; break; }
    directory = directory.slice(0, directory.lastIndexOf('/'));
  }
  for (const seen of walked) cache.set(seen, found);
  if (!found) return undefined;
  const [root, identity] = found.split('\u0000');
  return `pkg:${identity}/${file.slice(root!.length + 1)}`;
}

function __webStreamsModule(): Record<string, unknown> {
  // Read when used, not when the engine loads: the engine later wraps the
  // global ReadableStream (Node's closed-promise tracking), and a copy taken
  // here was the unwrapped one, so require('stream/web').ReadableStream was
  // not globalThis.ReadableStream, as it is in Node.
  const module: Record<string, unknown> = {};
  for (const name of ["ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableByteStreamController", "ReadableStreamDefaultController", "TransformStream", "TransformStreamDefaultController", "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController", "ByteLengthQueuingStrategy", "CountQueuingStrategy", "TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream"]) {
    if (typeof (globalThis as Record<string, unknown>)[name] === "undefined") continue;
    Object.defineProperty(module, name, { enumerable: true, configurable: true, get: () => (globalThis as Record<string, unknown>)[name] });
  }
  return module;
}
const builtinModules: Record<string, unknown> = {
  constants: constantsModule,
  punycode: punycodeModule,
  "stream/web": __webStreamsModule(),
  // Node's `path` is its posix object itself (path.js exports posix, and
  // posix.posix === posix), so require('path') === require('path/posix').
  path: pathShim.posix,
  // Make http/https mutable so packages like Sentry can patch them
  http: httpModule,
  https: httpsModule,
  _http_common: httpCommonModule,
  _http_incoming: httpIncomingModule,
  _http_outgoing: httpOutgoingModule,
  _http_server: httpServerModule,
  _http_client: httpClientModule,
  _http_agent: httpAgentModule,
  net: netShim,
  events: eventsShim,
  stream: streamShim,
  // `stream/promises` is the promise form of pipeline and finished, as Node's.
  'stream/promises': streamPromises,
  buffer: bufferShim,
  url: urlShim,
  querystring: querystringModule,
  util: utilShim,
  tty: ttyModule,
  os: osModule,
  crypto: cryptoShim,
  zlib: zlibModule,
  dns: createDnsModule(),
  child_process: childProcessShim,
  assert: assertModule,
  string_decoder: stringDecoderShim,
  timers: createTimersModule(),
  // `chokidar`, `readdirp`, `fsevents` and `ws` are not the engine's to
  // answer. Each is an ordinary package over a builtin that is Node's own
  // now, so a project installs it and it runs unchanged: a watcher over
  // `fs.watch`, a WebSocket server over the `upgrade` a real socket carries.
  // The engine's imitations answered those names before, and a program got a
  // watcher and a server that were not the ones it had installed. `fsevents`
  // is absent as it is on a Linux host, which is what chokidar checks for.
  module: moduleShim,
  perf_hooks: perfHooksShim,
  worker_threads: workerThreadsShim,
  esbuild: esbuildShim,
  rollup: rollupShim,
  v8: v8Shim,
  readline: readlineModule,
  tls: tlsShim,
  http2: http2Shim,
  cluster: clusterShim,
  dgram: dgramShim,
  // A stand-in for Node's surface that refuses the REPL by name (shims/repl.ts says why it is not Node's file).
  repl: replShim,
  // Node's `sys` is `util` itself (lib/sys.js: `module.exports = require('util')`), deprecated (DEP0025).
  sys: utilShim,
  vm: vmShim,
  inspector: inspectorShim,
  'inspector/promises': inspectorShim,
  async_hooks: asyncHooksShim,
  // `domain` stays the engine's own. Node's `domain.js` is a consumer of the
  // async-hooks machinery -- it installs a trampoline the C++ layer calls to
  // enter and leave a domain around every async callback -- and the engine
  // has no such machinery, so the vendored file loads and then catches
  // nothing, which is worse than an imitation that says what it is.
  domain: domainShim,
  diagnostics_channel: diagnosticsChannelModule,
  // prettier uses createRequire which doesn't work in our runtime, so we shim it
  prettier: prettierShim,
  // Some packages explicitly require 'console' (with Console constructor)
  console: {
    ...console,
    Console: class Console {
      private _stdout: { write: (s: string) => void } | null;
      private _stderr: { write: (s: string) => void } | null;
      constructor(options?: unknown) {
        // Node's Console accepts (stdout, stderr) or { stdout, stderr }
        const opts = options as Record<string, unknown> | undefined;
        if (opts && typeof opts === 'object' && 'write' in opts) {
          // new Console(stdout, stderr) — first arg is stdout stream
          this._stdout = opts as unknown as { write: (s: string) => void };
          this._stderr = (arguments[1] as { write: (s: string) => void }) || this._stdout;
        } else if (opts && typeof opts === 'object' && 'stdout' in opts) {
          // new Console({ stdout, stderr })
          this._stdout = opts.stdout as { write: (s: string) => void } || null;
          this._stderr = (opts.stderr as { write: (s: string) => void }) || this._stdout;
        } else {
          this._stdout = null;
          this._stderr = null;
        }
      }
      private _write(stream: 'out' | 'err', args: unknown[]) {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
        const target = stream === 'err' ? this._stderr : this._stdout;
        if (target) target.write(msg);
        else if (stream === 'err') console.error(...args);
        else console.log(...args);
      }
      log(...args: unknown[]) { this._write('out', args); }
      error(...args: unknown[]) { this._write('err', args); }
      warn(...args: unknown[]) { this._write('err', args); }
      info(...args: unknown[]) { this._write('out', args); }
      debug(...args: unknown[]) { this._write('out', args); }
      trace(...args: unknown[]) { this._write('err', args); }
      dir(obj: unknown) { this._write('out', [obj]); }
      time(_label?: string) {}
      timeEnd(_label?: string) {}
      timeLog(_label?: string) {}
      assert(value: unknown, ...args: unknown[]) { if (!value) this._write('err', ['Assertion failed:', ...args]); }
      clear() {}
      count(_label?: string) {}
      countReset(_label?: string) {}
      group(..._args: unknown[]) {}
      groupCollapsed(..._args: unknown[]) {}
      groupEnd() {}
      table(data: unknown) { this._write('out', [data]); }
    },
  },
  // util/types is accessed as a subpath
  'util/types': utilShim.types,
  // path subpaths: Node's own two flavours, the very objects path.posix and
  // path.win32 name (Node's test-path-posix-exists.js asserts that identity).
  'path/posix': pathShim.posix,
  'path/win32': pathShim.win32,

};
// Node's `assert/strict` is the module's own `strict` property, read when
// a guest asks rather than when this table is built -- `assert` is a lazy
// export and loading it here is a cycle with the loader.
Object.defineProperty(builtinModules, 'assert/strict', {
  configurable: true,
  enumerable: true,
  get(): unknown { return (assertModule as { strict: unknown }).strict; },
});
// A builtin NAME is a promise that `require` of it loads a module. Every name the engine lists
// (`shims/module.ts`, which is what `module.builtinModules` and `isBuiltin` answer from) has a module in this table,
// or is one of the three made per guest (`fs`, `process`, `wasi`, each answered where a guest's require is built).
// A listed name with neither resolved to its bare id and was then opened as a FILE of that name: `require('repl')`
// answered "ENOENT: open 'repl'" (ts-node, which loads `repl` on every start). The engine does not load with one.
{
  const __perGuest = new Set(['fs', 'process', 'wasi']);
  const __unanswered = moduleShim.builtinModules.filter((name: string) => !__perGuest.has(name) && !Object.prototype.hasOwnProperty.call(builtinModules, name));
  if (__unanswered.length > 0) throw new Error(`tabnode: builtin name${__unanswered.length === 1 ? '' : 's'} listed with no module: ${__unanswered.join(', ')}. Give each a module in runtime.ts's table or take it off shims/module.ts's list.`);
}
// Node's builtin module objects are ordinary mutable objects: a program can
// patch `vm.runInContext` or `crypto.randomUUID`, and Next's environment
// extensions and its error inspector do. Most shims are frozen module
// namespaces, so the assignment threw. Every builtin the table holds is handed
// out as a mutable copy, the way http and https already were.
for (const __substrateName of Object.keys(builtinModules)) {
  const __substrateModule = builtinModules[__substrateName];
  if (__substrateModule && typeof __substrateModule === "object" && Object.isFrozen(__substrateModule)) builtinModules[__substrateName] = makeMutable(__substrateModule as Record<string, unknown>);
}
/** Every proxy the engine's realm made, so `util.types.isProxy` can name one. */
function __browserRuntimeFillModules(table: Record<string, any>) {
  // A frozen shim cannot take the names it is missing, so the table gets a
  // copy carrying them; the shim's own mutable default object takes them too,
  // so an ESM default import and a require answer the same surface.
  const extend = (name: string, fills: Record<string, any>): any => {
    const base = table[name];
    if (!base) return null;
    const next = Object.assign({}, base, fills);
    if (base.default && typeof base.default === "object") {
      Object.assign(base.default, fills);
      next.default = base.default;
    }
    table[name] = next;
    return next;
  };
  const abortError = () => {
    const error = new Error("The operation was aborted") as Error & { code?: string };
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    return error;
  };

  // `path` needs no fills: Node's own lib/path.js carries toNamespacedPath,
  // matchesGlob, and the posix/win32 cross-links, and the module table points
  // at those objects directly so require("path/posix") === require("path").posix.

  // `assert`'s loose half, its `strict` half, `AssertionError`,
  // `partialDeepStrictEqual` and the `assert/strict` module were written out
  // here over the engine's hand-written assert. `assert` is Node's own file
  // now and every one of them is Node's own code; `assert/strict` is the
  // module's own `strict` property, as it is in Node.

  // The statics Node hangs off `EventEmitter` -- `errorMonitor`,
  // `captureRejections`, `defaultMaxListeners`, `setMaxListeners`,
  // `getMaxListeners`, `addAbortListener`, `EventEmitterAsyncResource` --
  // used to be written out here, over the engine's hand-written emitter.
  // `events` is Node's own file now and every one of them is Node's own code.

  // `util.types` is Node's own now -- `util.js` exports the same
  // `internal/util/types` this engine binds -- so the forty-three predicates
  // that used to be written out here live in `node-lib/internals/util.ts`,
  // beside the reason each one answers the way it does. What stays here is
  // the realm's business: a guest's `Proxy` records what it makes, because
  // `isProxy` is the one predicate no tag can answer.
  forGuestRealm(() => {
    const NativeProxy = globalThis.Proxy as any;
    if (NativeProxy.__substrateProxies) return;
    const RecordedProxy = function Proxy(target: any, handler: any) {
      if (!new.target) throw new TypeError("Constructor Proxy requires 'new'");
      const proxy = new NativeProxy(target, handler);
      recordedProxies.add(proxy);
      return proxy;
    };
    RecordedProxy.revocable = (target: any, handler: any) => {
      const revocable = NativeProxy.revocable(target, handler);
      recordedProxies.add(revocable.proxy);
      return revocable;
    };
    Object.defineProperty(RecordedProxy, "__substrateProxies", { value: recordedProxies });
    takeFromHost(globalThis, "Proxy", RecordedProxy);
  });

  // Node names a system error by its negative errno; the engine's constants
  // table already holds those numbers, so the map is read off it rather than
  // written down a second time.
  const errorNames = new Map();
  for (const [name, value] of Object.entries(table.constants || {})) {
    if (typeof value === "number" && /^E[A-Z0-9]+$/.test(name) && !errorNames.has(-value)) errorNames.set(-value, name);
  }
  // A number the constants table does not name is still one libuv names, and
  // the binding holds that table: `spawnSync` past `maxBuffer` reports
  // `ENOBUFS`, which the engine's own constants never carried.
  const systemErrorName = (errno: any) => errorNames.get(errno) || errorNames.get(-errno) || __uvErrname(errno);

  // `util.parseArgs`, `util.isDeepStrictEqual`, `util.getSystemErrorName`,
  // `getSystemErrorMessage`, `getSystemErrorMap`, `toUSVString`, `aborted`
  // and `util.types` were all written out here, over the engine's
  // hand-written `util`. `util` is Node's own file now and every one of them
  // is Node's own code; `errorNames` above stays, because the engine's own
  // parts still name an errno.

  table["timers/promises"] = table.timers.promises;

  // Node's punycode decoder, RFC 3492, so domainToUnicode answers the name a
  // person reads rather than the xn-- label: the engine dropped the punycode
  // module Node retired, and nothing else in a tab decodes one.
  const punycodeDecode = (input: any) => {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    const output = [];
    let index = input.lastIndexOf("-");
    if (index > 0) { for (let i = 0; i < index; i++) output.push(input.charCodeAt(i)); index++; } else index = 0;
    let n = 128, bias = 72, i = 0;
    while (index < input.length) {
      const start = i;
      for (let weight = 1, k = base; ; k += base) {
        if (index >= input.length) throw new RangeError("Invalid punycode input");
        const code = input.charCodeAt(index++);
        let digit;
        if (code >= 0x30 && code <= 0x39) digit = code - 0x30 + 26;
        else if (code >= 0x61 && code <= 0x7a) digit = code - 0x61;
        else if (code >= 0x41 && code <= 0x5a) digit = code - 0x41;
        else throw new RangeError("Invalid punycode input");
        i += digit * weight;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        weight *= base - t;
      }
      const out = output.length + 1;
      let delta = i - start;
      delta = start === 0 ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / out);
      let k = 0;
      for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
      bias = Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
      n += Math.floor(i / out);
      i %= out;
      output.splice(i++, 0, n);
    }
    return String.fromCodePoint(...output);
  };
  const urlModule = table.url;
  const URLClass = urlModule.URL || globalThis.URL;
  const domainToASCII = (domain: any) => {
    try { return new URLClass("http://" + String(domain)).hostname; } catch (error) { return ""; }
  };
  const domainToUnicode = (domain: any) => {
    const ascii = domainToASCII(domain);
    if (!ascii) return "";
    return ascii.split(".").map((label: any) => {
      if (!/^xn--/i.test(label)) return label;
      try { return punycodeDecode(label.slice(4)); } catch (error) { return label; }
    }).join(".");
  };
  function Url(this: any) {
    this.protocol = null; this.slashes = null; this.auth = null; this.host = null;
    this.port = null; this.hostname = null; this.hash = null; this.search = null;
    this.query = null; this.pathname = null; this.path = null; this.href = null;
  }
  const resolveObject = (from: any, to: any) => Object.assign(new (Url as any)(), urlModule.parse(urlModule.resolve(from, to)));
  Url.prototype.parse = function (this: any, input: any, parseQueryString: any, slashesDenoteHost: any) {
    return Object.assign(this, urlModule.parse(input, parseQueryString, slashesDenoteHost));
  };
  Url.prototype.format = function () { return urlModule.format(this); };
  Url.prototype.resolve = function (relative: any) { return urlModule.resolve(urlModule.format(this), relative); };
  Url.prototype.resolveObject = function (relative: any) { return resolveObject(urlModule.format(this), relative); };
  const urlFills: Record<string, any> = {
    Url,
    resolveObject,
    domainToASCII,
    domainToUnicode,
    urlToHttpOptions: (url: any) => {
      const hostname = typeof url.hostname === "string" && url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
      const options = {
        protocol: url.protocol,
        hostname,
        hash: url.hash,
        search: url.search,
        pathname: url.pathname,
        path: (url.pathname || "") + (url.search || ""),
        href: url.href
      } as Record<string, any>;
      if (url.port !== "" && url.port !== void 0 && url.port !== null) options.port = Number(url.port);
      if (url.username || url.password) options.auth = decodeURIComponent(url.username || "") + ":" + decodeURIComponent(url.password || "");
      return options;
    }
  };
  if (typeof URLPattern !== "undefined") urlFills.URLPattern = URLPattern;
  extend("url", urlFills);

  extend("querystring", {
    // Node's unescapeBuffer answers the bytes behind the percent escapes, not
    // a string, so a caller decoding a body that is not UTF-8 keeps them.
    unescapeBuffer: (text: any, decodeSpaces: any) => {
      const bytes = [];
      const encoder = new TextEncoder();
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "+" && decodeSpaces) { bytes.push(32); continue; }
        if (ch === "%" && i + 2 < text.length) {
          const value = parseInt(text.slice(i + 1, i + 3), 16);
          if (!Number.isNaN(value)) { bytes.push(value); i += 2; continue; }
        }
        for (const byte of encoder.encode(ch)) bytes.push(byte);
      }
      return BufferPolyfill.from(bytes);
    }
  });

  // The buffer module's Blob and File are the tab's own; isUtf8 and isAscii
  // read the bytes, which is all Node's do.
  const bufferModule = table.buffer;
  bufferModule.Blob = globalThis.Blob;
  if (typeof globalThis.File !== "undefined") bufferModule.File = globalThis.File;
  bufferModule.kStringMaxLength = (bufferModule.constants && bufferModule.constants.MAX_STRING_LENGTH) || 536870888;
  bufferModule.isUtf8 = (input: any) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch (error) { return false; }
  };
  bufferModule.isAscii = (input: any) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > 127) return false;
    return true;
  };

  extend("os", {
    // A tab reports the parallelism the browser gives it; a worker with no
    // navigator answers one, as Node does on a machine it cannot ask.
    availableParallelism: () => (typeof navigator === "object" && navigator && Number(navigator.hardwareConcurrency)) || 1
  });

  table["dns/promises"] = table.dns.promises;

  // readline/promises was not a module, and the engine's readline.promises
  // answered an object with only createInterface on it whose async iterator
  // yielded nothing, so "for await (const line of rl)" ended at once.
  const readlineModule = table.readline;
  class PromisesInterface {
    [key: string]: any;
    constructor(options: any) {
      this.input = options && options.input;
      this.output = options && options.output;
      this._interface = readlineModule.createInterface(options);
    }
    question(query: any, options: any) {
      const signal = options && options.signal;
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(abortError()); return; }
        if (signal) signal.addEventListener("abort", () => reject(abortError()), { once: true });
        this._interface.question(query, resolve);
      });
    }
    close() { return this._interface.close(); }
    pause() { if (typeof this._interface.pause === "function") this._interface.pause(); return this; }
    resume() { if (typeof this._interface.resume === "function") this._interface.resume(); return this; }
    write(data: any, key: any) { return this._interface.write(data, key); }
    getCursorPos() { return this._interface.getCursorPos(); }
    on(event: any, listener: any) { this._interface.on(event, listener); return this; }
    once(event: any, listener: any) { this._interface.once(event, listener); return this; }
    off(event: any, listener: any) { this._interface.removeListener(event, listener); return this; }
    removeListener(event: any, listener: any) { this._interface.removeListener(event, listener); return this; }
    [Symbol.asyncIterator]() {
      const lines: any[] = [];
      let closed = false;
      let wake: any = null;
      const bump = () => { const resume = wake; wake = null; if (resume) resume(); };
      this._interface.on("line", (line: any) => { lines.push(line); bump(); });
      this._interface.on("close", () => { closed = true; bump(); });
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          for (;;) {
            if (lines.length > 0) return { value: lines.shift(), done: false };
            if (closed) return { value: void 0, done: true };
            await new Promise((resolve) => { wake = resolve; });
          }
        }
      };
    }
  }
  // Node's Readline queues its cursor and clear escapes and writes them on commit.
  class Readline {
    [key: string]: any;
    constructor(stream: any, options: any) {
      this._stream = stream;
      this._autoCommit = !!(options && options.autoCommit);
      this._queue = [];
    }
    _queueEscape(text: any) {
      this._queue.push(text);
      return this._autoCommit ? this.commit() : this;
    }
    clearLine(dir: any) { return this._queueEscape("\u001b[" + (dir < 0 ? "1K" : dir > 0 ? "0K" : "2K")); }
    clearScreenDown() { return this._queueEscape("\u001b[0J"); }
    cursorTo(x: any, y: any) { return this._queueEscape(y === void 0 ? "\u001b[" + (x + 1) + "G" : "\u001b[" + (y + 1) + ";" + (x + 1) + "H"); }
    moveCursor(dx: any, dy: any) {
      let text = "";
      if (dx < 0) text += "\u001b[" + -dx + "D"; else if (dx > 0) text += "\u001b[" + dx + "C";
      if (dy < 0) text += "\u001b[" + -dy + "A"; else if (dy > 0) text += "\u001b[" + dy + "B";
      return this._queueEscape(text);
    }
    rollback() { this._queue = []; return this; }
    async commit() {
      const text = this._queue.join("");
      this._queue = [];
      if (text && this._stream && typeof this._stream.write === "function") this._stream.write(text);
    }
  }
  const readlinePromises = {
    Interface: PromisesInterface,
    Readline,
    createInterface: (options: any) => new PromisesInterface(options)
  } as Record<string, any>;
  readlinePromises.default = readlinePromises;
  table["readline/promises"] = readlinePromises;
  extend("readline", { promises: readlinePromises });

  // `zlib`'s streaming classes were written out here, over the engine's
  // one-shot functions: each gathered its whole input and ran the one-shot at
  // flush, so the bytes were right and the streaming was not. `zlib` is
  // Node's own file now, on zlib's own inflate and deflate, and every class
  // it exports is a real streaming codec.

}
/**
 * `stream/consumers`: the one module beside `stream` that Node ships and this
 * lane did not vendor -- four functions that read a whole stream into a
 * string, a Buffer, JSON or a Blob. Everything else the engine used to fill in
 * here (`pipeline`, `finished`, `stream/promises`, the `toWeb` statics, an
 * async iterator on a Readable, `duplexPair`, `isDisturbed`, the high-water
 * marks) is Node's own file's now and is gone.
 */
function __browserRuntimeFillStreams(table: Record<string, any>, Bytes = BufferPolyfill) {
  const collect = async (source: any) => {
    const chunks: any[] = [];
    if (source && typeof source.getReader === "function") {
      const reader = source.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(Bytes.from(step.value));
      }
    } else if (source && typeof source[Symbol.asyncIterator] === "function") {
      for await (const chunk of source) chunks.push(typeof chunk === "string" ? Bytes.from(chunk) : Bytes.from(chunk));
    } else if (source && typeof source[Symbol.iterator] === "function") {
      for (const chunk of source) chunks.push(typeof chunk === "string" ? Bytes.from(chunk) : Bytes.from(chunk));
    } else {
      throw new TypeError("The stream argument must be a stream or an iterable");
    }
    return Bytes.concat(chunks);
  };
  table["stream/consumers"] = {
    arrayBuffer: async (source: any) => {
      const bytes = await collect(source);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    blob: async (source: any) => new Blob([new Uint8Array(await collect(source))]),
    buffer: collect,
    bytes: async (source: any) => new Uint8Array(await collect(source)),
    json: async (source: any) => JSON.parse((await collect(source)).toString("utf8")),
    text: async (source: any) => (await collect(source)).toString("utf8")
  };
}

__browserRuntimeFillStreams(builtinModules);

__browserRuntimeFillModules(builtinModules);

/**
 * A shared esbuild or rollup shim must use the calling guest's cwd, even after
 * awaits. One shim instance serves every guest in the tab, so a build the guest
 * started with a relative entry resolved that entry against whatever directory
 * the tab happened to be in once the await resumed, and the build failed on a
 * file that was right there. Each guest process gets its own bound copy.
 */
type RollupInput = string | string[] | Record<string, string> | undefined;
type RollupOptions = { input?: RollupInput; fs?: unknown; [key: string]: unknown };
type RollupOutputOptions = { dir?: string; file?: string; [key: string]: unknown };
type RollupBundle = Record<string, (output?: RollupOutputOptions) => unknown>;
type RollupModule = { rollup: (options: RollupOptions) => Promise<RollupBundle>; [key: string]: unknown };
type EsbuildOptions = { absWorkingDir?: string; tsconfig?: string; tsconfigRaw?: string; [key: string]: unknown };
type EsbuildModule = { [key: string]: unknown };

const __substrateGuestBundlers = new WeakMap<Process, EsbuildModule>();
// `wasi` is a per-guest builtin, as fs and process are: its WASI class runs a
// wasm program over the guest's own filesystem and stdio, so each guest
// process gets Node's `lib/wasi.js` evaluated once on a binding to its own.
const __substrateGuestWasis = new WeakMap<Process, WasiModule>();
function __substrateGuestWasi(fsShim: FsShim, process: Process): WasiModule {
  let module = __substrateGuestWasis.get(process);
  if (module === undefined) {
    module = createWasiModule(fsShim as unknown as WasiHostFs, process);
    __substrateGuestWasis.set(process, module);
  }
  return module;
}
const __substrateGuestRollups = new WeakMap<Process, RollupModule>();
let currentVfs: VirtualFS | null = null;
function __substrateGuestRollup(process: Process): RollupModule {
  let bound = __substrateGuestRollups.get(process);
  if (bound) return bound;
  const original = builtinModules.rollup as RollupModule;
  bound = { ...original, rollup: async (options: RollupOptions = {}) => {
    const cwd = process.cwd();
    const resolve = (path: string) => {
      if (path.startsWith(String.fromCharCode(0))) return path;
      const parts: string[] = [];
      for (const part of (path.startsWith("/") ? path : cwd + "/" + path).split("/")) {
        if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part);
      }
      return "/" + parts.join("/");
    };
    const input = typeof options.input === "string" ? resolve(options.input)
      : Array.isArray(options.input) ? options.input.map(resolve)
      : options.input ? Object.fromEntries(Object.entries(options.input).map(([name,path]) => [name,resolve(path)])) : options.input;
    const fs = options.fs ?? (globalThis as { __browserRuntimeRollupFs?: unknown }).__browserRuntimeRollupFs;
    const bundle = await original.rollup({ ...options, input, ...(fs ? { fs } : {}) });
    for (const name of ["generate", "write"]) {
      const action = bundle[name].bind(bundle);
      bundle[name] = (output: RollupOutputOptions = {}) => action({ ...output, ...(output.dir ? { dir: resolve(output.dir) } : {}), ...(output.file ? { file: resolve(output.file) } : {}) });
    }
    return bundle;
  } };
  bound.default = bound;
  __substrateGuestRollups.set(process,bound);
  return bound;
}
function __substrateGuestEsbuild(process: Process): EsbuildModule {
  let bound = __substrateGuestBundlers.get(process);
  if (bound) return bound;
  const original = builtinModules.esbuild as Record<string, (options: EsbuildOptions) => unknown>;
  bound = { ...original };
  // esbuild reads the nearest tsconfig.json above the working directory from
  // disk; the tab's esbuild has none, so it is read from the tab's filesystem
  // here and handed over, as esbuild takes it.
  const nearestTsconfig = (directory: string) => {
    const fs2 = typeof currentVfs !== "undefined" ? currentVfs : null;
    if (!fs2) return void 0;
    let dir = directory;
    for (let hops = 0; hops < 32; hops += 1) {
      const candidate = (dir === "/" ? "" : dir) + "/tsconfig.json";
      try { if (fs2.existsSync(candidate)) return fs2.readFileSync(candidate, "utf8") as string; } catch {}
      if (dir === "/" || !dir) return void 0;
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
    return void 0;
  };
  for (const name of ["build", "context"]) {
    bound[name] = (options: EsbuildOptions = {}) => {
      const absWorkingDir = options.absWorkingDir ?? process.cwd();
      const tsconfigRaw = options.tsconfigRaw ?? (options.tsconfig ? void 0 : nearestTsconfig(absWorkingDir));
      return original[name]({ ...options, absWorkingDir, ...(tsconfigRaw !== void 0 ? { tsconfigRaw } : {}) });
    };
  }
  bound.default = bound;
  __substrateGuestBundlers.set(process, bound);
  return bound;
}

type GuestProcess = Process & { getBuiltinModule?: (name: string) => unknown };

/**
 * A package the project has installed is the one a require of it loads, as Node
 * loads it. The engine answered `rollup`, `esbuild` and `prettier` with shims of
 * its own before looking in `node_modules`, so a real Vite could not reach the
 * esbuild the project carries (the vendor's wasm build, as a pack), and its
 * config loader died in the engine's shim reaching for a CDN. An installed
 * esbuild wins only when it can run here, which is when its package directory
 * holds the wasm binary; one that would spawn a native binary is still answered
 * by the engine's own service for it, as is a package that is not installed.
 */
// Whether the esbuild a file belongs to runs in a tab: its package directory
// holds the wasm binary, as esbuild-wasm's does and esbuild's does not.
function __substrateEsbuildRunsHere(vfs: VirtualFS, file: string): boolean {
  let dir = file;
  for (let hops = 0; hops < 6; hops += 1) {
    dir = dir.slice(0, dir.lastIndexOf("/"));
    if (!dir) return false;
    if (vfs.existsSync(dir + "/package.json")) return vfs.existsSync(dir + "/esbuild.wasm");
  }
  return false;
}

/**
 * Node's `module` builtin is the `Module` class: every module's `require` is
 * `Module.prototype.require`, and resolution goes through
 * `Module._resolveFilename`, so a program that replaces either, Next's require
 * hook among them, sees every later require. A plain object answered
 * `require("module")` and resolution went through closures no program could
 * reach, so the hook read `undefined.require` and died. The class here is one
 * per module cache (one per container), and each `require` the engine creates
 * consults it before its own path.
 */
const __substrateModuleClasses = new WeakMap<Record<string, Module>, any>();
/** What a module being loaded carries past its extension's handler, whose signature has no room for it. */
const __substrateLoading = new WeakMap<object, { resolvedAs?: { url?: string; format?: string; source?: string | ArrayBuffer | ArrayBufferView | null }; compiling?: { raw: string; format: string | undefined } }>();
/** Node's `findLongestRegisteredExtension`: the longest registered extension the file's name ends with, else `.js`. */
function __substrateRegisteredExtension(filename: string, extensions: Record<string, unknown>): string {
  const name = filename.slice(filename.lastIndexOf('/') + 1);
  for (let index = name.indexOf('.'); index !== -1; index = name.indexOf('.', index + 1)) {
    if (index === 0) continue;
    const extension = name.slice(index);
    if (extensions[extension]) return extension;
  }
  return '.js';
}
// Node shares successful path resolutions between a process's modules
// (Module._pathCache). A cache per require repeated sibling imports' tree
// probes: 0.863 s inclusive resolveModule in Dub's retained World host.
// Keep failures local and separate filesystems/process module caches. The
// payload estimate bounds retained strings, not JavaScript heap overhead.
/**
 * What a process keeps between its resolutions (node-resolution.ts `ResolutionKept`), and the depth of its `require`
 * calls in flight: Node's `requireDepth`, which decides when its stat cache exists.
 */
const __substrateResolutionKept = new WeakMap<object, ResolutionKept & { depth: number }>();
function __substrateKeptFor(process: object): ResolutionKept & { depth: number } {
  let kept = __substrateResolutionKept.get(process);
  if (!kept) { kept = { manifests: new Map(), realPaths: new Map(), depth: 0, probes: { file: 0, directory: 0, absent: 0, held: 0, outside: 0, windows: 0 } }; __substrateResolutionKept.set(process, kept); }
  return kept;
}
/**
 * Node's stat cache exists while a module compiled at require depth 0 executes, and not otherwise
 * (`Module.prototype._compile`: `if (requireDepth === 0) { statCache = new SafeMap(); }`, unset when the body returns).
 */
const __substrateWindowSaid = new WeakSet<object>();
function __substrateInStatWindow<T>(process: object, run: () => T): T {
  const keeping = __substrateKeptFor(process);
  // An instrument: at a process's first module body, whether its stat window opens and the require depth it saw.
  if (!__substrateWindowSaid.has(process)) {
    __substrateWindowSaid.add(process);
    console.log('[boot-trace]', JSON.stringify({ event: 'stat-window', at: Date.now(), pid: (process as { pid?: number }).pid ?? null, opened: keeping.depth === 0 && keeping.stats === undefined, depth: keeping.depth }));
  }
  if (keeping.depth !== 0 || keeping.stats !== undefined) return run();
  keeping.stats = new Map();
  if (keeping.probes) keeping.probes.windows += 1;
  try { return run(); } finally { keeping.stats = undefined; }
}
const __substrateResolvedPaths = new WeakMap<Record<string, Module>, WeakMap<VirtualFS, { paths: Map<string, string>; bytes: number }>>();
function __substratePathsFor(cache: Record<string, Module>, fs: VirtualFS) {
  let filesystems = __substrateResolvedPaths.get(cache);
  if (!filesystems) { filesystems = new WeakMap(); __substrateResolvedPaths.set(cache, filesystems); }
  let paths = filesystems.get(fs);
  if (!paths) { paths = { paths: new Map(), bytes: 0 }; filesystems.set(fs, paths); }
  return paths;
}
function __substrateKeepPath(cache: { paths: Map<string, string>; bytes: number }, key: string, path: string): void {
  const bytes = 2 * (key.length + path.length);
  if (bytes > 8 * 1024 * 1024) return;
  const old = cache.paths.get(key);
  if (old !== undefined) { cache.paths.delete(key); cache.bytes -= 2 * (key.length + old.length); }
  while (cache.paths.size >= 8192 || cache.bytes + bytes > 8 * 1024 * 1024) {
    const first = cache.paths.entries().next().value!;
    cache.paths.delete(first[0]);
    cache.bytes -= 2 * (first[0].length + first[1].length);
  }
  cache.paths.set(key, path);
  cache.bytes += bytes;
}
// The directory a module resolves from: its file's, or, for the stand-in
// parent a require without a module names, the directory itself, which it
// carries with a trailing slash that dirname would otherwise climb out of.
function __substrateModuleDir(parent: any, currentDir: string): string {
  if (!parent || typeof parent.filename !== "string" || parent.filename === "") return currentDir;
  if (parent.filename.endsWith("/")) return parent.filename.length > 1 ? parent.filename.slice(0, -1) : "/";
  return pathShim.dirname(parent.filename);
}
function __substrateModuleClassFor(moduleCache: Record<string, Module>, requireFor: (parent: any) => any): any {
  let Module = __substrateModuleClasses.get(moduleCache);
  if (Module) return Module;
  Module = function Module(this: any, id = "", parent?: any) {
    this.id = id; this.filename = id; this.exports = {}; this.loaded = false; this.children = []; this.paths = []; this.parent = parent;
  };
  // Node's chain, and the one a program patches into: a module's `require`
  // calls `Module._load`, and `_load` does the resolving and the loading.
  // openvscode-server's extension host answers an extension's
  // `require('vscode')` by replacing `_load` (`NodeModuleRequireInterceptor`),
  // which is how ts-node, pirates, module-alias and proxyquire all work too;
  // the engine's require went straight to its own loader, so every such patch
  // was installed and never called. Measured in the tab: after
  // `module._load = fn`, a `require('fs')` never reached `fn`.
  // The calls in flight are counted here and nowhere below, as Node counts them (`requireDepth` in
  // `Module.prototype.require`): `_load` does not count, so an entry started through it runs its body at depth 0.
  Module.prototype.require = function (this: any, id: string) {
    const keeping = __substrateKeptFor(process);
    keeping.depth += 1;
    const phase = __substrateLoadPhase(process, undefined, 'resolve');
    try { return Module._load(id, this, false); } finally { keeping.depth -= 1; __substrateLoadPhase(process, undefined, phase); }
  };
  Module.__substrateRequire = Module.prototype.require;
  // `Module.prototype._compile(content, filename)` is the seam every loader
  // that transpiles a file uses: require.extensions hooks, ts-node, and
  // Next's TypeScript config loader, which compiles a string into a bare
  // `new Module(...)`. Node also takes ES module source here (require(esm),
  // Node >= 22.12), so the content goes through the engine's own loader.
  Module.prototype._compile = function (this: any, content: string, filename: string) {
    const file = typeof filename === 'string' && filename ? filename : (this.filename || this.id || '');
    this.filename = file;
    if (!Array.isArray(this.paths) || this.paths.length === 0) this.paths = Module._nodeModulePaths(pathShim.dirname(file));
    (Module.__substrateCompileRaw ?? ((module: any, text: string, name: string, dir: string) => requireFor(module).__compileRaw(module, text, name, dir)))(this, String(content), file, pathShim.dirname(file));
    return this.exports;
  };
  // The engine's own compile, by identity: a load takes a body by the tree's digest only where this is what the
  // module would be compiled by, since a program's own `_compile` is handed the source's text.
  Module.__substrateOwnCompile = Module.prototype._compile;
  Module._resolveFilename = function (request: string, parent: any) { return requireFor(parent).__resolveRaw(request); };
  Module.__substrateResolveFilename = Module._resolveFilename;
  // `Module._load(request, null, true)` runs a module as the main module, the
  // way Node starts the entry it was given: the module it loads is
  // `process.mainModule` and every `require.main` from the moment its body runs.
  Module._load = function (request: string, parent: any, isMain: boolean) {
    const from = parent || new Module();
    if (isMain) (process as any).__substrateMainPending = Module._resolveFilename(request, from, true, void 0);
    return requireFor(from).__loadRaw(request);
  };
  Module.__substrateLoad = Module._load;
  Module._cache = moduleCache;
  // Node's extension loaders, what `require.extensions` names, and the loader's one path: it loads every file by
  // calling the entry for the file's extension. The built-in ones are the engine's load step, which compiles through
  // `module._compile` as Node's do; a program that registers one (ts-node's `.ts`, @babel/register's `.js`) replaces
  // the entry and is called in its place, and usually chains to the one it replaced. `.ts`, `.mts` and `.cts` are
  // built in as in Node 24, where they strip types; a registered `.ts` handler replaces that, as it does there.
  const builtinHandler = (module: any, filename: string) => {
    // Before this run has loaded any file (a program calling a handler itself), the load step is a loader's made here.
    (Module.__substrateBuiltinLoad ?? ((loading: any, name: string) => requireFor(loading).__builtinLoad(loading, name)))(module, filename);
  };
  Module._extensions = Object.assign(Object.create(null), {
    ".js": builtinHandler,
    ".json": builtinHandler,
    ".ts": builtinHandler,
    ".mts": builtinHandler,
    ".cts": builtinHandler,
    ".node": (module: any, filename: string) => { throw Object.assign(new Error(`Cannot load native addon ${filename} in a tab.`), { code: "ERR_DLOPEN_FAILED" }); },
  });
  Module._pathCache = Object.create(null);
  Module.builtinModules = moduleShim.builtinModules;
  Module.isBuiltin = moduleShim.isBuiltin;
  Module.syncBuiltinESMExports = () => syncBuiltinESMExports(process);
  Module.globalPaths = ["/node_modules"];
  Module._nodeModulePaths = (directory: string) => {
    const result = [];
    for (let current = directory.replace(/\/$/u, "") || "/";;) {
      if (!current.endsWith("/node_modules")) result.push((current === "/" ? "" : current) + "/node_modules");
      if (current === "/") return result;
      current = current.slice(0, current.lastIndexOf("/")) || "/";
    }
  };
  // The rest of Node's CommonJS surface that is a few lines over what is here (lib/internal/modules/cjs/loader.js,
  // run_main.js). Each was absent, and a program that reads one found `undefined` where Node has a function.
  // `Module.runMain(main)`: run a file as the entry, which is what ts-node does once it has registered itself.
  Module.runMain = (main: string = (process as any).argv[1]) => Module._load(main, null, true);
  // `Module._resolveLookupPaths(request, parent)`: where a lookup would search; `require.resolve.paths` is over it.
  Module._resolveLookupPaths = (request: string, parent: any) => requireFor(parent || new Module()).resolve.paths(request);
  // `Module._findPath(request, paths)`: the file `request` is under the first of `paths` that has it, or false.
  Module._findPath = (request: string, paths: string[]) => {
    for (const from of pathShim.isAbsolute(request) ? [""] : paths ?? []) {
      try { return requireFor(new Module()).__resolveRaw(pathShim.resolve(from || "/", request)); } catch { /* the next directory */ }
    }
    return false;
  };
  // Node recomputes its global folders from HOME and NODE_PATH here; this engine's are fixed (`globalPaths`).
  Module._initPaths = () => undefined;
  Module._preloadModules = (requests: string[] | undefined) => { for (const request of requests ?? []) Module._load(request, new Module("internal/preload"), false); };
  Module._debug = () => undefined;
  // `module.load(filename)`: Node's own body, the extension's handler run on this module.
  Module.prototype.load = function (this: any, filename: string) {
    this.filename = filename;
    this.paths = Module._nodeModulePaths(pathShim.dirname(filename));
    const extension = pathShim.extname(filename);
    (Module._extensions[extension] ?? Module._extensions[".js"])(this, filename);
    this.loaded = true;
  };
  Module.wrapper = ["(function (exports, require, module, __filename, __dirname) { ", "\n});"];
  Module.wrap = (code: string) => Module.wrapper[0] + code + Module.wrapper[1];
  Module.createRequire = (filenameOrUrl: string) => {
    let fromPath = String(filenameOrUrl);
    if (fromPath.startsWith("file://")) {
      fromPath = fromPath.slice(7);
      if (fromPath.startsWith("/") && fromPath[2] === ":") fromPath = fromPath.slice(1);
    }
    const made = requireFor({ id: fromPath, filename: fromPath, paths: [] });
    made.cache = moduleCache;
    return made;
  };
  Module.findSourceMap = () => undefined;
  // The same switch `process.setSourceMapsEnabled` sets, by Node's two module functions.
  Module.getSourceMapsSupport = () => Object.freeze({ ...sourceMapsSupportOf(process) });
  Module.setSourceMapsSupport = (enabled: unknown, options: { nodeModules?: unknown; generatedCode?: unknown } = {}) => {
    if (typeof enabled !== 'boolean') throw new ERR_INVALID_ARG_TYPE('enabled', 'boolean', enabled);
    for (const key of ['nodeModules', 'generatedCode'] as const) {
      if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new ERR_INVALID_ARG_TYPE(`options.${key}`, 'boolean', options[key]);
    }
    setSourceMapsSupportOf(process, enabled, { nodeModules: options.nodeModules === true, generatedCode: options.generatedCode === true });
  };
  // The module-customization hooks of this run, built on the first call and
  // nowhere else: a run that registers none never pays for the chain, which is
  // the fast path Node keeps too. They hang off the Module class because that
  // class is this run's -- one per module cache -- and Node's are per process.
  Module.__substrateHooks = void 0;
  const __substrateHooksOf = (): RunModuleHooks => (Module.__substrateHooks ??= new RunModuleHooks(process));
  Module.registerHooks = (hooks: { resolve?: unknown; load?: unknown }) => __substrateHooksOf().sync.registerHooks(hooks);
  Module.register = (specifier: unknown, parentURL?: unknown, options?: { parentURL?: unknown; data?: unknown; transferList?: unknown }) =>
    __substrateHooksOf().register(specifier, parentURL, options, (url: string, from: string) => Module.createRequire(from)(url));
  Module.Module = Module;
  Module.default = Module;
  __substrateModuleClasses.set(moduleCache, Module);
  return Module;
}

/**
 * Create a require function for a specific module context
 */
function createRequire(
  vfs: VirtualFS,
  fsShim: FsShim,
  process: Process,
  currentDir: string,
  moduleCache: Record<string, Module>,
  options: RuntimeOptions,
  processedCodeCache?: Map<string, string>,
  parentModule?: Module | null
): RequireFunction {
  currentVfs = vfs;
  // Whether a name the engine has a shim for is answered by an installed
  // package instead: one is installed, and, for esbuild, one that runs here.
  // Names the engine's table answers that are not Node's: a package the project
  // installed wins over each; and one that stands for a native watcher,
  // fsevents, chokidar's use of it, is not answered at all when it is not
  // installed, as it is not on a Linux host.
  const __substrateInstalledWins = (id: string): boolean => {
    const shimmed = id === 'rollup' || id.startsWith('rollup/') || id.startsWith('@rollup/') ? 'rollup'
      : id === 'esbuild' || id.startsWith('esbuild/') || id.startsWith('@esbuild/') ? 'esbuild'
      : id === 'prettier' || id.startsWith('prettier/') ? 'prettier'
      : id === 'ws' || id.startsWith('ws/') ? 'ws'
      : id === 'chokidar' || id.startsWith('chokidar/') ? 'chokidar'
      : id === 'readdirp' || id.startsWith('readdirp/') ? 'readdirp'
      : id === 'fsevents' ? 'fsevents' : void 0;
    if (!shimmed) return false;
    try {
      const file = resolveModule(id, currentDir);
      return shimmed !== 'esbuild' || __substrateEsbuildRunsHere(vfs, file);
    } catch {
      return false;
    }
  };
  const __substrateModule = () => __substrateModuleClassFor(moduleCache, (parent: any) => createRequire(vfs, fsShim, process, __substrateModuleDir(parent, currentDir), moduleCache, options, processedCodeCache, parent));
  /** The hooks this run has registered, and undefined while it has registered none. */
  const __substrateHooks = (): RunModuleHooks | undefined => __substrateModule().__substrateHooks as RunModuleHooks | undefined;
  const __substrateResolve = (id: string): string => {
    const Module = __substrateModule();
    return Module._resolveFilename === Module.__substrateResolveFilename
      ? resolveModule(id, currentDir)
      : Module._resolveFilename(id, parentModule || { id: currentDir, filename: currentDir + '/', paths: [] }, false, undefined);
  };
  // Module resolution cache for faster repeated imports
  const resolutionCache: Map<string, string | null> = new Map();
  const successfulPaths = __substratePathsFor(moduleCache, vfs);

  // Package.json parsing cache
  const packageJsonCache: Map<string, PackageJson | null> = new Map();

  const getParsedPackageJson = (pkgPath: string): PackageJson | null => {
    if (packageJsonCache.has(pkgPath)) {
      return packageJsonCache.get(pkgPath)!;
    }
    try {
      const content = vfs.readFileSync(pkgPath, 'utf8');
      const parsed = JSON.parse(content) as PackageJson;
      packageJsonCache.set(pkgPath, parsed);
      return parsed;
    } catch {
      packageJsonCache.set(pkgPath, null);
      return null;
    }
  };

  const resolveModule = (id: string, fromDir: string): string => {
    // Handle node: protocol prefix (Node.js 16+)
    if (id.startsWith('node:')) {
      id = id.slice(5);
    }
    // A file URL is read as its path here too, behind a lowered import.
    if (id.startsWith('file://')) {
      id = decodeURIComponent(new URL(id).pathname);
    }

    // A package the engine stands in for resolves to the installed file. The
    // engine answers `require("rollup")` and `require("esbuild")` with its own
    // builds, and this resolver gave their bare names back, as it does for
    // Node's builtins; Vite's Node API resolves rollup to read the package.json
    // beside it, and read `<cwd>/rollup/../../package.json` instead, which is
    // nowhere, so vue3-ssr's server died importing Vite. Node's builtins still
    // resolve to their names; a stand-in resolves to the file the project
    // installed, and to its name only where the project has no such package.
    const __standInPaths = (globalThis as Record<string, unknown>).__browserRuntimeStandInPaths as Record<string, string> | undefined;
    if (__standInPaths && Object.prototype.hasOwnProperty.call(__standInPaths, id) && vfs.existsSync(__standInPaths[id])) {
      return __standInPaths[id];
    }
    if (id === 'fs' || id === 'process' || id === 'url' || id === 'querystring' || id === 'util' || moduleShim.builtinModules.includes(id)) {
      return id;
    }
    const __standIn = Boolean(builtinModules[id]);

    // The engine's own `#imports` walk stopped one directory short of the root,
    // so a root package's imports map never answered; the shared resolver takes
    // the `#` names too.
    if (id.startsWith('#')) {
      const __resolvedImport = __nodeResolverFor(vfs, 'runtime').resolve(id, fromDir, __substrateKeptFor(process));
      if (__resolvedImport) return __resolvedImport;
      throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
    }
    const cacheKey = `${fromDir}\0${id}`;
    const cached = resolutionCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached === null) {
        throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
      }
      return cached;
    }
    const successful = successfulPaths.paths.get(cacheKey);
    if (successful !== undefined) return successful;

    // One resolver for every name the engine resolves: this require, the simple
    // loader's, and the bundler's plugin. Each had a hand-rolled subset of
    // Node's algorithm; they disagreed with each other and with Node, and every
    // app found a new gap. This site keeps only its edges — the cache, the
    // builtins, the stand-ins — and calls the shared resolver.
    {
      const __resolved = __nodeResolverFor(vfs, 'runtime').resolve(id, fromDir, __substrateKeptFor(process));
      if (__resolved) {
        __substrateKeepPath(successfulPaths, cacheKey, __resolved);
        return __resolved;
      }
    }

    // A name the tree does not answer is put to the module stand-ins before it
    // is "not found": a registered stand-in may answer with a module it computes
    // from the project, what a generator would have written. The registry is
    // `globalThis.__browserRuntimeModuleStandIns`, installed by the toolchain.
    const __standIns = (globalThis as Record<string, unknown>).__browserRuntimeModuleStandIns as { resolve: (id: string, from: string) => string | null } | undefined;
    const __answered = __standIns ? __standIns.resolve(id, fromDir) : null;
    if (__answered) {
      resolutionCache.set(cacheKey, __answered);
      return __answered;
    }
    resolutionCache.set(cacheKey, null);
    if (__standIn) return id;
    throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
  };

  /**
   * What a resolve step already decided about a module: the URL the hooks
   * chain settled on, the format it named, and, where a load hook replaced a
   * builtin's source, that source. Node carries the same three on the module
   * record (`kURL`, `kFormat`, `kModuleSource`).
   */
  type ResolvedAs = { url?: string; format?: string; source?: string | ArrayBuffer | ArrayBufferView | null };
  const loadModule = (resolvedPath: string, resolvedAs?: ResolvedAs): Module => {
    // A path into a package the host stands in for loads the host's file
    // too, from the same table the resolver reads by name
    // (`globalThis.__browserRuntimeStandInPaths`, package name -> file): Vite's
    // bundled config imports its plugins by the file paths its own resolver
    // found, `node_modules/<package>/dist/index.mjs`, never by name. The
    // engine names no package here; the table is the host's.
    const __hostStandIns = (globalThis as Record<string, unknown>).__browserRuntimeStandInPaths as Record<string, string> | undefined;
    if (__hostStandIns) {
      for (const [__name, __file] of Object.entries(__hostStandIns)) {
        if (resolvedPath.includes('/node_modules/' + __name + '/') && vfs.existsSync(__file)) { resolvedPath = __file; break; }
      }
    }
    // Return cached module
    // A native addon cannot load in a tab. Node answers a `require` of a `.node`
    // file that cannot be loaded with `ERR_DLOPEN_FAILED`, and a package that
    // probes for its addon, chokidar for fsevents, takes its portable path on
    // that error. Reading the binary as a module and parsing it took the process
    // with it.
    if (resolvedPath.endsWith('.node')) {
      // A native addon whose surface the holder answers in JavaScript, named
      // by the package the addon belongs to (`bcrypt` -> a module with the
      // binding's exports): the addon's bytes are never read and the stand-in
      // loads in its place. Every other addon fails as Node's dlopen would.
      const __native = (globalThis as { __browserRuntimeNativeStandIns?: Record<string, string> }).__browserRuntimeNativeStandIns;
      const __package = __native ? Object.keys(__native).find((name) => resolvedPath.includes('/node_modules/' + name + '/')) : undefined;
      const __answer = __package !== undefined && __native ? __native[__package] : undefined;
      if (__answer && vfs.existsSync(__answer)) {
        resolvedPath = __answer;
      } else {
        throw Object.assign(new Error('Cannot load native addon ' + resolvedPath + ': a tab runs no native code.'), { code: 'ERR_DLOPEN_FAILED' });
      }
    }
    if (moduleCache[resolvedPath]) {
      return moduleCache[resolvedPath];
    }

    // A module knows its parent. Node's `module.parent` is the module that
    // first required this one, null for the entry; with no parent, nodemon,
    // which reads its own version from the package.json above
    // `module.parent.filename`, died in a callback with nothing said.
    const module: Module = {
      id: resolvedPath,
      filename: resolvedPath,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
      parent: parentModule || null,
    };
    // A module is an instance of Module, as Node's is: `module.require`, `module._compile` and `module.load` are the
    // class's, `module.path` is its directory and `module.paths` where its own requires look. Made as a bare object
    // it had none of them ("mod.require is not a function": source-map-support's `dynamicRequire(module, 'fs')`).
    Object.setPrototypeOf(module, __substrateModule().prototype);
    (module as Module & { path: string }).path = pathShim.dirname(resolvedPath);
    module.paths = __substrateModule()._nodeModulePaths(pathShim.dirname(resolvedPath));
    if (parentModule && Array.isArray(parentModule.children)) parentModule.children.push(module);

    // Cache before loading to handle circular dependencies
    moduleCache[resolvedPath] = module;
    // The entry module is the main module: `process.mainModule` and
    // `require.main` name it, and its id is ".", as Node has them, so a program
    // that runs only when it is the entry (`require.main === module`, which the
    // Prisma CLI and every bin script written that way tests) runs.
    if ((process as any).__substrateMainPending === resolvedPath) {
      delete (process as any).__substrateMainPending;
      (process as any).mainModule = module;
      module.id = '.';
    }

    // Node keeps every loaded module for the life of the process; so does a tab.
    // A cap of 2000 meant a program that requires more, as a Next application's
    // Server Action does with its middleware, saw its earliest modules load a
    // second time: two live copies of a module that holds state, such as Next's
    // request store, and the second copy empty.

    // Node's `Module.prototype.load`: the handler registered for the file's extension loads it, and that is the one
    // path. The built-in handlers are the engine's own load step (`builtinLoad`, below) and compile through
    // `module._compile`; a handler a program registered (ts-node, @babel/register, pirates) is called here because
    // it is the one in the table, and the `_compile` it replaced on the module is called because the handler it
    // chains to calls it.
    if (resolvedAs) __substrateLoading.set(module, { resolvedAs });
    const Mod = __substrateModule();
    Mod.__substrateBuiltinLoad = builtinLoad;
    Mod.__substrateCompileRaw = compileRaw;
    try { Mod._extensions[__substrateRegisteredExtension(resolvedPath, Mod._extensions)](module, resolvedPath); }
    finally { __substrateLoading.delete(module); }
    return module;
  };

  /**
   * The built-in handlers' load step (Node's `Module._extensions['.js']`, `['.json']` and, since Node 24, `['.ts']`):
   * the file's source and format, through the run's load hooks where it has any; JSON parsed; anything else
   * compiled through `module._compile`, which a program may have replaced on this module.
   */
  const builtinLoad = (module: Module, resolvedPath: string): void => {
    __substrateLoadPhase(process, vfs, 'read');
    const Mod = __substrateModule();
    const resolvedAs = __substrateLoading.get(module)?.resolvedAs;
    // A module's source, and the format it is compiled in, are the load step.
    // Where a run has registered load hooks the chain answers both and this
    // read is its last link, which is where Node's `loadSource` calls
    // `loadWithHooks`; where it has none, nothing here changes.
    const __hooks = __substrateHooks();
    const defaultSource = (): string => resolvedPath.startsWith('data:')
      ? __substrateDataModuleSource(resolvedPath)!
      : vfs.readFileSync(resolvedPath, 'utf8');
    let format = resolvedAs?.format;
    let source = resolvedAs?.source;
    if (__hooks && __hooks.hasSyncLoad && source === undefined) {
      const url = resolvedAs?.url ?? __hooks.sync.convertCJSFilenameToURL(resolvedPath);
      const loaded = __hooks.sync.loadWithHooks(url, format, void 0, CJS_CONDITIONS, (urlFromHook, context) => ({
        // Node's `getDefaultLoad`: a URL the chain changed is read from the
        // file it names, not from the one the loader started with.
        source: urlFromHook === url ? defaultSource() : vfs.readFileSync(__hooks.sync.convertURLToCJSFilename(urlFromHook), 'utf8'),
        format: context.format,
      }));
      format = loaded.format;
      source = loaded.source;
    }

    if (format === 'json' || (format === undefined && resolvedPath.endsWith('.json'))) {
      module.exports = JSON.parse(source === undefined || source === null ? vfs.readFileSync(resolvedPath, 'utf8') : String(source));
      module.loaded = true;
      return;
    }

    // A body named by the tree's own digest of the file, where the source would reach the engine's compile as the
    // file's own text and nothing else: no load hook is registered (a hook may answer other text or a format), no
    // resolve step named a source or format, the module's `_compile` is the engine's (a program's own is handed the
    // text, so it must be read), and types are not stripped. Then the text is never read and never hashed. A tree
    // with no digest for the file's current content, or no body by that name, leaves the load to the read below.
    if (source === undefined && format === undefined && !(__hooks && __hooks.hasSyncLoad) && !resolvedPath.startsWith('data:')
      && (module as Module & { _compile?: unknown })._compile === Mod.__substrateOwnCompile
      && !transformsTypes(process as { execArgv?: string[]; env?: Record<string, string> })) {
      const kind = preparedModuleKind(resolvedPath);
      const digest = kind ? vfs.contentDigest(resolvedPath) : undefined;
      const body = kind && digest ? __substrateReadPrepared(vfs, preparedModuleKeyOf(kind, digest)) : undefined;
      if (body !== undefined) {
        __substrateCountPrepared(process, 'digest');
        (module as Module & { filename?: string }).filename = resolvedPath;
        if (!Array.isArray(module.paths) || module.paths.length === 0) module.paths = Mod._nodeModulePaths(pathShim.dirname(resolvedPath));
        runModuleBody(module, body, resolvedPath, pathShim.dirname(resolvedPath), true);
        return;
      }
    }

    // Read and execute JS file; a data: URL carries its own source.
    const rawCode = source === undefined || source === null ? defaultSource() : String(source);
    // A data: URL is no file: it has no extension's handler to answer to and no directory of its own.
    if (resolvedPath.startsWith('data:')) { runModuleBody(module, prepareModuleCode(rawCode, resolvedPath, format), resolvedPath, currentDir); return; }
    // What `_compile` is handed, kept beside the module so the engine's own compile knows the format a hook named
    // and whether the text is still the file's own (a body the image prepared is taken only for that).
    __substrateLoading.set(module, { ...(resolvedAs ? { resolvedAs } : {}), compiling: { raw: rawCode, format } });
    (module as Module & { _compile(content: string, filename: string): unknown })._compile(rawCode, resolvedPath);
  };

  /** `Module.prototype._compile`'s own work: the engine's pipeline over `content`, as the module at `filename`. */
  const compileRaw = (module: Module, content: string, filename: string, dirname: string): void => {
    const compiling = __substrateLoading.get(module)?.compiling;
    const format = compiling?.format;
    const rawCode = content;
    const resolvedPath = filename;
    __substrateTracePreparedGate(vfs, process, compiling, content, resolvedPath);
    // A body prepared for the file's own text; a program's `_compile` that handed on other text compiles that text.
    const strips = transformsTypes(process as { execArgv?: string[]; env?: Record<string, string> });
    const key = compiling?.raw === content && format === undefined && !strips ? preparedModuleKey(rawCode, resolvedPath) : undefined;
    if (key) {
      const taken = __substrateReadPrepared(vfs, key);
      if (taken !== undefined) {
        __substrateCountPrepared(process, 'hash');
        runModuleBody(module, taken, resolvedPath, dirname, true);
        return;
      }
      // A file the image carries no body for (a package installed in the
      // tab) is prepared here once and kept under the same name, so the next
      // process takes it: every Playwright test worker required
      // playwright-core afresh, 28 s each, measured in a tab. Only where the
      // tree has the directory bodies are kept in; asked once the body's own
      // read has missed, so a taken body costs no question about it.
      if (vfs.existsSync(PREPARED_MODULES_DIR)) {
        const body = __substrateScopeGlobalCalls(prepareModuleCode(rawCode, resolvedPath));
        // One write is one step of the tab's filesystem, so no reader sees
        // half a body; a rename after it failed in a forked process's realm
        // and left the half-named file behind.
        // What was kept is also said, one key a line, in a list beside the bodies: a reader that wants the bodies
        // made in the tab (a dry run's capture) reads the list, where telling them from an image's own tens of
        // thousands meant listing the directory.
        try { vfs.writeFileSync(`${PREPARED_MODULES_DIR}/${key}`, body); vfs.appendFileSync(`${PREPARED_MODULES_DIR}/${PREPARED_MODULES_KEPT}`, `${key}\n`); }
        catch { /* a process that may not write there prepares its own */ }
        __substrateCountPrepared(process, 'kept');
        runModuleBody(module, body, resolvedPath, dirname, true);
        return;
      }
    }
    __substrateCountPrepared(process, key ? 'noDirectory' : compiling?.raw !== content ? 'notOwnText' : format !== undefined ? 'format' : strips ? 'types' : 'notJavaScript');
    runModuleBody(module, prepareModuleCode(rawCode, resolvedPath, format), resolvedPath, dirname);
  };

  /**
   * A file's source made a body: shebang stripped, types stripped, ESM
   * lowered, dynamic imports rewritten; cached by content.
   *
   * `format` is what a load hook named, and it decides the same three things
   * the file's extension decides without one: whether the source carries
   * types, whether it is lowered as an ES module, and whether it is JSON. A
   * run with no hooks never passes one, and the extension rules below are
   * what they always were.
   */
  const prepareModuleCode = (rawCode: string, resolvedPath: string, format?: string): string => {
    // Check processed code cache (useful for HMR when module cache is cleared but code hasn't changed)
    // Use a simple hash of the content for cache key to handle content changes
    const codeCacheKey = `${resolvedPath}|${format ?? ''}|${transformsTypes(process as { execArgv?: string[]; env?: Record<string, string> }) ? 'transform-types|' : ''}${simpleHash(rawCode)}`;
    let code = processedCodeCache?.get(codeCacheKey);
    if (!code) {
      code = __substratePrepareBody(rawCode, resolvedPath, format, process);
      processedCodeCache?.set(codeCacheKey, code);
    }
    return code;
  };

  /**
   * Runs a body as the module, on the module's own require and console, and
   * keeps it settling where it must. Node compiles a body in place through
   * `Module.prototype._compile`, and a loader that transpiles a file
   * (require.extensions hooks, ts-node, Next's TypeScript config loader)
   * hands the result to it; the engine's own pipeline is what makes the
   * body Node-shaped here.
   */
  const runModuleBody = (module: Module, prepared: string, resolvedPath: string, dirname: string, scoped = false): void => {
    __substrateLoadPhase(process, vfs, 'link');
    const loadClock = __substrateLoadClocks.get(process);
    if (loadClock) { loadClock.bodies += 1; loadClock.bodyBytes += prepared.length; }
    let code = prepared;
    // Create require for this module
    const moduleRequire = createRequire(
      vfs,
      fsShim,
      process,
      dirname,
      moduleCache,
      options,
      processedCodeCache,
      module
    );
    moduleRequire.cache = moduleCache;

    // Create console wrapper
    const consoleWrapper = createConsoleWrapper(options.onConsole);

    // Execute module code
    // We use an outer/inner function pattern to avoid conflicts:
    // - Outer function receives parameters and sets up vars
    // - Inner function runs the code, allowing let/const to shadow without "already declared" errors
    // - import.meta is provided for ESM code that uses it
    try {
      const importMetaUrl = resolvedPath.startsWith('data:') ? resolvedPath : 'file://' + resolvedPath;
      const strictBody = code.startsWith(__substrateModuleMarker);
      if (strictBody) __substrateEsBodyRuns(process);
      if (!scoped) code = __substrateScopeGlobalCalls(code);
      // The wrapper is one line and the body begins on it, as Node's
      // `Module.wrap` is one line, so a module's line N is line N of the
      // script V8 compiles and a stack names the module's own lines. The
      // header's `var` statements are the module's scope, `globalThis` and
      // `global` among them for code that reads the process off them
      // directly; the inner function is what lets the body's own `let` and
      // `const` shadow that scope. `__substrateSourceURL` names the script.
      const wrappedCode = `(function($exports, $require, $module, $filename, $dirname, $process, $console, $importMeta, $dynamicImport, __substrateGuestGlobal, __substrateGuestConstructor) { var exports = $exports; var require = $require; var module = $module; var __filename = $filename; var __dirname = $dirname; var process = $process; var console = $console; var import_meta = $importMeta; var __dynamicImport = $dynamicImport; var globalThis = __substrateGuestGlobal($process); var global = globalThis; var Buffer = globalThis.Buffer; var queueMicrotask = globalThis.queueMicrotask, atob = globalThis.atob, btoa = globalThis.btoa, structuredClone = globalThis.structuredClone, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval; globalThis.process = $process; global.process = $process; with ({ __proto__: null, get MessageChannel() { return globalThis.MessageChannel; }, set MessageChannel(value) { globalThis.MessageChannel = value; }, get MessagePort() { return globalThis.MessagePort; }, set MessagePort(value) { globalThis.MessagePort = value; }, get Worker() { return globalThis.Worker; }, set Worker(value) { globalThis.Worker = value; }, get self() { return globalThis.self; }, set self(value) { globalThis.self = value; }, get postMessage() { return globalThis.postMessage; }, set postMessage(value) { globalThis.postMessage = value; }, get onmessage() { return globalThis.onmessage; }, set onmessage(value) { globalThis.onmessage = value; }, get onmessageerror() { return globalThis.onmessageerror; }, set onmessageerror(value) { globalThis.onmessageerror = value; }, get close() { return globalThis.close; }, set close(value) { globalThis.close = value; }, get addEventListener() { return globalThis.addEventListener; }, set addEventListener(value) { globalThis.addEventListener = value; }, get removeEventListener() { return globalThis.removeEventListener; }, set removeEventListener(value) { globalThis.removeEventListener = value; }, get dispatchEvent() { return globalThis.dispatchEvent; }, set dispatchEvent(value) { globalThis.dispatchEvent = value; }, get navigator() { return globalThis.navigator; }, set navigator(value) { globalThis.navigator = value; }, get Navigator() { return globalThis.Navigator; }, set Navigator(value) { globalThis.Navigator = value; }, get Promise() { return globalThis.Promise; }, set Promise(value) { globalThis.Promise = value; }, get fetch() { return globalThis.fetch; }, set fetch(value) { globalThis.fetch = value; }, get window() { return globalThis.window; }, set window(value) { globalThis.window = value; }, get document() { return globalThis.document; }, set document(value) { globalThis.document = value; }, get location() { return globalThis.location; }, set location(value) { globalThis.location = value; }, get performance() { return globalThis.performance; }, set performance(value) { globalThis.performance = value; } }) { return (function() {${code}
}).call(${strictBody ? 'void 0' : '$module.exports'}); }
})${__substrateSourceURL(resolvedPath)}`;

      // A lowered ES module body is a generator that yields at each import
      // still settling; a body that must wait, on a top-level `await` of its
      // own, runs as an async function. Either way its settling is what its
      // importers await.
      let bodyKind: 'sync' | 'generator' | 'async' = code.includes(__substrateTopLevelAwaitMarker) ? 'async' : code.includes(__substrateAwaitMarker) ? 'generator' : 'sync';
      let fn;
      __substrateLoadPhase(process, vfs, 'compile');
      try {
        fn = __substrateCompileBody(bodyKind === 'generator' ? __substrateGeneratorBody(wrappedCode) : bodyKind === 'async' ? __substrateAsyncBody(wrappedCode) : wrappedCode, process);
      } catch (evalError) {
        const msg = evalError instanceof Error ? evalError.message : String(evalError);
      // A module with top-level await runs. Node runs a `.js` file of a package
      // with `"type": "module"` as a module, where `await` is valid at the top;
      // a module lowered to a function body made V8 refuse vue3-ssr's server at
      // its first top-level `await`. A body V8 refuses for that reason runs as
      // an async function body instead.
        if (!(evalError instanceof SyntaxError)) throw evalError;
        bodyKind = 'async';
        try { fn = __substrateCompileBody(__substrateAsyncBody(wrappedCode), process); }
        catch { throw new SyntaxError(`${msg} (in ${resolvedPath})`); }
      }
      __substrateLoadPhase(process, vfs, 'link');
      // Create dynamic import function for this module context
      const dynamicImport = createDynamicImport(moduleRequire, process, importMetaUrl);
      const importMeta = createImportMeta(moduleRequire, importMetaUrl, dirname, resolvedPath);

      __substrateLoadPhase(process, vfs, 'evaluate');
      const body = __substrateInStatWindow(process, () => withGuestExecution(() => fn(
        module.exports,
        moduleRequire,
        module,
        resolvedPath,
        dirname,
        process,
        consoleWrapper,
        importMeta,
        dynamicImport,
        __substrateGuestGlobal,
        __substrateGuestConstructor
      )));

      const settling = __substrateDriveBody(bodyKind, body, module);
      if (settling) __substrateKeepPending(module, settling, () => { delete moduleCache[resolvedPath]; });
      else module.loaded = true;
    } catch (error) {
      // Remove from cache on error
      delete moduleCache[resolvedPath];
      // Enhance runtime errors with the module path for easier debugging
      // A module error names the module it happened in and, as it climbs, each
      // module that required it, the way Node prints a require stack; the engine
      // named the innermost alone, so a native module deep in a tree could not
      // say which package had asked for it.
      if (error instanceof Error) {
        if (!error.message.includes('(in /')) error.message = `${error.message} (in ${resolvedPath})`;
        else if (!error.message.includes(`\n  required by ${resolvedPath}`)) error.message = `${error.message}\n  required by ${resolvedPath}`;
      }
      throw error;
    }
  };

  const require: RequireFunction = (id: string): unknown => {
    const Module = __substrateModule();
    if (Module.prototype.require !== Module.__substrateRequire) {
      return Module.prototype.require.call(parentModule || { id: currentDir, filename: currentDir + '/', paths: [] }, id);
    }
    // A program that replaced `Module._load` sees every require from here on,
    // as it would in Node; with the engine's own still in place, the fast
    // path below is the whole of a require, as it is for `_resolveFilename`.
    if (Module._load !== Module.__substrateLoad) {
      const keeping = __substrateKeptFor(process);
      keeping.depth += 1;
      try { return Module._load(id, parentModule || { id: currentDir, filename: currentDir + '/', paths: [] }, false); } finally { keeping.depth -= 1; }
    }
    return requireRaw(id);
  };
  /**
   * A require through the hooks this run registered, and, where it has
   * registered none, the require the engine has always done.
   *
   * Node resolves a request before it decides whether the request names a
   * builtin (`Module._load` calls `resolveForCJSWithHooks` first), so a
   * resolve hook can send `require("zlib")` to a file on disk and a load hook
   * can replace a builtin's source. Node keeps a fast path for the ordinary
   * case and so does this: with no hook registered, `requirePlain` is the
   * whole of a require and nothing below it runs.
   */
  // Node's `Module.prototype.require` counts the calls in flight (`requireDepth`); the count is the process's.
  const requireRaw = (id: string): unknown => {
    const keeping = __substrateKeptFor(process);
    keeping.depth += 1;
    const phase = __substrateLoadPhase(process, vfs, 'resolve');
    try { return requireCounted(id); } finally { keeping.depth -= 1; __substrateLoadPhase(process, vfs, phase); }
  };
  const requireCounted = (id: string): unknown => {
    // A data: URL is a module of its own, loaded at that URL.
    if (id.startsWith('data:')) return loadModule(id).exports;
    // A hook is handed the specifier as it was written, `node:` prefix and
    // all: the prefix is stripped for the engine's own lookup and nowhere
    // else, which is the rule Node states in its own test -- "the one with
    // the prefix stripped for internal lookups should not get passed into
    // the hooks". A hook that answers `node:assert` never saw it otherwise.
    // Only the synchronous chain: a hook installed with `module.register` is
    // Node's ESM customization and does not apply to a `require` there
    // either, so a run that registered one alone resolves exactly as it did.
    const hooks = __substrateHooks();
    if (hooks && (hooks.hasSyncResolve || hooks.hasSyncLoad)) return requireHooked(id, hooks);
    // Handle node: protocol prefix (Node.js 16+)
    if (id.startsWith('node:')) {
      id = id.slice(5);
    }
    return requirePlain(id);
  };

  /**
   * A name the engine answers with a module of its own rather than a file:
   * Node's builtins, and the packages the engine stands in for. Handing one
   * to the file resolver would look for a file that is not there.
   */
  const __substrateNamedModule = (specifier: string): string | undefined => {
    const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (moduleShim.isBuiltin(name) || name === 'fs/promises') return name;
    if (Object.prototype.hasOwnProperty.call(builtinModules, name) && !__substrateInstalledWins(name)) return name;
    return void 0;
  };

  const requireHooked = (id: string, hooks: RunModuleHooks): unknown => {
    let defaultURL: string | undefined;
    let defaultFilename: string | undefined;
    // The bottom of the chain: the engine's own resolution, in the URL terms
    // a hook speaks. A builtin keeps its name, as Node's `defaultResolveImpl`
    // returns the normalized id rather than a path.
    const defaultResolve = (specifier: string): { url: string } => {
      defaultFilename = __substrateNamedModule(specifier) ?? __substrateResolve(specifier);
      defaultURL = hooks.sync.convertCJSFilenameToURL(defaultFilename);
      return { url: defaultURL };
    };
    const parent = parentModule && typeof parentModule.filename === 'string' && parentModule.filename
      ? hooks.sync.convertCJSFilenameToURL(parentModule.filename)
      : void 0;
    const resolved = hooks.hasSyncResolve
      ? hooks.sync.resolveWithHooks(id, parent, void 0, CJS_CONDITIONS, defaultResolve)
      : defaultResolve(id);
    const url = resolved.url;
    const format = (resolved as { format?: string }).format;
    const filename = url === defaultURL ? defaultFilename! : hooks.sync.convertURLToCJSFilename(url);

    // A builtin still goes through the load chain, as Node's
    // `loadBuiltinWithHooks` runs it, and the source a hook returns for one is
    // ignored -- unless the hook also moved the format off `builtin`, which is
    // how a program puts a file of its own in a builtin's place.
    if (moduleShim.isBuiltin(filename)) {
      if (hooks.hasSyncLoad) {
        const loaded = hooks.sync.loadWithHooks(url, format || 'builtin', void 0, CJS_CONDITIONS, (_urlFromHook, context) => ({ source: null, format: context.format }));
        if (loaded.format && loaded.format !== 'builtin') {
          return loadModule(filename, { url, format: loaded.format, source: loaded.source }).exports;
        }
      }
      return requirePlain(filename);
    }
    // Nothing moved: the engine's own require, with every stand-in and
    // installed-package rule it carries. The load chain runs inside loadModule.
    if (url === defaultURL && format === undefined) return requirePlain(id);
    return loadModule(filename, { url, format }).exports;
  };

  /**
   * Node appends each builtin a process loads to `process.moduleLoadList`, in
   * the order it first loaded each, and a program reads that list to tell
   * whether a module is already in memory. The engine answers a builtin from a
   * table rather than compiling one, so the record is made here, where the
   * name is first answered.
   */
  const __substrateRecordBuiltin = (id: string): void => {
    const list = (process as unknown as { moduleLoadList?: string[] }).moduleLoadList;
    if (!Array.isArray(list)) return;
    const entry = `NativeModule ${id}`;
    if (!list.includes(entry)) list.push(entry);
  };

  const requirePlain = (id: string): unknown => {
    // Handle node: protocol prefix (Node.js 16+)
    if (id.startsWith('node:')) {
      id = id.slice(5);
    }
    // A data: URL is a module of its own, loaded at that URL.
    if (id.startsWith('data:')) return loadModule(id).exports;
    if (moduleShim.isBuiltin(id)) __substrateRecordBuiltin(id);

    // Built-in modules
    if (id === 'fs') {
      return fsModuleFor(process);
    }
    if (id === 'fs/promises') {
      return (fsModuleFor(process) as { promises: unknown }).promises;
    }
    if (id === 'internal/fs/promises') {
      return (fsModuleFor(process) as { promises: unknown }).promises;
    }
    if (id === 'process') {
      return process;
    }
    // Worker threads run where a thread host is installed, a worker the
    // page owns per thread; the shim alone refuses to run one. The host
    // registers itself under this symbol and answers the module for a guest.
    if (id === 'worker_threads') {
      const bridge = (globalThis as Record<symbol, unknown>)[Symbol.for("@volter/browser-node/threads")] as { module?: (vfs: VirtualFS, process: unknown, shim: unknown) => unknown } | undefined;
      const module = bridge && typeof bridge.module === "function" ? bridge.module(vfs, process, builtinModules.worker_threads) : undefined;
      return guestMessageModule(process, (module ?? workerThreadsShim) as Record<string, unknown>, !module);
    }
    if (id === 'module') {
      return __substrateModule();
    }
    // Ahead of the per-process builtin table: node-lib's own modules require
    // `vm` first and that table keeps the first answer for the process.
    if (id === 'vm') {
      return __substrateGuestVm(process);
    }
    if (id === 'wasi') {
      return __substrateGuestWasi(fsShim, process);
    }
    if (id === 'stream/consumers') return nativeModuleFor(process, id, () => {
      const table: Record<string, any> = {};
      __browserRuntimeFillStreams(table, loadNodeLibFor(process, 'buffer').Buffer);
      return table[id];
    });
    if (hasNodeLibModule(id)) return loadNodeLibFor(process, id);
    if (builtinModules[id] && !__substrateInstalledWins(id) && !(id === 'fsevents' || id === 'chokidar' || id === 'readdirp')) {
      return id === 'esbuild' ? __substrateGuestEsbuild(process) : id === 'rollup' ? __substrateGuestRollup(process) : nativeModuleFor(process, id, () => builtinModules[id]);
    }

    if (!__substrateInstalledWins(id)) {
      // Intercept rollup and esbuild - always use our shims
      // These packages have native binaries that don't work in browser
      if (id === 'rollup' || id.startsWith('rollup/') || id.startsWith('@rollup/rollup-')) {
        console.log('[runtime] Intercepted rollup:', id);
        return __substrateGuestRollup(process);
      }
      if (id === 'esbuild' || id.startsWith('esbuild/') || id.startsWith('@esbuild/')) {
        console.log('[runtime] Intercepted esbuild:', id);
        return __substrateGuestEsbuild(process);
      }
      // Intercept prettier - uses createRequire which doesn't work in our runtime
      if (id === 'prettier' || id.startsWith('prettier/')) {
        return builtinModules['prettier'];
      }
    }
    const resolved = __substrateResolve(id);

    // If resolved to a built-in name (shouldn't happen but safety check)
    if (builtinModules[resolved] && !(resolved === 'fsevents' || resolved === 'chokidar' || resolved === 'readdirp')) {
      return requirePlain(resolved);
    }

    // Also check if resolved path is to rollup, esbuild, or prettier in node_modules
    if (resolved.includes('/node_modules/rollup/') ||
        resolved.includes('/node_modules/@rollup/rollup-')) {
      return __substrateGuestRollup(process);
    }
    if ((resolved.includes('/node_modules/esbuild/') ||
        resolved.includes('/node_modules/@esbuild/')) && !__substrateEsbuildRunsHere(vfs, resolved)) {
      return __substrateGuestEsbuild(process);
    }
    if (resolved.includes('/node_modules/prettier/')) {
      return builtinModules['prettier'];
    }

    // A page that can run a package's native side in the browser -- Rolldown's
    // wasm binding is the one that does -- registers it on the filesystem the
    // package is installed in, under this symbol: a map from the installed
    // export file to the module to answer with, made for the process that is
    // asking. Nothing else about the package changes: it is resolved the
    // installed way, so `require.resolve` still names the file on disk and its
    // manifest still says the version; a filesystem with no registration, and
    // an export path the registration does not name, load the file as before.
    // The registry was a text patch over the engine's build, which read the
    // same symbol at the same point; a guest that required the package on an
    // unpatched build got the installed stub instead of the binding, and every
    // filesystem in the tab shared whichever binding was loaded last.
    const registered = (vfs as unknown as Record<symbol, unknown>)[__substrateNativeModules] as
      | Map<string, (process: unknown) => unknown>
      | undefined;
    if (registered && typeof registered.has === 'function') {
      if (registered.has(resolved)) return registered.get(resolved)!(process);
      // A registration by package identity, `pkg:<name>@<version>/<file>`,
      // answers every copy of that version in the tree: a nested copy under
      // another package, or one pnpm placed in its store, is the same package.
      const identity = __substratePackageIdentity(vfs, resolved);
      if (identity && registered.has(identity)) return registered.get(identity)!(process);
    }

    return loadModule(resolved).exports;
  };

  require.resolve = (id: string, options?: { paths?: unknown }): string => {
    if (id === 'fs' || id === 'process' || id.startsWith('node:') || moduleShim.builtinModules.includes(id)) {
      return id;
    }
    // Node's `options.paths`: each directory, in order, is where the lookup starts, as if the request came from a
    // module there, and the first that resolves wins. The option was ignored and every lookup started at the caller,
    // so a module installed in one tree could not find a package another tree holds (a World's injector resolving
    // the application's own Prisma adapter from the application's directory). Node 12.
    if (options && options.paths !== undefined) {
      if (!Array.isArray(options.paths)) {
        throw Object.assign(new TypeError(`The property 'options.paths' must be an Array. Received ${String(options.paths)}`), { code: 'ERR_INVALID_ARG_VALUE' });
      }
      options.paths.forEach((from, index) => {
        if (typeof from !== 'string') throw Object.assign(new TypeError(`The "paths[${index}]" argument must be of type string. Received ${typeof from}`), { code: 'ERR_INVALID_ARG_TYPE' });
      });
      // A relative entry is the process's working directory's, as Node's Module._resolveFilename makes it.
      const requireStack = parentModule && typeof parentModule.filename === 'string' ? [parentModule.filename] : [];
      for (const from of options.paths as string[]) {
        try { return resolveModule(id, pathShim.resolve(process.cwd(), from)); } catch { /* the next directory */ }
      }
      throw Object.assign(new Error(`Cannot find module '${id}'${requireStack.length ? `\nRequire stack:\n- ${requireStack.join('\n- ')}` : ''}`), { code: 'MODULE_NOT_FOUND', requireStack });
    }
    return resolveModule(id, currentDir);
  };
  // Node's `require.resolve.paths(request)` (lib/internal/modules/helpers.js makeRequireFunction, over
  // Module._resolveLookupPaths): the directories a lookup of `request` from this module would search. Null for a
  // builtin; for a relative request the requiring module's own directory; otherwise each node_modules above it.
  // Every require the engine makes is made here (a module's own, `createRequire`'s), so each has it: ts-node reads
  // it on a require from `createRequire` before it resolves anything ("req.resolve.paths is not a function").
  (require.resolve as unknown as { paths: (request: string) => string[] | null }).paths = (request: string): string[] | null => {
    if (typeof request !== 'string') throw Object.assign(new TypeError(`The "request" argument must be of type string. Received ${request === null ? 'null' : typeof request}`), { code: 'ERR_INVALID_ARG_TYPE' });
    if (request === 'fs' || request === 'process' || request.startsWith('node:') || moduleShim.builtinModules.includes(request)) return null;
    const second = request.charAt(1);
    const relative = request.charAt(0) === '.' && (request.length === 1 || second === '/' || (second === '.' && (request.length === 2 || request.charAt(2) === '/')));
    if (relative) return [currentDir];
    return __substrateModule()._nodeModulePaths(currentDir);
  };

  require.cache = moduleCache;
  (require as any).__requireRaw = requireRaw;
  // What `Module._load` is: a load that is not a `require` call and so is not counted as one.
  (require as any).__loadRaw = requireCounted;
  (require as any).__compileRaw = compileRaw;
  (require as any).__builtinLoad = builtinLoad;
  (require as any).__resolveRaw = (id: string) => resolveModule(id, currentDir);
  // The doors `module.register`'s chain reaches this loader through: the run's
  // hooks, the engine's own resolution in the URL terms a hook speaks, the
  // read that is the bottom of a load chain, and the load of a module whose
  // URL, format and source the chain has already settled.
  (require as any).__moduleHooks = __substrateHooks;
  (require as any).__resolveToURL = (specifier: string): string => {
    const hooks = __substrateHooks()!;
    return hooks.sync.convertCJSFilenameToURL(__substrateNamedModule(specifier) ?? __substrateResolve(specifier));
  };
  (require as any).__readFromURL = (url: string): string | null => {
    // A builtin has no source of its own, and Node's default load answers null
    // for one rather than reading a file named after it.
    if (url.startsWith('node:')) return null;
    if (url.startsWith('data:')) return __substrateDataModuleSource(url)!;
    return vfs.readFileSync(__substrateHooks()!.sync.convertURLToCJSFilename(url), 'utf8');
  };
  (require as any).__loadFromURL = (url: string, format?: string, source?: string | ArrayBuffer | ArrayBufferView | null): unknown => {
    if (url.startsWith('data:')) return loadModule(url, { url, format, source }).exports;
    const filename = __substrateHooks()!.sync.convertURLToCJSFilename(url);
    if (source === undefined && moduleShim.isBuiltin(filename)) return requirePlain(filename);
    return loadModule(filename, { url, format, source }).exports;
  };
  (require as any).extensions = __substrateModule()._extensions;
  Object.defineProperty(require, 'main', { get: () => (process as any).mainModule, set: (value: unknown) => { (process as any).mainModule = value; }, enumerable: true, configurable: true });

  // A bundle built for Node reaches its builtins through
  // `process.getBuiltinModule("node:http")` rather than a static import, so that
  // one call is the first thing it makes of the engine; the guest process had no
  // such method and the bundle died on its first line. It answers the engine's
  // own module for a builtin name with or without the `node:` prefix, and
  // undefined for a name that is not a builtin, as Node does.
  if (process && typeof process === 'object' && typeof (process as GuestProcess).getBuiltinModule !== 'function') {
    (process as GuestProcess).getBuiltinModule = (name: string) => {
      if (typeof name !== 'string') return void 0;
      const id = name.startsWith('node:') ? name.slice(5) : name;
      if (id !== 'fs' && id !== 'fs/promises' && id !== 'process' && id !== 'module' && id !== 'wasi' && !Object.prototype.hasOwnProperty.call(builtinModules, id)) return void 0;
      try { return require(id); } catch (error) { return void 0; }
    };
  }

  return require;
}

/**
 * Create a console wrapper that can capture output
 */
function createConsoleWrapper(
  onConsole?: (method: string, args: unknown[]) => void
): Console {
  const wrapper = {
    log: (...args: unknown[]) => {
      console.log(...args);
      onConsole?.('log', args);
    },
    error: (...args: unknown[]) => {
      console.error(...args);
      onConsole?.('error', args);
    },
    warn: (...args: unknown[]) => {
      console.warn(...args);
      onConsole?.('warn', args);
    },
    info: (...args: unknown[]) => {
      console.info(...args);
      onConsole?.('info', args);
    },
    debug: (...args: unknown[]) => {
      console.debug(...args);
      onConsole?.('debug', args);
    },
    trace: (...args: unknown[]) => {
      console.trace(...args);
      onConsole?.('trace', args);
    },
    dir: (obj: unknown) => {
      console.dir(obj);
      onConsole?.('dir', [obj]);
    },
    time: console.time.bind(console),
    timeEnd: console.timeEnd.bind(console),
    timeLog: console.timeLog.bind(console),
    assert: console.assert.bind(console),
    clear: console.clear.bind(console),
    count: console.count.bind(console),
    countReset: console.countReset.bind(console),
    group: console.group.bind(console),
    groupCollapsed: console.groupCollapsed.bind(console),
    groupEnd: console.groupEnd.bind(console),
    table: console.table.bind(console),
  };

  return wrapper as unknown as Console;
}

/**
 * Runtime class for executing code in virtual environment
 * Note: This class has sync methods for backward compatibility.
 * Use createRuntime() factory for IRuntime interface compliance.
 */
export class Runtime {
  private vfs: VirtualFS;
  private fsShim: FsShim;
  private process: Process;
  private moduleCache: Record<string, Module> = {};
  private options: RuntimeOptions;
  /** Cache for pre-processed code (after ESM transform) before eval */
  private processedCodeCache: Map<string, string> = new Map();

  constructor(vfs: VirtualFS, options: RuntimeOptions = {}) {
    this.vfs = vfs;
    // Create process first so we can get cwd for fs shim
    this.process = createProcess({
      cwd: options.cwd || '/',
      env: options.env,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      ...(options.onStdoutBytes ? { onStdoutBytes: options.onStdoutBytes } : {}),
      ...(options.onStderrBytes ? { onStderrBytes: options.onStderrBytes } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.stdinHeld ? { stdinHeld: true } : {}),
      ...(options.tty ? { tty: options.tty } : {}),
      ...(typeof options.pid === 'number' ? { pid: options.pid } : {}),
      ...(typeof options.ppid === 'number' ? { ppid: options.ppid } : {}),
    });
    // The filesystem of this run, on this run's own process. Node's `fs` is
    // one module for the whole engine and the engine holds one tree per run,
    // so the binding reads the tree off the process whose code is executing --
    // the same door every vendored file gets its `process` through.
    (this.process as unknown as Record<symbol, unknown>)[kRunFilesystem] = vfs;
    // The Node line this process answers as, and where it came from (node-line.ts).
    const namedVersion = options.env?.NODE_VERSION;
    console.log('[boot-trace]', JSON.stringify({ event: 'node-line', at: Date.now(), pid: this.process.pid ?? null, version: this.process.version,
      line: nodeLineOf(this.process.version), from: this.process.version === `v${String(namedVersion ?? '').replace(/^v/, '')}` ? 'NODE_VERSION of the image' : 'default',
      // The variable as this process was given it, so a reader need not infer it: null when it has none.
      env: typeof namedVersion === 'string' ? namedVersion : null }));
    // Create fs shim with cwd getter for relative path resolution
    this.fsShim = createFsShim(vfs, () => this.process.cwd());
    this.options = options;
    // Node's `process.dlopen(module, filename[, flags])`, which a loader calls
    // in place of `require` when it wants its own flags: Prisma's library
    // engine loads `libquery_engine-*.node` this way. A tab runs no native
    // code, so the load is the one a `require` of that path makes: through
    // the run's resolve hooks, where an image's binding map answers the
    // addon with its prepared export, and otherwise to ERR_DLOPEN_FAILED as
    // Node's dlopen fails. The flags name dynamic-linker modes and have
    // nothing to act on here.
    Object.defineProperty(this.process, 'dlopen', {
      configurable: true, enumerable: true, writable: true,
      value: (target: { exports?: unknown }, filename: string, _flags?: number): void => {
        if (target === null || typeof target !== 'object') {
          throw Object.assign(new TypeError('The "module" argument must be of type object'), { code: 'ERR_INVALID_ARG_TYPE' });
        }
        if (typeof filename !== 'string') {
          throw Object.assign(new TypeError('The "filename" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' });
        }
        const file = pathShim.resolve(this.process.cwd(), filename);
        const load = createRequire(this.vfs, this.fsShim, this.process, pathShim.dirname(file), this.moduleCache, this.options, this.processedCodeCache);
        try {
          target.exports = load(file);
        } catch (error) {
          // Node's dlopen of a missing file fails as the dynamic linker
          // reports it (the engine is linux to its guests), under
          // ERR_DLOPEN_FAILED, which loaders read; require's MODULE_NOT_FOUND
          // is a different failure. An addon that exists and cannot load
          // already fails as ERR_DLOPEN_FAILED, and a prepared refusal keeps
          // its own named reason.
          if ((error as { code?: unknown } | null)?.code !== 'MODULE_NOT_FOUND') throw error;
          throw Object.assign(new Error(file + ': cannot open shared object file: No such file or directory'), { code: 'ERR_DLOPEN_FAILED' });
        }
      },
    });

    // Initialize child_process with VFS for bash command support
    initChildProcess(vfs);

    // Initialize file watcher shims with VFS

    // Initialize esbuild shim with VFS for file access
    esbuildShim.setVFS(vfs);

    // The realm's own corrections — the ones a guest can only reach through
    // the realm — are installed here, when a guest is first asked for, and
    // not when this module is loaded. Importing the engine into someone
    // else's Node process leaves that process's globals alone;
    // `restoreHostGlobals()` hands back what a runtime took.
    startGuestLoop();
    installGuestRealm();
  }

  /**
   * Execute code as a module (synchronous - backward compatible)
   */
  execute(
    code: string,
    filename: string = '/index.js'
  ): { exports: unknown; module: Module } {
    // The tree holds the file the run names; it is written only when the
    // text differs. Every run wrote it, and a file run as it stands in the
    // tree was rewritten with itself, which fired its watcher (a dev server
    // watching the project restarted on its own entry being run) and
    // touched its mtime for nothing.
    let held: string | undefined;
    try { held = this.vfs.readFileSync(filename, 'utf8') as string; } catch { held = undefined; }
    if (held !== code) this.vfs.writeFileSync(filename, code);
    return this.evaluate(code, filename);
  }

  /**
   * Runs source that is not a file of the tree -- `node -e`'s, named
   * `[eval]` in the directory it runs in, as Node names it -- the way
   * `execute` runs a file's, without writing it anywhere.
   */
  evaluate(
    code: string,
    filename: string
  ): { exports: unknown; module: Module } {
    const dirname = pathShim.dirname(filename);

    // Create require function
    const require = createRequire(
      this.vfs,
      this.fsShim,
      this.process,
      dirname,
      this.moduleCache,
      this.options,
      this.processedCodeCache
    );

    // Create module object
    const module: Module = {
      id: filename,
      filename,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
    };
    // The entry is an instance of Module too (see loadModule).
    const moduleClass = require('module') as { prototype: object; _nodeModulePaths(directory: string): string[] };
    Object.setPrototypeOf(module, moduleClass.prototype);
    (module as Module & { path: string }).path = dirname;
    module.paths = moduleClass._nodeModulePaths(dirname);

    // Cache the module
    this.moduleCache[filename] = module;
    // The entry module is the main module: `process.mainModule` and
    // `require.main` name it, and its id is ".", as Node has them, so a program
    // that runs only when it is the entry (`require.main === module`, which the
    // Prisma CLI and every bin script written that way tests) runs.
    if (!(this.process as any).mainModule) {
      (this.process as any).mainModule = module;
      module.id = '.';
    }

    // Create console wrapper
    const consoleWrapper = createConsoleWrapper(this.options.onConsole);

    // Transform code the same way loadModule does
    // Strip shebang line if present (e.g. #!/usr/bin/env node)
    if (code.startsWith('#!')) {
      code = code.slice(code.indexOf('\n') + 1);
    }

    code = __substrateModuleTypes(code, filename, undefined, this.process);

    // Transform ESM to CJS if needed (AST-based, handles import.meta and dynamic imports too)
    if (!filename.endsWith('.cjs') && !filename.endsWith('.cts')) {
      const lowered = transformEsmToCjs(code, filename);
      // The directive shares the body's first line, as `prepareModuleCode`'s does.
      code = lowered === code ? code : `${__substrateModuleMarker}"use strict";${lowered}`;
    } else {
      // A `.cjs` module skips the ESM transform, and with it the rewrite of
      // `import(...)` to the engine's dynamic import, so its
      // `import("fs/promises")` reached the browser's own import and failed on
      // the bare specifier. The dynamic-import rewrite applies to `.cjs` too,
      // from the syntax tree as for every other CommonJS module: the text
      // rewrite also renamed a method called `import`, and jiti's
      // `async import(e,t){...}` became `__dynamicImport`, so `jiti.import` was
      // undefined and every Pi extension failed to load.
      code = __substrateRewriteDynamicImportsInScript(code);
    }

    // Execute code
    // Use the same wrapper pattern as loadModule for consistency
    try {
      const importMetaUrl = 'file://' + filename;
      const strictBody = code.startsWith(__substrateModuleMarker);
      code = __substrateScopeGlobalCalls(code);
      // The wrapper is one line and the body begins on it, as Node's
      // `Module.wrap` is one line, so a module's line N is line N of the
      // script V8 compiles and a stack names the module's own lines. The
      // header's `var` statements are the module's scope, `globalThis` and
      // `global` among them for code that reads the process off them
      // directly; the inner function is what lets the body's own `let` and
      // `const` shadow that scope. `__substrateSourceURL` names the script.
      const wrappedCode = `(function($exports, $require, $module, $filename, $dirname, $process, $console, $importMeta, $dynamicImport, __substrateGuestGlobal, __substrateGuestConstructor) { var exports = $exports; var require = $require; var module = $module; var __filename = $filename; var __dirname = $dirname; var process = $process; var console = $console; var import_meta = $importMeta; var __dynamicImport = $dynamicImport; var globalThis = __substrateGuestGlobal($process); var global = globalThis; var Buffer = globalThis.Buffer; var queueMicrotask = globalThis.queueMicrotask, atob = globalThis.atob, btoa = globalThis.btoa, structuredClone = globalThis.structuredClone, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval; globalThis.process = $process; global.process = $process; with ({ __proto__: null, get MessageChannel() { return globalThis.MessageChannel; }, set MessageChannel(value) { globalThis.MessageChannel = value; }, get MessagePort() { return globalThis.MessagePort; }, set MessagePort(value) { globalThis.MessagePort = value; }, get Worker() { return globalThis.Worker; }, set Worker(value) { globalThis.Worker = value; }, get self() { return globalThis.self; }, set self(value) { globalThis.self = value; }, get postMessage() { return globalThis.postMessage; }, set postMessage(value) { globalThis.postMessage = value; }, get onmessage() { return globalThis.onmessage; }, set onmessage(value) { globalThis.onmessage = value; }, get onmessageerror() { return globalThis.onmessageerror; }, set onmessageerror(value) { globalThis.onmessageerror = value; }, get close() { return globalThis.close; }, set close(value) { globalThis.close = value; }, get addEventListener() { return globalThis.addEventListener; }, set addEventListener(value) { globalThis.addEventListener = value; }, get removeEventListener() { return globalThis.removeEventListener; }, set removeEventListener(value) { globalThis.removeEventListener = value; }, get dispatchEvent() { return globalThis.dispatchEvent; }, set dispatchEvent(value) { globalThis.dispatchEvent = value; }, get navigator() { return globalThis.navigator; }, set navigator(value) { globalThis.navigator = value; }, get Navigator() { return globalThis.Navigator; }, set Navigator(value) { globalThis.Navigator = value; }, get Promise() { return globalThis.Promise; }, set Promise(value) { globalThis.Promise = value; }, get fetch() { return globalThis.fetch; }, set fetch(value) { globalThis.fetch = value; }, get window() { return globalThis.window; }, set window(value) { globalThis.window = value; }, get document() { return globalThis.document; }, set document(value) { globalThis.document = value; }, get location() { return globalThis.location; }, set location(value) { globalThis.location = value; }, get performance() { return globalThis.performance; }, set performance(value) { globalThis.performance = value; } }) { return (function() {${code}
}).call(${strictBody ? 'void 0' : '$module.exports'}); }
})${__substrateSourceURL(filename)}`;

      // Create dynamic import function for this module context
      const dynamicImport = createDynamicImport(require, this.process, filename.startsWith('data:') ? filename : `file://${filename}`);

      // A module with top-level await runs. Node runs a `.js` file of a package
      // with `"type": "module"` as a module, where `await` is valid at the top;
      // a module lowered to a function body made V8 refuse vue3-ssr's server at
      // its first top-level `await`. A body V8 refuses for that reason runs as
      // an async function body instead.
      let bodyKind: 'sync' | 'generator' | 'async' = code.includes(__substrateTopLevelAwaitMarker) ? 'async' : code.includes(__substrateAwaitMarker) ? 'generator' : 'sync';
      let fn;
      try {
        fn = __substrateCompileBody(bodyKind === 'generator' ? __substrateGeneratorBody(wrappedCode) : bodyKind === 'async' ? __substrateAsyncBody(wrappedCode) : wrappedCode, this.process);
      } catch (syntaxError) {
        if (!(syntaxError instanceof SyntaxError)) throw syntaxError;
        bodyKind = 'async';
        try { fn = __substrateCompileBody(__substrateAsyncBody(wrappedCode), this.process); }
        catch { throw syntaxError; }
      }
      const body = __substrateInStatWindow(this.process, () => withGuestExecution(() => fn(
        module.exports,
        require,
        module,
        filename,
        dirname,
        this.process,
        consoleWrapper,
        createImportMeta(require, importMetaUrl, dirname, filename),
        dynamicImport,
        __substrateGuestGlobal,
        __substrateGuestConstructor
      )));

      const settling = __substrateDriveBody(bodyKind, body, module);
      if (settling) __substrateKeepPending(module, settling, () => { delete this.moduleCache[filename]; });
      else module.loaded = true;
    } catch (error) {
      delete this.moduleCache[filename];
      throw error;
    }

    return { exports: module.exports, module };
  }

  /**
   * Execute code as a module (async version for IRuntime interface)
   * Alias: executeSync() is the same as execute() for backward compatibility
   */
  executeSync = this.execute;

  /**
   * Execute code as a module (async - for IRuntime interface)
   */
  async executeAsync(
    code: string,
    filename: string = '/index.js'
  ): Promise<IExecuteResult> {
    const result = this.execute(code, filename);
    const pending = __substratePendingOf(result.exports);
    if (pending) await pending;
    return result;
  }

  /**
   * Run a file from the virtual file system (synchronous - backward compatible)
   */
  runFile(filename: string): { exports: unknown; module: Module } {
    // An entry runs at its real path, as Node runs one: Node resolves an
    // entry's symlinks before loading it (unless --preserve-symlinks), so a
    // program run through its `.bin` link reads its relative imports and its
    // package's `type` from where the file is. Run at the link, paraglide's
    // `.bin` entry resolved `../lib` beside `.bin` and found nothing.
    let real = filename;
    try { real = this.vfs.realpathSync(filename) as string; } catch { /* the read below reports it */ }
    // File entries take the same prepared-body and main-module path as require.
    // Evaluating raw source here recompiled worker dependencies in the tab.
    const require = createRequire(this.vfs, this.fsShim, this.process,
      pathShim.dirname(real), this.moduleCache, this.options, this.processedCodeCache);
    if (!(this.process as any).mainModule) (this.process as any).__substrateMainPending = real;
    // Node starts its entry through `Module._load`, not through a `require` call, so the entry's body runs at depth 0.
    const exports = (require as unknown as { __loadRaw(id: string): unknown }).__loadRaw(real);
    return { exports, module: this.moduleCache[real] };
  }

  /**
   * Alias for runFile (backward compatibility)
   */
  runFileSync = this.runFile;

  /**
   * Run a file from the virtual file system (async - for IRuntime interface)
   */
  async runFileAsync(filename: string): Promise<IExecuteResult> {
    const result = this.runFile(filename);
    // An entry still settling, a top-level `await` in it or in what it
    // imports, has run when it has settled.
    const pending = __substratePendingOf(result.exports);
    if (pending) await pending;
    return result;
  }

  /**
   * Clear the module cache
   */
  clearCache(): void {
    // Clear contents in-place so closures that captured the reference still see the cleared cache
    for (const key of Object.keys(this.moduleCache)) {
      delete this.moduleCache[key];
    }
  }

  /**
   * Get the virtual file system
   */
  getVFS(): VirtualFS {
    return this.vfs;
  }

  /**
   * Get the process object
   */
  getProcess(): Process {
    return this.process;
  }

  /**
   * Create a REPL context that evaluates expressions and persists state.
   *
   * Returns an object with an `eval` method that:
   * - Returns the value of the last expression (unlike `execute` which returns module.exports)
   * - Persists variables between calls (`var x = 1` then `x` works)
   * - Has access to `require`, `console`, `process`, `Buffer` (same as execute)
   *
   * Security: The eval runs inside a Generator's local scope via direct eval,
   * NOT in the global scope. Only the runtime's own require/console/process are
   * exposed — the same sandbox boundary as execute(). Variables created in the
   * REPL are confined to the generator's closure and cannot leak to the page.
   *
   * Note: `const`/`let` are transformed to `var` so they persist across calls
   * (var hoists to the generator's function scope, const/let are block-scoped
   * to each eval call and would be lost).
   */
  createREPL(): { eval: (code: string) => unknown } {
    const require = createRequire(
      this.vfs,
      this.fsShim,
      this.process,
      '/',
      this.moduleCache,
      this.options,
      this.processedCodeCache
    );
    const consoleWrapper = createConsoleWrapper(this.options.onConsole);
    const process = this.process;
    const buffer = bufferShim.Buffer;

    // Use a Generator to maintain a persistent eval scope.
    // Generator functions preserve their local scope across yields, so
    // var declarations from eval() persist between calls. Direct eval
    // runs in the generator's scope (not global), providing isolation.
    const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
    const replGen = new GeneratorFunction(
      'require',
      'console',
      'process',
      'Buffer',
      `var __code, __result;
while (true) {
  __code = yield;
  try {
    __result = eval(__code);
    yield { value: __result, error: null };
  } catch (e) {
    yield { value: undefined, error: e };
  }
}`
    )(require, consoleWrapper, process, buffer);
    replGen.next(); // prime the generator

    return {
      eval(code: string): unknown {
        // Transform const/let to var for persistence across REPL calls.
        // var declarations in direct eval are added to the enclosing function
        // scope (the generator), so they survive across yields.
        const transformed = code.replace(/^\s*(const|let)\s+/gm, 'var ');

        // Try as expression first (wrapping in parens), fall back to statement.
        // replGen.next(code) sends code to the generator, which evals it and
        // yields the result — so the result is in the return value of .next().
        const exprResult = replGen.next('(' + transformed + ')').value as { value: unknown; error: unknown };
        if (!exprResult.error) {
          // Advance past the wait-for-code yield so it's ready for next call
          replGen.next();
          return exprResult.value;
        }

        // Expression parse failed — advance past wait-for-code, then try as statement
        replGen.next();
        const stmtResult = replGen.next(transformed).value as { value: unknown; error: unknown };
        if (stmtResult.error) {
          replGen.next(); // advance past wait-for-code yield
          throw stmtResult.error;
        }
        replGen.next(); // advance past wait-for-code yield
        return stmtResult.value;
      },
    };
  }
}

/**
 * Create and execute code in a new runtime (synchronous - backward compatible)
 */
export function execute(
  code: string,
  vfs: VirtualFS,
  options?: RuntimeOptions
): { exports: unknown; module: Module } {
  const runtime = new Runtime(vfs, options);
  return runtime.execute(code);
}

// Re-export types
export type { IRuntime, IExecuteResult, IRuntimeOptions } from './runtime-interface';

export default Runtime;

/**
 * The corrections a guest needs from the realm itself, rather than from its
 * own global: a constructor it reads by bare name, a prototype it inherits.
 * Each is registered here when this module loads and installed by the first
 * `Runtime`, so that a host that only imported the engine keeps its own.
 */
// Polyfill setImmediate/clearImmediate (Node.js globals not available in browsers)
forGuestRealm(() => {
  if (typeof globalThis.setImmediate === 'undefined') {
    takeFromHost(globalThis, 'setImmediate', (fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 0, ...args));
    takeFromHost(globalThis, 'clearImmediate', (id: number) => clearTimeout(id));
  }
});

// Node's timers answer a `Timeout` object and a browser's answer a number.
// That correction used to be made on the realm, which replaced the
// `setTimeout` of any Node process that imported the engine. It is the
// guest's, and it is made on the guest's own timers, in
// `guestTimerFunctions`.

forGuestRealm(() => {
  // Node's `fetch` does not apply the fetch specification's
  // forbidden-request-header guard, and a browser's `Request` constructor
  // does: `new Request(url, { headers: { host } })` keeps the header on
  // Node and silently loses it here, along with `connection`,
  // `content-length`, `origin` and the `sec-`/`proxy-` families. Any
  // program that wraps a request it was handed in a web `Request` then
  // reads `null` where Node shows a value. Next's middleware adapter and
  // its app-router `headers()` both do exactly that, so Dub's middleware
  // died on its first line reading the authority the request arrived on.
  //
  // A request keeps the headers it was built with, as Node keeps them.
  // What the browser will not *send* is still its own business: this
  // restores what a program can read, which is what Node's own behaviour
  // is measured on.
  if (typeof globalThis.Request === 'function' && !(globalThis.Request as unknown as { __substrateHeaderGuard?: boolean }).__substrateHeaderGuard) {
    const Native = globalThis.Request;
    const kept = new WeakMap<object, Headers>();
    class NodeRequest extends Native {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        // An async-iterable body (a Node stream) is read as undici reads it.
        init = withNodeRequestBody(init);
        super(input as RequestInfo, init);
        rememberRequestBodySource(this, input, init);
        const asked = new Headers(init?.headers ?? (input instanceof Native ? (input as Request).headers : undefined));
        const headers = new Headers(super.headers);
        asked.forEach((value, name) => { if (!headers.has(name)) headers.set(name, value); });
        kept.set(this, headers);
      }
      get headers(): Headers {
        return kept.get(this) ?? super.headers;
      }
      clone(): Request {
        const copy = super.clone();
        rememberRequestBodySource(copy, this);
        return new NodeRequest(copy, { headers: this.headers });
      }
    }
    Object.defineProperty(NodeRequest, '__substrateHeaderGuard', { value: true });
    Object.defineProperty(NodeRequest, 'name', { value: 'Request', configurable: true });
    takeFromHost(globalThis, 'Request', NodeRequest);
  }
});

forGuestRealm(() => {
  // A response keeps the Set-Cookie headers it was built with, as Node's
  // does; the browser's response guard drops them (see node-response.ts).
  installNodeResponse(globalThis);
});

forGuestRealm(() => {
  // Node's `stream.finished()` on a web stream waits on a promise Node's own
  // web streams carry (`nodejs.webstream.isClosedPromise`), settled when the
  // stream closes or errors, and undici's fetch finalizes every response that
  // way. The worker's streams are the browser's and carry none, so a stream a
  // guest constructs is given one, settled by its own controller. The
  // constructor stays the browser's (a proxy of it), so a stream the platform
  // made is still `instanceof ReadableStream`.
  const kIsClosedPromise = Symbol.for('nodejs.webstream.isClosedPromise');
  const Native = globalThis.ReadableStream;
  if (typeof Native !== 'function' || (Native as unknown as { __substrateClosedPromise?: boolean }).__substrateClosedPromise) return;
  type Source = { start?: (controller: unknown) => unknown; pull?: (controller: unknown) => unknown; cancel?: (reason: unknown) => unknown };
  const Tracked: typeof ReadableStream = new Proxy(Native, {
    construct(target, args, newTarget): object {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      promise.then(undefined, () => {});
      const source = args[0] as Source | null | undefined;
      const track = (controller: { close?: (...rest: unknown[]) => unknown; error?: (...rest: unknown[]) => unknown }): void => {
        const close = controller.close;
        const error = controller.error;
        if (typeof close === 'function') controller.close = function (this: unknown, ...rest: unknown[]) { const result = close.apply(this, rest); resolve(); return result; };
        if (typeof error === 'function') controller.error = function (this: unknown, ...rest: unknown[]) { reject(rest[0]); return error.apply(this, rest); };
      };
      const failed = (cause: unknown): never => { reject(cause); throw cause; };
      const wrapped: Source = Object.create(source ?? null);
      wrapped.start = (controller) => {
        track(controller as Parameters<typeof track>[0]);
        try { return source?.start?.call(source, controller); } catch (cause) { return failed(cause); }
      };
      if (typeof source?.pull === 'function') {
        const pull = source.pull;
        wrapped.pull = (controller) => {
          try { return Promise.resolve(pull.call(source, controller)).catch(failed); } catch (cause) { return failed(cause); }
        };
      }
      wrapped.cancel = (reason) => {
        resolve();
        return source?.cancel?.call(source, reason);
      };
      const stream: object = Reflect.construct(target, [wrapped, ...args.slice(1)], newTarget === Tracked ? target : newTarget);
      Object.defineProperty(stream, kIsClosedPromise, { value: { promise, resolve, reject }, configurable: true });
      return stream;
    },
  });
  Object.defineProperty(Tracked, '__substrateClosedPromise', { value: true });
  takeFromHost(globalThis, 'ReadableStream', Tracked);
});

// Polyfill Error.captureStackTrace/prepareStackTrace for Safari/WebKit
// (V8-specific API used by Express's depd and other npm packages)
forGuestRealm(__substrateStackTracePolyfill);

// A call site of a module's body names the module's file, as Node's does.
forGuestRealm(__substrateCallSiteFileNames);

// Polyfill TextDecoder to handle base64/base64url/hex gracefully
// (Some CLI tools incorrectly try to use TextDecoder for these)
forGuestRealm(__substrateTextDecoderPolyfill);

/**
 * Set up a polyfilled TextDecoder that handles binary encodings
 */
function __substrateTextDecoderPolyfill(): void {
  const OriginalTextDecoder = globalThis.TextDecoder;
  // Installed once: wrapping the wrapper would decode through two decoders.
  if ((OriginalTextDecoder as unknown as { __substrateBinaryEncodings?: boolean }).__substrateBinaryEncodings) return;

  class PolyfillTextDecoder {
    private encoding: string;
    private decoder: TextDecoder | null = null;

    constructor(encoding: string = 'utf-8', options?: TextDecoderOptions) {
      this.encoding = encoding.toLowerCase();

      // For valid text encodings, use the real TextDecoder
      const validTextEncodings = [
        'utf-8', 'utf8', 'utf-16le', 'utf-16be', 'utf-16',
        'ascii', 'iso-8859-1', 'latin1', 'windows-1252'
      ];

      if (validTextEncodings.includes(this.encoding)) {
        try {
          this.decoder = new OriginalTextDecoder(encoding, options);
        } catch {
          // Fall back to utf-8
          this.decoder = new OriginalTextDecoder('utf-8', options);
        }
      }
      // For binary encodings (base64, base64url, hex), decoder stays null
    }

    decode(input?: BufferSource, options?: TextDecodeOptions): string {
      // A view over shared memory is decoded from a copy: the web's decoder refuses one, and Node's takes it.
      if (input && typeof SharedArrayBuffer !== 'undefined') {
        const buffer = input instanceof ArrayBuffer ? undefined : (input as ArrayBufferView).buffer;
        if (buffer instanceof SharedArrayBuffer) {
          const view = input as ArrayBufferView;
          input = new Uint8Array(new Uint8Array(buffer, view.byteOffset, view.byteLength));
        } else if ((input as unknown) instanceof SharedArrayBuffer) input = new Uint8Array(new Uint8Array(input as unknown as SharedArrayBuffer));
      }
      if (this.decoder) {
        return this.decoder.decode(input, options);
      }

      // Handle binary encodings manually
      if (!input) return '';

      const bytes = input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

      if (this.encoding === 'base64') {
        return uint8ToBase64(bytes);
      }

      if (this.encoding === 'base64url') {
        return uint8ToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      }

      if (this.encoding === 'hex') {
        return uint8ToHex(bytes);
      }

      // Fallback: decode as utf-8
      return new OriginalTextDecoder('utf-8').decode(input, options);
    }

    get fatal(): boolean {
      return this.decoder?.fatal ?? false;
    }

    get ignoreBOM(): boolean {
      return this.decoder?.ignoreBOM ?? false;
    }
  }

  Object.defineProperty(PolyfillTextDecoder, '__substrateBinaryEncodings', { value: true });
  takeFromHost(globalThis, 'TextDecoder', PolyfillTextDecoder);
}

/**
 * Polyfill V8's Error.captureStackTrace and Error.prepareStackTrace for Safari/WebKit.
 * Express's `depd` and other npm packages use these V8-specific APIs which don't
 * exist in Safari, causing "callSite.getFileName is not a function" errors.
 */
function __substrateStackTracePolyfill(): void {
  // Only polyfill if not already available (i.e., not V8/Chrome)
  if (typeof (Error as any).captureStackTrace === 'function') return;

  // Set a default stackTraceLimit so Math.max(10, undefined) doesn't produce NaN
  // (depd and other packages read this value)
  if ((Error as any).stackTraceLimit === undefined) {
    takeFromHost(Error, 'stackTraceLimit', 10);
  }

  // Parse a stack trace string into structured frames
  function parseStack(stack: string): Array<{fn: string, file: string, line: number, col: number}> {
    if (!stack) return [];
    const frames: Array<{fn: string, file: string, line: number, col: number}> = [];
    const lines = stack.split('\n');

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('Error') || line.startsWith('TypeError')) continue;

      let fn = '', file = '', lineNo = 0, colNo = 0;

      // Safari format: "functionName@file:line:col" or "@file:line:col"
      const safariMatch = line.match(/^(.*)@(.*?):(\d+):(\d+)$/);
      if (safariMatch) {
        fn = safariMatch[1] || '';
        file = safariMatch[2];
        lineNo = parseInt(safariMatch[3], 10);
        colNo = parseInt(safariMatch[4], 10);
        frames.push({ fn, file, line: lineNo, col: colNo });
        continue;
      }

      // Chrome format: "at functionName (file:line:col)" or "at file:line:col"
      const chromeMatch = line.match(/^at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?$/);
      if (chromeMatch) {
        fn = chromeMatch[1] || '';
        file = chromeMatch[2];
        lineNo = parseInt(chromeMatch[3], 10);
        colNo = parseInt(chromeMatch[4], 10);
        frames.push({ fn, file, line: lineNo, col: colNo });
        continue;
      }
    }
    return frames;
  }

  // Create a mock CallSite object from a parsed frame
  function createCallSite(frame: {fn: string, file: string, line: number, col: number}) {
    return {
      getFileName: () => frame.file || null,
      getLineNumber: () => frame.line || null,
      getColumnNumber: () => frame.col || null,
      getFunctionName: () => frame.fn || null,
      getMethodName: () => frame.fn || null,
      getTypeName: () => null,
      getThis: () => undefined,
      getFunction: () => undefined,
      getEvalOrigin: () => undefined,
      isNative: () => false,
      isConstructor: () => false,
      isToplevel: () => !frame.fn,
      isEval: () => false,
      toString: () => frame.fn
        ? `${frame.fn} (${frame.file}:${frame.line}:${frame.col})`
        : `${frame.file}:${frame.line}:${frame.col}`,
    };
  }

  // Helper: parse stack and create CallSite objects, used by both captureStackTrace and .stack getter
  function buildCallSites(stack: string, constructorOpt?: Function) {
    const frames = parseStack(stack);
    let startIdx = 0;
    if (constructorOpt && constructorOpt.name) {
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].fn === constructorOpt.name) {
          startIdx = i + 1;
          break;
        }
      }
    }
    return frames.slice(startIdx).map(createCallSite);
  }

  // Symbol to store raw stack string, used by the .stack getter
  const stackSymbol = Symbol('rawStack');

  // Intercept .stack on Error.prototype so that packages using the V8 pattern
  // "Error.prepareStackTrace = fn; new Error().stack" also get CallSite objects.
  // In V8, reading .stack lazily triggers prepareStackTrace; Safari doesn't do this.
  defineOnHost(Error.prototype, 'stack', {
    get() {
      const rawStack = (this as any)[stackSymbol];
      if (rawStack !== undefined && typeof (Error as any).prepareStackTrace === 'function') {
        const callSites = buildCallSites(rawStack);
        try {
          return (Error as any).prepareStackTrace(this, callSites);
        } catch {
          return rawStack;
        }
      }
      return rawStack;
    },
    set(value: string) {
      (this as any)[stackSymbol] = value;
    },
    configurable: true,
    enumerable: false,
  });

  // Polyfill Error.captureStackTrace
  const captureStackTrace = function(target: any, constructorOpt?: Function) {
    // Temporarily clear prepareStackTrace to get the raw stack string
    // (otherwise our .stack getter would call prepareStackTrace recursively)
    const savedPrepare = (Error as any).prepareStackTrace;
    (Error as any).prepareStackTrace = undefined;
    const err = new Error();
    const rawStack = err.stack || '';
    (Error as any).prepareStackTrace = savedPrepare;

    // If prepareStackTrace is set, provide structured call sites
    if (typeof savedPrepare === 'function') {
      const callSites = buildCallSites(rawStack, constructorOpt);
      try {
        target.stack = savedPrepare(target, callSites);
      } catch (e) {
        console.warn('[tabnode] Error.prepareStackTrace threw:', e);
        target.stack = rawStack;
      }
    } else {
      target.stack = rawStack;
    }
  };
  takeFromHost(Error, 'captureStackTrace', captureStackTrace);
}

/**
 * A call site of a module's body answers `getFileName()` with the module's
 * file, as a call site of a file Node compiled does.
 *
 * The engine evaluates a module's body, and the `//# sourceURL=` directive the
 * wrapper carries names that script in the stack's text and in
 * `getScriptNameOrSourceURL()` — but V8 leaves `getFileName()` null for an
 * eval'd frame whatever the script is named. The `bindings` package, how
 * `@vscode/spdlog` and `@vscode/native-watchdog` find their `.node` file, sets
 * `Error.prepareStackTrace`, reads its caller's `getFileName()` and calls
 * `.indexOf` on it, so openvscode-server's extension host died in
 * `TypeError: Cannot read properties of undefined (reading 'indexOf')` at
 * `bindings.getFileName`.
 *
 * V8 reads `Error.prepareStackTrace` as an ordinary property, so the realm
 * holds the guest's function and hands V8 one that names the frames first. A
 * frame V8 names itself is passed through untouched, and so is a frame of a
 * guest's own `eval`, which carries no name to give. The guest reads back one
 * function per function it set, so the save-and-restore every package writes
 * around `prepareStackTrace` restores what it saved.
 */
function __substrateCallSiteFileNames(): void {
  // Safari has no V8 call sites; there the engine builds them itself from the
  // stack's text, where the script's name is already all there is.
  if (typeof (Error as { captureStackTrace?: unknown }).captureStackTrace !== 'function') return;
  interface CallSite { getFileName(): string | null; getScriptNameOrSourceURL?(): string | null }
  type Prepare = (error: unknown, sites: CallSite[]) => unknown;
  const held = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  if ((held?.get as { __substrateNamesFrames?: boolean } | undefined)?.__substrateNamesFrames) return;
  // A guest may pin `Error.prepareStackTrace` on the realm -- a source-map
  // package defines it without `configurable` -- and the realm's `Error` is
  // shared by every run the engine holds. Naming frames is a nicety; a
  // process that cannot install it still runs. The define threw instead, and
  // in the tab every run started after the one that pinned it died before its
  // first line with `node: Cannot redefine property: prepareStackTrace` --
  // measured through the page's shell on v0.2.14-volter.63, where it made the
  // shell unusable while openvscode-server kept running.
  if (held !== undefined && held.configurable === false) return;

  const named = (site: CallSite): CallSite => new Proxy(site, {
    get(target, key) {
      if (key === 'getFileName') return () => target.getFileName() ?? (target.getScriptNameOrSourceURL?.() || null);
      const value = Reflect.get(target, key) as unknown;
      // A call site's methods read the frame off their own receiver, which a
      // proxy is not: each is handed back bound to the frame itself.
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  let guestPrepare: unknown = held && !held.get && !held.set ? held.value : undefined;
  const namers = new WeakMap<object, Prepare>();
  const guests = new WeakMap<object, unknown>();
  const namerFor = (prepare: Prepare): Prepare => {
    let namer = namers.get(prepare);
    if (!namer) {
      namer = (error, sites) => prepare(error, sites.map(named));
      namers.set(prepare, namer);
      guests.set(namer, prepare);
    }
    return namer;
  };
  // While one of Node's own files has an override pending for a stack it is
  // about to read, V8 is handed a function that gives that error its
  // override and every other error what it would have had: the guest's
  // function, else V8's own text, which is the error and one `at` line
  // per call site. Otherwise V8 is handed exactly what the guest set.
  const overridingFor = (guest: unknown): Prepare => {
    const known = typeof guest === 'function' ? overridings.get(guest) : overridingNone;
    if (known) return known;
    const overriding: Prepare = (error, sites) => {
      const override = error !== null && typeof error === 'object' ? stackOverrides.get(error) : undefined;
      if (override) { stackOverrides.delete(error as object); return override(error, sites.map(named)); }
      if (typeof guest === 'function') return namerFor(guest as Prepare)(error, sites);
      return `${Error.prototype.toString.call(error)}${sites.map(site => `\n    at ${String(site)}`).join('')}`;
    };
    // A guest that saves the hook and restores it later restores the function
    // it read; that stands for the guest's own, as a namer does.
    guests.set(overriding, guest);
    if (typeof guest === 'function') overridings.set(guest, overriding);
    else overridingNone = overriding;
    return overriding;
  };
  const overridings = new WeakMap<object, Prepare>();
  let overridingNone: Prepare | undefined;
  const get = () => (stackOverrides.size > 0 ? overridingFor(guestPrepare)
    : typeof guestPrepare === 'function' ? namerFor(guestPrepare as Prepare) : guestPrepare);
  (get as { __substrateNamesFrames?: boolean }).__substrateNamesFrames = true;
  defineOnHost(Error, 'prepareStackTrace', {
    get,
    set(prepare: unknown) {
      guestPrepare = typeof prepare === 'function' && guests.has(prepare as object) ? guests.get(prepare as object) : prepare;
    },
    configurable: true,
    enumerable: false,
  });
}
