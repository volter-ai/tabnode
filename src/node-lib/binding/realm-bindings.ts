/**
 * The bindings Node's bootstrap asks of where the realm's process is `node` (ADR-0018 §7), each Node v24.21.0's C++ as
 * it answers a main thread's Environment that owns its process's state: `config` (src/node_config.cc), `errors`
 * (src/node_errors.cc), `trace_events` (src/node_trace_events.cc), `performance` (src/node_perf.cc), `permission`
 * (src/permission/permission.cc), `mksnapshot` (src/node_snapshotable.cc), `worker` (src/node_worker.cc),
 * `module_wrap` (src/module_wrap.cc) and `contextify` (src/node_contextify.cc).
 *
 * Where these differ from Node:
 * - The engine has no inspector, no ICU, no tracing agent and no snapshot builder: `config` says so as a Node built
 *   without them does, no trace category is ever enabled, and nothing is a snapshot being built.
 * - `module_wrap`'s ModuleWrap is a synthetic module's (a builtin's ESM facade); a source text module is not compiled
 *   here, and `createRequiredModuleFacade` and `throwIfPromiseRejected` are not bound: the program's modules are the
 *   engine's loader's (runtime.ts), not Node's `internal/modules/esm`.
 * - `contextify` compiles in the realm's one context; a context of `vm`'s is the engine's `vm` module's.
 * - The permission model is never on, so every `has` is true.
 */
import * as acorn from 'acorn';
import { reallyExit } from './libnode';
import { performance as systemPerformance } from '../../system';
import { errorSourcePositions } from '../../error-source';
import { nodeVersions } from '../node-versions';

const indirectEval = eval;

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
    // NoSideEffectsToString: V8's ToDetailString, which never runs a program's code.
    noSideEffectsToString(value: unknown): string {
      if (typeof value === 'string') return value;
      if (typeof value === 'symbol') return value.toString();
      if (value === null || typeof value !== 'object' && typeof value !== 'function') return String(value);
      try { return Object.prototype.toString.call(value); } catch { return '#<Object>'; }
    },
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
 * kInvalidFatalExceptionMonkeyPatching; one that throws ends nothing here, as Node's returns to its exit.
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
  let handled: unknown;
  try { handled = (fatal as (error: unknown, fromPromise: boolean) => unknown).call(process, error, fromPromise); }
  catch { return; }
  if (handled !== false) return;
  reportFatalException(host, error, enhance, true);
  reallyExit(host.exitCode(EXIT_CODES.kGenericUserError));
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

/** Module::Status (V8) and ModulePhase (src/module_wrap.h:36-39), as CreatePerContextProperties defines them. */
const MODULE_STATUS = { kUninstantiated: 0, kInstantiating: 1, kInstantiated: 2, kEvaluating: 3, kEvaluated: 4, kErrored: 5 };

/**
 * `internalBinding('module_wrap')`: ModuleWrap's synthetic form (`new ModuleWrap(url, context, exportNames,
 * evaluationSteps)`), whose namespace is a module namespace object (null-prototyped, `[Symbol.toStringTag]` 'Module',
 * not extensible, each export a live binding read through a getter, where V8's binding is a data property).
 */
export function createModuleWrapBinding(): Record<string, unknown> {
  let importModuleDynamically: unknown;
  let initializeImportMeta: unknown;
  class ModuleWrap {
    url!: string;
    #exports = new Map<string, unknown>();
    #names: string[] = [];
    #steps: ((this: ModuleWrap) => void) | undefined;
    #status = MODULE_STATUS.kUninstantiated;
    #error: unknown;
    #namespace: object | undefined;
    #source: unknown;
    constructor(url: unknown, context: unknown, exportNames: unknown, evaluationSteps: unknown) {
      if (typeof url !== 'string') throw new TypeError('ModuleWrap: a URL');
      if (context !== undefined && (context === null || typeof context !== 'object')) throw new TypeError('ModuleWrap: a context');
      if (!Array.isArray(exportNames) || typeof evaluationSteps !== 'function') {
        throw new Error('module_wrap: a source text module is not compiled in this realm');
      }
      Object.defineProperty(this, 'url', { value: url, enumerable: true });
      this.#names = exportNames.map(String);
      for (const name of this.#names) this.#exports.set(name, undefined);
      this.#steps = evaluationSteps as (this: ModuleWrap) => void;
    }
    link(): void {}
    getModuleRequests(): unknown[] { return []; }
    instantiate(): void { if (this.#status === MODULE_STATUS.kUninstantiated) this.#status = MODULE_STATUS.kInstantiated; }
    evaluate(_timeout?: unknown, _breakOnSigint?: unknown): Promise<undefined> {
      if (this.#status === MODULE_STATUS.kErrored) return Promise.reject(this.#error);
      if (this.#status === MODULE_STATUS.kEvaluated) return Promise.resolve(undefined);
      this.#status = MODULE_STATUS.kEvaluating;
      try { this.#steps!.call(this); } catch (error) { this.#status = MODULE_STATUS.kErrored; this.#error = error; return Promise.reject(error); }
      this.#status = MODULE_STATUS.kEvaluated;
      return Promise.resolve(undefined);
    }
    evaluateSync(): unknown { void this.evaluate(); if (this.#status === MODULE_STATUS.kErrored) throw this.#error; return this.getNamespace(); }
    setExport(name: unknown, value: unknown): void {
      const key = String(name);
      if (!this.#exports.has(key)) throw new ReferenceError(`Export '${key}' is not defined in module`);
      this.#exports.set(key, value);
    }
    setModuleSourceObject(source: unknown): void { this.#source = source; }
    getModuleSourceObject(): unknown { return this.#source; }
    getNamespace(): object {
      if (this.#status < MODULE_STATUS.kInstantiated) throw new Error('cannot get namespace, module has not been instantiated');
      if (this.#namespace) return this.#namespace;
      const namespace = Object.create(null) as object;
      for (const name of [...this.#names].sort()) {
        Object.defineProperty(namespace, name, { enumerable: true, configurable: false, get: () => this.#exports.get(name) });
      }
      Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' });
      Object.preventExtensions(namespace);
      return this.#namespace = namespace;
    }
    getStatus(): number { return this.#status; }
    getError(): unknown { return this.#error; }
    get hasAsyncGraph(): boolean { return false; }
  }
  return {
    ModuleWrap,
    ...MODULE_STATUS,
    kEvaluationPhase: 2,
    kSourcePhase: 1,
    setImportModuleDynamicallyCallback(callback: unknown): void { importModuleDynamically = callback; },
    setInitializeImportMetaObjectCallback(callback: unknown): void { initializeImportMeta = callback; },
    get importModuleDynamicallyCallback(): unknown { return importModuleDynamically; },
    get initializeImportMetaObjectCallback(): unknown { return initializeImportMeta; },
  };
}

/** A source's magic comment (`//# sourceURL=` or `//# sourceMappingURL=`), as V8 reads one off a script's end. */
function magicComment(source: string, name: 'sourceURL' | 'sourceMappingURL'): string | undefined {
  const pattern = new RegExp(`(?:^|\\n)\\s*//[#@]\\s*${name}=\\s*(\\S+)\\s*$`, 'u');
  const tail = source.slice(-4096);
  const match = pattern.exec(tail.replace(/\s+$/u, ''));
  return match?.[1];
}

/** `source` compiled in the realm's one context with its offsets kept: `lineOffset` lines and `columnOffset` columns before it. */
function compiledIn(source: string, filename: string, lineOffset: number, columnOffset: number, head: string, tail: string): unknown {
  const padding = '\n'.repeat(Math.max(0, lineOffset | 0)) + ' '.repeat(Math.max(0, columnOffset | 0));
  return indirectEval(`${head}${padding}${source}${tail}\n//# sourceURL=${filename}`);
}

/** Whether a source parses as an ES module where it does not as a script: Node's ShouldRetryAsESM, read by the parser. */
function parsesOnlyAsModule(source: string): boolean {
  try { acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true }); return false; }
  catch { /* not a script */ }
  try { acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); return true; }
  catch { return false; }
}

export function createContextifyBinding(): Record<string, unknown> {
  class ContextifyScript {
    readonly cachedDataRejected = false;
    readonly sourceMapURL: string | undefined;
    #code: string;
    #filename: string;
    #lineOffset: number;
    #columnOffset: number;
    constructor(code: unknown, filename: unknown, lineOffset: unknown, columnOffset: unknown) {
      this.#code = String(code);
      this.#filename = String(filename);
      this.#lineOffset = Number(lineOffset) | 0;
      this.#columnOffset = Number(columnOffset) | 0;
      this.sourceMapURL = magicComment(this.#code, 'sourceMappingURL');
      // V8 compiles the script now, so a syntax error is the constructor's.
      // eslint-disable-next-line no-new-func
      new Function(this.#code);
    }
    runInContext(contextifiedObject: unknown, _timeout?: unknown, _displayErrors?: unknown): unknown {
      if (contextifiedObject !== null && contextifiedObject !== undefined) {
        throw new Error('contextify: a context of vm\'s is the engine\'s vm module\'s');
      }
      return compiledIn(this.#code, this.#filename, this.#lineOffset, this.#columnOffset, '', '');
    }
  }
  return {
    ContextifyScript,
    compileFunction(code: unknown, filename: unknown, lineOffset: unknown, columnOffset: unknown, _cachedData: unknown,
      _produceCachedData: unknown, parsingContext: unknown, contextExtensions: unknown, params: unknown): Record<string, unknown> {
      if (parsingContext !== undefined && parsingContext !== null) throw new Error('contextify: a context of vm\'s is the engine\'s vm module\'s');
      const source = String(code);
      const names = Array.isArray(params) ? params.map(String) : [];
      const extensions = Array.isArray(contextExtensions) ? contextExtensions : [];
      // Context extensions are scopes around the function, as V8's CompileFunction makes them.
      const head = extensions.map((_, index) => `with (__substrateExtensions[${index}]) {`).join('');
      const close = extensions.map(() => '}').join('');
      const made = extensions.length > 0
        ? (compiledIn(source, String(filename), Number(lineOffset) | 0, Number(columnOffset) | 0,
          `(function (__substrateExtensions) { ${head} return function (${names.join(', ')}) {`, `\n}; ${close} })`) as (ext: unknown[]) => unknown)(extensions)
        : compiledIn(source, String(filename), Number(lineOffset) | 0, Number(columnOffset) | 0, `(function (${names.join(', ')}) {`, '\n})');
      return { function: made, sourceMapURL: magicComment(source, 'sourceMappingURL'), sourceURL: magicComment(source, 'sourceURL') };
    },
    compileFunctionForCJSLoader(content: unknown, filename: unknown, _isSeaMain: unknown, shouldDetectModule: unknown): Record<string, unknown> {
      const source = String(content);
      try {
        const made = compiledIn(source, String(filename), 0, 0, '(function (exports, require, module, __filename, __dirname) {', '\n})');
        return { cachedDataRejected: false, sourceMapURL: magicComment(source, 'sourceMappingURL'), sourceURL: magicComment(source, 'sourceURL'), function: made, canParseAsESM: false };
      } catch (error) {
        if (shouldDetectModule === true && error instanceof SyntaxError && parsesOnlyAsModule(source)) {
          return { cachedDataRejected: false, sourceMapURL: undefined, sourceURL: undefined, function: undefined, canParseAsESM: true };
        }
        throw error;
      }
    },
    containsModuleSyntax(code: unknown, _filename: unknown, _resourceName?: unknown, _cjsVar?: unknown): boolean {
      return parsesOnlyAsModule(String(code));
    },
    constants: { measureMemory: { mode: { SUMMARY: 0, DETAILED: 1 }, execution: { DEFAULT: 0, EAGER: 1 } } },
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
