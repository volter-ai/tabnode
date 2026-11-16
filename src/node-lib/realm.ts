/**
 * NODE'S BOOTSTRAP ON THE REALM'S OWN GLOBAL (ADR-0018 §7). Where the realm's process is `node`, the realm is that
 * process's: its `globalThis` is the process's global, and Node v24.21.0's own bootstrap runs on it as Node's C++ runs
 * it (src/api/environment.cc InitializePrimordials, src/node_realm.cc RunBootstrapping and BootstrapRealm):
 *
 *   internal/per_context/primordials, domexception, messageport   (exports, primordials, privateSymbols, perIsolateSymbols)
 *   internal/bootstrap/realm                                       (process, getLinkedBinding, getInternalBinding, primordials)
 *   internal/bootstrap/node                                        (process, require, internalBinding, primordials)
 *   internal/bootstrap/web/exposed-wildcard, exposed-window-or-worker
 *   internal/bootstrap/switches/is_main_thread, does_own_process_state
 *   process.env, the Environment's env proxy
 *
 * then the main script StartExecution selects (`runNodeMain`), which runs `prepareMainThreadExecution` and the entry
 * through Node's own CommonJS and ES module loaders, over the bindings here (`module_wrap`, `contextify`, `cjs_lexer`,
 * `modules`), where the engine speaks for V8 (v8-host.ts).
 *
 * Every builtin is compiled as Node's BuiltinLoader compiles it, its own text as the body of a function of the
 * parameters its kind takes, in the realm's scope, with no rewrite of a free name, no Proxy and no `with`. Node's
 * `BuiltinModule` (internal/bootstrap/realm) is the process's builtin loader. A builtin id whose file is not vendored
 * is answered by the engine's own module for it (`engineModule`): the engine's
 * `worker_threads`, `dns`, `perf_hooks` and the rest, the realm's web streams, `Blob`, `File`, `URL`, `TextEncoder` and
 * `TextDecoder`, and the realm's one Environment's `internal/timers`, `internal/async_context_frame` and
 * `internal/crypto/keys` (load.ts REALM_ENVIRONMENT).
 */
import { nodeLibNames, nodeLibSource } from './bodies';
import { primordialsOf, loadNodeLib, REALM_ENVIRONMENT, moduleSurface } from './load';
import { nodeLibInternal, nodeLibInternalNames } from './internals';
import { nodeLibPublic, nodeLibPublicNames } from './public-modules';
import { internalBlobOf } from './internals/buffer-and-streams';
import { createSqliteModule } from './sqlite';
import { internalUrlOf } from './internals/url';
import { objectUrlMethodsOf } from './object-urls';
import type { BlobBinding } from './binding/blob';
import { utilBinding, createUtilBinding } from './binding/util';
import { perIsolateSymbols } from './binding/symbols';
import { createMessagingBinding } from './binding/messaging';
import { createAsyncWrapBinding } from './binding/async_wrap';
import { createTaskQueueBinding } from './binding/task_queue';
import { createProcessMethodsBinding, setPatchedFacts, type ProcessMethodsHost } from './binding/process_methods';
import { createCredentialsBinding } from './binding/credentials';
import { cliOptionValue, createOptionsBinding } from './binding/options';
import {
  createConfigBinding, createErrorsBinding, createTraceEventsBinding, createPerformanceBinding, createPermissionBinding,
  createMksnapshotBinding, createWorkerBinding, createContextifyBinding, createReportBinding, processConfig,
} from './binding/realm-bindings';
import { createModuleWrapBinding } from './binding/module_wrap';
import { createCjsLexerBinding } from './binding/cjs_lexer';
import { createNodeModulesBinding } from './binding/node_modules';
import { promiseHandlerAddedAfterReject } from './binding/task_queue';
import { routeErrorStacks } from '../runtime';
import { createEnvProxy, realEnvStore } from './binding/env_var';
import { libnode, withCString } from './binding/libnode';

const indirectEval = eval;

/** What the run gives its realm: its facts and the engine's doors the bindings answer from. */
export interface NodeRealmRun extends Omit<ProcessMethodsHost, 'process'> {
  /** The program's name, the script and its arguments, and the options, as Node's parser left them (native/node/node_start.cc). */
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly execPath: string;
  readonly pid: number;
  ppid(): number;
  /** The engine's own binding of a name the realm makes none of (fs, tcp_wrap, ...), the run's (load.ts NodeLibScope). */
  engineBinding(name: string): unknown;
  /** The process's graph becomes the realm's, as soon as `internal/bootstrap/realm` has made its loaders. */
  adopt(loaders: { require(id: string): unknown; internalBinding(name: string): unknown }): void;
}

/** The realm's loaders, as `setInternalLoaders` hands them to Node's C++. */
export interface NodeRealm {
  readonly process: Record<string, unknown>;
  require(id: string): unknown;
  internalBinding(name: string): unknown;
  /** Environment::CheckUnsettledTopLevelAwait, inverted: the entry's promise pending on its module's top-level await. */
  entryUnsettled(): boolean;
}

/**
 * CreateProcessObject (src/node_process_object.cc:96-158): an instance of a function named `process`, its exit info
 * under `exit_info_private_symbol`, `version`, `versions`, `arch`, `platform` and `release` read-only, and `_rawDebug`.
 */
export function createNodeProcessObject(facts: {
  version: string; versions: Record<string, unknown>; arch: string; platform: string; release: Record<string, unknown>;
  rawDebug(text: string): void;
}): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const ProcessTemplate = { process: function process() {} }.process as unknown as new () => Record<string, unknown>;
  const process = new ProcessTemplate();
  // Environment's exit_info (src/env.h ExitInfoField): kExiting, kExitCode, kHasExitCode.
  Object.defineProperty(process, utilBinding.privateSymbols.exit_info_private_symbol, { value: new Int32Array(3) });
  const readOnly = (name: string, value: unknown): void => {
    Object.defineProperty(process, name, { value, writable: false, enumerable: true, configurable: true });
  };
  readOnly('version', facts.version);
  const versions = {};
  for (const [name, value] of Object.entries(facts.versions)) {
    if (typeof value === 'string') Object.defineProperty(versions, name, { value, writable: false, enumerable: true, configurable: true });
  }
  readOnly('versions', versions);
  readOnly('arch', facts.arch);
  readOnly('platform', facts.platform);
  const release = {};
  for (const [name, value] of Object.entries(facts.release)) {
    Object.defineProperty(release, name, { value, writable: false, enumerable: true, configurable: true });
  }
  readOnly('release', release);
  process._rawDebug = function _rawDebug(message: unknown): void { facts.rawDebug(`${message}\n`); };
  return process;
}

/** BuiltinSourceType (src/builtin_info.cc): the parameters each kind of builtin is compiled with. */
function parametersOf(id: string): readonly string[] {
  if (id.startsWith('internal/bootstrap/realm')) return ['process', 'getLinkedBinding', 'getInternalBinding', 'primordials'];
  if (id.startsWith('internal/bootstrap/') || id.startsWith('internal/main/')) return ['process', 'require', 'internalBinding', 'primordials'];
  if (id.startsWith('internal/per_context/')) return ['exports', 'primordials', 'privateSymbols', 'perIsolateSymbols'];
  return ['exports', 'require', 'module', 'process', 'internalBinding', 'primordials'];
}

/** A vendored builtin's own text compiled as the body of a function of its kind's parameters, its line 1 the file's. */
function compiledBuiltin(id: string): Function {
  const source = nodeLibSource(id);
  if (source === undefined) throw new Error(`No such built-in module: ${id}`);
  return indirectEval(`(function (${parametersOf(id).join(', ')}) {${source}\n})\n//# sourceURL=node:${id}`) as Function;
}

/** The realm's own web classes, as they stood before Node's bootstrap exposed its globals over them. */
function realmWebClasses(): Record<string, unknown> {
  const realm = globalThis as unknown as Record<string, unknown>;
  const names = ['ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest',
    'ReadableByteStreamController', 'ReadableStreamDefaultController', 'WritableStream', 'WritableStreamDefaultController',
    'WritableStreamDefaultWriter', 'TransformStream', 'TransformStreamDefaultController', 'ByteLengthQueuingStrategy',
    'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream', 'DecompressionStream',
    'TextEncoder', 'TextDecoder', 'Blob', 'File', 'URL', 'URLSearchParams', 'URLPattern', 'Performance', 'PerformanceEntry',
    'PerformanceMark', 'PerformanceMeasure', 'PerformanceObserver', 'PerformanceObserverEntryList', 'PerformanceResourceTiming'];
  return Object.fromEntries(names.map((name) => [name, realm[name]]));
}

/** The builtin ids Node's web exposure reads that the engine answers from the realm's own classes. */
const REALM_WEB_MODULES: Readonly<Record<string, readonly string[]>> = {
  'internal/webstreams/readablestream': ['ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
    'ReadableStreamBYOBRequest', 'ReadableByteStreamController', 'ReadableStreamDefaultController'],
  'internal/webstreams/writablestream': ['WritableStream', 'WritableStreamDefaultController', 'WritableStreamDefaultWriter'],
  'internal/webstreams/transformstream': ['TransformStream', 'TransformStreamDefaultController'],
  'internal/webstreams/queuingstrategies': ['ByteLengthQueuingStrategy', 'CountQueuingStrategy'],
  'internal/webstreams/encoding': ['TextEncoderStream', 'TextDecoderStream'],
  'internal/webstreams/compression': ['CompressionStream', 'DecompressionStream'],
  'internal/encoding': ['TextEncoder', 'TextDecoder'],
  'internal/file': ['File'],
};

/** Node's own aliases among its public ids (lib/fs/promises.js, lib/path/posix.js and the rest), over the files they name. */
const ALIASES: Readonly<Record<string, (require: (id: string) => any) => unknown>> = {
  'fs/promises': (require) => require('internal/fs/promises').exports,
  'dns/promises': (require) => require('dns').promises,
  'path/posix': (require) => require('path').posix,
  'path/win32': (require) => require('path').win32,
  'util/types': (require) => require('internal/util/types'),
};

/**
 * Node's bootstrap of the realm whose process is `node`: the per-context scripts, `internal/bootstrap/realm`, `node`,
 * the web exposure, the two switches, and `process.env`.
 */
export function bootstrapNodeRealm(process: Record<string, unknown>, run: NodeRealmRun): NodeRealm {
  // InitializeBaseContextForSnapshot (src/api/environment.cc:912-935): `Intl.v8BreakIterator` deleted.
  const intl = (globalThis as { Intl?: unknown }).Intl;
  if (intl !== null && typeof intl === 'object') delete (intl as Record<string, unknown>).v8BreakIterator;
  const primordials = primordialsOf();
  initializeContextRuntime();
  const privateSymbols = utilBinding.privateSymbols;
  const symbols = perIsolateSymbols();
  let internalBindingLoader: ((name: string) => unknown) | undefined;
  let requireBuiltin: ((id: string) => any) | undefined;
  const require = (id: string): any => {
    if (!requireBuiltin) throw new Error(`node: ${id} was asked for before the realm's loader was made`);
    return requireBuiltin(id);
  };
  let stacks: ((global: object, error: unknown, trace: unknown[]) => unknown) | undefined;

  // InitializePrimordials: the per-context exports, `primordials` on them, and the context files over them.
  const perContext: Record<string, unknown> = { primordials };
  for (const id of ['internal/per_context/domexception', 'internal/per_context/messageport']) {
    compiledBuiltin(id)(perContext, primordials, privateSymbols, symbols);
  }

  let web: Record<string, unknown> = realmWebClasses();
  const blob = (): BlobBinding => internalBinding('blob') as BlobBinding;
  /** The engine's own module of a builtin id Node's library has no vendored file of, or undefined. */
  const engineModule = (id: string): (() => unknown) | undefined => {
    if (REALM_ENVIRONMENT.has(id)) return () => loadNodeLib(id);
    if (id === 'process') return () => process;
    const alias = ALIASES[id];
    if (alias) return () => alias(require);
    const webNames = REALM_WEB_MODULES[id];
    if (webNames) return () => Object.fromEntries(webNames.map((name) => [name, web[name]]));
    if (id === 'internal/blob') {
      return () => ({ ...internalBlobOf(blob()), Blob: web.Blob, isBlob: (value: unknown) => typeof web.Blob === 'function' && value instanceof (web.Blob as typeof Blob) });
    }
    if (id === 'internal/url') {
      return () => ({
        ...internalUrlOf(require, undefined),
        // installObjectURLMethods (lib/internal/url.js): `URL.createObjectURL` and `URL.revokeObjectURL` on the realm's URL.
        installObjectURLMethods: (): void => { Object.defineProperties(web.URL as object, objectUrlMethodsOf(process)); },
        URLPattern: web.URLPattern,
      });
    }
    // `node:sqlite` is the engine's binding of SQLite's own C API (BUILTINS.md Kind 2), its paths the process's.
    if (id === 'sqlite') {
      return () => createSqliteModule({
        resolvePath: (path: string) => (require('path') as { resolve(...parts: string[]): string }).resolve((process.cwd as () => string)(), path),
        own: () => () => {},
      });
    }
    // `stream/web` is the realm's web streams, as the globals Node's web exposure gives are (REALM_WEB_MODULES).
    if (id === 'stream/web') {
      return () => Object.fromEntries(['ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
        'ReadableStreamBYOBRequest', 'ReadableByteStreamController', 'ReadableStreamDefaultController', 'TransformStream',
        'TransformStreamDefaultController', 'WritableStream', 'WritableStreamDefaultWriter', 'WritableStreamDefaultController',
        'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream',
        'DecompressionStream'].map((name) => [name, web[name]]));
    }
    if (id === 'perf_hooks') {
      const shim = nodeLibPublic(id, require, process);
      return () => {
        const module = { ...(shim!() as Record<string, unknown>) };
        for (const name of ['Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure', 'PerformanceObserver',
          'PerformanceObserverEntryList', 'PerformanceResourceTiming']) module[name] ??= web[name];
        return module;
      };
    }
    return nodeLibInternal(id, require, process) ?? nodeLibPublic(id, require, process);
  };
  const vendored = new Set(nodeLibNames());
  const engineIds = [...REALM_ENVIRONMENT, 'process', 'stream/web', 'sqlite', ...Object.keys(ALIASES), ...Object.keys(REALM_WEB_MODULES),
    ...nodeLibInternalNames(), ...nodeLibPublicNames()];
  const builtinIds = [...new Set([...vendored, ...engineIds])].sort();

  // internalBinding('builtins') (src/node_builtins.cc): the ids, a builtin's function, the loaders Node's JavaScript
  // makes, `config` as config.gypi's JSON, and no code cache.
  const builtins = {
    builtinIds,
    compileFunction(id: unknown): Function {
      const name = String(id);
      if (!REALM_ENVIRONMENT.has(name) && vendored.has(name)) return compiledBuiltin(name);
      const answer = engineModule(name);
      if (!answer) throw new Error(`No such built-in module: ${name}`);
      return function (_exports: unknown, _require: unknown, module: { exports: unknown }) {
        module.exports = REALM_ENVIRONMENT.has(name) ? answer() : moduleSurface(answer());
      };
    },
    setInternalLoaders(binding: (name: string) => unknown, requireFn: (id: string) => unknown): void {
      internalBindingLoader = binding;
      requireBuiltin = requireFn as (id: string) => any;
    },
    config: JSON.stringify(processConfig()),
    get natives(): Record<string, string> {
      return Object.fromEntries([...vendored].map((name) => [name, nodeLibSource(name)!]));
    },
    hasCachedBuiltins: (): boolean => false,
    getCacheUsage: () => ({ compiledWithCache: [], compiledWithoutCache: [...vendored], compiledInSnapshot: [] }),
  };

  const exitInfo = process[privateSymbols.exit_info_private_symbol as unknown as string] as Int32Array;
  const made = new Map<string, unknown>();
  const makers: Record<string, () => unknown> = {
    builtins: () => builtins,
    config: createConfigBinding,
    errors: () => createErrorsBinding({
      process: () => process,
      routeStacks: (callback) => { stacks = callback; },
      writeStderr: (text) => run.writeStderr(text),
      // Environment::exit_code: the code the process has, else the default.
      exitCode: (fallback) => (exitInfo[2] ? exitInfo[1]! : fallback),
    }),
    module_wrap: () => createModuleWrapBinding(symbols, privateSymbols, promiseHandlerAddedAfterReject),
    contextify: () => createContextifyBinding(symbols, privateSymbols,
      () => (internalBinding('process_methods') as { emitWarningSync?: (message: string) => void }).emitWarningSync),
    modules: () => createNodeModulesBinding(require, () => run.engineBinding('fs') as { readFileUtf8(path: string, flags: number): string }),
    options: () => createOptionsBinding((primordials.SafeMap as { prototype: object }).prototype),
    process_methods: () => createProcessMethodsBinding({ ...run, process }),
    async_wrap: createAsyncWrapBinding,
    task_queue: createTaskQueueBinding,
    credentials: () => createCredentialsBinding(realEnvStore),
    trace_events: createTraceEventsBinding,
    performance: createPerformanceBinding,
    permission: createPermissionBinding,
    mksnapshot: createMksnapshotBinding,
    worker: () => createWorkerBinding(run.engineBinding('worker') as Record<string, unknown>),
    util: () => createUtilBinding(require),
    symbols: () => symbols,
    cjs_lexer: createCjsLexerBinding,
    report: () => createReportBinding(process, require),
    messaging: () => {
      let createObject: unknown;
      return {
        ...createMessagingBinding(require, perContext),
        // The per-context DOMException (internal/per_context/domexception), as Node's binding reads it off the
        // per-context exports.
        get DOMException() { return perContext.DOMException; },
        exposeLazyDOMExceptionProperty: (target: object): void => {
          Object.defineProperty(target, 'DOMException', {
            configurable: true, enumerable: false,
            get: () => perContext.DOMException,
            set(value) { Object.defineProperty(target, 'DOMException', { value, writable: true, configurable: true, enumerable: false }); },
          });
        },
        // SetDeserializerCreateObjectFunction (node_messaging.cc): the function a deserializer makes a JS transferable
        // host object with. The realm's structured clone carries no host object of Node's JavaScript, so none is made.
        setDeserializerCreateObjectFunction(fn: unknown): void { createObject = fn; void createObject; },
      };
    },
  };
  const internalBinding = (name: string): unknown => {
    if (made.has(name)) return made.get(name);
    const maker = makers[name];
    const binding = maker ? maker() : run.engineBinding(name);
    if (binding === undefined) throw new Error(`No such binding: ${name}`);
    made.set(name, binding);
    return binding;
  };
  const getLinkedBinding = (name: unknown): never => { throw new Error(`No such binding was linked: ${String(name)}`); };

  // ProcessTitleGetter and ProcessTitleSetter (src/node_process_object.cc:31-48): libuv's process title, the
  // program's (process_methods.c), "node" where libuv has none.
  setPatchedFacts(process, {
    title: () => {
      const program = libnode();
      const at = program.exports.tabnode_get_process_title();
      if (at === 0) return 'node';
      try { return program.cString(at) ?? 'node'; } finally { program.exports.tabnode_free(at); }
    },
    setTitle: (value: string) => { withCString(value, (at) => libnode().exports.tabnode_set_process_title(at)); },
    argv: run.argv, execArgv: run.execArgv, pid: run.pid, ppid: () => run.ppid(), execPath: run.execPath,
  });

  trackEntryPromise(globalThis, privateSymbols.entry_point_promise_private_symbol!);
  // RunBootstrapping: the realm's loaders, then BootstrapRealm.
  compiledBuiltin('internal/bootstrap/realm')(process, getLinkedBinding, internalBinding, primordials);
  if (!requireBuiltin || !internalBindingLoader) throw new Error('node: internal/bootstrap/realm made no loaders');
  if (stacks) routeErrorStacks(stacks);
  const loaderBinding = internalBindingLoader;
  run.adopt({ require, internalBinding: loaderBinding });
  // The realm's classes as the engine left them, read now, before Node's web exposure defines its globals over them.
  web = realmWebClasses();
  const run4 = (id: string): void => { compiledBuiltin(id)(process, requireBuiltin, loaderBinding, primordials); };
  run4('internal/bootstrap/node');
  run4('internal/bootstrap/web/exposed-wildcard');
  run4('internal/bootstrap/web/exposed-window-or-worker');
  run4('internal/bootstrap/switches/is_main_thread');
  run4('internal/bootstrap/switches/does_own_process_state');
  Object.defineProperty(process, 'env', { value: createEnvProxy(realEnvStore, require), writable: true, enumerable: true, configurable: true });
  return { process, require, internalBinding: loaderBinding, entryUnsettled: () => entryUnsettled(process, require, privateSymbols) };
}

/**
 * StartExecution's SelectLoadMode (src/node.cc): the main script for the process's options and arguments, compiled as
 * a kMainScript builtin and run with the realm's process, loaders and primordials. `inspect`, `--prof-process`,
 * `--test`, `--watch` and the REPL's main are not among the vendored files: the inspector, V8's tick processor, the
 * test runner, the watcher and `lib/repl.js` are not the engine's.
 */
export function runNodeMain(realm: NodeRealm, argv: readonly string[]): void {
  const { getOptionValue } = realm.require('internal/options') as { getOptionValue(name: string): unknown };
  const first = argv[1] ?? '';
  const stdinIsTTY = (): boolean => {
    const { guessHandleType } = realm.internalBinding('util') as { guessHandleType(fd: number): number };
    return guessHandleType(0) === 1;
  };
  const main = first === 'inspect' ? 'internal/main/inspect'
    : getOptionValue('--help') ? 'internal/main/print_help'
      : getOptionValue('--prof-process') ? 'internal/main/prof_process'
        : getOptionValue('[has_eval_string]') && !getOptionValue('--interactive') ? 'internal/main/eval_string'
          : getOptionValue('--check') ? 'internal/main/check_syntax'
            : getOptionValue('--test') ? 'internal/main/test_runner'
              : getOptionValue('--watch') ? 'internal/main/watch_mode'
                : first !== '' && first !== '-' ? 'internal/main/run_main_module'
                  : getOptionValue('--interactive') || stdinIsTTY() ? 'internal/main/repl'
                    : 'internal/main/eval_stdin';
  compiledBuiltin(main)(realm.process, realm.require, realm.internalBinding, primordialsOf());
}

/**
 * InitializeContextRuntime's --disable-proto (src/api/environment.cc:850-909): `Object.prototype.__proto__` deleted,
 * or an accessor whose getter and setter throw ERR_PROTO_ACCESS (ProtoThrower), after the primordials are made.
 */
function initializeContextRuntime(): void {
  const mode = cliOptionValue('--disable-proto');
  if (mode === '') return;
  if (mode === 'delete') {
    delete (Object.prototype as Record<string, unknown>).__proto__;
  } else if (mode === 'throw') {
    // Function::New(context, ProtoThrower): a function with no name.
    const thrower = [function (): never {
      throw Object.assign(new Error('Accessing Object.prototype.__proto__ has been disallowed with --disable-proto=throw'), { code: 'ERR_PROTO_ACCESS' });
    }][0]!;
    Object.defineProperty(Object.prototype, '__proto__', { get: thrower, set: thrower, enumerable: false, configurable: true });
  }
}

/** The entry's promise and its state, as run_main.js sets `entry_point_promise_private_symbol` on the global. */
const entryPromises = new WeakMap<object, { promise?: Promise<unknown>; pending: boolean }>();
function trackEntryPromise(global: object, symbol: symbol): void {
  const state: { promise?: Promise<unknown>; pending: boolean } = { pending: false };
  entryPromises.set(global, state);
  Object.defineProperty(global, symbol, {
    configurable: true,
    get: () => state.promise,
    set(value: unknown) {
      state.promise = value as Promise<unknown>;
      state.pending = value instanceof Promise;
      if (value instanceof Promise) value.then(() => { state.pending = false; }, () => { state.pending = false; });
    },
  });
}

/**
 * Environment::CheckUnsettledTopLevelAwait (src/env.cc) and ModuleWrap's (src/module_wrap.cc): the entry's promise
 * pending, its module a source text module whose graph awaits and has not finished evaluating; with warnings on, the
 * warning Node prints. A page's engine gives no stalled await's message, so the warning names the module, not the line.
 */
function entryUnsettled(process: Record<string, unknown>, require: (id: string) => any, privateSymbols: Record<string, symbol>): boolean {
  const state = entryPromises.get(globalThis);
  if (!state?.pending) return false;
  const wrap = (globalThis as unknown as Record<symbol, unknown>)[privateSymbols.entry_point_module_private_symbol!] as
    { url?: string; synthetic?: boolean; hasAsyncGraph?: boolean; getStatus(): number } | undefined;
  if (!wrap || typeof wrap !== 'object' || wrap.synthetic || !wrap.hasAsyncGraph || wrap.getStatus() === 4) return false;
  if ((require('internal/options') as { getOptionValue(name: string): unknown }).getOptionValue('--warnings')) {
    (process._rawDebug as (message: string) => void)(`Warning: Detected unsettled top-level await at ${wrap.url}`);
  }
  return true;
}

