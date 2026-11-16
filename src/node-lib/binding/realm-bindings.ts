/**
 * The bindings Node's bootstrap asks of where the realm's process is `node` (ADR-0018 §7), each Node v24.21.0's C++ as
 * it answers a main thread's Environment that owns its process's state: `config` (src/node_config.cc), `errors`
 * (src/node_errors.cc), `trace_events` (src/node_trace_events.cc), `performance` (src/node_perf.cc), `permission`
 * (src/permission/permission.cc), `mksnapshot` (src/node_snapshotable.cc), `worker` (src/node_worker.cc),
 * and `contextify` (src/node_contextify.cc).
 *
 * Where these differ from Node:
 * - The engine has no inspector, no ICU, no tracing agent and no snapshot builder: `config` says so as a Node built
 *   without them does, no trace category is ever enabled, and nothing is a snapshot being built.
 * - `contextify` compiles in the realm's one context; a context of `vm`'s is the engine's `vm` module's.
 * - The permission model is never on, so every `has` is true.
 */
import * as acorn from 'acorn';
import { reallyExit } from './program';
import { compileFunction, compileScript, magicComment } from '../v8-host';
import { Script as VmSandboxScript } from '../../shims/vm';
import { performance as systemPerformance } from '../../system';
import { errorSourcePositions } from '../../error-source';
import { nodeVersions } from '../node-versions';

/** NODE_PERFORMANCE_MILESTONES (src/node_perf_common.h:27-35). */
const MILESTONES = ['TIME_ORIGIN_TIMESTAMP', 'TIME_ORIGIN', 'ENVIRONMENT', 'NODE_START', 'V8_START', 'LOOP_START', 'LOOP_EXIT', 'BOOTSTRAP_COMPLETE'];
/** NODE_PERFORMANCE_ENTRY_TYPES (src/node_perf_common.h). */
const ENTRY_TYPES = ['GC', 'HTTP', 'HTTP2', 'NET', 'DNS'];
/** ExitCode (src/node_exit_code.h). */
const EXIT_CODES = {
  kNoFailure: 0, kGenericUserError: 1, kInternalJSParseError: 3, kInternalJSEvaluationFailure: 4, kV8FatalError: 5,
  kInvalidFatalExceptionMonkeyPatching: 6, kExceptionInFatalExceptionHandler: 7, kInvalidCommandLineArgument: 9,
  kBootstrapFailure: 10, kInvalidCommandLineArgument2: 12, kUnsettledTopLevelAwait: 13, kStartupSnapshotFailure: 14,
  kAbort: 134,
};

/** OpenSSL 3's OPENSSL_VERSION_NUMBER of a version's text (0xMNN00PP0L), as config.gypi's `openssl_version` holds it. */
function opensslVersionNumber(version: string | undefined): number {
  const [major = 0, minor = 0, patch = 0] = (version ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  return ((major << 28) | (minor << 20) | (patch << 4)) >>> 0;
}

/** `process.config` as Node's build writes it (config.gypi), for a Node built as the `node` program is. */
export function processConfig(): { target_defaults: Record<string, unknown>; variables: Record<string, unknown> } {
  return {
    target_defaults: { default_configuration: 'Release' },
    variables: {
      node_shared: false, node_use_openssl: true, node_shared_openssl: false, openssl_is_fips: false,
      openssl_version: opensslVersionNumber(nodeVersions().openssl), node_use_amaro: true, node_use_quic: false,
      v8_enable_i18n_support: 0,
    },
  };
}

export function createConfigBinding(): Record<string, unknown> {
  return {
    hasIntl: false, hasSmallICU: false, hasNodeOptions: true, hasInspector: false, noBrowserGlobals: false, bits: 64,
    hasOpenSSL: true, openSSLIsBoringSSL: false, fipsMode: false, hasDtrace: false, isDebugBuild: false,
    getDefaultLocale: (): string => '',
  };
}

/** What the run gives `errors`: where V8's stacks go, a synchronous stderr, and the process's exit code. */
export interface ErrorsHost {
  readonly process: () => Record<string, unknown>;
  /** The realm's V8 hook made Node's PrepareStackTraceCallback (runtime.ts `routeErrorStacks`). */
  routeStacks(callback: (global: object, error: unknown, trace: unknown[]) => unknown): void;
  writeStderr(text: string): void;
  /** Environment::exit_code(default): the process's code where it has one. */
  exitCode(fallback: number): number;
}

export function createErrorsBinding(host: ErrorsHost): Record<string, unknown> {
  let enhanceBefore: ((error: unknown) => unknown) | undefined;
  let enhanceAfter: ((error: unknown) => unknown) | undefined;
  let sourceMapsEnabled = false;
  const binding: Record<string, unknown> = {
    setPrepareStackTraceCallback(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('setPrepareStackTraceCallback: a function');
      host.routeStacks(callback as (global: object, error: unknown, trace: unknown[]) => unknown);
    },
    setGetSourceMapErrorSource(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('setGetSourceMapErrorSource: a function');
    },
    setSourceMapsEnabled(enabled: unknown): void {
      if (typeof enabled !== 'boolean') throw new TypeError('setSourceMapsEnabled: a boolean');
      sourceMapsEnabled = enabled;
    },
    setMaybeCacheGeneratedSourceMap(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('setMaybeCacheGeneratedSourceMap: a function');
    },
    setEnhanceStackForFatalException(before: unknown, after: unknown): void {
      if (typeof before !== 'function' || typeof after !== 'function') throw new TypeError('setEnhanceStackForFatalException: two functions');
      enhanceBefore = before as (error: unknown) => unknown;
      enhanceAfter = after as (error: unknown) => unknown;
    },
    noSideEffectsToString,
    triggerUncaughtException(error: unknown, fromPromise: unknown): void {
      triggerUncaughtException(host, error, fromPromise === true, { enhanceBefore, enhanceAfter });
    },
    getErrorSourcePositions: (error: object) => errorSourcePositions(host.process(), error),
  };
  Object.defineProperty(binding, 'exitCodes', { value: Object.freeze({ ...EXIT_CODES }), enumerable: true });
  Object.defineProperty(binding, 'sourceMapsEnabled', { get: () => sourceMapsEnabled });
  return binding;
}

/**
 * errors::TriggerUncaughtException (src/node_errors.cc): `process._fatalException(error, fromPromise)`, which gives
 * the program its chance; where it answers false the error is fatal: ReportFatalException prints it and the process
 * exits with its code, kGenericUserError where it set none. A `_fatalException` that is not a function is
 * kInvalidFatalExceptionMonkeyPatching; one that throws is reported and is kExceptionInFatalExceptionHandler.
 */
export function triggerUncaughtException(host: ErrorsHost, error: unknown, fromPromise: boolean,
  enhance: { enhanceBefore?: (error: unknown) => unknown; enhanceAfter?: (error: unknown) => unknown }): void {
  const process = host.process();
  const fatal = process._fatalException;
  if (typeof fatal !== 'function') {
    reportFatalException(host, error, enhance, false);
    reallyExit(EXIT_CODES.kInvalidFatalExceptionMonkeyPatching);
    return;
  }
  // errors::TryCatchScope in kFatal mode (node_errors.cc:722-744): a throw from `_fatalException` is reported, enhanced,
  // and the process exits with kExceptionInFatalExceptionHandler; a stack overflow with JavaScript below the call
  // (kFatalRethrowStackOverflow, 1357-1360: the binding is called from JavaScript) is thrown on to it.
  let handled: unknown;
  try { handled = (fatal as (error: unknown, fromPromise: boolean) => unknown).call(process, error, fromPromise); }
  catch (thrown) {
    if (isStackOverflowError(error) && isStackOverflowError(thrown)) throw thrown;
    reportFatalException(host, thrown, enhance, true);
    reallyExit(EXIT_CODES.kExceptionInFatalExceptionHandler);
    return;
  }
  if (handled !== false) return;
  reportFatalException(host, error, enhance, true);
  reallyExit(host.exitCode(EXIT_CODES.kGenericUserError));
}

/** JSReceiver::GetDataProperty: a data property up the prototype chain, never a getter's answer. */
function dataProperty(object: object, key: PropertyKey): unknown {
  for (let current: object | null = object; current !== null; current = Object.getPrototypeOf(current) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
  }
  return undefined;
}

/** `text` past 128 characters as V8 shortens it: its first `head`, "...<omitted>...", its last `tail`. */
function omitted(text: string, head: number, tail: number): string {
  return text.length > 128 ? `${text.slice(0, head)}...<omitted>...${text.slice(text.length - tail)}` : text;
}

/** JSReceiver::class_name, for the objects with no @@toStringTag of their own. */
function className(value: object): string {
  if (typeof value === 'function') return 'Function';
  if (Array.isArray(value)) return 'Array';
  if (value instanceof Error) return 'Error';
  if (value instanceof Date) return 'Date';
  if (value instanceof RegExp) return 'RegExp';
  if (value instanceof Boolean) return 'Boolean';
  if (value instanceof Number) return 'Number';
  if (value instanceof String) return 'String';
  return 'Object';
}

/**
 * Object::NoSideEffectsToString (V8's objects.cc:585-730, its ToDetailString): a primitive's string, a function's
 * source (past 128 characters its first 111 and last 2 around "...<omitted>..."), a symbol's `Symbol(description)`, an
 * error's NoSideEffectsErrorToString (`name: message` of its data properties), `#<Constructor>` for an object whose
 * toString is Object.prototype's, else `[object Tag]`; it runs no getter and no method of the program's.
 */
function noSideEffectsToString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value);
  if (typeof value === 'bigint') return `${value}`;
  if (typeof value === 'symbol') {
    return value.description === undefined ? 'Symbol()' : `Symbol(${omitted(value.description, 56, 56)})`;
  }
  const receiver = value as object;
  if (typeof receiver === 'function') return omitted(Function.prototype.toString.call(receiver), 111, 2);
  const toString = dataProperty(receiver, 'toString');
  if (receiver instanceof Error || toString === Error.prototype.toString) {
    const name = dataProperty(receiver, 'name');
    const message = dataProperty(receiver, 'message');
    const nameText = typeof name === 'string' ? name : '';
    const messageText = typeof message === 'string' ? message : '';
    if (nameText.length === 0) return messageText;
    if (messageText.length === 0) return nameText;
    return `${nameText}: ${messageText}`;
  }
  if (toString === Object.prototype.toString) {
    const constructor = dataProperty(receiver, 'constructor');
    if (typeof constructor === 'function') {
      const name = Object.getOwnPropertyDescriptor(constructor, 'name');
      if (name && typeof name.value === 'string' && name.value.length > 0) return `#<${name.value}>`;
    }
  }
  const tag = dataProperty(receiver, Symbol.toStringTag);
  return `[object ${typeof tag === 'string' ? tag : className(receiver)}]`;
}

/** IsStackOverflowError (node_errors.cc:696-718): a native RangeError whose message is V8's for a stack overflow. */
function isStackOverflowError(error: unknown): boolean {
  if (!(error instanceof RangeError)) return false;
  try { return error.constructor?.name === 'RangeError' && error.message === 'Maximum call stack size exceeded'; }
  catch { return false; }
}

/** ReportFatalException (src/node_errors.cc:446-588), with no inspector to tell and no report to write. */
function reportFatalException(host: ErrorsHost, error: unknown,
  enhance: { enhanceBefore?: (error: unknown) => unknown; enhanceAfter?: (error: unknown) => unknown }, enhanceStack: boolean): void {
  let trace: unknown;
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    if (enhanceStack) {
      for (const enhancer of [enhance.enhanceBefore, enhance.enhanceAfter]) {
        if (enhancer === undefined) continue;
        try { trace = enhancer(error); } catch { /* the enhancer's Maybe is empty: the trace is the last one made */ }
      }
    } else {
      try { trace = (error as { stack?: unknown }).stack; } catch { trace = undefined; }
    }
  }
  const text = trace === undefined ? '' : String(trace);
  if (text.length > 0) {
    host.writeStderr(`${text}\n`);
  } else {
    let message: unknown, name: unknown;
    if (error !== null && typeof error === 'object') {
      try { message = (error as { message?: unknown }).message; name = (error as { name?: unknown }).name; } catch { /* as V8's Get fails */ }
    }
    if (message === undefined || name === undefined) {
      let said: string;
      try { said = String(error); } catch { said = '<toString() threw exception>'; }
      host.writeStderr(`${said}\n`);
    } else {
      host.writeStderr(`${String(name)}: ${String(message)}\n`);
    }
    host.writeStderr('(Use `node --trace-uncaught ...` to show where the exception was thrown)\n');
  }
  host.writeStderr(`\nNode.js ${(host.process() as { version?: string }).version ?? ''}\n`);
}

export function createTraceEventsBinding(): Record<string, unknown> {
  class CategorySet {
    constructor(_categories: unknown) {}
    enable(): void {}
    disable(): void {}
  }
  return {
    getEnabledCategories: (): string => '',
    // No category's state ever changes, so the handler is never called.
    setTraceCategoryStateUpdateHandler(handler: unknown): void {
      if (typeof handler !== 'function') throw new TypeError('setTraceCategoryStateUpdateHandler: a function');
    },
    getCategoryEnabledBuffer: (_category: unknown): Uint8Array => new Uint8Array(1),
    CategorySet,
    isTraceCategoryEnabled: (_category: unknown): boolean => false,
    trace: (): void => {},
  };
}

export function createPerformanceBinding(): Record<string, unknown> {
  // PerformanceState (src/node_perf.cc): every milestone -1, then the time origin, in microseconds since the epoch and
  // on the process's monotonic clock, whose origin `now` counts from (internal/perf/utils), so 0.
  const milestones = new Float64Array(MILESTONES.length).fill(-1);
  const observerCounts = new Uint32Array(ENTRY_TYPES.length);
  milestones[0] = systemPerformance.timeOrigin * 1e3;
  milestones[1] = 0;
  const now = (): number => systemPerformance.now();
  const constants: Record<string, number> = {};
  MILESTONES.forEach((name, index) => { constants[`NODE_PERFORMANCE_MILESTONE_${name}`] = index; });
  ENTRY_TYPES.forEach((name, index) => { constants[`NODE_PERFORMANCE_ENTRY_TYPE_${name}`] = index; });
  return {
    milestones, observerCounts, constants,
    now,
    loopIdleTime: (): number => 0,
    markBootstrapComplete(): void { milestones[MILESTONES.indexOf('BOOTSTRAP_COMPLETE')] = now() * 1e6; },
    setupObservers(_callback: unknown): void {},
    installGarbageCollectionTracking(): void {},
    removeGarbageCollectionTracking(): void {},
    notify(): void {},
    uvMetricsInfo: (): number[] => [0, 0, 0],
  };
}

export function createPermissionBinding(): Record<string, unknown> {
  return { has: (): boolean => true, drop: (): void => {} };
}

export function createMksnapshotBinding(): Record<string, unknown> {
  return {
    isBuildingSnapshotBuffer: new Uint8Array(1),
    setSerializeCallback(_callback: unknown): void {},
    setDeserializeCallback(_callback: unknown): void {},
    setDeserializeMainFunction(_callback: unknown): void {},
    runEmbedderPreload: undefined,
    anonymousMainPath: '__node_anonymous_main',
  };
}

export function createWorkerBinding(base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    isMainThread: true,
    isInternalThread: false,
    ownsProcessState: true,
    threadId: 0,
    resourceLimits: new Float64Array(4),
    kMaxYoungGenerationSizeMb: 0, kMaxOldGenerationSizeMb: 1, kCodeRangeSizeMb: 2, kStackSizeMb: 3, kTotalResourceLimitCount: 4,
  };
}

/** ShouldRetryAsESM's messages (src/node_contextify.cc): ESM syntax, and what only CommonJS's scope refuses. */
const ESM_SYNTAX_ERRORS = ['Cannot use import statement outside a module', "Unexpected token 'export'", "Cannot use 'import.meta' outside a module"];
const THROWS_ONLY_IN_CJS = ["Identifier 'module' has already been declared", "Identifier 'exports' has already been declared",
  "Identifier 'require' has already been declared", "Identifier '__filename' has already been declared",
  "Identifier '__dirname' has already been declared", 'await is only valid in async functions and the top level bodies of modules'];
const MAYBE_TOP_LEVEL_AWAIT = ['missing ) after argument list', 'SyntaxError: Unexpected'];
/** The parameters of a CommonJS module's function (GetCJSParameters). */
const CJS_PARAMETERS = ['exports', 'require', 'module', '__filename', '__dirname'];

/** V8's message of a compile's exception, as Message::Get gives it: its name and message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * ShouldRetryAsESM: an ES module's syntax, or a refusal only CommonJS's scope makes of a text that compiles as a
 * source text module (V8's module parse, the engine's parser's).
 */
function shouldRetryAsESM(message: string, code: string): boolean {
  if (ESM_SYNTAX_ERRORS.some((text) => message.includes(text))) return true;
  if (!THROWS_ONLY_IN_CJS.some((text) => message.includes(text)) && !MAYBE_TOP_LEVEL_AWAIT.some((text) => message.includes(text))) return false;
  try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); return true; }
  catch { return false; }
}

/**
 * `internalBinding('contextify')` (src/node_contextify.cc): ContextifyScript, the functions `vm.compileFunction` and
 * the CommonJS loader compile, and ContainsModuleSyntax, each compiled by the engine for V8 (v8-host.ts), its dynamic
 * `import()` the host-defined option it was given. Where this differs from Node: a page's engine makes no V8 context,
 * so a context of `vm`'s is the context object as the engine's sandbox (shims/vm.ts: its names resolved on the object
 * through `with`); a script's timeout and SIGINT watchdog are not kept, a page's engine giving no way to stop a running
 * script; V8's code cache is not made, so cached data given is rejected and none is produced.
 */
export function createContextifyBinding(symbols: Record<string, symbol>, privateSymbols: Record<string, symbol>,
  emitWarningSync: () => ((message: string) => void) | undefined): Record<string, unknown> {
  const hdoSymbol = privateSymbols.host_defined_option_symbol!;

  class ContextifyScript {
    #run: () => unknown;
    #code: string;
    constructor(code: unknown, filename: unknown, lineOffset?: unknown, columnOffset?: unknown, cachedData?: unknown,
      produceCachedData?: unknown, parsingContext?: unknown, id?: unknown) {
      const source = String(code);
      this.#code = source;
      const record = this as Record<string | symbol, unknown>;
      const symbol = typeof id === 'symbol' ? id : symbols.vm_dynamic_import_missing_flag;
      this.#run = compileScript(source, String(filename), symbol, Number(lineOffset ?? 0) | 0, Number(columnOffset ?? 0) | 0);
      Object.defineProperty(this, hdoSymbol, { value: symbol });
      record.sourceURL = magicComment(source, 'sourceURL') ?? String(filename);
      record.sourceMapURL = magicComment(source, 'sourceMappingURL');
      if (cachedData !== undefined) record.cachedDataRejected = true;
      if (produceCachedData === true) record.cachedDataProduced = false;
    }
    runInContext(contextifiedObject: unknown, _timeout?: unknown, _displayErrors?: unknown, _breakOnSigint?: unknown): unknown {
      if (contextifiedObject !== null && contextifiedObject !== undefined) {
        // A context of vm's: the engine's sandbox, its names the context object's (shims/vm.ts).
        return new VmSandboxScript(this.#code).runInNewContext(contextifiedObject as object);
      }
      return this.#run();
    }
    createCachedData(): Uint8Array { return new Uint8Array(0); }
  }
  /** CompileFunctionForCJSLoader (the static helper): the module's function, its import() the default loader's. */
  const compileCjs = (code: string, filename: string, cjsScope: boolean): Function =>
    compileFunction(code, filename, cjsScope ? CJS_PARAMETERS : [], symbols.vm_dynamic_import_default_internal, { cjs: cjsScope });
  return {
    ContextifyScript,
    compileFunction(code: unknown, filename: unknown, lineOffset: unknown, columnOffset: unknown, cachedData: unknown,
      _produceCachedData: unknown, parsingContext: unknown, contextExtensions: unknown, params: unknown, id: unknown): Record<string, unknown> {
      const source = String(code);
      // A function of a vm context's resolves its names on the context object, as the context extension it is here.
      const extensions = [...(parsingContext !== undefined && parsingContext !== null ? [parsingContext as object] : []),
        ...(Array.isArray(contextExtensions) ? contextExtensions as object[] : [])];
      const made = compileFunction(source, String(filename), Array.isArray(params) ? params.map(String) : [], id, {
        lineOffset: Number(lineOffset) | 0, columnOffset: Number(columnOffset) | 0, extensions,
      });
      Object.defineProperty(made, hdoSymbol, { value: id });
      return { function: made, sourceURL: String(filename), sourceMapURL: magicComment(source, 'sourceMappingURL'),
        cachedDataRejected: cachedData === undefined ? undefined : true, cachedDataProduced: undefined, cachedData: undefined };
    },
    compileFunctionForCJSLoader(content: unknown, filename: unknown, _isSeaMain: unknown, shouldDetectModule: unknown): Record<string, unknown> {
      const code = String(content);
      const name = String(filename);
      let made: Function | undefined;
      let failure: unknown;
      try { made = compileCjs(code, name, true); } catch (error) { failure = error; }
      let canParseAsESM = false;
      if (made === undefined) {
        canParseAsESM = shouldRetryAsESM(messageOf(failure), code);
        if (!canParseAsESM) throw failure;
        // node_contextify.cc:1823-1833: GetRequireEsmWarning through ProcessEmitWarningSync, each time (Node's
        // warned_about_require_esm is never set), and the syntax error thrown unless the warning's listener threw.
        if (shouldDetectModule !== true) {
          emitWarningSync()?.(`Failed to load the ES module: ${name}. Make sure to set "type": "module" in the nearest package.json file or use the .mjs extension.`);
          throw failure;
        }
      }
      // ScriptOrigin's SourceMapUrl and ResourceName, a file's own `//# sourceURL=` where it has one.
      return { cachedDataRejected: false, sourceMapURL: made ? magicComment(code, 'sourceMappingURL') : undefined,
        sourceURL: made ? magicComment(code, 'sourceURL') ?? name : undefined, function: made, canParseAsESM };
    },
    containsModuleSyntax(code: unknown, filename: unknown, _resourceName?: unknown, cjsVar?: unknown): boolean {
      const source = String(code);
      try { compileCjs(source, String(filename), typeof cjsVar !== 'string'); return false; }
      catch (error) { return shouldRetryAsESM(messageOf(error), source); }
    },
    constants: { measureMemory: { mode: { SUMMARY: 0, DETAILED: 1 }, execution: { DEFAULT: 0, EAGER: 1 } } },
    /**
     * ContextifyContext::MakeContext: the context object (a new one for `vm_context_no_contextify`) marked as a
     * context under `contextify_context_private_symbol`; its scripts run in the engine's sandbox over it.
     */
    makeContext(contextObject: unknown, name: unknown, origin: unknown): object {
      const sandbox = (contextObject === symbols.vm_context_no_contextify ? {} : contextObject) as object;
      Object.defineProperty(sandbox, privateSymbols.contextify_context_private_symbol!, { value: { name, origin }, configurable: true });
      return sandbox;
    },
    /** MicrotaskQueue: a context's own queue, which a page's engine runs with the realm's. */
    MicrotaskQueue: class MicrotaskQueue {},
    /** MeasureMemory: V8's estimate, the realm's `performance.memory` where it reports one. */
    measureMemory(): Promise<unknown> {
      const memory = ((globalThis as { performance?: { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } } }).performance?.memory) ?? {};
      const used = memory.usedJSHeapSize ?? 0;
      return Promise.resolve({ total: { jsMemoryEstimate: used, jsMemoryRange: [used, memory.totalJSHeapSize ?? used] } });
    },
  };
}

/**
 * `internalBinding('report')` (src/node_report_module.cc over src/node_report.cc), for Node's own
 * `lib/internal/process/report.js`: its settings, from the run's options as Node's PerProcessOptions holds them, and a
 * report in Node's shape (reportVersion 5). Where this differs from Node: the report holds its header, the JavaScript
 * stack, the environment and the network interfaces; the native stack, the heap, the resource usage, libuv's handles,
 * the user limits and the shared objects are not read, each an empty section. The process is linked to the WALI SDK's
 * musl, so its header carries no `glibcVersionRuntime`, as a Node on musl's does not.
 */
export function createReportBinding(process: Record<string, unknown>, require: (id: string) => any): Record<string, unknown> {
  const option = (name: string): unknown => (require('internal/options') as { getOptionValue(name: string): unknown }).getOptionValue(name);
  const settings = {
    directory: String(option('--report-dir') ?? option('--report-directory') ?? ''),
    filename: String(option('--report-filename') ?? ''),
    compact: option('--report-compact') === true,
    excludeNetwork: option('--report-exclude-network') === true,
    excludeEnv: option('--report-exclude-env') === true,
    signal: String(option('--report-signal') ?? 'SIGUSR2'),
    onFatalError: option('--report-on-fatalerror') === true,
    onSignal: option('--report-on-signal') === true,
    onUncaughtException: option('--report-uncaught-exception') === true,
  };
  let sequence = 0;
  const report = (event: string, trigger: string, filename: string | null, error: unknown): Record<string, unknown> => {
    const os = require('os') as Record<string, (...args: unknown[]) => unknown>;
    const now = new Date();
    const stackOf = (): { message: string; stack: string[] } => {
      const thrown = error instanceof Error ? error : new Error('JavaScript API');
      const lines = String(thrown.stack ?? '').split('\n');
      return { message: lines[0] ?? '', stack: lines.slice(1).map((line) => line.trim()) };
    };
    return {
      header: {
        reportVersion: 5, event, trigger, filename, dumpEventTime: now.toISOString(), dumpEventTimeStamp: String(now.getTime()),
        processId: process.pid, threadId: 0, cwd: (process.cwd as () => string)(), commandLine: [...(process.argv as string[])],
        nodejsVersion: process.version, wordSize: 64, arch: process.arch, platform: process.platform,
        componentVersions: { ...(process.versions as object) }, release: { ...(process.release as object) },
        osName: os.type!(), osRelease: os.release!(), osVersion: os.version!(), osMachine: os.machine!(),
        cpus: os.cpus!(), ...(settings.excludeNetwork ? {} : { networkInterfaces: os.networkInterfaces!() }), host: os.hostname!(),
      },
      javascriptStack: stackOf(),
      javascriptHeap: {},
      nativeStack: [],
      resourceUsage: {},
      libuv: [],
      workers: [],
      ...(settings.excludeEnv ? {} : { environmentVariables: { ...(process.env as object) } }),
      userLimits: {},
      sharedObjects: [],
    };
  };
  const text = (value: Record<string, unknown>): string => JSON.stringify(value, null, settings.compact ? undefined : 2);
  return {
    getReport: (error: unknown): string => text(report('JavaScript API', 'GetReport', null, error)),
    writeReport(event: unknown, trigger: unknown, file: unknown, error: unknown): string {
      // TriggerNodeReport's default name: report.YYYYMMDD.HHMMSS.PID.TID.SEQ.json, in the report directory or the cwd.
      let name = typeof file === 'string' && file !== '' ? file : settings.filename;
      if (name === '') {
        const d = new Date();
        const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
        name = `report.${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${process.pid}.0.${pad(++sequence, 3)}.json`;
      }
      const target = name === 'stdout' || name === 'stderr' ? name
        : name.startsWith('/') ? name : `${settings.directory || (process.cwd as () => string)()}/${name}`;
      const body = text(report(String(event), String(trigger), name, error));
      if (target === 'stdout') (process.stdout as { write(text: string): void }).write(`${body}\n`);
      else if (target === 'stderr') (process.stderr as { write(text: string): void }).write(`${body}\n`);
      else (require('fs') as { writeFileSync(path: string, text: string): void }).writeFileSync(target, body);
      return name;
    },
    getCompact: (): boolean => settings.compact, setCompact: (value: boolean): void => { settings.compact = value; },
    getExcludeNetwork: (): boolean => settings.excludeNetwork, setExcludeNetwork: (value: boolean): void => { settings.excludeNetwork = value; },
    getExcludeEnv: (): boolean => settings.excludeEnv, setExcludeEnv: (value: boolean): void => { settings.excludeEnv = value; },
    getDirectory: (): string => settings.directory, setDirectory: (value: string): void => { settings.directory = value; },
    getFilename: (): string => settings.filename, setFilename: (value: string): void => { settings.filename = value; },
    getSignal: (): string => settings.signal, setSignal: (value: string): void => { settings.signal = value; },
    shouldReportOnFatalError: (): boolean => settings.onFatalError, setReportOnFatalError: (value: boolean): void => { settings.onFatalError = value; },
    shouldReportOnSignal: (): boolean => settings.onSignal, setReportOnSignal: (value: boolean): void => { settings.onSignal = value; },
    shouldReportOnUncaughtException: (): boolean => settings.onUncaughtException,
    setReportOnUncaughtException: (value: boolean): void => { settings.onUncaughtException = value; },
  };
}
